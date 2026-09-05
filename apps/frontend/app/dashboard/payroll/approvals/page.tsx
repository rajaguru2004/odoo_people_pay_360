'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CheckCircle, XCircle, Eye, Clock, AlertCircle, Calendar, Users } from 'lucide-react';
import payrollService from '@/services/payrollService';
import { Payroll } from '@/types/payroll';
import { formatCurrency, getCompanyTz } from '@/utils/formatters';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePermission } from '@/hooks/usePermission';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import { toast } from '@/lib/toast';
import { apiErrorMessage } from '@/utils/apiError';

function PayrollApprovalsPageContent() {
  const router = useRouter();
  // Approving and rejecting a payroll run is ADMIN-only on the server
  // (`POST /payrolls/:id/approve` and `/reject`). HR_MANAGER reaches this queue
  // to watch it, not to decide it — offering them the buttons only produced a
  // 403 they could do nothing about.
  const { isAdmin } = usePermission();
  const t = useTranslations('payrollApprovalsPage');
  const tc = useTranslations('common');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [payrolls, setPayrolls] = useState<Payroll[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTab, setSelectedTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const { confirm, ConfirmDialog, closeModal } = useConfirm();
  // The reject reason is written to `rejectionReason` and is the only
  // explanation the person who has to redo the run ever sees, so the server
  // requires it. `window.prompt` could not enforce a minimum, could not show a
  // validation message and could not be styled — a modal with a real field can.
  const [rejecting, setRejecting] = useState<Payroll | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectBusy, setRejectBusy] = useState(false);

  useEffect(() => {
    fetchPayrolls();
  }, []);

  const fetchPayrolls = async () => {
    try {
      setLoading(true);
      const response = await payrollService.getAll();
      setPayrolls(response.data);
    } catch (error) {
      console.error('Failed to fetch payrolls:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (id: string, month: number, year: number) => {
    const ok = await confirm({
      title: tc('approve'),
      message: t('approveConfirmMessage', { month, year }),
      confirmText: tc('approve'),
      type: 'success',
    });
    if (!ok) return;

    try {
      await payrollService.approve(id, { notes: 'Approved' });
      toast.success(t('approveSuccess'));
      fetchPayrolls();
    } catch (error: unknown) {
      toast.error(apiErrorMessage(error, t('approveFailedFallback')));
    } finally {
      closeModal();
    }
  };

  const submitRejection = async () => {
    if (!rejecting || !rejectReason.trim()) return;
    setRejectBusy(true);
    try {
      await payrollService.reject(rejecting.id, { reason: rejectReason.trim() });
      toast.success(t('rejectSuccess'));
      setRejecting(null);
      setRejectReason('');
      fetchPayrolls();
    } catch (error: unknown) {
      toast.error(apiErrorMessage(error, t('rejectFailedFallback')));
    } finally {
      setRejectBusy(false);
    }
  };

  const filteredPayrolls = payrolls.filter(p => {
    if (selectedTab === 'pending') return p.status === 'PENDING_APPROVAL';
    if (selectedTab === 'approved') return p.status === 'APPROVED';
    if (selectedTab === 'rejected') return p.status === 'REJECTED';
    return false;
  });

  const stats = {
    pending: payrolls.filter(p => p.status === 'PENDING_APPROVAL').length,
    approved: payrolls.filter(p => p.status === 'APPROVED').length,
    rejected: payrolls.filter(p => p.status === 'REJECTED').length,
  };

  return (
    <>
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-surface-card rounded-[--radius-card] p-6 border-2 border-status-warning/30">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-status-warning-bg rounded-[--radius-button] flex items-center justify-center">
                <Clock className="text-status-warning" size={20} />
              </div>
              <p className="text-sm text-text-body">{tc('pending')}</p>
            </div>
            <p className="text-3xl font-bold text-status-warning">{stats.pending}</p>
          </div>

          <div className="bg-surface-card rounded-[--radius-card] p-6 border-2 border-status-success/30">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-status-success-bg rounded-[--radius-button] flex items-center justify-center">
                <CheckCircle className="text-status-success" size={20} />
              </div>
              <p className="text-sm text-text-body">{tc('approved')}</p>
            </div>
            <p className="text-3xl font-bold text-status-success">{stats.approved}</p>
          </div>

          <div className="bg-surface-card rounded-[--radius-card] p-6 border-2 border-status-error/30">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-status-error-bg rounded-[--radius-button] flex items-center justify-center">
                <XCircle className="text-status-error" size={20} />
              </div>
              <p className="text-sm text-text-body">{tc('rejected')}</p>
            </div>
            <p className="text-3xl font-bold text-status-error">{stats.rejected}</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border">
          <div className="border-b border-surface-border">
            <div className="flex gap-4 px-6">
              <button
                onClick={() => setSelectedTab('pending')}
                className={`py-4 px-4 font-semibold border-b-2 transition-colors ${selectedTab === 'pending'
                    ? 'border-status-warning text-status-warning'
                    : 'border-transparent text-text-muted hover:text-text-heading'
                  }`}
              >
                {t('tabWaiting', { count: stats.pending })}
              </button>
              <button
                onClick={() => setSelectedTab('approved')}
                className={`py-4 px-4 font-semibold border-b-2 transition-colors ${selectedTab === 'approved'
                    ? 'border-status-success text-status-success'
                    : 'border-transparent text-text-muted hover:text-text-heading'
                  }`}
              >
                {t('tabApproved', { count: stats.approved })}
              </button>
              <button
                onClick={() => setSelectedTab('rejected')}
                className={`py-4 px-4 font-semibold border-b-2 transition-colors ${selectedTab === 'rejected'
                    ? 'border-status-error text-status-error'
                    : 'border-transparent text-text-muted hover:text-text-heading'
                  }`}
              >
                {t('tabRejected', { count: stats.rejected })}
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-page border-b border-surface-border">
                <tr>
                  <th className="px-6 py-4 text-start text-sm font-semibold text-text-heading">{t('colPayrollPeriod')}</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading">{tc('employees')}</th>
                  <th className="px-6 py-4 text-end text-sm font-semibold text-text-heading">{t('colTotalExpenditure')}</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading">{t('colDateSent')}</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center">
                      <div className="flex items-center justify-center">
                        <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                      </div>
                    </td>
                  </tr>
                ) : filteredPayrolls.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center">
                      <AlertCircle size={48} className="text-text-muted mx-auto mb-3" />
                      <p className="text-text-muted font-medium">
                        {selectedTab === 'pending' && t('emptyPending')}
                        {selectedTab === 'approved' && t('emptyApproved')}
                        {selectedTab === 'rejected' && t('emptyRejected')}
                      </p>
                    </td>
                  </tr>
                ) : (
                  filteredPayrolls.map((payroll) => (
                    <tr key={payroll.id} data-testid="payroll-approval-row" data-payroll-id={payroll.id} className="hover:bg-surface-page transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Calendar className="text-brand-primary" size={18} />
                          <span className="font-semibold text-text-heading">
                            {t('rowMonthYear', { month: payroll.month, year: payroll.year })}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Users size={16} className="text-text-muted" />
                          <span className="font-semibold text-text-heading">
                            {payroll._count?.items || 0}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-end">
                        <span className="font-bold text-status-success">
                          {formatCurrency(Number(payroll.totalAmount))}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center text-sm text-text-body">
                        {payroll.submittedAt
                          ? new Date(payroll.submittedAt).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })
                          : '-'}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => router.push(`/dashboard/payroll/${payroll.id}`)}
                            className="p-2 hover:bg-brand-primary/10 rounded-[--radius-button] text-brand-primary transition-colors"
                            title={t('viewDetailsTooltip')}
                          >
                            <Eye size={18} />
                          </button>
                          {selectedTab === 'pending' && isAdmin() && (
                            <>
                              <button
                                data-testid="payroll-approval-approve"
                                onClick={() => handleApprove(payroll.id, payroll.month, payroll.year)}
                                className="p-2 hover:bg-status-success-bg rounded-[--radius-button] text-status-success transition-colors"
                                title={tc('approve')}
                              >
                                <CheckCircle size={18} />
                              </button>
                              <button
                                data-testid="payroll-approval-reject"
                                onClick={() => { setRejecting(payroll); setRejectReason(''); }}
                                className="p-2 hover:bg-status-error-bg rounded-[--radius-button] text-status-error transition-colors"
                                title={tc('reject')}
                              >
                                <XCircle size={18} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <ConfirmDialog />

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-surface-card p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold text-text-primary">
              {tc('reject')}
            </h3>
            <p className="mb-4 text-sm text-text-muted">
              {t('rejectPromptMessage', {
                month: rejecting.month,
                year: rejecting.year,
              })}
            </p>
            <textarea
              data-testid="payroll-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-slate-200 p-3 text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                data-testid="payroll-reject-cancel"
                onClick={() => setRejecting(null)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold"
              >
                {tc('cancel')}
              </button>
              <button
                data-testid="payroll-reject-confirm"
                onClick={submitRejection}
                disabled={!rejectReason.trim() || rejectBusy}
                className="rounded-xl bg-status-error px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {tc('reject')}
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
export default function PayrollApprovalsPage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <PayrollApprovalsPageContent />
    </ProtectedRoute>
  );
}
