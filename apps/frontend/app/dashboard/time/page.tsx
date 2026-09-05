'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ClipboardCheck, Clock, Timer, UserCheck, UserX } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import type { KpiStat } from '@/components/module-landing/StatCard';
import { PeriodNav } from '@/components/module-landing/primitives';
import AttentionStripSource from '@/components/attendance/hub/AttentionStripSource';
import AttendanceTrendPanel from '@/components/attendance/hub/AttendanceTrendPanel';
import DepartmentAttendancePanel from '@/components/attendance/hub/DepartmentAttendancePanel';
import ArrivalPatternPanel from '@/components/attendance/hub/ArrivalPatternPanel';
import ShiftRosterPanel from '@/components/attendance/hub/ShiftRosterPanel';
import TodayPanel from '@/components/attendance/hub/TodayPanel';
import { formatHours, formatRate, pointsChange } from '@/components/attendance/attendanceFormat';
import { useAttendanceHub } from '@/hooks/useAttendanceHub';
import { useCorrectionStats } from '@/hooks/useAttendanceCorrections';
import type { HubPeriod } from '@/types/attendanceHub';

/**
 * The tabs, and what each one means to the API.
 *
 * `Today` is a PERIOD rather than a mode, so the same ‹ › arrows page back to
 * yesterday, last week, last month or last year — one control to learn instead
 * of a toggle plus a stepper that only works in three of the four states.
 */
const PERIOD_TABS: Array<{ label: string; value: HubPeriod }> = [
  { label: 'Today', value: 'today' },
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
  { label: 'Year', value: 'year' },
];

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Time & Attendance module hub.
 *
 * ONE clock runs the page. The tabs and the ‹ › arrows move the cards, the
 * trend, the department ranking and both insight panels together; a panel left
 * on today while the cards above it moved to August would be the same lie in a
 * quieter place, because nothing on screen would say which window the reader is
 * looking at.
 *
 * What changes with the window is the FORM of the headline, not only the digit.
 * On a single day the card reads "Present today: 6"; over a month it becomes
 * "Attendance: 98.2%", because 433 employee-days present is not a figure anybody
 * can hold in their head.
 *
 * The correction queue is the one exception — it reports what is waiting NOW,
 * since "corrections raised last March" is not something anybody acts on.
 */
function TimeHubContent() {
  const tm = useTranslations('moduleLanding');
  const {
    summary,
    period,
    setPeriod,
    goPrevious,
    goNext,
    goToday,
    canGoPrevious,
    canGoNext,
    isCurrent,
    loading,
    fetching,
    failed,
  } = useAttendanceHub();

  const correctionStats = useCorrectionStats();
  const pending = correctionStats.data?.data.pending ?? 0;
  const avgResolutionHours = correctionStats.data?.data.avgResolutionHours ?? null;

  const [exporting, setExporting] = useState(false);

  const stats = summary?.periodStats;
  const previous = summary?.previousStats;
  const periodLabel = summary?.range.label ?? '';
  const previousLabel = summary?.previousRange.label ?? '';
  const isDay = period === 'today';

  const activeTab = PERIOD_TABS.find((p) => p.value === period)?.label ?? 'Month';
  const onTabChange = useCallback(
    (label: string) => {
      const match = PERIOD_TABS.find((p) => p.label === label);
      if (match) setPeriod(match.value);
    },
    [setPeriod],
  );

  /** A delta badge, or nothing at all when either side of the comparison is unknown. */
  const delta = useCallback(
    (points: number | undefined, goodDirection: 'up' | 'down', suffix = 'pts'): KpiStat['delta'] =>
      points === undefined || points === 0
        ? undefined
        : {
            value: points,
            direction: points >= 0 ? 'up' : 'down',
            goodDirection,
            display: `${Math.abs(points).toFixed(1)} ${suffix}`,
            label: `vs ${previousLabel}`,
          },
    [previousLabel],
  );

  const hoursDelta =
    stats?.avgWorkHours != null && previous?.avgWorkHours != null
      ? Math.round((stats.avgWorkHours - previous.avgWorkHours) * 10) / 10
      : undefined;

  /**
   * Every rate on this row is null-safe.
   *
   * `null` is what the server sends when nobody was expected — a public holiday,
   * a window entirely ahead of today — and it prints as an em dash. Coercing it
   * to 0% would put "Attendance 0.0%" on the screen for a day the office was
   * shut, which is a claim that everybody failed to turn up.
   */
  const kpis: KpiStat[] = [
    {
      key: 'attendance',
      label: isDay ? 'Present today' : 'Attendance',
      value: failed || !stats ? null : isDay ? stats.present : formatRate(stats.attendanceRate),
      icon: UserCheck,
      tone: (stats?.attendanceRate ?? 0) >= 90 ? 'success' : 'default',
      delta: delta(pointsChange(stats?.attendanceRate, previous?.attendanceRate), 'up'),
      footnote: !stats
        ? undefined
        : stats.expected === 0
          ? 'Nobody was expected in this window.'
          : `${stats.present} of ${stats.expected} expected days worked.`,
      href: '/dashboard/attendance',
    },
    {
      key: 'absent',
      label: isDay ? 'Absent today' : 'Absence rate',
      value: failed || !stats ? null : isDay ? stats.absent : formatRate(stats.absentRate),
      icon: UserX,
      tone: (stats?.absent ?? 0) > 0 ? 'danger' : 'success',
      delta: delta(pointsChange(stats?.absentRate, previous?.absentRate), 'down'),
      footnote: !stats
        ? undefined
        : isDay && summary?.range.isCurrent && summary.today && !summary.today.settled
          ? `Provisional — ${summary.today.notCheckedIn} have not arrived yet.`
          : `${stats.absent} absent day${stats.absent === 1 ? '' : 's'} · ${stats.onLeave} on leave.`,
      href: '/dashboard/attendance',
    },
    {
      key: 'late',
      label: isDay ? 'Late today' : 'Lateness rate',
      value: failed || !stats ? null : isDay ? stats.late : formatRate(stats.lateRate),
      icon: Clock,
      tone: (stats?.late ?? 0) > 0 ? 'warning' : 'info',
      delta: delta(pointsChange(stats?.lateRate, previous?.lateRate), 'down'),
      footnote:
        stats?.lateRate == null
          ? 'Nobody has clocked in yet, so there is nothing to be late for.'
          : `${stats.lateOccurrences} late arrival${stats.lateOccurrences === 1 ? '' : 's'} recorded.`,
      href: '/dashboard/attendance/history',
    },
    {
      key: 'corrections',
      // Not period-scoped on purpose: a queue is what is waiting now.
      label: 'Corrections waiting',
      value: correctionStats.isError ? null : pending,
      icon: ClipboardCheck,
      tone: pending > 0 ? 'warning' : 'success',
      footnote: correctionStats.isError
        ? 'The queue could not be read.'
        : pending === 0
          ? 'Nothing is waiting on a decision.'
          : avgResolutionHours != null
            ? `Usually answered in ${avgResolutionHours.toFixed(1)}h.`
            : 'None have been answered yet.',
      href: '/dashboard/attendance/corrections',
    },
    {
      key: 'hours',
      label: 'Average hours worked',
      value: failed || stats?.avgWorkHours == null ? null : formatHours(stats.avgWorkHours),
      icon: Timer,
      tone: 'info',
      delta: delta(hoursDelta, 'up', 'h'),
      footnote: stats ? `Across ${stats.daysCounted} day${stats.daysCounted === 1 ? '' : 's'}.` : undefined,
      href: '/dashboard/attendance/reports',
    },
  ];

  /** The window on screen, as a spreadsheet. */
  const handleExport = useCallback(() => {
    if (!summary) return;
    setExporting(true);
    try {
      // A day exports its arrival curve, because that is what its rows ARE — an
      // "expected" column against 03:00 would be a column of noise.
      const byHour = summary.trendKind === 'hour';
      const header = byHour
        ? ['hour', 'arrivals', 'on_time', 'late']
        : ['date', 'expected', 'present', 'on_time', 'late', 'absent', 'on_leave', 'attendance_rate_pct'];

      const body = summary.trend.map((b) =>
        (byHour
          ? [`${b.key}:00`, b.present, b.onTime, b.late]
          : [b.key, b.expected, b.present, b.onTime, b.late, b.absent, b.onLeave, b.attendanceRate ?? '']
        )
          .map(csvCell)
          .join(','),
      );

      const csv = [header.join(','), ...body].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download =
        summary.range.start === summary.range.end
          ? `attendance-${summary.range.start}.csv`
          : `attendance-${summary.period}-${summary.range.start}-to-${summary.range.end}.csv`;
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
        // Both arrows page by anchors the summary carries, so neither is live
        // until the first one arrives.
        canGoPrev={canGoPrevious}
        // False in the current period. The stepper must not walk into a window
        // that has not happened — the figures behind it would all be zero, and a
        // page of zeros is indistinguishable from a page that failed.
        canGoNext={canGoNext}
        onReset={isCurrent ? undefined : goToday}
        resetLabel="Now"
        busy={fetching}
      />
    ),
    [periodLabel, goPrevious, goNext, canGoPrevious, canGoNext, isCurrent, goToday, fetching],
  );

  return (
    <ModuleLandingPage
      moduleKey="timeAttendance"
      title={tm('timeAttendance.title')}
      subtitle={tm('timeAttendance.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      showControls
      timeFilterOptions={PERIOD_TABS.map((p) => p.label)}
      timeFilter={activeTab}
      onTimeFilterChange={onTabChange}
      periodNav={periodNav}
      onExport={handleExport}
      exportBusy={exporting}
      badges={{ attendanceRequests: pending }}
      badgeTones={{ attendanceRequests: 'warning' }}
      insights={
        <div className="space-y-6">
          <AttentionStripSource
            attention={summary?.attention}
            loading={loading || correctionStats.isLoading}
          />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7 xl:col-span-8">
              <AttendanceTrendPanel summary={summary} loading={loading} />
            </div>
            <div className="lg:col-span-5 xl:col-span-4">
              <DepartmentAttendancePanel
                rows={summary?.departments}
                periodLabel={periodLabel}
                loading={loading}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            <TodayPanel today={summary?.today} yesterday={summary?.yesterday} />
            <ShiftRosterPanel summary={summary} periodLabel={periodLabel} />
            <ArrivalPatternPanel summary={summary} isDay={isDay} />
          </div>
        </div>
      }
    />
  );
}

export default function TimeAttendanceHubPage() {
  return (
    // Wider than the other module hubs on purpose: payroll is run per branch
    // and per department, and a department head owns their team's attendance.
    // Both are management views the API serves; only an EMPLOYEE is refused.
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER']}>
      <TimeHubContent />
    </ProtectedRoute>
  );
}
