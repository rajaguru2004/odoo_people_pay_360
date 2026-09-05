import { DateTime } from 'luxon';
import { DATE_FORMAT, DATETIME_FORMAT } from './constants';

/**
 * Format an instant in a named zone.
 *
 * The zone is an explicit argument rather than an implicit "whatever this
 * browser is set to". A payroll cut-off or a shift start read in the viewer's
 * local zone rather than the company's is a date that is simply wrong for
 * anyone travelling or working remotely, and it is wrong silently.
 */
export function formatDate(
  value: string | Date | null | undefined,
  zone = 'Asia/Muscat',
  pattern = DATE_FORMAT,
): string {
  if (!value) return '—';
  const dt =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone })
      : DateTime.fromISO(value, { zone });
  return dt.isValid ? dt.toFormat(pattern) : '—';
}

export function formatDateTime(
  value: string | Date | null | undefined,
  zone = 'Asia/Muscat',
): string {
  return formatDate(value, zone, DATETIME_FORMAT);
}

/** "3 days ago". Returns '—' for anything unparseable rather than "Invalid DateTime". */
export function formatRelative(value: string | Date | null | undefined, zone = 'Asia/Muscat'): string {
  if (!value) return '—';
  const dt =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone })
      : DateTime.fromISO(value, { zone });
  return dt.isValid ? dt.toRelative() ?? '—' : '—';
}

/**
 * A DATE-ONLY value (hire date, period start) rendered without a zone shift.
 *
 * `2026-01-15` parsed as an instant is midnight UTC, which is the 14th in any
 * zone west of Greenwich. A hire date has no time of day, so it must never be
 * put through a zone conversion at all.
 */
export function formatDateOnly(value: string | null | undefined, pattern = DATE_FORMAT): string {
  if (!value) return '—';
  const dt = DateTime.fromISO(value.slice(0, 10), { zone: 'utc' });
  return dt.isValid ? dt.toFormat(pattern) : '—';
}
