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
