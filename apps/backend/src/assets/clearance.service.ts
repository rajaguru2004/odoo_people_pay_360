import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { withFullName } from '../common/utils/employee-name.util';
import type { Principal } from '../auth/auth.service';

export interface OpenAssetSummary {
  assignmentId: string;
  assetId: string;
  assetTag: string;
  name: string;
  category: string;
  assignedAt: Date;
}

export interface ClearanceStatus {
  /** Nothing is still out. */
  cleared: boolean;
  assetCleared: boolean;
  openAssets: OpenAssetSummary[];
}

export interface ClearanceOverride {
  actorUserId?: string;
  actorRole?: string;
  reason?: string;
}

/** Only these two may push an exit past a failed clearance. */
const OVERRIDE_ROLES: string[] = [UserRole.ADMIN, UserRole.HR_MANAGER];

/** The switch a site that does not track assets turns off. */
const CLEARANCE_SETTING = 'clearance_blocking_enabled';

/**
 * Offboarding clearance: a leaver cannot be completed while they still hold
 * company property.
 *
 * Keyed on OPEN assignments (`returnedAt IS NULL`) rather than on the
 * employee's status. An employee still holding a laptop is not cleared whatever
 * their status says — an open assignment is a fact, a status is a conclusion
 * somebody recorded.
 */
@Injectable()
export class ClearanceService {
  private readonly logger = new Logger(ClearanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  /**
   * Resolve the employee a clearance is asked ABOUT, and authorize the question
   * before answering it.
   *
   * An unknown id must not answer "clear to go": the projection below queries
   * by a raw id, and an id that matches nothing would otherwise produce a
   * confident clearance for somebody who does not exist. The failure direction
   * of an offboarding gate has to be "blocked", never "fine".
   *
   * `caller` is absent on the internal path (`assertCleared`), where the
   * question is about the true state rather than about one principal's view.
   */
  private async loadSubject(employeeId: string, caller?: Principal) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    if (caller && caller.role === UserRole.MANAGER) {
      const headed = await this.prisma.department.findMany({
        where: { managerId: caller.employeeId ?? undefined },
        select: { id: true },
      });
      const scope = new Set(headed.map((department) => department.id));
      if (caller.departmentId) scope.add(caller.departmentId);
      if (!employee.departmentId || !scope.has(employee.departmentId)) {
        throw new ForbiddenException(
          'You can only check clearance for your own department',
        );
      }
    }

    return employee;
  }

  /** What the employee still holds. */
  async getClearanceStatus(
    employeeId: string,
    caller?: Principal,
  ): Promise<ClearanceStatus> {
    await this.loadSubject(employeeId, caller);

    const open = await this.prisma.assetAssignment.findMany({
      where: { employeeId, returnedAt: null },
      include: {
        asset: {
          select: { id: true, assetTag: true, name: true, category: true },
        },
      },
      orderBy: { assignedAt: 'asc' },
    });

    const openAssets = open.map((row) => ({
      assignmentId: row.id,
      assetId: row.asset.id,
      assetTag: row.asset.assetTag,
      name: row.asset.name,
      category: row.asset.category,
      assignedAt: row.assignedAt,
    }));

    const assetCleared = openAssets.length === 0;
    return { cleared: assetCleared, assetCleared, openAssets };
  }

  /**
   * Throw unless the employee holds nothing. Call BEFORE any deactivation, or
   * clearance is a suggestion rather than a control.
   *
   * `override.reason` lets ADMIN or HR push an exit through anyway — a
   * write-off, a lost item, an urgent departure. The override is always
   * recorded: a tender needs the block, an administrator needs the escape
   * hatch, and an auditor needs to see which was used.
   */
  async assertCleared(
    employeeId: string,
    override: ClearanceOverride = {},
  ): Promise<void> {
    const enabled = await this.settings.get(CLEARANCE_SETTING);
    if (enabled === 'false') return;

    const status = await this.getClearanceStatus(employeeId);
    if (status.cleared) return;

    const listed = status.openAssets
      .map((asset) => `${asset.assetTag} (${asset.name})`)
      .join(', ');

    if (!override.reason?.trim()) {
      throw new BadRequestException(
        `Cannot complete offboarding: this employee still holds ${status.openAssets.length} company asset(s) — ${listed}. ` +
          'Record the returns first, or supply an override reason (ADMIN or HR only).',
      );
    }
    if (!override.actorRole || !OVERRIDE_ROLES.includes(override.actorRole)) {
      throw new BadRequestException(
        'Only ADMIN or HR_MANAGER may override an asset clearance check.',
      );
    }

    await this.prisma.auditLog.create({
      data: {
        userId: override.actorUserId ?? null,
        action: 'CLEARANCE_OVERRIDDEN',
        entityType: 'Employee',
        entityId: employeeId,
        metadata: {
          reason: override.reason,
          openAssets: status.openAssets.map((asset) => ({
            assetTag: asset.assetTag,
            name: asset.name,
          })),
        },
      },
    });
    this.logger.warn(
      `Asset clearance overridden for employee ${employeeId}: ${override.reason}`,
    );
  }

  /**
   * Assets still held by people who have already left — a worklist, not a
   * blocker. These predate the clearance check or came through an override, and
   * nothing else would ever surface them.
   */
  async getOutstandingForInactive() {
    const rows = await this.prisma.assetAssignment.findMany({
      where: { returnedAt: null, employee: { status: { not: 'ACTIVE' } } },
      include: {
        asset: {
          select: { id: true, assetTag: true, name: true, category: true },
        },
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            status: true,
            exitDate: true,
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { assignedAt: 'asc' },
    });

    return rows.map((row) => ({
      ...row,
      employee: withFullName(row.employee),
    }));
  }
}
