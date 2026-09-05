import { CURRENCY_DECIMALS, DEFAULT_CURRENCY_DECIMALS } from './constants';

/**
 * Format money.
 *
 * The decimal count comes from the CURRENCY, never from a default of 2 — see
 * the note on CURRENCY_DECIMALS. `Intl.NumberFormat` is given both a minimum
 * and a maximum so an exact amount still shows its trailing zeros: an OMR
 * payslip line reading "125.5" instead of "125.500" looks like a different
 * number to anyone reconciling it.
 */
export function formatCurrency(
  amount: number | string | null | undefined,
  currency = 'OMR',
  locale = 'en-US',
): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (value === null || value === undefined || Number.isNaN(value)) return '—';

  const digits = CURRENCY_DECIMALS[currency] ?? DEFAULT_CURRENCY_DECIMALS;

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Plain number with thousands separators. */
export function formatNumber(value: number | null | undefined, locale = 'en-US'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(locale).format(value);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** "Aisha Al Balushi" from the parts, tolerating a missing half. */
export function fullName(person?: { firstName?: string | null; lastName?: string | null } | null): string {
  if (!person) return '—';
  return [person.firstName, person.lastName].filter(Boolean).join(' ') || '—';
}

/** "AB" — the avatar fallback. */
export function initials(person?: { firstName?: string | null; lastName?: string | null } | null): string {
  if (!person) return '?';
  const first = person.firstName?.trim()?.[0] ?? '';
  const last = person.lastName?.trim()?.[0] ?? '';
  return (first + last).toUpperCase() || '?';
}

/**
 * The magnitude at which a money figure stops being printed in full.
 *
 * Below a thousand there is nothing to abbreviate — "OMR 999.500" is already
 * shorter than "OMR 999.5" would gain us — and above it the exact figure costs
 * a KPI card more width than it has. Fixed rather than measured so the same
 * amount renders identically in a test, on a phone and in a screenshot.
 */
const COMPACT_FROM = 1_000;

/** Magnitude suffixes only; the digits themselves come from `Intl`. */
function compactDigits(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    compactDisplay: 'short',
    // One decimal, and no forced trailing zero: 23.6K, but 1M rather than 1.0M.
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Money, shortened to a magnitude suffix once it is genuinely long — "OMR 23.6K"
 * for 23,567.125, "OMR 1.2M" for 1,240,000.
 *
 * Anything under `COMPACT_FROM` is handed straight to `formatCurrency`, so the
 * currency's own decimal count still rules the exact case: an OMR figure prints
 * its three thousandths, and only the magnitude — never the precision — is what
 * abbreviating gives up.
 *
 * K/M/B, not lakh/crore. The suffix idea came from a reader asking for "crore",
 * but the app's locale is `en-US` and its currencies are Gulf ones (OMR, KWD,
 * BHD); a reader here parses 23.6K on sight and would have to stop and convert
 * 2.36 lakh. The Indian grouping would also fight `Intl`'s en-US thousands
 * separators everywhere else on the same card.
 *
 * Compact notation rounds, so 999,999 prints as "OMR 1M". That is the point of
 * a compact figure — the caller is expected to keep the exact one reachable
 * (`StatCard` puts it in a `title`), because the card is a glance and the
 * reconciliation happens on the payslip.
 */
export function formatCurrencyCompact(
  amount: number | string | null | undefined,
  currency = 'OMR',
  locale = 'en-US',
): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (value === null || value === undefined || Number.isNaN(value)) return '—';

  if (Math.abs(value) < COMPACT_FROM) return formatCurrency(value, currency, locale);

  // `Intl` places the sign and the currency code itself, so a negative comes
  // back as "-OMR 1.2M" with the minus where en-US expects it.
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value);
}

/** The first number in a string: "OMR 23,567.125" → "23,567.125". */
const NUMBER_RUN = /-?\d[\d,]*(?:\.\d+)?/;

/**
 * A numeric run is only a QUANTITY if a formatter has been at it — a thousands
 * separator or a decimal point.
 *
 * Without this, a bare run of four digits is over `COMPACT_FROM` and "Jun 2026"
 * abbreviates to "Jun 2K". Hub cards really do carry period labels, run
 * references and employee codes in the same slot as money, so the shortener has
 * to be able to tell a magnitude from an identifier, and the punctuation the
 * formatter added is the only evidence in the string that it was ever a sum.
 * The cost is that a raw "1234567" is left long; the alternative is a card that
 * silently renames a year.
 */
const FORMATTED_QUANTITY = /[,.]/;

/**
 * Shorten a figure that has ALREADY been formatted — "OMR 23,567.125" becomes
 * "OMR 23.6K", "1,234,567" becomes "1.2M".
 *
 * `KpiStat.value` reaches a card as a finished string: the hub that built it
 * knew the currency and this component does not, and that contract is shared
 * with other callers so it cannot change. This rewrites only the numeric run and
 * leaves everything around it — the currency code, the sign, a trailing `%` —
 * exactly where the original formatter put it.
 *
 * Returns the input untouched unless the FIRST number in it is a formatted
 * quantity (see `FORMATTED_QUANTITY` — "Jun 2026" is a period, not 2K), and
 * untouched again below `COMPACT_FROM`: "OMR 9,999.999" shortening to "OMR 10K"
 * rounds across the magnitude the reader is looking at, which is the one thing
 * worse than a long line.
 */
export function compactFigureText(text: string, locale = 'en-US'): string {
  const match = NUMBER_RUN.exec(text);
  if (!match || !FORMATTED_QUANTITY.test(match[0])) return text;

  const value = Number(match[0].replace(/,/g, ''));
  if (Number.isNaN(value) || Math.abs(value) < COMPACT_FROM) return text;

  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  return before + compactDigits(value, locale) + after;
}
