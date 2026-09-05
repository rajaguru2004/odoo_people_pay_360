/**
 * Shared money rounding for the whole backend.
 *
 * Extracted verbatim from payrolls.service.ts so every module that touches
 * money cannot drift apart. A second rounding convention in a payroll codebase is how
 * you get a 1-paisa reconciliation break that nobody can trace — if you need
 * different behaviour, change it HERE and accept that payroll output moves.
 */

/**
 * Round a monetary amount to 2 decimal places (currency minor units) instead of
 * whole units. The payroll_items columns are Decimal(12,2), so 2dp is the finest
 * granularity the DB persists — this preserves cents for USD/EUR/GBP and rials
 * for OMR to 2dp (OMR's 3rd decimal / baisa is a DB-precision limitation).
 */
export const roundMoney = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/** Default minor units per major unit (paise/cents). */
export const DEFAULT_MINOR_SCALE = 100;

/**
 * Convert a major-unit amount to integer minor units.
 *
 * Instalment/amortization arithmetic runs in minor units so that
 * `sum(components) === total` is an EQUALITY, not a tolerance.
 */
export const toMinor = (n: number, scale = DEFAULT_MINOR_SCALE): number =>
  Math.round((n + Number.EPSILON) * scale);

/** Convert integer minor units back to a major-unit amount. */
export const fromMinor = (m: number, scale = DEFAULT_MINOR_SCALE): number =>
  Math.round(m) / scale;

/**
 * Money equality within half a minor unit. Never compare money with `===` after
 * a division — use this, or stay in minor units.
 */
export const moneyEquals = (
  a: number,
  b: number,
  scale = DEFAULT_MINOR_SCALE,
): boolean => Math.abs(a - b) < 0.5 / scale;
