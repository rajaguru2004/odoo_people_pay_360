'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { MapPin } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import {
  STATUS_TONE,
  formatHours,
  formatLateness,
  formatTimeOfDay,
  statusLabel,
} from '@/components/attendance/attendanceFormat';
import { useAttendance } from '@/hooks/useAttendance';
import { useCorrections } from '@/hooks/useAttendanceCorrections';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import { formatDateOnly, formatDateTime } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { AttendanceCorrection, AttendanceSource } from '@/types/attendance';
import type { RequestStatus } from '@/types/common';

/** Where a punch came from, in words rather than in the enum's shouting. */
const SOURCE_LABEL: Record<AttendanceSource, string> = {
  ESS: 'Self-service',
  MANUAL: 'Entered by hand',
  BIOMETRIC: 'Biometric terminal',
  IMPORT: 'Imported',
  SYSTEM: 'Derived by the system',
};

const REQUEST_TONE: Record<RequestStatus, 'neutral' | 'success' | 'warning' | 'error'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
};

function humanise(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-body">{children || '—'}</dd>
    </div>
  );
}

/**
 * A punch's coordinates, or nothing.
 *
 * Prisma sends a Decimal as a string and only a geofenced branch records one at
 * all, so both halves have to be present and numeric before this is worth
 * printing. Five decimal places is about a metre — more digits would suggest a
 * precision a phone's GPS does not have.
 */
function coordinates(lat?: string | null, lng?: string | null): string | null {
  if (!lat || !lng) return null;
  const north = Number(lat);
  const east = Number(lng);
  if (Number.isNaN(north) || Number.isNaN(east)) return null;
  return `${north.toFixed(5)}, ${east.toFixed(5)}`;
}

/** What the clock said beside what was asked for, on one correction. */
function CorrectionEntry({ correction }: { correction: AttendanceCorrection }) {
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={REQUEST_TONE[correction.status]}>{humanise(correction.status)}</Badge>
        <span className="text-sm text-text-muted">
          raised {formatDateTime(correction.createdAt)}
        </span>
      </div>

      <dl className="mt-3 grid gap-4 sm:grid-cols-2">
        {/* Both halves of the snapshot. The record exists so a reader can see
            what was changed without going back to the timesheet. */}
        <Fact label="Recorded">
          <span className="tabular-nums">
            {formatTimeOfDay(correction.originalCheckIn)} –{' '}
            {formatTimeOfDay(correction.originalCheckOut)}
          </span>
        </Fact>
        <Fact label="Requested">
          <span className="tabular-nums">
            {formatTimeOfDay(correction.requestedCheckIn)} –{' '}
            {formatTimeOfDay(correction.requestedCheckOut)}
          </span>
        </Fact>
      </dl>

      <p className="mt-3 whitespace-pre-wrap text-sm text-text-body">{correction.reason}</p>

      {correction.reviewedAt && (
        <p className="mt-1.5 text-sm text-text-muted">
          {correction.reviewedBy?.employee
            ? fullName(correction.reviewedBy.employee)
            : (correction.reviewedBy?.email ?? 'A reviewer')}{' '}
          · {formatDateTime(correction.reviewedAt)}
          {correction.reviewNote ? ` · ${correction.reviewNote}` : ''}
        </p>
      )}
    </li>
  );
}

/**
 * Every correction raised against this person's day.
 *
 * A separate component so it can only mount once the record has told us WHOSE
 * day this is — asking with an empty filter would fetch the whole company queue
 * and paint somebody else's disputes under this record for a frame.
 *
 * An EMPLOYEE caller is narrowed to their own rows by the server whatever the
 * filter says, so this is the same request for every role.
 */
function DayCorrections({ employeeId, day }: { employeeId: string; day: string }) {
  const { data, isLoading, isError } = useCorrections({
    employeeId,
    startDate: day,
    endDate: day,
  });

  const rows = data?.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Corrections"
        subtitle="What has been disputed about this day, and what was decided."
      />

      {isLoading && <CardBody className="text-sm text-text-muted">Loading the history…</CardBody>}

      {isError && (
        <CardBody className="text-sm text-text-muted">
          The correction history could not be read.
        </CardBody>
      )}

      {!isLoading && !isError && rows.length === 0 && (
        <CardBody className="text-sm text-text-muted">
          Nothing has been raised against this day.
        </CardBody>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-surface-border-light">
          {rows.map((correction) => (
            <CorrectionEntry key={correction.id} correction={correction} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AttendanceRecord({ id }: { id: string }) {
  const role = useAuthStore((s) => s.user?.role);
  const { data, isLoading, isError, error } = useAttendance(id);
  const attendance = data?.data;

  const person = attendance?.employee;
  const name = person ? fullName(person) : '';

  usePageHeader(
    name || 'Attendance record',
    attendance ? formatDateOnly(attendance.date, 'EEEE, d LLLL yyyy') : undefined,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading the record…</Card>;
  }

  if (isError || !attendance) {
    // 403 is the ordinary answer here rather than a fault: the endpoint is
    // self-or-privileged, so an employee following a link to a colleague's day
    // gets one. Saying so is more use than "something went wrong".
    const refused = (error as { statusCode?: number } | null)?.statusCode === 403;
    return (
      <Card className="p-6 text-sm text-status-error">
        {refused
          ? 'This attendance record belongs to somebody else.'
          : 'Could not load this attendance record.'}
      </Card>
    );
  }

  // The day the work is ATTRIBUTED to — a DATE column, so the key is the first
  // ten characters and never an instant parse, which would move a night shift
  // to the previous day west of Greenwich.
  const day = attendance.date.slice(0, 10);
  const checkInAt = coordinates(attendance.checkInLatitude, attendance.checkInLongitude);
  const checkOutAt = coordinates(attendance.checkOutLatitude, attendance.checkOutLongitude);
  const lateness = formatLateness(attendance.lateMinutes);
  const canOpenPerson = hasPermission(role, 'VIEW_EMPLOYEES');

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={STATUS_TONE[attendance.status]}>{statusLabel(attendance.status)}</Badge>
          <span className="text-sm text-text-body">{formatDateOnly(attendance.date)}</span>
          <span className="text-sm text-text-muted">
            {SOURCE_LABEL[attendance.source] ?? humanise(attendance.source)}
          </span>
          {lateness && <span className="text-sm font-semibold text-status-warning">{lateness}</span>}
          {attendance.isEarlyLeave && (
            <span className="text-sm font-semibold text-status-warning">Left early</span>
          )}
        </div>

        <div className="text-sm text-text-muted">
          {person?.employeeCode ? `${person.employeeCode} · ` : ''}
          {person?.department?.name ?? 'No department'}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="The day"
          subtitle="The punches as the office clock recorded them, and what they add up to."
        />
        <CardBody>
          <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Employee">
              {canOpenPerson && person ? (
                <Link
                  href={`/dashboard/employees/${attendance.employeeId}`}
                  className="text-brand-primary hover:underline"
                >
                  {name}
                </Link>
              ) : (
                name
              )}
            </Fact>
            <Fact label="Branch">
              {attendance.employee?.branch?.name ?? attendance.branchId ?? ''}
            </Fact>
            <Fact label="Date">{formatDateOnly(attendance.date, 'EEEE, d LLLL yyyy')}</Fact>

            {/* Times in the company's zone, not the reader's: an 08:00 arrival
                in Muscat read in London is simply the wrong number, and it is
                wrong without saying so. */}
            <Fact label="Checked in">
              <span className="tabular-nums">{formatTimeOfDay(attendance.checkIn)}</span>
            </Fact>
            <Fact label="Checked out">
              <span className="tabular-nums">{formatTimeOfDay(attendance.checkOut)}</span>
            </Fact>
            <Fact label="Worked">
              {/* An em dash rather than 0.0h while a shift is still open: zero
                  says the person clocked in and did nothing. */}
              <span className="tabular-nums">{formatHours(attendance.workHours)}</span>
            </Fact>

            <Fact label="Expected">
              <span className="tabular-nums">{formatHours(attendance.expectedHours)}</span>
            </Fact>
            <Fact label="Late by">
              <span className="tabular-nums">
                {attendance.lateMinutes > 0 ? `${attendance.lateMinutes} min` : 'On time'}
              </span>
            </Fact>
            <Fact label="Last changed">{formatDateTime(attendance.updatedAt)}</Fact>

            {attendance.notes && (
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  Notes
                </dt>
                <dd className="mt-1 whitespace-pre-line text-sm text-text-body">
                  {attendance.notes}
                </dd>
              </div>
            )}
          </dl>
        </CardBody>
      </Card>

      {(checkInAt || checkOutAt) && (
        <Card>
          <CardHeader
            title="Where the punches were taken"
            subtitle="Recorded only where the branch has a geofence."
          />
          <CardBody>
            <dl className="grid gap-5 sm:grid-cols-2">
              <Fact label="Check-in position">
                {checkInAt && (
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <MapPin className="h-4 w-4 text-text-muted" aria-hidden />
                    {checkInAt}
                  </span>
                )}
              </Fact>
              <Fact label="Check-out position">
                {checkOutAt && (
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <MapPin className="h-4 w-4 text-text-muted" aria-hidden />
                    {checkOutAt}
                  </span>
                )}
              </Fact>
            </dl>
          </CardBody>
        </Card>
      )}

      <DayCorrections employeeId={attendance.employeeId} day={day} />
    </div>
  );
}

export default function AttendanceRecordPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    // No role list on purpose. `GET /attendances/:id` is self-or-privileged and
    // the URL carries an ATTENDANCE id, so whose day this is cannot be known
    // before the record loads. A role list here would either shut an employee
    // out of their own day or admit every role to everyone's; the check that
    // can actually decide runs on the server, and the page reports its answer.
    <ProtectedRoute>
      <AttendanceRecord id={id} />
    </ProtectedRoute>
  );
}
