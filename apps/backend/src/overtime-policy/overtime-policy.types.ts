import type { OvertimeConfig, RateTier } from './overtime-config';

/** Current `rules` JSON shape, persisted on `OvertimePolicy.schemaVersion`. */
export const OT_POLICY_RULES_SCHEMA_VERSION = 1;

/**
 * What a holiday means to this policy.
 *
 * A TS enum rather than a Prisma one because it lives inside the JSON `rules`
 * blob: STANDARD pays the holiday premium tier, IGNORE treats the holiday as an
 * ordinary weekday. Daily-wage staff are the case for IGNORE — they are already
 * paid per day worked, so a holiday premium on top is a second payment for the
 * same fact.
 */
export enum HolidayBehaviorEnum {
  STANDARD = 'STANDARD',
  IGNORE = 'IGNORE',
}

export type HolidayBehaviorValue = `${HolidayBehaviorEnum}`;

/**
 * The policy `rules` blob.
 *
 * A superset of the rate / behaviour / allowance / cap fields of
 * {@link OvertimeConfig}, plus the two policy-level fields (`eligible`,
 * `holidayBehavior`) and an optional day-boundary override. The org-flow flags —
 * whether overtime exists at all, who may submit it, whether an approver may
 * edit it — are deliberately NOT per-policy: they are decisions about the
 * company, not about one class of employee.
 */
export interface OvertimePolicyRules {
  /** Per-policy eligibility gate. false → these employees cannot file overtime. */
  eligible: boolean;
  holidayBehavior: HolidayBehaviorValue;

  lateThreshold: string;
  regularRate: number;
  lateRate: number;
  doubleOtEnabled: boolean;
  doubleRate: number;
  doubleOtAllowAnytime: boolean;
  sunday: RateTier;
  holiday: RateTier;
  shiftEndTime: string;
  /** Overrides the global day boundary. null → inherit it. */
  dayEndBoundary: string | null;
  foodAllowanceEnabled: boolean;
  foodAllowanceAmount: number;
  foodAllowanceThreshold: string;
  doubleFoodAllowanceAnyTime: boolean;
  maxHoursPerDay: number;
  maxHoursPerDoubleDay: number;
  maxHoursPerMonth: number;
  maxHoursPerYear: number;
}

/**
 * What the calc engine consumes: the exact {@link OvertimeConfig} shape, so the
 * splitting and monetizing code never learns that policies exist, plus the
 * resolved policy-level fields and the identity of the policy that produced it.
 * `policyId` is null when resolution fell through to the global settings.
 */
export interface ResolvedOvertimeConfig extends OvertimeConfig {
  eligible: boolean;
  holidayBehavior: HolidayBehaviorValue;
  policyId: string | null;
  policyName: string | null;
}

/** Which tier of the inheritance chain produced the effective policy. */
export type PolicyResolutionSource =
  'EMPLOYEE_OVERRIDE' | 'EMPLOYMENT_TYPE' | 'COMPANY_DEFAULT' | 'LEGACY_GLOBAL';

const num = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d;
const bool = (v: unknown, d: boolean): boolean =>
  typeof v === 'boolean' ? v : d;

/** A full, valid `rules` blob built from the current global configuration. */
export function buildDefaultRules(global: OvertimeConfig): OvertimePolicyRules {
  return {
    eligible: true,
    holidayBehavior: 'STANDARD',
    lateThreshold: global.lateThreshold,
    regularRate: global.regularRate,
    lateRate: global.lateRate,
    doubleOtEnabled: global.doubleOtEnabled,
    doubleRate: global.doubleRate,
    doubleOtAllowAnytime: global.doubleOtAllowAnytime,
    sunday: { ...global.sunday },
    holiday: { ...global.holiday },
    shiftEndTime: global.shiftEndTime,
    dayEndBoundary: null,
    foodAllowanceEnabled: global.foodAllowanceEnabled,
    foodAllowanceAmount: global.foodAllowanceAmount,
    foodAllowanceThreshold: global.foodAllowanceThreshold,
    doubleFoodAllowanceAnyTime: global.doubleFoodAllowanceAnyTime,
    maxHoursPerDay: global.maxHoursPerDay,
    maxHoursPerDoubleDay: global.maxHoursPerDoubleDay,
    maxHoursPerMonth: global.maxHoursPerMonth,
    maxHoursPerYear: global.maxHoursPerYear,
  };
}

/**
 * Overlay a partial payload on the defaults derived from `global`, deep-merging
 * the Sunday and Holiday tiers. Used when CREATING a policy: an administrator
 * who names three fields gets a complete, valid rule set.
 */
export function composeRules(
  partial: Partial<OvertimePolicyRules> | undefined,
  global: OvertimeConfig,
): OvertimePolicyRules {
  const base = buildDefaultRules(global);
  const p = partial ?? {};
  return {
    ...base,
    ...p,
    sunday: { ...base.sunday, ...(p.sunday ?? {}) },
    holiday: { ...base.holiday, ...(p.holiday ?? {}) },
  };
}

/**
 * Overlay a partial payload on an EXISTING blob, deep-merging tiers. Used when
 * editing, so a field the form did not send keeps the value it had rather than
 * reverting to a global default the administrator never chose.
 */
export function overlayRules(
  existing: OvertimePolicyRules,
  partial: Partial<OvertimePolicyRules> | undefined,
): OvertimePolicyRules {
  const p = partial ?? {};
  return {
    ...existing,
    ...p,
    sunday: { ...existing.sunday, ...(p.sunday ?? {}) },
    holiday: { ...existing.holiday, ...(p.holiday ?? {}) },
  };
}

/**
 * Merge a stored (possibly partial, possibly older-schema) blob over the live
 * global configuration.
 *
 * Missing rule fields INHERIT the global rather than defaulting to zero: a blob
 * written before a field existed must not silently set that field's rate to
 * nothing, which would pay an hour at 0×.
 */
export function mergeRulesOverGlobal(
  rules: Partial<OvertimePolicyRules>,
  global: OvertimeConfig,
): Omit<ResolvedOvertimeConfig, 'policyId' | 'policyName'> {
  return {
    ...global,
    lateThreshold: rules.lateThreshold ?? global.lateThreshold,
    regularRate: num(rules.regularRate, global.regularRate),
    lateRate: num(rules.lateRate, global.lateRate),
    doubleOtEnabled: bool(rules.doubleOtEnabled, global.doubleOtEnabled),
    doubleRate: num(rules.doubleRate, global.doubleRate),
    doubleOtAllowAnytime: bool(
      rules.doubleOtAllowAnytime,
      global.doubleOtAllowAnytime,
    ),
    sunday: {
      regularRate: num(rules.sunday?.regularRate, global.sunday.regularRate),
      lateRate: num(rules.sunday?.lateRate, global.sunday.lateRate),
      lateThreshold: rules.sunday?.lateThreshold ?? global.sunday.lateThreshold,
    },
    holiday: {
      regularRate: num(rules.holiday?.regularRate, global.holiday.regularRate),
      lateRate: num(rules.holiday?.lateRate, global.holiday.lateRate),
      lateThreshold:
        rules.holiday?.lateThreshold ?? global.holiday.lateThreshold,
    },
    shiftEndTime: rules.shiftEndTime ?? global.shiftEndTime,
    foodAllowanceEnabled: bool(
      rules.foodAllowanceEnabled,
      global.foodAllowanceEnabled,
    ),
    foodAllowanceAmount: num(
      rules.foodAllowanceAmount,
      global.foodAllowanceAmount,
    ),
    foodAllowanceThreshold:
      rules.foodAllowanceThreshold ?? global.foodAllowanceThreshold,
    doubleFoodAllowanceAnyTime: bool(
      rules.doubleFoodAllowanceAnyTime,
      global.doubleFoodAllowanceAnyTime,
    ),
    maxHoursPerDay: num(rules.maxHoursPerDay, global.maxHoursPerDay),
    maxHoursPerDoubleDay: num(
      rules.maxHoursPerDoubleDay,
      global.maxHoursPerDoubleDay,
    ),
    maxHoursPerMonth: num(rules.maxHoursPerMonth, global.maxHoursPerMonth),
    maxHoursPerYear: num(rules.maxHoursPerYear, global.maxHoursPerYear),
    // A policy override of the day boundary, else the global one.
    dayEndBoundary: rules.dayEndBoundary ?? global.dayEndBoundary,
    eligible: bool(rules.eligible, true),
    holidayBehavior: rules.holidayBehavior === 'IGNORE' ? 'IGNORE' : 'STANDARD',
  };
}

/** A resolved config straight from the globals, when no policy governs anyone. */
export function resolvedFromGlobal(
  global: OvertimeConfig,
): ResolvedOvertimeConfig {
  return {
    ...global,
    eligible: true,
    holidayBehavior: 'STANDARD',
    policyId: null,
    policyName: null,
  };
}
