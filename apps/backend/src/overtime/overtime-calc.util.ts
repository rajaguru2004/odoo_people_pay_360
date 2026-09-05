/**
 * Overtime hour splitting, and the day-boundary clamp.
 *
 * A request is not paid at a single tier. The worked window is split at the
 * late-OT threshold so each portion is paid at its own rate:
 *
 *   shift end 17:00, late threshold 22:00, worked until 23:00
 *     → 17:00–22:00 = 5h @ the regular multiplier
 *     → 22:00–23:00 = 1h @ the late multiplier
 *
 * The window is CLAMPED to the configured attendance day boundary first:
 * overtime is counted up to the close of that attendance day and never past it,
 * so a shift somebody forgot to close does not bill twenty hours.
 *
 * All arithmetic is UTC wall-clock. Overtime start and end are stored tz-naive
 * tagged UTC — an entered 17:00 is persisted as "…T17:00:00Z" — so reading them
 * with UTC getters recovers the entered hour whatever the server's own zone is.
 * Local getters would drift by the server offset: on +05:30, 17:00 reads as
 * 22:30 and every evening shift is classified as late.
 *
 * Deliberately free of Prisma and Nest. These are the rules, and rules that can
 * only be exercised through a database and an injector do not get exercised.
 */

export interface OvertimeSplit {
  /** Hours before the late threshold (weekday tier). 0 on a double-OT day. */
  regularHours: number;
  /** Hours from the late threshold on (weekday tier). 0 on a double-OT day. */
  lateHours: number;
  /** Double-tier hours before the double late threshold. 0 on a weekday. */
  doubleHours: number;
  /** Double-tier hours from that threshold on. 0 on a weekday. */
  doubleLateHours: number;
  /** The payable total after clamping. */
  totalHours: number;
  /** Where the window actually ends once the boundary is applied. */
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
const NOON_MINUTES = 720;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The instant the attendance day anchored on `start` closes.
 *
 * The noon rule: a boundary time before 12:00 is an early-MORNING clock time,
 * which on an evening shift means the coming midnight and after — so it belongs
 * to the NEXT calendar day. A boundary of "02:00" closes the day at two in the
 * morning tomorrow, and an overnight shift is still counted inside the
 * attendance day it started in.
 */
export function dayBoundaryInstant(start: Date, boundaryMinutes: number): Date {
  const b = atMinutes(start, boundaryMinutes);
  if (boundaryMinutes < NOON_MINUTES) {
    b.setUTCDate(b.getUTCDate() + 1);
  }
  return b;
}

/**
 * The instant a late-OT threshold fires for a window anchored on `start`.
 *
 * The SAME noon rule as the day boundary, and for a reason that has already cost
 * money once. Without it, an administrator who stores an AM time meaning a PM
 * one pays EVERY evening hour at the late multiplier: `atMinutes` puts a "00:00"
 * threshold behind the overtime start, the regular tier collapses to zero hours,
 * and `isLate` is true from the first minute.
 *
 * The rule is keyed on noon and NOT on "is the threshold before the start" — a
 * 22:00 threshold with a 22:30 start is genuinely late overtime and must stay
 * same-day. The limitation it accepts: a shift that really does end before noon
 * cannot express a pre-noon late threshold.
 */
function lateThresholdInstant(start: Date, thresholdMinutes: number): Date {
  return dayBoundaryInstant(start, thresholdMinutes);
}

/**
 * Split a worked window into per-tier hours, clamped to the day boundary.
 *
 * @param start                  worked-from instant
 * @param end                    worked-until instant (may cross midnight)
 * @param isDoubleDay            rest day or public holiday — the window is split across the double tiers
 * @param lateThresholdMin       weekday late-OT threshold, minutes past midnight (22:00 → 1320)
 * @param dayBoundaryMin         attendance day boundary, minutes past midnight (23:59 → 1439)
 * @param doubleLateThresholdMin double-day late threshold; defaults to the weekday one
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

  // Nothing left after clamping: the window began at or after the boundary.
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
    // A double day splits at ITS OWN late threshold into a before-tier and an
    // after-tier, mirroring the weekday split so each portion carries its own
    // multiplier rather than the whole rest day being paid at one rate.
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

/**
 * "HH:MM" as minutes past midnight.
 *
 * A malformed value falls back to `fallbackMinutes` rather than to NaN: NaN
 * propagates through the whole split and produces a request with no hours at
 * all, which reads on screen as "you worked nothing" instead of as a
 * misconfiguration.
 */
export function parseThresholdMinutes(
  value: string | null | undefined,
  fallbackMinutes = 22 * 60,
): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((value ?? '').trim());
  if (!m) return fallbackMinutes;
  return Number(m[1]) * 60 + Number(m[2]);
}
