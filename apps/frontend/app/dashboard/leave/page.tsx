'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CalendarRange,
  CalendarCheck2,
  Hourglass,
  Scale,
  Gauge,
  TimerReset,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
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
  SegmentedBar,
  SplineTrendChart,
  type BarOverviewItem,
  type BarSegment,
  type DonutSlice,
  type MeterRow,
} from '@/components/module-landing/primitives';
import { useLeaveHub } from '@/hooks/useLeaveHub';
import { axisFor, downloadCsv } from '@/utils/chartAxis';
import type { HubPeriod } from '@/types/leaveHub';

/**
 * The tab labels, and the period each one means to the API.
 *
 * No `Today` tab: "leave filed today" is not a question anybody opens a module
 * hub with. Month leads and is the default — leave accrues monthly and payroll
 * consumes overtime monthly, so that is the cycle these numbers live in.
 */
const PERIOD_TABS: Array<{ label: string; value: HubPeriod }> = [
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
  { label: 'Year', value: 'year' },
];

const STATUS_COLORS = {
  approved: 'var(--color-status-success)',
  pending: 'var(--color-status-warning)',
  rejected: 'var(--color-status-error)',
  cancelled: 'color-mix(in srgb, var(--color-text-muted) 40%, white)',
} as const;

const TYPE_SHADES = [
  'var(--color-brand-accent, #FF5A1F)',
  'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 85%, white)',
  'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 70%, white)',
  'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 55%, white)',
  'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 42%, white)',
  'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 30%, white)',
];

/**
 * Leave & Overtime module hub.
 *
 * Same layout as `app/dashboard/time/page.tsx`, the finalized module hub. Two
 * questions on one page, because they are the same trade: hours the company
 * owes against hours it has bought.
 *
 *   KPIs        what the window did, and what is waiting
 *   Trend       requests over time, stacked by status
 *   Ranking     which kinds of leave people are consuming
 *   Insights    the status split, the balance, and who is carrying overtime
 *   Attention   what to act on, each item a link to its queue
 *
 * ## The KPI row changes MEANING with the period, not just its numbers
 *
 * A week and a year want different headlines. "Leave days this week: 12" is
 * useful; "leave days this year: 4,180" is a number nobody can hold, and the
 * honest headline over a year is utilisation. So the selector re-chooses which
 * five of `periodStats` are worth the space — see `KPI_BY_PERIOD` below.
 *
 * The one card that never moves is **Pending approvals**. A queue is what is
 * waiting NOW; "approvals pending last March" is not a thing anybody acts on.
 * The Time & Attendance hub keeps its correction queue unwindowed for the same
 * reason.
 */
function LeaveHubContent() {
  const t = useTranslations('leaveHub');
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
  } = useLeaveHub();

  const [exporting, setExporting] = useState(false);

  const stats = summary?.periodStats;
  const prev = summary?.previousStats;
  const attention = summary?.attention;
  const overtime = summary?.overtime;
  const periodLabel = summary?.range.label ?? '';
  const prevLabel = summary?.previousRange.label ?? '';
  const otEnabled = overtime?.enabled ?? true;

  const activeTab = PERIOD_TABS.find((p) => p.value === period)?.label ?? 'Month';

  const onTabChange = useCallback(
    (label: string) => {
      const match = PERIOD_TABS.find((p) => p.label === label);
      if (match) changePeriod(match.value);
    },
    [changePeriod],
  );

  /** A delta badge in percentage POINTS, or nothing when either side is unknown. */
  const pointsDelta = useCallback(
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

  /** A delta on a COUNT, expressed as a percentage of the previous window. */
  const countDelta = useCallback(
    (
      current: number | undefined,
      previous: number | undefined,
      goodDirection: 'up' | 'down',
    ): KpiStat['delta'] => {
      if (current === undefined || !previous) return undefined;
      const pct = Math.round(((current - previous) / previous) * 1000) / 10;
      if (pct === 0) return undefined;
      return {
        value: pct,
        direction: pct >= 0 ? 'up' : 'down',
        goodDirection,
        display: `${Math.abs(pct).toFixed(1)}%`,
        label: t('vsPrevious', { period: prevLabel }),
      };
    },
    [prevLabel, t],
  );

  const unknown = hubFailed || !stats;

  /**
   * The five cards, per period.
   *
   * Every value comes from the same `periodStats`; the selector only decides
   * which five earn the space and how they are worded. Position 2 is Pending
   * Approvals in all three, deliberately.
   */
  const kpis: KpiStat[] = useMemo(() => {
    const requests: KpiStat = {
      key: 'requests',
      label: period === 'week' ? t('kpiRequestsWeek') : t('kpiRequestsMonth'),
      value: unknown ? null : stats!.requests,
      icon: CalendarRange,
      tone: 'default',
      delta: countDelta(stats?.requests, prev?.requests, 'down'),
      footnote: !stats
        ? undefined
        : stats.approvalRate === null
        ? // "{rate}% approval rate" with an em dash substituted in reads as
          // "—% approval rate". With nothing filed there is no rate at all.
          t('kpiRequestsHintNone')
        : t('kpiRequestsHint', {
            approved: stats.approved,
            rate: stats.approvalRate.toFixed(0),
          }),
      href: '/dashboard/leaves',
    };

    const pending: KpiStat = {
      key: 'pending',
      // Deliberately NOT period-scoped. A queue is what is waiting now.
      label: t('kpiPending'),
      value: unknown ? null : stats!.pending,
      icon: CalendarCheck2,
      tone:
        (stats?.pendingOlderThan2Days ?? 0) > 0
          ? 'danger'
          : (stats?.pending ?? 0) > 0
          ? 'warning'
          : 'success',
      footnote: !stats
        ? undefined
        : stats.pending === 0
        ? t('kpiPendingClear')
        : stats.pendingOlderThan2Days > 0
        ? t('kpiPendingStale', { count: stats.pendingOlderThan2Days })
        : t('kpiPendingFresh'),
      href: '/dashboard/leaves/pending',
    };

    const onLeave: KpiStat = {
      key: 'onLeave',
      label: t('kpiOnLeaveToday'),
      value: unknown ? null : stats!.onLeaveToday,
      icon: CalendarRange,
      tone: 'info',
      footnote: !stats
        ? undefined
        : stats.onLeaveTodayRate === null
        ? t('kpiNobodyActive')
        : t('kpiOnLeaveTodayHint', { rate: stats.onLeaveTodayRate.toFixed(1) }),
      href: '/dashboard/leaves',
    };

    const leaveDays: KpiStat = {
      key: 'leaveDays',
      label: t('kpiLeaveDaysWeek'),
      value: unknown ? null : t('days', { count: stats!.leaveDays }),
      icon: Layers,
      tone: 'default',
      delta: countDelta(stats?.leaveDays, prev?.leaveDays, 'down'),
      footnote: t('kpiLeaveDaysHint'),
      href: '/dashboard/leaves',
    };

    const utilisation: KpiStat = {
      key: 'utilisation',
      label: t('kpiUtilisation'),
      value: unknown || stats!.utilisation === null ? null : `${stats!.utilisation.toFixed(1)}%`,
      icon: Gauge,
      // Low utilisation early in the year is normal; low late is a queue
      // forming for December.
      tone: stats?.utilisation !== null && (stats?.utilisation ?? 0) < 40 ? 'warning' : 'default',
      delta: pointsDelta(stats?.utilisation, prev?.utilisation, 'up'),
      footnote: stats
        ? t('kpiUtilisationHint', { used: stats.used, allocated: stats.allocated + stats.carriedOver })
        : undefined,
      href: '/dashboard/leaves/balances',
    };

    const remaining: KpiStat = {
      key: 'remaining',
      label: t('kpiRemaining'),
      value: unknown ? null : t('days', { count: stats!.remaining }),
      icon: Scale,
      tone: 'info',
      // Days, not money: converting to cash needs a per-employee rate this
      // endpoint does not carry, and a wrong currency figure is worse than none.
      footnote:
        stats?.averageBalance === null || stats?.averageBalance === undefined
          ? t('kpiRemainingHint')
          : t('kpiRemainingAverage', { days: stats.averageBalance }),
      href: '/dashboard/leaves/balances',
    };

    const averageBalance: KpiStat = {
      ...remaining,
      key: 'averageBalance',
      label: t('kpiAverageBalance'),
      value:
        unknown || stats!.averageBalance === null
          ? null
          : t('days', { count: stats!.averageBalance }),
      footnote: stats ? t('kpiAverageBalanceHint', { total: stats.remaining }) : undefined,
    };

    const topType: KpiStat = {
      key: 'topType',
      label: t('kpiTopLeaveType'),
      value: unknown ? null : summary?.periodStats.topLeaveType ?? null,
      icon: Layers,
      tone: 'default',
      footnote: summary?.leaveTypes?.[0]
        ? t('kpiTopLeaveTypeHint', {
            days: summary.leaveTypes[0].days,
            share: summary.leaveTypes[0].share?.toFixed(0) ?? '—',
          })
        : undefined,
      href: '/dashboard/leaves/balances',
    };

    const consumed: KpiStat = {
      key: 'consumed',
      label: t('kpiConsumed'),
      value: unknown ? null : t('days', { count: stats!.leaveDays }),
      icon: CalendarRange,
      tone: 'default',
      delta: countDelta(stats?.leaveDays, prev?.leaveDays, 'down'),
      footnote: stats ? t('kpiConsumedHint', { requests: stats.approved }) : undefined,
      href: '/dashboard/leaves',
    };

    /**
     * The overtime card, or its stand-in.
     *
     * With `overtime_enabled` off there is no overtime to report — drawing 0h
     * would say "nobody worked late", which is a different and false claim. The
     * slot goes to the leave approval rate instead, so the row keeps its five
     * cards rather than rendering a hole.
     */
    const overtimeCard: KpiStat = otEnabled
      ? {
          key: 'overtime',
          label: period === 'week' ? t('kpiOvertimeWeek') : t('kpiOvertime'),
          value: unknown ? null : t('hours', { hours: stats!.overtimeHours }),
          icon: TimerReset,
          tone: (stats?.overtimeHours ?? 0) > 0 ? 'warning' : 'success',
          delta: countDelta(stats?.overtimeHours, prev?.overtimeHours, 'down'),
          footnote:
            stats?.avgOvertimePerEmployee == null
              ? t('kpiOvertimeNone')
              : t('kpiOvertimeHint', {
                  people: stats.overtimeEmployees,
                  avg: stats.avgOvertimePerEmployee,
                }),
          href: '/dashboard/overtime',
        }
      : {
          key: 'approvalRate',
          label: t('kpiApprovalRate'),
          value:
            unknown || stats!.approvalRate === null ? null : `${stats!.approvalRate.toFixed(0)}%`,
          icon: Hourglass,
          tone: 'default',
          delta: pointsDelta(stats?.approvalRate, prev?.approvalRate, 'up'),
          footnote: stats
            ? t('kpiApprovalRateHint', { approved: stats.approved, total: stats.requests })
            : undefined,
          href: '/dashboard/leaves',
        };

    if (period === 'week') {
      return [requests, pending, onLeave, leaveDays, overtimeCard];
    }
    if (period === 'year') {
      // A year's headline is not a count of days nobody can hold — it is how
      // much of the entitlement the company actually used.
      return [consumed, pending, utilisation, topType, averageBalance];
    }
    return [requests, pending, utilisation, remaining, overtimeCard];
  }, [period, stats, prev, summary, unknown, otEnabled, t, countDelta, pointsDelta]);

  /** The action queue. Counts first, then the names behind the biggest one. */
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
      attention.stale.count,
      t('actionStale', { count: attention.stale.count }),
      t('actionApprove'),
      'critical',
      '/dashboard/leaves/pending',
      'stale',
    );
    push(
      attention.pending.count,
      t('actionPending', { count: attention.pending.count }),
      t('actionApprove'),
      'warning',
      '/dashboard/leaves/pending',
      'pending',
    );
    push(
      attention.onLeaveToday.count,
      t('actionOnLeaveToday', { count: attention.onLeaveToday.count }),
      t('actionView'),
      'info',
      '/dashboard/leaves',
      'on-leave',
    );
    if (otEnabled) {
      push(
        attention.highOvertime.count,
        t('actionHighOvertime', { count: attention.highOvertime.count }),
        t('actionReview'),
        'warning',
        '/dashboard/overtime',
        'high-overtime',
      );
    }

    const worst =
      attention.stale.names.length > 0
        ? { names: attention.stale.names, detail: t('waiting'), severity: 'critical' as const, href: '/dashboard/leaves/pending' }
        : attention.pending.names.length > 0
        ? { names: attention.pending.names, detail: t('awaitingApproval'), severity: 'warning' as const, href: '/dashboard/leaves/pending' }
        : attention.onLeaveToday.names.length > 0
        ? { names: attention.onLeaveToday.names, detail: t('onLeave'), severity: 'info' as const, href: '/dashboard/leaves' }
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
  }, [attention, otEnabled, t]);

  /** The main chart: requests per bucket, stacked by status. */
  const { barItems, axis } = useMemo(() => {
    const buckets = summary?.trend ?? [];

    // Open on the busiest bucket — the sentence the chart is drawing. Pinning
    // it to the current bucket puts a card of zeros on screen for most of a
    // month, which reads as a broken dashboard rather than a quiet week.
    let defaultKey: string | undefined;
    let best = 0;
    for (const b of buckets) {
      if (b.total > best) {
        best = b.total;
        defaultKey = b.key;
      }
    }

    const items: BarOverviewItem[] = buckets.map((b) => ({
      key: b.key,
      label: b.label,
      value: b.total,
      highlight: b.key === defaultKey,
      segments: [
        { key: 'approved', label: t('statusApproved'), value: b.approved, color: STATUS_COLORS.approved },
        { key: 'pending', label: t('statusPending'), value: b.pending, color: STATUS_COLORS.pending },
        { key: 'rejected', label: t('statusRejected'), value: b.rejected, color: STATUS_COLORS.rejected },
        { key: 'cancelled', label: t('statusCancelled'), value: b.cancelled, color: STATUS_COLORS.cancelled },
      ],
      tooltipTitle: b.label,
    }));

    return {
      barItems: items,
      axis: axisFor(Math.max(1, ...buckets.map((b) => b.total))),
    };
  }, [summary, t]);

  /** Right-side: what kinds of leave people are consuming. */
  const typeMeters: MeterRow[] = useMemo(() => {
    const types = (summary?.leaveTypes ?? []).slice(0, 6);
    const top = Math.max(1, ...types.map((x) => x.days));
    return types.map((x, i) => ({
      key: x.key,
      label: x.name,
      percent: (x.days / top) * 100,
      valueLabel:
        x.share === null
          ? t('days', { count: x.days })
          : t('typeValue', { days: x.days, share: x.share.toFixed(0) }),
      color: TYPE_SHADES[Math.min(i, TYPE_SHADES.length - 1)],
    }));
  }, [summary, t]);

  /** Bottom-left: the status split, all four of them. */
  const statusSlices: DonutSlice[] = useMemo(() => {
    const s = summary?.status;
    return [
      { key: 'approved', label: t('statusApproved'), value: s?.approved ?? 0, color: STATUS_COLORS.approved },
      { key: 'pending', label: t('statusPending'), value: s?.pending ?? 0, color: STATUS_COLORS.pending },
      { key: 'rejected', label: t('statusRejected'), value: s?.rejected ?? 0, color: STATUS_COLORS.rejected },
      { key: 'cancelled', label: t('statusCancelled'), value: s?.cancelled ?? 0, color: STATUS_COLORS.cancelled },
    ];
  }, [summary, t]);

  const statusTotal = statusSlices.reduce((a, s) => a + s.value, 0);

  /** Bottom-middle: entitled against used against remaining. */
  const balance = summary?.balance;
  const balanceSegments: BarSegment[] = useMemo(() => {
    const entitled = (balance?.allocated ?? 0) + (balance?.carriedOver ?? 0);
    const share = (n: number) => (entitled > 0 ? `${Math.round((n / entitled) * 100)}%` : '—');
    return [
      {
        key: 'used',
        label: t('balanceUsed'),
        value: balance?.used ?? 0,
        color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
        shareLabel: share(balance?.used ?? 0),
      },
      {
        key: 'remaining',
        label: t('balanceRemaining'),
        value: balance?.remaining ?? 0,
        color: 'color-mix(in srgb, var(--color-brand-primary) 35%, white)',
        shareLabel: share(balance?.remaining ?? 0),
      },
    ];
  }, [balance, t]);

  /** Bottom-right: the overtime curve, and who is carrying it. */
  const overtimeSeries = useMemo(() => {
    const buckets = overtime?.trend ?? [];
    if (!buckets.length) return [];
    return [
      {
        key: 'hours',
        values: buckets.map((b) => b.hours),
        color: 'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 85%, white)',
      },
    ];
  }, [overtime]);

  const overtimeTicks = useMemo(() => {
    const buckets = overtime?.trend ?? [];
    const every = Math.max(1, Math.ceil(buckets.length / 5));
    return buckets.filter((_, i) => i % every === 0).map((b) => b.label);
  }, [overtime]);

  /** Average approval turnaround stands in for the OT panel when OT is off. */
  const handleExport = useCallback(() => {
    if (!summary) return;
    setExporting(true);
    try {
      downloadCsv(
        `leave-overtime-${summary.period}-${summary.range.start}-to-${summary.range.end}.csv`,
        ['bucket', 'approved', 'pending', 'rejected', 'cancelled', 'total', 'overtime_hours'],
        summary.trend.map((b, i) => [
          b.key,
          b.approved,
          b.pending,
          b.rejected,
          b.cancelled,
          b.total,
          summary.overtime.trend[i]?.hours ?? '',
        ]),
      );
    } finally {
      setExporting(false);
    }
  }, [summary]);

  const otDelta =
    stats && prev && prev.overtimeHours > 0
      ? Math.round(((stats.overtimeHours - prev.overtimeHours) / prev.overtimeHours) * 1000) / 10
      : undefined;

  return (
    <ModuleLandingPage
      moduleKey="leaveOvertime"
      title={tm('leaveOvertime.title')}
      subtitle={tm('leaveOvertime.subtitle')}
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
      badges={{
        pendingLeaves: stats?.pending,
        overtimeRequests: otEnabled ? stats?.overtimeRequests : undefined,
      }}
      badgeTones={{
        pendingLeaves: (stats?.pendingOlderThan2Days ?? 0) > 0 ? 'danger' : 'warning',
        overtimeRequests: 'warning',
      }}
      insights={
        <div className="space-y-6">
          {/* What to act on */}
          <AttentionStrip
            title={t('needsAttention')}
            items={attentionItems}
            loading={loading}
            emptyLabel={hubFailed ? t('leaveUnknown') : t('queuesClear')}
            seeAll={{ label: t('seePending'), href: '/dashboard/leaves/pending' }}
          />

          {/* Middle row: the period's requests + what kinds of leave */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 xl:col-span-8 surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <PanelHeader
                title={t('leaveTrend')}
                hint={
                  !stats
                    ? undefined
                    : stats.approvalRate === null
                    ? // An em dash substituted into "{period} — {rate} approved"
                      // reads as "Aug 2026 — — approved". When there is no rate
                      // the honest hint is that nothing was filed.
                      t('leaveTrendHintEmpty', { period: periodLabel })
                    : t('leaveTrendHint', {
                        period: periodLabel,
                        rate: `${stats.approvalRate.toFixed(0)}%`,
                      })
                }
                action={<PanelLink href="/dashboard/leaves">{t('viewDetails')}</PanelLink>}
              />
              <div className="mt-2 pt-2 flex-1 min-h-[260px] flex">
                {barItems.length === 0 || barItems.every((b) => b.value === 0) ? (
                  <p className="text-[13px] text-text-muted py-16 text-center w-full">
                    {t('noRequests')}
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
                title={t('leaveTypes')}
                hint={stats ? t('leaveTypesHint', { period: periodLabel }) : undefined}
                action={
                  <PanelLink href="/dashboard/leaves/balances">{t('seeBalances')}</PanelLink>
                }
              />
              {loading ? (
                <div className="mt-4 space-y-6 animate-pulse">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-2.5 rounded-full bg-surface-border/70" />
                  ))}
                </div>
              ) : typeMeters.length === 0 ? (
                <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
                  {t('noLeaveTypes')}
                </p>
              ) : (
                <div className="flex-1 flex flex-col justify-center mt-2">
                  <MeterList rows={typeMeters} />
                </div>
              )}
            </div>
          </div>

          {/* Bottom row: status split, balance, overtime */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="surface-panel p-6 rounded-[20px] flex flex-col">
              <PanelHeader
                title={t('leaveStatus')}
                hint={t('leaveStatusHint', { period: periodLabel })}
              />
              {loading ? (
                <div className="flex-1 grid place-items-center animate-pulse">
                  <div className="h-[175px] w-[175px] rounded-full bg-surface-border/70" />
                </div>
              ) : statusTotal === 0 ? (
                <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
                  {t('noRequests')}
                </p>
              ) : (
                <div className="flex-1 flex flex-col gap-5 my-auto pt-2">
                  <DonutChart
                    slices={statusSlices}
                    size={168}
                    thickness={22}
                    caption={String(statusTotal)}
                    subCaption={t('ofRequests')}
                  />
                  <DonutLegend slices={statusSlices} total={statusTotal} />
                </div>
              )}
            </div>

            <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <div>
                <PanelHeader
                  title={t('leaveBalance')}
                  hint={
                    balance
                      ? t('leaveBalanceHint', {
                          year: summary?.range.end.slice(0, 4) ?? '',
                        })
                      : undefined
                  }
                  action={
                    <PanelLink href="/dashboard/leaves/balances">{t('seeBalances')}</PanelLink>
                  }
                />
                {/* A lone em dash beside the word "utilised" reads as a
                    rendering fault. With no entitlement there is nothing to be
                    a percentage OF, so the panel says that instead. */}
                {balance && balance.allocated + balance.carriedOver === 0 ? (
                  <p className="text-[13px] text-text-muted my-3">
                    {t('leaveBalanceNone', { year: summary?.range.end.slice(0, 4) ?? '' })}
                  </p>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2.5 my-2">
                      <span className="text-[28px] font-extrabold text-text-heading tracking-tight leading-none tabular-nums">
                        {balance?.utilisation === null || balance?.utilisation === undefined
                          ? '—'
                          : `${balance.utilisation.toFixed(1)}%`}
                      </span>
                      <span className="text-xs font-semibold text-text-muted">
                        {t('utilised')}
                      </span>
                    </div>
                    <p className="text-[11px] text-text-muted">
                      {balance
                        ? t('entitledOf', {
                            entitled: balance.allocated + balance.carriedOver,
                          })
                        : ''}
                    </p>
                  </>
                )}
              </div>

              <div className="mt-4">
                <SegmentedBar segments={balanceSegments} height={14} />
              </div>
            </div>

            <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              {otEnabled ? (
                <>
                  <div>
                    <PanelHeader
                      title={t('overtimeInsight')}
                      hint={t('overtimeInsightHint', { period: periodLabel })}
                      action={<PanelLink href="/dashboard/overtime">{t('seeOvertime')}</PanelLink>}
                    />
                    <div className="flex items-baseline gap-2.5 my-2">
                      <span className="text-[28px] font-extrabold text-text-heading tracking-tight leading-none tabular-nums">
                        {unknown ? '—' : t('hours', { hours: stats!.overtimeHours })}
                      </span>
                      {otDelta !== undefined && otDelta !== 0 && (
                        <span
                          className={`inline-flex items-center gap-0.5 text-xs font-semibold ${
                            otDelta > 0 ? 'text-status-error' : 'text-status-success'
                          }`}
                        >
                          {otDelta > 0 ? (
                            <ArrowUpRight size={13} strokeWidth={2.5} />
                          ) : (
                            <ArrowDownRight size={13} strokeWidth={2.5} />
                          )}
                          {`${Math.abs(otDelta).toFixed(1)}%`}
                        </span>
                      )}
                    </div>
                    <div className="space-y-0.5 text-[11px] text-text-muted">
                      <p>
                        {overtime?.topDepartment
                          ? t('topDepartment', {
                              name: overtime.topDepartment.name,
                              hours: overtime.topDepartment.hours,
                            })
                          : t('noOvertimeDepartment')}
                      </p>
                      <p>
                        {overtime?.topEmployee
                          ? t('topEmployee', {
                              name: overtime.topEmployee.name,
                              hours: overtime.topEmployee.hours,
                            })
                          : t('noOvertimeEmployee')}
                      </p>
                    </div>
                  </div>

                  <div className="mt-2">
                    <SplineTrendChart
                      height={130}
                      series={overtimeSeries}
                      timeTicks={overtimeTicks}
                      emptyLabel={t('noOvertime')}
                    />
                  </div>
                </>
              ) : (
                /* `overtime_enabled` is off. Rather than a panel of zeros — which
                   would read as "nobody worked late" — the slot reports the
                   thing this module still has: how the leave queue is moving. */
                <>
                  <div>
                    <PanelHeader
                      title={t('queueHealth')}
                      hint={t('queueHealthHint', { period: periodLabel })}
                      action={
                        <PanelLink href="/dashboard/leaves/pending">{t('seePending')}</PanelLink>
                      }
                    />
                    <div className="flex items-baseline gap-2.5 my-2">
                      <span className="text-[28px] font-extrabold text-text-heading tracking-tight leading-none tabular-nums">
                        {unknown || stats!.approvalRate === null
                          ? '—'
                          : `${stats!.approvalRate.toFixed(0)}%`}
                      </span>
                      <span className="text-xs font-semibold text-text-muted">
                        {t('approved')}
                      </span>
                    </div>
                    <p className="text-[11px] text-text-muted">{t('overtimeOff')}</p>
                  </div>
                  <div className="mt-4">
                    <SegmentedBar
                      segments={statusSlices.map((s) => ({
                        key: s.key,
                        label: s.label,
                        value: s.value,
                        color: s.color,
                      }))}
                      height={14}
                      legendColumns={2}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      }
    />
  );
}

export default function LeaveOvertimeHubPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <LeaveHubContent />
    </ProtectedRoute>
  );
}
