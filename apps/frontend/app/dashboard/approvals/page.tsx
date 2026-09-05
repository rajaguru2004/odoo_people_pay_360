'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Eye, Inbox, X } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useApprovalHistory,
  useApprovalInbox,
  useDecideApproval,
} from '@/hooks/useApprovals';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDate } from '@/utils/formatDate';
import type { ApprovalInboxItem } from '@/types/approval';
import { APPROVAL_KIND_UI } from './approvalKinds';

type Tab = 'pending' | 'decided';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'pending', label: 'Awaiting me' },
  { key: 'decided', label: 'Decided by me' },
];

/** The approver-type enum, said the way an approver would say it. */
function approverLabel(approverType: string): string {
  switch (approverType) {
    case 'HR_MANAGER':
      return 'HR';
    case 'MANAGER':
      return 'Dept. manager';
    case 'SUPERVISOR':
      return 'Supervisor';
    case 'ADMIN':
      return 'Admin';
    default:
      return approverType;
  }
}

function ApprovalsInbox() {
  const [tab, setTab] = useState<Tab>('pending');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  usePageHeader(
    'Approvals',
    tab === 'decided'
      ? 'Requests you have already decided'
      : 'Requests awaiting your decision',
  );

  // Only the visible half is fetched. The two lists answer different questions
  // and neither is cheap enough to keep warm for a tab nobody opened.
  const inbox = useApprovalInbox(tab === 'pending');
  const history = useApprovalHistory(50, tab === 'decided');
  const decide = useDecideApproval();

  const active = tab === 'decided' ? history : inbox;
  const items = useMemo(() => active.data?.data ?? [], [active.data]);

  const submit = async (
    item: ApprovalInboxItem,
    decision: 'APPROVE' | 'REJECT',
    text?: string,
  ) => {
    if (decision === 'REJECT' && !text?.trim()) {
      toast.warning('Say why it is being rejected');
      return;
    }
    setBusyId(item.requestId);
    try {
      await decide.mutateAsync({ item, decision, reason: text });
      toast.success(decision === 'APPROVE' ? 'Approved' : 'Rejected');
      setRejecting(null);
      setReason('');
    } catch (error) {
      // The axios interceptor rejects with a FLAT object — there is no
      // `.response` to read through.
      toast.error(apiErrorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Two lists, one screen. Merged, what still needs a decision would be
          buried under what no longer does — and that is this screen's first job. */}
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((entry) => {
          const isActive = tab === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              data-testid={`approval-tab-${entry.key}`}
              aria-pressed={isActive}
              onClick={() => {
                setTab(entry.key);
                setRejecting(null);
                setReason('');
              }}
              className={`rounded-[var(--radius-button)] border px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'border-brand-primary bg-brand-primary text-text-on-brand'
                  : 'border-surface-border bg-surface-card text-text-body hover:bg-surface-border-light'
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {active.isLoading && (
        <Card className="p-6">
          <p data-testid="approval-loading" className="text-sm text-text-muted">
            Loading…
          </p>
        </Card>
      )}

      {active.isError && (
        <Card className="p-6">
          <p className="text-sm text-status-error">
            {apiErrorMessage(active.error, 'Could not load approvals.')}
          </p>
        </Card>
      )}

      {/* An empty QUEUE is good news; an empty RECORD means "you have decided
          nothing yet". One message for both would say the wrong thing on one. */}
      {!active.isLoading && !active.isError && items.length === 0 && (
        <Card>
          <div
            data-testid={tab === 'decided' ? 'approval-decided-empty' : 'approval-empty'}
          >
            <EmptyState
              icon={<Inbox className="h-6 w-6" aria-hidden />}
              title={tab === 'decided' ? 'Nothing decided yet.' : 'No pending approvals.'}
              description={
                tab === 'decided'
                  ? 'Requests you decide will be listed here.'
                  : 'Nothing is waiting on you right now.'
              }
            />
          </div>
        </Card>
      )}

      {items.length > 0 && (
        <div className="space-y-3">
          {items.map((item) => {
            const request = item.request ?? { id: item.requestId };
            const employee = request.employee ?? undefined;
            const kind = APPROVAL_KIND_UI[item.requestType];
            const KindIcon = kind.icon;
            const busy = busyId === item.requestId;
            const settled = Boolean(item.decision);
            const recordHref = kind.href?.(item.requestId);

            return (
              <Card
                key={`${item.requestType}-${item.requestId}`}
                data-testid="approval-row"
                data-request-type={item.requestType}
                data-request-id={item.requestId}
                data-step-order={item.stepOrder}
                data-approver-type={item.approverType}
                className="p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      aria-hidden
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-sm font-semibold text-brand-primary"
                    >
                      {employee?.fullName?.charAt(0) ?? '?'}
                    </span>

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-text-heading">
                          {employee?.fullName ?? 'Employee'}
                        </p>
                        <Badge tone={kind.tone}>
                          <KindIcon className="me-1 h-3 w-3" aria-hidden />
                          {kind.label}
                        </Badge>
                        <Badge>
                          Step {item.stepOrder} · {approverLabel(item.approverType)}
                        </Badge>
                        {/* What THIS user did. Not the request's own standing —
                            a step-1 approval leaves it pending behind them. */}
                        {item.decision && (
                          <span data-testid="approval-decision" data-decision={item.decision}>
                            <Badge tone={item.decision === 'APPROVED' ? 'success' : 'error'}>
                              {item.decision === 'APPROVED' ? 'You approved' : 'You rejected'}
                            </Badge>
                          </span>
                        )}
                      </div>

                      <p className="mt-0.5 text-xs text-text-muted">
                        {employee?.employeeCode ?? '—'}
                        {employee?.department?.name ? ` · ${employee.department.name}` : ''}
                      </p>

                      <p className="mt-2 text-sm text-text-body">{kind.summary(request)}</p>

                      {request.reason && (
                        <p className="mt-1 text-xs italic text-text-muted">
                          “{request.reason}”
                        </p>
                      )}

                      {item.decidedAt && (
                        <p data-testid="approval-decided-at" className="mt-1 text-xs text-text-muted">
                          Decided {formatDate(item.decidedAt)}
                          {item.comment ? ` · “${item.comment}”` : ''}
                        </p>
                      )}

                      {!kind.decidable && !settled && (
                        <p className="mt-2 text-xs text-text-muted">
                          Decided in the module that owns this request.
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {recordHref && (
                      <Link
                        href={recordHref}
                        data-testid="approval-details"
                        className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] border border-surface-border px-3 text-sm font-medium text-text-body transition-colors hover:bg-surface-border-light"
                      >
                        <Eye className="h-4 w-4" aria-hidden />
                        {settled ? 'View full request' : 'View details'}
                      </Link>
                    )}

                    {/* A settled row is a RECORD, not a control: the server
                        refuses a second decision on it. */}
                    {!settled && kind.decidable && (
                      <>
                        <Button
                          size="sm"
                          data-testid="approval-approve"
                          isLoading={busy && rejecting !== item.requestId}
                          onClick={() => void submit(item, 'APPROVE')}
                        >
                          <Check className="h-4 w-4" aria-hidden />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="approval-reject-open"
                          disabled={busy}
                          onClick={() => {
                            setRejecting(rejecting === item.requestId ? null : item.requestId);
                            setReason('');
                          }}
                        >
                          <X className="h-4 w-4" aria-hidden />
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {rejecting === item.requestId && !settled && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-surface-border-light pt-3">
                    <input
                      data-testid="approval-reject-reason"
                      aria-label="Reason for rejection"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Reason for rejection…"
                      className="h-9 min-w-0 flex-1 rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                    />
                    <Button
                      size="sm"
                      variant="danger"
                      data-testid="approval-reject-confirm"
                      isLoading={busy}
                      onClick={() => void submit(item, 'REJECT', reason)}
                    >
                      Confirm reject
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ApprovalsPage() {
  return (
    // Deliberately ungated by role: a configured chain routes to a supervisor
    // or a department manager, neither of whom carries an approver role. The
    // server serves an empty queue to anyone who is not an approver.
    <ProtectedRoute>
      <ApprovalsInbox />
    </ProtectedRoute>
  );
}
