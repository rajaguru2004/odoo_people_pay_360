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

export const formatCurrency = (amount: number): string => {
  return formatCurrencyWithConfig(amount, activeCurrency, activeCurrencySymbol, activeCurrencyDisplay);
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

export const formatNumber = (num: number, decimals: number = 0): string => {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num);
};

// Percentage formatter
export const formatPercent = (value: number, decimals: number = 1): string => {
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
