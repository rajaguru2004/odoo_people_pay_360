'use client';

import { useCallback, useMemo, useState } from 'react';
import { CalendarCheck, CalendarClock, Hourglass, Timer, Wallet } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import type { KpiStat } from '@/components/module-landing/StatCard';
import { PeriodNav } from '@/components/module-landing/primitives';
import LeaveAttentionStrip from '@/components/leave/hub/LeaveAttentionStrip';
import LeaveTrendPanel from '@/components/leave/hub/LeaveTrendPanel';
import LeaveTypePanel from '@/components/leave/hub/LeaveTypePanel';
import BalancePanel from '@/components/leave/hub/BalancePanel';
import OvertimePanel from '@/components/leave/hub/OvertimePanel';
import { formatDays, formatRate, pointsChange } from '@/components/leave/leaveFormat';
import { formatHours } from '@/utils/overtimeCalc';
import { csvCell } from '@/utils/chartAxis';
import { useLeaveHub } from '@/hooks/useLeaveHub';
import type { HubPeriod } from '@/types/leaveHub';

/**
 * The tabs, and what each one means to the API.
 *
 * No `Today`. "Leave filed today" is not a question anybody opens this module
 * with — the window that matters is the month a rota is planned against — and a
 * tab nobody presses is a tab that hides the three that get used.
 */
const PERIOD_TABS: Array<{ label: string; value: HubPeriod }> = [
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
  { label: 'Year', value: 'year' },
];

/**
 * Leave & Overtime module hub.
 *
 * ONE clock runs the page: the tabs and the ‹ › arrows move the cards, the
 * trend, the type ranking and the overtime panel together. A panel left on this
 * month while the cards above moved to August would be the same lie in a quieter
 * place, because nothing on screen would say which window is being read.
 *
 * The one deliberate exception is the entitlement donut, which is a YEAR fact —
 * a week does not have an entitlement — and says so in its own caption.
 */
function LeaveHubContent() {
  const {
    summary,
    period,
    setPeriod,
    goPrevious,
    goNext,
    goToday,
    canGoNext,
    isCurrent,
    loading,
    fetching,
    failed,
  } = useLeaveHub();

  const [exporting, setExporting] = useState(false);

  const stats = summary?.periodStats;
  const previous = summary?.previousStats;
  const periodLabel = summary?.range.label ?? '';
  const previousLabel = summary?.previousRange.label ?? '';

  const activeTab = PERIOD_TABS.find((p) => p.value === period)?.label ?? 'Month';
  const onTabChange = useCallback(
    (label: string) => {
      const match = PERIOD_TABS.find((p) => p.label === label);
      if (match) setPeriod(match.value);
    },
    [setPeriod],
  );

  /** A delta badge, or nothing at all when either side is unknown. */
  const delta = useCallback(
    (
      change: number | undefined,
      goodDirection: 'up' | 'down',
      suffix: string,
    ): KpiStat['delta'] =>
      change === undefined || change === 0
        ? undefined
        : {
            value: change,
            direction: change >= 0 ? 'up' : 'down',
            goodDirection,
            display: `${Math.abs(change).toFixed(1)} ${suffix}`,
            label: `vs ${previousLabel}`,
          },
    [previousLabel],
  );

  const daysChange =
    stats && previous
      ? Math.round((stats.leaveDays - previous.leaveDays) * 10) / 10
      : undefined;
  const overtimeChange =
    stats && previous
      ? Math.round((stats.overtimeHours - previous.overtimeHours) * 10) / 10
      : undefined;

  /**
   * Every rate here is null-safe.
   *
   * `null` is what the server sends when there was nothing to divide by, and it
   * prints as an em dash. Coercing it to 0% would put "Approved 0.0%" on screen
   * for a month in which nothing was filed — a claim that every request was
   * refused.
   */
  const kpis: KpiStat[] = [
    {
      key: 'pending',
      // Not period-scoped in spirit: a queue is what is waiting, and the number
      // an approver acts on today.
      label: 'Awaiting a decision',
      value: failed || !stats ? null : stats.pending,
      icon: Hourglass,
      tone: (stats?.pending ?? 0) > 0 ? 'warning' : 'success',
      footnote: !stats
        ? undefined
        : stats.pending === 0
          ? 'Nothing is waiting on anybody.'
          : stats.pendingOlderThanTwoDays > 0
            ? `${stats.pendingOlderThanTwoDays} have been waiting over two days.`
            : 'All of them were filed in the last two days.',
      href: '/dashboard/leaves/pending',
    },
    {
      key: 'days',
      label: 'Leave taken',
      value: failed || !stats ? null : formatDays(stats.leaveDays),
      icon: CalendarCheck,
      tone: 'default',
      delta: delta(daysChange, 'down', 'days'),
      footnote: stats?.topLeaveType
        ? `Mostly ${stats.topLeaveType}.`
        : 'No leave was approved in this window.',
      href: '/dashboard/leaves',
    },
    {
      key: 'away',
      label: 'Away today',
      value: failed || !stats ? null : stats.onLeaveToday,
      icon: CalendarClock,
      tone: 'info',
      footnote:
        stats?.onLeaveTodayRate == null
          ? 'Nobody is on the books to be away.'
          : `${formatRate(stats.onLeaveTodayRate)} of ${stats.activeHeadcount} active staff.`,
      href: '/dashboard/leaves',
    },
    {
      key: 'balance',
      label: 'Entitlement used',
      value: failed || !stats ? null : formatRate(stats.utilisation),
      icon: Wallet,
      tone: (stats?.utilisation ?? 0) > 85 ? 'warning' : 'default',
      delta: delta(
        pointsChange(stats?.utilisation, previous?.utilisation),
        'up',
        'pts',
      ),
      footnote: stats
        ? `${formatDays(stats.remaining)} still owed — ${formatDays(stats.averageBalance ?? 0)} a head.`
        : undefined,
      href: '/dashboard/leaves/balances',
    },
    {
      key: 'overtime',
      label: 'Overtime approved',
      value:
        failed || !stats || summary?.overtime.enabled === false
          ? null
          : formatHours(stats.overtimeHours),
      icon: Timer,
      // Overtime rising is not good news, whatever it does to output.
      tone: (stats?.overtimeHours ?? 0) > 0 ? 'warning' : 'success',
      delta: delta(overtimeChange, 'down', 'h'),
      footnote:
        summary?.overtime.enabled === false
          ? 'This company does not track overtime.'
          : stats?.avgOvertimePerEmployee == null
            ? 'Nobody worked overtime in this window.'
            : `${formatHours(stats.avgOvertimePerEmployee)} each, across ${stats.overtimeEmployees} ${
                stats.overtimeEmployees === 1 ? 'person' : 'people'
              }.`,
      href: '/dashboard/overtime',
    },
  ];

  /** The window on screen, as a spreadsheet. */
  const handleExport = useCallback(() => {
    if (!summary) return;
    setExporting(true);
    try {
      const header = [
        'bucket',
        'approved',
        'pending',
        'rejected',
        'withdrawn',
        'total',
        'overtime_hours',
      ];
      const overtimeByKey = new Map(
        summary.overtime.trend.map((b) => [b.key, b.hours]),
      );
      const body = summary.trend.map((b) =>
        [
          b.key,
          b.approved,
          b.pending,
          b.rejected,
          b.cancelled,
          b.total,
          overtimeByKey.get(b.key) ?? '',
        ]
          .map(csvCell)
          .join(','),
      );

      const csv = [header.join(','), ...body].join('\n');
      const url = URL.createObjectURL(
        new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `leave-overtime-${summary.period}-${summary.range.start}-to-${summary.range.end}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
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
        // Leave is filed ahead, so the server allows one window forward and
        // refuses the year of guaranteed emptiness past it.
        canGoNext={canGoNext}
        onReset={isCurrent ? undefined : goToday}
        resetLabel="Now"
        busy={fetching}
      />
    ),
    [periodLabel, goPrevious, goNext, canGoNext, isCurrent, goToday, fetching],
  );

  return (
    <ModuleLandingPage
      moduleKey="leaveOvertime"
      title="Leave & overtime"
      subtitle="What is owed, what is waiting on a decision, and who is working late."
      kpis={kpis}
      kpisLoading={loading}
      showControls
      timeFilterOptions={PERIOD_TABS.map((p) => p.label)}
      timeFilter={activeTab}
      onTimeFilterChange={onTabChange}
      periodNav={periodNav}
      onExport={handleExport}
      exportBusy={exporting}
      badges={{ pendingLeave: stats?.pending ?? 0 }}
      badgeTones={{ pendingLeave: 'warning' }}
      insights={
        <div className="space-y-6">
          <LeaveAttentionStrip attention={summary?.attention} loading={loading} />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7 xl:col-span-8">
              <LeaveTrendPanel summary={summary} loading={loading} />
            </div>
            <div className="lg:col-span-5 xl:col-span-4">
              <BalancePanel summary={summary} loading={loading} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <LeaveTypePanel summary={summary} loading={loading} />
            <OvertimePanel summary={summary} loading={loading} />
          </div>
        </div>
      }
    />
  );
}

export default function LeaveOvertimeHubPage() {
  return (
    // A department head sees the hub, scoped by the server to the departments
    // they run. Payroll is not admitted: this page answers by name and by
    // reason, and a sick note is not a payroll fact.
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <LeaveHubContent />
    </ProtectedRoute>
  );
}
