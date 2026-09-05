import { splitOvertimeHours, dayBoundaryInstant } from './overtime-calc.util';

/**
 * Pure unit coverage for the OT hour split + day-boundary clamp.
 * Times are LOCAL wall-clock (no `Z`), matching the overtime engine.
 */
describe('splitOvertimeHours', () => {
  // OT times are UTC wall-clock; anchor test inputs to UTC so they are
  // independent of the runner's own timezone.
  const d = (s: string) => new Date(`${s}Z`);
  const LATE = 22 * 60; // 22:00
  const EOD = 23 * 60 + 59; // 23:59 (same-day boundary, effectively no clamp)

  it('splits 17:00–23:00 into 5h regular + 1h late', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T17:00:00'),
      d('2026-08-19T23:00:00'),
      false,
      LATE,
      EOD,
    );
    expect(r).toMatchObject({
      regularHours: 5,
      lateHours: 1,
      doubleHours: 0,
      totalHours: 6,
      isLate: true,
    });
    expect(r.clampedByBoundary).toBe(false);
  });

  it('all-regular when the window ends before the threshold', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T17:00:00'),
      d('2026-08-19T21:00:00'),
      false,
      LATE,
      EOD,
    );
    expect(r).toMatchObject({ regularHours: 4, lateHours: 0, isLate: false });
  });

  it('all-late when the window starts after the threshold', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T22:30:00'),
      d('2026-08-19T23:30:00'),
      false,
      LATE,
      EOD,
    );
    expect(r).toMatchObject({ regularHours: 0, lateHours: 1, isLate: true });
  });

  it('double-OT day before the double threshold routes all hours to the double-regular bucket', () => {
    const r = splitOvertimeHours(
      d('2026-08-16T08:00:00'),
      d('2026-08-16T17:00:00'),
      true,
      LATE,
      EOD,
    );
    expect(r).toMatchObject({
      regularHours: 0,
      lateHours: 0,
      doubleHours: 9,
      doubleLateHours: 0,
      totalHours: 9,
    });
  });

  it('double-OT day splits at the double late threshold into double-regular and double-late buckets', () => {
    const r = splitOvertimeHours(
      d('2026-08-16T18:00:00'),
      d('2026-08-16T23:00:00'),
      true,
      LATE, // weekday threshold (ignored on a double day)
      EOD,
      20 * 60, // double late threshold 20:00
    );
    // 18:00–20:00 = 2h double-regular, 20:00–23:00 = 3h double-late
    expect(r).toMatchObject({
      regularHours: 0,
      lateHours: 0,
      doubleHours: 2,
      doubleLateHours: 3,
      totalHours: 5,
      isLate: true,
    });
  });

  it('clamps to a same-day boundary of 23:00 (drops hours past it)', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T20:00:00'),
      d('2026-08-20T00:00:00'), // 24:00
      false,
      LATE,
      23 * 60, // 23:00 boundary
    );
    expect(r).toMatchObject({
      regularHours: 2,
      lateHours: 1,
      totalHours: 3,
      clampedByBoundary: true,
    });
  });

  it('after-midnight boundary (02:00) keeps overnight hours on the same attendance day', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T22:00:00'),
      d('2026-08-20T01:00:00'),
      false,
      LATE,
      2 * 60, // 02:00 boundary → belongs to the next calendar day
    );
    expect(r).toMatchObject({
      regularHours: 0,
      lateHours: 3,
      totalHours: 3,
      clampedByBoundary: false,
    });
  });

  it('returns all-zero when the whole window is past the boundary', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T23:30:00'),
      d('2026-08-20T01:00:00'),
      false,
      LATE,
      23 * 60, // boundary 23:00, before the 23:30 start
    );
    expect(r).toMatchObject({
      regularHours: 0,
      lateHours: 0,
      doubleHours: 0,
      totalHours: 0,
    });
  });
});

describe('dayBoundaryInstant', () => {
  it('same-day boundary stays on the anchor date', () => {
    const b = dayBoundaryInstant(new Date('2026-08-19T20:00:00Z'), 23 * 60);
    expect(b.getUTCDate()).toBe(19);
    expect(b.getUTCHours()).toBe(23);
  });

  it('before-noon boundary rolls to the next calendar day (noon rule)', () => {
    const b = dayBoundaryInstant(new Date('2026-08-19T20:00:00Z'), 2 * 60);
    expect(b.getUTCDate()).toBe(20);
    expect(b.getUTCHours()).toBe(2);
  });
});

/**
 * Regression cover for the Taneka production incident (Aug 2026): every
 * evening overtime request was billed at the LATE multiplier because the
 * governing policy stored an AM late threshold ("11:59" for 11:59 PM). The
 * threshold landed BEHIND the overtime start, so the regular tier collapsed to
 * zero hours and `isLate` was true from the first minute.
 */
describe('splitOvertimeHours — pre-noon late thresholds (AM/PM slip)', () => {
  const d = (s: string) => new Date(`${s}Z`);
  const EOD = 23 * 60 + 59;

  it('rolls an AM threshold (11:59) to the next day instead of making all OT late', () => {
    // Monthly Wages (8am to 7pm): shift end 19:00, threshold stored as 11:59.
    const r = splitOvertimeHours(
      d('2026-08-28T19:00:00'),
      d('2026-08-28T22:00:00'),
      false,
      11 * 60 + 59,
      5 * 60, // dayEndBoundary 05:00 → next day
    );
    expect(r).toMatchObject({
      regularHours: 3,
      lateHours: 0,
      totalHours: 3,
      isLate: false,
    });
  });

  it('reads a 00:00 threshold as midnight, not as noon-ago', () => {
    // Company Default stores lateThreshold "00:00" with a 17:00 shift end.
    const r = splitOvertimeHours(
      d('2026-08-28T17:00:00'),
      d('2026-08-28T22:00:00'),
      false,
      0,
      5 * 60,
    );
    expect(r).toMatchObject({
      regularHours: 5,
      lateHours: 0,
      totalHours: 5,
      isLate: false,
    });
  });

  it('keeps a threshold EQUAL to the start same-day, so it is late from minute one', () => {
    // Daily Wages rest-day tier: sunday.lateThreshold 17:00, shift end 17:00.
    // Strict "<" comparison — this must NOT roll forward.
    const r = splitOvertimeHours(
      d('2026-08-30T17:00:00'),
      d('2026-08-30T22:00:00'),
      true,
      23 * 60 + 59,
      5 * 60,
      17 * 60, // double-day late threshold
    );
    expect(r).toMatchObject({
      doubleHours: 0,
      doubleLateHours: 5,
      totalHours: 5,
      isLate: true,
    });
  });

  it('an afternoon threshold after the start still splits normally', () => {
    const r = splitOvertimeHours(
      d('2026-08-28T17:00:00'),
      d('2026-08-28T23:00:00'),
      false,
      22 * 60,
      EOD,
    );
    expect(r).toMatchObject({ regularHours: 5, lateHours: 1, isLate: true });
  });

  it('Daily Wages weekday 17:00–22:00 with a 23:59 threshold is fully regular', () => {
    const r = splitOvertimeHours(
      d('2026-08-28T17:00:00'),
      d('2026-08-28T22:00:00'),
      false,
      23 * 60 + 59,
      5 * 60,
    );
    expect(r).toMatchObject({
      regularHours: 5,
      lateHours: 0,
      isLate: false,
    });
  });
});
