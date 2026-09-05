import type { PrismaService } from '../prisma/prisma.service';

/**
 * The company-wide overtime settings, read from `SystemSetting` rows.
 *
 * These are the bottom of the policy inheritance chain: an OvertimePolicy's
 * `rules` blob is merged OVER this, so a policy that specifies nothing behaves
 * exactly like the company settings do. Keeping the defaults here rather than
 * in the shared settings table means the overtime modules own their own
 * parameters and a deployment that never opens the overtime screens still
 * resolves a complete, valid config.
 */
export interface OvertimeConfig {
  enabled: boolean;
  lateThreshold: string;
  foodAllowanceEnabled: boolean;
  foodAllowanceThreshold: string;
  foodAllowanceAmount: number;
  regularRate: number;
  lateRate: number;
  doubleOtEnabled: boolean;
  doubleRate: number;
  sunday: { regularRate: number; lateRate: number; lateThreshold: string };
  holiday: { regularRate: number; lateRate: number; lateThreshold: string };
  shiftEndTime: string;
  doubleFoodAllowanceAnyTime: boolean;
  doubleOtAllowAnytime: boolean;
  maxHoursPerDay: number;
  maxHoursPerDoubleDay: number;
  maxHoursPerMonth: number;
  maxHoursPerYear: number;
  requireManagerApproval: boolean;
  allowEmployeeSubmit: boolean;
}

/** Every setting key the overtime modules read, with the value it falls back to. */
export const OVERTIME_SETTING_DEFAULTS = {
  overtime_enabled: 'true',
  overtime_late_threshold: '22:00',
  overtime_food_allowance_enabled: 'true',
  overtime_food_allowance_amount: '150',
  overtime_regular_rate: '1.5',
  overtime_late_rate: '1.5',
  overtime_double_ot_enabled: 'true',
  overtime_double_rate: '2.0',
  overtime_shift_end_time: '17:00',
  overtime_double_food_allowance_any_time: 'false',
  overtime_double_ot_allow_anytime: 'true',
  overtime_max_hours_per_day: '4',
  overtime_max_hours_per_double_day: '12',
  overtime_max_hours_per_month: '30',
  overtime_max_hours_per_year: '200',
  overtime_require_manager_approval: 'true',
  overtime_allow_employee_submit: 'true',
  /** Blank reasons are accepted once an administrator turns this off. */
  overtime_require_reason: 'true',
  /** Whether an approver may correct the window while approving it. */
  overtime_approver_edit_enabled: 'true',
  overtime_site_allowance_enabled: 'false',
  /** 0 means "no ceiling". */
  overtime_site_allowance_max: '0',
  /**
   * How far past midnight an attendance day runs. Overtime is only payable up
   * to this clock; a night shift that runs past it is clamped, not extended.
   * Its own key rather than the `attendance_day_end` the reports use — that one
   * answers "is today's absence count final yet", which is a much earlier hour
   * and would silently truncate every evening request.
   */
  attendance_day_end_time: '23:59',
} as const;

export type OvertimeSettingKey = keyof typeof OVERTIME_SETTING_DEFAULTS;

/**
 * Assemble the typed config from raw setting rows.
 *
 * The per-day-type tiers fall back through the flat `doubleRate` and the
 * weekday threshold rather than through a constant, so an administrator who
 * sets one double rate gets it applied on Sundays AND on public holidays
 * without having to fill in six more fields to say the same thing.
 */
export function buildOvertimeConfig(
  stored: ReadonlyMap<string, string>,
): OvertimeConfig {
  const v = (key: string, fallback = ''): string =>
    stored.get(key) ??
    (OVERTIME_SETTING_DEFAULTS as Record<string, string>)[key] ??
    fallback;

  const num = (raw: string, fallback: number): number => {
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const doubleRate = num(v('overtime_double_rate'), 2);
  const lateThreshold = v('overtime_late_threshold');

  return {
    enabled: v('overtime_enabled') !== 'false',
    lateThreshold,
    foodAllowanceEnabled: v('overtime_food_allowance_enabled') !== 'false',
    foodAllowanceThreshold:
      stored.get('overtime_food_allowance_threshold') ?? lateThreshold,
    foodAllowanceAmount: num(v('overtime_food_allowance_amount'), 150),
    regularRate: num(v('overtime_regular_rate'), 1.5),
    lateRate: num(v('overtime_late_rate'), 1.5),
    doubleOtEnabled: v('overtime_double_ot_enabled') !== 'false',
    doubleRate,
    sunday: {
      regularRate: num(
        stored.get('overtime_sunday_regular_rate') ?? '',
        doubleRate,
      ),
      lateRate: num(stored.get('overtime_sunday_late_rate') ?? '', doubleRate),
      lateThreshold:
        stored.get('overtime_sunday_late_threshold') ?? lateThreshold,
    },
    holiday: {
      regularRate: num(
        stored.get('overtime_holiday_regular_rate') ?? '',
        doubleRate,
      ),
      lateRate: num(stored.get('overtime_holiday_late_rate') ?? '', doubleRate),
      lateThreshold:
        stored.get('overtime_holiday_late_threshold') ?? lateThreshold,
    },
    shiftEndTime: v('overtime_shift_end_time'),
    doubleFoodAllowanceAnyTime:
      v('overtime_double_food_allowance_any_time') !== 'false',
    doubleOtAllowAnytime: v('overtime_double_ot_allow_anytime') !== 'false',
    maxHoursPerDay: num(v('overtime_max_hours_per_day'), 4),
    maxHoursPerDoubleDay: num(v('overtime_max_hours_per_double_day'), 12),
    maxHoursPerMonth: num(v('overtime_max_hours_per_month'), 30),
    maxHoursPerYear: num(v('overtime_max_hours_per_year'), 200),
    requireManagerApproval: v('overtime_require_manager_approval') !== 'false',
    allowEmployeeSubmit: v('overtime_allow_employee_submit') !== 'false',
  };
}

/** One overtime setting, with its default applied. */
export async function overtimeSetting(
  prisma: PrismaService,
  key: OvertimeSettingKey,
): Promise<string> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row?.value ?? OVERTIME_SETTING_DEFAULTS[key];
}

/**
 * The whole config in one query.
 *
 * Read by prefix rather than key by key: the resolver runs on every submission,
 * every preview and every approval, and twenty-odd round trips per request is
 * the kind of cost that only shows up once a month has real data in it.
 */
export async function loadOvertimeConfig(
  prisma: PrismaService,
): Promise<OvertimeConfig> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { startsWith: 'overtime_' } },
    select: { key: true, value: true },
  });
  return buildOvertimeConfig(new Map(rows.map((r) => [r.key, r.value])));
}
