import { splitOvertimeHours, dayBoundaryInstant } from './overtime-calc.util';

/**
 * Pure coverage for the tier split and the day-boundary clamp.
 *
 * Every instant is anchored to UTC because overtime times are stored as
 * zone-naive wall clocks tagged UTC — writing them any other way would make the
 * expectations depend on the timezone the test runner happens to be in.
 */
describe('splitOvertimeHours', () => {
  const d = (s: string) => new Date(`${s}Z`);
  const LATE = 22 * 60; // 22:00
  const EOD = 23 * 60 + 59; // 23:59 — a same-day boundary, so effectively no clamp

  it('splits 17:00-23:00 into 5h regular and 1h late', () => {
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

  it('is all regular when the window ends before the threshold', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T17:00:00'),
      d('2026-08-19T21:00:00'),
      false,
      LATE,
      EOD,
    );
    expect(r).toMatchObject({ regularHours: 4, lateHours: 0, isLate: false });
  });

  it('is all late when the window starts after the threshold', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T22:30:00'),
      d('2026-08-19T23:30:00'),
      false,
      LATE,
      EOD,
    );
    expect(r).toMatchObject({ regularHours: 0, lateHours: 1, isLate: true });
  });

  it('routes a double-OT day before its threshold to the double-regular bucket', () => {
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

  it('splits a double-OT day at its own late threshold', () => {
    const r = splitOvertimeHours(
      d('2026-08-16T18:00:00'),
      d('2026-08-16T23:00:00'),
      true,
      LATE, // the weekday threshold, ignored on a double day
      EOD,
      20 * 60, // double late threshold 20:00
    );
    // 18:00-20:00 = 2h double-regular, 20:00-23:00 = 3h double-late
    expect(r).toMatchObject({
      regularHours: 0,
      lateHours: 0,
      doubleHours: 2,
      doubleLateHours: 3,
      totalHours: 5,
      isLate: true,
    });
  });

  it('clamps to a same-day boundary of 23:00, dropping the hours past it', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T20:00:00'),
      d('2026-08-20T00:00:00'),
      false,
      LATE,
      23 * 60,
    );
    expect(r).toMatchObject({
      regularHours: 2,
      lateHours: 1,
      totalHours: 3,
      clampedByBoundary: true,
    });
  });

  it('keeps overnight hours on the same attendance day for an after-midnight boundary', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T22:00:00'),
      d('2026-08-20T01:00:00'),
      false,
      LATE,
      2 * 60, // 02:00 boundary, so it belongs to the next calendar day
    );
    expect(r).toMatchObject({
      regularHours: 0,
      lateHours: 3,
      totalHours: 3,
      clampedByBoundary: false,
    });
  });

  it('returns all zeroes when the whole window sits past the boundary', () => {
    const r = splitOvertimeHours(
      d('2026-08-19T23:30:00'),
      d('2026-08-20T01:00:00'),
      false,
      LATE,
      23 * 60, // boundary 23:00, ahead of the 23:30 start
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
  it('keeps a same-day boundary on the anchor date', () => {
    const b = dayBoundaryInstant(new Date('2026-08-19T20:00:00Z'), 23 * 60);
    expect(b.getUTCDate()).toBe(19);
    expect(b.getUTCHours()).toBe(23);
  });

  it('rolls a before-noon boundary to the next calendar day', () => {
    const b = dayBoundaryInstant(new Date('2026-08-19T20:00:00Z'), 2 * 60);
    expect(b.getUTCDate()).toBe(20);
    expect(b.getUTCHours()).toBe(2);
  });
});

/**
 * Thresholds entered as AM times when a PM time was meant.
 *
 * A threshold read naively as an early-morning clock lands BEHIND an evening
 * overtime start, the regular tier collapses to nothing, and every hour of the
 * evening bills at the late multiplier. The noon rule exists to stop that, and
 * these cases pin both sides of it.
 */
describe('splitOvertimeHours with pre-noon late thresholds', () => {
  const d = (s: string) => new Date(`${s}Z`);
  const EOD = 23 * 60 + 59;

  it('rolls an 11:59 threshold forward rather than making all overtime late', () => {
    // A shift ending at 19:00 against a threshold stored as "11:59".
    const r = splitOvertimeHours(
      d('2026-08-28T19:00:00'),
      d('2026-08-28T22:00:00'),
      false,
      11 * 60 + 59,
      5 * 60, // day boundary 05:00, so it belongs to the next day
    );
    expect(r).toMatchObject({
      regularHours: 3,
      lateHours: 0,
      totalHours: 3,
      isLate: false,
    });
  });

  it('reads a 00:00 threshold as midnight, not as noon ago', () => {
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

  it('keeps a threshold equal to the start same-day, so it is late from the first minute', () => {
    // A rest-day tier whose late threshold matches the shift end exactly. The
    // comparison is strict, so this must NOT roll forward.
    const r = splitOvertimeHours(
      d('2026-08-30T17:00:00'),
      d('2026-08-30T22:00:00'),
      true,
      23 * 60 + 59,
      5 * 60,
      17 * 60,
    );
    expect(r).toMatchObject({
      doubleHours: 0,
      doubleLateHours: 5,
      totalHours: 5,
      isLate: true,
    });
  });

  it('still splits normally for an afternoon threshold after the start', () => {
    const r = splitOvertimeHours(
      d('2026-08-28T17:00:00'),
      d('2026-08-28T23:00:00'),
      false,
      22 * 60,
      EOD,
    );
    expect(r).toMatchObject({ regularHours: 5, lateHours: 1, isLate: true });
  });

  it('treats a 17:00-22:00 weekday window against a 23:59 threshold as fully regular', () => {
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
