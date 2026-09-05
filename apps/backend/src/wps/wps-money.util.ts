import { Prisma } from '@prisma/client';

/**
 * Money for wage files: integer MINOR units only.
 *
 * A wage file is checked by the bank's own arithmetic — detail rows must sum to
 * the header total exactly — so nothing in this path may touch a JS float. The
 * payroll engine's `roundMoney` (Math.round(n * 100) / 100 on a number) is
 * deliberately not reused here.
 *
 * OMR / BHD / KWD have exponent 3 (1000 baisa/fils to the major unit); AED / SAR /
 * QAR / USD / EUR have 2. Getting this wrong is precisely the failure WPS exists
 * to prevent: a 2-decimal Omani file disagrees with the bank's total.
 */
export interface WpsMoney {
  /**
   * bigint, not number: a run total in baisa can exceed Number.MAX_SAFE_INTEGER
   * (payrolls.total_amount is Decimal(18,3) ⇒ up to 1e18 minor units). Never
   * crosses the HTTP boundary — controllers format it first.
   */
  minor: bigint;
  currency: string; // ISO-4217
  exponent: number; // minor units per major = 10 ** exponent
}

/** Thrown when a stored amount cannot be expressed in the currency's minor units. */
export class WpsPrecisionError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
    readonly currency: string,
    readonly exponent: number,
  ) {
    super(
      `${field}=${value} cannot be expressed in ${currency} minor units (exponent ${exponent}) without rounding`,
    );
    this.name = 'WpsPrecisionError';
  }
}

/** Minor-unit exponent per ISO-4217 code. Currencies not listed default to 2. */
const CURRENCY_EXPONENTS: Record<string, number> = {
  OMR: 3,
  BHD: 3,
  KWD: 3,
  TND: 3,
  IQD: 3,
  JOD: 3,
  LYD: 3,
  JPY: 0,
  KRW: 0,
  VND: 0,
};

export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENTS[(currency || '').toUpperCase()] ?? 2;
}

const TEN = new Prisma.Decimal(10);

/**
 * Convert a stored amount to minor units.
 *
 * Prisma.Decimal IS decimal.js, so this is exact — no new dependency and no float
 * anywhere. THROWS rather than rounds: if the DB holds more precision than the
 * currency allows, the file would silently disagree with the bank's arithmetic,
 * and a loud failure at generation is the only safe outcome. (A Decimal(12,2)
 * value scaled by 10^3 is always an exact integer, so this cannot fire today; it
 * is the guard that keeps the WPS path correct once the money columns widen.)
 */
export function toMinor(
  value: Prisma.Decimal | string | number | null | undefined,
  currency: string,
  exponent: number,
  field: string,
): WpsMoney {
  const d = new Prisma.Decimal(value ?? 0);
  const scaled = d.mul(TEN.pow(exponent));
  if (!scaled.isInteger()) {
    throw new WpsPrecisionError(field, d.toString(), currency, exponent);
  }
  return { minor: BigInt(scaled.toFixed(0)), currency, exponent };
}

function assertCompatible(a: WpsMoney, b: WpsMoney): void {
  if (a.currency !== b.currency || a.exponent !== b.exponent) {
    throw new Error(
      `Cannot combine ${a.currency}(${a.exponent}) with ${b.currency}(${b.exponent})`,
    );
  }
}

export function addMinor(...parts: WpsMoney[]): WpsMoney {
  if (parts.length === 0) throw new Error('addMinor needs at least one amount');
  return parts.reduce((acc, p) => {
    assertCompatible(acc, p);
    return { ...acc, minor: acc.minor + p.minor };
  });
}

export function subMinor(a: WpsMoney, b: WpsMoney): WpsMoney {
  assertCompatible(a, b);
  return { ...a, minor: a.minor - b.minor };
}

/** Sum, tolerating an empty list (returns zero in the given currency). */
export function sumMinor(
  parts: WpsMoney[],
  currency: string,
  exponent: number,
): WpsMoney {
  const zero: WpsMoney = { minor: 0n, currency, exponent };
  return parts.reduce((acc, p) => {
    assertCompatible(acc, p);
    return { ...acc, minor: acc.minor + p.minor };
  }, zero);
}

export function zeroMoney(currency: string, exponent: number): WpsMoney {
  return { minor: 0n, currency, exponent };
}

/** Decimal string with exactly `exponent` places — e.g. 123450 baisa -> "123.450". */
export function minorToFixed(m: WpsMoney): string {
  const negative = m.minor < 0n;
  const digits = (negative ? -m.minor : m.minor).toString();
  if (m.exponent === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(m.exponent + 1, '0');
  const whole = padded.slice(0, -m.exponent);
  const frac = padded.slice(-m.exponent);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * Zero-padded integer minor units — what most GCC fixed-width SIF layouts carry
 * (no decimal separator; the position implies it).
 */
export function minorToPadded(m: WpsMoney, width: number): string {
  const negative = m.minor < 0n;
  const digits = (negative ? -m.minor : m.minor).toString();
  if (digits.length > width) {
    throw new Error(
      `Amount ${minorToFixed(m)} needs ${digits.length} digits but the field is ${width} wide`,
    );
  }
  return `${negative ? '-' : ''}${digits.padStart(width, '0')}`;
}

/** For JSON responses: minor units are not safe to serialize as a JS number. */
export function moneyToJson(m: WpsMoney) {
  return {
    minor: m.minor.toString(),
    currency: m.currency,
    exponent: m.exponent,
    formatted: minorToFixed(m),
  };
}
