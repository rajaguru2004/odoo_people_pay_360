import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';
import { assertBranchAssignable } from '../common/branch/branch-scope.util';
import {
  allocateRecoveries,
  labelFor,
  type RecoveryAllocation,
  type RecoveryOrder,
} from './recovery-allocator';

const KINDS = [
  'ASSET_DAMAGE',
  'ASSET_LOSS',
  'TRAINING_BOND',
  'NOTICE_SHORTFALL',
  'OTHER',
];

const toOrder = (r: {
  id: string;
  kind: string;
  reference: string | null;
  totalAmount: unknown;
  amountRecovered: unknown;
  instalmentAmount: unknown;
  startDate: Date;
  endDate: Date | null;
  priority: number;
  status: string;
}): RecoveryOrder => ({
  id: r.id,
  kind: r.kind,
  reference: r.reference,
  totalAmount: Number(r.totalAmount),
  amountRecovered: Number(r.amountRecovered),
  instalmentAmount: r.instalmentAmount === null ? null : Number(r.instalmentAmount),
  startDate: r.startDate,
  endDate: r.endDate,
  priority: r.priority,
  status: r.status,
});

@Injectable()
export class EmployeeRecoveriesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  static allocate = allocateRecoveries;

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async create(dto: Record<string, unknown>, user: any) {
    const employeeId = String(dto.employeeId ?? '');
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, employeeCode: true, departmentId: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertCanAccessEmployeeRecord(user, employee, 'raise a recovery against');
    if (!employee.branchId) {
      throw new BadRequestException(
        'This employee has no branch, so a recovery cannot be costed to one.',
      );
    }
    assertBranchAssignable(employee.branchId);

    const kind = String(dto.kind ?? 'OTHER');
    if (!KINDS.includes(kind)) {
      throw new BadRequestException(`kind must be one of ${KINDS.join(', ')}.`);
    }
    const totalAmount = Number(dto.totalAmount ?? 0);
    if (!(totalAmount > 0)) {
      throw new BadRequestException('totalAmount must be more than zero.');
    }
    if (dto.assetAssignmentId && !['ASSET_DAMAGE', 'ASSET_LOSS'].includes(kind)) {
      throw new BadRequestException(
        'An asset assignment can only be linked to an ASSET_DAMAGE or ASSET_LOSS ' +
          'recovery. Linking one to a training bond would double-count that ' +
          "asset's cost in the asset report.",
      );
    }

    const created = await this.prisma.employeeRecovery.create({
      data: {
        employeeId,
        branchId: employee.branchId,
        kind,
        assetAssignmentId: (dto.assetAssignmentId as string) ?? null,
        reference: (dto.reference as string) ?? null,
        totalAmount: new Prisma.Decimal(totalAmount.toFixed(2)),
        instalmentAmount: dto.instalmentAmount
          ? new Prisma.Decimal(Number(dto.instalmentAmount).toFixed(2))
          : null,
        startDate: dto.startDate ? new Date(String(dto.startDate)) : new Date(),
        endDate: dto.endDate ? new Date(String(dto.endDate)) : null,
        priority: Number(dto.priority ?? 200),
        reason: (dto.reason as string) ?? null,
        createdBy: user?.id ?? null,
      },
    });

    await this.audit.log({
      userId: user?.id,
      action: 'RECOVERY_RAISED',
      resourceType: 'EmployeeRecovery',
      resourceId: created.id,
      branchId: employee.branchId,
      newData: { kind, totalAmount, reference: created.reference },
    });
    return { success: true, data: created };
  }

  async findByEmployee(employeeId: string, user: unknown) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true, branchId: true, fullName: true, employeeCode: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertCanAccessEmployeeRecord(user, employee, 'view recoveries for');
    const data = await this.prisma.employeeRecovery.findMany({
      where: { employeeId },
      orderBy: [{ status: 'asc' }, { priority: 'asc' }, { startDate: 'asc' }],
    });
    return { success: true, data };
  }

  async findOne(id: string, user: unknown) {
    const recovery = await this.prisma.employeeRecovery.findUnique({
      where: { id },
      include: {
        employee: {
          select: { id: true, departmentId: true, branchId: true, fullName: true, employeeCode: true },
        },
      },
    });
    if (!recovery) throw new NotFoundException('Recovery not found');
    assertCanAccessEmployeeRecord(user, recovery.employee, 'view the recovery for');
    return recovery;
  }

  async update(id: string, dto: Record<string, unknown>, user: any) {
    const recovery = await this.findOne(id, user);
    assertBranchAssignable(recovery.branchId);
    if (recovery.status !== 'ACTIVE') {
      throw new ConflictException(
        `This recovery is ${recovery.status} and can no longer be changed.`,
      );
    }
    const data: Record<string, unknown> = {};
    if (dto.instalmentAmount !== undefined) {
      data.instalmentAmount = dto.instalmentAmount
        ? new Prisma.Decimal(Number(dto.instalmentAmount).toFixed(2))
        : null;
    }
    if (dto.endDate !== undefined) {
      data.endDate = dto.endDate ? new Date(String(dto.endDate)) : null;
    }
    if (dto.priority !== undefined) data.priority = Number(dto.priority);
    if (dto.reference !== undefined) data.reference = dto.reference;
    if (dto.reason !== undefined) data.reason = dto.reason;

    const updated = await this.prisma.employeeRecovery.update({ where: { id }, data });
    await this.audit.log({
      userId: user?.id,
      action: 'RECOVERY_AMENDED',
      resourceType: 'EmployeeRecovery',
      resourceId: id,
      branchId: recovery.branchId,
      newData: { fields: Object.keys(data) },
    });
    return { success: true, data: updated };
  }

  /**
   * Cancel — a flag flip, never a delete.
   *
   * Runs already generated under this recovery reference it; deleting the row
   * would leave those payslips with a deduction nothing explains.
   */
  async cancel(id: string, user: any) {
    const recovery = await this.findOne(id, user);
    assertBranchAssignable(recovery.branchId);
    const updated = await this.prisma.employeeRecovery.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    await this.audit.log({
      userId: user?.id,
      action: 'RECOVERY_CANCELLED',
      resourceType: 'EmployeeRecovery',
      resourceId: id,
      branchId: recovery.branchId,
      oldData: { status: recovery.status },
      newData: { status: 'CANCELLED' },
    });
    return { success: true, data: updated };
  }

  /** The only thing that erases a balance, and it demands a reason. */
  async waive(id: string, reason: string, user: any) {
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to waive a recovery.');
    }
    const recovery = await this.findOne(id, user);
    assertBranchAssignable(recovery.branchId);
    const updated = await this.prisma.employeeRecovery.update({
      where: { id },
      data: {
        status: 'WAIVED',
        waivedBy: user?.id ?? null,
        waivedAt: new Date(),
        waivedReason: reason,
      },
    });
    await this.audit.log({
      userId: user?.id,
      action: 'RECOVERY_WAIVED',
      resourceType: 'EmployeeRecovery',
      resourceId: id,
      branchId: recovery.branchId,
      newData: {
        reason,
        forgiven: Number(recovery.totalAmount) - Number(recovery.amountRecovered),
      },
    });
    return { success: true, data: updated };
  }

  /** An employee leaving does not clear a debt. */
  async markOutstandingAsReceivable(
    employeeId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const db = tx ?? this.prisma;
    const res = await db.employeeRecovery.updateMany({
      where: { employeeId, status: 'ACTIVE' },
      data: { status: 'RECEIVABLE' },
    });
    return res.count;
  }

  // ── The payroll seam ─────────────────────────────────────────────────────

  async loadForPayroll(
    employeeIds: string[],
    periodStart: Date,
    periodEnd: Date,
  ): Promise<Map<string, RecoveryOrder[]>> {
    const out = new Map<string, RecoveryOrder[]>();
    for (const id of employeeIds) out.set(id, []);
    if (employeeIds.length === 0) return out;

    const rows = await this.prisma.employeeRecovery.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: 'ACTIVE',
        startDate: { lte: periodEnd },
        OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
      },
    });
    for (const r of rows) {
      out.get(r.employeeId)?.push(toOrder(r));
    }
    return out;
  }

  /**
   * Advance `amountRecovered` and open a carry-forward for what could not be
   * taken. Runs inside the payroll's own transaction.
   */
  async persistAllocation(
    tx: Prisma.TransactionClient,
    args: {
      employeeId: string;
      branchId: string;
      payrollId: string;
      allocation: RecoveryAllocation;
    },
  ): Promise<void> {
    for (const line of args.allocation.lines) {
      if (line.amount > 0) {
        await tx.employeeRecovery.update({
          where: { id: line.recoveryId },
          data: {
            amountRecovered: { increment: new Prisma.Decimal(line.amount.toFixed(2)) },
            ...(line.closes ? { status: 'COMPLETED' } : {}),
          },
        });
      }
      if (line.shortfall > 0) {
        await tx.payrollCarryForward.create({
          data: {
            employeeId: args.employeeId,
            branchId: args.branchId,
            kind: 'RECOVERY',
            sourceId: line.recoveryId,
            amount: new Prisma.Decimal(line.shortfall.toFixed(2)),
            status: 'OUTSTANDING',
            originPayrollId: args.payrollId,
            reason:
              `${labelFor(line.kind)} could not be fully taken from this payroll.`,
          },
        });
      }
    }
  }

  /**
   * The exact mirror of `persistAllocation`.
   *
   * Called from unlock and from delete, exactly as the garnishment reversal is:
   * a run that is reversed must not leave a recovery believing it collected
   * money no payslip carries.
   */
  async reverseForPayroll(
    tx: Prisma.TransactionClient,
    payrollId: string,
  ): Promise<number> {
    const items = await tx.payrollItem.findMany({
      where: { payrollId },
      select: { employeeId: true, otherRecovery: true },
    });
    // A shortfall row records what was NOT advanced, so reversing it means
    // deleting the row and nothing else.
    await tx.payrollCarryForward.deleteMany({
      where: { originPayrollId: payrollId, kind: 'RECOVERY', status: 'OUTSTANDING' },
    });

    let reversed = 0;
    for (const item of items) {
      const taken = Number(item.otherRecovery ?? 0);
      if (taken <= 0) continue;
      // Recoveries are advanced in priority order, so they are given back in the
      // same order, newest debt last.
      const live = await tx.employeeRecovery.findMany({
        where: {
          employeeId: item.employeeId,
          status: { in: ['ACTIVE', 'COMPLETED'] },
          amountRecovered: { gt: 0 },
        },
        orderBy: [{ priority: 'asc' }, { startDate: 'asc' }, { id: 'asc' }],
      });
      let remaining = taken;
      for (const r of live) {
        if (remaining <= 0) break;
        const giveBack = Math.min(remaining, Number(r.amountRecovered));
        await tx.employeeRecovery.update({
          where: { id: r.id },
          data: {
            amountRecovered: { decrement: new Prisma.Decimal(giveBack.toFixed(2)) },
            ...(r.status === 'COMPLETED' ? { status: 'ACTIVE' } : {}),
          },
        });
        remaining -= giveBack;
        reversed += 1;
      }
    }
    return reversed;
  }

  kinds() {
    return { success: true, data: KINDS };
  }
}
