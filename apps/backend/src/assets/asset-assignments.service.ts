import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { getBranchContext } from '../common/branch/branch-context';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { AssetsService } from './assets.service';
import { AssignAssetDto } from './dto/assign-asset.dto';
import { ReturnAssetDto } from './dto/return-asset.dto';
import { AcknowledgeAssetDto } from './dto/acknowledge-asset.dto';

@Injectable()
export class AssetAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * R25 — write a custody action so it is discoverable from BOTH ends.
   *
   * The controller is `@AuditResource('AssetItem')`, but `ASSET_ASSIGNED` /
   * `ASSET_RETURNED` / `ASSET_ACKNOWLEDGED` were filed under
   * `resourceType: 'AssetAssignment'` with the ASSIGNMENT id, so zero rows
   * existed under the asset's own id. An auditor filtering the audit UI by
   * `AssetItem` — the only resource type the asset screens know about — saw the
   * register's lifecycle (created / updated / deleted) but not who was handed
   * what: the trail split in two and the asset half lost the custody half.
   *
   * `AuditService.log()` writes one flat `audit_logs` row and has no notion of
   * a secondary key, so of the two options — a second row, or the assetId
   * folded into the payload — this does BOTH, deliberately:
   *
   *   - a MIRROR row under `resourceType: 'AssetItem'` / `resourceId: assetId`,
   *     so the existing `resourceType` + `resourceId` filters (the only ones
   *     `AuditService.findAll` offers) reach it with no UI change; and
   *   - `assetId` + `assignmentId` in `newData` on both rows, so either row
   *     alone is enough to pivot to the other end without a join.
   *
   * The original `AssetAssignment` row is kept as-is: it is what the assignment
   * screens and the existing specs read.
   */
  /** `assertInBranch` as a predicate, for doors with two branch-bearing ends. */
  private isInBranchScope(branchId: string | null | undefined): boolean {
    try {
      assertInBranch(branchId);
      return true;
    } catch {
      return false;
    }
  }

  private async logCustody(entry: {
    userId?: string;
    action: string;
    assignmentId: string;
    assetId: string;
    newData: Record<string, unknown>;
  }): Promise<void> {
    const branchId = getBranchContext()?.effectiveBranchId ?? null;
    const newData = {
      ...entry.newData,
      assetId: entry.assetId,
      assignmentId: entry.assignmentId,
    };
    await this.audit.log({
      userId: entry.userId,
      action: entry.action,
      resourceType: 'AssetAssignment',
      resourceId: entry.assignmentId,
      newData,
      branchId,
    });
    await this.audit.log({
      userId: entry.userId,
      action: entry.action,
      resourceType: 'AssetItem',
      resourceId: entry.assetId,
      newData,
      branchId,
    });
  }

  /**
   * Hand an asset to an employee.
   *
   * Status flip and assignment row are one transaction: an asset marked
   * ASSIGNED with no open assignment would be invisible to clearance, and an
   * open assignment on an AVAILABLE asset would let it be handed out twice.
   */
  async assign(dto: AssignAssetDto, userId: string) {
    const [asset, employee] = await Promise.all([
      this.prisma.assetItem.findUnique({
        where: { id: dto.assetId },
        select: {
          id: true,
          assetTag: true,
          name: true,
          branchId: true,
          status: true,
          branch: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        select: {
          id: true,
          fullName: true,
          status: true,
          branchId: true,
          branch: { select: { id: true, code: true, name: true } },
          user: { select: { id: true } },
        },
      }),
    ]);

    if (!asset) throw new NotFoundException('Asset not found');
    if (!employee) throw new NotFoundException('Employee not found');
    assertInBranch(asset.branchId);
    assertInBranch(employee.branchId);

    // R1 — the two `assertInBranch` calls above check each side against the
    // CALLER's scope, never against each other, so a global ADMIN passed both
    // and nothing compared the asset's branch with the holder's.
    //
    // That is not cosmetic. `AssetItem` is scoped `direct` by its own branch,
    // while `AssetAssignment` is scoped by RELATION — the holder's branch. Once
    // the two disagree, the custody row lives in branch B while the asset lives
    // in branch A: branch A's HR sees an asset marked ASSIGNED with no visible
    // holder, the open-assignments screen they use to chase items back is
    // silent about it, and `return()` (which asserts on the HOLDER's branch)
    // answers them 404 for their own property — R1b, the lockout.
    //
    // Refusing the assignment closes both: the clearance obligation cannot
    // leave the branch that owns the asset in the first place.
    if (employee.branchId && asset.branchId !== employee.branchId) {
      const assetBranch = asset.branch
        ? `${asset.branch.name} (${asset.branch.code})`
        : asset.branchId;
      const employeeBranch = employee.branch
        ? `${employee.branch.name} (${employee.branch.code})`
        : employee.branchId;
      throw new BadRequestException(
        `Asset ${asset.assetTag} belongs to branch ${assetBranch} and cannot be assigned to ` +
          `${employee.fullName}, who is in branch ${employeeBranch}. ` +
          'Transfer the asset to that branch first, then assign it.',
      );
    }

    if (employee.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Cannot assign an asset to an employee with status ${employee.status}`,
      );
    }
    if (!AssetsService.isAssignable(asset.status)) {
      throw new BadRequestException(
        `Asset ${asset.assetTag} is ${asset.status} and cannot be assigned`,
      );
    }

    try {
      const assignment = await this.prisma.$transaction(async (tx) => {
        const created = await tx.assetAssignment.create({
          data: {
            assetId: dto.assetId,
            employeeId: dto.employeeId,
            assignedAt: dto.assignedAt ? new Date(dto.assignedAt) : new Date(),
            assignedById: userId,
            conditionOut: dto.conditionOut ?? null,
            notes: dto.notes ?? null,
          },
        });
        await tx.assetItem.update({
          where: { id: dto.assetId },
          data: { status: 'ASSIGNED' },
        });
        return created;
      });

      await this.logCustody({
        userId,
        action: 'ASSET_ASSIGNED',
        assignmentId: assignment.id,
        assetId: asset.id,
        newData: {
          assetTag: asset.assetTag,
          employeeId: dto.employeeId,
          employeeName: employee.fullName,
        },
      });

      // Prompt the digital receipt.
      if (employee.user?.id) {
        await this.notifications
          .create({
            userId: employee.user.id,
            title: 'Company asset assigned to you',
            message: `${asset.name} (${asset.assetTag}) has been assigned to you. Please acknowledge receipt.`,
            type: 'INFO' as any,
            link: '/dashboard/my-assets',
          })
          .catch(() => undefined);
      }

      return { success: true, data: assignment };
    } catch (e) {
      // The partial unique index on (asset_id) WHERE returned_at IS NULL.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `Asset ${asset.assetTag} is already assigned to someone else`,
        );
      }
      throw e;
    }
  }

  /** Record a return, closing the assignment and freeing the asset. */
  async return(assignmentId: string, dto: ReturnAssetDto, userId: string) {
    const assignment = await this.prisma.assetAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        asset: { select: { id: true, assetTag: true, name: true, branchId: true } },
        employee: { select: { id: true, fullName: true, branchId: true } },
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    // R1b — asserting on the HOLDER's branch alone locked the OWNING branch out
    // of closing custody on its own property: after a cross-branch assign,
    // branch A's HR got a 404 recording the return of branch A's own asset.
    // `assign()` now refuses that pairing (R1), so the two branches agree for
    // anything created from here on — but rows written before the guard can
    // still disagree, and the owner must be able to close them. Either end
    // being inside the caller's envelope is enough; 404 (not 403) when neither
    // is, matching `assertInBranch` and the rest of the module.
    if (
      !this.isInBranchScope(assignment.employee.branchId) &&
      !this.isInBranchScope(assignment.asset.branchId)
    ) {
      throw new NotFoundException('Assignment not found');
    }

    if (assignment.returnedAt) {
      throw new BadRequestException('This assignment was already returned');
    }

    const returnedAt = dto.returnedAt ? new Date(dto.returnedAt) : new Date();
    if (returnedAt < assignment.assignedAt) {
      throw new BadRequestException(
        'Return date cannot be before the assignment date',
      );
    }

    // A returned item is only AVAILABLE again if it came back usable; LOST and
    // IN_REPAIR must not silently re-enter the assignable pool.
    const nextStatus = dto.assetStatus ?? 'AVAILABLE';

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.assetAssignment.update({
        where: { id: assignmentId },
        data: {
          returnedAt,
          conditionIn: dto.conditionIn ?? null,
          returnReceivedById: userId,
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
      });
      await tx.assetItem.update({
        where: { id: assignment.assetId },
        data: { status: nextStatus },
      });
      return row;
    });

    await this.logCustody({
      userId,
      action: 'ASSET_RETURNED',
      assignmentId,
      assetId: assignment.assetId,
      newData: {
        assetTag: assignment.asset.assetTag,
        employeeId: assignment.employeeId,
        conditionIn: dto.conditionIn,
        assetStatus: nextStatus,
      },
    });

    return { success: true, data: updated };
  }

  /** ESS: the caller's own assets, current and past. */
  async findByEmployee(employeeId: string, openOnly = false) {
    const rows = await this.prisma.assetAssignment.findMany({
      where: { employeeId, ...(openOnly ? { returnedAt: null } : {}) },
      include: {
        asset: {
          select: {
            id: true,
            assetTag: true,
            name: true,
            category: true,
            serialNumber: true,
            warrantyExpiry: true,
          },
        },
      },
      orderBy: [{ returnedAt: 'asc' }, { assignedAt: 'desc' }],
    });
    return { success: true, data: rows };
  }

  /**
   * The employee's digital receipt. Only the holder may acknowledge — an HR
   * user confirming on their behalf would defeat the purpose of the record.
   */
  async acknowledge(
    assignmentId: string,
    dto: AcknowledgeAssetDto,
    user: any,
  ) {
    const assignment = await this.prisma.assetAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        asset: { select: { id: true, assetTag: true, name: true } },
        employee: { select: { id: true, branchId: true } },
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    assertInBranch(assignment.employee.branchId);

    if (assignment.employeeId !== user?.employeeId) {
      throw new ForbiddenException(
        'You can only acknowledge assets assigned to you',
      );
    }
    if (assignment.returnedAt) {
      throw new BadRequestException('This assignment is already closed');
    }
    if (assignment.acknowledgedAt) {
      throw new BadRequestException('You have already acknowledged this asset');
    }

    const updated = await this.prisma.assetAssignment.update({
      where: { id: assignmentId },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedNote: dto.note ?? null,
      },
    });

    await this.logCustody({
      userId: user.id,
      action: 'ASSET_ACKNOWLEDGED',
      assignmentId,
      assetId: assignment.assetId,
      newData: { assetTag: assignment.asset.assetTag, note: dto.note },
    });

    return { success: true, data: updated };
  }

  /** HR/manager view of everything currently held. */
  async findOpen(user: any, employeeId?: string) {
    const where: Prisma.AssetAssignmentWhereInput = { returnedAt: null };
    if (employeeId) where.employeeId = employeeId;

    // A department head sees only their own departments, matching how every
    // other manager-facing list in the app behaves.
    if (user?.role === 'MANAGER') {
      const deptIds = (user.managedDepartmentIds ?? []).filter(Boolean);
      if (deptIds.length === 0) return { success: true, data: [] };
      if (employeeId) {
        const emp = await this.prisma.employee.findUnique({
          where: { id: employeeId },
          select: { departmentId: true },
        });
        if (!isDeptInManagerScope(user, emp?.departmentId ?? '')) {
          throw new ForbiddenException(
            'You can only view assets for your own department',
          );
        }
      } else {
        where.employee = { departmentId: { in: deptIds } };
      }
    }

    const rows = await this.prisma.assetAssignment.findMany({
      where,
      include: {
        asset: {
          select: { id: true, assetTag: true, name: true, category: true },
        },
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            status: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
    });
    return { success: true, data: rows };
  }
}
