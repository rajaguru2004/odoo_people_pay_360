import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { GratuityService } from '../gratuity/gratuity.service';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';
import { assertBranchAssignable } from '../common/branch/branch-scope.util';
import {
  composeSettlement,
  totalsFor,
  type SettlementVariant,
} from './settlement-composer';

const VARIANTS: SettlementVariant[] = [
  'RESIGNATION',
  'TERMINATION',
  'RETIREMENT',
  'DEATH',
  'CONTRACT_END',
];

@Injectable()
export class FinalSettlementsService {
  private readonly logger = new Logger(FinalSettlementsService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private features: PayrollFeaturesService,
    private gratuity: GratuityService,
  ) {}

  private async assertEnabled() {
    const f = await this.features.resolve();
    if (!f.eosbEnabled || !f.eosbSettlementEnabled) {
      throw new NotFoundException('Final settlements are not enabled');
    }
    return f;
  }

  /**
   * Prepare a settlement, computing every line and storing the working.
   *
   * The parts come from the services that own them — gratuity from the rule
   * engine, encashment from the leave policy, loans from their own ledger — so
   * this assembles rather than calculates. Anything it calculated itself would
   * be a second definition of a number that already exists somewhere.
   */
  async create(dto: Record<string, unknown>, user: any) {
    await this.assertEnabled();

    const employeeId = String(dto.employeeId ?? '');
    const variant = String(dto.variant ?? '') as SettlementVariant;
    if (!VARIANTS.includes(variant)) {
      throw new BadRequestException(
        `variant must be one of ${VARIANTS.join(', ')}.`,
      );
    }
    const lastWorkingDate = dto.lastWorkingDate
      ? new Date(String(dto.lastWorkingDate))
      : null;
    if (!lastWorkingDate || Number.isNaN(lastWorkingDate.getTime())) {
      throw new BadRequestException('lastWorkingDate is required.');
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        employeeCode: true,
        departmentId: true,
        branchId: true,
        startDate: true,
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertCanAccessEmployeeRecord(user, employee, 'prepare a settlement for');
    if (!employee.branchId) {
      throw new BadRequestException(
        'This employee has no branch, so a settlement cannot be costed to one.',
      );
    }
    assertBranchAssignable(employee.branchId);

    const open = await this.prisma.finalSettlement.findFirst({
      where: { employeeId, status: { in: ['DRAFT', 'APPROVED'] } },
    });
    if (open) {
      throw new ConflictException(
        `${employee.fullName} already has a ${open.status.toLowerCase()} ` +
          `settlement. Two settlements for one leaver is how somebody is paid ` +
          `twice — cancel the existing one first.`,
      );
    }

    const parts = await this.gatherParts(employee, lastWorkingDate, dto);
    const composed = composeSettlement({ variant, ...parts.compose });

    const created = await this.prisma.$transaction(async (tx) => {
      const settlement = await tx.finalSettlement.create({
        data: {
          employeeId,
          branchId: employee.branchId!,
          variant,
          lastWorkingDate,
          noticeServedDays: parts.noticeServedDays,
          noticeRequiredDays: parts.noticeRequiredDays,
          status: 'DRAFT',
          workingJson: {
            preparedFor: employee.employeeCode,
            lastWorkingDate: lastWorkingDate.toISOString().slice(0, 10),
            gratuity: parts.gratuityWorking,
            lines: composed.workingLines,
          } as never,
          totalEarnings: new Prisma.Decimal(composed.totalEarnings.toFixed(2)),
          totalDeductions: new Prisma.Decimal(composed.totalDeductions.toFixed(2)),
          netPayable: new Prisma.Decimal(composed.netPayable.toFixed(2)),
          payrollId: (dto.payrollId as string) ?? null,
          preparedBy: user?.id ?? null,
        },
      });

      if (composed.lines.length > 0) {
        await tx.finalSettlementLine.createMany({
          data: composed.lines.map((l) => ({
            settlementId: settlement.id,
            category: l.category,
            code: l.code,
            label: l.label,
            computedAmount: new Prisma.Decimal(l.computedAmount.toFixed(2)),
            sourceType: l.sourceType,
            sourceId: l.sourceId,
            displayOrder: l.displayOrder,
          })),
        });
      }
      return settlement;
    });

    await this.audit.log({
      userId: user?.id,
      action: 'SETTLEMENT_PREPARED',
      resourceType: 'FinalSettlement',
      resourceId: created.id,
      branchId: employee.branchId,
      newData: {
        variant,
        netPayable: composed.netPayable,
        isReceivable: composed.isReceivable,
      },
    });
    return this.findOne(created.id, user);
  }

  async findOne(id: string, user: unknown) {
    const settlement = await this.prisma.finalSettlement.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { displayOrder: 'asc' } },
        employee: {
          select: {
            id: true,
            fullName: true,
            employeeCode: true,
            departmentId: true,
            branchId: true,
            startDate: true,
            position: true,
          },
        },
      },
    });
    if (!settlement) throw new NotFoundException('Settlement not found');
    assertCanAccessEmployeeRecord(user, settlement.employee, 'view the settlement for');
    return { success: true, data: settlement };
  }

  async list(branchId?: string, status?: string) {
    const data = await this.prisma.finalSettlement.findMany({
      where: {
        ...(branchId ? { branchId } : {}),
        ...(status ? { status } : {}),
      },
      include: {
        employee: { select: { fullName: true, employeeCode: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data };
  }

  /**
   * Override one line.
   *
   * The reason is mandatory at the database as well as here — HR knows things
   * the system does not, and may change any figure, but never silently. Totals
   * are recomputed from the adjusted amounts immediately, so the header can
   * never disagree with the lines under it.
   */
  async adjustLine(
    settlementId: string,
    lineId: string,
    dto: { amount: number; reason: string },
    user: any,
  ) {
    await this.assertEnabled();
    const settlement = await this.prisma.finalSettlement.findUnique({
      where: { id: settlementId },
      include: {
        lines: true,
        employee: { select: { id: true, departmentId: true, branchId: true } },
      },
    });
    if (!settlement) throw new NotFoundException('Settlement not found');
    assertCanAccessEmployeeRecord(user, settlement.employee, 'adjust the settlement for');
    assertBranchAssignable(settlement.branchId);

    if (settlement.status !== 'DRAFT') {
      throw new ConflictException(
        `This settlement is ${settlement.status}; only a DRAFT can be adjusted.`,
      );
    }
    const line = settlement.lines.find((l) => l.id === lineId);
    if (!line) throw new NotFoundException('Settlement line not found');

    const reason = String(dto?.reason ?? '').trim();
    if (!reason) {
      // Refused here with a sentence, rather than letting the CHECK refuse it
      // with a constraint name nobody can act on.
      throw new BadRequestException(
        'A reason is required to change a settlement line. The figure and the ' +
          'reason are stored together, because a settlement is read years later ' +
          'by people who were not in the room.',
      );
    }
    const amount = Number(dto?.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException(
        'The adjusted amount must be zero or more. Use the line’s category to ' +
          'change which side of the settlement it falls on, not a minus sign.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.finalSettlementLine.update({
        where: { id: lineId },
        data: {
          adjustedAmount: new Prisma.Decimal(amount.toFixed(2)),
          adjustmentReason: reason,
          adjustedBy: user?.id ?? null,
          adjustedAt: new Date(),
        },
      });
      const lines = await tx.finalSettlementLine.findMany({
        where: { settlementId },
      });
      const totals = totalsFor(
        lines.map((l) => ({
          category: l.category,
          computedAmount: l.computedAmount,
          adjustedAmount: l.adjustedAmount,
        })),
      );
      return tx.finalSettlement.update({
        where: { id: settlementId },
        data: {
          totalEarnings: new Prisma.Decimal(totals.totalEarnings.toFixed(2)),
          totalDeductions: new Prisma.Decimal(totals.totalDeductions.toFixed(2)),
          netPayable: new Prisma.Decimal(totals.netPayable.toFixed(2)),
        },
      });
    });

    await this.audit.log({
      userId: user?.id,
      action: 'SETTLEMENT_LINE_ADJUSTED',
      resourceType: 'FinalSettlement',
      resourceId: settlementId,
      branchId: settlement.branchId,
      oldData: { line: line.code, computed: Number(line.computedAmount) },
      newData: { line: line.code, adjusted: amount, reason },
    });
    return { success: true, data: updated };
  }

  /**
   * Approve, and consume the provisions this settlement pays out.
   *
   * Flipping the accruals to SETTLED is what makes the unlock guard meaningful:
   * a payroll whose provision has already been paid out refuses to be unlocked,
   * rather than reversing an accrual a settlement is standing on.
   */
  async approve(id: string, user: any) {
    await this.assertEnabled();
    const settlement = await this.prisma.finalSettlement.findUnique({
      where: { id },
      include: { employee: { select: { id: true, departmentId: true, branchId: true } } },
    });
    if (!settlement) throw new NotFoundException('Settlement not found');
    assertCanAccessEmployeeRecord(user, settlement.employee, 'approve the settlement for');
    assertBranchAssignable(settlement.branchId);
    if (settlement.status !== 'DRAFT') {
      throw new ConflictException(
        `This settlement is ${settlement.status}, so it cannot be approved.`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.gratuityAccrual.updateMany({
        where: { employeeId: settlement.employeeId, status: 'ACCRUED' },
        data: { status: 'SETTLED', settlementId: id },
      });
      return tx.finalSettlement.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedBy: user?.id ?? null,
          approvedAt: new Date(),
        },
      });
    });

    await this.audit.log({
      userId: user?.id,
      action: 'SETTLEMENT_APPROVED',
      resourceType: 'FinalSettlement',
      resourceId: id,
      branchId: settlement.branchId,
      oldData: { status: 'DRAFT' },
      newData: { status: 'APPROVED', netPayable: Number(settlement.netPayable) },
    });
    return { success: true, data: updated };
  }

  async markPaid(id: string, user: any) {
    await this.assertEnabled();
    const settlement = await this.prisma.finalSettlement.findUnique({
      where: { id },
      include: { employee: { select: { id: true, departmentId: true, branchId: true } } },
    });
    if (!settlement) throw new NotFoundException('Settlement not found');
    assertBranchAssignable(settlement.branchId);
    if (settlement.status !== 'APPROVED') {
      throw new ConflictException(
        `Only an APPROVED settlement can be marked paid; this one is ${settlement.status}.`,
      );
    }
    const updated = await this.prisma.finalSettlement.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date() },
    });
    await this.audit.log({
      userId: user?.id,
      action: 'SETTLEMENT_PAID',
      resourceType: 'FinalSettlement',
      resourceId: id,
      branchId: settlement.branchId,
      newData: { netPayable: Number(settlement.netPayable) },
    });
    return { success: true, data: updated };
  }

  /**
   * Cancel, releasing the provisions back.
   *
   * A cancelled settlement must not leave the accruals it consumed marked
   * SETTLED, or the payroll they came from stays permanently un-unlockable for
   * a settlement that no longer exists.
   */
  async cancel(id: string, reason: string, user: any) {
    await this.assertEnabled();
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to cancel a settlement.');
    }
    const settlement = await this.prisma.finalSettlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Settlement not found');
    assertBranchAssignable(settlement.branchId);
    if (settlement.status === 'PAID') {
      throw new ConflictException(
        'This settlement has been paid and cannot be cancelled. Raise a ' +
          'correction instead, so the payment stays on the record.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.gratuityAccrual.updateMany({
        where: { settlementId: id, status: 'SETTLED' },
        data: { status: 'ACCRUED', settlementId: null },
      });
      return tx.finalSettlement.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
      });
    });

    await this.audit.log({
      userId: user?.id,
      action: 'SETTLEMENT_CANCELLED',
      resourceType: 'FinalSettlement',
      resourceId: id,
      branchId: settlement.branchId,
      newData: { reason },
    });
    return { success: true, data: updated };
  }

  /** The figures a settlement is built from, each owned by its own service. */
  private async gatherParts(
    employee: { id: string; branchId: string | null; startDate: Date },
    lastWorkingDate: Date,
    dto: Record<string, unknown>,
  ) {
    const [entitlement, encashRows, loanRows, carryRows, garnishRows] =
      await Promise.all([
        this.gratuity
          .entitlementFor(employee.id, { role: 'ADMIN' }, lastWorkingDate)
          .catch(() => null),
        this.prisma.leaveEncashmentRequest.findMany({
          where: { employeeId: employee.id, status: 'APPROVED', payrollItemId: null },
        }),
        this.prisma.advanceLoanRequest.findMany({
          where: {
            employeeId: employee.id,
            status: { notIn: ['CLOSED', 'REJECTED', 'CANCELLED', 'WRITTEN_OFF'] },
          },
          select: { id: true, amount: true, amountRepaid: true },
        }),
        this.prisma.payrollCarryForward.findMany({
          where: { employeeId: employee.id, status: 'OUTSTANDING' },
        }),
        this.prisma.garnishmentOrder.findMany({
          where: { employeeId: employee.id, isActive: true },
        }),
      ]);

    const gratuity = Number((entitlement as any)?.data?.amount ?? 0);
    const leaveEncashment = encashRows.reduce(
      (a, r) => a + Number(r.amount ?? 0),
      0,
    );
    const loanRecovery = loanRows.reduce(
      (a, l) => a + Math.max(0, Number(l.amount) - Number(l.amountRepaid ?? 0)),
      0,
    );
    const carryForward = carryRows.reduce(
      (a, c) => a + Math.max(0, Number(c.amount) - Number(c.amountRecovered ?? 0)),
      0,
    );
    const garnishment = garnishRows.reduce(
      (a, g) =>
        a +
        (g.totalCap
          ? Math.max(0, Number(g.totalCap) - Number(g.collected ?? 0))
          : 0),
      0,
    );

    const noticeRequiredDays = dto.noticeRequiredDays as number | undefined;
    const noticeServedDays = dto.noticeServedDays as number | undefined;

    return {
      noticeRequiredDays: noticeRequiredDays ?? null,
      noticeServedDays: noticeServedDays ?? null,
      gratuityWorking: (entitlement as any)?.data?.workingLines ?? [],
      compose: {
        pendingSalary: Number(dto.pendingSalary ?? 0),
        gratuity,
        leaveEncashment,
        noticePay: Number(dto.noticePay ?? 0),
        otherEarnings:
          (dto.otherEarnings as Array<{ code: string; label: string; amount: number }>) ?? [],
        loanRecovery,
        garnishment,
        recoveries: [],
        carryForward,
        otherDeductions:
          (dto.otherDeductions as Array<{ code: string; label: string; amount: number }>) ?? [],
      },
    };
  }

  variants() {
    return { success: true, data: VARIANTS };
  }

  /** What is still open on the settlement desk, and what it will cost. */
  async stats() {
    const OPEN = ['DRAFT', 'APPROVED'];

    const [byStatus, openPayout] = await Promise.all([
      this.prisma.finalSettlement.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.finalSettlement.aggregate({
        where: { status: { in: OPEN } },
        _sum: { netPayable: true },
      }),
    ]);

    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));

    return {
      success: true,
      data: {
        draft: counts['DRAFT'] ?? 0,
        awaitingPayment: counts['APPROVED'] ?? 0,
        byStatus: counts,
        // Money that will leave the business once these are paid — not what
        // has already been paid, which is a different and less useful figure.
        openPayout: Number(openPayout._sum.netPayable ?? 0),
      },
    };
  }
}
