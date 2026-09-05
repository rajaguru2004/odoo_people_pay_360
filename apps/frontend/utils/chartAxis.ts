/**
 * Five round ticks that clear the tallest bar without towering over it.
 *
 * The naive `ceil(max/25)*25` put a six-person branch on a 0–25 axis, so every
 * bar sat in the bottom fifth of the panel and the shape of the month was
 * invisible. Step through the 1/2/5 decades instead and take the first that
 * fits.
 *
 * Lifted out of `app/dashboard/time/page.tsx` when the Schedules and
 * Leave & Overtime hubs adopted the same chart: three copies of an axis rule is
 * three panels that scale differently on the same screen.
 */
export function axisFor(max: number): { max: number; ticks: string[] } {
  // The ladder runs to money magnitudes, not just headcount ones. It used to
  // stop at 5000 and fall through to `Math.ceil(max/5)`, which on a payroll
  // total of 519,446 produced the axis 0 / 103,890 / 207,780 / 311,670 …:
  // arithmetically correct, unreadable, and not a round number anywhere.
  //
  // Only integers, and only the 1/2/5 decades the doc-comment promises — 2.5
  // is deliberately absent below 10,000 because a headcount axis that steps in
  // half-people is worse than a coarse one. Every value that matched before
  // still matches first, so no existing hub's axis moves.
  const steps = [
    1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000,
    10_000, 20_000, 25_000, 50_000, 100_000, 200_000, 250_000, 500_000,
    1_000_000, 2_000_000, 2_500_000, 5_000_000,
    10_000_000, 20_000_000, 25_000_000, 50_000_000, 100_000_000,
  ];
  const step = steps.find((s) => s * 5 >= max) ?? Math.ceil(max / 5);
  const top = step * 5;
  return { max: top, ticks: Array.from({ length: 6 }, (_, i) => String(i * step)) };
}

/**
 * `1200000` → `1.2M`, `200000` → `200k`.
 *
 * For axis ticks only. Six-digit labels down the side of a chart are wider than
 * the bars they measure, and the reader is after the magnitude rather than the
 * exact figure — which the tooltip carries in full, formatted as money.
 */
export function compactTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimZero(value / 1_000)}k`;
  return String(value);
}

function trimZero(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * One row of a CSV, with the quoting the format actually requires.
 *
 * Shared for the same reason as the axis: every hub exports its trend, and a
 * hub that forgets to escape a department called "Sales, EMEA" writes a file
 * that opens one column wider than it should.
 */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Hand the browser a CSV to save.
 *
 * The object URL is revoked immediately after the click: without it every
 * export leaks a blob for the lifetime of the tab, which on a dashboard people
 * leave open all day is a real number.
 */
export function downloadCsv(filename: string, header: string[], body: (string | number)[][]): void {
  const csv = [header.join(','), ...body.map((row) => row.map(csvCell).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
