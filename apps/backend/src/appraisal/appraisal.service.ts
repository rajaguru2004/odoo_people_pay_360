import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { getBranchContext } from '../common/branch/branch-context';
import { HrmPrincipal } from '../mcp/tool.types';
import { PrismaService } from '../prisma/prisma.service';
import { TERMINAL_STATUSES } from './appraisal.types';
import { AppraisalPeriodPreset, CreateAppraisalRunDto } from './dto/create-appraisal-run.dto';

const PRESET_MONTHS: Record<Exclude<AppraisalPeriodPreset, 'CUSTOM'>, number> = {
  LAST_MONTH: 1,
  LAST_QUARTER: 3,
  LAST_6_MONTHS: 6,
  LAST_YEAR: 12,
};

const PRESET_LABELS: Record<AppraisalPeriodPreset, string> = {
  LAST_MONTH: 'Last Month',
  LAST_QUARTER: 'Last Quarter',
  LAST_6_MONTHS: 'Last 6 Months',
  LAST_YEAR: 'Last Year',
  CUSTOM: 'Custom Period',
};

@Injectable()
export class AppraisalService {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(user: HrmPrincipal, dto: CreateAppraisalRunDto) {
    const { start, end } = this.resolvePeriod(dto);
    const branchId = getBranchContext()?.effectiveBranchId ?? null;

    const active = await this.prisma.appraisalRun.count({
      where: { status: { in: ['PENDING', 'RUNNING'] }, ...(branchId ? { branchId } : {}) },
    });
    if (active > 0) {
      throw new ConflictException(
        'An appraisal run is already in progress. Wait for it to finish or cancel it first.',
      );
    }

    return this.prisma.appraisalRun.create({
      data: {
        status: 'PENDING',
        periodStart: start,
        periodEnd: end,
        periodLabel: PRESET_LABELS[dto.preset],
        branchId,
        scopeJson: {
          ...(dto.departmentIds?.length ? { departmentIds: dto.departmentIds } : {}),
          ...(dto.employeeIds?.length ? { employeeIds: dto.employeeIds } : {}),
        },
        createdById: user.id,
      },
    });
  }

  async listRuns(user: HrmPrincipal) {
    return this.prisma.appraisalRun.findMany({
      where: this.accessWhere(user),
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        periodStart: true,
        periodEnd: true,
        periodLabel: true,
        branchId: true,
        totalEmployees: true,
        completedEmployees: true,
        toolCallCount: true,
        currentPhase: true,
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });
  }

  async getRun(user: HrmPrincipal, id: string) {
    const run = await this.prisma.appraisalRun.findUnique({
      where: { id },
      include: {
        results: {
          orderBy: [{ rankOverall: { sort: 'asc', nulls: 'last' } }, { employeeName: 'asc' }],
        },
      },
    });
    if (!run) throw new NotFoundException('Appraisal run not found');
    this.assertAccess(user, run.branchId);
    return run;
  }

  /** Lightweight access + status check for the SSE endpoint. */
  async getRunMeta(user: HrmPrincipal, id: string) {
    const run = await this.prisma.appraisalRun.findUnique({
      where: { id },
      select: { id: true, status: true, branchId: true },
    });
    if (!run) throw new NotFoundException('Appraisal run not found');
    this.assertAccess(user, run.branchId);
    return { ...run, isTerminal: TERMINAL_STATUSES.includes(run.status as any) };
  }

  async getResult(user: HrmPrincipal, runId: string, resultId: string) {
    const result = await this.prisma.appraisalResult.findUnique({
      where: { id: resultId },
      include: { run: { select: { id: true, branchId: true, periodStart: true, periodEnd: true, periodLabel: true, weightsJson: true } } },
    });
    if (!result || result.runId !== runId) throw new NotFoundException('Appraisal result not found');
    this.assertAccess(user, result.run.branchId);
    return result;
  }

  async deleteRun(user: HrmPrincipal, id: string) {
    const run = await this.prisma.appraisalRun.findUnique({
      where: { id },
      select: { id: true, status: true, branchId: true, createdById: true },
    });
    if (!run) throw new NotFoundException('Appraisal run not found');
    this.assertAccess(user, run.branchId);
    if (user.role !== 'ADMIN' && run.createdById !== user.id) {
      throw new ForbiddenException('Only admins or the run creator can delete a run');
    }
    if (!TERMINAL_STATUSES.includes(run.status as any)) {
      throw new ConflictException('Cancel the run before deleting it');
    }
    await this.prisma.appraisalRun.delete({ where: { id } });
    return { deleted: true };
  }

  async assertCancellable(user: HrmPrincipal, id: string) {
    const run = await this.prisma.appraisalRun.findUnique({
      where: { id },
      select: { id: true, status: true, branchId: true },
    });
    if (!run) throw new NotFoundException('Appraisal run not found');
    this.assertAccess(user, run.branchId);
    if (TERMINAL_STATUSES.includes(run.status as any)) {
      throw new ConflictException('Run already finished');
    }
    return run;
  }

  private assertAccess(user: HrmPrincipal, branchId: string | null): void {
    if (user.isGlobalBranchAccess || user.accessibleBranchIds === 'ALL') return;
    if (branchId && user.accessibleBranchIds.includes(branchId)) return;
    throw new ForbiddenException('You do not have access to this appraisal run');
  }

  private accessWhere(user: HrmPrincipal) {
    if (user.isGlobalBranchAccess || user.accessibleBranchIds === 'ALL') return {};
    return { branchId: { in: user.accessibleBranchIds } };
  }

  private resolvePeriod(dto: CreateAppraisalRunDto): { start: Date; end: Date } {
    if (dto.preset === AppraisalPeriodPreset.CUSTOM) {
      if (!dto.startDate || !dto.endDate) {
        throw new BadRequestException('startDate and endDate are required for a custom period');
      }
      const start = new Date(`${dto.startDate.slice(0, 10)}T00:00:00.000Z`);
      const end = new Date(`${dto.endDate.slice(0, 10)}T00:00:00.000Z`);
      if (!(start < end)) throw new BadRequestException('startDate must be before endDate');
      return { start, end };
    }
    const months = PRESET_MONTHS[dto.preset];
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - months);
    return { start, end };
  }

  /**
   * Appraisal runs by state, and whether one is going right now.
   *
   * A run is long-lived and asynchronous, so "is anything in flight" is the
   * question the hub actually needs — a count of completed runs says nothing
   * about whether this cycle has started.
   */
  async stats() {
    const [byStatus, active, latest] = await Promise.all([
      this.prisma.appraisalRun.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.appraisalRun.findFirst({
        where: { status: { in: ['PENDING', 'RUNNING'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, createdAt: true, totalEmployees: true },
      }),
      this.prisma.appraisalRun.findFirst({
        where: { status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, totalEmployees: true },
      }),
    ]);

    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));

    return {
      success: true,
      data: {
        byStatus: counts,
        completed: counts['COMPLETED'] ?? 0,
        activeRun: active ?? null,
        lastCompletedRun: latest ?? null,
      },
    };
  }
}
