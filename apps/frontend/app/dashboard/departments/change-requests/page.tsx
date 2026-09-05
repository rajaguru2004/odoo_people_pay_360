'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Clock, FileText, XCircle } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useChangeRequests } from '@/hooks/useChangeRequests';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type { RequestStatus } from '@/types/common';
import type { DepartmentChangeRequest } from '@/types/department';

const STATUS_TABS: Array<{ value: RequestStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const STATUS_TONE: Record<RequestStatus, 'warning' | 'success' | 'error' | 'neutral'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
};

const CHANGE_LABELS: Record<DepartmentChangeRequest['changeType'], string> = {
  MANAGER: 'Department head',
  PARENT: 'Reports to',
  RENAME: 'Name',
  DEACTIVATE: 'Status',
};

/**
 * The before and the after, taken from the SNAPSHOT the request was raised
 * with rather than from the department as it stands now. That is the point of
 * the `old*` columns: the queue keeps showing the value somebody objected to,
 * even if the record has moved on since.
 */
function beforeAfter(request: DepartmentChangeRequest): { before: string; after: string } {
  switch (request.changeType) {
    case 'MANAGER':
      return { before: fullName(request.oldManager), after: fullName(request.newManager) };
    case 'PARENT':
      return {
        before: request.oldParent?.name ?? 'Top level',
        after: request.newParent?.name ?? 'Top level',
      };
    case 'RENAME':
      return { before: request.oldName ?? '—', after: request.newName ?? '—' };
    case 'DEACTIVATE':
      return { before: 'Open', after: 'Closed' };
    default:
      return { before: '—', after: '—' };
  }
}

function raisedBy(request: DepartmentChangeRequest): string {
  const employee = request.requestedBy?.employee;
  if (employee) return fullName(employee);
  return request.requestedBy?.email ?? 'Unknown';
}

function RequestRow({ request }: { request: DepartmentChangeRequest }) {
  const { before, after } = beforeAfter(request);

  return (
    <Link
      href={`/dashboard/departments/change-requests/${request.id}`}
      data-testid="change-request-row"
      className="surface-panel grid gap-3 rounded-[var(--radius-card)] p-4 transition-all md:grid-cols-12 md:items-center"
    >
      <div className="md:col-span-3">
        <p className="truncate text-sm font-semibold text-text-heading">
          {request.department?.name ?? 'Unknown unit'}
        </p>
        <p className="mt-0.5 text-xs uppercase tracking-wide text-text-muted">
          {CHANGE_LABELS[request.changeType]}
        </p>
      </div>

      {/* The whole reason the queue exists: what this would change, in one line. */}
      <div className="flex min-w-0 items-center gap-2 text-sm md:col-span-4">
        <span className="truncate text-text-muted line-through decoration-text-muted/50">
          {before}
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-text-muted rtl:rotate-180" aria-hidden />
        <span className="truncate font-medium text-text-heading">{after}</span>
      </div>

      <div className="text-xs text-text-muted md:col-span-3">
        <p className="truncate">Raised by {raisedBy(request)}</p>
        <p className="mt-0.5 truncate">Takes effect {formatDateOnly(request.effectiveDate)}</p>
      </div>

      <div className="md:col-span-2 md:text-end">
        <Badge tone={STATUS_TONE[request.status]}>{request.status.toLowerCase()}</Badge>
      </div>
    </Link>
  );
}

function ChangeRequestsContent() {
  const [status, setStatus] = useState<RequestStatus | 'ALL'>('ALL');

  const { data, isLoading, isError } = useChangeRequests(
    status === 'ALL' ? {} : { status },
  );
  const requests = useMemo(() => data?.data ?? [], [data]);
  const total = data?.meta?.total ?? requests.length;

  usePageHeader(
    'Change requests',
    status === 'ALL'
      ? `${total} raised against the structure`
      : `${total} ${status.toLowerCase()}`,
  );

  const counts = useMemo(
    () => ({
      pending: requests.filter((request) => request.status === 'PENDING').length,
      approved: requests.filter((request) => request.status === 'APPROVED').length,
      rejected: requests.filter((request) => request.status === 'REJECTED').length,
    }),
    [requests],
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="In this view"
          value={requests.length}
          icon={<FileText className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Waiting"
          value={counts.pending}
          hint="Somebody has to decide"
          icon={<Clock className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Applied"
          value={counts.approved}
          icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Turned down"
          value={counts.rejected}
          icon={<XCircle className="h-5 w-5" aria-hidden />}
        />
      </div>

      <Card className="p-3">
        {/* Toggle buttons rather than a tablist: a tab implies a panel it
            controls, and what these move is the query behind the whole page. */}
        <div role="group" aria-label="Filter by status" className="flex flex-wrap items-center gap-2">
          {STATUS_TABS.map((tab) => {
            const active = status === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                aria-pressed={active}
                onClick={() => setStatus(tab.value)}
                className={`rounded-[var(--radius-button)] px-4 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-brand-primary text-text-on-brand'
                    : 'bg-surface-page text-text-muted hover:text-text-heading'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </Card>

      {isLoading && <Card className="p-6 text-sm text-text-muted">Loading the queue…</Card>}

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          The queue could not be read, so this page is not claiming it is empty.
        </Card>
      )}

      {!isLoading && !isError && requests.length === 0 && (
        <Card>
          <EmptyState
            icon={<FileText className="h-6 w-6" aria-hidden />}
            title="Nothing waiting"
            description="No request matches this filter."
          />
        </Card>
      )}

      {requests.length > 0 && (
        <div className="space-y-3">
          {requests.map((request) => (
            <RequestRow key={request.id} request={request} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChangeRequestsPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <ChangeRequestsContent />
    </ProtectedRoute>
  );
}
