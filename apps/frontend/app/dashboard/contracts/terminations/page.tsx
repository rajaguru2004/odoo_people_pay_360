'use client';

import { useState } from 'react';
import Link from 'next/link';
import { UserMinus } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { useReviewTermination, useTerminations } from '@/hooks/useContracts';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type { RequestStatus, ReviewAction } from '@/types/common';
import type { TerminationRequest } from '@/types/contract';

const REQUEST_TONE: Record<RequestStatus, 'neutral' | 'success' | 'warning' | 'error'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
};

const STATUS_FILTERS: RequestStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

function humanise(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

/**
 * The confirm step, which exists to state the CONSEQUENCE rather than to ask
 * "are you sure".
 *
 * Approving is the only place employment actually ends: the contract closes, the
 * employee record is marked terminated and their exit date is written from this
 * request. None of that is visible from a row in a queue, so the sentence spells
 * it out with the name and the date already filled in.
 */
function ReviewDialog({
  request,
  action,
  busy,
  onConfirm,
  onCancel,
}: {
  request: TerminationRequest;
  action: ReviewAction;
  busy: boolean;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState('');
  const name = fullName(request.contract?.employee);
  const approving = action === 'APPROVE';

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="review-termination-title"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-[var(--radius-card)] bg-surface-overlay p-6 shadow-2xl">
        <h2
          id="review-termination-title"
          className="text-lg font-semibold text-text-heading"
        >
          {approving ? 'Approve this termination?' : 'Reject this termination?'}
        </h2>

        <p className="mt-3 text-sm text-text-body">
          {approving ? (
            <>
              Approving ends {name}&apos;s employment. The contract closes, the record is marked
              terminated and the exit date is set to{' '}
              <span className="font-semibold">{formatDateOnly(request.terminationDate)}</span>.
            </>
          ) : (
            <>
              Rejecting leaves {name} employed and the contract untouched. The request stays on
              file with whatever you write below.
            </>
          )}
        </p>

        {approving && (
          <p className="mt-2 text-sm text-text-muted">
            The record is not deleted — payslips and audit entries keep resolving against it.
          </p>
        )}

        <div className="mt-4">
          <Textarea
            label="Review note"
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Shown to whoever raised the request."
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={approving ? 'danger' : 'primary'}
            isLoading={busy}
            onClick={() => onConfirm(note)}
          >
            {approving ? 'End the employment' : 'Reject the request'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TerminationQueue() {
  const role = useAuthStore((s) => s.user?.role);
  // Only an ADMIN may review. HR sees the queue and what it is waiting on, which
  // is what tells them whether to chase somebody.
  const canReview = role === 'ADMIN';

  const [status, setStatus] = useState<RequestStatus | ''>('PENDING');
  const [page, setPage] = useState(1);
  const [pendingReview, setPendingReview] = useState<{
    request: TerminationRequest;
    action: ReviewAction;
  } | null>(null);

  const { data, isLoading, isError } = useTerminations({
    page,
    status: status || undefined,
  });
  const review = useReviewTermination();

  const requests = data?.data ?? [];
  const total = data?.meta?.total;

  usePageHeader(
    'Terminations',
    total === undefined ? undefined : `${total} request${total === 1 ? '' : 's'}`,
  );

  const handleReview = async (note: string) => {
    if (!pendingReview) return;
    try {
      await review.mutateAsync({
        id: pendingReview.request.id,
        payload: {
          action: pendingReview.action,
          ...(note.trim() ? { reviewNote: note.trim() } : {}),
        },
      });
      toast.success(
        pendingReview.action === 'APPROVE'
          ? 'Employment ended and the exit date recorded'
          : 'Request rejected',
      );
      setPendingReview(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not record that decision'));
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-56">
          <Select
            aria-label="Filter by request status"
            placeholder="Every request"
            value={status}
            onChange={(event) => {
              // Reset in the handler, not an effect: page 4 of the new filter is
              // an empty table the reader would read as "nothing waiting".
              setStatus(event.target.value as RequestStatus | '');
              setPage(1);
            }}
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </Select>
        </div>
        <Link href="/dashboard/contracts">
          <Button variant="outline">All contracts</Button>
        </Link>
      </div>

      <Card>
        {isLoading && <p className="p-6 text-sm text-text-muted">Loading the queue…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            Could not load the queue. Is the API running?
          </p>
        )}

        {!isLoading && !isError && requests.length === 0 && (
          <EmptyState
            icon={<UserMinus className="h-6 w-6" aria-hidden />}
            title="Nothing waiting"
            description={
              status === 'PENDING'
                ? 'No termination is waiting on a decision.'
                : 'No request matches that filter.'
            }
          />
        )}

        {requests.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Employee</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Contract</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Category</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Notice</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Last day</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">State</th>
                  {canReview && (
                    <th scope="col" className="px-5 py-3 text-end font-medium">
                      Decision
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {requests.map((request) => (
                  <tr key={request.id} className="hover:bg-surface-border-light/60">
                    <td className="px-5 py-3">
                      <p className="font-medium text-text-heading">
                        {fullName(request.contract?.employee)}
                      </p>
                      <p className="mt-0.5 text-xs text-text-muted">{request.reason}</p>
                    </td>
                    <td className="px-5 py-3">
                      {request.contract ? (
                        <Link
                          href={`/dashboard/contracts/${request.contractId}`}
                          className="text-brand-primary hover:underline"
                        >
                          {request.contract.contractNumber}
                        </Link>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-text-body">{humanise(request.category)}</td>
                    <td className="px-5 py-3 text-text-body">
                      {formatDateOnly(request.noticeDate)}
                      {!request.noticeServed && (
                        <span className="ms-1 text-xs text-text-muted">(paid out)</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-text-body">
                      {formatDateOnly(request.terminationDate)}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={REQUEST_TONE[request.status]}>{humanise(request.status)}</Badge>
                    </td>
                    {canReview && (
                      <td className="px-5 py-3">
                        {request.status === 'PENDING' ? (
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => setPendingReview({ request, action: 'APPROVE' })}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setPendingReview({ request, action: 'REJECT' })}
                            >
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <p className="text-end text-xs text-text-muted">
                            {request.reviewedAt ? formatDateOnly(request.reviewedAt) : '—'}
                          </p>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination meta={data?.meta} onPageChange={setPage} />
      </Card>

      {pendingReview && (
        <ReviewDialog
          request={pendingReview.request}
          action={pendingReview.action}
          busy={review.isPending}
          onConfirm={handleReview}
          onCancel={() => setPendingReview(null)}
        />
      )}
    </div>
  );
}

export default function TerminationsPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <TerminationQueue />
    </ProtectedRoute>
  );
}
