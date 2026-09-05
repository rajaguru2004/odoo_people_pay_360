'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CalendarCheck2,
  CalendarDays,
  CalendarX2,
  TrendingDown,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import AttentionStrip, {
  type AttentionItem,
} from '@/components/module-landing/AttentionStrip';
import type { KpiStat } from '@/components/module-landing/StatCard';
import {
  BarOverviewChart,
  DonutChart,
  DonutLegend,
  MeterList,
  PanelHeader,
  PanelLink,
  PeriodNav,
  SplineTrendChart,
  type BarOverviewItem,
  type DonutSlice,
  type MeterRow,
} from '@/components/module-landing/primitives';
import { useSchedulesHub } from '@/hooks/useSchedules';
import { axisFor, downloadCsv } from '@/utils/chartAxis';
import type { SchedulePeriod } from '@/types/schedules';

/**
 * The tabs, and what each one means to the API.
 *
 * No `Today`, unlike the Time & Attendance hub. "Who is rostered today" is a
 * calendar screen, not a dashboard question — a scheduler opens this page to ask
 * whether the coming WEEK is covered, which is why Week leads and is the default.
 */
const PERIOD_TABS: Array<{ label: string; value: SchedulePeriod }> = [
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
  { label: 'Year', value: 'year' },
];

/** Brand ramp for the shift-distribution bars, densest shift first. */
const SHIFT_SHADES = [
  'var(--color-brand-primary)',
  'color-mix(in srgb, var(--color-brand-primary) 82%, var(--color-surface-card))',
  'color-mix(in srgb, var(--color-brand-primary) 66%, var(--color-surface-card))',
  'color-mix(in srgb, var(--color-brand-primary) 50%, var(--color-surface-card))',
  'color-mix(in srgb, var(--color-brand-primary) 36%, var(--color-surface-card))',
];

const SCHEDULED_COLOR =
  'color-mix(in srgb, var(--color-brand-primary) 90%, var(--color-surface-card))';
const BASELINE_COLOR =
  'color-mix(in srgb, var(--color-text-muted) 45%, var(--color-surface-card))';

/**
 * Schedules module hub — is the roster actually covered?
 *
 * The same layout as the Time & Attendance hub, which is the finalised module
 * shell: five KPIs, one big trend, one ranking, three insight panels, an action
 * strip, then the tiles. Only the meaning of each slot changes.
 *
 *   KPIs        who is scheduled, who is not, and what contradicts the roster
 *   Trend       scheduled stacked under unassigned, per day or per month
 *   Insights    the roster's shape: shift mix, status, staffing by hour
 *   Ranking     which departments are thin
 *   Attention   what to act on, each item linking to the screen behind it
 *
 * ONE clock runs the page. The Week / Month / Year tabs and the ‹ › arrows move
 * all of it together; a panel left on this week while the cards above it moved
 * to August would be the same lie in a quieter place.
 *
 * ## Three panels that are NOT what a roster dashboard usually promises
 *
 * "Open shifts", an "over capacity" slice and a required-vs-scheduled staffing
 * curve are the three things every scheduling tool draws. None of them is
 * representable here: `WorkSchedule` is one row per employee per date with a
 * required `employeeId`, and the schema has no capacity column and no hourly
 * demand anywhere. Rather than draw a "Required" line from a number nobody
 * stores, these panels measure what the data supports and are LABELLED for it —
 * coverage gaps against the window's own median, the three conflict kinds the
 * roster is happy to contain, and on-shift-by-hour against the active headcount.
 */
function SchedulesHubContent() {
  const t = useTranslations('schedules');
  const tm = useTranslations('moduleLanding');

  const {
    summary,
    period,
    setPeriod,
    goPrevious,
    goNext,
    goCurrent,
    canGoNext,
    isCurrent,
    loading,
    fetching,
    failed,
  } = useSchedulesHub();

  const [exporting, setExporting] = useState(false);

  const stats = summary?.periodStats;
  const previous = summary?.previousStats;
  const attention = summary?.attention;
  const periodLabel = summary?.range.label ?? '';
  const previousLabel = summary?.previousRange.label ?? '';
  const conflicts = stats?.conflicts;

  const activeTab = PERIOD_TABS.find((p) => p.value === period)?.label ?? 'Week';
  const onTabChange = useCallback(
    (label: string) => {
      const match = PERIOD_TABS.find((p) => p.label === label);
      if (match) setPeriod(match.value);
    },
    [setPeriod],
  );

  /**
   * A delta badge in percentage POINTS, or nothing when either side is unknown.
   *
   * Never a percentage of a percentage: coverage moving from 40% to 44% is "up
   * 4 points", and calling it "up 10%" invites the reader to think ten people.
   */
  const delta = useCallback(
    (
      current: number | null | undefined,
      before: number | null | undefined,
      goodDirection: 'up' | 'down',
    ): KpiStat['delta'] => {
      if (typeof current !== 'number' || typeof before !== 'number') return undefined;
      const points = Math.round((current - before) * 10) / 10;
      if (points === 0) return undefined;
      return {
        value: points,
        direction: points >= 0 ? 'up' : 'down',
        goodDirection,
        display: `${Math.abs(points).toFixed(1)} pts`,
        label: t('vsPrevious', { period: previousLabel }),
      };
    },
    [previousLabel, t],
  );

  /**
   * Every figure here is null-safe.
   *
   * `null` is what the server sends when there was nothing to divide by, and it
   * prints as an em dash. Coercing it to 0% would put "Coverage 0.0%" on screen
   * for a company with nobody active, which is a claim rather than an absence.
   */
  const kpis: KpiStat[] = [
    {
      key: 'scheduled',
      label: t('kpiScheduled'),
      value: failed || !stats ? null : stats.scheduledEmployees,
      icon: CalendarDays,
      tone: (stats?.coverageRate ?? 0) >= 90 ? 'success' : 'default',
      delta: delta(stats?.coverageRate, previous?.coverageRate, 'up'),
      footnote: !stats
        ? undefined
        : stats.coverageRate === null
          ? // "{rate}% covered" with an em dash substituted reads as "—% covered".
            // Drop the clause rather than the number.
            t('kpiScheduledHintNone', {
              scheduled: stats.scheduledEmployees,
              active: stats.activeHeadcount,
            })
          : t('kpiScheduledHint', {
              scheduled: stats.scheduledEmployees,
              active: stats.activeHeadcount,
              rate: stats.coverageRate.toFixed(1),
            }),
      href: '/dashboard/schedules/overview',
    },
    {
      key: 'today',
      // Deliberately NOT period-scoped: "who is on today" is what somebody
      // standing in the office at 9am needs, whatever window the chart shows.
      label: t('kpiToday'),
      value: failed || !stats ? null : stats.scheduledToday,
      icon: CalendarCheck2,
      tone: stats && stats.scheduledToday > 0 ? 'info' : 'warning',
      footnote: !stats
        ? undefined
        : stats.activeHeadcount === 0
          ? t('kpiNobodyActive')
          : t('kpiTodayHint', {
              rate: ((stats.scheduledToday / stats.activeHeadcount) * 100).toFixed(1),
            }),
      href: '/dashboard/schedules/overview',
    },
    {
      key: 'unassigned',
      label: t('kpiUnassigned'),
      value: failed || !stats ? null : stats.unscheduled,
      icon: CalendarX2,
      // Somebody with no shift will not know to turn up. That is the whole
      // module in one number.
      tone: (stats?.unscheduled ?? 0) > 0 ? 'warning' : 'success',
      footnote: !stats
        ? undefined
        : stats.activeHeadcount === 0
          ? t('kpiNobodyActive')
          : t('kpiUnassignedHint', {
              rate: ((stats.unscheduled / stats.activeHeadcount) * 100).toFixed(1),
            }),
      href: '/dashboard/schedules/shifts',
    },
    {
      key: 'gaps',
      label: t('kpiGaps'),
      value: failed || !stats ? null : stats.coverageGaps,
      icon: TrendingDown,
      tone: (stats?.coverageGaps ?? 0) > 0 ? 'warning' : 'success',
      footnote: !stats
        ? undefined
        : stats.workingDays < 3
          ? t('kpiGapsTooShort')
          : stats.coverageGaps === 0
            ? t('kpiGapsClear', { days: stats.workingDays })
            : t('kpiGapsHint', {
                gaps: stats.coverageGaps,
                days: stats.workingDays,
              }),
      href: '/dashboard/schedules/overview',
    },
    {
      key: 'conflicts',
      label: t('kpiConflicts'),
      value: failed || !conflicts ? null : conflicts.total,
      icon: AlertTriangle,
      tone: (conflicts?.total ?? 0) > 0 ? 'danger' : 'success',
      footnote: !conflicts
        ? undefined
        : conflicts.total === 0
          ? t('kpiConflictsClear')
          : t('kpiConflictsHint', {
              holiday: conflicts.onHoliday,
              off: conflicts.onWeeklyOff,
              overlap: conflicts.overlaps,
            }),
      href: '/dashboard/schedules/overview',
    },
  ];

  /**
   * The action queue: counts first — a link that says how many is a decision —
   * then the names behind the loudest one, so the strip is workable as it is.
   */
  const attentionItems: AttentionItem[] = useMemo(() => {
    if (!attention) return [];
    const items: AttentionItem[] = [];

    const push = (
      count: number,
      key: string,
      label: string,
      detail: string,
      severity: AttentionItem['severity'],
      href: string,
    ) => {
      if (count > 0) items.push({ key, label, detail, severity, href });
    };

    push(
      attention.unassigned.count,
      'unassigned',
      t('actionUnassigned', { count: attention.unassigned.count }),
      t('actionRoster'),
      'critical',
      '/dashboard/schedules/shifts',
    );
    push(
      attention.onHoliday.count,
      'on-holiday',
      t('actionOnHoliday', { count: attention.onHoliday.count }),
      t('actionReview'),
      'critical',
      '/dashboard/schedules/overview',
    );
    push(
      attention.overlaps.count,
      'overlaps',
      t('actionOverlaps', { count: attention.overlaps.count }),
      t('actionReview'),
      'warning',
      '/dashboard/schedules/shifts',
    );
    push(
      attention.onWeeklyOff.count,
      'on-weekly-off',
      t('actionOnWeeklyOff', { count: attention.onWeeklyOff.count }),
      t('actionReview'),
      'warning',
      '/dashboard/schedules/overview',
    );

    if (attention.thinnestDay) {
      items.push({
        key: 'thinnest',
        label: t('actionThinnest', {
          day: attention.thinnestDay.label,
          count: attention.thinnestDay.scheduled,
        }),
        detail: t('actionView'),
        severity: attention.thinnestDay.scheduled === 0 ? 'warning' : 'info',
        href: '/dashboard/schedules/overview',
      });
    }

    // The names behind the loudest number, so somebody can start without
    // opening a list.
    const worst =
      attention.unassigned.names.length > 0
        ? {
            names: attention.unassigned.names,
            detail: t('noShift'),
            severity: 'critical' as const,
            href: '/dashboard/schedules/shifts',
          }
        : attention.onHoliday.samples.length > 0
          ? {
              names: attention.onHoliday.samples.map(
                (c) => c.fullName || t('unnamedEmployee'),
              ),
              detail: t('onHoliday'),
              severity: 'critical' as const,
              href: '/dashboard/schedules/overview',
            }
          : attention.overlaps.samples.length > 0
            ? {
                names: attention.overlaps.samples.map(
                  (c) => c.fullName || t('unnamedEmployee'),
                ),
                detail: t('overlapping'),
                severity: 'warning' as const,
                href: '/dashboard/schedules/shifts',
              }
            : null;

    worst?.names.slice(0, 6).forEach((name, i) =>
      items.push({
        key: `name-${i}-${name}`,
        label: name,
        detail: worst.detail,
        severity: worst.severity,
        href: worst.href,
      }),
    );

    return items;
  }, [attention, t]);

  /** The main chart: scheduled stacked under unassigned, one bar per bucket. */
  const { barItems, axis } = useMemo(() => {
    const buckets = summary?.trend ?? [];

    // Which bar opens tinted: the worst-covered bucket that expected anybody.
    // Pinning it to today puts a bar of zeros on screen every Friday, which
    // reads as a broken dashboard rather than as a rest day.
    let highlightKey: string | undefined;
    let worst = Infinity;
    for (const bucket of buckets) {
      if (bucket.expected > 0 && (bucket.coverageRate ?? 100) < worst) {
        worst = bucket.coverageRate ?? 100;
        highlightKey = bucket.key;
      }
    }

    const items: BarOverviewItem[] = buckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      // The bar's height is what the calendar EXPECTED, so a closed day is a gap
      // on the axis rather than a full-height block of nothing.
      value: Math.max(bucket.expected, bucket.scheduled),
      highlight: bucket.key === highlightKey,
      segments: [
        {
          key: 'scheduled',
          label: t('segScheduled'),
          value: bucket.scheduled,
          color: SCHEDULED_COLOR,
        },
        {
          key: 'unassigned',
          label: t('segUnassigned'),
          value: bucket.unassigned,
          color: 'var(--color-status-warning)',
        },
      ],
      tooltipTitle: bucket.label,
      tooltipRows: [
        { label: t('tipExpected'), value: bucket.expected },
        {
          label: t('tipScheduled'),
          value: bucket.scheduled,
          color: SCHEDULED_COLOR,
        },
        {
          label: t('tipUnassigned'),
          value: bucket.unassigned,
          color: 'var(--color-status-warning)',
        },
        {
          label: t('tipCoverage'),
          value:
            bucket.coverageRate === null ? '—' : `${bucket.coverageRate.toFixed(1)}%`,
          emphasis: true,
        },
      ],
    }));

    return {
      barItems: items,
      axis: axisFor(
        Math.max(1, ...buckets.map((b) => Math.max(b.expected, b.scheduled))),
      ),
    };
  }, [summary, t]);

  /** Where the workforce is concentrated. */
  const shiftMeters: MeterRow[] = useMemo(() => {
    const mix = summary?.shiftMix ?? [];
    const top = Math.max(1, ...mix.map((m) => m.employees));
    return mix.map((m, i) => ({
      key: m.type,
      label: t(`shift.${m.type}`),
      percent: (m.employees / top) * 100,
      valueLabel:
        m.share === null
          ? String(m.employees)
          : t('shiftValue', { count: m.employees, share: m.share.toFixed(0) }),
      color: SHIFT_SHADES[Math.min(i, SHIFT_SHADES.length - 1)],
      href: '/dashboard/schedules/shifts',
    }));
  }, [summary, t]);

  /** What the roster's people actually are. */
  const statusSlices: DonutSlice[] = useMemo(() => {
    const s = summary?.status;
    return [
      {
        key: 'assigned',
        label: t('statusAssigned'),
        value: s?.assigned ?? 0,
        color: 'var(--color-status-success)',
      },
      {
        key: 'unassigned',
        label: t('statusUnassigned'),
        value: s?.unassigned ?? 0,
        color: 'color-mix(in srgb, var(--color-text-muted) 40%, var(--color-surface-card))',
      },
      {
        key: 'onHoliday',
        label: t('statusOnHoliday'),
        value: s?.onHoliday ?? 0,
        color: 'var(--color-status-error)',
      },
      {
        key: 'onWeeklyOff',
        label: t('statusOnWeeklyOff'),
        value: s?.onWeeklyOff ?? 0,
        color: 'var(--color-status-warning)',
      },
      {
        key: 'overlaps',
        label: t('statusOverlaps'),
        value: s?.overlaps ?? 0,
        color: 'var(--color-status-info)',
      },
    ];
  }, [summary, t]);

  const statusTotal = statusSlices.reduce((sum, s) => sum + s.value, 0);

  /**
   * How the day is staffed, hour by hour.
   *
   * Two series — people on shift, and a flat active-headcount line to read it
   * against. NOT "required": nothing in this system stores a requirement, and
   * drawing one would be inventing the most important number on the panel.
   */
  const coverage = summary?.staffCoverage;

  const coverageSeries = useMemo(() => {
    const hours = coverage?.hours ?? [];
    if (!hours.length) return [];
    return [
      { key: 'onShift', values: hours.map((h) => h.onShift), color: SCHEDULED_COLOR },
      {
        key: 'baseline',
        values: hours.map(() => coverage?.activeBaseline ?? 0),
        color: BASELINE_COLOR,
      },
    ];
  }, [coverage]);

  const coverageTicks = useMemo(
    () => (coverage?.hours ?? []).filter((_, i) => i % 6 === 0).map((h) => h.label),
    [coverage],
  );

  /** The busiest hour, which is the sentence the curve is drawing. */
  const peakHour = useMemo(() => {
    let best: { hour: number; label: string; onShift: number } | null = null;
    for (const hour of coverage?.hours ?? []) {
      if (!best || hour.onShift > best.onShift) best = hour;
    }
    return best && best.onShift > 0 ? best : null;
  }, [coverage]);

  /** Which departments are thin. */
  const deptMeters: MeterRow[] = useMemo(
    () =>
      (summary?.departments ?? []).slice(0, 6).map((row) => ({
        key: row.id,
        label: row.name,
        percent: row.rate ?? 0,
        // A department with nobody active has nothing to divide by, so it prints
        // an em dash rather than a fabricated 0%.
        valueLabel: row.rate === null ? '—' : `${row.rate.toFixed(0)}%`,
        color:
          row.rate === null
            ? 'var(--color-surface-border)'
            : row.rate >= 90
              ? 'var(--color-status-success)'
              : row.rate >= 60
                ? 'var(--color-brand-primary)'
                : 'var(--color-status-error)',
        href: '/dashboard/schedules/overview',
      })),
    [summary],
  );

  /** The window on screen, as a spreadsheet. */
  const handleExport = useCallback(() => {
    if (!summary) return;
    setExporting(true);
    try {
      downloadCsv(
        `schedules-${summary.period}-${summary.range.start}-to-${summary.range.end}.csv`,
        ['bucket', 'expected', 'scheduled', 'unassigned', 'coverage_rate_pct'],
        summary.trend.map((b) => [
          b.key,
          b.expected,
          b.scheduled,
          b.unassigned,
          b.coverageRate ?? '',
        ]),
      );
    } finally {
      setExporting(false);
    }
  }, [summary]);

  const periodNav = useMemo(
    () => (
      <PeriodNav
        label={periodLabel}
        onPrev={goPrevious}
        onNext={goNext}
        // A roster is a PLAN, so unlike attendance this legitimately walks
        // forward. It stops a year out, where the roster is empty by definition
        // and a page of zeros is indistinguishable from a page that failed.
        canGoNext={canGoNext}
        onReset={isCurrent ? undefined : goCurrent}
        resetLabel={t('backToCurrent')}
        busy={fetching}
      />
    ),
    [periodLabel, goPrevious, goNext, canGoNext, isCurrent, goCurrent, fetching, t],
  );

  return (
    <ModuleLandingPage
      moduleKey="schedules"
      title={tm('schedules.title')}
      subtitle={tm('schedules.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      showControls
      timeFilterOptions={PERIOD_TABS.map((p) => p.label)}
      timeFilter={activeTab}
      onTimeFilterChange={onTabChange}
      periodNav={periodNav}
      onExport={handleExport}
      exportBusy={exporting}
      badges={{ shiftManagement: stats?.unscheduled ?? 0 }}
      badgeTones={{ shiftManagement: 'warning' }}
      insights={
        <div className="space-y-6">
          <AttentionStrip
            title={t('needsAttention')}
            items={attentionItems}
            loading={loading}
            emptyLabel={failed ? t('coverageUnknown') : t('rosterClear')}
            seeAll={{
              label: t('seeCalendar'),
              href: '/dashboard/schedules/overview',
            }}
          />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6 lg:col-span-7 xl:col-span-8">
              <PanelHeader
                title={t('scheduleCoverage')}
                hint={
                  !stats
                    ? undefined
                    : stats.coverageRate === null
                      ? t('scheduleCoverageHintEmpty', { period: periodLabel })
                      : t('scheduleCoverageHint', {
                          period: periodLabel,
                          rate: `${stats.coverageRate.toFixed(1)}%`,
                        })
                }
                action={
                  <PanelLink href="/dashboard/schedules/overview">
                    {t('viewDetails')}
                  </PanelLink>
                }
              />
              {/* min-h keeps the chart readable when this panel is the short one;
                  flex-1 lets it fill when the shift list beside it is taller. */}
              <div className="mt-2 flex min-h-[260px] flex-1 pt-2">
                {barItems.length === 0 || barItems.every((b) => b.value === 0) ? (
                  <p className="w-full py-16 text-center text-[13px] text-text-muted">
                    {t('noRosterData')}
                  </p>
                ) : (
                  <div className="flex-1">
                    <BarOverviewChart
                      items={barItems}
                      height="100%"
                      maxVal={axis.max}
                      yAxisTicks={axis.ticks}
                      // A stacked bar's tooltip sits over the bands it describes
                      // and clips against the panel edge on the first and last
                      // bucket. Hover still shows it.
                      openHighlightTooltip={false}
                      minBarWidth={barItems.length > 20 ? 34 : undefined}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6 lg:col-span-5 xl:col-span-4">
              <PanelHeader
                title={t('shiftDistribution')}
                hint={
                  stats
                    ? t('shiftDistributionHint', {
                        count: stats.shiftRows,
                        period: periodLabel,
                      })
                    : undefined
                }
                action={
                  <PanelLink href="/dashboard/schedules/shifts">
                    {t('seeShifts')}
                  </PanelLink>
                }
              />
              {loading ? (
                <div className="mt-4 animate-pulse space-y-6">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-2.5 rounded-full bg-surface-border/70" />
                  ))}
                </div>
              ) : shiftMeters.length === 0 ? (
                <p className="grid flex-1 place-items-center text-[13px] text-text-muted">
                  {t('noShiftData')}
                </p>
              ) : (
                <div className="mt-2 flex flex-1 flex-col justify-center">
                  <MeterList rows={shiftMeters} />
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            <div className="surface-panel flex flex-col rounded-[20px] p-6">
              <PanelHeader
                title={t('shiftStatus')}
                hint={t('shiftStatusHint', { period: periodLabel })}
              />
              {loading ? (
                <div className="grid flex-1 animate-pulse place-items-center">
                  <div className="h-[168px] w-[168px] rounded-full bg-surface-border/70" />
                </div>
              ) : statusTotal === 0 ? (
                <p className="py-8 text-[13px] text-text-muted">{t('noRosterData')}</p>
              ) : (
                <div className="my-auto flex flex-1 flex-col gap-5 pt-2">
                  <DonutChart
                    slices={statusSlices}
                    size={168}
                    thickness={22}
                    caption={String(statusTotal)}
                    subCaption={t('ofEmployees')}
                  />
                  <DonutLegend slices={statusSlices} total={statusTotal} />
                </div>
              )}
            </div>

            <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6">
              <div>
                {/* Title and legend on separate rows. Side by side they fight for
                    a third of the page width and the title wraps to
                    "Staff on / shift". */}
                <div className="mb-1 flex flex-col gap-1.5">
                  <span className="text-[15px] font-bold text-text-heading">
                    {t('staffCoverage')}
                  </span>
                  <div className="flex items-center gap-3 text-[11px] font-medium text-text-muted">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-xs"
                        style={{ background: SCHEDULED_COLOR }}
                      />
                      {t('legendOnShift')}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-xs"
                        style={{ background: BASELINE_COLOR }}
                      />
                      {t('legendHeadcount')}
                    </span>
                  </div>
                </div>

                <div className="my-2 flex items-baseline gap-2.5">
                  <span className="text-[28px] leading-none font-extrabold tracking-tight text-text-heading tabular-nums">
                    {peakHour ? peakHour.label : '—'}
                  </span>
                  {peakHour && (
                    <span className="text-xs font-semibold text-text-muted">
                      {t('peakOnShift', { count: peakHour.onShift })}
                    </span>
                  )}
                </div>

                {/* Says what the curve LEAVES OUT rather than under-drawing the
                    morning in silence. */}
                <p className="text-[11px] text-text-muted">
                  {coverage && coverage.flexibleExcluded > 0
                    ? t('flexibleExcluded', { count: coverage.flexibleExcluded })
                    : t('staffCoverageHint')}
                </p>
              </div>

              <div className="mt-2">
                <SplineTrendChart
                  height={140}
                  series={coverageSeries}
                  timeTicks={coverageTicks}
                  emptyLabel={t('noHourlyData')}
                />
              </div>
            </div>

            <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6">
              <PanelHeader
                title={t('departmentCoverage')}
                hint={t('departmentCoverageHint', { period: periodLabel })}
                action={
                  <PanelLink href="/dashboard/schedules/shifts">
                    {t('seeShifts')}
                  </PanelLink>
                }
              />
              {loading ? (
                <div className="mt-4 animate-pulse space-y-6">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-2.5 rounded-full bg-surface-border/70" />
                  ))}
                </div>
              ) : deptMeters.length === 0 ? (
                <p className="grid flex-1 place-items-center text-[13px] text-text-muted">
                  {t('noDepartmentData')}
                </p>
              ) : (
                <div className="mt-2 flex flex-1 flex-col justify-center">
                  <MeterList rows={deptMeters} />
                </div>
              )}
            </div>
          </div>
        </div>
      }
    />
  );
}

export default function SchedulesHubPage() {
  return (
    // A department head owns their team's roster and the API narrows the hub to
    // the departments they head, so they belong here. Payroll does not: the
    // hub-summary endpoint refuses that role, and a tile leading to a 403 is
    // worse than no tile.
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <SchedulesHubContent />
    </ProtectedRoute>
  );
}
