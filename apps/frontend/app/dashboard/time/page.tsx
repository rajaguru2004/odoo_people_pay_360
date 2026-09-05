'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  UserCheck,
  Clock,
  UserX,
  ClipboardCheck,
  Timer,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import AttentionStrip, { type AttentionItem } from '@/components/module-landing/AttentionStrip';
import type { KpiStat } from '@/components/module-landing/StatCard';
import PresenceRing from '@/components/attendance/hub/PresenceRing';
import DepartmentAttendanceBars from '@/components/attendance/hub/DepartmentAttendanceBars';
import {
  PanelHeader,
  PanelLink,
  PeriodNav,
  BarOverviewChart,
  SegmentedBar,
  SplineTrendChart,
  type BarOverviewItem,
  type BarSegment,
} from '@/components/module-landing/primitives';
import { knownRate, pointsChange, useTimeHub } from '@/hooks/useTimeHub';
import type { HubPeriod } from '@/types/attendanceHub';

/**
 * The tab labels, and the period each one means to the API.
 *
 * `Today` is a period, not a mode: the same ‹ › arrows page back to yesterday,
 * last week, last month or last year, so there is one control to learn.
 */
const PERIOD_TABS: Array<{ label: string; value: HubPeriod }> = [
  { label: 'Today', value: 'today' },
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
  { label: 'Year', value: 'year' },
];

/**
 * Five round ticks that clear the tallest bar without towering over it.
 *
 * The naive `ceil(max/25)*25` put a six-person branch on a 0–25 axis, so every
 * bar sat in the bottom fifth of the panel and the shape of the month was
 * invisible. Step through the 1/2/5 decades instead and take the first that
 * fits.
 */
function axisFor(max: number): { max: number; ticks: string[] } {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const step = steps.find((s) => s * 5 >= max) ?? Math.ceil(max / 5);
  const top = step * 5;
  return { max: top, ticks: Array.from({ length: 6 }, (_, i) => String(i * step)) };
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Time & Attendance module hub.
 *
 * The layout is fixed across every module hub — five KPIs, one big trend, one
 * ranking, three insight panels, an action strip, then the tiles — and only the
 * meaning of each slot changes per module. Here:
 *
 *   KPIs        what happened in the selected period
 *   Trend       its shape — by hour for a day, by day, or by month for a year
 *   Ranking     where the problem is, worst department first
 *   Insights    why: turnout quality, roster adherence, arrival pattern
 *   Attention   what to act on, each item a link to the list behind it
 *
 * ONE clock runs the page. The Today / Week / Month / Year tabs and the ‹ ›
 * arrows move all of it together — cards, chart, ranking and all three insight
 * panels. A panel left on today while the cards above it moved to August would
 * be the same lie in a quieter place: the reader has no way to tell which
 * window they are looking at.
 *
 * What changes with the window is the FORM, not just the number. On a day the
 * cards read "Present today: 6"; on a month they become "Attendance: 98.2%",
 * because 433 employee-days present is not a number anybody can hold. The
 * turnout ring drops its LIVE dot once the window has no day in progress, and
 * "nobody heard from" disappears entirely — on a closed day those people are
 * absent, and the absence figure already says so.
 *
 * The one exception is the corrections queue, which is what is waiting NOW:
 * "corrections raised last March" is not something anybody acts on.
 */
function TimeHubContent() {
  const t = useTranslations('timeHub');
  const tm = useTranslations('moduleLanding');

  const {
    summary,
    period,
    changePeriod,
    step,
    isPast,
    resetToCurrent,
    corrections,
    pendingCorrections,
    oldestCorrectionDays,
    loading,
    fetching,
    correctionsLoading,
    correctionsFailed,
    hubFailed,
  } = useTimeHub();

  const [exporting, setExporting] = useState(false);

  const today = summary?.today;
  const periodStats = summary?.periodStats;
  const attention = summary?.attention;
  const periodLabel = summary?.range.label ?? '';

  const activeTab = PERIOD_TABS.find((p) => p.value === period)?.label ?? 'Month';

  const onTabChange = useCallback(
    (label: string) => {
      const match = PERIOD_TABS.find((p) => p.label === label);
      if (match) changePeriod(match.value);
    },
    [changePeriod],
  );

  /**
   * Whether the selected window is a single day.
   *
   * A day and a month want different headline numbers. "Present: 6" is the
   * answer for today and meaningless for August, where the honest headline is
   * a RATE — 433 employee-days present is a number nobody can hold. So a day
   * shows counts and a longer window shows percentages, and the labels change
   * with them rather than staying "Present today" over a month figure.
   */
  const isDay = period === 'today';
  const prev = summary?.previousStats;
  const prevLabel = summary?.previousRange.label ?? '';

  /**
   * Percentage-point moves against the same window one step back: today vs
   * yesterday, this week vs last week, August vs July.
   *
   * Points, never a percentage of a percentage — attendance going from 40% to
   * 44% is "up 4 points", and calling it "up 10%" invites the reader to think
   * ten people.
   */
  const attendanceDelta = pointsChange(periodStats?.attendanceRate, prev?.attendanceRate);
  const absenceDelta = pointsChange(periodStats?.absentRate, prev?.absentRate);
  const lateDelta = pointsChange(periodStats?.lateRate, prev?.lateRate);
  const hoursDelta =
    knownRate(periodStats?.avgWorkHours) !== undefined &&
    knownRate(prev?.avgWorkHours) !== undefined
      ? Math.round((periodStats!.avgWorkHours! - prev!.avgWorkHours!) * 10) / 10
      : undefined;

  /** A delta badge, or nothing when either side of the comparison is unknown. */
  const delta = (
    points: number | undefined,
    goodDirection: 'up' | 'down',
    suffix = 'pts',
  ): KpiStat['delta'] =>
    points === undefined || points === 0
      ? undefined
      : {
          value: points,
          direction: points >= 0 ? 'up' : 'down',
          goodDirection,
          display: `${Math.abs(points).toFixed(1)} ${suffix}`,
          label: t('vsPrevious', { period: prevLabel }),
        };

  const kpis: KpiStat[] = [
    {
      key: 'present',
      label: isDay ? t('kpiPresentToday') : t('kpiAttendance'),
      value:
        hubFailed || !periodStats
          ? null
          : isDay
          ? periodStats.present
          : periodStats.attendanceRate === null
          ? null
          : `${periodStats.attendanceRate.toFixed(1)}%`,
      icon: UserCheck,
      tone: (periodStats?.attendanceRate ?? 0) >= 90 ? 'success' : 'default',
      delta: delta(attendanceDelta, 'up'),
      footnote:
        !periodStats
          ? undefined
          : periodStats.expected === 0
          ? isDay
            ? t('kpiPresentNobodyExpected')
            : t('kpiNothingExpected')
          : isDay
          ? t('kpiPresentHint', {
              rate: (periodStats.attendanceRate ?? 0).toFixed(1),
              expected: periodStats.expected,
            })
          : t('kpiAttendanceHint', {
              present: periodStats.present,
              expected: periodStats.expected,
            }),
      href: '/dashboard/attendance',
    },
    {
      key: 'absent',
      label: isDay ? t('kpiAbsentToday') : t('kpiAbsenceRate'),
      value:
        hubFailed || !periodStats
          ? null
          : isDay
          ? periodStats.absent
          : periodStats.absentRate === null
          ? null
          : `${periodStats.absentRate.toFixed(1)}%`,
      icon: UserX,
      tone: (periodStats?.absent ?? 0) > 0 ? 'danger' : 'success',
      delta: delta(absenceDelta, 'down'),
      footnote:
        !periodStats
          ? undefined
          : isDay && summary?.range.isCurrent && today && !today.settled
          ? t('kpiAbsentOpenDay', { pending: today.notCheckedIn })
          : isDay
          ? t('kpiAbsentDayHint', { onLeave: periodStats.onLeave })
          : t('kpiAbsenceHint', { days: periodStats.absent }),
      href: '/dashboard/attendance',
    },
    {
      key: 'late',
      label: isDay ? t('kpiLateToday') : t('kpiLateRate'),
      value:
        hubFailed || !periodStats
          ? null
          : isDay
          ? periodStats.late
          : periodStats.lateRate === null
          ? null
          : `${periodStats.lateRate.toFixed(1)}%`,
      icon: Clock,
      tone: (periodStats?.late ?? 0) > 0 ? 'warning' : 'info',
      delta: delta(lateDelta, 'down'),
      footnote:
        knownRate(periodStats?.lateRate) === undefined
          ? t('kpiLateNobodyIn')
          : isDay
          ? t('kpiLateHint', { rate: periodStats!.lateRate!.toFixed(1) })
          : t('kpiLateOccurrences', { count: periodStats!.lateOccurrences }),
      href: '/dashboard/attendance/history',
    },
    {
      key: 'corrections',
      // Deliberately NOT period-scoped: a queue is what is waiting NOW, and
      // "corrections raised last March" is not a thing anybody acts on.
      label: t('kpiCorrections'),
      value: correctionsFailed ? null : pendingCorrections,
      icon: ClipboardCheck,
      tone: oldestCorrectionDays >= 3 ? 'danger' : pendingCorrections > 0 ? 'warning' : 'success',
      footnote: correctionsFailed
        ? t('kpiCorrectionsUnknown')
        : pendingCorrections === 0
        ? t('kpiCorrectionsClear')
        : corrections?.avgResolutionHours != null
        ? t('kpiCorrectionsOldestAndAvg', {
            days: oldestCorrectionDays,
            hours: corrections.avgResolutionHours,
          })
        : t('kpiCorrectionsOldest', { days: oldestCorrectionDays }),
      href: '/dashboard/attendance/corrections',
    },
    {
      key: 'hours',
      label: t('kpiAvgHours'),
      value:
        hubFailed || knownRate(periodStats?.avgWorkHours) === undefined
          ? null
          : `${periodStats!.avgWorkHours!.toFixed(1)}h`,
      icon: Timer,
      tone: 'info',
      delta: delta(hoursDelta, 'up', 'h'),
      footnote: isDay
        ? t('kpiAvgHoursHint')
        : periodStats
        ? t('kpiAvgHoursAcross', { days: periodStats.daysCounted })
        : undefined,
      href: '/dashboard/attendance/reports',
    },
  ];

  /**
   * The action queue. Counts first — a link that says how many is a decision,
   * a name is a task — then the names behind the biggest one, so the reader can
   * start without opening the list.
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
      attention.notCheckedIn.count,
      t('actionNotCheckedIn', { count: attention.notCheckedIn.count }),
      t('actionView'),
      'critical',
      '/dashboard/attendance',
      'not-checked-in',
    );
    push(
      attention.notCheckedOut.count,
      t('actionNotCheckedOut', { count: attention.notCheckedOut.count }),
      t('actionView'),
      'warning',
      '/dashboard/attendance/management',
      'not-checked-out',
    );
    push(
      pendingCorrections,
      t('actionCorrections', { count: pendingCorrections }),
      oldestCorrectionDays > 0 ? t('actionOldest', { days: oldestCorrectionDays }) : t('actionReview'),
      oldestCorrectionDays >= 3 ? 'critical' : 'warning',
      '/dashboard/attendance/corrections',
      'corrections',
    );
    push(
      attention.overScheduledHours.count,
      t('actionOverHours', { count: attention.overScheduledHours.count }),
      t('actionView'),
      'info',
      '/dashboard/attendance/reports',
      'over-hours',
    );
    push(
      attention.late.count,
      t('actionLate', { count: attention.late.count }),
      t('actionView'),
      'warning',
      '/dashboard/attendance/history',
      'late',
    );

    // The names behind the loudest number, so the strip is workable as it is.
    const worst =
      attention.notCheckedIn.names.length > 0
        ? { names: attention.notCheckedIn.names, detail: t('notIn'), severity: 'critical' as const }
        : attention.notCheckedOut.names.length > 0
        ? { names: attention.notCheckedOut.names, detail: t('stillIn'), severity: 'warning' as const }
        : attention.late.names.length > 0
        ? { names: attention.late.names, detail: t('late'), severity: 'warning' as const }
        : null;

    if (worst) {
      worst.names.slice(0, 6).forEach((name, i) =>
        items.push({
          key: `name-${i}-${name}`,
          label: name,
          detail: worst.detail,
          severity: worst.severity,
          href: '/dashboard/attendance',
        }),
      );
    }
    return items;
  }, [attention, pendingCorrections, oldestCorrectionDays, t]);

  /** The main chart: one bar per day (Week/Month) or per month (Year). */
  const { barItems, axis } = useMemo(() => {
    const buckets = summary?.trend ?? [];
    const byHour = summary?.trendKind === 'hour';
    const todayKey = summary?.today.date;

    // An hour expects nobody in particular — people arrive when their shift
    // starts — so an hourly bar is sized by who turned up. Everything else is
    // sized by who was expected, which is what the absences sit inside.
    const heightOf = (b: (typeof buckets)[number]) => (byHour ? b.present : b.expected);

    // Which bar opens with its tooltip showing.
    //
    // For a day that is the BUSIEST hour, because "most people arrive at 1 PM"
    // is the sentence the curve is drawing; the last hour with a straggler in
    // it says nothing. For a longer window it is the most recent bar that has
    // something in it — pinning it to today puts a card of zeros on screen
    // every Sunday, which reads as a broken dashboard rather than a day off.
    let defaultKey: string | undefined;
    if (byHour) {
      let best = 0;
      for (const b of buckets) {
        if (heightOf(b) > best) {
          best = heightOf(b);
          defaultKey = b.key;
        }
      }
    } else {
      for (const b of buckets) if (heightOf(b) > 0) defaultKey = b.key;
      if (buckets.some((b) => b.key === todayKey && b.expected > 0)) {
        defaultKey = todayKey;
      }
    }

    const items: BarOverviewItem[] = buckets.map((b) => ({
      key: b.key,
      label: b.label,
      value: heightOf(b),
      highlight: b.key === defaultKey,
      tooltipTitle: b.label,
      tooltipRows: byHour
        ? [
            {
              label: t('tipOnTime'),
              value: b.onTime,
              color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
            },
            {
              label: t('tipLate'),
              value: b.late,
              color: 'var(--color-status-warning)',
            },
            { label: t('tipArrivals'), value: b.present, emphasis: true },
          ]
        : [
            { label: t('tipExpected'), value: b.expected },
            {
              label: t('tipPresent'),
              value: b.present,
              color: 'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 70%, white)',
            },
            {
              label: t('tipLate'),
              value: b.late,
              color: 'var(--color-status-warning)',
            },
            {
              label: t('tipAbsent'),
              value: b.absent,
              color: 'var(--color-status-error)',
            },
            {
              label: t('tipAttendance'),
              value: b.attendanceRate === null ? '\u2014' : `${b.attendanceRate.toFixed(1)}%`,
              emphasis: true,
            },
          ],
    }));
    return {
      barItems: items,
      axis: axisFor(Math.max(1, ...buckets.map(heightOf))),
    };
  }, [summary, t]);

  /** Roster adherence over the selected window. */
  const shiftSegments: BarSegment[] = useMemo(() => {
    const s = summary?.shifts;
    const base = Math.max(s?.scheduled ?? 0, 1);
    const share = (n: number) => `${Math.round((n / base) * 100)}%`;
    return [
      {
        key: 'onShift',
        label: t('segOnShift'),
        value: s?.onShift ?? 0,
        color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
        shareLabel: share(s?.onShift ?? 0),
      },
      {
        key: 'late',
        label: t('segLate'),
        value: s?.late ?? 0,
        color: 'color-mix(in srgb, var(--color-brand-accent) 75%, white)',
        shareLabel: share(s?.late ?? 0),
      },
      {
        key: 'yetToCheckIn',
        label: t('segYetToCheckIn'),
        value: s?.yetToCheckIn ?? 0,
        color: 'color-mix(in srgb, var(--color-brand-primary) 40%, white)',
        shareLabel: share(s?.yetToCheckIn ?? 0),
      },
      {
        key: 'onLeave',
        label: t('segOnLeave'),
        value: s?.onLeave ?? 0,
        color: 'var(--color-status-info)',
        shareLabel: share(s?.onLeave ?? 0),
      },
    ];
  }, [summary, t]);

  /** Today's arrival pattern — on time against late, hour by hour. */
  const arrival = summary?.arrivalPattern ?? [];
  const arrivalSeries = useMemo(
    () => [
      {
        key: 'onTime',
        values: arrival.map((a) => a.onTime),
        color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
      },
      {
        key: 'late',
        values: arrival.map((a) => a.late),
        color: 'color-mix(in srgb, var(--color-brand-accent) 75%, white)',
      },
    ],
    [arrival],
  );
  const arrivalTicks = useMemo(
    () => arrival.filter((_, i) => i % 3 === 0).map((a) => a.label),
    [arrival],
  );
  /**
   * On-time arrivals as a share of everyone who turned up in the window.
   *
   * Of ARRIVALS, not of expected: this sits beside a curve of arrivals, and
   * mixing the two denominators in one card is how a reader ends up believing
   * a number nobody computed.
   */
  const onTimeShare = useMemo(() => {
    if (!periodStats || periodStats.present === 0) return undefined;
    return ((periodStats.present - periodStats.late) / periodStats.present) * 100;
  }, [periodStats]);

  /** The busiest arrival hour, which is the sentence the curve is drawing. */
  const peakArrival = useMemo(() => {
    let best: (typeof arrival)[number] | null = null;
    for (const a of arrival) {
      if (!best || a.onTime + a.late > best.onTime + best.late) best = a;
    }
    return best && best.onTime + best.late > 0 ? best : null;
  }, [arrival]);

  /** The period, as a spreadsheet. */
  const handleExport = useCallback(() => {
    if (!summary) return;
    setExporting(true);
    try {
      // A day exports its arrival curve, because that is what its rows ARE —
      // an "expected" column against an hour would be a column of noise.
      const byHour = summary.trendKind === 'hour';
      const header = byHour
        ? ['hour', 'arrivals', 'on_time', 'late']
        : [
            'date',
            'expected',
            'present',
            'on_time',
            'late',
            'absent',
            'on_leave',
            'attendance_rate_pct',
          ];
      const body = summary.trend.map((b) =>
        (byHour
          ? [`${b.key}:00`, b.present, b.onTime, b.late]
          : [
              b.key,
              b.expected,
              b.present,
              b.onTime,
              b.late,
              b.absent,
              b.onLeave,
              b.attendanceRate ?? '',
            ]
        )
          .map(csvCell)
          .join(','),
      );
      const csv = [header.join(','), ...body].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a');
      a.href = url;
      a.download =
        summary.range.start === summary.range.end
          ? `attendance-${summary.range.start}.csv`
          : `attendance-${summary.period}-${summary.range.start}-to-${summary.range.end}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [summary]);

  // The ring divides by the same `expected` as every other rate on the page.
  const turnoutTotal = periodStats?.expected ?? 0;

  return (
    <ModuleLandingPage
      moduleKey="timeAttendance"
      title={tm('timeAttendance.title')}
      subtitle={tm('timeAttendance.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      // The only hub with a real period filter: its tabs are controlled, the
      // stepper re-queries, and Export writes a CSV of the window on screen.
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
      badges={{ attendanceRequests: pendingCorrections }}
      badgeTones={{ attendanceRequests: oldestCorrectionDays >= 3 ? 'danger' : 'warning' }}
      insights={
        <div className="space-y-6">
          {/* What to act on */}
          <AttentionStrip
            title={t('needsAttention')}
            items={attentionItems}
            loading={loading || correctionsLoading}
            emptyLabel={t('needsChasingEmpty')}
            seeAll={{ label: t('seeOverview'), href: '/dashboard/attendance' }}
          />

          {/* Middle row: the period's trend + where the problem is */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 xl:col-span-8 surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <PanelHeader
                title={t('attendanceOverview')}
                hint={
                  !periodStats
                    ? undefined
                    : isDay
                    ? // A day's chart is its arrival curve, so the hint says so
                      // rather than quoting a rate the bars do not draw.
                      t('attendanceOverviewHintDay', { period: periodLabel })
                    : t('attendanceOverviewHint', {
                        period: periodLabel,
                        rate:
                          periodStats.attendanceRate === null
                            ? '—'
                            : `${periodStats.attendanceRate.toFixed(1)}%`,
                      })
                }
                action={<PanelLink href="/dashboard/attendance/reports">{t('viewDetails')}</PanelLink>}
              />
              {/* min-h keeps the chart readable when this panel is the short
                  one; flex-1 lets it fill when the department list is taller. */}
              <div className="mt-2 pt-2 flex-1 min-h-[260px] flex">
                {barItems.length === 0 || barItems.every((b) => b.value === 0) ? (
                  <p className="text-[13px] text-text-muted py-16 text-center w-full">
                    {isDay ? t('noArrivalsInDay') : t('noTrendData')}
                  </p>
                ) : (
                  <div className="flex-1">
                    <BarOverviewChart
                      items={barItems}
                      height="100%"
                      maxVal={axis.max}
                      yAxisTicks={axis.ticks}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-5 xl:col-span-4 flex flex-col">
              <DepartmentAttendanceBars
                rows={summary?.departments}
                loading={loading}
                periodLabel={periodLabel}
              />
            </div>
          </div>

          {/* Bottom row: turnout quality, roster adherence, arrival pattern */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="h-full">
              <PresenceRing
                present={periodStats?.present ?? 0}
                late={periodStats?.late ?? 0}
                absent={periodStats?.absent ?? 0}
                // Only an open day has anyone "not heard from"; once a day
                // closes those people are absent, and the arc above says so.
                notCheckedIn={isDay ? attention?.notCheckedIn.count ?? 0 : 0}
                onLeave={periodStats?.onLeave ?? 0}
                total={turnoutTotal}
                title={isDay ? t('turnout') : t('turnoutPeriod', { period: periodLabel })}
                live={Boolean(isDay && summary?.range.isCurrent)}
                loading={loading}
              />
            </div>

            <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <div>
                <PanelHeader
                  title={t('shiftOverview')}
                  hint={
                    !summary
                      ? undefined
                      : summary.shifts.source === 'roster'
                      ? t('shiftHintRosterPeriod', {
                          count: summary.shifts.shiftCount,
                          period: periodLabel,
                        })
                      : t('shiftHintCalendarPeriod', { period: periodLabel })
                  }
                  action={<PanelLink href="/dashboard/schedules">{t('schedule')}</PanelLink>}
                />
                <div className="flex items-baseline gap-2.5 my-2">
                  <span className="text-[28px] font-extrabold text-text-heading tracking-tight leading-none tabular-nums">
                    {summary?.shifts.checkedIn ?? 0}
                    <span className="text-[15px] font-bold text-text-muted">
                      /{summary?.shifts.scheduled ?? 0}
                    </span>
                  </span>
                  <span className="text-xs font-semibold text-text-muted">{t('checkedInOfScheduled')}</span>
                </div>
              </div>

              <div className="mt-4">
                <SegmentedBar segments={shiftSegments} height={14} />
              </div>
            </div>

            <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-3 mb-1">
                  <span className="text-[15px] font-bold text-text-heading">
                    {isDay ? t('arrivalPattern') : t('arrivalPatternPeriod')}
                  </span>
                  <div className="flex items-center gap-3 text-[11px] font-medium text-text-muted">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="w-2 h-2 rounded-xs"
                        style={{ background: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)' }}
                      />
                      {t('onTime')}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className="w-2 h-2 rounded-xs"
                        style={{ background: 'color-mix(in srgb, var(--color-brand-accent) 75%, white)' }}
                      />
                      {t('late')}
                    </span>
                  </div>
                </div>

                <div className="flex items-baseline gap-2.5 my-2">
                  <span className="text-[28px] font-extrabold text-text-heading tracking-tight leading-none tabular-nums">
                    {peakArrival ? peakArrival.label : '—'}
                  </span>
                  {peakArrival && (
                    <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-text-muted">
                      {t('peakArrivals', { count: peakArrival.onTime + peakArrival.late })}
                    </span>
                  )}
                  {onTimeShare !== undefined && (
                    <span
                      className={`inline-flex items-center gap-0.5 text-xs font-semibold ${
                        onTimeShare >= 80 ? 'text-status-success' : 'text-status-warning'
                      }`}
                    >
                      {onTimeShare >= 80 ? (
                        <ArrowUpRight size={13} strokeWidth={2.5} />
                      ) : (
                        <ArrowDownRight size={13} strokeWidth={2.5} />
                      )}
                      {t('onTimeShare', { rate: onTimeShare.toFixed(0) })}
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-2">
                <SplineTrendChart
                  height={140}
                  series={arrivalSeries}
                  timeTicks={arrivalTicks}
                  emptyLabel={isDay ? t('noArrivalsYet') : t('noArrivalsInPeriod')}
                />
              </div>
            </div>
          </div>
        </div>
      }
    />
  );
}

export default function TimeAttendanceHubPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <TimeHubContent />
    </ProtectedRoute>
  );
}
