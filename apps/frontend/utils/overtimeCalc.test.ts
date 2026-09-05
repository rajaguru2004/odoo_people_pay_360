import { describe, expect, it } from 'vitest';
import {
  OvertimeConfigLite,
  computeOvertimePreview,
  dayBoundaryInstant,
  parseThresholdMinutes,
} from './overtimeCalc';

/**
 * The overtime preview on the request form.
 *
 * This is a deliberate mirror of the backend engine, and the whole point of a
 * mirror is that the two agree. When they diverge the employee is shown one
 * figure and paid another — a disagreement nobody notices until payday, because
 * both numbers look plausible on their own.
 *
 * Everything is UTC wall-clock by convention: an entered 17:00 is
 * `...T17:00:00Z`. The helper below keeps that explicit in every case.
 */

/** `at('2026-03-09', '17:00')` → the Date the form would construct. */
const at = (date: string, time: string) => new Date(`${date}T${time}:00Z`);

const BASE_CONFIG: OvertimeConfigLite = {
  regularRate: 1.25,
  lateRate: 1.5,
  doubleRate: 2,
  doubleOtEnabled: true,
  lateThresholdMinutes: 21 * 60, // 21:00
  dayBoundaryMinutes: 4 * 60, // 04:00 next day
  foodAllowanceEnabled: true,
  foodAllowanceThresholdMinutes: 20 * 60, // 20:00
  foodAllowanceAmount: 100,
  doubleFoodAllowanceAnyTime: false,
};

const cfg = (overrides: Partial<OvertimeConfigLite> = {}): OvertimeConfigLite => ({
  ...BASE_CONFIG,
  ...overrides,
});

describe('parseThresholdMinutes', () => {
  it('converts HH:MM to minutes past midnight', () => {
    expect(parseThresholdMinutes('21:00', 0)).toBe(1260);
    expect(parseThresholdMinutes('04:30', 0)).toBe(270);
    expect(parseThresholdMinutes('00:00', 999)).toBe(0);
  });

  it('treats a missing minute part as :00', () => {
    expect(parseThresholdMinutes('21', 0)).toBe(1260);
  });

  it('falls back when the hour is unreadable', () => {
    expect(parseThresholdMinutes('abc', 1260)).toBe(1260);
    expect(parseThresholdMinutes('x:30', 1260)).toBe(1260);
  });

  it('falls back for an empty or absent value rather than reading midnight', () => {
    // `Number('')` is 0, not NaN, so the isNaN guard alone never fired here and
    // a blank setting became a threshold of 0 — i.e. every minute of overtime
    // billed at the late rate. Call sites happened to mask it with `|| '22:00'`,
    // which made the `fallbackMin` argument look like protection it did not
    // provide. Now it is.
    expect(parseThresholdMinutes('', 1260)).toBe(1260);
    expect(parseThresholdMinutes('   ', 1260)).toBe(1260);
    expect(parseThresholdMinutes(undefined as unknown as string, 1260)).toBe(1260);
  });
});

describe('dayBoundaryInstant', () => {
  it('places an early-morning boundary on the NEXT calendar day', () => {
    // The noon rule: 04:00 closes the attendance day that started on the 9th,
    // so an evening shift running past midnight is still that day's overtime.
    const boundary = dayBoundaryInstant(at('2026-03-09', '18:00'), 4 * 60);
    expect(boundary.toISOString()).toBe('2026-03-10T04:00:00.000Z');
  });

  it('places a boundary at or after noon on the SAME calendar day', () => {
    const boundary = dayBoundaryInstant(at('2026-03-09', '08:00'), 12 * 60);
    expect(boundary.toISOString()).toBe('2026-03-09T12:00:00.000Z');
  });

  it('treats exactly 12:00 as same-day, not next-day', () => {
    // The rule is `< 720`, so noon itself is the first same-day value. Pinned
    // because an off-by-one here moves a whole shift into the wrong day.
    const boundary = dayBoundaryInstant(at('2026-03-09', '08:00'), 720);
    expect(boundary.toISOString()).toBe('2026-03-09T12:00:00.000Z');
    const justBefore = dayBoundaryInstant(at('2026-03-09', '08:00'), 719);
    expect(justBefore.toISOString()).toBe('2026-03-10T11:59:00.000Z');
  });
});

describe('computeOvertimePreview — the regular/late split', () => {
  it('bills everything at regular when the work ends before the threshold', () => {
    const p = computeOvertimePreview(at('2026-03-09', '18:00'), at('2026-03-09', '20:00'), false, cfg());
    expect(p.totalHours).toBe(2);
    expect(p.regularHours).toBe(2);
    expect(p.lateHours).toBe(0);
    expect(p.isLate).toBe(false);
    expect(p.otType).toBe('REGULAR');
    expect(p.rateMultiplier).toBe(1.25);
  });

  it('splits across the threshold rather than billing the whole window at one tier', () => {
    // 18:00→23:00 with a 21:00 threshold is 3h regular + 2h late, not 5h of
    // either. Collapsing the split is the expensive failure here.
    const p = computeOvertimePreview(at('2026-03-09', '18:00'), at('2026-03-09', '23:00'), false, cfg());
    expect(p.totalHours).toBe(5);
    expect(p.regularHours).toBe(3);
    expect(p.lateHours).toBe(2);
    expect(p.isLate).toBe(true);
    expect(p.otType).toBe('LATE');
    expect(p.rateMultiplier).toBe(1.5);
  });

  it('bills everything late when the window starts after the threshold', () => {
    const p = computeOvertimePreview(at('2026-03-09', '22:00'), at('2026-03-09', '23:30'), false, cfg());
    expect(p.totalHours).toBe(1.5);
    expect(p.regularHours).toBe(0);
    expect(p.lateHours).toBe(1.5);
    expect(p.otType).toBe('LATE');
  });

  it('treats ending exactly at the threshold as not late', () => {
    const p = computeOvertimePreview(at('2026-03-09', '18:00'), at('2026-03-09', '21:00'), false, cfg());
    expect(p.isLate).toBe(false);
    expect(p.regularHours).toBe(3);
    expect(p.lateHours).toBe(0);
  });

  it('keeps the tiers summing to the total', () => {
    const windows: Array<[string, string]> = [
      ['18:00', '20:00'],
      ['18:00', '23:00'],
      ['22:00', '23:30'],
      ['19:30', '21:15'],
      ['20:45', '22:05'],
    ];
    for (const [from, to] of windows) {
      const p = computeOvertimePreview(at('2026-03-09', from), at('2026-03-09', to), false, cfg());
      expect(p.regularHours + p.lateHours + p.doubleHours).toBeCloseTo(p.totalHours, 2);
    }
  });
});

describe('computeOvertimePreview — double days', () => {
  it('puts every hour in the double bucket, leaving regular and late empty', () => {
    const p = computeOvertimePreview(at('2026-03-09', '10:00'), at('2026-03-09', '18:00'), true, cfg());
    expect(p.totalHours).toBe(8);
    expect(p.doubleHours).toBe(8);
    expect(p.regularHours).toBe(0);
    expect(p.lateHours).toBe(0);
    expect(p.otType).toBe('DOUBLE');
    expect(p.rateMultiplier).toBe(2);
  });

  it('marks a double day running past the threshold as DOUBLE_LATE', () => {
    const p = computeOvertimePreview(at('2026-03-09', '18:00'), at('2026-03-09', '23:00'), true, cfg());
    expect(p.otType).toBe('DOUBLE_LATE');
    expect(p.isLate).toBe(true);
    expect(p.doubleHours).toBe(5);
  });
});

describe('computeOvertimePreview — overnight and the day boundary', () => {
  it('rolls an end that precedes the start forward by a day', () => {
    // 22:00 → 02:00 is four hours of night work, not a negative window.
    const p = computeOvertimePreview(at('2026-03-09', '22:00'), at('2026-03-09', '02:00'), false, cfg());
    expect(p.totalHours).toBe(4);
    expect(p.clampedByBoundary).toBe(false);
  });

  it('clamps at the day boundary and says so', () => {
    // 22:00 → 06:00 crosses the 04:00 close, so only 6h are payable and the
    // form must be able to warn about the trimmed 2h.
    const p = computeOvertimePreview(at('2026-03-09', '22:00'), at('2026-03-10', '06:00'), false, cfg());
    expect(p.totalHours).toBe(6);
    expect(p.clampedByBoundary).toBe(true);
  });

  it('does not clamp a window ending exactly on the boundary', () => {
    const p = computeOvertimePreview(at('2026-03-09', '22:00'), at('2026-03-10', '04:00'), false, cfg());
    expect(p.totalHours).toBe(6);
    expect(p.clampedByBoundary).toBe(false);
  });

  it('reports zero payable hours when the window starts after a same-day boundary', () => {
    // Still flags the clamp, so the UI explains the zero instead of showing a
    // bare 0 with no reason. Needs a boundary at or after noon — an early-hours
    // boundary is always rolled to the next day, so nothing can start past it.
    const p = computeOvertimePreview(
      at('2026-03-09', '13:00'),
      at('2026-03-09', '15:00'),
      false,
      cfg({ dayBoundaryMinutes: 12 * 60 }),
    );
    expect(p.totalHours).toBe(0);
    expect(p.regularHours).toBe(0);
    expect(p.lateHours).toBe(0);
    expect(p.foodAllowance).toBe(0);
    expect(p.clampedByBoundary).toBe(true);
  });

  it('never clamps an evening window when the boundary is in the small hours', () => {
    // The noon rule's real consequence: with a 04:00 close, no same-day evening
    // time can exceed the boundary, because the boundary is tomorrow's 04:00.
    const p = computeOvertimePreview(at('2026-03-09', '05:00'), at('2026-03-09', '23:00'), false, cfg());
    expect(p.clampedByBoundary).toBe(false);
    expect(p.totalHours).toBe(18);
  });

  it('splits tiers correctly on a clamped overnight window', () => {
    const p = computeOvertimePreview(at('2026-03-09', '20:00'), at('2026-03-10', '06:00'), false, cfg());
    // 20:00 → 04:00 clamped = 8h; 20:00–21:00 regular, 21:00–04:00 late.
    expect(p.totalHours).toBe(8);
    expect(p.regularHours).toBe(1);
    expect(p.lateHours).toBe(7);
    expect(p.clampedByBoundary).toBe(true);
  });
});

describe('computeOvertimePreview — food allowance', () => {
  it('pays it once the work runs past the food threshold', () => {
    const p = computeOvertimePreview(at('2026-03-09', '18:00'), at('2026-03-09', '21:00'), false, cfg());
    expect(p.foodAllowance).toBe(100);
  });

  it('withholds it below the threshold', () => {
    const p = computeOvertimePreview(at('2026-03-09', '18:00'), at('2026-03-09', '19:30'), false, cfg());
    expect(p.foodAllowance).toBe(0);
  });

  it('withholds it when the feature is off, however long the shift', () => {
    const p = computeOvertimePreview(at('2026-03-09', '18:00'), at('2026-03-09', '23:00'), false, cfg({ foodAllowanceEnabled: false }));
    expect(p.foodAllowance).toBe(0);
  });

  it('judges the threshold against the CLAMPED end, not the entered one', () => {
    // A shift trimmed back below the food threshold must lose the allowance —
    // otherwise the preview pays for a meal the payslip will not.
    // 05:00 → 23:00 with a 12:00 close is trimmed to 12:00, short of the 20:00
    // food threshold the raw end would have cleared.
    const p = computeOvertimePreview(
      at('2026-03-09', '05:00'),
      at('2026-03-09', '23:00'),
      false,
      cfg({ dayBoundaryMinutes: 12 * 60, foodAllowanceThresholdMinutes: 20 * 60 }),
    );
    expect(p.clampedByBoundary).toBe(true);
    expect(p.totalHours).toBe(7);
    expect(p.foodAllowance).toBe(0);
  });

  it('withholds it on a double day below the threshold by default', () => {
    const p = computeOvertimePreview(at('2026-03-09', '09:00'), at('2026-03-09', '13:00'), true, cfg());
    expect(p.foodAllowance).toBe(0);
  });

  it('pays it on a double day at any hour when that switch is on', () => {
    // The daytime-double case: a full worked Sunday earns the meal even though
    // it ends long before the evening threshold.
    const p = computeOvertimePreview(
      at('2026-03-09', '09:00'),
      at('2026-03-09', '13:00'),
      true,
      cfg({ doubleFoodAllowanceAnyTime: true }),
    );
    expect(p.foodAllowance).toBe(100);
  });

});

describe('computeOvertimePreview — identical start and end', () => {
  it('reads equal times as a full overnight shift, not as zero', () => {
    // `end <= start` rolls the end forward a day, and the comparison is
    // inclusive — so an employee who picks 09:00 twice is previewed a
    // 24-hour shift, trimmed by the 04:00 close to 19 payable hours.
    //
    // This is a live defect, not a quirk of the maths: the request form
    // (app/dashboard/overtime/new/page.tsx) validates each time field with
    // `z.string().min(1)` and has no cross-field refine, and its own
    // `buildOvertimeWindow` repeats the same inclusive comparison — so the
    // 24-hour window is what gets SUBMITTED, not merely previewed.
    //
    // Pinned as-is because changing the comparison is a behaviour fix that
    // belongs with a form-level validation rule, not a silent edit here.
    const p = computeOvertimePreview(at('2026-03-09', '09:00'), at('2026-03-09', '09:00'), false, cfg());
    expect(p.totalHours).toBe(19);
    expect(p.clampedByBoundary).toBe(true);
  });

  it('pays a food allowance on that phantom window', () => {
    // The downstream cost of the above: a meal is granted for a shift the
    // employee never worked.
    const p = computeOvertimePreview(at('2026-03-09', '09:00'), at('2026-03-09', '09:00'), false, cfg());
    expect(p.foodAllowance).toBe(100);
  });
});

describe('computeOvertimePreview — rounding', () => {
  it('rounds hours to two places', () => {
    const p = computeOvertimePreview(at('2026-03-09', '18:00'), at('2026-03-09', '18:40'), false, cfg());
    expect(p.totalHours).toBe(0.67);
  });

  it('keeps a rounded split adding up to the rounded total', () => {
    // Rounding each tier independently can drift from the total; the late
    // bucket is derived by subtraction to prevent that.
    const p = computeOvertimePreview(at('2026-03-09', '20:50'), at('2026-03-09', '21:35'), false, cfg());
    expect(p.regularHours + p.lateHours).toBeCloseTo(p.totalHours, 2);
  });
});

/**
 * Mirror of the backend `splitOvertimeHours — pre-noon late thresholds` block.
 *
 * The Taneka production incident of Aug 2026: a policy stored "11:59" meaning
 * 11:59 PM, the threshold landed behind the overtime start, the regular tier
 * collapsed to zero hours and every evening hour was billed LATE. The preview
 * has to apply the same noon rule as the engine or the form shows one tier and
 * the payslip pays another.
 */
describe('computeOvertimePreview — pre-noon late thresholds (AM/PM slip)', () => {
  it('rolls an AM threshold (11:59) to the next day instead of flagging all OT late', () => {
    const r = computeOvertimePreview(
      at('2026-08-28', '19:00'),
      at('2026-08-28', '22:00'),
      false,
      cfg({ lateThresholdMinutes: 11 * 60 + 59 }),
    );
    expect(r).toMatchObject({
      regularHours: 3,
      lateHours: 0,
      otType: 'REGULAR',
      isLate: false,
    });
  });

  it('reads a 00:00 threshold as midnight, not as noon-ago', () => {
    const r = computeOvertimePreview(
      at('2026-08-28', '17:00'),
      at('2026-08-28', '22:00'),
      false,
      cfg({ lateThresholdMinutes: 0 }),
    );
    expect(r).toMatchObject({
      regularHours: 5,
      lateHours: 0,
      otType: 'REGULAR',
      isLate: false,
    });
  });

  it('keeps a post-noon threshold same-day, so OT starting after it is still late', () => {
    const r = computeOvertimePreview(
      at('2026-08-28', '22:30'),
      at('2026-08-28', '23:30'),
      false,
      cfg({ lateThresholdMinutes: 22 * 60 }),
    );
    expect(r).toMatchObject({
      regularHours: 0,
      lateHours: 1,
      otType: 'LATE',
      isLate: true,
    });
  });

  it('Daily Wages weekday 17:00–22:00 at a 23:59 threshold is fully regular', () => {
    const r = computeOvertimePreview(
      at('2026-08-28', '17:00'),
      at('2026-08-28', '22:00'),
      false,
      cfg({ lateThresholdMinutes: 23 * 60 + 59 }),
    );
    expect(r).toMatchObject({
      regularHours: 5,
      lateHours: 0,
      otType: 'REGULAR',
      isLate: false,
    });
  });
});
