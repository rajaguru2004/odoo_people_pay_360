'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { DateTime } from 'luxon';
import { CalendarClock, ClipboardList, Clock, Sun } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatCard } from '@/components/common/StatCard';
import { STATUS_TONE, formatHours, formatTimeOfDay, statusLabel } from '@/components/attendance/attendanceFormat';
import { elapsedLabel, punchState, todayKey } from '@/components/attendance/myDay';
import { nextShift } from './nextShift';
import { useEmployeeAttendance } from '@/hooks/useAttendance';
import { useCorrections } from '@/hooks/useAttendanceCorrections';
import { useLeaveBalance, useMyLeaveRequests } from '@/hooks/useLeaveRequests';
import { useMyOvertimeRequests } from '@/hooks/useOvertime';
import { useEmployeeCalendar } from '@/hooks/useSchedules';
import { useAuthStore } from '@/store/authStore';
import { formatDateOnly } from '@/utils/formatDate';

/** How far ahead to look for the next working day. */
const SHIFT_HORIZON_DAYS = 30;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-1 truncate text-sm tabular-nums text-text-body">{children}</dd>
    </div>
  );
}

/** "Today", "Tomorrow", or the date itself. */
function relativeDay(dayKey: string, from: string): string {
  const days = DateTime.fromISO(dayKey, { zone: 'utc' }).diff(
    DateTime.fromISO(from, { zone: 'utc' }),
    'days',
  ).days;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return formatDateOnly(dayKey, 'ccc d LLL');
}

/**
 * One employee's own day.
 *
 * Four questions, in the order somebody signing in actually asks them: where do
 * I stand today, how much leave is left, is anything of mine still waiting, and
 * when am I next due in.
 *
 * Every card is built to survive its endpoint being absent. Several of these
 * modules are arriving separately, and a self-service home screen that white-
 * screens because leave balances are not deployed yet is worse than one that
 * says it does not know. The rule throughout: an unanswered figure is an em
 * dash, never a zero — "0 days of leave left" and "we could not ask" are
 * different statements, and only one of them is true.
 */
export default function EmployeeDashboard() {
  const user = useAuthStore((s) => s.user);
  const employeeId = user?.employee?.id ?? user?.employeeId ?? undefined;

  const today = todayKey();
  const horizon = DateTime.fromISO(today, { zone: 'utc' })
    .plus({ days: SHIFT_HORIZON_DAYS })
    .toFormat('yyyy-MM-dd');

  const attendanceQ = useEmployeeAttendance(employeeId, {
    startDate: today,
    endDate: today,
  });
  const balanceQ = useLeaveBalance(employeeId);
  const calendarQ = useEmployeeCalendar({ startDate: today, endDate: horizon });

  // Leave and corrections filter server-side; `/overtime/my-requests` takes only
  // paging, so its pending rows are counted here instead.
  const leavesQ = useMyLeaveRequests({ status: 'PENDING' });
  const correctionsQ = useCorrections({ status: 'PENDING' });
  const overtimeQ = useMyOvertimeRequests();

  const record = attendanceQ.data?.data?.records?.[0] ?? null;
  const state = punchState(record);
  const shift = nextShift(calendarQ.data, today, SHIFT_HORIZON_DAYS);
  const dueToday = shift?.date === today;

  // A rest day is only claimed where something actually said so — the row's own
  // status, or a calendar that has closed the day. With no calendar to read,
  // "not checked in" is the safer of the two guesses: it invites a look at the
  // real screen rather than telling somebody to stay at home.
  const restDay = state === 'OFF' || Boolean(calendarQ.data && !record && !dueToday);

  const balance = balanceQ.data?.data;
  const annualLeft = balance
    ? (balance.remainingAnnual ?? balance.annualLeave - balance.usedAnnual)
    : null;

  const openItems = [
    { label: 'Leave requests', href: '/dashboard/my-leaves', query: leavesQ, rows: leavesQ.data?.data },
    { label: 'Overtime requests', href: '/dashboard/my-overtime', query: overtimeQ, rows: overtimeQ.data?.data?.filter((row) => row.status === 'PENDING') },
    {
      label: 'Attendance corrections',
      href: '/dashboard/attendance/corrections',
      query: correctionsQ,
      rows: correctionsQ.data?.data,
    },
  ];

  // Every source has to answer before a total can be asserted. A sum over the
  // two that replied would quietly under-report what is outstanding, which is
  // the one thing this card exists to get right.
  const allAnswered = openItems.every((item) => item.rows !== undefined);
  const waiting = allAnswered
    ? openItems.reduce((total, item) => total + (item.rows?.length ?? 0), 0)
    : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Today"
          subtitle={formatDateOnly(today, 'cccc, d LLLL yyyy')}
          action={
            <Link
              href="/dashboard/my-attendance"
              className="text-sm font-medium text-brand-primary hover:underline"
            >
              My attendance
            </Link>
          }
        />
        <CardBody>
          <div className="flex flex-wrap items-center gap-3">
            {attendanceQ.isError ? (
              <span className="text-sm text-text-muted">
                Your attendance for today could not be read.
              </span>
            ) : restDay ? (
              <>
                <Badge tone="neutral">Rest day</Badge>
                <span className="text-sm text-text-muted">Nothing is expected of you today.</span>
              </>
            ) : (
              <>
                {record && <Badge tone={STATUS_TONE[record.status]}>{statusLabel(record.status)}</Badge>}
                <span className="text-sm text-text-body">
                  {state === 'WORKING'
                    ? `Working — ${elapsedLabel(record?.checkIn)} so far`
                    : state === 'DONE'
                      ? 'Your day is closed.'
                      : 'You have not checked in yet.'}
                </span>
              </>
            )}
          </div>

          <dl className="mt-5 grid gap-5 sm:grid-cols-3">
            <Fact label="Checked in">
              {attendanceQ.isError ? '—' : formatTimeOfDay(record?.checkIn)}
            </Fact>
            <Fact label="Checked out">
              {attendanceQ.isError ? '—' : formatTimeOfDay(record?.checkOut)}
            </Fact>
            <Fact label="Worked">
              {attendanceQ.isError ? '—' : formatHours(record?.workHours)}
            </Fact>
          </dl>
        </CardBody>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Annual leave left"
          value={annualLeft === null ? '—' : annualLeft}
          hint={
            balance
              ? `of ${balance.annualLeave} days for ${balance.year}`
              : 'Balances are not available yet'
          }
          icon={<Sun className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Waiting on a decision"
          value={waiting === null ? '—' : waiting}
          hint={
            waiting === null
              ? 'Some of your requests could not be read'
              : 'Leave, overtime and attendance'
          }
          icon={<ClipboardList className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Next shift"
          value={shift ? relativeDay(shift.date, today) : '—'}
          hint={
            shift
              ? `${shift.startTime ?? '—'} – ${shift.endTime ?? '—'} · ${shift.title}`
              : 'No working day found in the next month'
          }
          icon={<CalendarClock className="h-5 w-5" aria-hidden />}
        />
      </div>

      <Card>
        <CardHeader
          title="Waiting on somebody else"
          subtitle="What you have raised and nobody has decided yet."
        />
        <ul className="divide-y divide-surface-border-light">
          {openItems.map((item) => (
            <li key={item.label} className="flex items-center justify-between gap-4 px-5 py-3.5">
              <Link href={item.href} className="text-sm font-medium text-brand-primary hover:underline">
                {item.label}
              </Link>
              <span className="text-sm tabular-nums text-text-body">
                {/* Undefined means the request did not come back at all. Printing
                    0 there would report an empty queue nobody has looked in. */}
                {item.rows === undefined
                  ? '—'
                  : item.rows.length === 0
                    ? 'Nothing pending'
                    : `${item.rows.length} pending`}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title="Quick access" subtitle="The screens this dashboard summarises." />
        <CardBody className="flex flex-wrap gap-2">
          {[
            { label: 'My attendance', href: '/dashboard/my-attendance', icon: Clock },
            { label: 'My leave', href: '/dashboard/my-leaves', icon: Sun },
            { label: 'My calendar', href: '/dashboard/my-calendar', icon: CalendarClock },
            { label: 'My payslips', href: '/dashboard/payroll', icon: ClipboardList },
          ].map(({ label, href, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="inline-flex items-center gap-2 rounded-[var(--radius-button)] border border-surface-border px-3.5 py-2 text-sm font-medium text-text-body transition-colors hover:border-brand-primary/40 hover:text-brand-primary"
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </Link>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
