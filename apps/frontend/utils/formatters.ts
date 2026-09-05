import { format, parseISO, formatDistanceToNow } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useBrandingStore } from '@/store/brandingStore';

// Company timezone from system settings (brandingStore). Instants (check-in/out,
// createdAt) are stored UTC and MUST render in the configured company timezone,
// not the viewer's browser timezone. Read live so it reflects the loaded setting.
export const getCompanyTz = (): string => {
  try {
    return useBrandingStore.getState().branding.system_timezone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
};

const toDate = (date: string | Date): Date =>
  typeof date === 'string' ? parseISO(date) : date;

// Active date-display format — a personal preference (Employee.dateFormat) set
// once from the loaded user (see DashboardLayout / Settings), so every
// formatDate()/formatDateTime()/formatWallClockDate() with no explicit pattern
// renders day/month/year in the order the user chose. UI tokens map to date-fns
// patterns; null/unknown falls back to DD/MM/YYYY.
export type DateFormatPref = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';
const DATE_FNS_PATTERN: Record<DateFormatPref, string> = {
  'DD/MM/YYYY': 'dd/MM/yyyy',
  'MM/DD/YYYY': 'MM/dd/yyyy',
  'YYYY-MM-DD': 'yyyy-MM-dd',
};
let activeDateFormat: DateFormatPref = 'DD/MM/YYYY';

export const setDefaultDateFormat = (fmt?: string | null): void => {
  if (fmt && fmt in DATE_FNS_PATTERN) activeDateFormat = fmt as DateFormatPref;
  else activeDateFormat = 'DD/MM/YYYY';
};

/** The active preference token (e.g. 'DD/MM/YYYY'). */
export const getDateFormatPref = (): DateFormatPref => activeDateFormat;

/** The date-fns pattern for the active date-only format. */
export const getDateFnsPattern = (): string => DATE_FNS_PATTERN[activeDateFormat];

/** Order pre-formatted day/month/year parts per the active preference. */
const orderDateParts = (day: string, month: string, year: string): string => {
  switch (activeDateFormat) {
    case 'MM/DD/YYYY':
      return `${month}/${day}/${year}`;
    case 'YYYY-MM-DD':
      return `${year}-${month}-${day}`;
    default:
      return `${day}/${month}/${year}`;
  }
};

// Date formatters
export const formatDate = (date: string | Date, pattern: string = getDateFnsPattern()): string => {
  if (!date) return '';
  const dateObj = toDate(date);
  return format(dateObj, pattern, { locale: enUS });
};

// HH:mm of a UTC instant, rendered in the company timezone.
export const formatTime = (date: string | Date, tz: string = getCompanyTz()): string => {
  if (!date) return '';
  const dateObj = toDate(date);
  if (isNaN(dateObj.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  }).format(dateObj);
};

// Overtime (and other shift-window) start/end times are stored as tz-NAIVE
// wall-clock tagged UTC — e.g. an entered 17:00 is persisted as "...T17:00:00Z"
// — because the backend classification engine and demo seed read the raw
// wall-clock hour. They are NOT real instants, so they must be rendered back in
// UTC to echo exactly the wall-clock the employee typed (which is, by
// convention, the global company timezone). Rendering them with a tz offset
// double-shifts and is the classic "time drifts after submit" bug.
export const formatWallClockTime = (date: string | Date): string => {
  if (!date) return '';
  const d = toDate(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
};

export const formatWallClockDate = (date: string | Date): string => {
  if (!date) return '';
  const d = toDate(date);
  if (isNaN(d.getTime())) return '';
  // Echo the stored calendar day (UTC, no tz shift) in the user's chosen order.
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return orderDateParts(p('day'), p('month'), p('year'));
};

// dd/MM/yyyy HH:mm of a UTC instant, rendered in the company timezone.
export const formatDateTime = (date: string | Date, tz: string = getCompanyTz()): string => {
  if (!date) return '';
  const dateObj = toDate(date);
  if (isNaN(dateObj.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  }).formatToParts(dateObj);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${orderDateParts(p('day'), p('month'), p('year'))} ${p('hour')}:${p('minute')}`;
};

export const formatRelativeTime = (date: string | Date): string => {
  if (!date) return '';
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return formatDistanceToNow(dateObj, { addSuffix: true, locale: enUS });
};

// Currency formatters
//
// The active payroll currency is a single global system setting (one tenant =
// one payroll currency). We keep it in module-level state so every existing
// `formatCurrency(amount)` call site renders the configured currency/symbol
// without threading config through hundreds of call sites. Set it once, early,
// from the loaded system settings (see DashboardLayout).
let activeCurrency = 'INR';
let activeCurrencySymbol = '₹';
// 'symbol' → prefix the glyph (₹1,234); 'code' → prefix the ISO code (INR 1,234).
// Admin-selectable in Payroll Settings; applies to every formatCurrency() call.
export type CurrencyDisplay = 'symbol' | 'code';
let activeCurrencyDisplay: CurrencyDisplay = 'symbol';

export const setDefaultCurrency = (
  currency?: string,
  currencySymbol?: string,
  display?: string,
): void => {
  if (currency) activeCurrency = currency;
  if (currencySymbol) activeCurrencySymbol = currencySymbol;
  if (display === 'symbol' || display === 'code') activeCurrencyDisplay = display;
};

/** The active payroll currency symbol (e.g. '₹', 'ر.ع.'). For custom prefixing. */
export const getCurrencySymbol = (): string => activeCurrencySymbol;

/** The active payroll ISO currency code (e.g. 'INR', 'OMR'). */
export const getCurrencyCode = (): string => activeCurrency;

/** The active display mode ('symbol' | 'code'). */
export const getCurrencyDisplay = (): CurrencyDisplay => activeCurrencyDisplay;

/**
 * The active currency prefix per the display mode: the symbol ('₹') or the ISO
 * code ('INR'). Use for custom/abbreviated renders so they follow the setting.
 */
export const getCurrencyPrefix = (): string =>
  activeCurrencyDisplay === 'code' ? activeCurrency : activeCurrencySymbol;

/**
 * Amount with the active currency prefix and locale grouping, but WITHOUT the
 * Intl currency fraction rules — for compact/custom renders (e.g. "₹1,23,456"
 * or abbreviated "INR 1.2M"). Prefer formatCurrency() for normal amounts.
 */
export const formatAmountWithSymbol = (amount: number, maximumFractionDigits = 0): string => {
  const prefix = getCurrencyPrefix();
  const sep = activeCurrencyDisplay === 'code' ? ' ' : '';
  return `${prefix}${sep}${new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(amount)}`;
};

/**
 * Money, using the system-settings currency.
 *
 * `currency` is an optional override for callers that already know the currency
 * of the figure they hold — a payroll run carries its own, and the dashboard
 * charts read it off the response rather than off global settings. Omitted, the
 * configured currency applies, so every existing caller is unaffected.
 */
export const formatCurrency = (
  amount: number | string | null | undefined,
  currency?: string,
): string => {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return currency
    ? formatCurrencyWithConfig(value, currency, currency, 'code')
    : formatCurrencyWithConfig(value, activeCurrency, activeCurrencySymbol, activeCurrencyDisplay);
};

/**
 * Config-aware currency formatter.
 * Uses the currency code from system settings for proper Intl formatting.
 * In 'code' mode renders the ISO code (INR 1,234); in 'symbol' mode replaces the
 * Intl-generated symbol with the configured custom symbol (₹1,234).
 * Falls back to INR / ₹ / symbol-mode if no config is provided.
 */
export const formatCurrencyWithConfig = (
  amount: number,
  currency: string = 'INR',
  currencySymbol: string = '₹',
  display: CurrencyDisplay = 'symbol',
): string => {
  try {
    const formatted = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency,
      currencyDisplay: display === 'code' ? 'code' : 'symbol',
    }).format(amount);
    if (display === 'code') {
      // Intl already prefixes the ISO code (e.g. "INR 1,234.00"); leave as-is.
      return formatted;
    }
    // Replace whatever symbol Intl generated with the admin-configured symbol
    return formatted.replace(/^[^\d\s\-]+/, currencySymbol);
  } catch {
    // Fallback for unknown currency codes
    const prefix = display === 'code' ? `${currency} ` : currencySymbol;
    return `${prefix}${new Intl.NumberFormat('en-IN').format(amount)}`;
  }
};

export const formatNumber = (
  num: number | null | undefined,
  decimals: number = 0,
): string => {
  // An absent figure is not zero. A dashboard tile reading "0" where nothing was
  // measured is a claim about the data; the em dash says we have none.
  if (num === null || num === undefined || Number.isNaN(num)) return '—';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num);
};

// Percentage formatter
export const formatPercent = (
  value: number | null | undefined,
  decimals: number = 1,
): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${formatNumber(value, decimals)}%`;
};

// Phone formatter
export const formatPhone = (phone: string): string => {
  if (!phone) return '';
  // Format: 0123 456 789
  return phone.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3');
};

// ID Card formatter
export const formatIdCard = (idCard: string): string => {
  if (!idCard) return '';
  // Format: 001 234 567 890
  return idCard.replace(/(\d{3})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4');
};

// File size formatter
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};

// Work hours formatter
export const formatWorkHours = (hours: number): string => {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};

// Month/Year formatter
export const formatMonthYear = (month: number, year: number): string => {
  return `Month ${month}/${year}`;
};

// ---------------------------------------------------------------------------
// Dashboard / payroll-analytics helpers.
//
// Ported with the dashboard visuals. They are additive: nothing above changed
// behaviour, so every existing caller of this module is unaffected.
// ---------------------------------------------------------------------------

/** "Aisha Al Balushi" from the parts, tolerating a missing half. */
export const fullName = (
  person?: { firstName?: string | null; lastName?: string | null } | null,
): string => {
  if (!person) return '—';
  return [person.firstName, person.lastName].filter(Boolean).join(' ') || '—';
};

/** "AB" — the avatar fallback. */
export const initials = (
  person?: { firstName?: string | null; lastName?: string | null } | null,
): string => {
  if (!person) return '?';
  const first = person.firstName?.trim()?.[0] ?? '';
  const last = person.lastName?.trim()?.[0] ?? '';
  return (first + last).toUpperCase() || '?';
};

/**
 * The magnitude at which a money figure stops being printed in full.
 *
 * Below a thousand there is nothing to abbreviate, and above it the exact
 * figure costs a KPI card more width than it has. Fixed rather than measured so
 * the same amount renders identically in a test, on a phone and in a screenshot.
 */
const COMPACT_FROM = 1_000;

/** Magnitude suffixes only; the digits themselves come from `Intl`. */
const compactDigits = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    notation: 'compact',
    compactDisplay: 'short',
    // One decimal, and no forced trailing zero: 23.6K, but 1M rather than 1.0M.
    maximumFractionDigits: 1,
  }).format(value);

/**
 * Money, shortened to a magnitude suffix once it is genuinely long — "23.6K"
 * for 23,567, "1.2M" for 1,240,000.
 *
 * Anything under `COMPACT_FROM` is handed straight to `formatCurrency`, so the
 * exact case keeps the configured currency's own formatting: only the
 * magnitude, never the precision, is what abbreviating gives up.
 *
 * Compact notation rounds, so 999,999 prints as "1M". That is the point of a
 * compact figure — the caller is expected to keep the exact one reachable
 * (`StatCard` puts it in a `title`), because the card is a glance and the
 * reconciliation happens on the payslip.
 */
export const formatCurrencyCompact = (
  amount: number | string | null | undefined,
  currency?: string,
  locale = 'en-US',
): string => {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (Math.abs(value) < COMPACT_FROM) return formatCurrency(value, currency);

  // A code always wants a space after it ("INR 1.2M"); a glyph never does ("₹1.2M").
  const prefix = currency
    ? `${currency} `
    : activeCurrencyDisplay === 'code'
      ? `${activeCurrency} `
      : activeCurrencySymbol;
  return `${prefix}${compactDigits(value, locale)}`;
};

/** The first number in a string: "INR 23,567.12" → "23,567.12". */
const NUMBER_RUN = /-?\d[\d,]*(?:\.\d+)?/;

/**
 * A numeric run is only a QUANTITY if a formatter has been at it — a thousands
 * separator or a decimal point.
 *
 * Without this, a bare run of four digits is over `COMPACT_FROM` and "Jun 2026"
 * abbreviates to "Jun 2K". Hub cards really do carry period labels, run
 * references and employee codes in the same slot as money, so the shortener has
 * to tell a magnitude from an identifier, and the punctuation the formatter
 * added is the only evidence in the string that it was ever a sum.
 */
const FORMATTED_QUANTITY = /[,.]/;

/**
 * Shorten a figure that has ALREADY been formatted — "INR 23,567.12" becomes
 * "INR 23.6K", "1,234,567" becomes "1.2M".
 *
 * `KpiStat.value` reaches a card as a finished string: the hub that built it
 * knew the currency and the card does not. This rewrites only the numeric run
 * and leaves everything around it — the currency code, the sign, a trailing
 * `%` — exactly where the original formatter put it.
 */
export const compactFigureText = (text: string, locale = 'en-US'): string => {
  const match = NUMBER_RUN.exec(text);
  if (!match || !FORMATTED_QUANTITY.test(match[0])) return text;

  const value = Number(match[0].replace(/,/g, ''));
  if (Number.isNaN(value) || Math.abs(value) < COMPACT_FROM) return text;

  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  return before + compactDigits(value, locale) + after;
};
