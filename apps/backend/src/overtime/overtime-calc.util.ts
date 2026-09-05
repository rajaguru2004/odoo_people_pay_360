/**
 * Overtime hour splitting + attendance-day-boundary clamping.
 *
 * The whole request is no longer paid at a single tier. Instead the worked
 * window is split at the late-OT threshold so each portion is paid at its own
 * rate:
 *
 *   shift end 17:00, late threshold 22:00, worked until 23:00
 *     → 17:00–22:00  = 5h  @ regularRate
 *     → 22:00–23:00  = 1h  @ lateRate
 *
 * The window is first CLAMPED to the configured attendance day boundary
 * (attendance_day_end_time): overtime is only counted up to the boundary of
 * that attendance day and never beyond it.
 *
 * All arithmetic is done in UTC wall-clock. Overtime start/end are stored as
 * tz-naive wall-clock tagged UTC (an entered 17:00 is persisted as
 * "...T17:00:00Z"), so reading them with UTC getters recovers exactly the
 * entered hour regardless of the server's own timezone. (Reading with local
 * getters would drift by the server offset — e.g. +5:30 turns 17:00 into 22:30.)
 */

export interface OvertimeSplit {
  /** Hours before the late threshold (weekday tier). 0 on a double-OT day. */
  regularHours: number;
  /** Hours from the late threshold onward (weekday tier). 0 on a double-OT day. */
  lateHours: number;
  /** Double-tier hours before the double late threshold (Sunday/holiday). 0 on a weekday. */
  doubleHours: number;
  /** Double-tier hours from the double late threshold onward (Sunday/holiday). 0 on a weekday. */
  doubleLateHours: number;
  /** regularHours + lateHours + doubleHours (the payable total after clamping). */
  totalHours: number;
  /** Effective end after clamping to the day boundary. */
  effectiveEnd: Date;
  /** Whether the effective end reached/passed the late threshold. */
  isLate: boolean;
  /** True when the raw end was trimmed by the day boundary. */
  clampedByBoundary: boolean;
}

/** Build a UTC wall-clock instant on `anchor`'s date at `minutesPastMidnight`. */
function atMinutes(anchor: Date, minutesPastMidnight: number): Date {
  return new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth(),
      anchor.getUTCDate(),
      Math.floor(minutesPastMidnight / 60),
      minutesPastMidnight % 60,
      0,
      0,
    ),
  );
}

const MS_PER_HOUR = 1000 * 60 * 60;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The instant a late-OT threshold fires for a window anchored on `start`.
 *
 * Uses the SAME noon rule as `dayBoundaryInstant`: a threshold before 12:00 is
 * an early-morning clock time, which on an evening shift means the coming
 * midnight-and-after, so it belongs to the NEXT calendar day.
 *
 * Without it, an admin who stores an AM time for a PM one silently pays EVERY
 * evening hour at the late multiplier: `atMinutes` puts a "11:59" (meaning
 * 11:59 PM) or "00:00" (meaning midnight) threshold behind the overtime start,
 * the regular tier collapses to zero hours, and `isLate` is true from the first
 * minute. That is the Taneka production incident of Aug 2026.
 *
 * The rule is deliberately keyed on noon and NOT on "is the threshold before
 * the start" — a 22:00 threshold with a 22:30 start is genuinely late overtime
 * and must stay same-day. Same limitation as `dayBoundaryInstant`: a shift that
 * really does end before noon cannot express a pre-noon late threshold.
 */
function lateThresholdInstant(start: Date, thresholdMinutes: number): Date {
  return dayBoundaryInstant(start, thresholdMinutes);
}

/**
 * The instant the attendance day (anchored on `start`) closes.
 * Noon rule (mirrors TimezoneService): a boundary before 12:00 belongs to the
 * NEXT calendar day (e.g. 02:00 closes the day at 02:00 tomorrow), so an
 * evening/overnight shift is still counted within the same attendance day.
 */
export function dayBoundaryInstant(start: Date, boundaryMinutes: number): Date {
  const b = atMinutes(start, boundaryMinutes);
  if (boundaryMinutes < 720) {
    b.setUTCDate(b.getUTCDate() + 1);
  }
  return b;
}

/**
 * Split a worked overtime window into per-tier hours, clamped to the day
 * boundary.
 *
 * @param start              worked-from instant
 * @param end                worked-until instant (may cross midnight)
 * @param isDoubleDay        Sunday / public holiday → the window is split across the double tiers
 * @param lateThresholdMin   weekday late-OT threshold, minutes past midnight (e.g. 22:00 → 1320)
 * @param dayBoundaryMin     attendance day boundary, minutes past midnight (e.g. 23:59 → 1439)
 * @param doubleLateThresholdMin  double-day late threshold, minutes past midnight. Defaults to
 *                                lateThresholdMin when omitted (back-compat with the weekday split).
 */
export function splitOvertimeHours(
  start: Date,
  end: Date,
  isDoubleDay: boolean,
  lateThresholdMin: number,
  dayBoundaryMin: number,
  doubleLateThresholdMin: number = lateThresholdMin,
): OvertimeSplit {
  const boundary = dayBoundaryInstant(start, dayBoundaryMin);
  const clampedByBoundary = end.getTime() > boundary.getTime();
  const effectiveEnd = clampedByBoundary ? boundary : end;

  // Guard: nothing left after clamping (end already past the boundary start).
  if (effectiveEnd.getTime() <= start.getTime()) {
    return {
      regularHours: 0,
      lateHours: 0,
      doubleHours: 0,
      doubleLateHours: 0,
      totalHours: 0,
      effectiveEnd,
      isLate: false,
      clampedByBoundary,
    };
  }

  const totalHours = (effectiveEnd.getTime() - start.getTime()) / MS_PER_HOUR;

  if (isDoubleDay) {
    // Double day: split at the double-day late threshold into a before-tier
    // (doubleHours) and an after-tier (doubleLateHours), mirroring the weekday
    // regular/late split so each portion can be paid at its own multiplier.
    const dblThreshold = lateThresholdInstant(start, doubleLateThresholdMin);
    const isLate = effectiveEnd.getTime() > dblThreshold.getTime();
    const regEnd = Math.min(effectiveEnd.getTime(), dblThreshold.getTime());
    const doubleHours = Math.max(0, (regEnd - start.getTime()) / MS_PER_HOUR);
    const doubleLateHours = totalHours - doubleHours;
    return {
      regularHours: 0,
      lateHours: 0,
      doubleHours: round2(doubleHours),
      doubleLateHours: round2(doubleLateHours),
      totalHours: round2(totalHours),
      effectiveEnd,
      isLate,
      clampedByBoundary,
    };
  }

  // Weekday: everything up to the threshold is regular, the rest is late.
  const threshold = lateThresholdInstant(start, lateThresholdMin);
  const isLate = effectiveEnd.getTime() > threshold.getTime();
  const regularEnd = Math.min(effectiveEnd.getTime(), threshold.getTime());
  const regularHours = Math.max(0, (regularEnd - start.getTime()) / MS_PER_HOUR);
  const lateHours = totalHours - regularHours;

  return {
    regularHours: round2(regularHours),
    lateHours: round2(lateHours),
    doubleHours: 0,
    doubleLateHours: 0,
    totalHours: round2(totalHours),
    effectiveEnd,
    isLate,
    clampedByBoundary,
  };
}
