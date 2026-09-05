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
import { loadOvertimeConfig } from './overtime-config';
import { CreateOvertimePolicyDto } from './dto/create-overtime-policy.dto';
import { UpdateOvertimePolicyDto } from './dto/update-overtime-policy.dto';
import { AssignOvertimePolicyDto } from './dto/assign-overtime-policy.dto';
import {
  OT_POLICY_RULES_SCHEMA_VERSION,
  OvertimePolicyRules,
  PolicyResolutionSource,
  ResolvedOvertimeConfig,
  buildDefaultRules,
  composeRules,
  mergeRulesOverGlobal,
  overlayRules,
  resolvedFromGlobal,
} from './overtime-policy.types';

/** The minimum an employee has to carry for a policy to be resolvable. */
export interface PolicyResolvable {
  overtimePolicyId: string | null;
  /** An EMPLOYMENT_TYPE library label, or null. */
  employmentType: string | null;
}

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

export const COMPANY_DEFAULT_POLICY_NAME = 'Company Default';

/**
 * The overtime policy engine.
 *
 * Two jobs: resolving which rules govern one employee, and the administration of
 * the rule sets themselves.
 *
 * ## The chain
 *
 *   Employee override → Employment type → Company default → global settings
 *
 * It always resolves. There is no kill switch on the engine itself: an employee
 * covered by nothing falls through to the company default, and only a database
 * with no policies at all reaches the globals. `resolveOvertimeConfig` returns
 * the exact {@link ResolvedOvertimeConfig} shape the calc engine consumes, so
 * the arithmetic never learns that policies exist — only where its inputs came
 * from changes.
 */
@Injectable()
export class OvertimePolicyService implements OnModuleInit {
  private readonly logger = new Logger(OvertimePolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  /**
   * Guarantee a company default exists on every boot.
   *
   * Without one, every employee not covered by an override or an employment-type
   * policy silently resolves to the raw `overtime_*` settings — so rates edited
   * on the Overtime Policies screen would never reach them, and there would be no
   * editable surface for the rates that did. Idempotent; a failure is logged
   * rather than fatal so a container can still start before `db push` has run.
   */
  async onModuleInit(): Promise<void> {
    try {
      const { created, policyId } = await this.ensureCompanyDefault();
      if (created) {
        this.logger.log(
          `Seeded the "${COMPANY_DEFAULT_POLICY_NAME}" overtime policy (${policyId}) from the global overtime settings.`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `Could not ensure a default overtime policy: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  async resolveEffectivePolicyWithSource(emp: PolicyResolvable): Promise<{
    policy: OvertimePolicy | null;
    source: PolicyResolutionSource;
  }> {
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

  /** The effective configuration for an employee, ready for the calc engine. */
  async resolveOvertimeConfig(
    emp: PolicyResolvable,
  ): Promise<ResolvedOvertimeConfig> {
    const global = await loadOvertimeConfig(this.settings);
    const policy = await this.resolveEffectivePolicy(emp);
    if (!policy) return resolvedFromGlobal(global);
    return {
      ...mergeRulesOverGlobal(
        policy.rules as Partial<OvertimePolicyRules>,
        global,
      ),
      policyId: policy.id,
      policyName: policy.name,
    };
  }

  /**
   * The configuration for a SPECIFIC policy id — the snapshot an approved
   * request carries.
   *
   * Honoured regardless of the policy's current active flag, so a request
   * approved in March still monetizes against the rules that classified its
   * hours even after the policy is retired in June. A missing policy falls back
   * to the globals rather than throwing: a deleted policy must not make a
   * historical payslip unreadable.
   */
  async configForPolicyId(
    policyId: string | null | undefined,
  ): Promise<ResolvedOvertimeConfig> {
    const global = await loadOvertimeConfig(this.settings);
    if (!policyId) return resolvedFromGlobal(global);
    const policy = await this.prisma.overtimePolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy) return resolvedFromGlobal(global);
    return {
      ...mergeRulesOverGlobal(
        policy.rules as Partial<OvertimePolicyRules>,
        global,
      ),
      policyId: policy.id,
      policyName: policy.name,
    };
  }

  /** Support answer: which policy governs this employee, and by which tier. */
  async resolveForEmployee(employeeId: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employmentType: true,
        overtimePolicyId: true,
      },
    });
    if (!emp) throw new NotFoundException('Employee not found');

    const { policy, source } = await this.resolveEffectivePolicyWithSource(emp);
    const cfg = await this.resolveOvertimeConfig(emp);

    return {
      success: true as const,
      data: {
        employeeId: emp.id,
        employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
        employmentType: emp.employmentType,
        overtimePolicyId: emp.overtimePolicyId,
        source,
        effectivePolicyId: policy?.id ?? null,
        effectivePolicyName: policy?.name ?? null,
        eligible: cfg.eligible,
        holidayBehavior: cfg.holidayBehavior,
        rates: {
          regularRate: cfg.regularRate,
          lateRate: cfg.lateRate,
          lateThreshold: cfg.lateThreshold,
          sunday: cfg.sunday,
          holiday: cfg.holiday,
        },
      },
    };
  }

  /**
   * Idempotently ensure a company default exists, mirroring the current global
   * settings — so introducing the policy engine changes nobody's rates until a
   * targeted policy is actually written.
   */
  async ensureCompanyDefault(): Promise<{
    created: boolean;
    policyId: string;
  }> {
    const active = await this.prisma.overtimePolicy.findFirst({
      where: { isDefault: true, isActive: true },
    });
    if (active) return { created: false, policyId: active.id };

    // A prior default may exist but be inactive or demoted — promote it rather
    // than colliding on the unique name.
    const byName = await this.prisma.overtimePolicy.findUnique({
      where: { name: COMPANY_DEFAULT_POLICY_NAME },
    });
    if (byName) {
      const promoted = await this.setDefault(byName.id);
      return { created: false, policyId: promoted.data.id };
    }

    const global = await loadOvertimeConfig(this.settings);
    const rules = buildDefaultRules(global);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.overtimePolicy.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
      return tx.overtimePolicy.create({
        data: {
          name: COMPANY_DEFAULT_POLICY_NAME,
          description:
            'Seeded from the global overtime settings. It mirrors them exactly, ' +
            'so adding the policy engine changed nobody until a targeted policy was written.',
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

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async list() {
    const data = await this.prisma.overtimePolicy.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { employees: true } } },
    });
    return { success: true as const, data };
  }

  async get(id: string) {
    const policy = await this.prisma.overtimePolicy.findUnique({
      where: { id },
      include: { _count: { select: { employees: true } } },
    });
    if (!policy) throw new NotFoundException('Overtime policy not found');
    return { success: true as const, data: policy };
  }

  async create(dto: CreateOvertimePolicyDto) {
    const global = await loadOvertimeConfig(this.settings);
    const rules = composeRules(dto.rules, global);
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
      return { success: true as const, data: created };
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  async update(id: string, dto: UpdateOvertimePolicyDto) {
    const existing = await this.prisma.overtimePolicy.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Overtime policy not found');

    const global = await loadOvertimeConfig(this.settings);
    // Normalise the stored blob against the global defaults FIRST, then overlay
    // the edit. That self-heals a partial or older-schema blob, so validation
    // never sees a missing tier and reports an error about a field the
    // administrator did not touch.
    const nextRules = overlayRules(
      composeRules(existing.rules as Partial<OvertimePolicyRules>, global),
      dto.rules ?? {},
    );
    this.validateRules(nextRules);

    const nextActive = dto.isActive ?? existing.isActive;
    // The active default is the universal fallback. Losing it silently drops
    // every uncovered employee onto the raw globals, so neither deactivating it
    // nor clearing its flag is allowed without promoting a replacement first.
    if (existing.isDefault && existing.isActive) {
      if (!nextActive) {
        throw new BadRequestException(
          'Cannot deactivate the active default policy. Set another policy as default first.',
        );
      }
      if (dto.isDefault === false) {
        throw new BadRequestException(
          'Cannot clear the default flag on the only default policy. Promote another policy instead.',
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
            isDefault: dto.isDefault ?? existing.isDefault,
            employmentType: nextType,
            schemaVersion: OT_POLICY_RULES_SCHEMA_VERSION,
            rules: nextRules as unknown as Prisma.InputJsonValue,
          },
        });
      });
      return { success: true as const, data: updated };
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  /** Promote a policy to the single active company default. */
  async setDefault(id: string) {
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
    return { success: true as const, data: updated };
  }

  async setActive(id: string, isActive: boolean) {
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
      return { success: true as const, data: updated };
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  /**
   * Delete a policy.
   *
   * Both foreign keys are ON DELETE SET NULL, so history survives: an approved
   * request keeps its hours and falls back to the global rates for monetisation,
   * and an assigned employee falls back through the chain.
   */
  async remove(id: string) {
    const policy = await this.prisma.overtimePolicy.findUnique({
      where: { id },
    });
    if (!policy) throw new NotFoundException('Overtime policy not found');
    if (policy.isDefault && policy.isActive) {
      throw new BadRequestException(
        'Cannot delete the active default policy. Set another policy as default first.',
      );
    }
    await this.prisma.overtimePolicy.delete({ where: { id } });
    return { success: true as const, message: 'Overtime policy deleted' };
  }

  // ── Assignment ─────────────────────────────────────────────────────────────

  async assign(dto: AssignOvertimePolicyDto) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { id: true },
    });
    if (!emp) throw new NotFoundException('Employee not found');

    if (dto.overtimePolicyId) {
      const policy = await this.prisma.overtimePolicy.findUnique({
        where: { id: dto.overtimePolicyId },
        select: { id: true },
      });
      if (!policy) throw new BadRequestException('Overtime policy not found');
    }

    const data: Prisma.EmployeeUpdateInput = {};
    if (dto.employmentType !== undefined) {
      data.employmentType = dto.employmentType;
    }
    // `hasOwnProperty`, not a truthiness test: an explicit null is the whole
    // point of the field — it CLEARS the override rather than leaving it alone.
    if (Object.prototype.hasOwnProperty.call(dto, 'overtimePolicyId')) {
      data.overtimePolicy = dto.overtimePolicyId
        ? { connect: { id: dto.overtimePolicyId } }
        : { disconnect: true };
    }

    const updated = await this.prisma.employee.update({
      where: { id: dto.employeeId },
      data,
      select: { id: true, employmentType: true, overtimePolicyId: true },
    });

    return { success: true as const, data: updated };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

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

  /** Cross-field validation over the composed blob. */
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
      // A zero multiplier is not "free overtime", it is a rule nobody meant to
      // write — and it pays an hour worked at nothing.
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
        throw new BadRequestException(
          `${field} must be a time in HH:MM format`,
        );
      }
    }

    if (rules.maxHoursPerDay > rules.maxHoursPerDoubleDay) {
      throw new BadRequestException(
        'maxHoursPerDay cannot exceed maxHoursPerDoubleDay',
      );
    }
  }

  private mapWriteError(e: unknown): Error {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      // `meta.target` is the column list Prisma names on a unique violation. It
      // arrives as a string or a string array depending on the connector, so it
      // is joined rather than stringified — `String(['name'])` happens to work
      // and `String({...})` gives "[object Object]", which matches nothing.
      const raw: unknown = e.meta?.target;
      const target =
        typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(',') : '';
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
