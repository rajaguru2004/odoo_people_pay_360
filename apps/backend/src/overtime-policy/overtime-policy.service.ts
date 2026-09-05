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
import { CreateOvertimePolicyDto } from './dto/create-overtime-policy.dto';
import { UpdateOvertimePolicyDto } from './dto/update-overtime-policy.dto';
import { AssignOvertimePolicyDto } from './dto/assign-overtime-policy.dto';
import { OvertimeConfig, loadOvertimeConfig } from './overtime-config';
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

/** The two employee facts the inheritance chain reads. */
export interface PolicyResolvable {
  overtimePolicyId: string | null;
  /**
   * The employee's own employment-type label, which the middle tier matches
   * against `OvertimePolicy.employmentType`.
   *
   * It lives on the employee record rather than being read off their live
   * contract: a contract that expires or is superseded would otherwise move
   * them onto a different rate card silently, and requests already approved
   * under the old one would start monetizing against rules nobody applied to
   * them. Null is not a refusal — it simply falls through to the company
   * default, which is what governs everyone who has never been given a type.
   */
  employmentType: string | null;
}

const POLICY_INCLUDE = {
  _count: { select: { employees: true } },
} satisfies Prisma.OvertimePolicyInclude;

/**
 * The two columns the inheritance chain reads.
 *
 * Exported so the callers that already load an employee can select them in the
 * same query rather than paying for a second round trip per submission.
 */
export const POLICY_RESOLVABLE_SELECT = {
  overtimePolicyId: true,
  employmentType: true,
} satisfies Prisma.EmployeeSelect;

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * The overtime policy engine.
 *
 * It owns two things: the inheritance chain that decides which rate card
 * governs an employee (employee override → employment type → company default →
 * the company overtime settings as an ultimate backstop), and the administrative
 * CRUD behind the policy screen.
 *
 * `resolveOvertimeConfig` hands back the same {@link OvertimeConfig} shape the
 * calculation code consumes, so the split and classification arithmetic never
 * has to know whether its numbers came from a policy row or from the settings
 * table.
 */
@Injectable()
export class OvertimePolicyService implements OnModuleInit {
  private readonly logger = new Logger(OvertimePolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Guarantee a company default exists on every boot.
   *
   * Without one, every employee not covered by an override or an
   * employment-type policy resolves straight to the raw settings table — so the
   * rates edited on the policy screen would never reach them, and there would
   * be no editable surface for their rates at all. Idempotent, and a failure
   * (an unmigrated database, say) is logged rather than fatal so the boot can
   * still complete and the migration be applied.
   */
  async onModuleInit(): Promise<void> {
    try {
      const { created, policyId } = await this.ensureCompanyDefault();
      if (created) {
        this.logger.log(
          `Seeded the "Company Default" overtime policy (${policyId}) from the company overtime settings.`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `Could not ensure a default overtime policy: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  // ── Resolution ───────────────────────────────────────────────────────────

  /** The company-wide settings the chain falls back to. */
  getOvertimeConfig(): Promise<OvertimeConfig> {
    return loadOvertimeConfig(this.prisma);
  }

  /** The chain inputs for one employee, in a single read. */
  async resolvableFor(employeeId: string): Promise<PolicyResolvable> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: POLICY_RESOLVABLE_SELECT,
    });
    return {
      overtimePolicyId: employee?.overtimePolicyId ?? null,
      employmentType: employee?.employmentType ?? null,
    };
  }

  /**
   * The effective policy plus the tier of the chain that produced it.
   *
   * `policy` is null only when NO policy exists at all; callers then fall back
   * to the company overtime settings.
   */
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

  /** The effective config for an employee, in the shape the engine consumes. */
  async resolveOvertimeConfig(
    emp: PolicyResolvable,
  ): Promise<ResolvedOvertimeConfig> {
    const global = await this.getOvertimeConfig();
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
   * The config for one policy id — the snapshot an approved request carries.
   *
   * Honoured whatever the policy's current active flag says, so a decided
   * request keeps being monetized by the rules that classified its hours. A
   * missing id, or a policy since deleted, falls back to the company settings.
   */
  async configForPolicyId(
    policyId: string | null | undefined,
  ): Promise<ResolvedOvertimeConfig> {
    const global = await this.getOvertimeConfig();
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

  /** Support view: which policy governs this employee, and why. */
  async resolveForEmployee(employeeId: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        ...POLICY_RESOLVABLE_SELECT,
      },
    });
    if (!emp) throw new NotFoundException('Employee not found');

    const resolvable: PolicyResolvable = {
      overtimePolicyId: emp.overtimePolicyId,
      employmentType: emp.employmentType,
    };
    const { policy, source } =
      await this.resolveEffectivePolicyWithSource(resolvable);
    const cfg = await this.resolveOvertimeConfig(resolvable);

    return {
      employeeId: emp.id,
      employeeName: [emp.firstName, emp.lastName].filter(Boolean).join(' '),
      employmentType: resolvable.employmentType,
      overtimePolicyId: emp.overtimePolicyId,
      source,
      effectivePolicyId: policy?.id ?? null,
      effectivePolicyName: policy?.name ?? null,
      eligible: cfg.eligible,
      holidayBehavior: cfg.holidayBehavior,
    };
  }

  /**
   * Idempotently ensure a "Company Default" policy exists mirroring the current
   * company overtime settings, so introducing a targeted policy changes nothing
   * for anyone the new policy does not name.
   */
  async ensureCompanyDefault(): Promise<{
    created: boolean;
    policyId: string;
  }> {
    const active = await this.prisma.overtimePolicy.findFirst({
      where: { isDefault: true, isActive: true },
    });
    if (active) return { created: false, policyId: active.id };

    // A "Company Default" may already exist but be inactive or demoted —
    // promote it rather than colliding on the unique name.
    const byName = await this.prisma.overtimePolicy.findUnique({
      where: { name: 'Company Default' },
    });
    if (byName) {
      const promoted = await this.setDefault(byName.id);
      return { created: false, policyId: promoted.id };
    }

    const global = await this.getOvertimeConfig();
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
            'Mirrors the company overtime settings, so an employee no targeted policy names is governed by exactly the rates on the settings screen.',
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

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async list() {
    return this.prisma.overtimePolicy.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      include: POLICY_INCLUDE,
    });
  }

  async get(id: string) {
    const policy = await this.prisma.overtimePolicy.findUnique({
      where: { id },
      include: POLICY_INCLUDE,
    });
    if (!policy) throw new NotFoundException('Overtime policy not found');
    return policy;
  }

  async create(dto: CreateOvertimePolicyDto) {
    const global = await this.getOvertimeConfig();
    const rules = composeRules(dto.rules, global);
    this.validateRules(rules);

    const isActive = dto.isActive ?? true;
    if (dto.employmentType && isActive) {
      await this.assertNoActiveTypeClash(dto.employmentType, null);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
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
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  async update(id: string, dto: UpdateOvertimePolicyDto) {
    const existing = await this.prisma.overtimePolicy.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Overtime policy not found');

    const global = await this.getOvertimeConfig();
    // Normalize the stored blob against the company defaults first — that
    // self-heals a partial or older-schema row so validation never trips over a
    // tier that was never written — then overlay the edit. An absent
    // `dto.rules` is simply an empty overlay.
    const nextRules = overlayRules(
      composeRules(existing.rules as Partial<OvertimePolicyRules>, global),
      dto.rules ?? {},
    );
    this.validateRules(nextRules);

    const nextActive = dto.isActive ?? existing.isActive;
    // The active default is the fallback for everyone no other policy covers.
    // Losing it drops all of them onto the raw settings table, so neither
    // deactivating it nor clearing its flag is allowed without a replacement.
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
      return await this.prisma.$transaction(async (tx) => {
        const makingDefault =
          (dto.isDefault ?? existing.isDefault) && nextActive;
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
            isDefault: makingDefault
              ? true
              : (dto.isDefault ?? existing.isDefault),
            employmentType: nextType,
            rules: nextRules as unknown as Prisma.InputJsonValue,
          },
        });
      });
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

    return this.prisma.$transaction(async (tx) => {
      await tx.overtimePolicy.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
      return tx.overtimePolicy.update({
        where: { id },
        data: { isDefault: true, isActive: true },
      });
    });
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
      return await this.prisma.overtimePolicy.update({
        where: { id },
        data: { isActive },
      });
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

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
    // Both `Employee.overtimePolicyId` and `OvertimeRequest.overtimePolicyId`
    // are SET NULL, so deleting a policy leaves history intact and drops its
    // assignees back onto the employment-type or default policy.
    await this.prisma.overtimePolicy.delete({ where: { id } });
    return { id };
  }

  // ── Assignment ───────────────────────────────────────────────────────────

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

    // Both fields are optional and independent: naming only one must leave the
    // other exactly as it was, so an HR user setting an employment type cannot
    // wipe an override somebody deliberately pinned.
    const data: Prisma.EmployeeUpdateInput = {};
    if (dto.employmentType !== undefined) {
      data.employmentType = dto.employmentType;
    }
    if (Object.prototype.hasOwnProperty.call(dto, 'overtimePolicyId')) {
      data.overtimePolicy = dto.overtimePolicyId
        ? { connect: { id: dto.overtimePolicyId } }
        : { disconnect: true };
    }

    return this.prisma.employee.update({
      where: { id: dto.employeeId },
      data,
      select: { id: true, ...POLICY_RESOLVABLE_SELECT },
    });
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

  /** Cross-field and range validation on the composed rules blob. */
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

  /** Turn a unique-constraint failure into the conflict that caused it. */
  private mapWriteError(e: unknown): Error {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      // Prisma reports the offending columns as a string array on most
      // adapters and a bare string on a few, so both are flattened here.
      const raw: unknown = e.meta?.target;
      const target = Array.isArray(raw)
        ? raw.join(',')
        : typeof raw === 'string'
          ? raw
          : '';
      if (target.includes('name')) {
        return new ConflictException('A policy with this name already exists');
      }
      if (target.includes('default')) {
        return new ConflictException('Another active default policy exists');
      }
      if (target.includes('employment_type')) {
        return new ConflictException(
          'An active policy already targets this employment type',
        );
      }
      return new ConflictException('Overtime policy conflict');
    }
    return e as Error;
  }
}
