import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OvertimePolicy, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { CreateOvertimePolicyDto } from './dto/create-overtime-policy.dto';
import { UpdateOvertimePolicyDto } from './dto/update-overtime-policy.dto';
import { AssignOvertimePolicyDto } from './dto/assign-overtime-policy.dto';
import {
  OvertimePolicyRules,
  OT_POLICY_RULES_SCHEMA_VERSION,
  PolicyResolutionSource,
  ResolvedOvertimeConfig,
  buildDefaultRules,
  composeRules,
  mergeRulesOverGlobal,
  overlayRules,
  resolvedFromGlobal,
} from './overtime-policy.types';

/** Minimal employee shape needed to resolve the effective policy. */
export interface PolicyResolvable {
  overtimePolicyId: string | null;
  /** An EMPLOYMENT_TYPE library label, or null when not set. */
  employmentType: string | null;
}

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * The Overtime Policy engine. Owns:
 *  - the inheritance-chain resolution (Employee Override → Employment Type →
 *    Company Default → global settings as an ultimate safety net). The engine
 *    always resolves — there is no kill-switch, and
 *  - admin CRUD for policies + employee assignment.
 *
 * `resolveOvertimeConfig` returns the exact OvertimeConfig shape the overtime /
 * payroll calc code already consumes (plus policy-level fields), so the engine
 * math is unchanged — only the *source* of the config differs.
 */
@Injectable()
export class OvertimePolicyService implements OnModuleInit {
  private readonly logger = new Logger(OvertimePolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Guarantee a Company Default policy exists on every boot.
   *
   * Without it, any employee not covered by an override or an employment-type
   * policy silently resolves to LEGACY_GLOBAL — the raw `overtime_*` system
   * settings — so overtime rates edited on the Overtime Policies screen would
   * never reach them and there would be no editable surface for those rates
   * either. Idempotent; failures (e.g. the table not migrated yet) are logged,
   * never fatal, so a boot can still complete and the migration be applied.
   */
  async onModuleInit(): Promise<void> {
    try {
      const { created, policyId } = await this.ensureCompanyDefault();
      if (created) {
        this.logger.log(
          `Seeded the "Company Default" overtime policy (${policyId}) from the global overtime settings.`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `Could not ensure a default overtime policy: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  // ── Resolution (inheritance chain) ──────────────────────────────────────────

  /**
   * Resolve the effective policy for an employee together with which tier of the
   * chain produced it (Employee Override → Employment Type → Company Default).
   * The engine always resolves — there is no kill-switch. policy=null only when
   * NO policy exists at all, in which case callers fall back to the global
   * overtime settings as an ultimate safety net.
   */
  async resolveEffectivePolicyWithSource(
    emp: PolicyResolvable,
  ): Promise<{ policy: OvertimePolicy | null; source: PolicyResolutionSource }> {
    if (emp.overtimePolicyId) {
      const override = await this.prisma.overtimePolicy.findFirst({
        where: { id: emp.overtimePolicyId, isActive: true },
      });
      if (override) return { policy: override, source: 'EMPLOYEE_OVERRIDE' };
    }

    if (emp.employmentType) {
      const byType = await this.prisma.overtimePolicy.findFirst({
        where: { employmentType: emp.employmentType, isActive: true },
      });
      if (byType) return { policy: byType, source: 'EMPLOYMENT_TYPE' };
    }

    const def = await this.prisma.overtimePolicy.findFirst({
      where: { isDefault: true, isActive: true },
    });
    if (def) return { policy: def, source: 'COMPANY_DEFAULT' };

    return { policy: null, source: 'LEGACY_GLOBAL' };
  }

  async resolveEffectivePolicy(
    emp: PolicyResolvable,
  ): Promise<OvertimePolicy | null> {
    return (await this.resolveEffectivePolicyWithSource(emp)).policy;
  }

  /**
   * The effective overtime config for an employee, in the exact shape the calc
   * engine consumes. Falls back to the legacy global config when no policy
   * governs the employee.
   */
  async resolveOvertimeConfig(
    emp: PolicyResolvable,
  ): Promise<ResolvedOvertimeConfig> {
    const global = await this.settings.getOvertimeConfig();
    const policy = await this.resolveEffectivePolicy(emp);
    if (!policy) return resolvedFromGlobal(global);
    return {
      ...mergeRulesOverGlobal(policy.rules as Partial<OvertimePolicyRules>, global),
      policyId: policy.id,
      policyName: policy.name,
    };
  }

  /**
   * The overtime config for a specific policy id (the snapshot stored on an
   * OvertimeRequest). Honours the snapshot regardless of the kill-switch or the
   * policy's current active flag, so historical rows monetize consistently with
   * how their hours were classified. null / missing policy → legacy globals.
   */
  async configForPolicyId(
    policyId: string | null | undefined,
  ): Promise<ResolvedOvertimeConfig> {
    const global = await this.settings.getOvertimeConfig();
    if (!policyId) return resolvedFromGlobal(global);
    const policy = await this.prisma.overtimePolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy) return resolvedFromGlobal(global);
    return {
      ...mergeRulesOverGlobal(policy.rules as Partial<OvertimePolicyRules>, global),
      policyId: policy.id,
      policyName: policy.name,
    };
  }

  /** Debug/support: the effective policy + source for one employee. */
  async resolveForEmployee(employeeId: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        employmentType: true,
        overtimePolicyId: true,
      },
    });
    if (!emp) throw new NotFoundException('Employee not found');

    const { policy, source } =
      await this.resolveEffectivePolicyWithSource(emp);
    const cfg = await this.resolveOvertimeConfig(emp);

    return {
      success: true,
      data: {
        employeeId: emp.id,
        employeeName: emp.fullName,
        employmentType: emp.employmentType,
        overtimePolicyId: emp.overtimePolicyId,
        source,
        effectivePolicyId: policy?.id ?? null,
        effectivePolicyName: policy?.name ?? null,
        eligible: cfg.eligible,
        holidayBehavior: cfg.holidayBehavior,
      },
    };
  }

  /**
   * Idempotently ensure a "Company Default" policy exists that mirrors the
   * current global overtime settings. Called during migration/rollout so that
   * enabling the kill-switch changes nothing until a targeted policy is added.
   */
  async ensureCompanyDefault(): Promise<{ created: boolean; policyId: string }> {
    const active = await this.prisma.overtimePolicy.findFirst({
      where: { isDefault: true, isActive: true },
    });
    if (active) return { created: false, policyId: active.id };

    // A prior "Company Default" may exist but be inactive/non-default — promote
    // it rather than colliding on the unique name.
    const byName = await this.prisma.overtimePolicy.findUnique({
      where: { name: 'Company Default' },
    });
    if (byName) {
      const promoted = await this.setDefault(byName.id);
      return { created: false, policyId: promoted.data.id };
    }

    const global = await this.settings.getOvertimeConfig();
    const rules = buildDefaultRules(global);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.overtimePolicy.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
      return tx.overtimePolicy.create({
        data: {
          name: 'Company Default',
          description:
            'Auto-seeded from the global overtime settings — mirrors the legacy overtime behaviour so enabling the policy engine changes nothing until a targeted policy is added.',
          isActive: true,
          isDefault: true,
          employmentType: null,
          schemaVersion: OT_POLICY_RULES_SCHEMA_VERSION,
          rules: rules as unknown as Prisma.InputJsonValue,
        },
      });
    });
    return { created: true, policyId: created.id };
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  async list() {
    const data = await this.prisma.overtimePolicy.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { employees: true } } },
    });
    return { success: true, data };
  }

  async get(id: string) {
    const policy = await this.prisma.overtimePolicy.findUnique({
      where: { id },
      include: { _count: { select: { employees: true } } },
    });
    if (!policy) throw new NotFoundException('Overtime policy not found');
    return { success: true, data: policy };
  }

  async create(dto: CreateOvertimePolicyDto, actorUserId?: string) {
    const global = await this.settings.getOvertimeConfig();
    const rules = composeRules(
      dto.rules as Partial<OvertimePolicyRules> | undefined,
      global,
    );
    this.validateRules(rules);

    const isActive = dto.isActive ?? true;
    if (dto.employmentType && isActive) {
      await this.assertNoActiveTypeClash(dto.employmentType, null);
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        if (dto.isDefault && isActive) {
          await tx.overtimePolicy.updateMany({
            where: { isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.overtimePolicy.create({
          data: {
            name: dto.name,
            description: dto.description ?? null,
            isActive,
            isDefault: dto.isDefault ?? false,
            employmentType: dto.employmentType ?? null,
            schemaVersion: OT_POLICY_RULES_SCHEMA_VERSION,
            rules: rules as unknown as Prisma.InputJsonValue,
          },
        });
      });
      return { success: true, data: created };
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  async update(id: string, dto: UpdateOvertimePolicyDto, actorUserId?: string) {
    const existing = await this.prisma.overtimePolicy.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Overtime policy not found');

    const global = await this.settings.getOvertimeConfig();
    // Always normalize the stored blob against global defaults first (this
    // self-heals legacy/partial blobs so validateRules never sees a missing
    // tier), then overlay the edit — an absent `dto.rules` is an empty overlay.
    const nextRules = overlayRules(
      composeRules(existing.rules as Partial<OvertimePolicyRules>, global),
      (dto.rules ?? {}) as Partial<OvertimePolicyRules>,
    );
    this.validateRules(nextRules);

    const nextActive = dto.isActive ?? existing.isActive;
    // The active default is the universal fallback for every employee not
    // covered by an override or an employment-type policy. Losing it silently
    // drops them onto the raw global settings, so neither deactivating it nor
    // clearing its default flag is allowed without promoting a replacement.
    if (existing.isDefault && existing.isActive) {
      if (!nextActive) {
        throw new BadRequestException(
          'Cannot deactivate the active default policy. Set another policy as default first.',
        );
      }
      if (dto.isDefault === false) {
        throw new BadRequestException(
          'Cannot clear the default flag on the only default policy. Promote another policy to default instead.',
        );
      }
    }
    const nextType =
      dto.employmentType !== undefined
        ? dto.employmentType
        : existing.employmentType;
    if (nextType && nextActive) {
      await this.assertNoActiveTypeClash(nextType, id);
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const makingDefault = (dto.isDefault ?? existing.isDefault) && nextActive;
        if (dto.isDefault === true && nextActive) {
          await tx.overtimePolicy.updateMany({
            where: { isDefault: true, id: { not: id } },
            data: { isDefault: false },
          });
        }
        return tx.overtimePolicy.update({
          where: { id },
          data: {
            name: dto.name ?? existing.name,
            description:
              dto.description !== undefined
                ? dto.description
                : existing.description,
            isActive: nextActive,
            isDefault: makingDefault ? true : dto.isDefault ?? existing.isDefault,
            employmentType: nextType,
            rules: nextRules as unknown as Prisma.InputJsonValue,
          },
        });
      });
      return { success: true, data: updated };
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  /** Promote a policy to the single active company default. */
  async setDefault(id: string, actorUserId?: string) {
    const policy = await this.prisma.overtimePolicy.findUnique({
      where: { id },
    });
    if (!policy) throw new NotFoundException('Overtime policy not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.overtimePolicy.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
      return tx.overtimePolicy.update({
        where: { id },
        data: { isDefault: true, isActive: true },
      });
    });
    return { success: true, data: updated };
  }

  async setActive(id: string, isActive: boolean, actorUserId?: string) {
    const policy = await this.prisma.overtimePolicy.findUnique({
      where: { id },
    });
    if (!policy) throw new NotFoundException('Overtime policy not found');
    if (!isActive && policy.isDefault && policy.isActive) {
      throw new BadRequestException(
        'Cannot deactivate the active default policy. Set another policy as default first.',
      );
    }
    if (isActive && policy.employmentType) {
      await this.assertNoActiveTypeClash(policy.employmentType, id);
    }
    try {
      const updated = await this.prisma.overtimePolicy.update({
        where: { id },
        data: { isActive },
      });
      return { success: true, data: updated };
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  async remove(id: string, actorUserId?: string) {
    const policy = await this.prisma.overtimePolicy.findUnique({
      where: { id },
    });
    if (!policy) throw new NotFoundException('Overtime policy not found');
    if (policy.isDefault && policy.isActive) {
      throw new BadRequestException(
        'Cannot delete the active default policy. Set another policy as default first.',
      );
    }
    // Employee.overtimePolicyId and OvertimeRequest.overtimePolicyId are ON
    // DELETE SET NULL, so history is preserved and assignees fall back to the
    // employment-type / default policy.
    await this.prisma.overtimePolicy.delete({ where: { id } });
    return { success: true };
  }

  // ── Assignment ────────────────────────────────────────────────────────────

  async assign(dto: AssignOvertimePolicyDto, actorUserId?: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: {
        id: true,
        branchId: true,
        user: { select: { id: true } },
      },
    });
    if (!emp) throw new NotFoundException('Employee not found');
    // A branch-scoped caller cannot reassign an out-of-branch employee.
    assertInBranch(emp.branchId);

    if (dto.overtimePolicyId) {
      const policy = await this.prisma.overtimePolicy.findUnique({
        where: { id: dto.overtimePolicyId },
        select: { id: true },
      });
      if (!policy)
        throw new BadRequestException('Overtime policy not found');
    }

    const data: Prisma.EmployeeUpdateInput = {};
    if (dto.employmentType !== undefined) {
      data.employmentType = dto.employmentType;
    }
    if (Object.prototype.hasOwnProperty.call(dto, 'overtimePolicyId')) {
      data.overtimePolicy = dto.overtimePolicyId
        ? { connect: { id: dto.overtimePolicyId } }
        : { disconnect: true };
    }

    const updated = await this.prisma.employee.update({
      where: { id: dto.employeeId },
      data,
      select: {
        id: true,
        employmentType: true,
        overtimePolicyId: true,
      },
    });

    if (emp.user?.id) {
      this.notifications
        .notifyUser(
          emp.user.id,
          'Overtime policy updated',
          'Your overtime policy assignment was updated by HR.',
          'INFO',
          '/dashboard/overtime',
        )
        .catch(() => undefined);
    }

    return { success: true, data: updated };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** At most one ACTIVE policy may target a given employment type. */
  private async assertNoActiveTypeClash(
    employmentType: string,
    excludeId: string | null,
  ) {
    const clash = await this.prisma.overtimePolicy.findFirst({
      where: {
        employmentType,
        isActive: true,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, name: true },
    });
    if (clash) {
      throw new ConflictException(
        `An active policy already targets ${employmentType} ("${clash.name}"). Deactivate or edit it first.`,
      );
    }
  }

  /** Cross-field / range validation on the composed rules blob. */
  private validateRules(rules: OvertimePolicyRules) {
    const positiveRates: Array<[string, number]> = [
      ['regularRate', rules.regularRate],
      ['lateRate', rules.lateRate],
      ['doubleRate', rules.doubleRate],
      ['sunday.regularRate', rules.sunday.regularRate],
      ['sunday.lateRate', rules.sunday.lateRate],
      ['holiday.regularRate', rules.holiday.regularRate],
      ['holiday.lateRate', rules.holiday.lateRate],
    ];
    for (const [field, value] of positiveRates) {
      if (!(value > 0)) {
        throw new BadRequestException(`${field} must be greater than 0`);
      }
    }

    const times: Array<[string, string | null]> = [
      ['lateThreshold', rules.lateThreshold],
      ['shiftEndTime', rules.shiftEndTime],
      ['foodAllowanceThreshold', rules.foodAllowanceThreshold],
      ['sunday.lateThreshold', rules.sunday.lateThreshold],
      ['holiday.lateThreshold', rules.holiday.lateThreshold],
      ['dayEndBoundary', rules.dayEndBoundary],
    ];
    for (const [field, value] of times) {
      if (value != null && !HHMM.test(value)) {
        throw new BadRequestException(`${field} must be a time in HH:MM format`);
      }
    }

    if (rules.maxHoursPerDay > rules.maxHoursPerDoubleDay) {
      throw new BadRequestException(
        'maxHoursPerDay cannot exceed maxHoursPerDoubleDay',
      );
    }
  }

  /** Map Prisma unique-constraint failures to friendly HTTP errors. */
  private mapWriteError(e: unknown): Error {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = (e.meta?.target as string) ?? '';
      if (target.includes('name')) {
        return new ConflictException('A policy with this name already exists');
      }
      if (target.includes('default')) {
        return new ConflictException('Another active default policy exists');
      }
      if (target.includes('emptype') || target.includes('employment_type')) {
        return new ConflictException(
          'An active policy already targets this employment type',
        );
      }
      return new ConflictException('Overtime policy conflict');
    }
    return e as Error;
  }
}
