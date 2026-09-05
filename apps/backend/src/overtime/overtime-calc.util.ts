/**
 * Splitting an overtime window into pay tiers, and clamping it to the
 * attendance day.
 *
 * A request is not paid at one rate. The worked window is cut at the late-OT
 * threshold so each portion earns its own multiplier:
 *
 *   shift end 17:00, late threshold 22:00, worked until 23:00
 *     → 17:00–22:00  = 5h  @ regularRate
 *     → 22:00–23:00  = 1h  @ lateRate
 *
 * The window is CLAMPED first, to the configured attendance day boundary:
 * overtime counts up to the close of that attendance day and never past it.
 *
 * All arithmetic is UTC wall-clock. Overtime start and end are stored zone-naive
 * but tagged UTC — an entered 17:00 is persisted as "...T17:00:00Z" — so reading
 * them with UTC getters recovers exactly the hour that was typed on any server.
 * Local getters would drift by the host's offset, turning 17:00 into 22:30 on a
 * +5:30 machine.
 */

export interface OvertimeSplit {
  /** Hours before the late threshold (weekday tier). 0 on a double-OT day. */
  regularHours: number;
  /** Hours from the late threshold onward (weekday tier). 0 on a double-OT day. */
  lateHours: number;
  /** Double-tier hours before the double late threshold (rest day / holiday). 0 on a weekday. */
  doubleHours: number;
  /** Double-tier hours from the double late threshold onward. 0 on a weekday. */
  doubleLateHours: number;
  /** The payable total after clamping. */
  totalHours: number;
  /** Effective end after clamping to the day boundary. */
  effectiveEnd: Date;
  /** Whether the effective end reached or passed the late threshold. */
  isLate: boolean;
  /** True when the raw end was trimmed by the day boundary. */
  clampedByBoundary: boolean;
}

/** A UTC wall-clock instant on `anchor`'s date at `minutesPastMidnight`. */
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
 * It uses the SAME noon rule as {@link dayBoundaryInstant}: a threshold before
 * 12:00 is an early-morning clock time, which on an evening shift means the
 * coming midnight and after, so it belongs to the NEXT calendar day.
 *
 * The rule is what stops an AM/PM slip in the stored threshold from repricing
 * an entire evening. Written as an AM time — "11:59" meaning 11:59 PM, or
 * "00:00" meaning midnight — a naive reading puts the threshold BEHIND the
 * overtime start: the regular tier collapses to zero hours and every minute
 * bills at the late multiplier.
 *
 * It keys on noon and deliberately NOT on "is the threshold before the start" —
 * a 22:00 threshold with a 22:30 start is genuinely late overtime and has to
 * stay same-day. The limitation it accepts, shared with `dayBoundaryInstant`,
 * is that a shift genuinely ending before noon cannot express a pre-noon
 * threshold.
 */
function lateThresholdInstant(start: Date, thresholdMinutes: number): Date {
  return dayBoundaryInstant(start, thresholdMinutes);
}

/**
 * The instant the attendance day anchored on `start` closes.
 *
 * Noon rule: a boundary before 12:00 belongs to the NEXT calendar day — 02:00
 * closes the day at two tomorrow morning — so an evening or overnight shift is
 * still counted inside the attendance day it began in.
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
 * @param start                   worked-from instant
 * @param end                     worked-until instant (may cross midnight)
 * @param isDoubleDay             rest day / public holiday — the window splits across the double tiers
 * @param lateThresholdMin        weekday late-OT threshold, minutes past midnight (22:00 → 1320)
 * @param dayBoundaryMin          attendance day boundary, minutes past midnight (23:59 → 1439)
 * @param doubleLateThresholdMin  double-day late threshold; defaults to the weekday one
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

  // Nothing survives the clamp: the window began after the day had closed.
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
    // and an after-tier, mirroring the weekday split so each portion can be
    // paid at its own multiplier.
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
  const regularHours = Math.max(
    0,
    (regularEnd - start.getTime()) / MS_PER_HOUR,
  );
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
