import { format, formatDistanceToNow, isPast, isFuture } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { DateTime } from 'luxon';

export function formatDate(date: string | Date, formatStr: string = 'PPP'): string {
  return format(new Date(date), formatStr, { locale: enUS });
}

export function formatDateTime(date: string | Date): string {
  return format(new Date(date), 'PPP p', { locale: enUS });
}

export function formatTime(date: string | Date): string {
  return format(new Date(date), 'p', { locale: enUS });
}

export function formatRelativeTime(date: string | Date): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale: enUS });
}

export function isDatePast(endTime: string | Date): boolean {
  return isPast(new Date(endTime));
}

export function isDateUpcoming(startTime: string | Date): boolean {
  return isFuture(new Date(startTime));
}

export function getDateStatus(startTime: string | Date, endTime: string | Date): 'upcoming' | 'ongoing' | 'completed' {
  const now = new Date();
  const start = new Date(startTime);
  const end = new Date(endTime);

  if (now < start) return 'upcoming';
  if (now >= start && now <= end) return 'ongoing';
  return 'completed';
}

/**
 * A date-only value — hire date, period start — rendered WITHOUT zone conversion.
 *
 * `2026-01-15` is a calendar day, not an instant. Putting it through
 * `new Date(...)` makes it midnight UTC, which is the 14th anywhere west of
 * Greenwich; the day the reader is shown then disagrees with the day stored.
 * Only the `YYYY-MM-DD` head of the string is read, and it is read in UTC, so
 * the calendar day survives the trip intact.
 *
 * An absent value is an em dash, never today's date.
 */
export function formatDateOnly(
  value: string | Date | null | undefined,
  pattern = 'dd/MM/yyyy',
): string {
  if (!value) return '—';
  const iso = typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  const dt = DateTime.fromISO(iso, { zone: 'utc' });
  return dt.isValid ? dt.toFormat(pattern) : '—';
}
