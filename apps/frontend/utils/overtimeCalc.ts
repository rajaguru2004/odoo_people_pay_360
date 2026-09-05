/**
 * Frontend mirror of the backend overtime engine
 * (apps/backend/src/overtime/overtime-calc.util.ts + overtime.service.ts food
 * logic). Kept in sync so the "Overtime Calculation Preview" on the request
 * form shows exactly what the server will persist: boundary-clamped payable
 * hours, per-tier split (regular/late/double), otType, and food allowance.
 *
 * All arithmetic is done in UTC wall-clock, matching the backend engine and the
 * storage convention (OT times are tz-naive wall-clock tagged UTC, e.g. an
 * entered 17:00 is "...T17:00:00Z"). Callers MUST pass Dates whose UTC
 * wall-clock is the intended time — i.e. parse form inputs as `${date}T${time}Z`.
 */

const MS_PER_HOUR = 1000 * 60 * 60;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type OtType = 'REGULAR' | 'LATE' | 'DOUBLE' | 'DOUBLE_LATE';

export interface OvertimeConfigLite {
  regularRate: number;
  lateRate: number;
  doubleRate: number;
  doubleOtEnabled: boolean;
  lateThresholdMinutes: number;
  dayBoundaryMinutes: number;
  foodAllowanceEnabled: boolean;
  foodAllowanceThresholdMinutes: number;
  foodAllowanceAmount: number;
  doubleFoodAllowanceAnyTime: boolean;
}

export interface OvertimePreview {
  /** Payable hours after clamping to the day boundary. */
  totalHours: number;
  regularHours: number;
  lateHours: number;
  doubleHours: number;
  otType: OtType;
  isLate: boolean;
  /** True when the raw end was trimmed by the attendance day boundary. */
  clampedByBoundary: boolean;
  foodAllowance: number;
  /** Rate multiplier headline for the dominant tier (display only). */
  rateMultiplier: number;
}

/** "HH:MM" -> minutes past midnight, defaulting to `fallbackMin` on bad input. */
export function parseThresholdMinutes(value: string, fallbackMin: number): number {
  // An empty or absent value must fall back, not read as midnight. `Number('')`
  // is 0 rather than NaN, so the isNaN guard alone never fired for it and a
  // blank setting silently made every minute of overtime "late".
  if (!value?.trim()) return fallbackMin;
  const [h, m] = value.split(':').map(Number);
  if (isNaN(h)) return fallbackMin;
  return h * 60 + (isNaN(m) ? 0 : m);
}

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

/**
 * The instant the attendance day (anchored on `start`) closes. Noon rule: a
 * boundary before 12:00 belongs to the NEXT calendar day so an evening/overnight
 * shift is still counted within the same attendance day.
 */
export function dayBoundaryInstant(start: Date, boundaryMinutes: number): Date {
  const b = atMinutes(start, boundaryMinutes);
  if (boundaryMinutes < 720) {
    b.setUTCDate(b.getUTCDate() + 1);
  }
  return b;
}

/**
 * Compute the full payable overtime preview for a worked window.
 * `end` may be chronologically before `start` (overnight, same calendar date):
 * it is rolled forward one day before any clamping, mirroring the service.
 */
export function computeOvertimePreview(
  start: Date,
  rawEnd: Date,
  isDoubleDay: boolean,
  cfg: OvertimeConfigLite,
): OvertimePreview {
  let end = rawEnd;
  if (end <= start) {
    end = new Date(end.getTime() + 24 * MS_PER_HOUR);
  }

  const boundary = dayBoundaryInstant(start, cfg.dayBoundaryMinutes);
  const clampedByBoundary = end.getTime() > boundary.getTime();
  const effectiveEnd = clampedByBoundary ? boundary : end;

  const empty: OvertimePreview = {
    totalHours: 0,
    regularHours: 0,
    lateHours: 0,
    doubleHours: 0,
    otType: 'REGULAR',
    isLate: false,
    clampedByBoundary,
    foodAllowance: 0,
    rateMultiplier: cfg.regularRate,
  };

  if (effectiveEnd.getTime() <= start.getTime()) return empty;

  // Noon rule, same as the day boundary: a late threshold before 12:00 is an
  // early-morning clock time and belongs to the NEXT calendar day. Without it
  // an AM time stored for a PM one ("11:59" for 11:59 PM, "00:00" for midnight)
  // sits behind the overtime start, the regular tier collapses, and every hour
  // reads late. Mirrors lateThresholdInstant() in the backend calc util.
  const threshold = atMinutes(start, cfg.lateThresholdMinutes);
  if (cfg.lateThresholdMinutes < 720) {
    threshold.setUTCDate(threshold.getUTCDate() + 1);
  }
  const totalHours = round2((effectiveEnd.getTime() - start.getTime()) / MS_PER_HOUR);
  const isLate = effectiveEnd.getTime() > threshold.getTime();

  let regularHours = 0;
  let lateHours = 0;
  let doubleHours = 0;
  let otType: OtType;
  let rateMultiplier: number;

  if (isDoubleDay) {
    doubleHours = totalHours;
    otType = isLate ? 'DOUBLE_LATE' : 'DOUBLE';
    rateMultiplier = cfg.doubleRate;
  } else {
    const regularEnd = Math.min(effectiveEnd.getTime(), threshold.getTime());
    regularHours = round2(Math.max(0, (regularEnd - start.getTime()) / MS_PER_HOUR));
    lateHours = round2(totalHours - regularHours);
    otType = isLate ? 'LATE' : 'REGULAR';
    // Headline the higher tier when the split spans both.
    rateMultiplier = lateHours > 0 ? cfg.lateRate : cfg.regularRate;
  }

  // Food allowance: driven by its own threshold, evaluated against the
  // boundary-clamped effective end (mirrors overtime.service.ts).
  const foodThresholdInstant = atMinutes(start, cfg.foodAllowanceThresholdMinutes);
  const isPastFoodThreshold = effectiveEnd.getTime() > foodThresholdInstant.getTime();

  let foodAllowance = 0;
  if (cfg.foodAllowanceEnabled && totalHours > 0) {
    if (isDoubleDay) {
      if (isPastFoodThreshold || cfg.doubleFoodAllowanceAnyTime) {
        foodAllowance = cfg.foodAllowanceAmount;
      }
    } else if (isPastFoodThreshold) {
      foodAllowance = cfg.foodAllowanceAmount;
    }
  }

  return {
    totalHours,
    regularHours,
    lateHours,
    doubleHours,
    otType,
    isLate,
    clampedByBoundary,
    foodAllowance,
    rateMultiplier,
  };
}
