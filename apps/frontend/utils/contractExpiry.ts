/**
 * How long a dated thing has left, and how alarmed to be about it.
 *
 * Contracts and work permits both end on a DATE, not at an instant, and both are
 * read on screens that have to agree with each other — the People hub, the
 * contract list and the visa report all count down to the same day. The
 * arithmetic lives here so they cannot drift apart, and so it can be tested
 * without a DOM.
 */

/** The window every "expiring soon" on these screens means, unless told otherwise. */
export const DEFAULT_EXPIRY_WINDOW_DAYS = 30;

export type ExpiryTone = 'error' | 'warning' | 'neutral';

/**
 * Whole days from today until a date-only value; negative once it has passed.
 *
 * Both sides are pinned to UTC midnight before subtracting. A hire date or an
 * expiry date has no time of day, and putting `2026-01-15` through a local-zone
 * parse makes it the 14th anywhere west of Greenwich — which is one day of
 * runway invented or lost depending on where the reader is sitting.
 */
export function daysUntilDate(
  value: string | null | undefined,
  today: Date = new Date(),
): number | null {
  if (!value) return null;

  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;

  const target = Date.UTC(y, m - 1, d);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  return Math.round((target - start) / 86_400_000);
}

/**
 * Red once it has lapsed or is inside a week, amber inside the window, plain
 * otherwise.
 *
 * An unknown figure is neutral rather than green: nothing was measured, so there
 * is nothing to reassure the reader about.
 */
export function expiryTone(
  days: number | null | undefined,
  windowDays: number = DEFAULT_EXPIRY_WINDOW_DAYS,
): ExpiryTone {
  if (days === null || days === undefined) return 'neutral';
  if (days <= 7) return 'error';
  if (days <= windowDays) return 'warning';
  return 'neutral';
}

/** "Expired 4 days ago" / "Expires today" / "12 days left" — never a bare number. */
export function expiryLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return '—';
  if (days < 0) return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  if (days === 0) return 'Expires today';
  return `${days} day${days === 1 ? '' : 's'} left`;
}

/** Inside the alert window and not yet lapsed — what a countdown badge is for. */
export function isExpiringWithin(
  days: number | null | undefined,
  windowDays: number = DEFAULT_EXPIRY_WINDOW_DAYS,
): boolean {
  return days !== null && days !== undefined && days >= 0 && days <= windowDays;
}
