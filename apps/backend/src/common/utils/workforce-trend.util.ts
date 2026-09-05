/** One calendar month of joiner/leaver movement. */
export interface TrendBucket {
  key: string;
  label: string;
  joiners: number;
  leavers: number;
  net: number;
  /**
   * Active headcount at the close of this month, or `null` when it cannot be
   * reconstructed — see the backwards walk in `buildWorkforceTrend`.
   */
  headcountEnd: number | null;
}

export interface WorkforceTrend {
  months: number;
  buckets: TrendBucket[];
  netChange: number;
  growthPct: number | null;
}

export interface WorkforceTrendInput {
  months: number;
  /** `Employee.hireDate` values. Anything outside the window is ignored. */
  hireDates: Date[];
  /** `Employee.exitDate` values. Anything outside the window is ignored. */
  exitDates: Date[];
  /** Active headcount right now — the anchor the backwards walk starts from. */
  currentHeadcount: number;
  now?: Date;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * `YYYY-MM` for a date-only column.
 *
 * UTC getters, always. Prisma hands a `@db.Date` back as midnight UTC, so
 * reading it with local getters moves a first-of-the-month hire into the
 * previous month for any server west of Greenwich — which is exactly the class
 * of bug `formatDateOnly` exists to avoid on the other side of the wire.
 */
export function monthKey(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}`;
}

/**
 * `2026-08` becomes `Aug 2026`.
 *
 * The server owns the label so the browser never does calendar maths on a
 * bucket key, and so every reader sees the same month name whatever their
 * locale data happens to contain.
 */
export function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  return `${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`;
}

/** Ascending month keys, the last of which is the month `now` falls in. */
export function trendMonthKeys(months: number, now = new Date()): string[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const keys: string[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    keys.push(monthKey(new Date(Date.UTC(year, month - back, 1))));
  }
  return keys;
}

/** First instant of the window — the lower bound for the hire/exit queries. */
export function trendWindowStart(months: number, now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1),
  );
}

/** First instant AFTER the window, so the bound can be used as `lt`. */
export function trendWindowEnd(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Turn raw hire and exit dates into a month-by-month headcount trend.
 *
 * Callers pass two flat lists of dates rather than per-month counts: reading
 * one column per list is two queries whatever the window length, where a count
 * per bucket would be `months × 2` round trips for the same answer.
 *
 * `headcountEnd` is walked BACKWARDS from today. Only the current headcount is
 * known for certain — an employee record carries its status now, not its status
 * last March — so the last bucket is anchored to it and each earlier bucket is
 * the later one minus that later one's net movement. A bucket whose walk would
 * go negative is reported as `null` rather than clamped to zero: the movement
 * rows and the current headcount disagree at that point, and a zero would
 * present that disagreement as a fact.
 */
export function buildWorkforceTrend({
  months,
  hireDates,
  exitDates,
  currentHeadcount,
  now = new Date(),
}: WorkforceTrendInput): WorkforceTrend {
  const buckets: TrendBucket[] = trendMonthKeys(months, now).map((key) => ({
    key,
    label: monthLabel(key),
    joiners: 0,
    leavers: 0,
    net: 0,
    headcountEnd: null,
  }));

  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const date of hireDates) {
    const bucket = byKey.get(monthKey(date));
    if (bucket) bucket.joiners += 1;
  }
  for (const date of exitDates) {
    const bucket = byKey.get(monthKey(date));
    if (bucket) bucket.leavers += 1;
  }
  for (const bucket of buckets) {
    bucket.net = bucket.joiners - bucket.leavers;
  }

  let running: number | null = currentHeadcount;
  for (let i = buckets.length - 1; i >= 0; i -= 1) {
    buckets[i].headcountEnd = running;
    if (running === null) continue;
    // The explicit annotation breaks the circular inference between `running`
    // (narrowed by the null check above) and the value it is reassigned from,
    // which TypeScript otherwise resolves to `any`.
    const earlier: number = running - buckets[i].net;
    running = earlier < 0 ? null : earlier;
  }

  const netChange = buckets.reduce((sum, b) => sum + b.net, 0);

  // The baseline is the headcount the window OPENED with, which is the first
  // bucket's close undone by its own movement. Unknown baseline, or nobody to
  // measure against, means no percentage at all — a 0% would read as "the
  // organisation did not grow", which is a claim the data cannot support.
  const first: TrendBucket | undefined = buckets[0];
  const opening =
    first === undefined || first.headcountEnd === null
      ? null
      : first.headcountEnd - first.net;

  return {
    months,
    buckets,
    netChange,
    growthPct:
      opening === null || opening <= 0
        ? null
        : Math.round((netChange / opening) * 1000) / 10,
  };
}
