import { roundMoney } from '../utils/money.util';

/**
 * The arithmetic the dashboard and the payroll analytics page share.
 *
 * Pure on purpose, and in `common/` rather than inside either module, because
 * both screens print the same month label, the same growth percentage and the
 * same "nothing to divide by" em dash. The moment one of them inlines its own
 * `${n}%` the two pages start disagreeing about what August was, and a reader
 * comparing them has no way to tell which one is lying.
 *
 * Every function here is total: it answers for an empty window, a zero
 * denominator and a missing previous period without throwing, because the
 * caller has no better answer to give than the one encoded here.
 */

/** `2026-08`. The machine key a chart bucket joins on. */
export const monthKey = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, '0')}`;

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * `Aug 2026` — the axis label.
 *
 * Formatted HERE rather than in the browser. A bucket that travels as a bare
 * `2026-08` gets re-parsed client-side, and a date-only string put through an
 * instant parse lands in July for anyone west of Greenwich: the same chart then
 * labels the same bar differently depending on who opened it.
 */
export const monthLabel = (year: number, month: number): string =>
  `${MONTHS_SHORT[month - 1]} ${year}`;

/** `August 2026` — the period a payroll block answers for, spelled out. */
export const periodLabel = (year: number, month: number): string =>
  `${MONTHS_LONG[month - 1]} ${year}`;

export interface MonthRef {
  year: number;
  month: number;
  key: string;
  label: string;
}

/**
 * The `months`-long window ending at (and including) the anchor, oldest first.
 *
 * Walked by calendar arithmetic on UTC parts rather than by adding 30 days, so
 * a window crossing February or a DST boundary still has exactly one bucket per
 * month.
 */
export const monthWindow = (
  anchorYear: number,
  anchorMonth: number,
  months: number,
): MonthRef[] => {
  const out: MonthRef[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const d = new Date(Date.UTC(anchorYear, anchorMonth - 1 - back, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    out.push({ year, month, key: monthKey(year, month), label: monthLabel(year, month) });
  }
  return out;
};

/** First instant of the month, UTC. */
export const monthStart = (year: number, month: number): Date =>
  new Date(Date.UTC(year, month - 1, 1));

/** Last calendar day of the month, UTC — the inclusive end of a date-only range. */
export const monthEnd = (year: number, month: number): Date =>
  new Date(Date.UTC(year, month, 0));

/** The month immediately before the given one. */
export const previousMonth = (year: number, month: number): { year: number; month: number } => {
  const d = new Date(Date.UTC(year, month - 2, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
};

/**
 * A rate, or `null` when there was nothing to divide by.
 *
 * The whole point of the null. An empty branch and an unreachable endpoint are
 * different claims, and a card printing 0.0% for both has told the reader
 * something false about one of them. A closed office did not fail to turn up.
 */
export const safeRate = (
  numerator: number,
  denominator: number,
  digits = 1,
): number | null => {
  if (!denominator || denominator <= 0) return null;
  const pct = (numerator / denominator) * 100;
  if (!Number.isFinite(pct)) return null;
  return Number(pct.toFixed(digits));
};

/**
 * Percentage change, or `null` when the baseline was zero.
 *
 * Growth from nothing is not "infinite" and it is certainly not 0% — there is
 * no previous figure to be a percentage OF, so the panel says so instead.
 */
export const changePct = (current: number, previous: number, digits = 1): number | null => {
  if (!previous) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if (!Number.isFinite(pct)) return null;
  return Number(pct.toFixed(digits));
};

/** Prisma `Decimal | null` to a plain rounded number. */
export const money = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? roundMoney(n) : 0;
};

/**
 * Whole days between two date-only values, `to - from`.
 *
 * Negative when `to` is already past, which is what the expiry panels render:
 * a permit that lapsed last week is a more urgent row than one lapsing next
 * month, and clamping it at zero would sort them together.
 */
export const daysBetween = (from: Date, to: Date): number => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
};

/** `2026-08-15` — a date-only value, with no zone conversion on the way out. */
export const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);
