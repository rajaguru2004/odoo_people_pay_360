'use client';

import type { ReactNode } from 'react';
import { ChartTooltipCard } from '@/components/module-landing/primitives';
import { chartColors } from '@/theme/chartColors';

/**
 * Recharts tooltips, rendered through the card the hand-rolled charts use.
 *
 * The module hubs already draw a tooltip — `ChartTooltipCard` in
 * `components/module-landing/primitives.tsx` — and a second one styled
 * separately would mean a reader moving between the hub and the analytics page
 * sees the same information in two different objects. So Recharts is given the
 * existing card as its `content` rather than its own default.
 */

/** What Recharts hands a custom tooltip. Typed loosely because it is. */
interface TooltipPayloadEntry {
  name?: string | number;
  value?: string | number;
  dataKey?: string | number;
  color?: string;
  payload?: Record<string, unknown>;
}

export interface ChartTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayloadEntry[];
  /** Formats each value — normally `formatCurrency` bound to the currency. */
  format: (value: number) => string;
  /** Renames a series for the reader; falls back to the Recharts `name`. */
  labels?: Record<string, string>;
  /** Extra rows below the series, already formatted. */
  extra?: (payload: Record<string, unknown>) => Array<{
    label: string;
    value: string;
  }>;
}

/**
 * The tooltip every chart on the analytics page uses.
 *
 * Entries with no value are dropped rather than printed as zero: a series that
 * has no reading at this point did not read nought, and a stacked bar would
 * otherwise list every empty segment under the hovered one.
 */
export function ChartTooltip({
  active,
  label,
  payload,
  format,
  labels,
  extra,
}: ChartTooltipProps): ReactNode {
  if (!active || !payload?.length) return null;

  const rows = payload
    .filter((entry) => entry.value !== undefined && entry.value !== null)
    .map((entry) => {
      const key = String(entry.dataKey ?? entry.name ?? '');
      const numeric = Number(entry.value);
      return {
        label: labels?.[key] ?? String(entry.name ?? key),
        value: Number.isFinite(numeric) ? format(numeric) : String(entry.value),
        color: entry.color ?? chartColors.primary,
      };
    });

  const extras = extra?.(payload[0]?.payload ?? {}) ?? [];
  for (const row of extras) {
    rows.push({ ...row, color: 'transparent' });
  }

  return <ChartTooltipCard title={label ? String(label) : undefined} rows={rows} />;
}

/**
 * The crosshair a line or an area gets.
 *
 * A vertical rule, because on a continuous series the question is always "what
 * was the value at THIS point in time" — the reader is locating an x, not a
 * mark. Bars, arcs and treemap cells take the per-mark highlight below instead:
 * there the mark IS the thing being asked about.
 */
export const crosshairCursor = {
  stroke: chartColors.grid,
  strokeWidth: 1,
  strokeDasharray: '4 4',
};

/** The soft wash a hovered bar or cell sits under. */
export const markCursor = {
  fill: 'color-mix(in srgb, var(--color-brand-primary) 8%, transparent)',
};
