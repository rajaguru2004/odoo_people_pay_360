/**
 * Month bucketing for the workforce trend charts on the Organization and People
 * hubs.
 *
 * Both hubs draw the same underlying series — people who joined and people who
 * left, by calendar month — so the bucketing lives here rather than twice. The
 * two hubs differ only in what they draw on top of it.
 *
 * Deliberately NOT built on `DashboardService.getTurnoverStats`, which keys off
 * `updated_at` + `status='INACTIVE'`: that is "a record was touched while
 * inactive", not "somebody left in March". Joiners come from
 * `Employee.startDate` and leavers from `Employee.endDate`, which are the dates
 * the business actually recorded.
 */

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Trailing windows the hubs offer. A value outside this list is refused. */
export const TREND_MONTH_OPTIONS = [6, 12] as const;
export type TrendMonths = (typeof TREND_MONTH_OPTIONS)[number];

export interface MonthBucket {
  /** `YYYY-MM`, stable across locales and safe as a react key. */
  key: string;
  /** `Aug 2026` — the axis label. */
  label: string;
  start: Date;
  /** Exclusive: the first instant of the following month. */
  end: Date;
  joiners: number;
  leavers: number;
  net: number;
  /**
   * Active headcount at the close of this bucket. Filled in by
   * `walkHeadcountBackwards`, because only *today's* headcount is a fact — every
   * earlier one is derived from it.
   */
  headcountEnd: number | null;
}

/**
 * `months` calendar buckets ending with the current (partial) month.
 *
 * All arithmetic is UTC. The hubs render dates the server has already labelled
 * so the browser never does calendar maths — the same rule the attendance hub
 * follows for its period stepper.
 */
export function buildMonthBuckets(months: number, now: Date = new Date()): MonthBucket[] {
  const buckets: MonthBucket[] = [];
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(y, m - i, 1));
    const end = new Date(Date.UTC(y, m - i + 1, 1));
    buckets.push({
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      label: `${MONTH_LABELS[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
      start,
      end,
      joiners: 0,
      leavers: 0,
      net: 0,
      headcountEnd: null,
    });
  }
  return buckets;
}

/**
 * Drop a column of dates into the buckets.
 *
 * Two single-column `findMany`s bucketed here beat `months × 2` count queries:
 * a year of joiners on a real database is a few thousand dates, and twenty-four
 * round trips is twenty-four round trips.
 *
 * Dates outside the window are ignored rather than clamped into the first
 * bucket — somebody who joined three years ago is not a joiner this March.
 */
export function bucketiseByMonth(
  dates: Array<Date | null | undefined>,
  buckets: MonthBucket[],
  field: 'joiners' | 'leavers',
): void {
  if (!buckets.length) return;
  const index = new Map(buckets.map((b) => [b.key, b]));

  for (const d of dates) {
    if (!d) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = index.get(key);
    if (bucket) bucket[field] += 1;
  }
  for (const b of buckets) b.net = b.joiners - b.leavers;
}

/**
 * Fill `headcountEnd` backwards from today.
 *
 * Only the current active headcount is a fact — it is a live `count()`. Every
 * earlier month is that figure minus the net movement since, which is why the
 * LAST bucket always reconciles with the KPI card printed above the chart. A
 * forward walk from an invented starting figure would let the chart and the
 * card disagree, and the reader would have no way to tell which one lied.
 *
 * The floor at 0 matters on a partially-backfilled database: an employee whose
 * `startDate` predates the window but whose record was created inside it can
 * otherwise walk the line negative, and a negative headcount is visibly absurd
 * in a way a merely wrong one is not.
 */
export function walkHeadcountBackwards(buckets: MonthBucket[], activeNow: number): void {
  let running = activeNow;
  for (let i = buckets.length - 1; i >= 0; i--) {
    buckets[i].headcountEnd = Math.max(0, running);
    running -= buckets[i].net;
  }
}

/** `null` when there was nothing to divide by — never 0%, which is a claim. */
export function pct(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Growth over the whole window, against the headcount it started from.
 *
 * `buckets[0].headcountEnd - buckets[0].net` is the opening headcount: what the
 * business had before the first month's movement.
 */
export function growthPercent(buckets: MonthBucket[]): number | null {
  if (!buckets.length) return null;
  const first = buckets[0];
  if (first.headcountEnd === null) return null;
  const opening = first.headcountEnd - first.net;
  const netChange = buckets.reduce((sum, b) => sum + b.net, 0);
  return pct(netChange, opening);
}
