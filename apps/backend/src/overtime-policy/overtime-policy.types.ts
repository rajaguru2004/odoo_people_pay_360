import { OvertimeConfig } from './overtime-config';

/** Current `rules` JSON schema version persisted on OvertimePolicy.schemaVersion. */
export const OT_POLICY_RULES_SCHEMA_VERSION = 1;

/**
 * Holiday behaviour lives inside the JSON `rules` blob rather than a column, so
 * it is a TypeScript enum and not a Prisma one. STANDARD = holiday premium
 * tier; IGNORE = the holiday is worked as an ordinary day, which is how
 * daily-wage staff are paid in several of the jurisdictions this runs in.
 */
export enum HolidayBehaviorEnum {
  STANDARD = 'STANDARD',
  IGNORE = 'IGNORE',
}

export type HolidayBehaviorValue = `${HolidayBehaviorEnum}`;

/** A per-day-type rate tier (Sunday / Holiday). */
export interface RateTier {
  regularRate: number;
  lateRate: number;
  lateThreshold: string;
}

/**
 * The policy `rules` blob. A superset of the rate / behaviour / allowance / cap
 * fields of {@link OvertimeConfig}, plus the two policy-level fields
 * (`eligible`, `holidayBehavior`) and an optional per-policy day-boundary
 * override.
 *
 * The org-flow flags (`enabled`, `allowEmployeeSubmit`,
 * `requireManagerApproval`) are deliberately NOT per-policy: they decide
 * whether the overtime feature is open at all, which is one answer for the
 * company and not a thing a rate card should be able to contradict.
 */
export interface OvertimePolicyRules {
  /** Per-policy eligibility gate. false → these employees cannot register OT. */
  eligible: boolean;
  /** STANDARD = holiday premium tier; IGNORE = holiday treated as a weekday. */
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
  /** Per-policy override of the attendance day boundary. null → inherit. */
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
 * What the calculation engine consumes: the exact {@link OvertimeConfig} shape
 * plus the resolved policy-level fields and the identity of the policy that
 * produced it (null when resolution fell all the way through to the company
 * settings). Keeping it a superset is what lets the split/classify code stay
 * ignorant of where its numbers came from.
 */
export interface ResolvedOvertimeConfig extends OvertimeConfig {
  eligible: boolean;
  holidayBehavior: HolidayBehaviorValue;
  dayEndBoundary: string | null;
  policyId: string | null;
  policyName: string | null;
}

/** Which tier of the inheritance chain produced the effective policy. */
export type PolicyResolutionSource =
  'EMPLOYEE_OVERRIDE' | 'EMPLOYMENT_TYPE' | 'COMPANY_DEFAULT' | 'LEGACY_GLOBAL';

const num = (v: unknown, d: number): number =>
  typeof v === 'number' && !Number.isNaN(v) ? v : d;
const bool = (v: unknown, d: boolean): boolean =>
  typeof v === 'boolean' ? v : d;

/** Build a full, valid `rules` blob from the current company overtime config. */
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
 * Overlay a partial `rules` object on the defaults derived from `global`,
 * deep-merging the Sunday/Holiday tiers so a payload that names one rate does
 * not blank the other two fields of that tier.
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
 * Overlay a partial `rules` object on an existing full blob, deep-merging the
 * tiers. Used when editing a policy so unspecified fields are preserved.
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
 * Merge a stored `rules` blob over the live company config.
 *
 * The blob is read defensively — it is JSON, so a row written under an earlier
 * schema version or edited by hand can be missing anything at all. Every field
 * that is absent or the wrong type inherits the company value rather than
 * collapsing to zero, because a rate of zero is a payslip of zero.
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
    eligible: bool(rules.eligible, true),
    holidayBehavior: rules.holidayBehavior === 'IGNORE' ? 'IGNORE' : 'STANDARD',
    dayEndBoundary: rules.dayEndBoundary ?? null,
  };
}

/** A ResolvedOvertimeConfig straight from the company config — no policy. */
export function resolvedFromGlobal(
  global: OvertimeConfig,
): ResolvedOvertimeConfig {
  return {
    ...global,
    eligible: true,
    holidayBehavior: 'STANDARD',
    dayEndBoundary: null,
    policyId: null,
    policyName: null,
  };
}
