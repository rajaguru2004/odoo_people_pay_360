'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Check, Paperclip, X } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Textarea';
import {
  useApproveLeaveRequest,
  useCancelLeaveRequest,
  useLeaveRequest,
  useRejectLeaveRequest,
} from '@/hooks/useLeaveRequests';
import { useEmployeeLeaveBalance } from '@/hooks/useLeaveBalances';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly, formatDateTime } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import {
  STATUS_TONE,
  daysWaiting,
  formatDays,
  statusLabel,
} from '@/components/leave/leaveFormat';

/**
 * One leave request, and the decision on it.
 *
 * The approver sees the BALANCE beside the request, because "they have four days
 * left and are asking for five" is the fact the decision turns on — and it is
 * the reason the balance endpoint admits a supervisor who owns none of the
 * requester's other records.
 */
function LeaveRequestDetail({ id }: { id: string }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const ownEmployeeId = user?.employee?.id ?? user?.employeeId ?? undefined;

  const { data, isLoading, isError, error } = useLeaveRequest(id);
  const request = data?.data;

  const approve = useApproveLeaveRequest();
  const reject = useRejectLeaveRequest();
  const cancel = useCancelLeaveRequest();

  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');

  const balance = useEmployeeLeaveBalance(
    request?.employeeId,
    request ? Number(request.startDate.slice(0, 4)) : undefined,
  );
  const typeBalance = balance.data?.data.leaveTypeBalances.find(
    (b) => b.leaveTypeKey === request?.leaveType,
  );

  usePageHeader(
    request ? `${request.leaveType} request` : 'Leave request',
    request?.employee ? fullName(request.employee) : undefined,
  );

  const isOwn = Boolean(
    ownEmployeeId && request && request.employeeId === ownEmployeeId,
  );
  const canDecide =
    Boolean(request) &&
    request!.status === 'PENDING' &&
    // Nobody decides their own, however senior. An approval is a second pair of
    // eyes or it is nothing — and the server refuses it either way.
    !isOwn &&
    ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'].includes(user?.role ?? '');

  const onApprove = async () => {
    try {
      const result = await approve.mutateAsync({ id, comment: comment.trim() || undefined });
      toast.success(result.message);
      setComment('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The request could not be approved.'));
    }
  };

  const onReject = async () => {
    try {
      await reject.mutateAsync({ id, comment: comment.trim() });
      toast.success('Leave rejected.');
      setRejecting(false);
      setComment('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The request could not be rejected.'));
    }
  };

  const onCancel = async () => {
    try {
      await cancel.mutateAsync(id);
      toast.success('Request withdrawn.');
      router.push('/dashboard/my-leaves');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The request could not be withdrawn.'));
    }
  };

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-[var(--radius-card)] bg-surface-border/60" />;
  }

  if (isError || !request) {
    return (
      <Card className="p-6">
        <p className="text-sm text-status-error">
          {apiErrorMessage(error, 'This leave request could not be loaded.')}
        </p>
      </Card>
    );
  }

  const waiting = request.status === 'PENDING' ? daysWaiting(request.createdAt) : 0;

  return (
    <div className="max-w-4xl space-y-5">
      <Link
        href="/dashboard/leaves"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-brand-primary"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
        All leave requests
      </Link>

      <Card>
        <CardHeader
          title={request.leaveType}
          subtitle={
            request.employee
              ? `${fullName(request.employee)} · ${request.employee.employeeCode}`
              : undefined
          }
          action={
            <div className="flex items-center gap-2">
              <Badge tone={STATUS_TONE[request.status]}>
                {statusLabel(request.status)}
              </Badge>
              {waiting >= 2 && <Badge tone="warning">waiting {waiting} days</Badge>}
            </div>
          }
        />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <Field label="First day off" value={formatDateOnly(request.startDate)} />
          <Field label="Last day off" value={formatDateOnly(request.endDate)} />
          <Field
            label="Working days"
            value={formatDays(request.totalDays)}
            hint="Weekly rest days and public holidays at this branch are already excluded."
          />
          <Field label="Filed" value={formatDateTime(request.createdAt)} />

          <div className="sm:col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Reason
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-text-body">
              {request.reason}
            </p>
          </div>

          {request.approvedAt && (
            <div className="sm:col-span-2 border-t border-surface-border-light pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Decision
              </p>
              <p className="mt-1 text-sm text-text-body">
                {request.approver?.email ?? 'An approver'} ·{' '}
                {formatDateTime(request.approvedAt)}
              </p>
              {request.rejectedReason && (
                <p className="mt-1 text-sm text-text-muted">{request.rejectedReason}</p>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Balance"
          subtitle={`${request.leaveType} in ${request.startDate.slice(0, 4)}.`}
        />
        <CardBody>
          {balance.isLoading ? (
            <div className="h-6 w-48 animate-pulse rounded bg-surface-border/60" />
          ) : balance.isError ? (
            <p className="text-sm text-text-muted">
              {/* Not zeros: a balance nobody could read is not a balance of nothing. */}
              The balance could not be read.
            </p>
          ) : typeBalance ? (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure label="Allocated" value={formatDays(typeBalance.allocated)} />
              <Figure label="Carried over" value={formatDays(typeBalance.carriedOver)} />
              <Figure label="Taken" value={formatDays(typeBalance.used)} />
              <Figure
                label="Remaining"
                value={formatDays(typeBalance.remaining)}
                emphasis
                warn={
                  request.status === 'PENDING' &&
                  typeBalance.remaining < request.totalDays
                }
              />
            </dl>
          ) : (
            <p className="text-sm text-text-muted">
              No balance has been set up for this type.
            </p>
          )}

          {typeBalance &&
            request.status === 'PENDING' &&
            typeBalance.remaining < request.totalDays && (
              <p className="mt-4 rounded-[var(--radius-card)] bg-status-error-bg px-4 py-3 text-sm text-status-error">
                This request asks for {formatDays(request.totalDays)} and only{' '}
                {formatDays(typeBalance.remaining)} remain. Approving it will fail
                and leave the request pending.
              </p>
            )}
        </CardBody>
      </Card>

      {(request.attachments?.length ?? 0) > 0 && (
        <Card>
          <CardHeader title="Attachments" subtitle="Evidence filed with the request." />
          <CardBody className="space-y-2">
            {request.attachments!.map((file) => (
              <a
                key={file.id}
                href={file.fileUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 text-sm text-brand-primary hover:underline"
              >
                <Paperclip className="h-4 w-4" aria-hidden />
                {file.fileName}
              </a>
            ))}
          </CardBody>
        </Card>
      )}

      {canDecide && (
        <Card>
          <CardHeader
            title="Decide"
            subtitle="Approving deducts the balance and writes an on-leave day for every working date."
          />
          <CardBody className="space-y-3">
            <Textarea
              label={rejecting ? 'Why it is being rejected' : 'Note (optional)'}
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={
                rejecting
                  ? 'Two people are already off that week'
                  : 'Anything the employee should know'
              }
            />
            <div className="flex flex-wrap items-center gap-2">
              {rejecting ? (
                <>
                  <Button
                    variant="danger"
                    disabled={comment.trim().length < 3}
                    isLoading={reject.isPending}
                    onClick={() => void onReject()}
                  >
                    Confirm rejection
                  </Button>
                  <Button variant="ghost" onClick={() => setRejecting(false)}>
                    Back
                  </Button>
                </>
              ) : (
                <>
                  <Button isLoading={approve.isPending} onClick={() => void onApprove()}>
                    <Check className="h-4 w-4" aria-hidden />
                    Approve
                  </Button>
                  <Button variant="outline" onClick={() => setRejecting(true)}>
                    <X className="h-4 w-4" aria-hidden />
                    Reject
                  </Button>
                </>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {isOwn && request.status === 'PENDING' && (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-muted">
              You filed this. It can be withdrawn until somebody decides it.
            </p>
            <Button variant="outline" isLoading={cancel.isPending} onClick={() => void onCancel()}>
              Withdraw
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </p>
      <p className="mt-1 text-sm font-medium text-text-heading">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

function Figure({
  label,
  value,
  emphasis = false,
  warn = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  warn?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </dt>
      <dd
        className={
          warn
            ? 'mt-1 text-lg font-semibold tabular-nums text-status-error'
            : emphasis
              ? 'mt-1 text-lg font-semibold tabular-nums text-brand-primary'
              : 'mt-1 text-lg font-semibold tabular-nums text-text-heading'
        }
      >
        {value}
      </dd>
    </div>
  );
}

export default function LeaveRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <ProtectedRoute
      requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER', 'EMPLOYEE']}
    >
      <LeaveRequestDetail id={id} />
    </ProtectedRoute>
  );
}
