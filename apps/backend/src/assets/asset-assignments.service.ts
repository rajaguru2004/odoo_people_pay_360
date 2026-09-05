import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssetStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { withFullName } from '../common/utils/employee-name.util';
import { AssetsService } from './assets.service';
import { AssignAssetDto } from './dto/assign-asset.dto';
import { ReturnAssetDto } from './dto/return-asset.dto';
import { AcknowledgeAssetDto } from './dto/acknowledge-asset.dto';
import type { Principal } from '../auth/auth.service';

const ASSET_CARD = {
  id: true,
  assetTag: true,
  name: true,
  category: true,
  serialNumber: true,
  warrantyExpiry: true,
} satisfies Prisma.AssetItemSelect;

@Injectable()
export class AssetAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write a custody action so it is discoverable from BOTH ends.
   *
   * Two rows, not one: an auditor filtering by `AssetItem` — the only entity the
   * asset screens name — would otherwise see the register's lifecycle (created,
   * updated, deleted) and none of the custody, because that half was filed under
   * the assignment's own id. Both rows carry both ids, so either one is enough
   * to pivot to the other end without a join.
   */
  private async logCustody(entry: {
    userId?: string;
    action: string;
    assignmentId: string;
    assetId: string;
    metadata: Prisma.JsonObject;
  }) {
    const metadata: Prisma.JsonObject = {
      ...entry.metadata,
      assetId: entry.assetId,
      assignmentId: entry.assignmentId,
    };
    await this.prisma.auditLog.createMany({
      data: [
        {
          userId: entry.userId ?? null,
          action: entry.action,
          entityType: 'AssetAssignment',
          entityId: entry.assignmentId,
          metadata,
        },
        {
          userId: entry.userId ?? null,
          action: entry.action,
          entityType: 'AssetItem',
          entityId: entry.assetId,
          metadata,
        },
      ],
    });
  }

  /**
   * Hand an asset to an employee.
   *
   * The custody row and the status flip are one transaction, and the flip is a
   * compare-and-set on AVAILABLE: an asset marked ASSIGNED with no open
   * assignment would be invisible to clearance, and an open assignment on an
   * AVAILABLE asset would let the same laptop be handed out twice.
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
          branch: { select: { code: true, name: true } },
        },
      }),
      this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          status: true,
          branchId: true,
          branch: { select: { code: true, name: true } },
        },
      }),
    ]);

    if (!asset) throw new NotFoundException('Asset not found');
    if (!employee) throw new NotFoundException('Employee not found');

    // The clearance obligation must not be able to leave the branch that owns
    // the asset. Once the two disagree, the owning branch sees an asset marked
    // ASSIGNED with no holder it can see, and no way to chase it back.
    if (employee.branchId && asset.branchId !== employee.branchId) {
      const assetBranch = asset.branch
        ? `${asset.branch.name} (${asset.branch.code})`
        : asset.branchId;
      const employeeBranch = employee.branch
        ? `${employee.branch.name} (${employee.branch.code})`
        : employee.branchId;
      throw new BadRequestException(
        `Asset ${asset.assetTag} belongs to ${assetBranch} and cannot be assigned to somebody in ` +
          `${employeeBranch}. Transfer the asset to that branch first, then assign it.`,
      );
    }

    if (employee.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Cannot assign an asset to an employee whose status is ${employee.status}`,
      );
    }
    if (!AssetsService.isAssignable(asset.status)) {
      throw new BadRequestException(
        `Asset ${asset.assetTag} is ${asset.status} and cannot be handed out`,
      );
    }

    const assignment = await this.prisma.$transaction(async (tx) => {
      // Conditional on the status this method already read, so two concurrent
      // hand-outs cannot both win. The loser sees zero rows updated.
      const claimed = await tx.assetItem.updateMany({
        where: { id: dto.assetId, status: AssetStatus.AVAILABLE },
        data: { status: AssetStatus.ASSIGNED },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          `Asset ${asset.assetTag} was handed to somebody else a moment ago`,
        );
      }
      return tx.assetAssignment.create({
        data: {
          assetId: dto.assetId,
          employeeId: dto.employeeId,
          assignedAt: dto.assignedAt ? new Date(dto.assignedAt) : new Date(),
          assignedById: userId,
          conditionOut: dto.conditionOut ?? null,
          notes: dto.notes ?? null,
        },
      });
    });

    await this.logCustody({
      userId,
      action: 'ASSET_ASSIGNED',
      assignmentId: assignment.id,
      assetId: asset.id,
      metadata: { assetTag: asset.assetTag, employeeId: dto.employeeId },
    });

    return assignment;
  }

  /** Record a return, closing the custody and freeing the asset. */
  async return(assignmentId: string, dto: ReturnAssetDto, userId: string) {
    const assignment = await this.prisma.assetAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        asset: { select: { id: true, assetTag: true, name: true } },
        employee: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    if (assignment.returnedAt) {
      throw new BadRequestException('This assignment was already returned');
    }

    const returnedAt = dto.returnedAt ? new Date(dto.returnedAt) : new Date();
    if (returnedAt < assignment.assignedAt) {
      throw new BadRequestException(
        'A return date cannot fall before the assignment date',
      );
    }

    // Only an item that came back usable becomes AVAILABLE again. LOST and
    // IN_REPAIR must not silently re-enter the assignable pool.
    const nextStatus = (dto.assetStatus ?? 'AVAILABLE') as AssetStatus;

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
      metadata: {
        assetTag: assignment.asset.assetTag,
        employeeId: assignment.employeeId,
        conditionIn: dto.conditionIn ?? null,
        assetStatus: nextStatus,
      },
    });

    return updated;
  }

  /** The caller's own assets, current and past. */
  async findByEmployee(employeeId: string, openOnly = false) {
    return this.prisma.assetAssignment.findMany({
      where: { employeeId, ...(openOnly ? { returnedAt: null } : {}) },
      include: { asset: { select: ASSET_CARD } },
      // Open items first — a leaver opens this screen to find out what is
      // blocking their exit.
      orderBy: [{ returnedAt: 'asc' }, { assignedAt: 'desc' }],
    });
  }

  /**
   * The employee's digital receipt.
   *
   * Only the holder may acknowledge. An HR user confirming on their behalf
   * would defeat the entire point of the record.
   */
  async acknowledge(
    assignmentId: string,
    dto: AcknowledgeAssetDto,
    user: Principal,
  ) {
    const assignment = await this.prisma.assetAssignment.findUnique({
      where: { id: assignmentId },
      include: { asset: { select: { id: true, assetTag: true } } },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

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
      metadata: { assetTag: assignment.asset.assetTag },
    });

    return updated;
  }

  /** Everything currently out, for the people chasing it back. */
  async findOpen(user: Principal, employeeId?: string) {
    const where: Prisma.AssetAssignmentWhereInput = { returnedAt: null };
    if (employeeId) where.employeeId = employeeId;

    // A department head sees their own department only, matching every other
    // manager-facing list here.
    if (user?.role === UserRole.MANAGER) {
      const scope = await this.managedDepartmentIds(user);
      if (scope.length === 0) return [];
      if (employeeId) {
        const subject = await this.prisma.employee.findUnique({
          where: { id: employeeId },
          select: { departmentId: true },
        });
        if (!subject?.departmentId || !scope.includes(subject.departmentId)) {
          throw new ForbiddenException(
            'You can only view assets held in your own department',
          );
        }
      } else {
        where.employee = { departmentId: { in: scope } };
      }
    }

    const rows = await this.prisma.assetAssignment.findMany({
      where,
      include: {
        asset: { select: ASSET_CARD },
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            status: true,
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
    });

    return rows.map((row) => ({
      ...row,
      employee: withFullName(row.employee),
    }));
  }

  /**
   * The departments a manager speaks for: the ones they head, plus their own.
   *
   * Read from the table rather than from a claim on the token, so a
   * reorganisation takes effect on the next request instead of the next sign-in.
   */
  private async managedDepartmentIds(user: Principal): Promise<string[]> {
    const ids = new Set<string>();
    if (user.departmentId) ids.add(user.departmentId);
    if (user.employeeId) {
      const headed = await this.prisma.department.findMany({
        where: { managerId: user.employeeId },
        select: { id: true },
      });
      headed.forEach((department) => ids.add(department.id));
    }
    return [...ids];
  }
}
