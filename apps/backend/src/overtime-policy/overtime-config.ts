import { SystemSettingsService } from '../system-settings/system-settings.service';

/**
 * The company-wide overtime configuration, read from `SystemSetting` rows.
 *
 * ## Why it is assembled here and not in `system-settings/`
 *
 * `SystemSettingsService` is shared infrastructure this branch does not own, and
 * a typed getter for one module's twenty keys does not belong in it. Everything
 * below goes through the public `get(key)` door, so nothing about the settings
 * module changes to support this.
 *
 * ## The rate tiers
 *
 * Sunday and Holiday each get their own multiplier pair and their own late
 * threshold, defaulting to the flat `overtime_double_rate` when unset. One
 * "double rate" for both is the common case and is what the defaults express;
 * separating them is what lets a company pay a public holiday differently from
 * an ordinary rest day without a code change.
 */
export interface RateTier {
  regularRate: number;
  lateRate: number;
  /** "HH:MM" wall clock. */
  lateThreshold: string;
}

export interface OvertimeConfig {
  /** The kill switch. Off, and no request can be filed at all. */
  enabled: boolean;
  /** "HH:MM" — past this, weekday overtime moves to the late tier. */
  lateThreshold: string;
  foodAllowanceEnabled: boolean;
  foodAllowanceThreshold: string;
  foodAllowanceAmount: number;
  regularRate: number;
  lateRate: number;
  doubleOtEnabled: boolean;
  doubleRate: number;
  sunday: RateTier;
  holiday: RateTier;
  /** When the ordinary working day ends — overtime may not start before it. */
  shiftEndTime: string;
  /** A rest day has no working hours to overlap, when the policy says so. */
  doubleOtAllowAnytime: boolean;
  doubleFoodAllowanceAnyTime: boolean;
  maxHoursPerDay: number;
  maxHoursPerDoubleDay: number;
  maxHoursPerMonth: number;
  maxHoursPerYear: number;
  /** Whether an employee may file their own overtime at all. */
  allowEmployeeSubmit: boolean;
  requireReason: boolean;
  approverEditEnabled: boolean;
  siteAllowanceEnabled: boolean;
  /** 0 means "no ceiling", the convention every maximum in this app uses. */
  siteAllowanceMax: number;
  /**
   * When the attendance day closes, as a wall clock. Overtime is clamped to it.
   *
   * A key of its own rather than the attendance module's `attendance_day_end`:
   * that setting means "until this passes, an absence count is a prediction",
   * defaults to 20:00, and reusing it would silently stop paying overtime at
   * eight in the evening.
   */
  dayEndBoundary: string;
}

/** Every default in one place, so a fresh database still computes overtime. */
export const OVERTIME_SETTING_DEFAULTS: Record<string, string> = {
  overtime_enabled: 'true',
  overtime_allow_employee_submit: 'true',
  overtime_require_reason: 'true',
  overtime_approver_edit_enabled: 'true',
  overtime_late_threshold: '22:00',
  overtime_regular_rate: '1.25',
  overtime_late_rate: '1.5',
  overtime_double_ot_enabled: 'true',
  overtime_double_rate: '2',
  overtime_double_ot_allow_anytime: 'true',
  overtime_sunday_regular_rate: '',
  overtime_sunday_late_rate: '',
  overtime_sunday_late_threshold: '',
  overtime_holiday_regular_rate: '',
  overtime_holiday_late_rate: '',
  overtime_holiday_late_threshold: '',
  overtime_food_allowance_enabled: 'true',
  overtime_food_allowance_amount: '3',
  overtime_food_allowance_threshold: '',
  overtime_double_food_allowance_any_time: 'false',
  overtime_site_allowance_enabled: 'false',
  overtime_site_allowance_max: '0',
  overtime_max_hours_per_day: '4',
  overtime_max_hours_per_double_day: '12',
  overtime_max_hours_per_month: '30',
  overtime_max_hours_per_year: '200',
  overtime_day_end_boundary: '23:59',
};

/**
 * Read the whole configuration in one pass.
 *
 * One `get` per key rather than a bulk read because `SystemSettingsService.get`
 * is the only door that applies the module's own defaults; `getAll()` masks
 * secrets and would hand back the mask string for any key that ever became one.
 */
export async function loadOvertimeConfig(
  settings: SystemSettingsService,
): Promise<OvertimeConfig> {
  const keys = Object.keys(OVERTIME_SETTING_DEFAULTS);
  const values = await Promise.all(keys.map((key) => settings.get(key)));
  const map = new Map(keys.map((key, i) => [key, values[i]]));

  const raw = (key: string): string => {
    const value = map.get(key);
    const fallback = OVERTIME_SETTING_DEFAULTS[key];
    return value === undefined || value === '' ? fallback : value;
  };
  const flag = (key: string) => raw(key) !== 'false';
  const num = (key: string) => {
    const parsed = Number(raw(key));
    return Number.isFinite(parsed)
      ? parsed
      : Number(OVERTIME_SETTING_DEFAULTS[key]);
  };
  /** A tier value, falling through to the flat double rate when blank. */
  const tierNum = (key: string, fallback: number) => {
    const value = map.get(key);
    const parsed = Number(value);
    return value !== undefined && value !== '' && Number.isFinite(parsed)
      ? parsed
      : fallback;
  };
  const tierTime = (key: string, fallback: string) => {
    const value = map.get(key);
    return value ? value : fallback;
  };

  const lateThreshold = raw('overtime_late_threshold');
  const doubleRate = num('overtime_double_rate');

  // The office end is the attendance module's, not a second copy of it: the
  // ordinary working day is one fact, and overtime starting before it ends would
  // pay the same hour twice.
  const shiftEndTime = (await settings.get('attendance_office_end')) || '17:00';

  return {
    enabled: flag('overtime_enabled'),
    lateThreshold,
    regularRate: num('overtime_regular_rate'),
    lateRate: num('overtime_late_rate'),
    doubleOtEnabled: flag('overtime_double_ot_enabled'),
    doubleRate,
    doubleOtAllowAnytime: flag('overtime_double_ot_allow_anytime'),
    sunday: {
      regularRate: tierNum('overtime_sunday_regular_rate', doubleRate),
      lateRate: tierNum('overtime_sunday_late_rate', doubleRate),
      lateThreshold: tierTime('overtime_sunday_late_threshold', lateThreshold),
    },
    holiday: {
      regularRate: tierNum('overtime_holiday_regular_rate', doubleRate),
      lateRate: tierNum('overtime_holiday_late_rate', doubleRate),
      lateThreshold: tierTime('overtime_holiday_late_threshold', lateThreshold),
    },
    shiftEndTime,
    foodAllowanceEnabled: flag('overtime_food_allowance_enabled'),
    foodAllowanceAmount: num('overtime_food_allowance_amount'),
    // Its OWN threshold, defaulting to the late one. An allowance for working
    // through dinner and a higher pay tier are different questions that happen
    // to have the same answer at most companies.
    foodAllowanceThreshold: tierTime(
      'overtime_food_allowance_threshold',
      lateThreshold,
    ),
    doubleFoodAllowanceAnyTime:
      raw('overtime_double_food_allowance_any_time') === 'true',
    maxHoursPerDay: num('overtime_max_hours_per_day'),
    maxHoursPerDoubleDay: num('overtime_max_hours_per_double_day'),
    maxHoursPerMonth: num('overtime_max_hours_per_month'),
    maxHoursPerYear: num('overtime_max_hours_per_year'),
    allowEmployeeSubmit: flag('overtime_allow_employee_submit'),
    requireReason: flag('overtime_require_reason'),
    approverEditEnabled: flag('overtime_approver_edit_enabled'),
    siteAllowanceEnabled: raw('overtime_site_allowance_enabled') === 'true',
    siteAllowanceMax: num('overtime_site_allowance_max'),
    dayEndBoundary: raw('overtime_day_end_boundary'),
  };
}
