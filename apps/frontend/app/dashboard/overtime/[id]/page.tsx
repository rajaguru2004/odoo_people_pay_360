'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Check, X } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  useApproveOvertime,
  useCancelOvertime,
  useOvertimeRequest,
  usePreviewOvertimeEdit,
  useRejectOvertime,
} from '@/hooks/useOvertime';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly, formatDateTime } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import {
  formatHours,
  formatOvertimeWindow,
  overtimeTimeOfDay,
  toOvertimeInstant,
} from '@/utils/overtimeCalc';
import { tierRows } from '@/utils/overtimeCalc';
import {
  DAY_TYPE_LABEL,
  DAY_TYPE_TONE,
  OT_TYPE_LABEL,
  STATUS_TONE,
  formatMultiplier,
  statusLabel,
} from '@/components/leave/leaveFormat';
import type { OvertimePreview } from '@/types/overtime';

/**
 * One overtime request, and the decision on it.
 *
 * The breakdown on this page is the SERVER'S, never a client recompute. It
 * depends on the employee's overtime policy and on the branch-aware day
 * classification, and a page that derived it from the global settings would show
 * REGULAR where the server said LATE — on the screen that decides the money.
 *
 * A pending request previews what approval WILL persist. A decided one shows the
 * frozen figures, monetized by the policy snapshot the row carries.
 */
function OvertimeDetail({ id }: { id: string }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const ownEmployeeId = user?.employee?.id ?? user?.employeeId ?? undefined;

  const { data, isLoading, isError, error } = useOvertimeRequest(id);
  const request = data?.data;

  const approve = useApproveOvertime();
  const reject = useRejectOvertime();
  const cancel = useCancelOvertime();
  const previewEdit = usePreviewOvertimeEdit();

  const [editing, setEditing] = useState(false);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [approverNote, setApproverNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [corrected, setCorrected] = useState<OvertimePreview | null>(null);

  /**
   * Open the correction fields, seeded from what was actually filed.
   *
   * Seeded HERE rather than in an effect on `request`: an effect would overwrite
   * a half-typed correction every time the query refetched in the background,
   * and the approver would watch their own edit disappear.
   *
   * The times are read in UTC. They are wall clocks tagged UTC, so reading them
   * in the browser's zone would put a different hour in the box than the
   * employee typed.
   */
  const startEditing = () => {
    if (!request) return;
    setStartTime(overtimeTimeOfDay(request.startTime));
    setEndTime(overtimeTimeOfDay(request.endTime));
    setCorrected(null);
    setEditing(true);
  };

  usePageHeader(
    request ? 'Overtime request' : 'Overtime',
    request?.employee ? fullName(request.employee) : undefined,
  );

  const isOwn = Boolean(
    ownEmployeeId && request && request.employeeId === ownEmployeeId,
  );
  const canDecide =
    Boolean(request) && request!.status === 'PENDING' && !isOwn;

  const runPreview = async () => {
    if (!request) return;
    const start = toOvertimeInstant(request.date.slice(0, 10), startTime);
    const end = toOvertimeInstant(request.date.slice(0, 10), endTime);
    if (!start || !end) {
      toast.error('The corrected times could not be read.');
      return;
    }
    try {
      const result = await previewEdit.mutateAsync({
        id,
        payload: { startTime: start, endTime: end },
      });
      setCorrected(result.data);
    } catch (err) {
      setCorrected(null);
      toast.error(apiErrorMessage(err, 'The correction was refused.'));
    }
  };

  const onApprove = async () => {
    if (!request) return;
    try {
      const payload = editing
        ? {
            startTime: toOvertimeInstant(request.date.slice(0, 10), startTime) ?? undefined,
            endTime: toOvertimeInstant(request.date.slice(0, 10), endTime) ?? undefined,
            approverNote: approverNote.trim() || undefined,
            // Sent back so a second approver holding this request open is
            // refused with a 409 rather than silently overwriting the first.
            expectedUpdatedAt: request.updatedAt,
          }
        : undefined;
      await approve.mutateAsync({ id, payload });
      toast.success('Overtime approved.');
      setEditing(false);
      setCorrected(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The request could not be approved.'));
    }
  };

  const onReject = async () => {
    try {
      await reject.mutateAsync({ id, reason: rejectReason.trim() });
      toast.success('Overtime rejected.');
      setRejecting(false);
      setRejectReason('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The request could not be rejected.'));
    }
  };

  const onCancel = async () => {
    try {
      await cancel.mutateAsync(id);
      toast.success('Request withdrawn.');
      router.push('/dashboard/my-overtime');
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
          {apiErrorMessage(error, 'This overtime request could not be loaded.')}
        </p>
      </Card>
    );
  }

  const shown = corrected ?? request.preview;

  return (
    <div className="max-w-4xl space-y-5">
      <Link
        href="/dashboard/overtime"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-brand-primary"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
        All overtime
      </Link>

      <Card>
        <CardHeader
          title={formatDateOnly(request.date)}
          subtitle={
            request.employee
              ? `${fullName(request.employee)} · ${request.employee.employeeCode}`
              : undefined
          }
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[request.status]}>
                {statusLabel(request.status)}
              </Badge>
              <Badge tone={DAY_TYPE_TONE[request.dayType]}>
                {DAY_TYPE_LABEL[request.dayType]}
              </Badge>
            </div>
          }
        />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Worked"
            value={formatOvertimeWindow(request.startTime, request.endTime)}
          />
          <Field
            label="Payable"
            value={formatHours(request.hours)}
            hint="After the attendance day boundary."
          />
          <Field label="Tier" value={OT_TYPE_LABEL[request.otType]} />
          <Field
            label="Policy"
            value={request.overtimePolicy?.name ?? 'Company settings'}
            hint={
              request.status === 'PENDING'
                ? 'Re-resolved at approval.'
                : 'The rules that classified these hours.'
            }
          />

          {request.originalStartTime && (
            <div className="sm:col-span-2 rounded-[var(--radius-card)] bg-surface-page p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                As filed by the employee
              </p>
              <p className="mt-1 text-sm text-text-body">
                {/* Kept because the approver rewrote the times: without it, what
                    the employee actually claimed exists nowhere. */}
                {formatOvertimeWindow(request.originalStartTime, request.originalEndTime)}
                {request.editedAt ? ` · corrected ${formatDateTime(request.editedAt)}` : ''}
              </p>
              {request.approverNote && (
                <p className="mt-1 text-sm text-text-muted">{request.approverNote}</p>
              )}
            </div>
          )}

          <div className="sm:col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Reason
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-text-body">
              {request.reason || '—'}
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
          title={corrected ? 'With your correction' : 'How it is paid'}
          subtitle={
            request.status === 'PENDING'
              ? 'What approving this will persist, under the rules in force now.'
              : 'The frozen figures, priced by the policy this request carries.'
          }
        />
        <CardBody>
          {!shown ? (
            <p className="text-sm text-text-muted">
              {/* Degraded rather than absent: the request is still readable. */}
              The breakdown could not be resolved for this request.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-surface-border-light">
                      <th scope="col" className="px-3 py-2 text-start text-[11px] font-semibold uppercase tracking-wider text-text-muted">Tier</th>
                      <th scope="col" className="px-3 py-2 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted">Hours</th>
                      <th scope="col" className="px-3 py-2 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tierRows(shown).map((row) => (
                      <tr key={row.key} className="border-b border-surface-border-light last:border-0">
                        <td className="px-3 py-2 text-text-body">{row.label}</td>
                        <td className="px-3 py-2 text-end font-medium tabular-nums text-text-heading">
                          {formatHours(row.hours)}
                        </td>
                        <td className="px-3 py-2 text-end tabular-nums text-text-muted">
                          {formatMultiplier(row.rate)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="px-3 py-2 font-semibold text-text-heading">Total</td>
                      <td className="px-3 py-2 text-end font-semibold tabular-nums text-text-heading">
                        {formatHours(shown.hours)}
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-surface-border-light pt-4 sm:grid-cols-3">
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Food allowance
                  </dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-text-heading">
                    {shown.foodAllowance}
                    {shown.foodAllowanceOverride !== null && (
                      <span className="ms-2 text-xs font-normal text-text-muted">
                        {/* Null is "nobody touched it"; a value, 0 included, is
                            a decision the approval must honour. */}
                        set by the approver
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Site allowance
                  </dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-text-heading">
                    {shown.siteAllowance}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Policy
                  </dt>
                  <dd className="mt-1 text-sm font-semibold text-text-heading">
                    {shown.policyName ?? 'Company settings'}
                  </dd>
                </div>
              </dl>
            </>
          )}
        </CardBody>
      </Card>

      {canDecide && (
        <Card>
          <CardHeader
            title="Decide"
            subtitle="Correcting the window re-prices the request before it is approved."
          />
          <CardBody className="space-y-4">
            {editing && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  type="time"
                  label="Corrected start"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
                <Input
                  type="time"
                  label="Corrected finish"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    isLoading={previewEdit.isPending}
                    onClick={() => void runPreview()}
                  >
                    Check the figures
                  </Button>
                </div>
                <div className="sm:col-span-3">
                  <Textarea
                    label="Why the change"
                    rows={2}
                    value={approverNote}
                    onChange={(e) => setApproverNote(e.target.value)}
                    placeholder="Employee wrote 22:00; the gate log shows 23:00."
                  />
                </div>
              </div>
            )}

            {rejecting && (
              <Textarea
                label="Why it is being rejected"
                rows={2}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Paperwork is part of the working day, not overtime."
              />
            )}

            <div className="flex flex-wrap items-center gap-2">
              {rejecting ? (
                <>
                  <Button
                    variant="danger"
                    disabled={rejectReason.trim().length < 3}
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
                    {editing ? 'Approve with the correction' : 'Approve'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (editing) {
                        setEditing(false);
                        setCorrected(null);
                      } else {
                        startEditing();
                      }
                    }}
                  >
                    {editing ? 'Approve as filed instead' : 'Correct the times'}
                  </Button>
                  <Button variant="ghost" onClick={() => setRejecting(true)}>
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
              You logged this. It can be withdrawn until somebody decides it.
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
      <p className="mt-1 text-sm font-medium tabular-nums text-text-heading">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-muted">{hint}</p>}
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
    <ProtectedRoute
      requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER', 'EMPLOYEE']}
    >
      <OvertimeDetail id={id} />
    </ProtectedRoute>
  );
}
