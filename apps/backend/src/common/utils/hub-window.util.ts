/**
 * Windows and month bucketing for the module hub aggregates.
 *
 * The Finance, Talent and Workplace hubs all answer the same two shapes of
 * question — "how much in this window, versus the one before it" and "how much
 * per month across the trailing year" — so the calendar arithmetic lives here
 * once rather than three times.
 *
 * All arithmetic is UTC, and every label is produced server-side. The browser
 * never does calendar maths on hub data; that is the rule the attendance hub
 * set with its period stepper and there is no reason for these three to differ.
 *
 * `workforce-trend.util.ts` already buckets by month, but its `MonthBucket`
 * carries `joiners`/`leavers`/`headcountEnd` — it is the workforce series, not
 * a general one. `pct` is genuinely shared and is re-exported from here so a
 * finance service is not importing a file called `workforce-trend`.
 */

export { pct } from './workforce-trend.util';

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** How many months the hub trend charts draw. */
export const HUB_TREND_MONTHS = 12;

/** `YYYY-MM` — stable across locales and safe as a React key. */
export function monthKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface HubWindow {
  key: string;
  /** Inclusive. */
  start: Date;
  /** Exclusive: the first instant of the following month. */
  end: Date;
  label: string;
}

export interface HubWindowPair {
  current: HubWindow;
  previous: HubWindow;
}

function monthWindow(year: number, month: number): HubWindow {
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return {
    key: monthKeyOf(start),
    start,
    end,
    label: `${MONTH_LABELS[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
  };
}

/**
 * The current calendar month and the one before it.
 *
 * The hubs carry no period filter — `showControls` is off on all three — so the
 * window is not a user choice and does not need to be parsed from a query
 * string. That also means there is no `anchor=2026-13-45` to validate, which is
 * the trap the attendance hub had to close.
 *
 * The current month is deliberately partial: a KPI reading "spend this
 * month" on the 3rd should say what has actually been spent by the 3rd.
 * The delta against a *whole* previous month is therefore unflattering early in
 * a month, and the cards label the window rather than pretending otherwise.
 */
export function resolveMonthWindow(now: Date = new Date()): HubWindowPair {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    current: monthWindow(y, m),
    previous: monthWindow(y, m - 1),
  };
}

export interface SeriesBucket {
  key: string;
  label: string;
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** `months` calendar buckets ending with the current (partial) month. */
export function buildSeriesBuckets(
  months: number = HUB_TREND_MONTHS,
  now: Date = new Date(),
): SeriesBucket[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const out: SeriesBucket[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const w = monthWindow(y, m - i);
    out.push({ key: w.key, label: MONTH_LABELS[w.start.getUTCMonth()], start: w.start, end: w.end });
  }
  return out;
}

/**
 * Drop dated rows into the buckets.
 *
 * One `findMany` of two columns bucketed in JS beats `months × n` count
 * queries: a year of rows is a few thousand rows, and thirty-six round trips
 * is thirty-six round trips.
 *
 * A row whose date falls outside the window is ignored, never clamped into the
 * first bucket — a record dated two years ago is not activity in the oldest
 * month on the chart.
 */
export function tallyByMonth<B extends { key: string }>(
  buckets: B[],
  rows: Array<{ date: Date | null | undefined; amount?: number | null }>,
  apply: (bucket: B, amount: number) => void,
): void {
  if (!buckets.length) return;
  const index = new Map(buckets.map((b) => [b.key, b]));
  for (const row of rows) {
    if (!row.date) continue;
    const bucket = index.get(monthKeyOf(row.date));
    if (bucket) apply(bucket, Number(row.amount ?? 0));
  }
}

/**
 * The absolute and directional change between two windows.
 *
 * `null` when the previous window is unknown — a KPI whose delta cannot be
 * computed shows no badge at all, because "0% change" against an unknown
 * baseline is the same class of lie as printing 0 for a failed read.
 */
export function windowDelta(
  current: number,
  previous: number | null | undefined,
): { value: number; direction: 'up' | 'down'; absolute: number } | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  const absolute = current - previous;
  // No baseline to divide by. The absolute change is still true and the card
  // prints that instead; a percentage off zero is not a number anyone can use.
  const value = previous === 0 ? 0 : Math.round((absolute / previous) * 1000) / 10;
  return { value, direction: absolute >= 0 ? 'up' : 'down', absolute };
}
