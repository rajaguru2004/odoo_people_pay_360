/**
 * Formatting shared by the analytics charts.
 *
 * Pure, so the axis and label rules can be tested without a DOM.
 */

/**
 * Money on the side of a chart, rather than a column of six-digit integers.
 *
 * An axis is read for magnitude, not for reconciliation — the table twin and
 * the tooltip carry the exact figure, and `formatCurrency` is used for both.
 * Mirrors the compact tick the payroll hub already uses, so the two pages label
 * the same amount the same way.
 */
export function compactMoney(value: number): string {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  }
  return String(Math.round(value));
}

/**
 * A percentage tick.
 *
 * Whole numbers: an axis reading 33.3% implies a precision the denominator of
 * an attendance rate does not have.
 */
export function percentTick(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * A share of a normalised bar, as a percentage of its own row.
 *
 * `null` when the row is empty, so the caller prints an em dash rather than
 * 0% — a department with no attendance events at all did not have nought per
 * cent attendance, it had no days to measure.
 */
export function shareOf(value: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round((value / total) * 1000) / 10;
}

/**
 * A label short enough to sit under a bar.
 *
 * Truncated with a real ellipsis rather than CSS, because an SVG `<text>` does
 * not wrap or clip to a box — a long department name simply overlaps its
 * neighbour and both become unreadable.
 */
export function axisLabel(value: string, max = 14): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}
