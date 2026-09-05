'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { generateSparkPath } from '@/utils/spark';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

export interface KpiStat {
  /** Stable key — also the React key, so never the translated label. */
  key: string;
  /** Already translated by the caller; this component owns no strings. */
  label: string;
  /**
   * `null` while the figure is genuinely unknown — the request failed, or the
   * endpoint is closed to this role. Printed as an em dash, never as a zero: a
   * missing number is not the number zero, and printing 0 makes a claim the data
   * does not support.
   */
  value: string | number | null;
  icon?: LucideIcon;
  tone?: StatTone;
  /**
   * Movement against the previous period. `goodDirection` decides the colour:
   * overtime hours rising is not the same news as headcount rising.
   */
  delta?: {
    value: number;
    direction: 'up' | 'down';
    goodDirection?: 'up' | 'down';
    label?: string;
    /**
     * What to print instead of the percentage — an already-formatted absolute
     * change ("OMR 3,120"). A percentage is the honest form for a rate; for
     * money the absolute is the sentence the reader was going to work out
     * anyway.
     */
    display?: string;
  };
  /** Raw series for the inline sparkline; two points minimum to draw anything. */
  trend?: number[];
  /**
   * Up to four supporting figures, between the hero and the footnote — gross
   * beside net, the statutory line beside the deduction total. Anything unknown
   * passes `null` and prints an em dash, on the same rule as `value`.
   */
  subStats?: Array<{ key: string; label: string; value: string | number | null }>;
  /** Makes the whole card a link. Every figure should drill somewhere. */
  href?: string;
  /** One short line in the footer: the context that stops a re-read. */
  footnote?: string;
}

/**
 * The icon chip's tint, and the accent the sparkline borrows.
 *
 * Only the chip and the delta carry colour. The hero figure stays in the heading
 * colour whatever the tone, because five cards each shouting in a different hue
 * is a traffic light, not a dashboard — the tone says where to look first, it is
 * not the message.
 */
const TONE_STYLES: Record<StatTone, { chip: string; spark: string }> = {
  default: { chip: 'bg-brand-primary/10 text-brand-primary', spark: 'var(--color-brand-primary)' },
  success: { chip: 'bg-status-success-bg text-status-success', spark: 'var(--color-status-success)' },
  warning: { chip: 'bg-status-warning-bg text-status-warning', spark: 'var(--color-status-warning)' },
  danger: { chip: 'bg-status-error-bg text-status-error', spark: 'var(--color-status-error)' },
  info: { chip: 'bg-status-info-bg text-status-info', spark: 'var(--color-status-info)' },
};

/** An em dash for anything the data cannot answer. */
function figure(value: string | number | null | undefined) {
  return value === null || value === undefined ? '—' : value;
}

function DeltaBadge({ delta }: { delta: NonNullable<KpiStat['delta']> }) {
  const good = (delta.goodDirection ?? 'up') === delta.direction;
  const Arrow = delta.direction === 'up' ? ArrowUpRight : ArrowDownRight;

  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-semibold ${
        good ? 'text-status-success' : 'text-status-error'
      }`}
    >
      <Arrow size={13} strokeWidth={2.5} className="shrink-0" aria-hidden />
      {delta.display ?? `${Math.abs(delta.value).toFixed(1)}%`}
    </span>
  );
}

function StatCardFace({ stat }: { stat: KpiStat }) {
  const tone = TONE_STYLES[stat.tone ?? 'default'];
  const Icon = stat.icon;
  // A sparkline of all zeros draws a flat line, which reads as "steady" — a
  // claim about a shape that is not in the data. No movement, no line.
  const sparkPath =
    stat.trend && stat.trend.some((v) => v > 0) ? generateSparkPath(stat.trend, 64, 24) : '';

  return (
    <div className="flex h-full flex-col justify-between p-5">
      <div>
        <div className="flex items-center gap-3">
          {Icon && (
            <span
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl shadow-xs ${tone.chip}`}
            >
              <Icon size={19} strokeWidth={2.2} aria-hidden />
            </span>
          )}
          {/* Two lines rather than one truncated one: "Contracts expiri…" is not
              a label, it is the beginning of one, and the reader cannot tell
              which card they are looking at. */}
          <span className="line-clamp-2 text-[13px] font-medium leading-snug text-text-body">
            {stat.label}
          </span>
        </div>

        <div className="mt-3.5 mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[28px] font-extrabold leading-tight tracking-tight tabular-nums text-text-heading lg:text-[32px]">
            {figure(stat.value)}
          </span>

          {sparkPath && (
            <svg
              viewBox="0 0 64 24"
              className="sparkline-mask h-6 w-16 shrink-0"
              fill="none"
              aria-hidden
            >
              <path
                d={sparkPath}
                stroke={tone.spark}
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </div>

      {stat.subStats && stat.subStats.length > 0 && (
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-surface-border/70 pt-2">
          {stat.subStats.map((s) => (
            <div key={s.key} className="min-w-0">
              <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {s.label}
              </p>
              <p className="truncate text-[13px] font-bold tabular-nums text-text-heading">
                {figure(s.value)}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex min-w-0 flex-col gap-0.5 pt-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {stat.delta && <DeltaBadge delta={stat.delta} />}
          <span className="line-clamp-2 text-[12px] font-normal leading-snug text-text-muted">
            {stat.delta?.label ?? stat.footnote ?? ''}
          </span>
        </div>
        {/* A delta and a footnote answer different questions — the movement, and
            the standing context needed to judge it — so one never replaces the
            other. */}
        {stat.delta?.label && stat.footnote && (
          <p className="line-clamp-2 text-[11px] font-normal leading-snug text-text-muted/80">
            {stat.footnote}
          </p>
        )}
      </div>
    </div>
  );
}

export function StatCard({ stat, index = 0 }: { stat: KpiStat; index?: number }) {
  // `kpi-<key>` is how a browser test names one figure among five identically
  // shaped cards; the key is stable while the label is translated.
  // Surface, border and radius come from `.surface-panel`; `.stat-card` adds
  // only the hover lift, so a KPI tile cannot drift from the rest of the page.
  const shell = 'stat-card surface-panel group flex h-full flex-col';

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.05 + index * 0.05 }}
      className="h-full"
    >
      {stat.href ? (
        // A real anchor, so middle-click and open-in-new-tab work on a figure
        // the reader wants to keep beside the one they are on.
        <Link href={stat.href} className={`${shell} block`} data-testid={`kpi-${stat.key}`}>
          <StatCardFace stat={stat} />
        </Link>
      ) : (
        <div className={shell} data-testid={`kpi-${stat.key}`}>
          <StatCardFace stat={stat} />
        </div>
      )}
    </motion.div>
  );
}

function StatCardSkeleton() {
  return (
    <div className="flex h-36 animate-pulse flex-col justify-between rounded-[20px] border border-surface-border bg-surface-card p-5">
      <div>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-surface-border" />
          <div className="h-3.5 w-24 rounded bg-surface-border" />
        </div>
        <div className="mt-4 h-8 w-28 rounded bg-surface-border" />
      </div>
      <div className="h-3 w-32 rounded bg-surface-border" />
    </div>
  );
}

/**
 * The KPI row at the top of a module hub.
 *
 * Capped at five columns: past that the figures stop being a glance and become a
 * table, which is the thing these pages exist to spare the reader.
 */
export function KpiRow({
  stats,
  loading = false,
  /**
   * Defaults to the number of cards about to be rendered.
   *
   * A hub builds its full `KpiStat[]` up front with `null` values and lets
   * `loading` decide what to draw, so `stats.length` is already the right
   * answer — and the grid picks its column count from that same length. A fixed
   * count leaves a five-card hub loading into a five-column grid with a hole.
   */
  skeletonCount,
}: {
  stats: KpiStat[];
  loading?: boolean;
  skeletonCount?: number;
}) {
  const columns =
    stats.length >= 5
      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5'
      : stats.length === 3
        ? 'grid-cols-1 sm:grid-cols-3'
        : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4';

  if (loading) {
    const skeletons = skeletonCount ?? stats.length ?? 4;
    return (
      <div className={`grid gap-4 ${columns}`}>
        {Array.from({ length: skeletons || 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (!stats.length) return null;

  return (
    <div className={`grid gap-4 ${columns}`}>
      {stats.map((stat, i) => (
        <StatCard key={stat.key} stat={stat} index={i} />
      ))}
    </div>
  );
}

export default StatCard;
