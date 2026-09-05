'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  Ban,
  BadgeCheck,
  Calculator,
  Download,
  Info,
  Undo2,
  Wallet,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PayrollRunTable from '@/components/payroll/PayrollRunTable';
import RunSummaryCards from '@/components/payroll/RunSummaryCards';
import RunStatusBadge from '@/components/payroll/RunStatusBadge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Textarea';
import {
  useApprovePayrollRun,
  useCalculatePayrollRun,
  useCancelPayrollRun,
  useExportPayrollRun,
  useMarkPayrollRunPaid,
  usePayrollRun,
  useRejectPayrollRun,
} from '@/hooks/usePayrollRuns';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDate, formatDateOnly } from '@/utils/formatDate';
import { runTotals } from '@/utils/payrollTotals';
import { hasPermission } from '@/utils/permissions';

/** The server's own filename, when it sent one. */
function filenameFrom(disposition: unknown, fallback: string): string {
  if (typeof disposition !== 'string') return fallback;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
}

function RejectDialog({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="reject-run-title"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-[var(--radius-card)] bg-surface-overlay p-6 shadow-2xl">
        <h2 id="reject-run-title" className="text-lg font-semibold text-text-heading">
          Send this run back?
        </h2>
        <p className="mt-3 text-sm text-text-body">
          The run returns to draft and its payslips are discarded on the next
          calculation. The reason stays on the run, so whoever picks it up reads
          what was wrong.
        </p>

        <div className="mt-4">
          <Textarea
            label="Reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="What has to change before this can be approved."
            data-testid="reject-reason"
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            // The server 400s without one, so the button refuses rather than
            // sending a request that can only fail.
            disabled={!reason.trim()}
            isLoading={busy}
            onClick={() => onConfirm(reason.trim())}
            data-testid="reject-confirm"
          >
            Send back
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * One payroll run.
 *
 * Every action is gated TWICE, and the two gates answer different questions:
 * the STATUS decides whether the action makes sense at all — a paid run cannot
 * be approved — and the PERMISSION decides whether this reader may ask. A
 * payroll officer holds `MANAGE_PAYROLL` and not `APPROVE_PAYROLL`, so they
 * calculate and cancel but never approve. That separation is enforced by the
 * server's `@Roles` too; hiding the button is an affordance, not the boundary.
 */
function PayrollRunDetailView({ id }: { id: string }) {
  const role = useAuthStore((state) => state.user?.role);
  const { data, isLoading, isError } = usePayrollRun(id);
  const run = data?.data;

  const calculate = useCalculatePayrollRun();
  const approve = useApprovePayrollRun();
  const reject = useRejectPayrollRun();
  const markPaid = useMarkPayrollRunPaid();
  const cancel = useCancelPayrollRun();
  const exportRun = useExportPayrollRun();

  const [rejecting, setRejecting] = useState(false);

  usePageHeader(
    run ? `Payroll run — ${formatDateOnly(run.periodStart)}` : 'Payroll run',
    run
      ? `${formatDateOnly(run.periodStart)} – ${formatDateOnly(run.periodEnd)} · ${
          run.employeeCount
        } employee${run.employeeCount === 1 ? '' : 's'}`
      : undefined,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading the run…</Card>;
  }

  if (isError || !run) {
    return (
      <Card className="p-6 text-sm text-status-error">
        This run could not be loaded. It may have been cancelled, or the API is not reachable.
      </Card>
    );
  }

  const payslips = run.payslips ?? [];
  // ONE pass over the run: the cards and the table below read the SAME totals,
  // so a figure on a card can never contradict the rows it is a total of.
  const totals = runTotals(payslips);

  const canManage = hasPermission(role, 'MANAGE_PAYROLL');
  const canApprove = hasPermission(role, 'APPROVE_PAYROLL');
  const canExport = hasPermission(role, 'EXPORT_DATA');

  const busy =
    calculate.isPending ||
    approve.isPending ||
    reject.isPending ||
    markPaid.isPending ||
    cancel.isPending;

  /**
   * One lifecycle move, reported the same way whichever it was.
   *
   * The message comes off the FLAT object the axios interceptor rejects with —
   * `err.response.data.message` is undefined on it, and reaching for that is how
   * a precise "this run has already been approved" turns into a generic
   * failure the reader cannot act on.
   */
  const act = async (
    perform: () => Promise<unknown>,
    success: string,
    failure: string,
  ) => {
    try {
      await perform();
      toast.success(success);
    } catch (error) {
      toast.error(apiErrorMessage(error, failure));
    }
  };

  const handleExport = async () => {
    try {
      // The interceptor hands a blob response back UNTOUCHED — the file is
      // `res.data`, not `res.data.data`.
      const response = await exportRun.mutateAsync(id);
      const name = filenameFrom(
        response.headers?.['content-disposition'],
        `payroll-run-${run.periodStart.slice(0, 10)}.xlsx`,
      );
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The export could not be written'));
    }
  };

  const cancellable = run.status !== 'PAID' && run.status !== 'CANCELLED';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <RunStatusBadge status={run.status} />
        <span className="text-sm text-text-muted">
          {run.calculatedAt ? `Calculated ${formatDate(run.calculatedAt)}` : 'Not calculated yet'}
          {run.approvedAt ? ` · Approved ${formatDate(run.approvedAt)}` : ''}
          {run.paidAt ? ` · Paid ${formatDate(run.paidAt)}` : ''}
        </span>

        <div className="ms-auto flex flex-wrap items-center gap-2">
          {canManage && (run.status === 'DRAFT' || run.status === 'CALCULATED') && (
            <Button
              variant="outline"
              isLoading={calculate.isPending}
              disabled={busy && !calculate.isPending}
              onClick={() =>
                void act(
                  () => calculate.mutateAsync(id),
                  'The payslips were rebuilt.',
                  'The run could not be calculated',
                )
              }
              data-testid="run-calculate"
            >
              <Calculator className="h-4 w-4" aria-hidden />
              {run.status === 'DRAFT' ? 'Calculate' : 'Recalculate'}
            </Button>
          )}

          {/* A payroll officer holds MANAGE_PAYROLL and not APPROVE_PAYROLL:
              the person who calculates a run must not be the one who releases
              it. The server refuses them too. */}
          {canApprove && run.status === 'CALCULATED' && (
            <>
              <Button
                isLoading={approve.isPending}
                disabled={busy && !approve.isPending}
                onClick={() =>
                  void act(
                    () => approve.mutateAsync(id),
                    'The run was approved.',
                    'The run could not be approved',
                  )
                }
                data-testid="run-approve"
              >
                <BadgeCheck className="h-4 w-4" aria-hidden />
                Approve
              </Button>
              <Button
                variant="outline"
                onClick={() => setRejecting(true)}
                disabled={busy}
                data-testid="run-reject"
              >
                <Undo2 className="h-4 w-4 rtl:rotate-180" aria-hidden />
                Reject
              </Button>
            </>
          )}

          {canApprove && run.status === 'APPROVED' && (
            <Button
              isLoading={markPaid.isPending}
              disabled={busy && !markPaid.isPending}
              onClick={() =>
                void act(
                  () => markPaid.mutateAsync(id),
                  'The run was marked paid.',
                  'The run could not be marked paid',
                )
              }
              data-testid="run-mark-paid"
            >
              <Wallet className="h-4 w-4" aria-hidden />
              Mark paid
            </Button>
          )}

          {canManage && cancellable && (
            <Button
              variant="outline"
              isLoading={cancel.isPending}
              disabled={busy && !cancel.isPending}
              onClick={() =>
                void act(
                  () => cancel.mutateAsync(id),
                  'The run was cancelled.',
                  'The run could not be cancelled',
                )
              }
              data-testid="run-cancel"
            >
              <Ban className="h-4 w-4" aria-hidden />
              Cancel
            </Button>
          )}

          {canExport && (
            <Button
              variant="outline"
              isLoading={exportRun.isPending}
              onClick={() => void handleExport()}
              data-testid="run-export"
            >
              <Download className="h-4 w-4" aria-hidden />
              Export
            </Button>
          )}
        </div>
      </div>

      {/* The reason survives the return to DRAFT, so the next attempt can read
          what was wrong rather than guessing at it. */}
      {run.rejectionReason && (
        <div
          data-testid="run-rejection-reason"
          className="flex items-start gap-2 rounded-[var(--radius-card)] bg-status-error-bg p-4 text-sm text-status-error"
        >
          <Info size={18} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">Sent back for correction. </span>
            {run.rejectionReason}
          </span>
        </div>
      )}

      {run.notes && (
        <Card>
          <CardHeader title="Notes" />
          <CardBody className="text-sm leading-relaxed text-text-body">{run.notes}</CardBody>
        </Card>
      )}

      <RunSummaryCards
        totals={totals}
        currency={run.currency}
        storedGross={run.totalGross}
        storedNet={run.totalNet}
        runId={run.id}
      />

      <PayrollRunTable payslips={payslips} currency={run.currency} />

      {rejecting && (
        <RejectDialog
          busy={reject.isPending}
          onCancel={() => setRejecting(false)}
          onConfirm={(reason) =>
            void act(
              async () => {
                await reject.mutateAsync({ id, payload: { reason } });
                setRejecting(false);
              },
              'The run was sent back.',
              'The run could not be sent back',
            )
          }
        />
      )}
    </div>
  );
}

export default function PayrollRunDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      <PayrollRunDetailView id={id} />
    </ProtectedRoute>
  );
}
