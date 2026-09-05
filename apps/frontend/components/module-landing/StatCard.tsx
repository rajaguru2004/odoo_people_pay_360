'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { generateSparkPath } from '@/utils/sparkUtils';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

export interface KpiStat {
  /** Stable key — also the React key, so it must not be the translated label. */
  key: string;
  /** Already translated by the caller; this component owns no strings. */
  label: string;
  /**
   * `null` while the number is genuinely unknown (the request failed, the
   * endpoint is role-gated for this user). Rendered as an em dash — never as a
   * zero, which is a claim the data does not support.
   */
  value: string | number | null;
  icon?: any;
  tone?: StatTone;
  /**
   * Change against the previous period. `goodDirection` decides the colour:
   * overtime hours rising is not the same news as headcount rising.
   */
  delta?: {
    value: number;
    direction: 'up' | 'down';
    goodDirection?: 'up' | 'down';
    label?: string;
    /**
     * What to print instead of the percentage — an already-formatted absolute
     * change ("₹31,200"). A percentage is the honest form for a rate, but for
     * money "up ₹31,200" is the sentence the reader was going to work out
     * anyway.
     */
    display?: string;
  };
  /** Raw series for the inline sparkline; two points minimum to draw anything. */
  trend?: number[];
  /**
   * Up to three supporting figures, printed between the hero and the footnote.
   *
   * A KPI card is mostly whitespace once the hero number is set, and the reader
   * then has to open another screen to learn the two figures that give the hero
   * its meaning — gross beside net, the statutory line beside the deduction
   * total. These put them on the card. Anything with no answer passes `null`
   * and prints an em dash, on the same rule as `value`.
   */
  subStats?: Array<{ key: string; label: string; value: string | number | null }>;
  /** Makes the whole card a link. Every KPI should drill somewhere. */
  href?: string;
  /** One short line in the footer: the context that stops a re-read. */
  footnote?: string;
}

/**
 * The icon chip's tint, and the accent the sparkline borrows.
 *
 * Only the chip and the delta carry colour. The value itself stays in the
 * heading colour whatever the tone, because five cards each shouting in a
 * different hue is a traffic light, not a dashboard — the tone is a hint about
 * where to look first, not the message.
 */
const TONE_STYLES: Record<StatTone, { chip: string; spark: string }> = {
  default: { chip: 'bg-brand-primary/10 text-brand-primary', spark: 'var(--color-brand-primary)' },
  success: { chip: 'bg-status-success-bg text-status-success', spark: 'var(--color-status-success)' },
  warning: { chip: 'bg-status-warning-bg text-status-warning', spark: 'var(--color-status-warning)' },
  danger: { chip: 'bg-status-error-bg text-status-error', spark: 'var(--color-status-error)' },
  info: { chip: 'bg-status-info-bg text-status-info', spark: 'var(--color-status-info)' },
};

function DeltaBadge({ delta }: { delta: NonNullable<KpiStat['delta']> }) {
  const good = (delta.goodDirection ?? 'up') === delta.direction;
  const Arrow = delta.direction === 'up' ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-semibold ${
        good ? 'text-status-success' : 'text-status-error'
      }`}
    >
      <Arrow size={13} strokeWidth={2.5} className="shrink-0" />
      {delta.display ?? `${Math.abs(delta.value).toFixed(1)}%`}
    </span>
  );
}

function CardBody({ stat }: { stat: KpiStat }) {
  const tone = TONE_STYLES[stat.tone ?? 'default'];
  const Icon = stat.icon;
  // A sparkline of all zeros draws a flat line, which reads as "steady" — a
  // claim about a shape that is not in the data. No data, no line.
  const hasTrend = Boolean(
    stat.trend && stat.trend.length > 1 && stat.trend.some((v) => v > 0),
  );

  return (
    <div className="p-5 flex flex-col justify-between h-full">
      {/* Top row: Icon chip + Label */}
      <div>
        <div className="flex items-center gap-3">
          {Icon && (
            <span className={`shrink-0 grid place-items-center w-10 h-10 rounded-xl shadow-xs ${tone.chip}`}>
              <Icon size={19} strokeWidth={2.2} />
            </span>
          )}
          {/* Two lines, not one truncated one. "Active employe…" and
              "Contracts expiri…" are not labels, they are the beginnings of
              labels, and the reader cannot tell which card they are looking at. */}
          <span className="text-[13px] font-medium text-text-body leading-snug line-clamp-2">
            {stat.label}
          </span>
        </div>

        {/* Hero Figure */}
        <div className="mt-3.5 mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[28px] lg:text-[32px] leading-tight font-extrabold tracking-tight tabular-nums text-text-heading">
            {stat.value === null || stat.value === undefined ? '—' : stat.value}
          </span>

          {hasTrend && (
            <svg viewBox="0 0 64 24" className="w-16 h-6 shrink-0 sparkline-mask" fill="none" aria-hidden>
              <path
                d={generateSparkPath(stat.trend!, 64, 24)}
                stroke={tone.spark}
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </div>

      {/* Supporting figures — the context that used to be an extra screen away */}
      {stat.subStats && stat.subStats.length > 0 && (
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-surface-border/70 pt-2">
          {stat.subStats.map((s) => (
            <div key={s.key} className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-text-muted font-semibold truncate">
                {s.label}
              </p>
              <p className="text-[13px] font-bold text-text-heading tabular-nums truncate">
                {s.value === null || s.value === undefined ? '—' : s.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Delta / Footnote Row */}
      <div className="mt-2 pt-2 flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          {stat.delta && <DeltaBadge delta={stat.delta} />}
          <span className="text-[12px] text-text-muted font-normal leading-snug line-clamp-2">
            {stat.delta?.label ?? stat.footnote ?? ''}
          </span>
        </div>
        {stat.delta?.label && stat.footnote && (
          <p className="text-[11px] text-text-muted/80 leading-snug line-clamp-2 font-normal">{stat.footnote}</p>
        )}
      </div>
    </div>
  );
}

export function StatCard({ stat, index = 0 }: { stat: KpiStat; index?: number }) {
  // Surface, border and radius all come from `.surface-panel`; `.stat-card`
  // adds the hover transition only.
  const shell = 'stat-card surface-panel group flex flex-col';
  const content = <CardBody stat={stat} />;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.05 + index * 0.05 }}
      className="h-full"
    >
      {stat.href ? (
        <Link href={stat.href} className={`${shell} h-full block`}>
          {content}
        </Link>
      ) : (
        <div className={`${shell} h-full`}>{content}</div>
      )}
    </motion.div>
  );
}

function StatCardSkeleton() {
  return (
    <div className="rounded-[20px] bg-surface-card border border-surface-border p-5 animate-pulse flex flex-col justify-between h-36">
      <div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-surface-border" />
          <div className="h-3.5 w-24 rounded bg-surface-border" />
        </div>
        <div className="mt-4 h-8 w-28 rounded bg-surface-border" />
      </div>
      <div className="h-3 w-32 rounded bg-surface-border" />
    </div>
  );
}

/**
 * The KPI row at the top of a module landing page.
 *
 * Deliberately capped at a five-column grid: past that the numbers stop being
 * a glance and become a table, which is the thing these pages exist to spare
 * the user.
 */
export function KpiRow({
  stats,
  loading = false,
  /**
   * Defaults to the number of cards the caller is about to render.
   *
   * Every hub builds its full `KpiStat[]` up front with `null` values and lets
   * `loading` decide what to draw, so `stats.length` is already the right
   * answer — and the grid below picks its column count from that same length.
   * A fixed 4 left every five-card hub loading into a five-column grid with a
   * hole in it. Falls back to 4 only when the caller genuinely has no cards yet.
   */
  skeletonCount,
}: {
  stats: KpiStat[];
  loading?: boolean;
  skeletonCount?: number;
}) {
  const skeletons = skeletonCount ?? stats.length ?? 4;
  const columns =
    stats.length >= 5
      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5'
      : stats.length === 3
      ? 'grid-cols-1 sm:grid-cols-3'
      : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4';

  if (loading) {
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
