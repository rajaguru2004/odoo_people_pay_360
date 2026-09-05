'use client';

import { ReactNode, useState } from 'react';
import Link from 'next/link';
import { MoreHorizontal, Download, Plus, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
// ChevronRight doubles as the "this row goes somewhere" affordance on MeterList
// and SegmentedBar, so it is imported once for the whole file.
import { motion } from 'framer-motion';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MODULE LANDING PRIMITIVES — Pixel-Perfect Reference Implementation
 * ─────────────────────────────────────────────────────────────────────────────
 * High-polish visual primitives matching the reference design layout & geometry.
 */

/* ── Panel Header ─────────────────────────────────────────────────────────── */

export function PanelHeader({
  title,
  hint,
  action,
  showMenu = true,
  onMenuClick,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  showMenu?: boolean;
  onMenuClick?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <div className="min-w-0">
        <h3 className="text-[16px] font-bold text-text-heading leading-tight">{title}</h3>
        {hint && <p className="mt-1 text-[11px] text-text-muted leading-snug">{hint}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {action && <div className="text-[12px] font-semibold">{action}</div>}
        {showMenu && (
          <button
            type="button"
            onClick={onMenuClick}
            className="p-1 rounded-lg text-text-muted hover:text-text-heading hover:bg-surface-page transition-colors cursor-pointer"
            aria-label="Options"
          >
            <MoreHorizontal size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

export function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-brand-primary hover:underline whitespace-nowrap text-xs font-semibold">
      {children}
    </Link>
  );
}

/* ── Segmented Time Filter & Action Buttons ──────────────────────────────── */

export function SegmentedTimeFilter({
  options = ['Week', 'Month', 'Years'],
  selected = 'Month',
  value,
  onChange,
}: {
  options?: string[];
  selected?: string;
  /** Pass to make the control fully controlled by the parent. */
  value?: string;
  onChange?: (val: string) => void;
}) {
  const [internal, setInternal] = useState(selected);
  // Controlled when the parent passes `value`: the time hub owns the period
  // because the ‹ › arrows and the chart read it too, and a second copy of it
  // here would drift the moment anything else changed it.
  const active = value ?? internal;

  const handleSelect = (opt: string) => {
    setInternal(opt);
    onChange?.(opt);
  };

  return (
    <div className="inline-flex items-center p-1 bg-surface-page/90 dark:bg-surface-page rounded-xl border border-surface-border/60">
      {options.map((opt) => {
        const isSelected = active === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => handleSelect(opt)}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              isSelected
                ? 'bg-surface-card text-text-heading shadow-xs'
                : 'text-text-muted hover:text-text-body'
            }`}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Export, and — only where something is actually created from the hub — Add new.
 *
 * Both render solely when a handler exists. A button wired to nothing is not a
 * placeholder in this codebase, it is a defect: the reader clicks it, nothing
 * happens, and they stop trusting the rest of the row.
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
        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl bg-surface-card border border-surface-border text-text-heading hover:bg-surface-page transition-all shadow-xs cursor-pointer disabled:opacity-60 disabled:cursor-wait"
      >
        <Download size={14} strokeWidth={2.2} />
        <span>{exportLabel}</span>
      </button>
      )}

      {onAddNew && (
      <button
        type="button"
        onClick={onAddNew}
        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand transition-all shadow-sm shadow-brand-primary/20 cursor-pointer"
      >
        <Plus size={15} strokeWidth={2.5} />
        <span>{addNewLabel}</span>
      </button>
      )}
    </div>
  );
}

/**
 * `‹ August 2026 ›` — which window the page is showing, and how to move it.
 *
 * The label is server-rendered, not formatted here: what "this week" means
 * depends on the branch's working week, and a client that guessed Monday would
 * disagree with the numbers beside it every Sunday in Muscat.
 *
 * Forward is disabled on the current period rather than hidden — a control that
 * vanishes makes the reader wonder what they did.
 */
export function PeriodNav({
  label,
  onPrev,
  onNext,
  canGoNext = true,
  onReset,
  resetLabel,
  busy = false,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  canGoNext?: boolean;
  /** Shown only when the view has been paged off the current period. */
  onReset?: () => void;
  resetLabel?: string;
  busy?: boolean;
}) {
  const arrow =
    'p-1.5 rounded-lg text-text-muted hover:text-text-heading hover:bg-surface-page transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent';

  return (
    <div className="inline-flex items-center gap-1">
      <button type="button" onClick={onPrev} className={arrow} aria-label="Previous period">
        <ChevronLeft size={16} strokeWidth={2.5} className="rtl:rotate-180" />
      </button>
      <span
        data-testid="period-label"
        className={`min-w-[124px] text-center text-xs font-bold text-text-heading tabular-nums transition-opacity ${
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
        <ChevronRight size={16} strokeWidth={2.5} className="rtl:rotate-180" />
      </button>
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          // Named for what it does, not for where it lands: the period tabs
          // beside it already own the word "Today", and two controls with the
          // same accessible name on one row is a coin toss for anyone driving
          // this by keyboard or screen reader.
          aria-label="Back to the current period"
          className="ms-1 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-brand-primary hover:bg-surface-page transition-colors cursor-pointer"
        >
          <RotateCcw size={12} strokeWidth={2.5} />
          {resetLabel}
        </button>
      )}
    </div>
  );
}

/* ── Meter Row / Categories Capsule List (Matching Reference Image 2) ─────── */

export interface MeterRow {
  key: string;
  label: string;
  percent: number;
  valueLabel: string;
  color?: string;
  /**
   * Where this line is explained or acted on.
   *
   * A meter that says "No bank record: 1" names a problem and then leaves the
   * reader to go and find it. With an href the row becomes the way in, so the
   * exception and the screen that resolves it are one click apart.
   */
  href?: string;
  /** One short line under the label — what the number means, or what to do. */
  hint?: string;
}

/**
 * Ranked horizontal capsule progress meters matching reference "Top selling categories".
 */
export function MeterList({
  rows,
  trackHeight = 16,
}: {
  rows: MeterRow[];
  trackHeight?: number;
}) {
  return (
    <div className="space-y-4">
      {rows.map((row) => {
        const pct = Math.max(0, Math.min(100, row.percent));
        const color = row.color ?? 'var(--color-brand-accent, #FF5A1F)';
        const heading = (
          <>
            <div className="flex items-center justify-between gap-3">
              <span
                className={`text-[14px] font-semibold text-text-heading truncate ${
                  row.href ? 'group-hover/meter:text-brand-primary transition-colors' : ''
                }`}
              >
                {row.label}
              </span>
              <span className="text-[14px] font-bold text-text-heading tabular-nums shrink-0 inline-flex items-center gap-1">
                {row.valueLabel}
                {row.href && (
                  <ChevronRight
                    size={13}
                    className="text-text-muted opacity-0 group-hover/meter:opacity-100 transition-opacity rtl:rotate-180"
                  />
                )}
              </span>
            </div>
            {row.hint && (
              <p className="text-[11px] text-text-muted leading-snug">{row.hint}</p>
            )}
          </>
        );
        return (
          <div key={row.key} className="space-y-1.5 group/meter">
            {row.href ? (
              <Link href={row.href} className="block space-y-0.5 rounded-lg -mx-1 px-1 py-0.5 hover:bg-surface-page transition-colors">
                {heading}
              </Link>
            ) : (
              <div className="space-y-0.5">{heading}</div>
            )}
            <div
              className="relative w-full rounded-lg bg-[#F5F6F8] dark:bg-surface-page overflow-hidden p-0.5 border border-surface-border/40"
              style={{ height: trackHeight }}
            >
              {pct > 0 ? (
                <div
                  className="relative h-full rounded-md transition-all duration-600 ease-out flex items-center justify-end"
                  style={{
                    width: `${pct}%`,
                    background: color,
                  }}
                >
                  {/* Vertical end cap thumb matching reference image 2 */}
                  <div
                    className="w-1.5 h-full rounded-xs bg-black/15 shrink-0"
                    style={{ borderLeft: '1px solid rgba(255,255,255,0.4)' }}
                  />
                </div>
              ) : (
                <div
                  className="h-full rounded-md opacity-20"
                  style={{ width: '4px', background: color }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Segmented Bar / Stock Overview ──────────────────────────────────────── */

export interface BarSegment {
  key: string;
  label: string;
  value: number;
  color: string;
  shareLabel?: string;
  /** Where the people behind this segment are listed. Same rule as `MeterRow.href`. */
  href?: string;
}

export function SegmentedBar({
  segments,
  height = 14,
  legendColumns = 1,
}: {
  segments: BarSegment[];
  height?: number;
  legendColumns?: 1 | 2;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const visible = segments.filter((s) => s.value > 0);

  return (
    <div>
      <div className="flex items-stretch gap-1.5" style={{ height }}>
        {total === 0 ? (
          <span className="flex-1 rounded-full bg-surface-border/50 dark:bg-surface-page" />
        ) : (
          visible.map((s) => (
            <span
              key={s.key}
              className="rounded-full transition-[flex-grow] duration-500 ease-out shadow-2xs"
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
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} />
              <span className="text-[13px] font-medium text-text-body truncate">{s.label}</span>
              <span className="ms-auto flex items-baseline gap-3 shrink-0">
                <span className="text-[13px] font-bold text-text-heading tabular-nums">{s.value}</span>
                {s.shareLabel && (
                  <span className="text-[12px] font-semibold text-text-muted tabular-nums w-9 text-end">
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
              className="flex items-center gap-2.5 min-w-0 rounded-lg -mx-1 px-1 py-0.5 hover:bg-surface-page hover:text-brand-primary transition-colors"
            >
              {inner}
            </Link>
          ) : (
            <div key={s.key} className="flex items-center gap-2.5 min-w-0">
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Donut Chart & Legend / Sales by Platform ────────────────────────────── */

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
  caption?: string;
  subCaption?: string;
  gapDegrees?: number;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = (gapDegrees / 360) * circumference;

  let offset = 0;
  const arcs = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const fraction = total > 0 ? s.value / total : 0;
      const length = Math.max(fraction * circumference - gap, 0);
      const arc = { ...s, length, rotation: (offset / (total || 1)) * 360 };
      offset += s.value;
      return arc;
    });

  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full -rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-surface-border)"
          strokeWidth={thickness}
          opacity={0.6}
        />
        {arcs.map((a) => (
          <circle
            key={a.key}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={a.color}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={`${a.length} ${circumference - a.length}`}
            style={{
              transform: `rotate(${a.rotation}deg)`,
              transformOrigin: '50% 50%',
              transition: 'stroke-dasharray 0.6s ease-out',
            }}
          />
        ))}
      </svg>

      {caption && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[26px] leading-none font-extrabold text-text-heading tabular-nums">
            {caption}
          </span>
          {subCaption && <span className="mt-1 text-[11px] font-medium text-text-muted">{subCaption}</span>}
        </div>
      )}
    </div>
  );
}

export function DonutLegend({ slices, total }: { slices: DonutSlice[]; total: number }) {
  return (
    <div className="space-y-3.5">
      {slices.map((s) => (
        <div key={s.key} className="flex items-center gap-3 min-w-0">
          <span className="w-3 h-3 rounded-md shrink-0" style={{ background: s.color }} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-text-heading truncate leading-tight">{s.label}</p>
            <p className="text-[12px] text-text-muted tabular-nums leading-tight mt-0.5">
              {s.value}
            </p>
          </div>
          <span className="ms-auto text-[13px] font-bold text-text-heading tabular-nums shrink-0">
            {total > 0 ? `${Math.round((s.value / total) * 100)}%` : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Bar Overview Chart / Sales Overview Style (Matching Reference Image 1) ─ */

export interface BarOverviewRow {
  label: string;
  value: string | number;
  /** Swatch colour; omitted rows print as a plain label/value pair. */
  color?: string;
  /** Renders above the value in the heading colour — for a headline rate. */
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
  value: number;
  /**
   * Real stacked bands, bottom-first.
   *
   * NOT the same thing as the 2-tone body an active bar has always drawn: that
   * is a fixed 32% cap, decoration that means nothing. These are proportional —
   * `Scheduled` against `Unassigned`, or the four leave statuses — and the
   * reader can compare band heights across bars.
   *
   * `value` still sets the bar's HEIGHT against `maxVal`. Pass the same total
   * the bands sum to, or the stack will not fill the bar.
   */
  segments?: BarStackPart[];
  highlight?: boolean;
  tooltipTitle?: string;
  primaryLabel?: string;
  secondaryValue?: number;
  secondaryLabel?: string;
  /**
   * The whole tooltip, when two numbers are not enough. A day of attendance
   * needs expected/present/late/absent AND the rate to be readable — the rate
   * alone hides the headcount it came from, the counts alone make the reader
   * divide.
   */
  tooltipRows?: BarOverviewRow[];
}

export function BarOverviewChart({
  items,
  height = 250,
  maxVal = 60,
  yAxisTicks = ['0', '12', '24', '36', '48', '60'],
  primaryColor = 'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 95%, black)',
  primaryLightColor = 'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 70%, white)',
  inactiveColor = '#ECEFF3',
  inactiveBorder = '#E2E6EC',
  openHighlightTooltip = true,
}: {
  items: BarOverviewItem[];
  /** A number of pixels, or a CSS length ("100%") to fill a flex parent. */
  height?: number | string;
  maxVal?: number;
  yAxisTicks?: string[];
  primaryColor?: string;
  primaryLightColor?: string;
  inactiveColor?: string;
  inactiveBorder?: string;
  /**
   * Whether the highlighted bar opens its tooltip at rest.
   *
   * True keeps the Time & Attendance hub exactly as it was: the chart arrives
   * with one card already showing, which is the sentence it is drawing. On a
   * STACKED chart that card sits over the bars it is describing and clips
   * against the panel edge on the first or last bucket, so the hubs that stack
   * pass false and let hover do the work. The bar is still tinted either way.
   */
  openHighlightTooltip?: boolean;
}) {
  const defaultHighlightIdx = items.findIndex((it) => it.highlight);
  // Seeded from the highlight so the chart arrives with one card showing —
  // but ONLY when the caller wants that. Without the flag here the opt-out is
  // silently ineffective: `isHovered` would be true on first render and the
  // tooltip would open anyway, which is exactly what the screenshot caught.
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(
    openHighlightTooltip && defaultHighlightIdx !== -1 ? defaultHighlightIdx : null
  );

  /** Print every nth x-label so a month's worth does not collapse into "Au…". */
  const labelEvery = Math.max(1, Math.ceil(items.length / 12));
  const activeIdx =
    hoveredIdx !== null ? hoveredIdx : defaultHighlightIdx !== -1 ? defaultHighlightIdx : null;

  return (
    <div className="relative w-full" style={{ height }}>
      {/* Grid container with Y-Axis */}
      <div className="flex h-[calc(100%-28px)] w-full">
        {/* Y Axis labels */}
        <div className="flex flex-col justify-between pe-3 text-[12px] font-medium text-text-muted select-none">
          {[...yAxisTicks].reverse().map((tick, i) => (
            <span key={i} className="leading-none text-end">{tick}</span>
          ))}
        </div>

        {/* Chart area with horizontal dashed grid lines and bars */}
        <div className="relative flex-1 flex items-end justify-between gap-3 px-2 border-b border-surface-border">
          {/* Horizontal dashed grid lines matching reference */}
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
            {yAxisTicks.map((_, i) => (
              <div key={i} className="w-full border-b border-surface-border/60 border-dashed h-0" />
            ))}
          </div>

          {/* Vertical Pill Bars */}
          {items.map((it, idx) => {
            const isHovered = hoveredIdx === idx;
            const isDefaultHighlight = it.highlight && hoveredIdx === null;
            // Colour and tooltip are separate decisions: a ranking chart wants
            // its leading bar coloured but not talking over the panel title.
            const isActive = isHovered || isDefaultHighlight;
            const showTooltip = isHovered || (isDefaultHighlight && openHighlightTooltip);
            const pct = Math.min(100, Math.max(8, (it.value / maxVal) * 100));

            return (
              <div
                key={it.key}
                className="relative flex-1 flex flex-col items-center justify-end h-full z-10 cursor-pointer group"
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() =>
                  setHoveredIdx(
                    openHighlightTooltip && defaultHighlightIdx !== -1
                      ? defaultHighlightIdx
                      : null,
                  )
                }
              >
                {/* Floating Tooltip Card over active bar (exact reference image 1 styling) */}
                {showTooltip && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    // `top-0`, not `-top-22`. The wrapper this sits in is the
                    // full-height bar COLUMN, so a negative offset floats the
                    // card above the plot area entirely and it lands on the
                    // panel's own title — which is what a stacked chart with
                    // data on first paint actually did: "Schedule coverage"
                    // rendered behind the tooltip. Anchored to the top of the
                    // plot area it stays inside the panel on every bar.
                    className="absolute top-0 z-30 bg-surface-card border border-surface-border shadow-xl rounded-2xl p-3 min-w-[155px] pointer-events-none"
                  >
                    <p className="text-[12px] font-bold text-text-heading mb-2">
                      {it.tooltipTitle ?? it.label}
                    </p>
                    <div className="space-y-1.5">
                      {(it.tooltipRows ??
                        (it.segments?.length
                          ? ([
                              ...it.segments.map((part) => ({
                                label: part.label,
                                value: part.value,
                                color: part.color,
                              })),
                              { label: 'Total', value: it.value, emphasis: true },
                            ] as BarOverviewRow[])
                          : null) ?? ([
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
                      ] as BarOverviewRow[])).map((row, rowIdx) => (
                        <div
                          key={`${row.label}-${rowIdx}`}
                          className={`flex items-center justify-between gap-3 text-[11px] ${
                            row.emphasis ? 'pt-1.5 mt-0.5 border-t border-surface-border' : ''
                          }`}
                        >
                          <span
                            className={`flex items-center gap-1.5 font-medium ${
                              row.emphasis ? 'text-text-heading font-bold' : 'text-text-muted'
                            }`}
                          >
                            {row.color && (
                              <span
                                className="w-2.5 h-3.5 rounded-xs shrink-0"
                                style={{ background: row.color }}
                              />
                            )}
                            {row.label}
                          </span>
                          <span className="font-bold text-text-heading tabular-nums">{row.value}</span>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}

                {/* The Pill Bar */}
                {it.segments?.length ? (
                  /* Real stacked bands.
                     `flex-col-reverse` + `flexGrow: value` is the same
                     proportional trick `SegmentedBar` uses: no percentage
                     arithmetic, so no rounding drift leaves a hairline of
                     background showing at the top of the stack. Zero-value
                     bands are dropped rather than drawn as slivers. */
                  <div
                    className={`w-full max-w-[46px] flex flex-col-reverse overflow-hidden rounded-t-xl transition-all duration-300 ${
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
                  /* Active 2-tone stacked bar with 3px gap matching reference image 1 */
                  <div
                    className="w-full max-w-[46px] flex flex-col justify-end gap-[3px] transition-all duration-300"
                    style={{ height: `${pct}%` }}
                  >
                    {/* Top lighter cap */}
                    <div
                      className="w-full h-[32%] rounded-t-xl rounded-b-xs shadow-2xs"
                      style={{ background: primaryLightColor }}
                    />
                    {/* Bottom primary body */}
                    <div
                      className="w-full flex-1 rounded-t-xs rounded-b-sm shadow-2xs"
                      style={{ background: primaryColor }}
                    />
                  </div>
                ) : (
                  /* Inactive solid pill bar with subtle border */
                  <div
                    className="w-full max-w-[46px] rounded-t-xl transition-all duration-300 border"
                    style={{
                      height: `${pct}%`,
                      background: inactiveColor,
                      borderColor: inactiveBorder,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* X Axis Labels.
          A month is 31 bars and 31 labels do not fit, so past ~12 items only
          every nth is printed — the alternative is a row of "Au…" that names
          no day at all. The active bar always keeps its label, because that is
          the one being read. */}
      <div className="flex justify-between ps-10 pe-2 pt-2 text-[12px] font-medium text-text-muted select-none overflow-visible min-w-0">
        {items.map((it, idx) => {
          const isActive = hoveredIdx === idx || (hoveredIdx === null && it.highlight);
          // The active label always prints; a scheduled one too close to it is
          // dropped, or the two run together ("Aug 21Aug 22").
          const show =
            isActive ||
            (idx % labelEvery === 0 &&
              (activeIdx === null || Math.abs(idx - activeIdx) >= labelEvery));
          return (
            <span
              key={it.key}
              title={it.label}
              // Two behaviours, because two kinds of label pass through here.
              //
              // THINNED (labelEvery > 1) means dates: short, and every other
              // slot is blank, so a printed label is allowed to spill sideways
              // into those blanks. Truncating instead gives a row of "Au…".
              //
              // UNTHINNED means categories — department names, which can be any
              // length. `whitespace-nowrap` on those pushed the flex row wider
              // than the page: one department called "AR Dept A areg1786971992152"
              // put a horizontal scrollbar on the whole dashboard and clipped the
              // fifth KPI card. Those wrap to two lines and stop there.
              //
              // `min-w-0` on both: without it a flex item refuses to shrink below
              // its content, which is the actual mechanism that widened the page.
              className={`flex-1 min-w-0 text-center ${
                labelEvery > 1
                  ? 'whitespace-nowrap overflow-visible'
                  : 'break-words line-clamp-2 leading-tight'
              } ${isActive ? 'font-extrabold text-text-heading' : 'text-text-muted'}`}
            >
              {show ? it.label : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ── Spline Trend Chart / Customer Insight Style ─────────────────────────── */

/**
 * A smooth path through `values`, drawn in a 0..width by 0..height box.
 *
 * Cardinal-spline control points rather than `Q`/`T` guesses: the old version
 * hard-coded its curve, so it drew the same pretty shape whatever the numbers
 * were. Control points keep the reference look while the line now means
 * something.
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
 * Two curves over the same x-axis — the hub uses it for today's arrival
 * pattern, on-time against late, which is how a 9:30 spike becomes visible
 * instead of averaging into "some people were late".
 */
export function SplineTrendChart({
  height = 140,
  series,
  timeTicks = ['12 AM', '6 AM', '12 PM', '6 PM', '11 PM'],
  emptyLabel,
}: {
  height?: number;
  /** Omit to draw nothing but the grid — never a decorative curve. */
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
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-full overflow-visible">
          {/* Light horizontal grid lines */}
          <line x1="0" y1="20" x2={W} y2="20" stroke="var(--color-surface-border)" strokeDasharray="3 3" opacity="0.6" />
          <line x1="0" y1="50" x2={W} y2="50" stroke="var(--color-surface-border)" strokeDasharray="3 3" opacity="0.6" />
          <line x1="0" y1="80" x2={W} y2="80" stroke="var(--color-surface-border)" strokeDasharray="3 3" opacity="0.6" />

          {/* Drawn back to front so the first series sits on top. Nothing is
              drawn at all when every value is zero: a flat line along the axis
              is a curve, and printing one beneath the words "nobody joined or
              left in this window" tells the reader two different things. */}
          {hasAny && [...lines].reverse().map((l) => (
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

      {/* X Axis Time Labels */}
      <div className="flex justify-between text-[10px] font-medium text-text-muted pt-1 select-none">
        {timeTicks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
    </div>
  );
}

/* ── Tooltip Card ────────────────────────────────────────────────────────── */

export interface TooltipRow {
  label: string;
  value: string;
  color: string;
}

export function ChartTooltipCard({ title, rows }: { title?: string; rows: TooltipRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-xl bg-surface-overlay border border-surface-border shadow-xl px-3.5 py-3 min-w-[180px]">
      {title && <p className="text-[13px] font-bold text-text-heading mb-2">{title}</p>}
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.color }} />
            <span className="text-[12px] text-text-muted">{r.label}</span>
            <span className="ms-auto text-[12px] font-bold text-text-heading tabular-nums">
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
