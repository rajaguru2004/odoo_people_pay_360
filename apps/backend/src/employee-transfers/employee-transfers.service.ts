import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';
import { assertBranchAssignable } from '../common/branch/branch-scope.util';

@Injectable()
export class EmployeeTransfersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private features: PayrollFeaturesService,
  ) {}

  private async assertEnabled() {
    const f = await this.features.resolve();
    if (!f.employeeTransferEnabled) {
      throw new NotFoundException('Branch transfers are not enabled');
    }
    return f;
  }

  async request(dto: Record<string, unknown>, user: any) {
    await this.assertEnabled();

    const employeeId = String(dto.employeeId ?? '');
    const toBranchId = String(dto.toBranchId ?? '');
    const reason = String(dto.reason ?? '').trim();
    const effectiveDate = dto.effectiveDate ? new Date(String(dto.effectiveDate)) : null;

    if (!reason) {
      throw new BadRequestException(
        'A reason is required. A transfer crosses the branch isolation axis, so ' +
          'it is recorded as a decision somebody made, not as a field edit.',
      );
    }
    if (!effectiveDate || Number.isNaN(effectiveDate.getTime())) {
      throw new BadRequestException('effectiveDate is required.');
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        employeeCode: true,
        departmentId: true,
        branchId: true,
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertCanAccessEmployeeRecord(user, employee, 'transfer');
    if (!employee.branchId) {
      throw new BadRequestException('This employee has no branch to transfer from.');
    }
    if (employee.branchId === toBranchId) {
      throw new BadRequestException(
        'That is the branch the employee is already in.',
      );
    }
    // Both ends must be reachable by whoever is asking: a transfer INTO a branch
    // you cannot see is a way to move someone out of your own scope and lose them.
    assertBranchAssignable(employee.branchId);
    assertBranchAssignable(toBranchId);

    const target = await this.prisma.branch.findUnique({
      where: { id: toBranchId },
      select: { id: true, name: true, isActive: true },
    });
    if (!target) throw new NotFoundException('Destination branch not found');
    if (!target.isActive) {
      throw new BadRequestException(
        `${target.name} is not active, so nobody can be transferred into it.`,
      );
    }

    const open = await this.prisma.employeeTransfer.findFirst({
      where: { employeeId, status: { in: ['PENDING', 'APPROVED'] } },
    });
    if (open) {
      throw new ConflictException(
        `${employee.fullName} already has a ${open.status.toLowerCase()} ` +
          `transfer. Two queued transfers make "which branch pays them this ` +
          `month?" unanswerable — resolve that one first.`,
      );
    }

    const created = await this.prisma.employeeTransfer.create({
      data: {
        employeeId,
        fromBranchId: employee.branchId,
        toBranchId,
        fromDepartmentId: employee.departmentId,
        toDepartmentId: (dto.toDepartmentId as string) ?? null,
        effectiveDate,
        reason,
        requestedBy: user?.id ?? null,
        notes: (dto.notes as string) ?? null,
      },
    });

    await this.audit.log({
      userId: user?.id,
      action: 'EMPLOYEE_TRANSFER_REQUESTED',
      resourceType: 'EmployeeTransfer',
      resourceId: created.id,
      branchId: employee.branchId,
      newData: {
        employeeCode: employee.employeeCode,
        from: employee.branchId,
        to: toBranchId,
        effectiveDate: effectiveDate.toISOString().slice(0, 10),
      },
    });
    return { success: true, data: created };
  }

  async approve(id: string, user: any) {
    await this.assertEnabled();
    const transfer = await this.load(id, user);
    if (transfer.status !== 'PENDING') {
      throw new ConflictException(
        `This transfer is ${transfer.status}, so it cannot be approved.`,
      );
    }
    const data = await this.prisma.employeeTransfer.update({
      where: { id },
      data: { status: 'APPROVED', approvedBy: user?.id ?? null, approvedAt: new Date() },
    });
    await this.audit.log({
      userId: user?.id,
      action: 'EMPLOYEE_TRANSFER_APPROVED',
      resourceType: 'EmployeeTransfer',
      resourceId: id,
      branchId: transfer.fromBranchId,
      oldData: { status: 'PENDING' },
      newData: { status: 'APPROVED' },
    });
    return { success: true, data };
  }

  async reject(id: string, reason: string, user: any) {
    await this.assertEnabled();
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to reject a transfer.');
    }
    const transfer = await this.load(id, user);
    if (transfer.status !== 'PENDING') {
      throw new ConflictException(`This transfer is ${transfer.status}.`);
    }
    const data = await this.prisma.employeeTransfer.update({
      where: { id },
      data: { status: 'REJECTED', rejectedReason: reason },
    });
    await this.audit.log({
      userId: user?.id,
      action: 'EMPLOYEE_TRANSFER_REJECTED',
      resourceType: 'EmployeeTransfer',
      resourceId: id,
      branchId: transfer.fromBranchId,
      newData: { reason },
    });
    return { success: true, data };
  }

  /**
   * Apply the move.
   *
   * Manual rather than scheduled: a cron that moves people between branches
   * unattended has a blast radius nobody would choose, because a transfer
   * changes which branch's payroll pays somebody.
   */
  async apply(id: string, user: any) {
    const features = await this.assertEnabled();
    const transfer = await this.load(id, user);
    if (transfer.status !== 'APPROVED') {
      throw new ConflictException(
        `Only an APPROVED transfer can be applied; this one is ${transfer.status}.`,
      );
    }
    assertBranchAssignable(transfer.toBranchId);

    // An open run in either branch would be re-priced underneath itself: the
    // employee's payslip already exists in one branch and the transfer would
    // move who owns it. Refused rather than resolved, because there is no
    // resolution that does not surprise somebody.
    const month = transfer.effectiveDate.getUTCMonth() + 1;
    const year = transfer.effectiveDate.getUTCFullYear();
    const openRun = await this.prisma.payroll.findFirst({
      where: {
        month,
        year,
        branchId: { in: [transfer.fromBranchId, transfer.toBranchId] },
        status: { not: 'LOCKED' },
      },
      select: { id: true, status: true, branchId: true },
    });
    if (openRun) {
      throw new ConflictException(
        `A ${openRun.status} payroll for ${month}/${year} already exists in one ` +
          `of the two branches. Applying the transfer now would move who owns ` +
          `that run while it is still open. Lock or delete it first.`,
      );
    }

    const applied = await this.prisma.$transaction(async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: transfer.employeeId },
        select: { branchId: true, departmentId: true },
      });

      await tx.employee.update({
        where: { id: transfer.employeeId },
        data: {
          branchId: transfer.toBranchId,
          ...(transfer.toDepartmentId
            ? { departmentId: transfer.toDepartmentId }
            : {}),
        },
      });

      // The existing journal, not a new mechanism: `EmployeeHistory` is where
      // every other field change on an employee is recorded, and a transfer
      // should be findable in the same place.
      //
      // `changedBy` is NOT NULL, so a caller with no user id would fail the
      // insert and take the whole transfer down with it. The move is what
      // matters; the journal entry is skipped rather than allowed to break it,
      // and the audit row below still names who did it either way.
      if (user?.id) {
        await tx.employeeHistory.create({
          data: {
            employeeId: transfer.employeeId,
            field: 'branchId',
            oldValue: employee?.branchId ?? null,
            newValue: transfer.toBranchId,
            changedBy: user.id,
          },
        });
      }

      return tx.employeeTransfer.update({
        where: { id },
        data: { status: 'APPLIED', appliedAt: new Date() },
      });
    });

    await this.audit.log({
      userId: user?.id,
      action: 'EMPLOYEE_TRANSFER_APPLIED',
      resourceType: 'EmployeeTransfer',
      resourceId: id,
      branchId: transfer.toBranchId,
      oldData: { branchId: transfer.fromBranchId },
      newData: {
        branchId: transfer.toBranchId,
        effectiveDate: transfer.effectiveDate.toISOString().slice(0, 10),
        payBasis: features.transferPayBasis,
      },
    });
    return { success: true, data: applied };
  }

  async cancel(id: string, user: any) {
    await this.assertEnabled();
    const transfer = await this.load(id, user);
    if (transfer.status === 'APPLIED') {
      throw new ConflictException(
        'This transfer has been applied. Raise a transfer back the other way ' +
          'rather than cancelling, so both moves stay on the record.',
      );
    }
    const data = await this.prisma.employeeTransfer.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await this.audit.log({
      userId: user?.id,
      action: 'EMPLOYEE_TRANSFER_CANCELLED',
      resourceType: 'EmployeeTransfer',
      resourceId: id,
      branchId: transfer.fromBranchId,
    });
    return { success: true, data };
  }

  async list(branchId?: string, status?: string) {
    const data = await this.prisma.employeeTransfer.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(branchId
          ? { OR: [{ fromBranchId: branchId }, { toBranchId: branchId }] }
          : {}),
      },
      include: {
        employee: { select: { fullName: true, employeeCode: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data };
  }

  async findForEmployee(employeeId: string, user: unknown) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true, branchId: true, fullName: true, employeeCode: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertCanAccessEmployeeRecord(user, employee, 'view transfers for');
    const data = await this.prisma.employeeTransfer.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data };
  }

  private async load(id: string, user: unknown) {
    const transfer = await this.prisma.employeeTransfer.findUnique({
      where: { id },
      include: {
        employee: {
          select: { id: true, departmentId: true, branchId: true, fullName: true, employeeCode: true },
        },
      },
    });
    if (!transfer) throw new NotFoundException('Transfer not found');
    assertCanAccessEmployeeRecord(user, transfer.employee, 'act on the transfer for');
    return transfer;
  }
}
