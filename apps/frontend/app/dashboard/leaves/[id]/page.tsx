'use client';

import { use, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Calendar,
  CheckCircle,
  Clock,
  FileText,
  Paperclip,
  Trash2,
  User,
  X,
  XCircle,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useApproveLeaveRequest,
  useCancelLeaveRequest,
  useDeleteLeaveAttachment,
  useLeaveApprovalTrail,
  useLeaveBalance,
  useLeaveRequest,
  useRejectLeaveRequest,
} from '@/hooks/useLeaveRequests';
import { useAuthStore } from '@/store/authStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Textarea';
import { formatDate, formatDateOnly, formatDateTime } from '@/utils/formatDate';
import { apiErrorMessage } from '@/utils/apiError';
import type {
  ApprovalTrailStep,
  LeaveAttachment,
  LeaveBalance,
  LeaveRequest,
  LeaveStatus,
} from '@/types/leave';

const STATUS_TONE: Record<LeaveStatus, 'success' | 'warning' | 'error' | 'neutral'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
};

function statusLabel(status: LeaveStatus) {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

/** How a step reads once it has been decided, skipped, or is still to come. */
function stepLabel(step: ApprovalTrailStep) {
  switch (step.status) {
    case 'ACTIVE':
      return 'Awaiting decision';
    case 'SKIPPED':
      return 'Skipped — no eligible approver';
    case 'PENDING':
      return 'Not started';
    case 'APPROVED':
      return 'Approved';
    case 'REJECTED':
      return 'Rejected';
    default:
      return step.status;
  }
}

const APPROVER_LABEL: Record<string, string> = {
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Dept. manager',
  HR_MANAGER: 'HR',
  ADMIN: 'Admin',
};

/**
 * What is left of the entitlement this request draws on.
 *
 * Reads the per-type row when the organisation has configured one, and falls
 * back to the two statutory buckets otherwise. `undefined` means the type is not
 * tracked at all — which is not the same as zero, and must never be printed as
 * one.
 */
function entitlementFor(balance: LeaveBalance | undefined, leaveType: string) {
  if (!balance) return undefined;

  const typed = balance.leaveTypeBalances ?? [];
  const match = typed.find(
    (row) => row.leaveTypeKey === leaveType || row.leaveTypeKey.toUpperCase() === leaveType.toUpperCase(),
  );
  if (match) {
    return {
      remaining: match.remaining,
      total: match.allocated + match.carriedOver,
      carriedOver: match.carriedOver,
    };
  }
  if (typed.length > 0) return undefined;

  const upper = leaveType.toUpperCase();
  if (upper.includes('ANNUAL')) {
    return {
      remaining:
        balance.remainingAnnual ?? balance.annualLeave + balance.carriedOver - balance.usedAnnual,
      total: balance.annualLeave + balance.carriedOver,
      carriedOver: balance.carriedOver,
    };
  }
  if (upper.includes('SICK')) {
    return {
      remaining: balance.remainingSick ?? balance.sickLeave - balance.usedSick,
      total: balance.sickLeave,
      carriedOver: 0,
    };
  }
  return undefined;
}

function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
}: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-md">
        <div className="flex items-start justify-between gap-3 border-b border-surface-border-light px-5 py-4">
          <div className="flex items-center gap-3">
            {icon}
            <h2 className="text-base font-semibold text-text-heading">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[var(--radius-button)] p-1 text-text-muted hover:bg-surface-border-light"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-surface-border-light px-5 py-3">
          {footer}
        </div>
      </Card>
    </div>
  );
}

/** The entitlement figure a reviewer needs in front of them before deciding. */
function BalanceContext({
  balance,
  leave,
}: {
  balance: LeaveBalance | undefined;
  leave: LeaveRequest;
}) {
  if (!balance) return null;
  const entitlement = entitlementFor(balance, leave.leaveType);

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] border border-surface-border bg-surface-page p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Leave balance ({balance.year})
      </p>
      {entitlement ? (
        <div className="space-y-2">
          <div>
            <p className="text-xs font-medium text-text-muted">Available {leave.leaveType}</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-text-heading">
              {entitlement.remaining} days remaining / {entitlement.total} days total
            </p>
          </div>
          {entitlement.remaining < leave.totalDays && (
            <div className="flex items-center gap-2 rounded-[var(--radius-button)] border border-status-error/20 bg-status-error-bg p-2.5 text-xs text-status-error">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                Requested {leave.totalDays}d exceeds the {entitlement.remaining}d available.
              </span>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs font-medium text-text-muted">
          This leave type is not tracked against a balance.
        </p>
      )}
    </div>
  );
}

function LeaveDetail({ id }: { id: string }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const ownEmployeeId = user?.employee?.id ?? user?.employeeId ?? undefined;

  const [approveComment, setApproveComment] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [deleting, setDeleting] = useState<LeaveAttachment | null>(null);

  const { data, isLoading, isError } = useLeaveRequest(id);
  const leave = data?.data;

  const trailQuery = useLeaveApprovalTrail(id);
  const trail = trailQuery.data?.data;

  // The year from the STRING, not from a parsed instant: `2026-01-01` read as an
  // instant is 2025 in any zone west of Greenwich, and the balance fetched would
  // be the wrong year's.
  const year = leave?.startDate ? Number(leave.startDate.slice(0, 4)) : undefined;
  const balanceQuery = useLeaveBalance(leave?.employeeId, year);
  const balance = balanceQuery.data?.data;

  const approve = useApproveLeaveRequest();
  const reject = useRejectLeaveRequest();
  const cancel = useCancelLeaveRequest();
  const deleteAttachment = useDeleteLeaveAttachment();

  usePageHeader('Leave request', `Request ${id.slice(0, 8)}`);

  const isAdmin = user?.role === 'ADMIN';
  const isHr = user?.role === 'HR_MANAGER';
  const isDeptManager =
    user?.role === 'MANAGER' &&
    Boolean(leave?.employee?.department?.id) &&
    leave?.employee?.department?.id === user?.employee?.department?.id;

  /**
   * Who may decide this request.
   *
   * A configured chain answers first and completely: its steps route to a
   * supervisor or a department manager, so `canAct` is the only thing that knows
   * whether THIS caller is the live approver. The role rule below it applies
   * only when no chain governs the request.
   */
  const canDecide = (() => {
    if (!leave || leave.status !== 'PENDING' || !user?.role) return false;
    if (trail?.engaged) return trail.canAct;
    return isAdmin || isHr || isDeptManager;
  })();

  const canCancel =
    leave?.status === 'PENDING' && Boolean(ownEmployeeId) && leave?.employeeId === ownEmployeeId;

  const handleApprove = async () => {
    if (!leave) return;
    try {
      const response = await approve.mutateAsync({ id, comment: approveComment || undefined });
      if (response.data?.status === 'APPROVED') {
        toast.success('Request approved');
      } else {
        // A multi-step chain: this step is done, the request is still open.
        toast.success('Your approval is recorded. The request moves to the next approver.');
      }
      setShowApprove(false);
      setApproveComment('');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Could not approve the request'));
    }
  };

  const handleReject = async () => {
    try {
      await reject.mutateAsync({ id, rejectedReason: rejectReason || undefined });
      toast.success('Request rejected');
      setShowReject(false);
      setRejectReason('');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Could not reject the request'));
    }
  };

  const handleCancel = async () => {
    try {
      await cancel.mutateAsync(id);
      setConfirmCancel(false);
      toast.success('Request cancelled');
      router.push('/dashboard/my-leaves');
    } catch (error) {
      setConfirmCancel(false);
      toast.error(apiErrorMessage(error, 'Could not cancel the request'));
    }
  };

  const handleDeleteAttachment = async () => {
    if (!deleting) return;
    try {
      await deleteAttachment.mutateAsync({ leaveRequestId: id, attachmentId: deleting.id });
      toast.success('Attachment deleted');
      setDeleting(null);
    } catch (error) {
      setDeleting(null);
      toast.error(apiErrorMessage(error, 'Could not delete the attachment'));
    }
  };

  if (isLoading) {
    return <p className="p-6 text-sm text-text-muted">Loading the request…</p>;
  }

  if (isError || !leave) {
    return <p className="p-6 text-sm text-text-muted">No leave request found.</p>;
  }

  const entitlement = entitlementFor(balance, leave.leaveType);
  const typedBalances = balance?.leaveTypeBalances ?? [];

  return (
    <div className="space-y-5" data-testid="leave-detail" data-leave-id={leave.id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" onClick={() => router.back()}>
          Back
        </Button>
        <span data-testid="leave-status" data-status={leave.status}>
          <Badge tone={STATUS_TONE[leave.status]}>{statusLabel(leave.status)}</Badge>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <div className="border-b border-surface-border-light px-5 py-4">
              <h2 className="text-base font-semibold text-text-heading">Employee</h2>
            </div>
            <dl className="grid grid-cols-2 gap-4 px-5 py-4 text-sm">
              <div>
                <dt className="text-text-muted">Name</dt>
                <dd className="font-medium text-text-heading">
                  {leave.employee?.fullName ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Employee code</dt>
                <dd className="font-medium text-text-heading">
                  {leave.employee?.employeeCode ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Department</dt>
                <dd className="font-medium text-text-heading">
                  {leave.employee?.department?.name ?? '—'}
                </dd>
              </div>
            </dl>
          </Card>

          <Card>
            <div className="border-b border-surface-border-light px-5 py-4">
              <h2 className="text-base font-semibold text-text-heading">The request</h2>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary/10 text-brand-primary">
                  <FileText className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <p className="text-sm text-text-muted">Leave type</p>
                  <p className="font-medium text-text-heading">{leave.leaveType}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-status-success-bg text-status-success">
                  <Calendar className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <p className="text-sm text-text-muted">Dates</p>
                  <p className="font-medium tabular-nums text-text-heading">
                    {formatDateOnly(leave.startDate)} – {formatDateOnly(leave.endDate)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-brand-accent/15 text-brand-accent">
                  <Clock className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <p className="text-sm text-text-muted">Total days</p>
                  <p
                    data-testid="leave-total-days"
                    data-days={leave.totalDays}
                    className="font-medium tabular-nums text-text-heading"
                  >
                    {leave.totalDays} days
                  </p>
                </div>
              </div>

              {balance && (
                <div className="border-t border-surface-border-light pt-4">
                  <p className="mb-2 text-sm font-medium text-text-muted">
                    Available balance ({balance.year})
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {typedBalances.length > 0
                      ? typedBalances.map((tb) => {
                          const isRequested =
                            tb.leaveTypeKey === leave.leaveType ||
                            tb.leaveTypeKey.toUpperCase() === leave.leaveType.toUpperCase();
                          return (
                            <div
                              key={tb.id}
                              data-testid="leave-balance-card"
                              data-leave-type={tb.leaveTypeKey}
                              className={`rounded-[var(--radius-card)] border p-3 ${
                                isRequested
                                  ? 'border-brand-primary/30 bg-brand-primary/5'
                                  : 'border-surface-border-light bg-surface-page'
                              }`}
                            >
                              <p className="text-xs font-medium text-text-muted">
                                {tb.leaveTypeKey}
                              </p>
                              <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-heading">
                                {tb.remaining} days left
                              </p>
                              <p className="mt-0.5 text-[10px] text-text-muted">
                                Total: {tb.allocated + tb.carriedOver} days (carried:{' '}
                                {tb.carriedOver})
                              </p>
                            </div>
                          );
                        })
                      : (
                          <>
                            <div className="rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-3">
                              <p className="text-xs font-medium text-text-muted">Annual leave</p>
                              <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-heading">
                                {balance.remainingAnnual ??
                                  balance.annualLeave + balance.carriedOver - balance.usedAnnual}{' '}
                                days left
                              </p>
                              <p className="mt-0.5 text-[10px] text-text-muted">
                                Total: {balance.annualLeave + balance.carriedOver} days (carried:{' '}
                                {balance.carriedOver})
                              </p>
                            </div>
                            <div className="rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-3">
                              <p className="text-xs font-medium text-text-muted">Sick leave</p>
                              <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-heading">
                                {balance.remainingSick ?? balance.sickLeave - balance.usedSick} days
                                left
                              </p>
                              <p className="mt-0.5 text-[10px] text-text-muted">
                                Total: {balance.sickLeave} days
                              </p>
                            </div>
                          </>
                        )}
                  </div>

                  {entitlement && entitlement.remaining < leave.totalDays && (
                    <div
                      data-testid="leave-balance-warning"
                      className="mt-3 flex items-center gap-2 rounded-[var(--radius-button)] border border-status-error/20 bg-status-error-bg p-3 text-xs text-status-error"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>
                        The {leave.totalDays} days requested exceed the {entitlement.remaining} days
                        of {leave.leaveType.toLowerCase()} still available.
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="border-t border-surface-border-light pt-4">
                <p className="mb-2 text-sm text-text-muted">Reason</p>
                <p className="whitespace-pre-wrap text-text-body">{leave.reason}</p>
              </div>
            </div>
          </Card>

          {leave.attachments && leave.attachments.length > 0 && (
            <Card data-testid="leave-attachments">
              <div className="flex items-center gap-2 border-b border-surface-border-light px-5 py-4">
                <Paperclip className="h-4 w-4 text-text-muted" aria-hidden />
                <h2 className="text-base font-semibold text-text-heading">Attachments</h2>
              </div>
              <ul className="grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-2">
                {leave.attachments.map((file) => {
                  const canDelete =
                    file.uploadedBy === user?.id || isAdmin || isHr || isDeptManager;
                  return (
                    <li
                      key={file.id}
                      data-testid="leave-attachment"
                      className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-surface-border bg-surface-page p-4"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary/10 text-brand-primary">
                          <FileText className="h-5 w-5" aria-hidden />
                        </span>
                        <div className="min-w-0">
                          <a
                            href={file.fileUrl}
                            target="_blank"
                            rel="noreferrer"
                            title={file.fileName}
                            className="block truncate text-sm font-semibold text-brand-primary hover:underline"
                          >
                            {file.fileName}
                          </a>
                          {file.fileSize !== undefined && (
                            <p className="text-xs text-text-muted">
                              {(file.fileSize / (1024 * 1024)).toFixed(2)} MB
                            </p>
                          )}
                        </div>
                      </div>
                      {canDelete && (
                        <button
                          type="button"
                          aria-label={`Delete ${file.fileName}`}
                          onClick={() => setDeleting(file)}
                          className="shrink-0 rounded-[var(--radius-button)] p-2 text-status-error hover:bg-status-error-bg"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {trail?.engaged && (
            <Card
              data-testid="leave-trail"
              data-can-act={trail.canAct}
              data-active-step={trail.activeStep ?? ''}
            >
              <div className="border-b border-surface-border-light px-5 py-4">
                <h2 className="text-base font-semibold text-text-heading">Approval chain</h2>
              </div>
              <ol className="space-y-4 px-5 py-4">
                {trail.steps.map((step) => {
                  const dot =
                    step.status === 'APPROVED'
                      ? 'bg-status-success'
                      : step.status === 'REJECTED'
                        ? 'bg-status-error'
                        : step.status === 'ACTIVE'
                          ? 'bg-status-warning'
                          : 'bg-surface-border';
                  return (
                    <li
                      key={step.id}
                      data-testid="leave-trail-step"
                      data-step-order={step.stepOrder}
                      data-step-status={step.status}
                      className="flex gap-3"
                    >
                      <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
                      <div>
                        <p className="text-sm font-semibold text-text-heading">
                          {step.stepOrder}. {APPROVER_LABEL[step.approverType] ?? step.approverType}{' '}
                          — {stepLabel(step)}
                        </p>
                        {step.decidedAt && (
                          <p className="text-xs text-text-muted">{formatDateTime(step.decidedAt)}</p>
                        )}
                        {step.comment && (
                          <p className="text-xs italic text-text-muted">{step.comment}</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {leave.status === 'PENDING' && trail.activeStep !== null && !trail.canAct && (
                <p className="border-t border-surface-border-light px-5 py-3 text-xs text-text-muted">
                  Waiting on step {trail.activeStep}. You are not the approver for that step.
                </p>
              )}
            </Card>
          )}

          {(leave.status === 'APPROVED' || leave.status === 'REJECTED') && (
            <Card>
              <div className="border-b border-surface-border-light px-5 py-4">
                <h2 className="text-base font-semibold text-text-heading">
                  {leave.status === 'APPROVED' ? 'Approval' : 'Rejection'}
                </h2>
              </div>
              <div className="space-y-4 px-5 py-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] ${
                      leave.status === 'APPROVED'
                        ? 'bg-status-success-bg text-status-success'
                        : 'bg-status-error-bg text-status-error'
                    }`}
                  >
                    <User className="h-5 w-5" aria-hidden />
                  </span>
                  <div>
                    <p className="text-sm text-text-muted">Decided by</p>
                    <p className="font-medium text-text-heading">{leave.approver?.email ?? '—'}</p>
                  </div>
                </div>

                {leave.approvedAt && (
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] ${
                        leave.status === 'APPROVED'
                          ? 'bg-status-success-bg text-status-success'
                          : 'bg-status-error-bg text-status-error'
                      }`}
                    >
                      <Clock className="h-5 w-5" aria-hidden />
                    </span>
                    <div>
                      <p className="text-sm text-text-muted">When</p>
                      <p className="font-medium text-text-heading">
                        {formatDateTime(leave.approvedAt)}
                      </p>
                    </div>
                  </div>
                )}

                {leave.rejectedReason && (
                  <div className="border-t border-surface-border-light pt-4">
                    <p className="mb-2 text-sm text-text-muted">
                      {leave.status === 'APPROVED' ? 'Comment' : 'Reason'}
                    </p>
                    <p
                      className={`whitespace-pre-wrap ${
                        leave.status === 'APPROVED' ? 'text-status-success' : 'text-status-error'
                      }`}
                    >
                      {leave.rejectedReason}
                    </p>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          {canDecide && (
            <>
              <Button
                className="w-full"
                data-testid="leave-approve-open"
                onClick={() => setShowApprove(true)}
              >
                <CheckCircle className="h-4 w-4" aria-hidden />
                Approve
              </Button>
              <Button
                className="w-full"
                variant="danger"
                data-testid="leave-reject-open"
                onClick={() => setShowReject(true)}
              >
                <XCircle className="h-4 w-4" aria-hidden />
                Reject
              </Button>
            </>
          )}

          {canCancel && (
            <Button
              className="w-full"
              variant="outline"
              data-testid="leave-cancel"
              onClick={() => setConfirmCancel(true)}
            >
              <XCircle className="h-4 w-4" aria-hidden />
              Cancel this request
            </Button>
          )}

          <Card>
            <div className="border-b border-surface-border-light px-5 py-4">
              <h3 className="text-base font-semibold text-text-heading">History</h3>
            </div>
            <ol className="space-y-4 px-5 py-4">
              <li className="flex gap-3">
                <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand-primary" aria-hidden />
                <div>
                  <p className="text-sm font-semibold text-text-heading">Raised</p>
                  <p className="text-xs text-text-muted">{formatDate(leave.createdAt)}</p>
                </div>
              </li>
              {leave.approvedAt && (
                <li className="flex gap-3">
                  <span
                    className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                      leave.status === 'APPROVED' ? 'bg-status-success' : 'bg-status-error'
                    }`}
                    aria-hidden
                  />
                  <div>
                    <p className="text-sm font-semibold text-text-heading">
                      {statusLabel(leave.status)}
                    </p>
                    <p className="text-xs text-text-muted">{formatDateTime(leave.approvedAt)}</p>
                  </div>
                </li>
              )}
            </ol>
          </Card>
        </div>
      </div>

      {showApprove && (
        <Modal
          title="Approve this request"
          icon={
            <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] bg-status-success-bg text-status-success">
              <CheckCircle className="h-5 w-5" aria-hidden />
            </span>
          }
          onClose={() => {
            setShowApprove(false);
            setApproveComment('');
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowApprove(false);
                  setApproveComment('');
                }}
              >
                Cancel
              </Button>
              <Button
                data-testid="leave-approve-confirm"
                isLoading={approve.isPending}
                onClick={() => void handleApprove()}
              >
                Approve
              </Button>
            </>
          }
        >
          <BalanceContext balance={balance} leave={leave} />
          <p className="text-sm font-medium text-text-body">
            Approve {leave.totalDays} days of {leave.leaveType} for{' '}
            {leave.employee?.fullName ?? 'this employee'}?
          </p>
          <Textarea
            label="Comment (optional)"
            data-testid="leave-approve-comment"
            placeholder="Anything the employee should know"
            value={approveComment}
            onChange={(event) => setApproveComment(event.target.value)}
          />
        </Modal>
      )}

      {showReject && (
        <Modal
          title="Reject this request"
          icon={
            <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] bg-status-error-bg text-status-error">
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </span>
          }
          onClose={() => {
            setShowReject(false);
            setRejectReason('');
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowReject(false);
                  setRejectReason('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                data-testid="leave-reject-confirm"
                isLoading={reject.isPending}
                onClick={() => void handleReject()}
              >
                Reject
              </Button>
            </>
          }
        >
          <BalanceContext balance={balance} leave={leave} />
          <p className="text-sm font-medium text-text-body">
            Reject this request? The employee is told the outcome either way.
          </p>
          <Textarea
            label="Reason (optional)"
            data-testid="leave-reject-reason"
            placeholder="Why it is being refused"
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
          />
        </Modal>
      )}

      {confirmCancel && (
        <Modal
          title="Withdraw this request"
          onClose={() => setConfirmCancel(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                isLoading={cancel.isPending}
                onClick={() => void handleCancel()}
              >
                Withdraw
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-body">
            This takes the request out of the approval queue. You can raise a new one afterwards.
          </p>
        </Modal>
      )}

      {deleting && (
        <Modal
          title="Delete this attachment"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                isLoading={deleteAttachment.isPending}
                onClick={() => void handleDeleteAttachment()}
              >
                Delete
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-body">
            &ldquo;{deleting.fileName}&rdquo; will be removed from this request permanently.
          </p>
        </Modal>
      )}
    </div>
  );
}

export default function LeaveDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  return (
    // Ungated by role: an employee reaches this page for their own request, and
    // the server decides what the payload contains. The decide buttons are
    // gated instead.
    <ProtectedRoute>
      <LeaveDetail id={id} />
    </ProtectedRoute>
  );
}
