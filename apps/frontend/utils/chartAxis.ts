/**
 * A y-axis a reader can do arithmetic against.
 *
 * `BarOverviewChart` takes a ceiling and its tick labels rather than deriving
 * them, so every caller that does not think about it draws bars against a
 * hard-coded 60. Rounding the peak UP to a round number keeps the tallest bar
 * inside the plot and the gridlines on values worth reading: a chart topping out
 * at 47 wants a 50 axis in steps of 10, not a 47 axis in steps of 9.4.
 */
export function axisFor(
  peak: number,
  steps = 5,
): { max: number; ticks: string[] } {
  const safePeak = Number.isFinite(peak) && peak > 0 ? peak : 1;

  // The step is the first "nice" number at or above peak/steps: 1, 2, 5 and
  // their powers of ten. Anything else puts a gridline on 3.7.
  const rough = safePeak / steps;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step =
    (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) *
    magnitude;

  const max = Math.ceil(safePeak / step) * step;
  const ticks: string[] = [];
  for (let value = 0; value <= max + step / 2; value += step) {
    // A whole-number axis prints whole numbers. Steps below 1 keep one decimal
    // so a 0.5 gridline does not render as two identical "0" labels.
    ticks.push(step >= 1 ? String(Math.round(value)) : value.toFixed(1));
  }
  // Highest label first: the axis is drawn top-down.
  return { max, ticks: ticks.reverse() };
}

/** A CSV cell, quoted only when it has to be. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Hand the reader a spreadsheet of what is on screen.
 *
 * The object URL is revoked immediately after the click. Without that every
 * export holds its blob in memory for the life of the tab, and a reader stepping
 * through a year of windows leaks one per step.
 */
export function downloadCsv(
  filename: string,
  header: string[],
  rows: Array<Array<string | number>>,
): void {
  const csv = [
    header.join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ].join('\n');

  const url = URL.createObjectURL(
    new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
