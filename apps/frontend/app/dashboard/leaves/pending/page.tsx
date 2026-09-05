'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Check, X } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import {
  useApproveLeaveRequest,
  usePendingLeaveRequests,
  useLeaveStats,
  useRejectLeaveRequest,
} from '@/hooks/useLeaveRequests';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import { daysWaiting, formatDays } from '@/components/leave/leaveFormat';
import type { LeaveRequest } from '@/types/leave';

const PAGE_SIZE = 20;

/**
 * The approval queue.
 *
 * Ordered oldest-first is not enough on its own: the row that matters is the one
 * that has been waiting, so a request older than two days carries a warning of
 * its own. Two days is the point at which an approval stops being "not yet" and
 * starts being "forgotten".
 *
 * Approving reports what it did with the attendance rows. A day the employee
 * already clocked keeps its own record, and the approver is TOLD — silently
 * skipping meant a day of approved leave had no ON_LEAVE row behind it and
 * nobody knew.
 */
function PendingLeaveContent() {
  const [page, setPage] = useState(1);
  const [rejecting, setRejecting] = useState<LeaveRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const query = useMemo(() => ({ page, limit: PAGE_SIZE }), [page]);
  const { data, isLoading, isError, error } = usePendingLeaveRequests(query);
  const stats = useLeaveStats();

  const approve = useApproveLeaveRequest();
  const reject = useRejectLeaveRequest();

  const rows = data?.data ?? [];

  usePageHeader(
    'Pending leave',
    stats.data ? `${stats.data.data.pending} waiting on a decision` : undefined,
  );

  const onApprove = async (request: LeaveRequest) => {
    try {
      const result = await approve.mutateAsync({ id: request.id });
      // The server's own sentence, not a generic one: it is the only thing that
      // knows how many days already had attendance.
      toast.success(result.message);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The request could not be approved.'));
    }
  };

  const onReject = async () => {
    if (!rejecting) return;
    try {
      await reject.mutateAsync({ id: rejecting.id, comment: rejectReason });
      toast.success('Leave rejected.');
      setRejecting(null);
      setRejectReason('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The request could not be rejected.'));
    }
  };

  if (isError) {
    return (
      <Card className="p-6">
        <p className="text-sm text-status-error">
          {apiErrorMessage(error, 'The queue could not be loaded.')}
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-[var(--radius-card)] bg-surface-border/60" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing is waiting"
            description="Every leave request has been decided."
            action={
              <Link href="/dashboard/leaves">
                <Button variant="outline">See all requests</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((request) => {
            const waiting = daysWaiting(request.createdAt);
            return (
              <Card key={request.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/dashboard/leaves/${request.id}`}
                        className="text-base font-semibold text-text-heading hover:text-brand-primary"
                      >
                        {request.employee ? fullName(request.employee) : 'Unknown employee'}
                      </Link>
                      <Badge tone="info">{request.leaveType}</Badge>
                      {waiting >= 2 && (
                        <Badge tone="warning">waiting {waiting} days</Badge>
                      )}
                    </div>

                    <p className="mt-1 text-sm text-text-muted">
                      {formatDateOnly(request.startDate)} –{' '}
                      {formatDateOnly(request.endDate)} ·{' '}
                      <span className="font-medium text-text-body">
                        {formatDays(request.totalDays)}
                      </span>
                      {request.employee?.department
                        ? ` · ${request.employee.department.name}`
                        : ''}
                    </p>

                    <p className="mt-2 max-w-2xl whitespace-pre-wrap text-sm text-text-body">
                      {request.reason}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => void onApprove(request)}
                      isLoading={approve.isPending}
                    >
                      <Check className="h-4 w-4" aria-hidden />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRejecting(request);
                        setRejectReason('');
                      }}
                    >
                      <X className="h-4 w-4" aria-hidden />
                      Reject
                    </Button>
                  </div>
                </div>

                {rejecting?.id === request.id && (
                  <div className="mt-4 border-t border-surface-border-light pt-4">
                    <Textarea
                      label="Why it is being rejected"
                      rows={2}
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      // Required, and only here: the person who filed this is
                      // owed a reason, and "Rejected" alone is the start of an
                      // argument rather than the end of one.
                      placeholder="Two people are already off that week"
                    />
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={rejectReason.trim().length < 3}
                        isLoading={reject.isPending}
                        onClick={() => void onReject()}
                      >
                        Confirm rejection
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRejecting(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}

          <Card>
            <Pagination meta={data?.meta} onPageChange={setPage} />
          </Card>
        </div>
      )}
    </div>
  );
}

export default function PendingLeavePage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <PendingLeaveContent />
    </ProtectedRoute>
  );
}
