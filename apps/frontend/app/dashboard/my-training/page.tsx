'use client';

import { AlertTriangle, BadgeCheck, CalendarDays, GraduationCap } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useMyTraining } from '@/hooks/useTraining';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import type { NominationStatus } from '@/types/training';

const STATUS_TONE: Record<
  NominationStatus,
  'neutral' | 'success' | 'warning' | 'error' | 'info'
> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
  ATTENDED: 'info',
  NO_SHOW: 'warning',
};

/** Inside this many days, a certificate is worth surfacing before HR chases. */
const EXPIRY_HORIZON_DAYS = 90;

/** Days from today to a DATE-ONLY value, read without a zone conversion. */
function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const target = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(target)) return null;
  const today = new Date();
  const startOfToday = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return Math.ceil((target - startOfToday) / 86_400_000);
}

function MyTrainingScreen() {
  const { data, isLoading, isError, error } = useMyTraining();
  const rows = data?.data ?? [];

  const upcoming = rows.filter((row) =>
    ['PENDING', 'APPROVED'].includes(row.status),
  );
  const completed = rows.filter((row) =>
    ['ATTENDED', 'NO_SHOW'].includes(row.status),
  );
  const expiringSoon = completed.filter((row) => {
    const days = daysUntil(row.certificateExpiry);
    return days !== null && days >= 0 && days <= EXPIRY_HORIZON_DAYS;
  });

  usePageHeader('My training', 'Courses you are booked on, and your certificates');

  return (
    <div className="space-y-5" data-testid="ess-my-training">
      {isError && (
        <Card className="p-6">
          <p className="text-sm text-status-error">
            {apiErrorMessage(error, 'Could not load your training record.')}
          </p>
        </Card>
      )}

      {expiringSoon.length > 0 && (
        <Card className="border-status-warning/30 bg-status-warning-bg/40 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-status-warning"
              aria-hidden
            />
            <div className="text-sm text-status-warning">
              <p className="font-semibold">
                {expiringSoon.length} certificate
                {expiringSoon.length === 1 ? '' : 's'} expiring within{' '}
                {EXPIRY_HORIZON_DAYS} days
              </p>
              <ul className="mt-1 space-y-0.5">
                {expiringSoon.map((row) => (
                  <li key={row.id}>
                    {row.session?.course?.title} — expires{' '}
                    {formatDateOnly(row.certificateExpiry)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-body">
          <CalendarDays className="h-4 w-4" aria-hidden />
          Upcoming ({upcoming.length})
        </h2>

        {isLoading && (
          <Card className="p-6">
            <p className="text-sm text-text-muted">Loading your training…</p>
          </Card>
        )}

        {!isLoading && upcoming.length === 0 && (
          <Card>
            <EmptyState
              icon={<GraduationCap className="h-6 w-6" aria-hidden />}
              title="Nothing booked"
              description="Courses you are nominated for appear here, with the decision on each one."
            />
          </Card>
        )}

        {upcoming.map((row) => (
          <Card key={row.id} className="p-4" data-testid={`my-training-row-${row.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <GraduationCap className="h-4 w-4 text-brand-primary" aria-hidden />
              <p className="text-sm font-semibold text-text-heading">
                {row.session?.course?.title}
              </p>
              <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {formatDateOnly(row.session?.startDate)} →{' '}
              {formatDateOnly(row.session?.endDate)}
              {row.session?.location ? ` · ${row.session.location}` : ''}
            </p>
            {row.justification && (
              <p className="mt-1 text-xs italic text-text-muted">
                “{row.justification}”
              </p>
            )}
            {row.rejectedReason && (
              <p className="mt-1 text-xs italic text-status-error">
                Rejected: {row.rejectedReason}
              </p>
            )}
          </Card>
        ))}
      </section>

      {completed.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-body">
            <BadgeCheck className="h-4 w-4" aria-hidden />
            Completed ({completed.length})
          </h2>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th scope="col" className="px-5 py-3 text-start font-medium">Course</th>
                    <th scope="col" className="px-5 py-3 text-start font-medium">Attended</th>
                    <th scope="col" className="px-5 py-3 text-start font-medium">Score</th>
                    <th scope="col" className="px-5 py-3 text-start font-medium">Result</th>
                    <th scope="col" className="px-5 py-3 text-start font-medium">Certificate expires</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border-light">
                  {completed.map((row) => {
                    const days = daysUntil(row.certificateExpiry);
                    const soon = days !== null && days <= EXPIRY_HORIZON_DAYS;
                    return (
                      <tr key={row.id}>
                        <td className="px-5 py-3 text-text-heading">
                          {row.session?.course?.title}
                        </td>
                        <td className="px-5 py-3 text-text-muted">
                          {formatDateOnly(row.attendedAt)}
                        </td>
                        <td className="px-5 py-3 tabular-nums text-text-muted">
                          {row.score ?? '—'}
                        </td>
                        <td className="px-5 py-3">
                          <Badge tone={STATUS_TONE[row.status]}>
                            {row.status === 'ATTENDED'
                              ? row.passed === false
                                ? 'Not passed'
                                : 'Passed'
                              : 'No-show'}
                          </Badge>
                        </td>
                        <td
                          className={`px-5 py-3 ${
                            soon
                              ? 'font-medium text-status-warning'
                              : 'text-text-muted'
                          }`}
                        >
                          {row.certificateExpiry
                            ? `${formatDateOnly(row.certificateExpiry)}${
                                days !== null && days >= 0 ? ` (${days}d)` : ''
                              }`
                            : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}

export default function MyTrainingPage() {
  return (
    <ProtectedRoute>
      <MyTrainingScreen />
    </ProtectedRoute>
  );
}
