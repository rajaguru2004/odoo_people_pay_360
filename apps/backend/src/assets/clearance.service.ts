import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { getBranchContext } from '../common/branch/branch-context';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';

export interface OpenAssetSummary {
  assignmentId: string;
  assetId: string;
  assetTag: string;
  name: string;
  category: string;
  assignedAt: Date;
}

export interface ClearanceStatus {
  /** Everything is clear: no held assets. */
  cleared: boolean;
  assetCleared: boolean;
  openAssets: OpenAssetSummary[];
}

export interface ClearanceOverride {
  /** User performing the override; recorded in the audit trail. */
  actorUserId?: string;
  actorRole?: string;
  reason?: string;
}

/** Only these may override a failed clearance. */
const OVERRIDE_ROLES = ['ADMIN', 'HR_MANAGER'];

/**
 * Offboarding asset clearance.
 *
 * The competitor-parity line item, and the real business value of the asset
 * register: a leaver cannot be completed while they still hold company
 * property.
 *
 * Keyed on OPEN assignments (`returnedAt IS NULL`), never on `Employee.status`.
 * That was written when the three exit paths disagreed: the termination flows
 * wrote `INACTIVE` and `EmployeesService.delete()` wrote `TERMINATED`, on a
 * free-text VarChar, so anything keyed on status saw a different population
 * depending on how someone had left (finding R72, since fixed — all three now
 * write `INACTIVE`, and `TERMINATED` means a contract).
 *
 * Custody remains the right key regardless, and for a better reason than
 * dodging that split: an employee still holding a laptop is not cleared
 * whatever their status says, and a status is a conclusion someone recorded
 * while an open assignment is a fact.
 */
@Injectable()
export class ClearanceService {
  private readonly logger = new Logger(ClearanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SystemSettingsService,
  ) {}

  /**
   * Resolve the employee a clearance is being asked ABOUT, and authorize the
   * question before answering it.
   *
   * Two defects lived in the fact that this used to be skipped entirely (R26,
   * R27): the projection queried `assetAssignment` by
   * a raw id, and both of those models are `'relation'`-scoped by the HOLDER.
   * So an id that belonged to nobody, and an id that belonged to somebody in
   * another branch, both matched zero rows and both produced
   * `{cleared: true, openAssets: []}` — a confident clearance for a person the
   * caller could not see, or who did not exist. The failure direction was
   * "clear to go", which is the wrong way for an offboarding gate to fail.
   *
   * `assertInBranch` throws NotFound rather than Forbidden, per the house
   * convention (`branch-scope.util.ts`) and the three offboarding doors: a
   * scoped caller must not be able to learn that an employee exists in a branch
   * they cannot reach. So an out-of-scope clearance read answers **404**.
   */
  private async loadSubject(
    employeeId: string,
    caller?: any,
  ): Promise<{
    id: string;
    branchId: string | null;
    departmentId: string | null;
  }> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, branchId: true, departmentId: true },
    });
    // R27 — an unknown id is an unknown id, not a clean bill of health.
    if (!employee) throw new NotFoundException('Employee not found');

    // R26 + R28 — the READ path, where there IS a principal to authorize.
    // One helper answers both halves in the documented order: branch first as a
    // 404 (no existence oracle), then ADMIN/HR_MANAGER company-wide, then
    // MANAGER only inside the departments they actually head — the same
    // narrowing the sibling `/assets/assignments/open` already applies.
    //
    // Deliberately NOT applied when `caller` is absent. That is the internal
    // path (`assertCleared`, and the reports), and the branch envelope is an
    // authorization fact about a REQUEST PRINCIPAL, not a property of the
    // projection: all three offboarding doors already run `assertInBranch` on
    // this very employee immediately before calling in
    // (`EmployeesService.delete`, `ContractsService.terminate`,
    // `TerminationRequestService.approveTermination`), and internal readers that
    // deliberately cross branches — `getOutstandingForInactive`, anything under
    // `runWithBranchBypass` — need the true state, not the caller's view of it.
    // Asserting here would refuse a bypass that had explicitly asked for it.
    if (caller) {
      assertCanAccessEmployeeRecord(caller, employee, 'view');
    }
    return employee;
  }

  /**
   * Open obligations: assets still held.
   *
   * `caller` is the request principal on the READ path (`GET
   * /assets/clearance/:employeeId`) and absent on the internal offboarding
   * path; see `loadSubject` for what each one authorizes.
   */
  async getClearanceStatus(
    employeeId: string,
    caller?: any,
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

    const assetCleared = open.length === 0;

    return {
      cleared: assetCleared,
      assetCleared,
      openAssets: open.map((a) => ({
        assignmentId: a.id,
        assetId: a.asset.id,
        assetTag: a.asset.assetTag,
        name: a.asset.name,
        category: a.asset.category,
        assignedAt: a.assignedAt,
      })),
    };
  }

  /**
   * Throw unless the employee holds nothing. Call BEFORE any deactivation
   * mutation — every one of the three paths that can end an employment
   * (`TerminationRequestService.approveTermination`, `ContractsService.terminate`,
   * `EmployeesService.delete`) must go through this, or clearance is a
   * suggestion rather than a control.
   *
   * `override.reason` lets ADMIN/HR_MANAGER proceed anyway (write-off, lost
   * item, urgent exit). The override is always audited — a tender needs the
   * block, an administrator needs the escape hatch, and the auditor needs to
   * see which was used.
   */
  async assertCleared(
    employeeId: string,
    override: ClearanceOverride = {},
  ): Promise<void> {
    // Kill-switch: a site that does not track assets must not have offboarding
    // blocked by an empty register.
    const enabled = await this.settings.getSetting(
      'clearance_blocking_enabled',
      'true',
    );
    if (enabled === 'false') return;

    const status = await this.getClearanceStatus(employeeId);

    if (status.assetCleared) return;

    const listed = status.openAssets
      .map((a) => `${a.assetTag} (${a.name})`)
      .join(', ');

    if (!override.reason?.trim()) {
      throw new BadRequestException(
        `Cannot complete offboarding: employee still has ` +
          `${status.openAssets.length} company asset(s) — ${listed}. ` +
          'Record the returns first, or supply an override reason (ADMIN/HR_MANAGER only).',
      );
    }

    if (!override.actorRole || !OVERRIDE_ROLES.includes(override.actorRole)) {
      throw new BadRequestException(
        'Only ADMIN or HR_MANAGER may override an asset clearance check.',
      );
    }

    await this.audit.log({
      userId: override.actorUserId,
      action: 'CLEARANCE_OVERRIDDEN',
      resourceType: 'Employee',
      resourceId: employeeId,
      newData: {
        reason: override.reason,
        openAssets: status.openAssets.map((a) => ({
          assetTag: a.assetTag,
          name: a.name,
        })),
      },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });
    this.logger.warn(
      `Asset clearance overridden for employee ${employeeId} by ${override.actorUserId}: ${override.reason}`,
    );
  }

  /**
   * Assets held by employees who are no longer active — an HR worklist, not a
   * blocker. These predate the clearance check (or came through an override),
   * and nothing else would ever surface them.
   */
  async getOutstandingForInactive() {
    const rows = await this.prisma.assetAssignment.findMany({
      where: {
        returnedAt: null,
        employee: { status: { not: 'ACTIVE' } },
      },
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
            endDate: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { assignedAt: 'asc' },
    });
    return { success: true, data: rows };
  }
}
