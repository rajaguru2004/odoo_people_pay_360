import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  assertBranchAssignable,
  assertInBranch,
} from '../common/branch/branch-scope.util';
import { BudgetCommitmentService } from './budget-commitment.service';
import { BudgetActualsService, actualsKey } from './budget-actuals.service';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpsertBudgetLineDto } from './dto/upsert-budget-line.dto';

export interface VarianceRow {
  budgetLineId: string;
  departmentId: string | null;
  departmentName: string;
  category: string;
  planned: number;
  committed: number;
  actual: number;
  remaining: number;
  /** Share of Planned already consumed (committed + actual), 0-1+. */
  utilization: number;
}

@Injectable()
export class BudgetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly commitments: BudgetCommitmentService,
    private readonly actuals: BudgetActualsService,
  ) {}

  async create(dto: CreateBudgetDto, userId: string) {
    assertBranchAssignable(dto.branchId);

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    if (endDate <= startDate) {
      throw new BadRequestException('Budget end date must be after its start');
    }

    try {
      const budget = await this.prisma.budget.create({
        data: {
          name: dto.name,
          fiscalYear: dto.fiscalYear,
          startDate,
          endDate,
          branchId: dto.branchId,
          currency: dto.currency ?? 'OMR',
          status: dto.status ?? 'DRAFT',
          createdById: userId,
        },
      });
      await this.audit.log({
        userId,
        action: 'BUDGET_CREATED',
        resourceType: 'Budget',
        resourceId: budget.id,
        newData: { name: dto.name, fiscalYear: dto.fiscalYear },
        branchId: dto.branchId,
      });
      return { success: true, data: budget };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          `A budget named "${dto.name}" already exists for ${dto.fiscalYear} in this branch`,
        );
      }
      throw e;
    }
  }

  async findAll(params: { fiscalYear?: number; status?: string } = {}) {
    const where: Prisma.BudgetWhereInput = {};
    if (params.fiscalYear) where.fiscalYear = params.fiscalYear;
    if (params.status) where.status = params.status;

    const data = await this.prisma.budget.findMany({
      where,
      include: {
        branch: { select: { id: true, code: true, name: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ fiscalYear: 'desc' }, { name: 'asc' }],
    });
    return { success: true, data };
  }

  private async getOrThrow(id: string) {
    const budget = await this.prisma.budget.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        lines: {
          include: { department: { select: { id: true, name: true } } },
          orderBy: [{ category: 'asc' }],
        },
      },
    });
    if (!budget) throw new NotFoundException('Budget not found');
    assertInBranch(budget.branchId);
    return budget;
  }

  async findOne(id: string) {
    return { success: true, data: await this.getOrThrow(id) };
  }

  async setStatus(id: string, status: string, userId: string) {
    const budget = await this.getOrThrow(id);
    if (!['DRAFT', 'ACTIVE', 'CLOSED'].includes(status)) {
      throw new BadRequestException('Status must be DRAFT, ACTIVE or CLOSED');
    }
    // Only an ACTIVE budget attracts commitments — resolveLine() filters on it.
    const updated = await this.prisma.budget.update({
      where: { id },
      data: { status },
    });
    await this.audit.log({
      userId,
      action: 'BUDGET_STATUS_CHANGED',
      resourceType: 'Budget',
      resourceId: id,
      oldData: { status: budget.status },
      newData: { status },
      branchId: budget.branchId,
    });
    return { success: true, data: updated };
  }

  /**
   * Create or update a budget line. `departmentId: null` is the company-wide
   * fallback line for a category — what spend attaches to when no department
   * line matches.
   */
  async upsertLine(budgetId: string, dto: UpsertBudgetLineDto, userId: string) {
    const budget = await this.getOrThrow(budgetId);

    const existing = await this.prisma.budgetLine.findFirst({
      where: {
        budgetId,
        category: dto.category,
        departmentId: dto.departmentId ?? null,
      },
      select: { id: true },
    });

    const line = existing
      ? await this.prisma.budgetLine.update({
          where: { id: existing.id },
          data: { plannedAmount: dto.plannedAmount, notes: dto.notes ?? null },
          include: { department: { select: { id: true, name: true } } },
        })
      : await this.prisma.budgetLine.create({
          data: {
            budgetId,
            departmentId: dto.departmentId ?? null,
            category: dto.category,
            plannedAmount: dto.plannedAmount,
            notes: dto.notes ?? null,
          },
          include: { department: { select: { id: true, name: true } } },
        });

    await this.audit.log({
      userId,
      action: existing ? 'BUDGET_LINE_UPDATED' : 'BUDGET_LINE_CREATED',
      resourceType: 'BudgetLine',
      resourceId: line.id,
      newData: {
        category: dto.category,
        departmentId: dto.departmentId ?? null,
        plannedAmount: dto.plannedAmount,
      },
      branchId: budget.branchId,
    });
    return { success: true, data: line };
  }

  async removeLine(budgetId: string, lineId: string, userId: string) {
    const budget = await this.getOrThrow(budgetId);
    const line = await this.prisma.budgetLine.findFirst({
      where: { id: lineId, budgetId },
      select: {
        id: true,
        _count: { select: { commitments: { where: { status: 'OPEN' } } } },
      },
    });
    if (!line) throw new NotFoundException('Budget line not found');

    // Deleting cascades the commitments, which would silently free money that
    // is still committed against approved requests.
    if (line._count.commitments > 0) {
      throw new BadRequestException(
        'This line has open commitments from approved requests. Release or realize them before deleting it.',
      );
    }

    await this.prisma.budgetLine.delete({ where: { id: lineId } });
    await this.audit.log({
      userId,
      action: 'BUDGET_LINE_DELETED',
      resourceType: 'BudgetLine',
      resourceId: lineId,
      branchId: budget.branchId,
    });
    return { success: true, message: 'Budget line deleted' };
  }

  /**
   * Planned vs Committed vs Actual vs Remaining.
   *
   *   Remaining = Planned − OPEN commitments − Actual
   *
   * A commitment that has been REALIZED is excluded from `committed` precisely
   * because its money now shows up in `actual` — that is the double-count guard,
   * and it is why the two columns can be added without fear.
   */
  async varianceReport(budgetId: string) {
    const budget = await this.getOrThrow(budgetId);

    const lineIds = budget.lines.map((l) => l.id);
    const [committedByLine, actuals] = await Promise.all([
      this.commitments.openByLine(lineIds),
      this.actuals.forWindow(budget.branchId, budget.startDate, budget.endDate),
    ]);

    const rows: VarianceRow[] = budget.lines.map((line) => {
      const planned = Number(line.plannedAmount);
      const committed = committedByLine.get(line.id) ?? 0;
      const actual = actuals.get(actualsKey(line.departmentId, line.category)) ?? 0;
      return {
        budgetLineId: line.id,
        departmentId: line.departmentId,
        departmentName: line.department?.name ?? 'Company-wide',
        category: line.category,
        planned,
        committed,
        actual,
        remaining: planned - committed - actual,
        utilization: planned > 0 ? (committed + actual) / planned : 0,
      };
    });

    // Spend in a (department, category) with no budget line is invisible in the
    // rows above. Surfacing it is the point of a variance report — silently
    // dropping it would make an over-run look like an under-spend.
    const budgeted = new Set(
      budget.lines.map((l) => actualsKey(l.departmentId, l.category)),
    );
    const unbudgeted = [...actuals.entries()]
      .filter(([key]) => !budgeted.has(key))
      .map(([key, amount]) => {
        const [dept, category] = key.split('::');
        return {
          departmentId: dept === 'COMPANY' ? null : dept,
          category,
          actual: amount,
        };
      })
      .filter((u) => u.actual !== 0);

    const totals = rows.reduce(
      (acc, r) => ({
        planned: acc.planned + r.planned,
        committed: acc.committed + r.committed,
        actual: acc.actual + r.actual,
        remaining: acc.remaining + r.remaining,
      }),
      { planned: 0, committed: 0, actual: 0, remaining: 0 },
    );

    return {
      success: true,
      data: {
        budget: {
          id: budget.id,
          name: budget.name,
          fiscalYear: budget.fiscalYear,
          startDate: budget.startDate,
          endDate: budget.endDate,
          currency: budget.currency,
          status: budget.status,
          branch: budget.branch,
        },
        rows,
        totals,
        // Real spend with no line to attach to.
        unbudgeted,
      },
    };
  }

  /**
   * Every active budget's variance, added up.
   *
   * Built by running the existing per-budget report rather than by writing a
   * second aggregate: two implementations of "committed plus actual against
   * planned" is exactly how two screens come to disagree about whether a
   * budget is overspent. The loop is over budgets, of which an organisation
   * has a handful, not over lines.
   */
  async varianceSummary(fiscalYear?: number) {
    const budgets = await this.prisma.budget.findMany({
      where: {
        status: { in: ['ACTIVE', 'APPROVED'] },
        ...(fiscalYear ? { fiscalYear } : {}),
      },
      select: { id: true, name: true, fiscalYear: true },
    });

    const reports = await Promise.all(budgets.map((b) => this.varianceReport(b.id)));

    let planned = 0;
    let committed = 0;
    let actual = 0;
    let overBudget = 0;

    const rows = reports.map((report: any, i) => {
      const lines = report?.data?.lines ?? report?.lines ?? [];
      const sum = (key: string) => lines.reduce((a: number, l: any) => a + Number(l[key] ?? 0), 0);
      const p = sum('planned');
      const c = sum('committed');
      const a = sum('actual');
      planned += p;
      committed += c;
      actual += a;
      if (c + a > p) overBudget += 1;
      return {
        budgetId: budgets[i].id,
        name: budgets[i].name,
        fiscalYear: budgets[i].fiscalYear,
        planned: p,
        committed: c,
        actual: a,
        remaining: p - c - a,
      };
    });

    return {
      success: true,
      data: {
        rows,
        totals: {
          budgets: budgets.length,
          overBudget,
          planned,
          committed,
          actual,
          remaining: planned - committed - actual,
        },
      },
    };
  }
}
