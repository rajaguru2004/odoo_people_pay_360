import { DateTime } from 'luxon';
import { TIME_FORMAT } from '@/utils/constants';
import type { OtType, OvertimeStatus } from '@/types/overtime';

/**
 * The vocabulary every overtime screen shares.
 *
 * Pure on purpose: a status tone, an OT-type label and the arithmetic of a
 * worked window are decisions four screens have to make identically, and the
 * moment one of them inlines its own the pages start disagreeing about what a
 * claim says.
 */

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export const OVERTIME_STATUS_TONE: Record<OvertimeStatus, Tone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
};

/** `PENDING` → "Pending". A column of shouting enums is not a table anyone reads. */
export function overtimeStatusLabel(status: OvertimeStatus | string): string {
  const words = String(status).toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const OT_TYPE_LABEL: Record<OtType, string> = {
  REGULAR: 'Regular',
  LATE: 'Late OT',
  DOUBLE: 'Double OT',
  DOUBLE_LATE: 'Double late OT',
};

export const OT_TYPE_TONE: Record<OtType, Tone> = {
  REGULAR: 'info',
  LATE: 'warning',
  DOUBLE: 'error',
  DOUBLE_LATE: 'error',
};

/** An absent type reads as REGULAR — that is what the server defaults it to. */
export function otTypeLabel(otType?: OtType | null): string {
  return OT_TYPE_LABEL[otType ?? 'REGULAR'] ?? OT_TYPE_LABEL.REGULAR;
}

export function otTypeTone(otType?: OtType | null): Tone {
  return OT_TYPE_TONE[otType ?? 'REGULAR'] ?? 'info';
}

/**
 * The clock face of an overtime timestamp.
 *
 * These instants are stored tz-naive and tagged `Z`, so reading them back in
 * UTC is what recovers the hour that was typed. Rendered in the viewer's own
 * zone instead, an 17:00 claim filed in Muscat reads as 13:00 in London — the
 * same row saying two different things about when somebody worked.
 */
export function formatWallClockTime(value: string | null | undefined): string {
  if (!value) return '—';
  const dt = DateTime.fromISO(value, { zone: 'utc' });
  return dt.isValid ? dt.toFormat(TIME_FORMAT) : '—';
}

/** "18:00 – 21:00", or an em dash when either end is missing. */
export function formatWallClockRange(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start || !end) return '—';
  return `${formatWallClockTime(start)} – ${formatWallClockTime(end)}`;
}

/** "2.5h". Prisma sends a Decimal as a string, so both shapes arrive here. */
export function formatOvertimeHours(hours: number | string | null | undefined): string {
  if (hours === null || hours === undefined || hours === '') return '—';
  const value = Number(hours);
  if (Number.isNaN(value)) return '—';
  // Trailing `.0` dropped: "3h" reads as a shift, "3.0h" reads as a measurement.
  return `${Number(value.toFixed(2))}h`;
}

export interface OvertimeWindow {
  startIso: string;
  endIso: string;
  hours: number;
}

/**
 * The instants and the duration behind a day plus two clock times.
 *
 * An end at or before the start is an OVERNIGHT shift — 22:00 to 02:00 is four
 * hours of night work — so the end rolls forward a day rather than being
 * refused. Identical times are the one case that can never mean anything: with
 * the roll-forward they would file a 24-hour claim for a shift nobody worked,
 * which is why the form rejects them before ever calling this.
 *
 * The result is tagged `Z` without a zone conversion, matching how the server
 * stores the window: what was typed is what is read back.
 */
export function buildOvertimeWindow(
  date: string,
  startTime: string,
  endTime: string,
): OvertimeWindow {
  const start = DateTime.fromISO(`${date}T${startTime}`, { zone: 'utc' });
  let end = DateTime.fromISO(`${date}T${endTime}`, { zone: 'utc' });

  if (!start.isValid || !end.isValid) {
    return { startIso: '', endIso: '', hours: 0 };
  }

  if (end <= start) end = end.plus({ days: 1 });

  const hours = Math.round(end.diff(start, 'hours').hours * 10) / 10;

  return {
    startIso: `${date}T${startTime}:00Z`,
    endIso: `${end.toFormat('yyyy-MM-dd')}T${endTime}:00Z`,
    hours,
  };
}
