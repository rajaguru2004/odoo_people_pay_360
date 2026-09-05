'use client';

import { Fragment, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { DateTime } from 'luxon';
import { ChevronDown, ClipboardCheck, Plus, X } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useCorrectionStats,
  useCorrections,
  useCreateCorrection,
  useReviewCorrection,
} from '@/hooks/useAttendanceCorrections';
import { useAuthStore } from '@/store/authStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { formatTimeOfDay } from '@/components/attendance/attendanceFormat';
import { formatDateOnly, formatDateTime } from '@/utils/formatDate';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import type { AttendanceCorrection, CorrectionListQuery } from '@/types/attendance';
import type { RequestStatus } from '@/types/common';

const PAGE_SIZE = 20;

const STATUS_TONE: Record<RequestStatus, 'success' | 'warning' | 'error' | 'neutral'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
};

const TABS: Array<{ key: 'ALL' | RequestStatus; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

/**
 * A wall-clock time on a given day, as the instant the API stores.
 *
 * The zone is the company's rather than the browser's: somebody reviewing an
 * Omani timesheet from London is asking about 08:00 in the office, and reading
 * the field in their own zone would file the punch four hours out.
 */
function instantFrom(day: string, time: string | undefined, zone = 'Asia/Muscat') {
  if (!time) return undefined;
  const dt = DateTime.fromISO(`${day}T${time}`, { zone });
  return dt.isValid ? dt.toISO() ?? undefined : undefined;
}

const requestSchema = z
  .object({
    date: z.string().min(1, 'Pick the day being corrected'),
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
    reason: z.string().min(5, 'Say what happened, in a sentence'),
  })
  .refine((value) => Boolean(value.checkIn || value.checkOut), {
    message: 'Give at least one of the two times',
    path: ['checkIn'],
  });

type RequestForm = z.infer<typeof requestSchema>;

const rejectSchema = z.object({
  // Required on a rejection and only there: the person who raised this is owed
  // a reason, and "Rejected" on its own is the start of an argument.
  reviewNote: z.string().min(3, 'Say why it is being rejected'),
});

type RejectForm = z.infer<typeof rejectSchema>;

/** What the clock said, beside what is being asked for. */
function TimePair({
  title,
  checkIn,
  checkOut,
  muted = false,
}: {
  title: string;
  checkIn?: string | null;
  checkOut?: string | null;
  muted?: boolean;
}) {
  const nothing = !checkIn && !checkOut;

  return (
    <div className="rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{title}</p>
      {nothing ? (
        <p className="mt-1 text-sm text-text-muted">
          {muted ? 'No row on that day at all' : 'Not given'}
        </p>
      ) : (
        <dl className="mt-1 space-y-0.5 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-text-muted">In</dt>
            <dd className="font-medium tabular-nums text-text-heading">
              {formatTimeOfDay(checkIn)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-text-muted">Out</dt>
            <dd className="font-medium tabular-nums text-text-heading">
              {formatTimeOfDay(checkOut)}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function CorrectionDetail({ correction }: { correction: AttendanceCorrection }) {
  return (
    <div className="grid gap-4 bg-surface-page/60 px-5 py-4 md:grid-cols-3">
      {/* Both halves of the snapshot, side by side. The record exists so a
          reviewer can see what changed without opening the timesheet. */}
      <TimePair
        title="Recorded"
        checkIn={correction.originalCheckIn}
        checkOut={correction.originalCheckOut}
        muted={!correction.attendanceId}
      />
      <TimePair
        title="Requested"
        checkIn={correction.requestedCheckIn}
        checkOut={correction.requestedCheckOut}
      />
      <div className="space-y-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Reason
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-text-body">{correction.reason}</p>
        </div>
        {correction.reviewedAt && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Review
            </p>
            <p className="mt-1 text-sm text-text-body">
              {correction.reviewedBy?.employee
                ? fullName(correction.reviewedBy.employee)
                : (correction.reviewedBy?.email ?? 'A reviewer')}{' '}
              · {formatDateTime(correction.reviewedAt)}
            </p>
            {correction.reviewNote && (
              <p className="mt-1 text-sm text-text-muted">{correction.reviewNote}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AttendanceRequests() {
  const role = useAuthStore((s) => s.user?.role);
  const canReview = role === 'ADMIN' || role === 'HR_MANAGER';

  const [tab, setTab] = useState<'ALL' | RequestStatus>('PENDING');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const [rejecting, setRejecting] = useState<AttendanceCorrection | null>(null);

  const query = useMemo<CorrectionListQuery>(
    () => ({ page, limit: PAGE_SIZE, status: tab === 'ALL' ? undefined : tab }),
    [page, tab],
  );

  const { data, isLoading, isError } = useCorrections(query);
  const stats = useCorrectionStats();
  const createCorrection = useCreateCorrection();
  const review = useReviewCorrection();

  const rows = data?.data ?? [];
  const counts = stats.data?.data;

  usePageHeader(
    'Attendance requests',
    counts ? `${counts.pending} waiting on a decision` : undefined,
  );

  const requestForm = useForm<RequestForm>({
    resolver: zodResolver(requestSchema),
    defaultValues: { date: '', checkIn: '', checkOut: '', reason: '' },
  });

  const rejectForm = useForm<RejectForm>({
    resolver: zodResolver(rejectSchema),
    defaultValues: { reviewNote: '' },
  });

  const submitRequest = requestForm.handleSubmit(async (values) => {
    try {
      await createCorrection.mutateAsync({
        date: values.date,
        requestedCheckIn: instantFrom(values.date, values.checkIn),
        requestedCheckOut: instantFrom(values.date, values.checkOut),
        reason: values.reason,
      });
      toast.success('Correction raised');
      setRaising(false);
      requestForm.reset();
    } catch (error) {
      // The axios interceptor rejects with a FLAT object — there is no
      // `.response` to read through.
      toast.error(apiErrorMessage(error));
    }
  });

  const approve = async (correction: AttendanceCorrection) => {
    try {
      await review.mutateAsync({ id: correction.id, payload: { action: 'APPROVE' } });
      toast.success('Approved — the timesheet has been rewritten');
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  };

  const submitRejection = rejectForm.handleSubmit(async (values) => {
    if (!rejecting) return;
    try {
      await review.mutateAsync({
        id: rejecting.id,
        payload: { action: 'REJECT', reviewNote: values.reviewNote },
      });
      toast.success('Rejected');
      setRejecting(null);
      rejectForm.reset();
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  });

  const countFor = (key: 'ALL' | RequestStatus) => {
    if (!counts) return undefined;
    if (key === 'ALL') return counts.total;
    return counts[key.toLowerCase() as 'pending' | 'approved' | 'rejected' | 'cancelled'];
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((entry) => {
            const count = countFor(entry.key);
            const active = tab === entry.key;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => {
                  setTab(entry.key);
                  // A narrower tab has fewer pages: staying on page 4 would
                  // land on an empty table that reads as "nothing here".
                  setPage(1);
                }}
                aria-pressed={active}
                className={`inline-flex items-center gap-2 rounded-[var(--radius-button)] border px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? 'border-brand-primary bg-brand-primary text-text-on-brand'
                    : 'border-surface-border bg-surface-card text-text-body hover:bg-surface-border-light'
                }`}
              >
                {entry.label}
                {count !== undefined && (
                  <span className="tabular-nums text-xs opacity-80">{count}</span>
                )}
              </button>
            );
          })}
        </div>

        <Button onClick={() => setRaising(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          Request a correction
        </Button>
      </div>

      <Card>
        {isLoading && <p className="p-6 text-sm text-text-muted">Loading the queue…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            Could not load the queue. Is the API running?
          </p>
        )}

        {!isLoading && !isError && rows.length === 0 && (
          <EmptyState
            icon={<ClipboardCheck className="h-6 w-6" aria-hidden />}
            title="Nothing here"
            description={
              tab === 'PENDING'
                ? 'No corrections are waiting on a decision.'
                : 'No requests with that standing.'
            }
          />
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Raised by</th>
                  <th className="px-5 py-3 text-start font-medium">Day</th>
                  <th className="px-5 py-3 text-start font-medium">Why</th>
                  <th className="px-5 py-3 text-start font-medium">Standing</th>
                  <th className="px-5 py-3 text-end font-medium">Decision</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {rows.map((correction) => {
                  const open = expandedId === correction.id;
                  return (
                    // A Fragment with the key, not a shorthand `<>`: the row and
                    // its detail are two siblings in one list entry, and only a
                    // keyed element can carry that.
                    <Fragment key={correction.id}>
                      <tr
                        data-testid="correction-row"
                        onClick={() => setExpandedId(open ? null : correction.id)}
                        className="cursor-pointer hover:bg-surface-border-light/60"
                      >
                        <td className="px-5 py-3">
                          <p className="font-medium text-text-heading">
                            {fullName(correction.employee)}
                          </p>
                          <p className="text-xs text-text-muted">
                            {correction.employee?.department?.name ?? '—'}
                          </p>
                        </td>
                        <td className="px-5 py-3 tabular-nums text-text-body">
                          {formatDateOnly(correction.date)}
                        </td>
                        <td className="max-w-xs px-5 py-3">
                          <p className="truncate text-text-body">{correction.reason}</p>
                        </td>
                        <td className="px-5 py-3">
                          <Badge tone={STATUS_TONE[correction.status]}>
                            {correction.status.charAt(0) +
                              correction.status.slice(1).toLowerCase()}
                          </Badge>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-2">
                            {canReview && correction.status === 'PENDING' && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  isLoading={review.isPending}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void approve(correction);
                                  }}
                                >
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    rejectForm.reset();
                                    setRejecting(correction);
                                  }}
                                >
                                  Reject
                                </Button>
                              </>
                            )}
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-label={`Details of the request for ${formatDateOnly(correction.date)}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setExpandedId(open ? null : correction.id);
                              }}
                              className="rounded-[var(--radius-button)] p-1.5 text-text-muted hover:bg-surface-border-light"
                            >
                              <ChevronDown
                                className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
                                aria-hidden
                              />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={5} className="p-0">
                            <CorrectionDetail correction={correction} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination meta={data?.meta} onPageChange={setPage} />
      </Card>

      {raising && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-text-heading">
                  Raise a correction
                </h2>
                <p className="mt-0.5 text-sm text-text-muted">
                  For your own timesheet. HR decides whether it is applied.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRaising(false)}
                aria-label="Close"
                className="rounded-[var(--radius-button)] p-1 text-text-muted hover:bg-surface-border-light"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <form onSubmit={submitRequest} className="space-y-3">
              <Input
                label="Day"
                type="date"
                error={requestForm.formState.errors.date?.message}
                {...requestForm.register('date')}
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Checked in at"
                  type="time"
                  error={requestForm.formState.errors.checkIn?.message}
                  {...requestForm.register('checkIn')}
                />
                <Input
                  label="Checked out at"
                  type="time"
                  {...requestForm.register('checkOut')}
                />
              </div>
              <Textarea
                label="What happened"
                placeholder="The reader did not register my badge at the gate"
                error={requestForm.formState.errors.reason?.message}
                {...requestForm.register('reason')}
              />
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={() => setRaising(false)}>
                  Cancel
                </Button>
                <Button type="submit" isLoading={createCorrection.isPending}>
                  Send it
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-text-heading">Reject this request</h2>
                <p className="mt-0.5 text-sm text-text-muted">
                  {fullName(rejecting.employee)} · {formatDateOnly(rejecting.date)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRejecting(null)}
                aria-label="Close"
                className="rounded-[var(--radius-button)] p-1 text-text-muted hover:bg-surface-border-light"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <form onSubmit={submitRejection} className="space-y-3">
              <Textarea
                label="Why"
                placeholder="The gate log shows the badge was read at 08:40"
                error={rejectForm.formState.errors.reviewNote?.message}
                {...rejectForm.register('reviewNote')}
              />
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={() => setRejecting(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="danger" isLoading={review.isPending}>
                  Reject
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function AttendanceCorrectionsPage() {
  return (
    // Deliberately ungated by role. The service narrows an EMPLOYEE to their
    // own rows from the principal, so this screen doubles as "my requests" for
    // the people who raise them; the review buttons are gated instead.
    <ProtectedRoute>
      <AttendanceRequests />
    </ProtectedRoute>
  );
}
