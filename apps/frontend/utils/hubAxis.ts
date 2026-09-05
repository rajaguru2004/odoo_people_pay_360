/**
 * Five round ticks that clear the tallest bar without towering over it.
 *
 * The Time & Attendance hub carries a local `axisFor` with a hardcoded step
 * ladder that tops out at 5000 — fine for counting people, useless for a money
 * axis where a single month can be six figures. This version derives the ladder
 * from the magnitude instead, so it works for two claims or two million.
 *
 * The naive `ceil(max / 5)` puts a lone bar at exactly the top of the panel with
 * no headroom, and every other bar becomes a sliver; stepping through the
 * 1 / 2 / 2.5 / 5 decades and taking the first that fits keeps the shape of the
 * series visible.
 *
 * `time/page.tsx` deliberately keeps its own copy: that hub is finished and
 * signed off, and rewiring it to prove a point about duplication would be a
 * change to working code that nobody asked for.
 */
export function niceAxis(max: number): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 5, ticks: [0, 1, 2, 3, 4, 5] };

  const magnitude = Math.pow(10, Math.floor(Math.log10(max / 5 || 1)));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s * 5 >= max) ?? Math.ceil(max / 5);

  const top = step * 5;
  return { max: top, ticks: Array.from({ length: 6 }, (_, i) => i * step) };
}

/**
 * A compact axis label: `1.2M`, `45k`, `900`.
 *
 * Six-figure tick labels turn a 5-tick axis into a wall of digits and push the
 * plot area sideways until the bars have nowhere to live.
 */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}k`;
  return trim(value);
}

function trim(n: number): string {
  // One decimal, but never a trailing `.0` — `45k` reads better than `45.0k`.
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * A percentage for display, or an em dash.
 *
 * `null` from the server means the denominator was zero — the rate is unknown,
 * not zero — and it has to stay visibly unknown all the way to the pixel.
 */
export function ratePct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`;
}

/** A share of a total, floored at 0 and capped at 100, for a meter track. */
export function sharePct(part: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}
