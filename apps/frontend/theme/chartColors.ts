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
