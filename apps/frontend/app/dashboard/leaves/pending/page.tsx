'use client';

import { useRouter } from 'next/navigation';
import { CheckCircle, Clock, Paperclip } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { usePendingLeaveRequests } from '@/hooks/useLeaveRequests';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { formatDate, formatDateOnly } from '@/utils/formatDate';

/** "AB" from a joined name the API already put together. */
function initialsOf(name: string | undefined) {
  if (!name) return 'NA';
  return (
    name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'NA'
  );
}

function PendingLeaves() {
  const router = useRouter();
  const { data, isLoading, isError } = usePendingLeaveRequests();
  const requests = data?.data ?? [];

  usePageHeader('Pending leave approvals', 'Requests waiting on a decision from you');

  return (
    <div className="space-y-5" data-testid="leaves-pending">
      <div className="flex justify-end">
        <div className="inline-flex items-center gap-2 rounded-[var(--radius-card)] border border-status-warning/20 bg-status-warning-bg px-4 py-2">
          <Clock className="h-5 w-5 text-status-warning" aria-hidden />
          <span
            data-testid="pending-count"
            data-count={requests.length}
            className="font-semibold text-status-warning"
          >
            {requests.length} awaiting approval
          </span>
        </div>
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
            icon={<CheckCircle className="h-6 w-6" aria-hidden />}
            title="Nothing waiting"
            description="No leave requests are pending a decision."
          />
        )}

        {requests.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Employee</th>
                  <th className="px-5 py-3 text-start font-medium">Files</th>
                  <th className="px-5 py-3 text-start font-medium">Type</th>
                  <th className="px-5 py-3 text-start font-medium">From</th>
                  <th className="px-5 py-3 text-start font-medium">To</th>
                  <th className="px-5 py-3 text-start font-medium">Days</th>
                  <th className="px-5 py-3 text-start font-medium">Reason</th>
                  <th className="px-5 py-3 text-start font-medium">Raised</th>
                  <th className="px-5 py-3 text-end font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {requests.map((request) => {
                  const attachmentCount = request.attachments?.length ?? 0;
                  return (
                    <tr
                      key={request.id}
                      data-testid="pending-row"
                      data-leave-id={request.id}
                      className="hover:bg-surface-border-light/60"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-semibold text-brand-primary">
                            {initialsOf(request.employee?.fullName)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-text-heading">
                              {request.employee?.fullName ?? '—'}
                            </p>
                            <p className="truncate text-xs text-text-muted">
                              {request.employee?.employeeCode ?? ''}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        {attachmentCount > 0 ? (
                          <span
                            className="inline-flex items-center gap-1 text-text-muted"
                            title={`${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`}
                          >
                            <Paperclip className="h-4 w-4" aria-hidden />
                            <span className="rounded-[var(--radius-badge)] border border-surface-border bg-surface-page px-1.5 py-0.5 text-xs font-medium tabular-nums">
                              {attachmentCount}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 font-medium text-text-heading">
                        {request.leaveType}
                      </td>
                      <td className="px-5 py-3 tabular-nums text-text-body">
                        {formatDateOnly(request.startDate)}
                      </td>
                      <td className="px-5 py-3 tabular-nums text-text-body">
                        {formatDateOnly(request.endDate)}
                      </td>
                      <td className="px-5 py-3 font-semibold tabular-nums text-brand-primary">
                        {request.totalDays}
                      </td>
                      <td className="max-w-xs px-5 py-3">
                        <p className="truncate text-text-body">{request.reason}</p>
                      </td>
                      {/* createdAt is an instant, so it goes through the zoned
                          formatter rather than the date-only one. */}
                      <td className="px-5 py-3 text-text-muted">{formatDate(request.createdAt)}</td>
                      <td className="px-5 py-3 text-end">
                        <Button
                          size="sm"
                          aria-label={`Review ${request.employee?.fullName ?? 'this'} request`}
                          onClick={() => router.push(`/dashboard/leaves/${request.id}`)}
                        >
                          Review
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function PendingLeavesPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <PendingLeaves />
    </ProtectedRoute>
  );
}
