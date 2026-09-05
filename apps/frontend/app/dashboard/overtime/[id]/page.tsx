'use client';

import { use, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Calendar, CheckCircle, Clock, XCircle } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { approvalKeys, useApprovalTrail } from '@/hooks/useApprovals';
import {
  useApproveOvertime,
  useCancelOvertime,
  useOvertimeRequest,
  useRejectOvertime,
} from '@/hooks/useOvertime';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/common/EmptyState';
import {
  OVERTIME_STATUS_TONE,
  formatOvertimeHours,
  formatWallClockRange,
  otTypeLabel,
  otTypeTone,
  overtimeStatusLabel,
} from '@/components/overtime/overtimeFormat';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly, formatDateTime } from '@/utils/formatDate';
import { formatCurrency } from '@/utils/formatters';
import type { ApprovalTrailStep } from '@/types/approval';
import type { OtType, Overtime } from '@/types/overtime';

const num = (value: number | string | null | undefined) => Number(value ?? 0) || 0;

interface Breakdown {
  totalHours: number;
  regularHours: number;
  lateHours: number;
  doubleHours: number;
  otType: OtType;
  foodAllowance: number;
  siteAllowance: number;
  /** The multipliers the server picked, where it sent them. */
  rates: { regular: number; late: number; double: number } | null;
  policyName: string | null;
}

/**
 * What this request is worth, in hours.
 *
 * The server's `preview` wins whenever it is there: it resolves the employee's
 * overtime policy and the branch's rest-day calendar, and it is what approval
 * will persist. Falling back to the row's own stored columns keeps a payload
 * without a preview readable — what it must never do is recompute the split
 * here, because the browser cannot see the policy and a figure that disagrees
 * with the payslip is worse than no figure.
 */
function breakdownOf(overtime: Overtime): Breakdown {
  const preview = overtime.preview ?? null;

  if (preview) {
    return {
      totalHours: num(preview.hours),
      regularHours: num(preview.regularHours),
      // A double day's post-threshold hours live in their own bucket with their
      // own multiplier; they are shown on the late row, so that row's rate
      // follows whichever bucket is filled.
      lateHours: num(preview.lateHours) + num(preview.doubleLateHours),
      doubleHours: num(preview.doubleHours),
      otType: preview.otType,
      foodAllowance: num(preview.foodAllowance),
      siteAllowance: num(preview.siteAllowance ?? overtime.siteAllowance),
      rates: {
        regular: preview.regularRate,
        late:
          num(preview.doubleLateHours) > 0 && num(preview.lateHours) === 0
            ? preview.doubleLateRate
            : preview.lateRate,
        double: preview.doubleRate,
      },
      policyName: preview.policyName,
    };
  }

  return {
    totalHours: num(overtime.hours),
    regularHours: num(overtime.regularHours),
    lateHours: num(overtime.lateHours),
    doubleHours: num(overtime.doubleHours),
    otType: overtime.otType ?? 'REGULAR',
    foodAllowance: num(overtime.foodAllowance),
    siteAllowance: num(overtime.siteAllowance),
    rates: null,
    policyName: null,
  };
}

/** The chain step, said the way an approver would say it. */
function stepLabel(step: ApprovalTrailStep): string {
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

const STEP_DOT: Record<string, string> = {
  APPROVED: 'bg-status-success',
  REJECTED: 'bg-status-error',
  ACTIVE: 'bg-status-warning',
};

function OvertimeDetail({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const currency = useBrandingStore((state) => state.branding.default_currency);
  const user = useAuthStore((state) => state.user);

  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const { data, isLoading, isError, error } = useOvertimeRequest(id);
  const trailQuery = useApprovalTrail('OVERTIME', id);
  const approve = useApproveOvertime();
  const reject = useRejectOvertime();
  const cancel = useCancelOvertime();

  const overtime = data?.data ?? null;
  const trail = trailQuery.data?.data ?? null;

  usePageHeader(
    'Overtime request',
    overtime ? `${formatDateOnly(overtime.date)} · ${overtime.employee?.fullName ?? ''}` : undefined,
  );

  const breakdown = useMemo(() => (overtime ? breakdownOf(overtime) : null), [overtime]);

  /**
   * A decision on the LIVE step, not a decision by a role.
   *
   * With a chain configured the eligible approver may be a supervisor or a
   * department manager, neither of whom carries an approver role — so the
   * engine answers this, and the role rule only stands in when no chain governs
   * the request.
   */
  const roleMayDecide = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';
  const canDecide =
    overtime?.status === 'PENDING' && (trail?.engaged ? trail.canAct : roleMayDecide);

  const ownEmployeeId = user?.employee?.id ?? user?.employeeId ?? undefined;
  const canWithdraw =
    overtime?.status === 'PENDING' && !!ownEmployeeId && overtime.employeeId === ownEmployeeId;

  /** A decision also clears a step from the approver's queue. */
  const refreshApprovals = () =>
    void queryClient.invalidateQueries({ queryKey: approvalKeys.all });

  const onApprove = async () => {
    try {
      const result = await approve.mutateAsync({ id });
      refreshApprovals();
      toast.success(
        result?.data?.status === 'APPROVED'
          ? 'Approved'
          : 'Your approval is recorded — the request moves to the next approver.',
      );
    } catch (err) {
      // The axios interceptor rejects with a FLAT object — there is no
      // `.response` to read through.
      toast.error(apiErrorMessage(err, 'Could not approve the request'));
    }
  };

  const onReject = async () => {
    const text = rejectReason.trim();
    if (!text) {
      toast.warning('Say why it is being rejected');
      return;
    }
    try {
      await reject.mutateAsync({ id, payload: { rejectedReason: text } });
      refreshApprovals();
      toast.success('Rejected');
      setRejecting(false);
      setRejectReason('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not reject the request'));
    }
  };

  const onWithdraw = async () => {
    try {
      await cancel.mutateAsync(id);
      refreshApprovals();
      toast.success('Claim withdrawn');
      router.push(user?.role === 'EMPLOYEE' ? '/dashboard/my-overtime' : '/dashboard/overtime');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not withdraw the claim'));
    }
  };

  if (isLoading) {
    return <p className="p-6 text-sm text-text-muted">Loading the request…</p>;
  }

  if (isError || !overtime || !breakdown) {
    return (
      <Card>
        <div data-testid="ot-not-found">
          <EmptyState
            title="This request is not available"
            description={apiErrorMessage(error, 'It may have been withdrawn already.')}
            action={
              <Button variant="outline" onClick={() => router.back()}>
                Go back
              </Button>
            }
          />
        </div>
      </Card>
    );
  }

  const tiers: Array<{ tier: string; label: string; hours: number; rate: number | null }> = [
    {
      tier: 'regular',
      label: 'Regular',
      hours: breakdown.regularHours,
      rate: breakdown.rates?.regular ?? null,
    },
    { tier: 'late', label: 'Late', hours: breakdown.lateHours, rate: breakdown.rates?.late ?? null },
    {
      tier: 'double',
      label: 'Double',
      hours: breakdown.doubleHours,
      rate: breakdown.rates?.double ?? null,
    },
  ].filter((entry) => entry.hours > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
          Back
        </Button>
        <span data-testid="overtime-status" data-status={overtime.status}>
          <Badge tone={OVERTIME_STATUS_TONE[overtime.status] ?? 'neutral'}>
            {overtimeStatusLabel(overtime.status)}
          </Badge>
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Who filed it" />
            <CardBody>
              <dl className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-sm text-text-muted">Name</dt>
                  <dd className="font-medium break-words text-text-heading">
                    {overtime.employee?.fullName ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-text-muted">Employee code</dt>
                  <dd className="font-medium text-text-heading">
                    {overtime.employee?.employeeCode ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-text-muted">Department</dt>
                  <dd className="font-medium text-text-heading">
                    {overtime.employee?.department?.name ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-text-muted">Email</dt>
                  <dd className="font-medium break-words text-text-heading">
                    {overtime.employee?.email ?? '—'}
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="The claim" />
            <CardBody className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary/10 text-brand-primary">
                    <Calendar className="h-4 w-4" aria-hidden />
                  </span>
                  <div>
                    <p className="text-sm text-text-muted">Day</p>
                    <p className="font-medium text-text-heading">
                      {formatDateOnly(overtime.date)}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary/10 text-brand-primary">
                    <Clock className="h-4 w-4" aria-hidden />
                  </span>
                  <div>
                    <p className="text-sm text-text-muted">Window</p>
                    <p className="font-medium tabular-nums text-text-heading">
                      {formatWallClockRange(overtime.startTime, overtime.endTime)}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary/10 text-brand-primary">
                    <Clock className="h-4 w-4" aria-hidden />
                  </span>
                  <div>
                    <p className="text-sm text-text-muted">Hours</p>
                    <p className="font-medium tabular-nums text-text-heading">
                      {formatOvertimeHours(breakdown.totalHours)}
                    </p>
                  </div>
                </div>
              </div>

              <div
                data-testid="ot-breakdown"
                data-ot-type={breakdown.otType}
                data-total-hours={breakdown.totalHours}
                data-food-allowance={breakdown.foodAllowance}
                className="rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-text-heading">How it is priced</p>
                  <Badge tone={otTypeTone(breakdown.otType)}>
                    {otTypeLabel(breakdown.otType)}
                  </Badge>
                </div>

                <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  {tiers.map((entry) => (
                    <div key={entry.tier}>
                      <p className="text-text-muted">
                        {entry.label}
                        {entry.rate !== null ? ` · ×${entry.rate}` : ''}
                      </p>
                      <p
                        data-testid="ot-breakdown-tier"
                        data-tier={entry.tier}
                        data-hours={entry.hours}
                        className="mt-0.5 font-semibold tabular-nums text-text-heading"
                      >
                        {formatOvertimeHours(entry.hours)}
                      </p>
                    </div>
                  ))}

                  <div>
                    <p className="text-text-muted">Food allowance</p>
                    <p
                      className={`mt-0.5 font-semibold tabular-nums ${
                        breakdown.foodAllowance > 0 ? 'text-status-success' : 'text-text-muted'
                      }`}
                    >
                      {breakdown.foodAllowance > 0
                        ? formatCurrency(breakdown.foodAllowance, currency)
                        : '—'}
                    </p>
                  </div>

                  {breakdown.siteAllowance > 0 && (
                    <div>
                      <p className="text-text-muted">Site allowance</p>
                      <p className="mt-0.5 font-semibold tabular-nums text-status-success">
                        {formatCurrency(breakdown.siteAllowance, currency)}
                      </p>
                      {overtime.siteAllowanceNote && (
                        <p className="mt-0.5 text-xs text-text-muted">
                          {overtime.siteAllowanceNote}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <p className="mt-3 border-t border-surface-border-light pt-3 text-xs text-text-muted">
                  {breakdown.policyName
                    ? `Priced under “${breakdown.policyName}”. Settled on approval.`
                    : 'The rate is settled on approval, under the policy that governs this employee.'}
                </p>
              </div>

              <div className="border-t border-surface-border-light pt-4">
                <p className="text-sm text-text-muted">Why</p>
                <p className="mt-1 whitespace-pre-wrap text-text-body">{overtime.reason}</p>
              </div>
            </CardBody>
          </Card>

          {overtime.status === 'REJECTED' && overtime.rejectedReason && (
            <Card className="border-status-error/30">
              <CardHeader title="Why it was rejected" />
              <CardBody>
                <p
                  data-testid="ot-rejection-reason"
                  className="whitespace-pre-wrap text-sm text-status-error"
                >
                  {overtime.rejectedReason}
                </p>
              </CardBody>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          {canDecide && (
            <Card className="space-y-2 p-4">
              <Button
                className="w-full"
                data-testid="overtime-approve"
                isLoading={approve.isPending}
                onClick={() => void onApprove()}
              >
                <CheckCircle className="h-4 w-4" aria-hidden />
                Approve
              </Button>
              <Button
                className="w-full"
                variant="danger"
                data-testid="overtime-reject-open"
                onClick={() => setRejecting(true)}
              >
                <XCircle className="h-4 w-4" aria-hidden />
                Reject
              </Button>
            </Card>
          )}

          {canWithdraw && (
            <Button
              className="w-full"
              variant="outline"
              data-testid="overtime-cancel"
              onClick={() => setConfirmingCancel(true)}
            >
              Withdraw this claim
            </Button>
          )}

          <Card>
            <CardHeader title="History" />
            <CardBody className="space-y-4">
              <div className="flex gap-3">
                <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand-primary" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-text-heading">Filed</p>
                  <p className="text-xs text-text-muted">{formatDateTime(overtime.createdAt)}</p>
                </div>
              </div>

              {/* The chain, step by step. Without it a multi-step request just
                  reads "Pending" with no clue whose desk it is on. */}
              {trail?.engaged && (
                <div
                  data-testid="ot-trail"
                  data-engaged={trail.engaged}
                  data-can-act={trail.canAct}
                  data-active-step={trail.activeStep ?? ''}
                  className="contents"
                />
              )}

              {trail?.engaged &&
                trail.steps.map((step) => (
                  <div
                    key={step.id}
                    data-testid="ot-trail-step"
                    data-step-order={step.stepOrder}
                    data-approver-type={step.approverType}
                    data-step-status={step.status}
                    className="flex gap-3"
                  >
                    <span
                      aria-hidden
                      className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                        STEP_DOT[step.status] ?? 'bg-surface-border'
                      }`}
                    />
                    <div>
                      <p className="text-sm font-medium text-text-heading">
                        {step.stepOrder}. {approverLabel(step.approverType)} — {stepLabel(step)}
                      </p>
                      {step.decidedAt && (
                        <p className="text-xs text-text-muted">{formatDateTime(step.decidedAt)}</p>
                      )}
                      {step.comment && (
                        <p className="text-xs italic text-text-muted">{step.comment}</p>
                      )}
                    </div>
                  </div>
                ))}

              {overtime.approvedAt && (
                <div className="flex gap-3">
                  <span
                    aria-hidden
                    className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                      overtime.status === 'APPROVED' ? 'bg-status-success' : 'bg-status-error'
                    }`}
                  />
                  <div>
                    <p className="text-sm font-medium text-text-heading">
                      {overtimeStatusLabel(overtime.status)}
                    </p>
                    <p className="text-xs text-text-muted">
                      {formatDateTime(overtime.approvedAt)}
                    </p>
                  </div>
                </div>
              )}

              {trail?.engaged && overtime.status === 'PENDING' && trail.activeStep && !trail.canAct && (
                <p
                  data-testid="ot-trail-waiting"
                  className="border-t border-surface-border-light pt-3 text-xs text-text-muted"
                >
                  Waiting on step {trail.activeStep}. You are not the approver for it.
                </p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md p-5">
            <h2 className="text-base font-semibold text-text-heading">Reject this claim</h2>
            <p className="mt-0.5 text-sm text-text-muted">
              {overtime.employee?.fullName ?? 'The employee'} will see this reason.
            </p>
            <div className="mt-4 space-y-3">
              <Textarea
                label="Why"
                data-testid="overtime-reject-reason"
                rows={4}
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder="The hours are already covered by the shift roster"
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setRejecting(false);
                    setRejectReason('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  data-testid="overtime-reject-confirm"
                  isLoading={reject.isPending}
                  disabled={!rejectReason.trim()}
                  onClick={() => void onReject()}
                >
                  Confirm rejection
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {confirmingCancel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-sm p-5">
            <h2 className="text-base font-semibold text-text-heading">Withdraw this claim?</h2>
            <p className="mt-1 text-sm text-text-muted">
              It disappears from the approver’s queue. You can file it again.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmingCancel(false)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                data-testid="overtime-cancel-confirm"
                isLoading={cancel.isPending}
                onClick={() => void onWithdraw()}
              >
                Withdraw
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function OvertimeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    // Ungated by role: an employee reaches this page for their own claim, and
    // the server refuses the row to anyone not entitled to it.
    <ProtectedRoute>
      <OvertimeDetail id={id} />
    </ProtectedRoute>
  );
}
