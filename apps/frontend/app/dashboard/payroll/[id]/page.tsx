'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, Lock, Edit, Save, X, Info, SendHorizontal, GitBranch } from 'lucide-react';
import { useTranslations } from 'next-intl';
import payrollService from '@/services/payrollService';
import { Payroll, PayrollItem } from '@/types/payroll';
import { formatCurrency } from '@/utils/formatters';
import { useAuthStore } from '@/store/authStore';
import { isDailyWage } from '@/utils/payBasis';
import { usePayrollLabels } from '@/hooks/usePayrollLabels';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import PayrollRunTable, { buildRunRows, runTotals } from '@/components/payroll/PayrollRunTable';
import RunSummaryCards from '@/components/payroll/RunSummaryCards';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { useConfirm } from '@/hooks/useConfirm';
import { toast } from '@/lib/toast';
import { apiErrorMessage } from '@/utils/apiError';

function PayrollDetailPageContent({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  // Native confirm/alert/prompt cannot be styled, cannot validate, and are
  // dismissed by the browser rather than by the page — which also made every
  // outcome invisible to a browser test. The revision reason in particular is
  // required by the server, so it needs a real field.
  const { confirm, ConfirmDialog, closeModal } = useConfirm();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionReason, setRevisionReason] = useState('');
  const [revisionBusy, setRevisionBusy] = useState(false);
  const { id } = use(params);
  const { user } = useAuthStore();
  const t = useTranslations('payrollDetailPage');
  const tc = useTranslations('common');
  const [payroll, setPayroll] = useState<Payroll | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<any>({});
  // One reader for the statutory names, shared with the hub and the payslip
  // list. The country switch used to be written out by hand on five screens.
  const statutory = usePayrollLabels();
  const labels = {
    pf: statutory.pf,
    tax: statutory.tax,
    netSalary: t('netSalaryLabel'),
  };

  const isHR = user?.role && ['ADMIN', 'HR_MANAGER'].includes(user.role);

  // Exclude employees with no configured salary structure (base salary 0) from
  // the payroll list and its summary totals — they should not be processed.
  // Daily-wage staff are exempt from that filter: their earned basic is
  // legitimately 0 when they were absent all period, and hiding them would drop
  // them from the run AND from the headcount above.
  // Computed above the early-return because the header subtitle counts it too,
  // and the count in the header must be the count in the table.
  const visibleItems =
    payroll?.items?.filter(
      (item) => Number(item.baseSalary) > 0 || isDailyWage(item.employee?.salaryType),
    ) ?? [];

  // The one heading for this route, rendered by TopHeader — and the record
  // crumb PageBreadcrumbs appends to the derived trail, which is the only way
  // this screen can say WHICH run you are looking at. Declared above the
  // loading/not-found early-return so the hook order never changes, with a
  // fallback while the record loads: TopHeader's `??` is nullish-only, so an
  // empty string would paint a blank header rather than fall back.
  usePageHeader(
    payroll ? t('title', { month: payroll.month, year: payroll.year }) : t('titleFallback'),
    payroll
      ? t('staffAndAmount', {
          count: visibleItems.length,
          amount: formatCurrency(Number(payroll.totalAmount)),
        })
      : undefined,
  );

  useEffect(() => {
    fetchPayroll();
  }, [id]);

  const fetchPayroll = async () => {
    try {
      setLoading(true);
      const response = await payrollService.getById(id);
      setPayroll(response.data);
    } catch (error) {
      console.error('Failed to fetch payroll:', error);
      toast.error(t('notFound'));
      router.push('/dashboard/payroll/manage');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (item: PayrollItem) => {
    setEditingItem(item.id);
    setEditValues({
      allowances: Number(item.allowances),
      bonus: Number(item.bonus),
      deduction: Number(item.deduction),
      overtimeHours: Number(item.overtimeHours),
      foodAllowance: Number(item.foodAllowance || 0),
      notes: item.notes || '',
    });
  };

  const handleSave = async (itemId: string) => {
    try {
      await payrollService.updateItem(id, itemId, editValues);
      toast.success(t('updateSuccess'));
      setEditingItem(null);
      fetchPayroll();
    } catch (error: any) {
      console.error('Failed to update item:', error);
      toast.error(apiErrorMessage(error, t('updateFailedFallback')));
    }
  };

  // The lifecycle is DRAFT -> submit -> PENDING_APPROVAL -> approve -> APPROVED
  // -> lock -> LOCKED. Only `lock` marks the salaries final, so skipping straight
  // to it (as the old single "finalize" button did from DRAFT) produced a payroll
  // that read as final but had never been approved. Approval happens on the
  // Payroll approvals screen.
  const handleSubmit = async () => {
    const ok = await confirm({
      title: t('submitConfirmMessage'),
      message: t('submitConfirmMessage'),
      type: 'info',
    });
    if (!ok) return;

    try {
      await payrollService.submit(id);
      toast.success(t('submitSuccess'));
      fetchPayroll();
    } catch (error: any) {
      console.error('Failed to submit for approval:', error);
      toast.error(apiErrorMessage(error, t('submitFailedFallback')));
    }
  };

  const handleLock = async () => {
    const ok = await confirm({
      title: t('lockConfirmMessage'),
      message: t('lockConfirmMessage'),
      type: 'warning',
    });
    if (!ok) return;

    try {
      await payrollService.lock(id);
      toast.success(t('lockSuccess'));
      fetchPayroll();
    } catch (error: any) {
      console.error('Failed to lock:', error);
      toast.error(apiErrorMessage(error, t('lockFailedFallback')));
    }
  };

  /**
   * A LOCKED payroll cannot be edited, re-approved or re-locked — so a revision is
   * the only way to correct one. That matters for runs finalised by the old code
   * path without approval: they are otherwise stuck. The new version is a DRAFT
   * at version+1 that copies the amounts but no ledger rows, so it can never
   * double-pay.
   */
  const handleCreateRevision = async () => {
    if (!revisionReason.trim()) {
      toast.error(t('revisionReasonRequired'));
      return;
    }
    setRevisionBusy(true);
    try {
      const res = await payrollService.createRevision(id, revisionReason.trim());
      const newId = (res as { data?: { id?: string } })?.data?.id;
      toast.success(t('revisionSuccess'));
      setRevisionOpen(false);
      setRevisionReason('');
      if (newId) router.push(`/dashboard/payroll/${newId}`);
      else fetchPayroll();
    } catch (error: unknown) {
      toast.error(apiErrorMessage(error, t('revisionFailedFallback')));
    } finally {
      setRevisionBusy(false);
    }
  };

  if (loading || !payroll) {
    return (
      <>
        <div className="flex items-center justify-center h-96">
          <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      </>
    );
  }

  const canEdit = Boolean(isHR) && payroll.status === 'DRAFT';

  // One pass over the run: the cards, the table and the exception filter all
  // read the SAME arithmetic, so a figure on a card can never contradict the
  // rows it is a total of.
  const rows = buildRunRows(visibleItems);
  const totals = runTotals(rows);

  return (
    <>
      <div className="space-y-6">
        {/* Back + the run's own actions. The title and the staff/amount line
            live in the sticky TopHeader (declared via usePageHeader above), and
            the breadcrumb trail above them names WHICH run — repeating either
            here is the duplicate-heading defect. */}
        <PageActionRow
          onBack={() => router.back()}
          action={
            <div className="flex gap-2" data-testid="payroll-detail-status" data-status={payroll.status}>
              {payroll.status === 'DRAFT' && (
                <span className="px-4 py-2 bg-surface-page text-text-muted rounded-[--radius-badge] font-semibold">
                  {tc('draft')}
                </span>
              )}
              {payroll.status === 'PENDING_APPROVAL' && (
                <span className="px-4 py-2 bg-status-warning-bg text-status-warning rounded-[--radius-badge] font-semibold">
                  {tc('pending')}
                </span>
              )}
              {payroll.status === 'APPROVED' && (
                <span className="px-4 py-2 bg-status-info-bg text-status-info rounded-[--radius-badge] font-semibold">
                  {tc('approved')}
                </span>
              )}
              {payroll.status === 'REJECTED' && (
                <span className="px-4 py-2 bg-status-error-bg text-status-error rounded-[--radius-badge] font-semibold">
                  {tc('rejected')}
                </span>
              )}
              {payroll.status === 'LOCKED' && (
                <span className="px-4 py-2 bg-status-success-bg text-status-success rounded-[--radius-badge] font-semibold">
                  {tc('locked')}
                </span>
              )}
              {isHR && (payroll.status === 'DRAFT' || payroll.status === 'REJECTED') && (
                <button
                  data-testid="payroll-detail-submit"
                  onClick={handleSubmit}
                  className="flex items-center gap-2 px-4 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] font-semibold hover:shadow-lg transition-all"
                >
                  <SendHorizontal size={18} />
                  {t('submitBtn')}
                </button>
              )}
              {isHR && payroll.status === 'APPROVED' && (
                <button
                  data-testid="payroll-detail-lock"
                  onClick={handleLock}
                  className="flex items-center gap-2 px-4 py-2 bg-status-success text-text-on-brand rounded-[--radius-button] font-semibold hover:shadow-lg transition-all"
                >
                  <Lock size={18} />
                  {t('lockBtn')}
                </button>
              )}
              {/* The only way to correct a LOCKED run — and the only escape for one
                  finalised without approval by the old code path. */}
              {isHR && payroll.status === 'LOCKED' && (
                <button
                  data-testid="payroll-detail-revision"
                  onClick={() => { setRevisionReason(''); setRevisionOpen(true); }}
                  className="flex items-center gap-2 px-4 py-2 border-2 border-surface-border text-text-body rounded-[--radius-button] font-semibold hover:bg-surface-page transition-all"
                >
                  <GitBranch size={18} />
                  {t('revisionBtn')}
                </button>
              )}
            </div>
          }
        />

        {/* Where the next action lives, since approval happens on another screen. */}
        {isHR && payroll.status === 'PENDING_APPROVAL' && (
          <div className="flex items-start gap-2 p-4 bg-status-warning-bg text-status-warning rounded-[--radius-card]">
            <Info size={18} className="mt-0.5 shrink-0" />
            <p className="text-sm">{t('awaitingApprovalHint')}</p>
          </div>
        )}
        {isHR && payroll.status === 'REJECTED' && (
          <div className="flex items-start gap-2 p-4 bg-status-error-bg text-status-error rounded-[--radius-card]">
            <Info size={18} className="mt-0.5 shrink-0" />
            <p className="text-sm">{t('rejectedHint')}</p>
          </div>
        )}

        {/* Summary — every figure summed from the same row arithmetic the
            table below prints, so the two can never disagree. */}
        <RunSummaryCards
          totals={totals}
          labels={labels}
          payrollId={id}
          storedTotal={Number(payroll.totalAmount)}
        />

        <PayrollRunTable
          rows={rows}
          labels={labels}
          canEdit={canEdit}
          editingItem={editingItem}
          editValues={editValues}
          onEdit={handleEdit}
          onCancelEdit={() => setEditingItem(null)}
          onChangeEdit={(patch) => setEditValues({ ...editValues, ...patch })}
          onSave={handleSave}
        />
      </div>

      <ConfirmDialog />

      {revisionOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-surface-card p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold text-text-primary">
              {t('revisionReasonPrompt')}
            </h3>
            <textarea
              data-testid="payroll-revision-reason"
              value={revisionReason}
              onChange={(e) => setRevisionReason(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-slate-200 p-3 text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                data-testid="payroll-revision-cancel"
                onClick={() => setRevisionOpen(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold"
              >
                {tc('cancel')}
              </button>
              <button
                data-testid="payroll-revision-confirm"
                onClick={handleCreateRevision}
                disabled={!revisionReason.trim() || revisionBusy}
                className="rounded-xl bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {tc('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * MANAGE_PAYROLL, matching the server: `GET /payrolls` and every write door on it
 * admit ADMIN and HR_MANAGER only. Without this the page rendered its chrome,
 * its stat cards and its action buttons for a manager or an employee and then
 * fired requests the API refused — a screen that looks usable and is not.
 */
export default function PayrollDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <PayrollDetailPageContent params={params} />
    </ProtectedRoute>
  );
}
