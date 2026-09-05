'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CalendarDays,
  CalendarCheck2,
  CalendarX2,
  TrendingDown,
  AlertTriangle,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import AttentionStrip, { type AttentionItem } from '@/components/module-landing/AttentionStrip';
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
import { useSchedulesHub } from '@/hooks/useSchedulesHub';
import { axisFor, downloadCsv } from '@/utils/chartAxis';
import type { HubPeriod } from '@/types/schedulesHub';

/**
 * The tab labels, and the period each one means to the API.
 *
 * No `Today` tab, unlike the Time & Attendance hub. "Who is rostered today" is
 * a calendar screen, not a dashboard question — a scheduler opens this page to
 * ask whether the coming week is covered, which is why Week leads and is the
 * default.
 */
const PERIOD_TABS: Array<{ label: string; value: HubPeriod }> = [
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
  { label: 'Year', value: 'year' },
];

/** Brand ramp for the shift-distribution bars, densest shift first. */
const SHIFT_SHADES = [
  'var(--color-brand-accent, #FF5A1F)',
  'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 85%, white)',
  'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 70%, white)',
  'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 55%, white)',
  'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 42%, white)',
  'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 30%, white)',
];

/**
 * Schedules module hub — is the roster actually covered?
 *
 * Same layout as `app/dashboard/time/page.tsx`, which is the finalized module
 * hub: five KPIs, one big trend, one ranking, three insight panels, an action
 * strip, then the tiles. Only the meaning of each slot changes.
 *
 *   KPIs        who is scheduled, who is not, and what is wrong with the roster
 *   Trend       scheduled against unassigned, stacked, per day or per month
 *   Ranking     which departments are thin
 *   Insights    the roster's shape: shift mix, status, staffing by hour
 *   Attention   what to act on, each item a link to the screen behind it
 *
 * ONE clock runs the page. The Week / Month / Year tabs and the ‹ › arrows move
 * all of it together.
 *
 * ## Three panels that are NOT what the brief asked for, and why
 *
 * The brief asked for "Open Shifts", an "Over capacity" donut slice, and a
 * Required-vs-Scheduled staffing curve. None of the three is representable:
 * `WorkSchedule` is one row per employee per date with a required `employeeId`,
 * and the schema has no capacity column and no hourly demand anywhere. Rather
 * than draw a `Required` line from a number nobody stores, the panels measure
 * what the data supports and are LABELLED for that — coverage gaps against the
 * window's own median, the three conflict kinds the roster is happy to contain,
 * and on-shift-by-hour against the active headcount.
 */
function SchedulesHubContent() {
  const t = useTranslations('schedulesHub');
  const tm = useTranslations('moduleLanding');

  const {
    summary,
    period,
    changePeriod,
    step,
    isPast,
    resetToCurrent,
    loading,
    fetching,
    hubFailed,
  } = useSchedulesHub();

  const [exporting, setExporting] = useState(false);

  const stats = summary?.periodStats;
  const prev = summary?.previousStats;
  const attention = summary?.attention;
  const periodLabel = summary?.range.label ?? '';
  const prevLabel = summary?.previousRange.label ?? '';

  const activeTab = PERIOD_TABS.find((p) => p.value === period)?.label ?? 'Week';

  const onTabChange = useCallback(
    (label: string) => {
      const match = PERIOD_TABS.find((p) => p.label === label);
      if (match) changePeriod(match.value);
    },
    [changePeriod],
  );

  /**
   * A delta badge, in percentage POINTS, or nothing when either side is unknown.
   *
   * Never a percentage of a percentage: coverage moving from 40% to 44% is "up
   * 4 points", and calling it "up 10%" invites the reader to think ten people.
   */
  const delta = useCallback(
    (
      current: number | null | undefined,
      previous: number | null | undefined,
      goodDirection: 'up' | 'down',
      suffix = 'pts',
    ): KpiStat['delta'] => {
      if (typeof current !== 'number' || typeof previous !== 'number') return undefined;
      const points = Math.round((current - previous) * 10) / 10;
      if (points === 0) return undefined;
      return {
        value: points,
        direction: points >= 0 ? 'up' : 'down',
        goodDirection,
        display: `${Math.abs(points).toFixed(1)} ${suffix}`,
        label: t('vsPrevious', { period: prevLabel }),
      };
    },
    [prevLabel, t],
  );

  const conflicts = stats?.conflicts;

  const kpis: KpiStat[] = [
    {
      key: 'scheduled',
      label: t('kpiTotalScheduled'),
      value: hubFailed || !stats ? null : stats.scheduledEmployees,
      icon: CalendarDays,
      tone: (stats?.coverageRate ?? 0) >= 90 ? 'success' : 'default',
      delta: delta(stats?.coverageRate, prev?.coverageRate, 'up'),
      footnote: !stats
        ? undefined
        : stats.coverageRate === null
        ? // Same as the Leave hub: "{rate}% covered" with an em dash in it
          // reads as "—% covered". Drop the clause rather than the number.
          t('kpiTotalScheduledHintNone', {
            scheduled: stats.scheduledEmployees,
            active: stats.activeHeadcount,
          })
        : t('kpiTotalScheduledHint', {
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
      label: t('kpiScheduledToday'),
      value: hubFailed || !stats ? null : stats.scheduledToday,
      icon: CalendarCheck2,
      tone: stats && stats.scheduledToday > 0 ? 'info' : 'warning',
      footnote: !stats
        ? undefined
        : stats.activeHeadcount === 0
        ? t('kpiNobodyActive')
        : t('kpiScheduledTodayHint', {
            rate: ((stats.scheduledToday / stats.activeHeadcount) * 100).toFixed(1),
          }),
      href: '/dashboard/schedules/overview',
    },
    {
      key: 'unassigned',
      label: t('kpiUnassigned'),
      value: hubFailed || !stats ? null : stats.unscheduled,
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
      label: t('kpiCoverageGaps'),
      value: hubFailed || !stats ? null : stats.coverageGaps,
      icon: TrendingDown,
      tone: (stats?.coverageGaps ?? 0) > 0 ? 'warning' : 'success',
      footnote: !stats
        ? undefined
        : stats.workingDays < 3
        ? t('kpiCoverageGapsTooShort')
        : stats.coverageGaps === 0
        ? t('kpiCoverageGapsClear', { days: stats.workingDays })
        : t('kpiCoverageGapsHint', {
            gaps: stats.coverageGaps,
            days: stats.workingDays,
          }),
      href: '/dashboard/schedules/overview',
    },
    {
      key: 'conflicts',
      label: t('kpiConflicts'),
      value: hubFailed || !conflicts ? null : conflicts.total,
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
   * The action queue. Counts first — a link that says how many is a decision —
   * then the names behind the biggest one, so the reader can start without
   * opening the list.
   */
  const attentionItems: AttentionItem[] = useMemo(() => {
    if (!attention) return [];
    const items: AttentionItem[] = [];
    const push = (
      count: number,
      label: string,
      detail: string,
      severity: AttentionItem['severity'],
      href: string,
      keyName: string,
    ) => {
      if (count > 0) items.push({ key: keyName, label, detail, severity, href });
    };

    push(
      attention.unassigned.count,
      t('actionUnassigned', { count: attention.unassigned.count }),
      t('actionRoster'),
      'critical',
      '/dashboard/schedules/shifts',
      'unassigned',
    );
    push(
      attention.onHoliday.count,
      t('actionOnHoliday', { count: attention.onHoliday.count }),
      t('actionReview'),
      'critical',
      '/dashboard/schedules/overview',
      'on-holiday',
    );
    push(
      attention.overlaps.count,
      t('actionOverlaps', { count: attention.overlaps.count }),
      t('actionReview'),
      'warning',
      '/dashboard/schedules/shifts',
      'overlaps',
    );
    push(
      attention.onWeeklyOff.count,
      t('actionOnWeeklyOff', { count: attention.onWeeklyOff.count }),
      t('actionReview'),
      'warning',
      '/dashboard/schedules/overview',
      'on-weekly-off',
    );
    if (attention.thinnestDay && attention.thinnestDay.scheduled >= 0) {
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

    // The names behind the loudest number, so the strip is workable as it is.
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
            names: attention.onHoliday.samples.map((c) => c.fullName ?? t('unnamedEmployee')),
            detail: t('onHoliday'),
            severity: 'critical' as const,
            href: '/dashboard/schedules/overview',
          }
        : attention.overlaps.samples.length > 0
        ? {
            names: attention.overlaps.samples.map((c) => c.fullName ?? t('unnamedEmployee')),
            detail: t('overlapping'),
            severity: 'warning' as const,
            href: '/dashboard/schedules/shifts',
          }
        : null;

    if (worst) {
      worst.names.slice(0, 6).forEach((name, i) =>
        items.push({
          key: `name-${i}-${name}`,
          label: name,
          detail: worst.detail,
          severity: worst.severity,
          href: worst.href,
        }),
      );
    }
    return items;
  }, [attention, t]);

  /** The main chart: scheduled stacked under unassigned, one bar per bucket. */
  const { barItems, axis } = useMemo(() => {
    const buckets = summary?.trend ?? [];

    // Which bar opens with its tooltip showing: the worst-covered bucket that
    // expected anybody. Pinning it to today puts a card of zeros on screen
    // every Sunday, which reads as a broken dashboard rather than a day off.
    let defaultKey: string | undefined;
    let worst = Infinity;
    for (const b of buckets) {
      if (b.expected > 0 && (b.coverageRate ?? 100) < worst) {
        worst = b.coverageRate ?? 100;
        defaultKey = b.key;
      }
    }

    const items: BarOverviewItem[] = buckets.map((b) => ({
      key: b.key,
      label: b.label,
      // The bar's height is what the calendar EXPECTED, so a closed day is a
      // gap on the axis rather than a full-height block of nothing.
      value: Math.max(b.expected, b.scheduled),
      highlight: b.key === defaultKey,
      segments: [
        {
          key: 'scheduled',
          label: t('segScheduled'),
          value: b.scheduled,
          color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
          },
        {
          key: 'unassigned',
          label: t('segUnassigned'),
          value: b.unassigned,
          color: 'var(--color-status-warning)',
        },
      ],
      tooltipTitle: b.label,
      tooltipRows: [
        { label: t('tipExpected'), value: b.expected },
        {
          label: t('tipScheduled'),
          value: b.scheduled,
          color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
        },
        {
          label: t('tipUnassigned'),
          value: b.unassigned,
          color: 'var(--color-status-warning)',
        },
        {
          label: t('tipCoverage'),
          value: b.coverageRate === null ? '—' : `${b.coverageRate.toFixed(1)}%`,
          emphasis: true,
        },
      ],
    }));

    return {
      barItems: items,
      axis: axisFor(Math.max(1, ...buckets.map((b) => Math.max(b.expected, b.scheduled)))),
    };
  }, [summary, t]);

  /** Right-side: where the workforce is concentrated. */
  const shiftMeters: MeterRow[] = useMemo(() => {
    const mix = summary?.shiftMix ?? [];
    const top = Math.max(1, ...mix.map((m) => m.employees));
    return mix.map((m, i) => ({
      key: m.type,
      label: t(`shift.${m.type}` as any),
      percent: (m.employees / top) * 100,
      valueLabel:
        m.share === null
          ? String(m.employees)
          : t('shiftValue', { count: m.employees, share: m.share.toFixed(0) }),
      color: SHIFT_SHADES[Math.min(i, SHIFT_SHADES.length - 1)],
    }));
  }, [summary, t]);

  /** Bottom-left: what the roster's people actually are. */
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
        color: 'color-mix(in srgb, var(--color-text-muted) 40%, white)',
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

  const statusTotal = statusSlices.reduce((a, s) => a + s.value, 0);

  /**
   * Bottom-middle: how the day is staffed, hour by hour.
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
      {
        key: 'onShift',
        values: hours.map((h) => h.onShift),
        color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
      },
      {
        key: 'baseline',
        values: hours.map(() => coverage?.activeBaseline ?? 0),
        color: 'color-mix(in srgb, var(--color-text-muted) 45%, white)',
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
    for (const h of coverage?.hours ?? []) {
      if (!best || h.onShift > best.onShift) best = h;
    }
    return best && best.onShift > 0 ? best : null;
  }, [coverage]);

  /** Right-side ranking: which departments are thin. */
  const deptMeters: MeterRow[] = useMemo(() => {
    const rows = (summary?.departments ?? []).slice(0, 6);
    return rows.map((r) => ({
      key: r.id,
      label: r.name,
      percent: r.rate ?? 0,
      // A department with nobody active in it has nothing to divide by, so it
      // prints an em dash rather than a fabricated 0%.
      valueLabel: r.rate === null ? '—' : `${r.rate.toFixed(0)}%`,
      color:
        r.rate === null
          ? 'var(--color-surface-border)'
          : r.rate >= 90
          ? 'var(--color-status-success)'
          : r.rate >= 60
          ? 'var(--color-brand-accent, #FF5A1F)'
          : 'var(--color-status-error)',
    }));
  }, [summary]);

  /** The period, as a spreadsheet. */
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

  return (
    <ModuleLandingPage
      moduleKey="schedules"
      title={tm('schedules.title')}
      subtitle={tm('schedules.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      // `showControls` defaults to FALSE now: it used to default true and drew
      // a period filter on all ten hubs while only the ones below passed
      // `timeFilter`/`onTimeFilterChange`, so on the rest the tabs moved and the
      // page did not. This hub's filter is real — controlled tabs, a stepper
      // that re-queries, and an export of the window on screen — so it opts in.
      showControls
      timeFilterOptions={PERIOD_TABS.map((p) => p.label)}
      timeFilter={activeTab}
      onTimeFilterChange={onTabChange}
      periodNav={
        summary ? (
          <PeriodNav
            label={periodLabel}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            canGoNext={summary.range.hasNext}
            onReset={isPast ? resetToCurrent : undefined}
            resetLabel={t('backToCurrent')}
            busy={fetching}
          />
        ) : undefined
      }
      onExport={handleExport}
      exportBusy={exporting}
      insights={
        <div className="space-y-6">
          {/* What to act on */}
          <AttentionStrip
            title={t('needsAttention')}
            items={attentionItems}
            loading={loading}
            emptyLabel={hubFailed ? t('coverageUnknown') : t('rosterClear')}
            seeAll={{ label: t('seeCalendar'), href: '/dashboard/schedules/overview' }}
          />

          {/* Middle row: the period's coverage + where the thin departments are */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 xl:col-span-8 surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <PanelHeader
                title={t('scheduleCoverage')}
                hint={
                  !stats
                    ? undefined
                    : stats.coverageRate === null
                    ? // Same trap as the Leave hub: substituting an em dash into
                      // "{period} — {rate} of the workforce" reads as a broken
                      // string rather than as an unknown rate.
                      t('scheduleCoverageHintEmpty', { period: periodLabel })
                    : t('scheduleCoverageHint', {
                        period: periodLabel,
                        rate: `${stats.coverageRate.toFixed(1)}%`,
                      })
                }
                action={
                  <PanelLink href="/dashboard/schedules/overview">{t('viewDetails')}</PanelLink>
                }
              />
              {/* min-h keeps the chart readable when this panel is the short
                  one; flex-1 lets it fill when the department list is taller. */}
              <div className="mt-2 pt-2 flex-1 min-h-[260px] flex">
                {barItems.length === 0 || barItems.every((b) => b.value === 0) ? (
                  <p className="text-[13px] text-text-muted py-16 text-center w-full">
                    {t('noRosterData')}
                  </p>
                ) : (
                  <div className="flex-1">
                    <BarOverviewChart
                      items={barItems}
                      height="100%"
                      maxVal={axis.max}
                      yAxisTicks={axis.ticks}
                      // A stacked bar's tooltip sits over the bands it
                      // describes, and on the first or last bucket it clips
                      // against the panel edge. Hover still shows it.
                      openHighlightTooltip={false}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-5 xl:col-span-4 surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <PanelHeader
                title={t('shiftDistribution')}
                hint={
                  stats
                    ? t('shiftDistributionHint', { count: stats.shiftRows, period: periodLabel })
                    : undefined
                }
                action={
                  <PanelLink href="/dashboard/schedules/shifts">{t('seeShifts')}</PanelLink>
                }
              />
              {loading ? (
                <div className="mt-4 space-y-6 animate-pulse">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-2.5 rounded-full bg-surface-border/70" />
                  ))}
                </div>
              ) : shiftMeters.length === 0 ? (
                <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
                  {t('noShiftData')}
                </p>
              ) : (
                <div className="flex-1 flex flex-col justify-center mt-2">
                  <MeterList rows={shiftMeters} />
                </div>
              )}
            </div>
          </div>

          {/* Bottom row: roster status, staffing by hour, department coverage */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="surface-panel p-6 rounded-[20px] flex flex-col">
              <PanelHeader
                title={t('shiftStatus')}
                hint={t('shiftStatusHint', { period: periodLabel })}
              />
              {loading ? (
                <div className="flex-1 grid place-items-center animate-pulse">
                  <div className="h-[175px] w-[175px] rounded-full bg-surface-border/70" />
                </div>
              ) : statusTotal === 0 ? (
                <p className="text-[13px] text-text-muted py-8">{t('noRosterData')}</p>
              ) : (
                <div className="flex-1 flex flex-col gap-5 my-auto pt-2">
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

            <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <div>
                {/* Title and legend on separate rows.
                    Side by side they fight for a third of the page width and
                    the title wraps to "Staff on / shift" — caught in the first
                    screenshot pass. The Time & Attendance hub gets away with
                    one row because "Arrival pattern" plus two short swatches
                    happens to fit; this one does not. */}
                <div className="flex flex-col gap-1.5 mb-1">
                  <span className="text-[15px] font-bold text-text-heading">
                    {t('staffCoverage')}
                  </span>
                  <div className="flex items-center gap-3 text-[11px] font-medium text-text-muted">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="w-2 h-2 rounded-xs"
                        style={{
                          background:
                            'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
                        }}
                      />
                      {t('legendOnShift')}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className="w-2 h-2 rounded-xs"
                        style={{
                          background: 'color-mix(in srgb, var(--color-text-muted) 45%, white)',
                        }}
                      />
                      {t('legendHeadcount')}
                    </span>
                  </div>
                </div>

                <div className="flex items-baseline gap-2.5 my-2">
                  <span className="text-[28px] font-extrabold text-text-heading tracking-tight leading-none tabular-nums">
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

            <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <PanelHeader
                title={t('departmentCoverage')}
                hint={t('departmentCoverageHint', { period: periodLabel })}
                action={
                  <PanelLink href="/dashboard/schedules/shifts">{t('seeShifts')}</PanelLink>
                }
              />
              {loading ? (
                <div className="mt-4 space-y-6 animate-pulse">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-2.5 rounded-full bg-surface-border/70" />
                  ))}
                </div>
              ) : deptMeters.length === 0 ? (
                <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
                  {t('noDepartmentData')}
                </p>
              ) : (
                <div className="flex-1 flex flex-col justify-center mt-2">
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
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <SchedulesHubContent />
    </ProtectedRoute>
  );
}
