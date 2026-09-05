/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CHART COLORS — Centralized for Recharts
 * ─────────────────────────────────────────────────────────────────────────────
 * Recharts consumes hex strings, not CSS variables, so chart colors must be
 * defined as JS values. All chart colors reference the active theme preset.
 *
 * Usage in a chart component:
 *   import { chartColors } from '@/theme/chartColors';
 *   <Bar fill={chartColors.primary} />
 *   <Pie data={data.map((d, i) => ({ ...d, fill: chartColors.palette[i % chartColors.palette.length] }))} />
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { activeTheme } from './index';
import type { ThemeConfig } from './types';

/**
 * Active theme singleton for chart colors. Seeded with the build-time default
 * so SSR / first render is safe; the ThemeProvider calls `setChartTheme()` with
 * the resolved live theme so Recharts colors track the selected preset.
 */
let current: ThemeConfig = activeTheme;

/** Called by ThemeProvider whenever the resolved theme changes. */
export function setChartTheme(theme: ThemeConfig): void {
  current = theme;
}

/**
 * Chart color accessor. Fields are getters off the live theme singleton, so
 * existing `import { chartColors }` call-sites stay valid and become reactive
 * (Recharts reads the field values at render time).
 */
export const chartColors = {
  // ── Semantic ──────────────────────────────────────────────────────────────
  /** Primary brand color — main bars, lines, key series */
  get primary() { return current.colors.brandPrimary; },
  /** Accent color — secondary series */
  get accent() { return current.colors.brandAccent; },
  /** Success / positive trend */
  get success() { return current.colors.statusSuccess; },
  /** Warning / attention */
  get warning() { return current.colors.statusWarning; },
  /** Error / negative trend */
  get error() { return current.colors.statusError; },
  /** Neutral info */
  get info() { return current.colors.statusInfo; },

  // ── Multi-series palette ──────────────────────────────────────────────────
  /**
   * Ordered palette for pie charts, stacked bars, multi-line charts.
   * Cycles when dataset has more series than palette entries.
   */
  get palette() {
    const c = current.colors;
    return [
      c.brandPrimary,      // brand primary
      c.brandAccent,       // brand accent
      c.statusSuccess,     // green
      c.statusWarning,     // amber
      c.statusInfo,        // blue/info
      '#8b5cf6',           // violet  — neutral 6th (not brand-specific)
      '#06b6d4',           // cyan    — neutral 7th
      '#ec4899',           // pink    — neutral 8th
    ];
  },

  // ── Grid / axis ───────────────────────────────────────────────────────────
  /** Recharts CartesianGrid stroke color */
  get grid() { return current.colors.surfaceBorder; },
  /** Recharts axis tick text color */
  get axisText() { return current.colors.textMuted; },
  /** Recharts tooltip background */
  get tooltipBg() { return current.colors.surfaceOverlay; },
  /** Recharts tooltip border */
  get tooltipBorder() { return current.colors.surfaceBorder; },

  // ── Specific chart semantics ──────────────────────────────────────────────
  get present() { return current.colors.statusSuccess; },
  get absent() { return current.colors.statusError; },
  get late() { return current.colors.statusWarning; },
  get leave() { return current.colors.statusInfo; },
  get overtime() { return current.colors.brandAccent; },
};

export type ChartColors = typeof chartColors;

/* ─────────────────────────────────────────────────────────────────────────────
 * CATEGORICAL SERIES — for charts that colour by ENTITY
 * ─────────────────────────────────────────────────────────────────────────────
 * `chartColors.palette` above is kept exactly as it is for its existing
 * callers. It cannot be used to colour departments: slots 3 and 4 of it ARE
 * `statusSuccess` and `statusWarning`, so a page using it paints the third
 * department green and the fourth amber — and a green department reads as a
 * healthy one.
 *
 * These slots are reserved from the status hues on purpose. Status colour means
 * good / warning / serious / critical and nothing else, so it is never handed
 * to a series.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Eight categorical slots, none of them a status hue.
 *
 * Two of these (`orange`, `cyan`) sit near 3:1 on the white card. That is the
 * reason every chart using this ramp ships direct labels and a table twin —
 * colour is never the only thing carrying the identity of a mark.
 */
export const SERIES_RAMP = [
  '#00358F', // brand deep blue
  '#f66600', // brand orange
  '#0f766e', // teal
  '#7c3aed', // violet
  '#be185d', // magenta
  '#a16207', // ochre
  '#0891b2', // cyan
  '#4d7c0f', // olive
] as const;

/** Everything past the eighth entity, and anything unrecognised. */
export const SERIES_OTHER = '#94a3b8';

/**
 * A stable entity → colour function.
 *
 * **Seeded from the UNFILTERED key list**, which is why this takes the full set
 * rather than the rows being drawn. Colouring by the position of a row in the
 * data means filtering one department out shifts every later one up a slot, and
 * the reader who learned Finance is orange watches it turn teal when somebody
 * changes a filter that has nothing to do with Finance. The server returns the
 * complete option list on every response precisely so this can be built from
 * something that does not move.
 *
 * Past eight entities the tail shares the neutral: a ninth hue would be a
 * colour nobody can name against the eight above it, and the matrix table below
 * every chart already carries the detail.
 */
export function createSeriesScale(
  orderedKeys: readonly string[],
): (key: string | null | undefined) => string {
  const slots = new Map<string, string>();
  orderedKeys.forEach((key, index) => {
    if (index < SERIES_RAMP.length) slots.set(key, SERIES_RAMP[index]);
  });
  return (key) => (key ? (slots.get(key) ?? SERIES_OTHER) : SERIES_OTHER);
}

/**
 * The run lifecycle, as ONE hue getting darker with progress.
 *
 * A pipeline is ordered, so it takes an ordinal ramp. Eight categorical hues
 * would say the stages are unrelated identities rather than four points on one
 * road. `CANCELLED` is the neutral: it is not a stage and it is not a failure,
 * it is a withdrawal from the sequence.
 */
export const RUN_STATUS_COLORS: Record<string, string> = {
  DRAFT: '#AECCFF',
  CALCULATED: '#6b9ae8',
  APPROVED: '#2e6ac4',
  PAID: '#00358F',
  CANCELLED: SERIES_OTHER,
};

/**
 * The money composition, read as two directions rather than five identities.
 *
 * Earnings share one hue light-to-dark because basic and allowances are parts
 * of the same quantity; deductions take the opposing hue because they move the
 * other way. Two hues with the neutral between them is a diverging scale, which
 * is what "money in, money out" actually is.
 */
export const COMPOSITION_COLORS: Record<string, string> = {
  BASIC: '#00358F',
  ALLOWANCES: '#6b9ae8',
  DEDUCTIONS: '#f66600',
  EMPLOYER_COST: SERIES_OTHER,
};

/**
 * Attendance segments.
 *
 * The ONE place status colour is correct for a series, because these segments
 * ARE the status: a present day is good and an absent one is not. Every chart
 * using them still carries a legend and a table, because four colours is not a
 * label.
 */
export const ATTENDANCE_COLORS = {
  get present() { return current.colors.statusSuccess; },
  get late() { return current.colors.statusWarning; },
  get absent() { return current.colors.statusError; },
  get halfDay() { return current.colors.brandAccent; },
  get onLeave() { return current.colors.statusInfo; },
};

/**
 * A single hue, light to dark, across `0…1`.
 *
 * For the treemap, where colour encodes a SECOND measure (average pay per head)
 * on top of the area that already encodes the first. A categorical ramp there
 * would claim the departments are unrelated identities when the whole point of
 * the fill is that they sit on one scale.
 */
export function sequentialFill(t: number): string {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  return `color-mix(in srgb, ${SERIES_RAMP[0]} ${Math.round(20 + clamped * 70)}%, white)`;
}
