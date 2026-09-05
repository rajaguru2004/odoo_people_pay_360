'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  MoreHorizontal,
  Plus,
  RotateCcw,
} from 'lucide-react';

/**
 * The panel and chart kit the module hubs are built from.
 *
 * Hand-rolled SVG and flexbox rather than a charting library: every shape here
 * is a bar, an arc or a line through a dozen points, and drawing them directly
 * keeps each one on the design tokens — which is what makes a hub readable when
 * the palette changes underneath it. Nothing in this file carries a literal
 * colour; a caller passes `var(--color-…)` or gets the brand default.
 *
 * Anything wider than its panel scrolls inside its own container, so a long
 * series never puts a horizontal scrollbar on the page.
 */

/* ── Panels ──────────────────────────────────────────────────────────────── */

export function PanelHeader({
  title,
  hint,
  action,
  showMenu = false,
  onMenuClick,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  /** The ⋯ affordance, drawn only where it opens something. */
  showMenu?: boolean;
  onMenuClick?: () => void;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[16px] font-bold leading-tight text-text-heading">{title}</h3>
        {hint && <p className="mt-1 text-[11px] leading-snug text-text-muted">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {action && <div className="text-[12px] font-semibold">{action}</div>}
        {showMenu && onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            className="rounded-lg p-1 text-text-muted transition-colors hover:bg-surface-page hover:text-text-heading"
            aria-label={`${title} options`}
          >
            <MoreHorizontal size={18} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

export function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="whitespace-nowrap text-xs font-semibold text-brand-primary hover:underline"
    >
      {children}
    </Link>
  );
}

/* ── Header controls ─────────────────────────────────────────────────────── */

export function SegmentedTimeFilter({
  options = ['Week', 'Month', 'Year'],
  selected,
  value,
  onChange,
}: {
  options?: string[];
  /**
   * The initial choice when the control keeps its own state. Defaults to the
   * first option, so a caller passing its own list cannot end up with a row
   * where nothing is selected.
   */
  selected?: string;
  /** Pass to make the control fully owned by the page. */
  value?: string;
  onChange?: (val: string) => void;
}) {
  const [internal, setInternal] = useState(selected ?? options[0]);
  // Controlled when the page passes `value`: a hub owns the period because the
  // ‹ › stepper and the charts read it too, and a second copy here would drift
  // the moment anything else moved it.
  const active = value ?? internal;

  return (
    <div className="inline-flex items-center rounded-xl border border-surface-border/60 bg-surface-page p-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => {
            setInternal(opt);
            onChange?.(opt);
          }}
          aria-pressed={active === opt}
          className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-all ${
            active === opt
              ? 'bg-surface-card text-text-heading shadow-xs'
              : 'text-text-muted hover:text-text-body'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

/**
 * Export, and — only where something is actually created from the hub — Add new.
 *
 * Both render solely when a handler exists. A button wired to nothing is not a
 * placeholder: the reader clicks it, nothing happens, and they stop trusting the
 * rest of the row.
 */
export function HeaderActionButtons({
  onExport,
  onAddNew,
  exportLabel = 'Export',
  addNewLabel = 'Add new',
  exportBusy = false,
}: {
  onExport?: () => void;
  onAddNew?: () => void;
  exportLabel?: string;
  addNewLabel?: string;
  exportBusy?: boolean;
}) {
  if (!onExport && !onAddNew) return null;

  return (
    <div className="flex items-center gap-2.5">
      {onExport && (
        <button
          type="button"
          onClick={onExport}
          disabled={exportBusy}
          className="inline-flex items-center gap-1.5 rounded-xl border border-surface-border bg-surface-card px-3.5 py-2 text-xs font-semibold text-text-heading shadow-xs transition-all hover:bg-surface-page disabled:cursor-wait disabled:opacity-60"
        >
          <Download size={14} strokeWidth={2.2} aria-hidden />
          <span>{exportLabel}</span>
        </button>
      )}

      {onAddNew && (
        <button
          type="button"
          onClick={onAddNew}
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand-primary px-4 py-2 text-xs font-semibold text-text-on-brand shadow-sm transition-all hover:bg-brand-primary-dark"
        >
          <Plus size={15} strokeWidth={2.5} aria-hidden />
          <span>{addNewLabel}</span>
        </button>
      )}
    </div>
  );
}

/**
 * `‹ August 2026 ›` — which window the page is showing, and how to move it.
 *
 * The label is passed in rather than formatted here: what "this week" means
 * depends on the branch's working week, and a control that guessed Monday would
 * disagree with the numbers beside it.
 *
 * Forward is disabled on the current period rather than hidden — a control that
 * vanishes makes the reader wonder what they did.
 */
export function PeriodNav({
  label,
  onPrev,
  onNext,
  canGoPrev = true,
  canGoNext = true,
  onReset,
  resetLabel,
  busy = false,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  /**
   * False while there is no window to step FROM.
   *
   * A caller that pages by anchors handed back with the data has nothing to
   * move to until the first payload lands, so a press before then is dropped.
   * A live control that quietly does nothing is worse than a dim one: the
   * reader presses it, the label does not change, and there is no way to tell a
   * slow answer from a broken button.
   */
  canGoPrev?: boolean;
  canGoNext?: boolean;
  /** Shown only once the view has been paged off the current period. */
  onReset?: () => void;
  resetLabel?: string;
  busy?: boolean;
}) {
  const arrow =
    'rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-page hover:text-text-heading disabled:opacity-35 disabled:hover:bg-transparent';

  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onPrev}
        disabled={!canGoPrev}
        className={arrow}
        aria-label="Previous period"
      >
        <ChevronLeft size={16} strokeWidth={2.5} aria-hidden className="rtl:rotate-180" />
      </button>
      <span
        // Named for a browser test: the period is the one thing on the row that
        // has no accessible name of its own to select by.
        data-testid="hub-period-label"
        className={`min-w-[124px] text-center text-xs font-bold tabular-nums text-text-heading transition-opacity ${
          busy ? 'opacity-50' : ''
        }`}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={!canGoNext}
        className={arrow}
        aria-label="Next period"
      >
        <ChevronRight size={16} strokeWidth={2.5} aria-hidden className="rtl:rotate-180" />
      </button>
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          // Named for what it does, not for where it lands: the period tabs
          // beside it already own the word "Today", and two controls with the
          // same accessible name on one row is a coin toss for anyone driving
          // the page by keyboard.
          aria-label="Back to the current period"
          className="ms-1 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-brand-primary transition-colors hover:bg-surface-page"
        >
          <RotateCcw size={12} strokeWidth={2.5} aria-hidden />
          {resetLabel}
        </button>
      )}
    </div>
  );
}

/* ── Ranked meters ───────────────────────────────────────────────────────── */

export interface MeterRow {
  key: string;
  label: string;
  /** 0–100. Clamped, so a caller cannot draw past the track. */
  percent: number;
  valueLabel: string;
  color?: string;
  /**
   * Where this line is explained or acted on.
   *
   * A meter that reads "No contract: 4" names a problem and leaves the reader to
   * go and find it. With an href the row becomes the way in, so the exception
   * and the screen that resolves it are one click apart.
   */
  href?: string;
  /** One short line under the label — what the number means, or what to do. */
  hint?: string;
}

export function MeterList({ rows, trackHeight = 16 }: { rows: MeterRow[]; trackHeight?: number }) {
  return (
    <div className="space-y-4">
      {rows.map((row) => {
        const pct = Math.max(0, Math.min(100, row.percent));
        const color = row.color ?? 'var(--color-brand-accent)';
        const heading = (
          <>
            <div className="flex items-center justify-between gap-3">
              <span
                className={`truncate text-[14px] font-semibold text-text-heading ${
                  row.href ? 'transition-colors group-hover/meter:text-brand-primary' : ''
                }`}
              >
                {row.label}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-[14px] font-bold tabular-nums text-text-heading">
                {row.valueLabel}
                {row.href && (
                  <ChevronRight
                    size={13}
                    aria-hidden
                    className="text-text-muted opacity-0 transition-opacity group-hover/meter:opacity-100 rtl:rotate-180"
                  />
                )}
              </span>
            </div>
            {row.hint && <p className="text-[11px] leading-snug text-text-muted">{row.hint}</p>}
          </>
        );

        return (
          <div key={row.key} className="group/meter space-y-1.5">
            {row.href ? (
              <Link
                href={row.href}
                className="-mx-1 block space-y-0.5 rounded-lg px-1 py-0.5 transition-colors hover:bg-surface-page"
              >
                {heading}
              </Link>
            ) : (
              <div className="space-y-0.5">{heading}</div>
            )}
            <div
              className="relative w-full overflow-hidden rounded-lg border border-surface-border/40 bg-surface-page p-0.5"
              style={{ height: trackHeight }}
            >
              {pct > 0 ? (
                <div
                  className="relative flex h-full items-center justify-end rounded-md transition-all duration-500 ease-out"
                  style={{ width: `${pct}%`, background: color }}
                >
                  {/* End cap, so a bar that nearly fills the track still shows
                      where it stops. Tinted with the card surface rather than a
                      flat black, so it stays a notch rather than a smudge
                      whatever the palette underneath. */}
                  <span className="h-full w-1.5 shrink-0 rounded-xs bg-surface-card/40" />
                </div>
              ) : (
                // A zero row keeps a sliver of its colour rather than an empty
                // track: the category is present in the data and reads as zero,
                // not as missing.
                <div className="h-full w-1 rounded-md opacity-20" style={{ background: color }} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Segmented bar ───────────────────────────────────────────────────────── */

export interface BarSegment {
  key: string;
  label: string;
  value: number;
  color: string;
  shareLabel?: string;
  /** Where the records behind this segment are listed. Same rule as `MeterRow`. */
  href?: string;
}

/**
 * One bar split by proportion, with the legend that reads it.
 *
 * `flexGrow: value` rather than percentage widths: no arithmetic, so no rounding
 * drift leaves a hairline of background at the end of the bar.
 */
export function SegmentedBar({
  segments,
  height = 14,
  legendColumns = 1,
}: {
  segments: BarSegment[];
  height?: number;
  legendColumns?: 1 | 2;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  return (
    <div>
      <div className="flex items-stretch gap-1.5" style={{ height }}>
        {total === 0 ? (
          <span className="flex-1 rounded-full bg-surface-border/50" />
        ) : (
          segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <span
                key={s.key}
                className="rounded-full shadow-2xs transition-[flex-grow] duration-500 ease-out"
                style={{ flexGrow: s.value, flexBasis: 0, minWidth: 8, background: s.color }}
                title={`${s.label}: ${s.value}`}
              />
            ))
        )}
      </div>

      <div className={`mt-4 grid gap-x-6 gap-y-2.5 ${legendColumns === 2 ? 'sm:grid-cols-2' : ''}`}>
        {segments.map((s) => {
          const inner = (
            <>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="truncate text-[13px] font-medium text-text-body">{s.label}</span>
              <span className="ms-auto flex shrink-0 items-baseline gap-3">
                <span className="text-[13px] font-bold tabular-nums text-text-heading">{s.value}</span>
                {s.shareLabel && (
                  <span className="w-9 text-[12px] font-semibold tabular-nums text-text-muted text-end">
                    {s.shareLabel}
                  </span>
                )}
              </span>
            </>
          );

          return s.href ? (
            <Link
              key={s.key}
              href={s.href}
              className="-mx-1 flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-0.5 transition-colors hover:bg-surface-page hover:text-brand-primary"
            >
              {inner}
            </Link>
          ) : (
            <div key={s.key} className="flex min-w-0 items-center gap-2.5">
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Donut ───────────────────────────────────────────────────────────────── */

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function DonutChart({
  slices,
  size = 180,
  thickness = 22,
  caption,
  subCaption,
  gapDegrees = 4,
}: {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  /** The figure in the hole — usually the total the slices add up to. */
  caption?: string;
  subCaption?: string;
  gapDegrees?: number;
}) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = (gapDegrees / 360) * circumference;

  // A zero slice is dropped rather than drawn as a hairline, and each arc is
  // rotated by everything before it — summed up front rather than carried in a
  // mutable counter, so the ring is a pure function of the slices.
  const drawn = slices.filter((s) => s.value > 0);
  const arcs = drawn.map((s, i) => {
    const before = drawn.slice(0, i).reduce((sum, prev) => sum + prev.value, 0);
    const fraction = total > 0 ? s.value / total : 0;
    return {
      ...s,
      length: Math.max(fraction * circumference - gap, 0),
      rotation: (before / (total || 1)) * 360,
    };
  });

  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90" aria-hidden>
        {/* The track always draws, so an empty ring reads as "nothing yet"
            rather than as a chart that failed to render. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-surface-border)"
          strokeWidth={thickness}
          opacity={0.6}
        />
        {arcs.map((arc) => (
          <circle
            key={arc.key}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={arc.color}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={`${arc.length} ${circumference - arc.length}`}
            style={{
              transform: `rotate(${arc.rotation}deg)`,
              transformOrigin: '50% 50%',
              transition: 'stroke-dasharray 0.6s ease-out',
            }}
          />
        ))}
      </svg>

      {caption && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[26px] font-extrabold leading-none tabular-nums text-text-heading">
            {caption}
          </span>
          {subCaption && (
            <span className="mt-1 text-[11px] font-medium text-text-muted">{subCaption}</span>
          )}
        </div>
      )}
    </div>
  );
}

export function DonutLegend({ slices, total }: { slices: DonutSlice[]; total: number }) {
  return (
    <div className="space-y-3.5">
      {slices.map((s) => (
        <div key={s.key} className="flex min-w-0 items-center gap-3">
          <span className="h-3 w-3 shrink-0 rounded-md" style={{ background: s.color }} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold leading-tight text-text-heading">
              {s.label}
            </p>
            <p className="mt-0.5 text-[12px] leading-tight tabular-nums text-text-muted">{s.value}</p>
          </div>
          {/* No total, no share: 0% would claim a proportion of nothing. */}
          <span className="ms-auto shrink-0 text-[13px] font-bold tabular-nums text-text-heading">
            {total > 0 ? `${Math.round((s.value / total) * 100)}%` : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Bar overview ────────────────────────────────────────────────────────── */

export interface BarOverviewRow {
  label: string;
  value: string | number;
  /** Swatch colour; a row without one prints as a plain label/value pair. */
  color?: string;
  /** Sets the row apart above a rule — for the total under its parts. */
  emphasis?: boolean;
}

/** One band of a stacked bar, drawn bottom-first in array order. */
export interface BarStackPart {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface BarOverviewItem {
  key: string;
  label: string;
  /** Sets the bar's height against `maxVal`, and the total its bands sum to. */
  value: number;
  /**
   * Proportional bands, bottom-first — present against absent, or the four
   * request statuses. The reader can compare band heights across bars, which is
   * the thing a single-tone bar cannot show.
   */
  segments?: BarStackPart[];
  highlight?: boolean;
  tooltipTitle?: string;
  primaryLabel?: string;
  secondaryValue?: number;
  secondaryLabel?: string;
  /**
   * The whole tooltip, when two numbers are not enough. A day of attendance
   * needs expected, present, late and absent AND the rate to be readable — the
   * rate alone hides the headcount it came from, the counts alone make the
   * reader divide.
   */
  tooltipRows?: BarOverviewRow[];
}

export function BarOverviewChart({
  items,
  height = 250,
  maxVal = 60,
  yAxisTicks = ['0', '12', '24', '36', '48', '60'],
  primaryColor = 'var(--color-brand-primary)',
  primaryLightColor = 'color-mix(in srgb, var(--color-brand-primary) 55%, var(--color-surface-card))',
  openHighlightTooltip = true,
  minBarWidth,
}: {
  items: BarOverviewItem[];
  /** Pixels, or a CSS length ("100%") to fill a flex parent. */
  height?: number | string;
  maxVal?: number;
  yAxisTicks?: string[];
  primaryColor?: string;
  primaryLightColor?: string;
  /**
   * The narrowest a bar may get before the plot scrolls instead of shrinking.
   *
   * Unset, the bars share the panel however many there are — right for a dozen
   * buckets. Set it for a long series: the plot then scrolls INSIDE its own
   * container, with the y-axis staying put, rather than widening the page. The
   * x-labels scroll with the bars because they live in the same scroller;
   * anything else drifts out of alignment the moment it moves.
   */
  minBarWidth?: number;
  /**
   * Whether the highlighted bar opens its tooltip at rest.
   *
   * True is right for a chart whose highlighted bar IS the sentence the panel is
   * making. On a stacked chart the card sits over the bands it describes and
   * clips against the panel edge on the first and last bucket, so those pass
   * false and let hover do the work. The bar is tinted either way.
   */
  openHighlightTooltip?: boolean;
}) {
  const defaultHighlightIdx = items.findIndex((it) => it.highlight);
  // Seeded from the highlight so the chart can arrive with one card showing —
  // but only when the caller asked for that, or the opt-out below is silently
  // ineffective and the tooltip opens anyway on first paint.
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(
    openHighlightTooltip && defaultHighlightIdx !== -1 ? defaultHighlightIdx : null,
  );

  /** Print every nth x-label so a month of bars does not collapse into "Au…". */
  const labelEvery = Math.max(1, Math.ceil(items.length / 12));
  const plotMinWidth = minBarWidth ? items.length * minBarWidth : undefined;
  const activeIdx = hoveredIdx ?? (defaultHighlightIdx !== -1 ? defaultHighlightIdx : null);

  return (
    <div className="relative flex w-full" style={{ height }}>
      {/* The axis sits outside the scroller so it stays legible while a long
          series is scrolled sideways. */}
      <div className="flex h-[calc(100%-28px)] flex-col justify-between pe-3 text-[12px] font-medium text-text-muted select-none">
        {[...yAxisTicks].reverse().map((tick, i) => (
          <span key={i} className="leading-none text-end">
            {tick}
          </span>
        ))}
      </div>

      <div className={`min-w-0 flex-1 ${plotMinWidth ? 'overflow-x-auto' : ''}`}>
        <div className="flex h-[calc(100%-28px)] w-full">
          <div
            className="relative flex flex-1 items-end justify-between gap-3 border-b border-surface-border px-2"
            style={{ minWidth: plotMinWidth }}
          >
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
              {yAxisTicks.map((_, i) => (
                <div key={i} className="h-0 w-full border-b border-dashed border-surface-border/60" />
              ))}
            </div>

            {items.map((it, idx) => {
              const isHovered = hoveredIdx === idx;
              const isDefaultHighlight = Boolean(it.highlight) && hoveredIdx === null;
              // Colour and tooltip are separate decisions: a ranking chart wants
              // its leading bar tinted without talking over the panel title.
              const isActive = isHovered || isDefaultHighlight;
              const showTooltip = isHovered || (isDefaultHighlight && openHighlightTooltip);
              // A floor of 8%: a bar of one unit against a max of sixty is a line
              // the reader cannot hover, and an unreachable tooltip hides the
              // number entirely.
              const pct = Math.min(100, Math.max(8, (it.value / (maxVal || 1)) * 100));

              const tooltipRows: BarOverviewRow[] =
                it.tooltipRows ??
                (it.segments?.length
                  ? [
                      ...it.segments.map((part) => ({
                        label: part.label,
                        value: part.value,
                        color: part.color,
                      })),
                      { label: 'Total', value: it.value, emphasis: true },
                    ]
                  : [
                      { label: it.primaryLabel ?? 'Total', value: it.value, color: primaryColor },
                      ...(it.secondaryValue !== undefined
                        ? [
                            {
                              label: it.secondaryLabel ?? 'Present',
                              value: it.secondaryValue,
                              color: primaryLightColor,
                            },
                          ]
                        : []),
                    ]);

              return (
                <div
                  key={it.key}
                  className="relative z-10 flex h-full flex-1 flex-col items-center justify-end"
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() =>
                    setHoveredIdx(
                      openHighlightTooltip && defaultHighlightIdx !== -1 ? defaultHighlightIdx : null,
                    )
                  }
                >
                  {showTooltip && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      // Anchored to the top of the PLOT area, not above it: this
                      // wrapper is the full-height bar column, so a negative offset
                      // floats the card out of the panel and onto its title.
                      className="pointer-events-none absolute top-0 z-30 min-w-[155px] rounded-2xl border border-surface-border bg-surface-card p-3 shadow-xl"
                    >
                      <p className="mb-2 text-[12px] font-bold text-text-heading">
                        {it.tooltipTitle ?? it.label}
                      </p>
                      <div className="space-y-1.5">
                        {tooltipRows.map((row, rowIdx) => (
                          <div
                            key={`${row.label}-${rowIdx}`}
                            className={`flex items-center justify-between gap-3 text-[11px] ${
                              row.emphasis ? 'mt-0.5 border-t border-surface-border pt-1.5' : ''
                            }`}
                          >
                            <span
                              className={`flex items-center gap-1.5 font-medium ${
                                row.emphasis ? 'font-bold text-text-heading' : 'text-text-muted'
                              }`}
                            >
                              {row.color && (
                                <span
                                  className="h-3.5 w-2.5 shrink-0 rounded-xs"
                                  style={{ background: row.color }}
                                />
                              )}
                              {row.label}
                            </span>
                            <span className="font-bold tabular-nums text-text-heading">{row.value}</span>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {it.segments?.length ? (
                    // `flex-col-reverse` + `flexGrow: value` is the proportional
                    // trick the segmented bar uses, for the same reason: no
                    // percentage arithmetic, so no rounding gap at the top of the
                    // stack. Zero bands are dropped rather than drawn as slivers.
                    <div
                      className={`flex w-full max-w-[46px] flex-col-reverse overflow-hidden rounded-t-xl transition-all duration-300 ${
                        isActive ? 'shadow-sm' : ''
                      }`}
                      style={{ height: `${pct}%`, opacity: isActive ? 1 : 0.82 }}
                    >
                      {it.segments
                        .filter((part) => part.value > 0)
                        .map((part) => (
                          <span
                            key={part.key}
                            className="w-full transition-[flex-grow] duration-500 ease-out"
                            style={{
                              flexGrow: part.value,
                              flexBasis: 0,
                              minHeight: 2,
                              background: part.color,
                            }}
                            title={`${part.label}: ${part.value}`}
                          />
                        ))}
                    </div>
                  ) : isActive ? (
                    <div
                      className="flex w-full max-w-[46px] flex-col justify-end gap-[3px] transition-all duration-300"
                      style={{ height: `${pct}%` }}
                    >
                      <div
                        className="h-[32%] w-full rounded-t-xl rounded-b-xs shadow-2xs"
                        style={{ background: primaryLightColor }}
                      />
                      <div
                        className="w-full flex-1 rounded-t-xs rounded-b-sm shadow-2xs"
                        style={{ background: primaryColor }}
                      />
                    </div>
                  ) : (
                    <div
                      className="w-full max-w-[46px] rounded-t-xl border border-surface-border transition-all duration-300"
                      style={{ height: `${pct}%`, background: 'var(--color-surface-border)' }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {/* X axis. A month is 31 bars and 31 labels do not fit, so past ~12
            items only every nth prints — the alternative is a row of "Au…"
            naming no day at all. The active bar always keeps its label,
            because that is the one being read. */}
        <div
          className="flex min-w-0 justify-between pt-2 pe-2 ps-2 text-[12px] font-medium text-text-muted select-none"
          style={{ minWidth: plotMinWidth }}
        >
          {items.map((it, idx) => {
            const isActive = hoveredIdx === idx || (hoveredIdx === null && it.highlight);
            // A scheduled label too close to the active one is dropped, or the two
            // run together ("21 Aug22 Aug").
            const show =
              isActive ||
              (idx % labelEvery === 0 &&
                (activeIdx === null || Math.abs(idx - activeIdx) >= labelEvery));

            return (
              <span
                key={it.key}
                title={it.label}
                // Two behaviours, because two kinds of label pass through here.
                // Thinned labels are dates: short, with blank slots beside them, so
                // they may spill sideways rather than truncate to nothing. Unthinned
                // ones are categories — a department name can be any length, and
                // `whitespace-nowrap` on those pushes the flex row wider than the
                // panel and puts a scrollbar on the page. `min-w-0` on both: a flex
                // item otherwise refuses to shrink below its content, which is the
                // mechanism that widens the row.
                className={`min-w-0 flex-1 text-center ${
                  labelEvery > 1
                    ? 'overflow-visible whitespace-nowrap'
                    : 'line-clamp-2 leading-tight break-words'
                } ${isActive ? 'font-extrabold text-text-heading' : 'text-text-muted'}`}
              >
                {show ? it.label : ''}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Spline trend ────────────────────────────────────────────────────────── */

/**
 * A smooth path through `values` inside a `width` × `height` box.
 *
 * Cardinal-spline control points derived from the neighbouring points, rather
 * than fixed `Q`/`T` handles: a hard-coded curve draws the same pretty shape
 * whatever the numbers are, which is a picture of nothing.
 */
function splinePath(
  values: number[],
  width: number,
  height: number,
  max: number,
  tension = 0.35,
): string {
  if (values.length === 0) return '';
  const safeMax = max > 0 ? max : 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const pts = values.map((v, i) => ({
    x: i * step,
    y: height - (Math.max(0, v) / safeMax) * height,
  }));

  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y} L ${width} ${pts[0].y}`;

  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension * 2;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension * 2;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension * 2;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension * 2;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

export interface SplineSeries {
  key: string;
  values: number[];
  color: string;
}

/**
 * Curves over a shared x-axis — arrivals through the day, on time against late,
 * which is how a 09:30 spike becomes visible instead of averaging into "some
 * people were late".
 */
export function SplineTrendChart({
  height = 140,
  series,
  timeTicks = ['12 AM', '6 AM', '12 PM', '6 PM', '11 PM'],
  emptyLabel,
}: {
  height?: number;
  /** Omit to draw the grid alone — never a decorative curve. */
  series?: SplineSeries[];
  timeTicks?: string[];
  emptyLabel?: string;
}) {
  const W = 300;
  const H = 100;
  const lines = series ?? [];
  const peak = Math.max(1, ...lines.flatMap((l) => l.values));
  const hasAny = lines.some((l) => l.values.some((v) => v > 0));

  return (
    <div className="relative w-full" style={{ height }}>
      <div className="relative h-[calc(100%-24px)] w-full">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-full w-full overflow-visible"
          aria-hidden
        >
          {[20, 50, 80].map((y) => (
            <line
              key={y}
              x1="0"
              y1={y}
              x2={W}
              y2={y}
              stroke="var(--color-surface-border)"
              strokeDasharray="3 3"
              opacity="0.6"
            />
          ))}

          {/* Drawn back to front so the first series sits on top. Nothing is
              drawn when every value is zero: a flat line along the axis IS a
              curve, and one under the words "nobody clocked in" tells the reader
              two different things. */}
          {hasAny &&
            [...lines].reverse().map((l) => (
              <path
                key={l.key}
                d={splinePath(l.values, W, H - 6, peak)}
                fill="none"
                stroke={l.color}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                transform="translate(0, 3)"
              />
            ))}
        </svg>

        {!hasAny && emptyLabel && (
          <span className="absolute inset-0 grid place-items-center text-[11px] font-medium text-text-muted">
            {emptyLabel}
          </span>
        )}
      </div>

      <div className="flex justify-between pt-1 text-[10px] font-medium text-text-muted select-none">
        {timeTicks.map((tick, i) => (
          <span key={i}>{tick}</span>
        ))}
      </div>
    </div>
  );
}

/* ── Tooltip card ────────────────────────────────────────────────────────── */

export interface TooltipRow {
  label: string;
  value: string;
  color: string;
}

/** The floating card a chart hands its hovered point to. */
export function ChartTooltipCard({ title, rows }: { title?: string; rows: TooltipRow[] }) {
  if (!rows.length) return null;

  return (
    <div className="min-w-[180px] rounded-xl border border-surface-border bg-surface-overlay px-3.5 py-3 shadow-xl">
      {title && <p className="mb-2 text-[13px] font-bold text-text-heading">{title}</p>}
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
            <span className="text-[12px] text-text-muted">{row.label}</span>
            <span className="ms-auto text-[12px] font-bold tabular-nums text-text-heading">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
