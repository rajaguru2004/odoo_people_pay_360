'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { compactFigureText, formatNumber } from '@/utils/formatters';
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
  /** Raw series for the sparkline row; two points minimum to draw anything. */
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

/*
 * Where a figure stops being printed in full, counted in CHARACTERS of the
 * string the caller already formatted.
 *
 * The narrowest this card ever gets is the five-column row on a laptop: a
 * ~1000px content area, four 16px gaps and `p-5` a side leave roughly 135px of
 * text. Twelve characters of the 28/32px hero want nearly 190px of that, which
 * is how "OMR 23,567.125" came to be painted past the card edge and read back
 * as "OMR 23,567.1" — a clipped figure is not a rounder figure, it is a
 * DIFFERENT one, and this one is believable, which is what makes it dangerous.
 *
 * Characters, not a measured element: a rule that reads the DOM answers
 * differently on first paint, in a screenshot and in jsdom, and cannot be
 * reasoned about from the source. The counts are deliberately generous, because
 * a card with room must still print the exact figure — abbreviation is the
 * fallback for the genuinely long, not the house style.
 */
const HERO_MAX_CHARS = 11;
const SUB_MAX_CHARS = 10;
const DELTA_MAX_CHARS = 14;
/**
 * The sparkline's own row, in px of the 24px-tall box it is drawn into.
 *
 * It used to sit beside the hero as a `shrink-0` sibling of a span that could
 * not shrink either, so a long figure never pushed it aside — the two simply
 * occupied the same pixels, which is the collision under the "19". Sizing that
 * shared line correctly means knowing how wide the digits came out, and the only
 * honest answer to that is a measurement this component refuses to take. So the
 * line is not shared at all: the trend keeps its own row, full width, where no
 * figure of any length can reach it. It costs a card with a trend ~24px of
 * height and buys a guarantee rather than an estimate.
 */
const SPARK_WIDTH = 148;

/**
 * What will be shown, and the full figure it may be standing in for.
 *
 * A `number` here is by definition a quantity — a period label reaches the card
 * as a string, already formatted by the hub that knew the calendar — so it is
 * grouped before anything else looks at it. That is worth doing for its own sake
 * (12,430 over 12430) and it is also what makes shortening safe: the shortener
 * abbreviates only a run a formatter has grouped or pointed, precisely so it
 * cannot mistake "Jun 2026" for two thousand of something.
 */
function fit(value: string | number | null | undefined, max: number) {
  const full = typeof value === 'number' ? formatNumber(value) : String(figure(value));
  const text = full.length > max ? compactFigureText(full) : full;
  return { text, full, abbreviated: text !== full };
}

/**
 * A figure that may be abbreviated without lying about itself.
 *
 * The short form keeps the exact one a hover away in `title`, and hands that
 * same exact one to assistive tech instead of the abbreviation: a screen reader
 * announcing "OMR twenty-three point six K" has quietly rounded somebody's
 * payroll on their behalf, and its listener has no hover to check it with.
 */
function Figure({ fitted, className }: { fitted: ReturnType<typeof fit>; className: string }) {
  return (
    <>
      <span
        className={className}
        title={fitted.abbreviated ? fitted.full : undefined}
        aria-hidden={fitted.abbreviated || undefined}
      >
        {fitted.text}
      </span>
      {fitted.abbreviated && <span className="sr-only">{fitted.full}</span>}
    </>
  );
}

/**
 * The hero steps DOWN a size before it is allowed to abbreviate, because a
 * slightly smaller exact figure beats a larger approximate one; the last step
 * only ever catches a value that had no number in it to shorten.
 */
function heroSize(length: number) {
  // Seven characters is what 28px of extrabold tabular digits fits in the ~135px
  // the narrowest card has; past that the type steps before the number does.
  if (length <= 7) return 'text-[28px] lg:text-[32px]';
  if (length <= HERO_MAX_CHARS) return 'text-[23px] lg:text-[26px]';
  return 'text-[19px] lg:text-[21px]';
}

function DeltaBadge({ delta }: { delta: NonNullable<KpiStat['delta']> }) {
  const good = (delta.goodDirection ?? 'up') === delta.direction;
  const Arrow = delta.direction === 'up' ? ArrowUpRight : ArrowDownRight;
  // An absolute money change is the one delta long enough to wrap off its own
  // arrow; it gets the hero's treatment rather than a second rule of its own.
  const fitted = fit(delta.display ?? `${Math.abs(delta.value).toFixed(1)}%`, DELTA_MAX_CHARS);

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-xs font-semibold ${
        good ? 'text-status-success' : 'text-status-error'
      }`}
      title={fitted.abbreviated ? fitted.full : undefined}
    >
      <Arrow size={13} strokeWidth={2.5} className="shrink-0" aria-hidden />
      {fitted.text}
      {fitted.abbreviated && <span className="sr-only">{fitted.full}</span>}
    </span>
  );
}

function StatCardFace({ stat }: { stat: KpiStat }) {
  const tone = TONE_STYLES[stat.tone ?? 'default'];
  const Icon = stat.icon;
  const hero = fit(stat.value, HERO_MAX_CHARS);

  // A sparkline of all zeros draws a flat line, which reads as "steady" — a
  // claim about a shape that is not in the data. No movement, no line.
  const hasShape = Boolean(stat.trend && stat.trend.some((v) => v > 0));
  // The path is GENERATED at the row's width rather than a 64px one stretched
  // into it, so the stroke keeps its weight; `none` then lets it fill the row
  // exactly instead of leaving a sliver the eye reads as crooked padding. The
  // trend is never dropped to make room — it is moved, and only ever occupies
  // space nothing else is using.
  const sparkPath = hasShape ? generateSparkPath(stat.trend as number[], SPARK_WIDTH, 24) : '';

  return (
    <div className="flex h-full min-w-0 flex-col justify-between p-5">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
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
          <span className="line-clamp-2 min-w-0 text-[13px] font-medium leading-snug text-text-body">
            {stat.label}
          </span>
        </div>

        {/* `min-w-0`: a flex and a grid child both default to `min-width:auto`,
            so nothing in this column would give way and the overflow left the
            card rather than wrapping inside it. The hero now has the line to
            itself, which is why it can have all of it. */}
        <div className="mt-3.5 mb-1.5 flex min-w-0 flex-col">
          <Figure
            fitted={hero}
            className={`min-w-0 break-words font-extrabold leading-tight tracking-tight tabular-nums text-text-heading ${heroSize(
              hero.text.length,
            )}`}
          />
        </div>

        {sparkPath && (
          <svg
            viewBox={`0 0 ${SPARK_WIDTH} 24`}
            preserveAspectRatio="none"
            className="sparkline-mask mb-1 h-6 w-full"
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

      {stat.subStats && stat.subStats.length > 0 && (
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-surface-border/70 pt-2">
          {stat.subStats.map((s) => {
            const sub = fit(s.value, SUB_MAX_CHARS);
            return (
              <div key={s.key} className="min-w-0">
                {/* Wrapped, never ellipsed. A shortened VALUE is at least still
                    visibly a figure; a shortened LABEL — "ACTIVE EMPL…" —
                    leaves a number on the card belonging to nothing. */}
                <p className="line-clamp-2 break-words text-[10px] font-semibold uppercase leading-[1.3] tracking-wide text-text-muted">
                  {s.label}
                </p>
                <Figure
                  fitted={sub}
                  className="block break-words text-[13px] font-bold tabular-nums text-text-heading"
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-2 flex min-w-0 flex-col gap-0.5 pt-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {stat.delta && <DeltaBadge delta={stat.delta} />}
          <span className="line-clamp-2 min-w-0 text-[12px] font-normal leading-snug text-text-muted">
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
  const shell = 'stat-card surface-panel group flex h-full min-w-0 flex-col';

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.05 + index * 0.05 }}
      className="h-full min-w-0"
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
