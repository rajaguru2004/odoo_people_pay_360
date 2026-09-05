'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  CalendarClock,
  Clock,
  LogIn,
  LogOut,
  ScanFace,
  Timer,
  TriangleAlert,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import {
  useCheckIn,
  useCheckOut,
  useEmployeeAttendance,
} from '@/hooks/useAttendance';
import { useMyFaceEnrollmentStatus } from '@/hooks/useFaceEnrollments';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { MonthStepper } from '@/components/attendance/MonthStepper';
import {
  isAtLatestMonth,
  monthOf,
  stepMonth,
  type MonthCursor,
} from '@/components/attendance/monthGrid';
import {
  STATUS_TONE,
  formatHours,
  formatLateness,
  formatRate,
  formatTimeOfDay,
  statusLabel,
} from '@/components/attendance/attendanceFormat';
import {
  currentPosition,
  elapsedLabel,
  monthRange,
  punchAction,
  punchState,
  todayKey,
} from '@/components/attendance/myDay';
import { formatDateOnly } from '@/utils/formatDate';
import { apiErrorMessage } from '@/utils/apiError';
import type { Attendance } from '@/types/attendance';

/**
 * How long the day counter waits between redraws.
 *
 * A minute, matching what `elapsedLabel` prints. A second-by-second timer on a
 * screen people leave open all morning burns a render a second to change a
 * digit nobody is reading.
 */
const TICK_MS = 60_000;

/** The running total, redrawn once a minute while somebody is checked in. */
function WorkingSince({ checkIn }: { checkIn: string }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span
      className="text-2xl font-semibold tabular-nums text-status-success"
      // The value changes on its own, so a screen reader has to be told when.
      // `polite`, not `assertive`: it must not interrupt what is being read.
      aria-live="polite"
    >
      {elapsedLabel(checkIn)}
    </span>
  );
}

/** Today: where the person stands, and the one button that changes it. */
function TodayCard({
  record,
  zone,
  isLoading,
}: {
  record: Attendance | null;
  zone: string;
  isLoading: boolean;
}) {
  const checkIn = useCheckIn();
  const checkOut = useCheckOut();

  const state = punchState(record);
  const next = punchAction(state);
  const busy = checkIn.isPending || checkOut.isPending;

  const punch = async (action: 'CHECK_IN' | 'CHECK_OUT') => {
    // Asked for at the moment of the punch rather than on page load: a branch
    // with a geofence needs it, one without never does, and prompting everybody
    // on arrival for a permission most of them do not need trains people to
    // refuse it.
    const position = await currentPosition();
    const payload = position ?? {};

    try {
      if (action === 'CHECK_IN') {
        await checkIn.mutateAsync(payload);
        toast.success('Checked in');
      } else {
        await checkOut.mutateAsync(payload);
        toast.success('Checked out');
      }
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The punch was refused'));
    }
  };

  return (
    <Card>
      <CardHeader
        title="Today"
        subtitle={formatDateOnly(todayKey(zone))}
        action={
          record ? (
            <Badge tone={STATUS_TONE[record.status]}>{statusLabel(record.status)}</Badge>
          ) : undefined
        }
      />
      <CardBody className="space-y-4">
        {isLoading && <p className="text-sm text-text-muted">Reading today’s record…</p>}

        {!isLoading && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-text-muted">
                  Checked in
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-text-heading">
                  {formatTimeOfDay(record?.checkIn, zone)}
                </p>
                {record?.isLate && (
                  <p className="mt-0.5 text-xs text-status-warning">
                    {formatLateness(record.lateMinutes)}
                  </p>
                )}
              </div>

              <div>
                <p className="text-xs uppercase tracking-wider text-text-muted">
                  Checked out
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-text-heading">
                  {formatTimeOfDay(record?.checkOut, zone)}
                </p>
                {record?.isEarlyLeave && (
                  <p className="mt-0.5 text-xs text-status-warning">Left early</p>
                )}
              </div>

              <div>
                <p className="text-xs uppercase tracking-wider text-text-muted">
                  {state === 'WORKING' ? 'On the clock' : 'Hours today'}
                </p>
                <p className="mt-1">
                  {state === 'WORKING' && record?.checkIn ? (
                    <WorkingSince checkIn={record.checkIn} />
                  ) : (
                    <span className="text-2xl font-semibold tabular-nums text-text-heading">
                      {formatHours(record?.workHours)}
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-surface-border-light pt-4">
              {next ? (
                <Button
                  size="lg"
                  variant={next.action === 'CHECK_IN' ? 'primary' : 'secondary'}
                  isLoading={busy}
                  onClick={() => void punch(next.action)}
                >
                  {next.action === 'CHECK_IN' ? (
                    <LogIn className="h-4 w-4" aria-hidden />
                  ) : (
                    <LogOut className="h-4 w-4" aria-hidden />
                  )}
                  {next.label}
                </Button>
              ) : (
                <p className="text-sm text-text-muted">
                  {state === 'OFF'
                    ? 'Nothing is expected today.'
                    : 'Your day is closed. Ask for a correction if a time is wrong.'}
                </p>
              )}

              <Link
                href="/dashboard/attendance/corrections"
                className="text-sm font-medium text-brand-primary hover:underline"
              >
                Request a correction
              </Link>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** Whether a biometric punch is available to this person, and what to do about it. */
function BiometricStrip() {
  const { data } = useMyFaceEnrollmentStatus();
  const status = data?.data;
  if (!status) return null;

  return (
    <Card
      className={
        status.isRegistered
          ? 'border-status-success/30 bg-status-success-bg/40'
          : 'border-status-warning/30 bg-status-warning-bg/40'
      }
    >
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] ${
              status.isRegistered
                ? 'bg-status-success/15 text-status-success'
                : 'bg-status-warning/15 text-status-warning'
            }`}
          >
            {status.isRegistered ? (
              <ScanFace className="h-5 w-5" aria-hidden />
            ) : (
              <TriangleAlert className="h-5 w-5" aria-hidden />
            )}
          </span>
          <div>
            <p className="text-sm font-semibold text-text-heading">
              {status.isRegistered
                ? `Biometric verification is set up (${status.totalRegistered} template${
                    status.totalRegistered === 1 ? '' : 's'
                  })`
                : 'No face template on file'}
            </p>
            <p className="mt-0.5 text-sm text-text-muted">
              {status.isRegistered
                ? 'You can verify at a terminal instead of punching by hand.'
                : 'Ask HR to enrol you before using a biometric terminal.'}
            </p>
          </div>
        </div>

        <Link href="/dashboard/face-recognition">
          <Button variant="outline" size="sm">
            Biometric verification
          </Button>
        </Link>
      </CardBody>
    </Card>
  );
}

function MyAttendance() {
  const user = useAuthStore((s) => s.user);
  const employeeId = user?.employeeId ?? user?.employee?.id ?? undefined;
  const zone = user?.employee?.timezone ?? 'Asia/Muscat';

  const [cursor, setCursor] = useState<MonthCursor>(() => monthOf(new Date(), zone));
  const range = useMemo(() => monthRange(cursor), [cursor]);
  const today = todayKey(zone);

  // Today and the month are two separate reads on purpose. The today card has
  // to stay correct after a punch — which invalidates the whole attendance
  // subtree — while the month below it may be sitting on a period from last
  // year that has no reason to refetch.
  const todayQuery = useEmployeeAttendance(employeeId, {
    startDate: today,
    endDate: today,
  });
  const monthQuery = useEmployeeAttendance(employeeId, range);

  const todayRecord = todayQuery.data?.data?.records?.[0] ?? null;
  const history = monthQuery.data?.data;
  const records = history?.records ?? [];
  const summary = history?.summary;

  usePageHeader(
    'My attendance',
    summary
      ? `${summary.present} day${summary.present === 1 ? '' : 's'} worked this month`
      : 'Your own punches and hours',
  );

  if (!employeeId) {
    return (
      <Card>
        <EmptyState
          icon={<Clock className="h-6 w-6" aria-hidden />}
          title="This account is not attached to an employee record"
          description="Attendance belongs to a person on the books. An operator account has none, so there is nothing to punch."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <TodayCard record={todayRecord} zone={zone} isLoading={todayQuery.isLoading} />

      <BiometricStrip />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Days worked"
          value={summary?.present ?? 0}
          hint="Present, late or half day"
          icon={<CalendarClock className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Hours recorded"
          value={formatHours(summary?.workHours)}
          hint={
            summary?.avgWorkHours
              ? `${formatHours(summary.avgWorkHours)} a day on average`
              : 'Nothing recorded yet'
          }
          icon={<Timer className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Late arrivals"
          value={summary?.late ?? 0}
          hint={
            summary?.lateMinutes
              ? `${summary.lateMinutes} minutes past the grace window`
              : 'On time so far'
          }
          icon={<Clock className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Attendance"
          value={formatRate(summary?.attendanceRate)}
          hint={`${summary?.absent ?? 0} absent · ${summary?.onLeave ?? 0} on leave`}
        />
      </div>

      <Card>
        <CardHeader
          title="This month"
          subtitle="Only the days with a record. A day nobody expected you never produces one."
          action={
            <MonthStepper
              cursor={cursor}
              onChange={(delta) => setCursor((c) => stepMonth(c, delta))}
              canGoNext={!isAtLatestMonth(cursor, new Date(), zone)}
              busy={monthQuery.isFetching}
            />
          }
        />

        {monthQuery.isLoading && (
          <p className="p-6 text-sm text-text-muted">Loading your month…</p>
        )}

        {monthQuery.isError && (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(monthQuery.error, 'Could not load your attendance.')}
          </p>
        )}

        {!monthQuery.isLoading && !monthQuery.isError && records.length === 0 && (
          <EmptyState
            icon={<CalendarClock className="h-6 w-6" aria-hidden />}
            title="Nothing recorded this month"
            description="Punches appear here as soon as you check in, whether from this screen or a terminal."
          />
        )}

        {records.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Date</th>
                  <th className="px-5 py-3 text-start font-medium">In</th>
                  <th className="px-5 py-3 text-start font-medium">Out</th>
                  <th className="px-5 py-3 text-end font-medium">Hours</th>
                  <th className="px-5 py-3 text-start font-medium">Status</th>
                  <th className="px-5 py-3 text-start font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {records.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-border-light/60">
                    <td className="px-5 py-3 font-medium text-text-heading">
                      {formatDateOnly(row.date)}
                    </td>
                    <td className="px-5 py-3 tabular-nums text-text-body">
                      {formatTimeOfDay(row.checkIn, zone)}
                    </td>
                    <td className="px-5 py-3 tabular-nums text-text-body">
                      {formatTimeOfDay(row.checkOut, zone)}
                    </td>
                    <td className="px-5 py-3 text-end tabular-nums text-text-body">
                      {formatHours(row.workHours)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={STATUS_TONE[row.status]}>
                          {statusLabel(row.status)}
                        </Badge>
                        {row.isLate && (
                          <span className="text-xs text-status-warning">
                            {formatLateness(row.lateMinutes)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-text-muted">{row.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function MyAttendancePage() {
  return (
    // No permission or role gate: reading your own attendance is a question
    // every signed-in person is entitled to ask, and the server narrows the
    // answer to whoever is asking.
    <ProtectedRoute>
      <MyAttendance />
    </ProtectedRoute>
  );
}
