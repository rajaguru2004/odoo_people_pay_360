import type { RequestStatus } from '@/types/common';
import type { OvertimeDayType, OvertimeType } from '@/types/overtime';

/**
 * The vocabulary every leave and overtime screen shares.
 *
 * Pure on purpose: a status colour, a rate and a day-type caption are decisions
 * eight screens have to make the same way, and the moment one of them inlines
 * its own `${rate}%` the pages start disagreeing about what an unknown number
 * looks like.
 */

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export const STATUS_TONE: Record<RequestStatus, Tone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  // Neutral, not error: a withdrawn request is not a refused one, and colouring
  // the two the same makes a queue look like a wall of rejections.
  CANCELLED: 'neutral',
};

/** `PENDING` → "Pending". A column of shouting enums is not a table anyone reads. */
export function statusLabel(status: RequestStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

export const DAY_TYPE_LABEL: Record<OvertimeDayType, string> = {
  WEEKDAY: 'Weekday',
  // Named for what it IS at this company rather than for the enum: the rest day
  // is Friday in Muscat, and a badge reading "Sunday" beside a Friday date is
  // the kind of thing a reader stops trusting the whole row over.
  SUNDAY: 'Rest day',
  HOLIDAY: 'Public holiday',
};

export const DAY_TYPE_TONE: Record<OvertimeDayType, Tone> = {
  WEEKDAY: 'neutral',
  SUNDAY: 'info',
  HOLIDAY: 'warning',
};

export const OT_TYPE_LABEL: Record<OvertimeType, string> = {
  REGULAR: 'Regular',
  LATE: 'Late',
  DOUBLE: 'Double',
  DOUBLE_LATE: 'Double, late',
};

/**
 * A rate, or an em dash.
 *
 * `null` is what the server sends when there was nothing to divide by. Printing
 * 0% there is a claim — "nothing was approved" rather than "nothing was filed" —
 * and the two are different facts about the same window.
 */
export function formatRate(
  rate: number | null | undefined,
  digits = 1,
): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  return `${rate.toFixed(digits)}%`;
}

/** Days, pluralised, with an em dash for an unknown figure. */
export function formatDays(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'day' : 'days'}`;
}

/** A rate multiplier as "1.25×", which is how a payslip line reads. */
export function formatMultiplier(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  return `${Math.round(rate * 100) / 100}×`;
}

/** The change in a percentage, in points — never a percentage of a percentage. */
export function pointsChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | undefined {
  if (current === null || current === undefined) return undefined;
  if (previous === null || previous === undefined) return undefined;
  return Math.round((current - previous) * 10) / 10;
}

/**
 * How stale a pending request is, in whole days.
 *
 * Whole days rather than hours: "waiting 2 days" is what an approver acts on,
 * and "waiting 53 hours" makes them do the division.
 */
export function daysWaiting(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((Date.now() - created) / 86_400_000));
}
