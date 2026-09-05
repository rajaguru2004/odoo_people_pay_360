'use client';

import { use, useEffect, useState } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Calendar, Clock, User, FileText, CheckCircle, XCircle, Loader2, AlertTriangle, X, Paperclip, Trash2 } from 'lucide-react';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import leaveService from '@/services/leaveService';
import approvalWorkflowService, { ApprovalTrail } from '@/services/approvalWorkflowService';
import { LeaveRequest, LeaveBalance } from '@/types/leave';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { usePermission } from '@/hooks/usePermission';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';

const getLeaveTypeLabel = (type: string, tc: (key: string) => string) => {
  const labels: Record<string, string> = {
    ANNUAL: tc('annualLeave'),
    SICK: tc('sickLeave'),
    UNPAID: tc('unpaidLeave'),
    MATERNITY: tc('maternityLeave'),
    PATERNITY: tc('paternityLeave'),
    BEREAVEMENT: tc('bereavementLeave'),
  };
  return labels[type.toUpperCase()] || type;
};

const getStatusLabels = (tc: (key: string) => string): Record<string, { label: string; color: string }> => ({
  PENDING: { label: tc('pending'), color: 'bg-status-warning-bg text-status-warning border-status-warning/20' },
  APPROVED: { label: tc('approved'), color: 'bg-status-success-bg text-status-success border-status-success/20' },
  REJECTED: { label: tc('rejected'), color: 'bg-status-error-bg text-status-error border-status-error/20' },
  CANCELLED: { label: tc('cancelled'), color: 'bg-surface-page text-text-muted border-surface-border' },
});

export default function LeaveDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useTranslations('leaveDetailPage');
  const tc = useTranslations('common');
  const tLeaves = useTranslations('leavesPage');
  const tMyLeaves = useTranslations('myLeavesPage');
  const router = useRouter();
  const { id } = use(params);
  const { user } = useAuthStore();
  const { can } = usePermission();
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();

  // The one heading for this route, rendered by TopHeader. The subtitle carries
  // the request id, which only exists once the record has loaded — the hook
  // itself still runs unconditionally, ahead of the loading/not-found returns.
  usePageHeader(t('title'), t('requestIdPrefix', { id: id.slice(0, 8) }));

  const [leave, setLeave] = useState<LeaveRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [approveComment, setApproveComment] = useState('');
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [trail, setTrail] = useState<ApprovalTrail | null>(null);

  const { branding } = useBrandingStore();
  const hierarchyEnabled = branding.leave_approval_hierarchy_enabled;
  const approvedTiers = leave?.approvals?.filter((a: any) => a.status === 'APPROVED').map((a: any) => a.tier) || [];
  const nextTier = !approvedTiers.includes(1) ? 1 : !approvedTiers.includes(2) ? 2 : 3;

  const isDeptManager = user?.role === 'MANAGER' && leave?.employee?.department?.managerId === user?.employeeId;
  const isHR = user?.role === 'HR_MANAGER';
  const isAdmin = user?.role === 'ADMIN';

  const canApprove = (() => {
    if (!leave || leave.status !== 'PENDING') return false;
    if (!user?.role) return false;

    // A configured approval chain decides who may act — its steps route to a
    // supervisor (an EMPLOYEE-role user) or a department manager, so no role
    // check here can stand in for it. Legacy rules apply only without a chain.
    if (trail?.engaged) return trail.canAct;

    if (!hierarchyEnabled) {
      if (user.role === 'MANAGER') {
        return leave.employee?.department?.id === user.employee?.department?.id;
      }
      return ['ADMIN', 'HR_MANAGER'].includes(user.role);
    } else {
      if (nextTier === 1) return isDeptManager || isHR || isAdmin;
      if (nextTier === 2) return isHR || isAdmin;
      if (nextTier === 3) return isAdmin;
      return false;
    }
  })();

  useEffect(() => {
    fetchLeaveDetail();
  }, [id]);

  const fetchLeaveDetail = async () => {
    try {
      setLoading(true);
      const response = await leaveService.getById(id);
      setLeave(response.data);
      try {
        const tr = await approvalWorkflowService.trail('LEAVE', id);
        setTrail((tr as any)?.data ?? null);
      } catch {
        setTrail(null);
      }
      if (response.data?.employeeId) {
        const year = new Date(response.data.startDate).getFullYear();
        try {
          const balRes = await leaveService.getBalance(response.data.employeeId, year);
          if (balRes.success && balRes.data) {
            setBalance(balRes.data);
          }
        } catch (err) {
          console.error('Failed to fetch leave balance:', err);
        }
      }
    } catch (error) {
      console.error('Failed to fetch leave detail:', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    try {
      const res: any = await leaveService.approve(id, approveComment);
      if ((res?.data ?? res)?.status === 'APPROVED') {
        toast.success(t('approveSuccess'));
      } else {
        // A multi-step chain: this step is done, the request is still open.
        toast.success('Your approval is recorded. The request now moves to the next approver.');
      }
      setShowApproveModal(false);
      setApproveComment('');
      fetchLeaveDetail();
    } catch (error: any) {
      console.error('Failed to approve:', error);
      toast.error(error.response?.data?.message || t('approveFailed'));
    }
  };

  const handleReject = async () => {
    try {
      await leaveService.reject(id, rejectReason);
      toast.success(t('rejectSuccess'));
      setShowRejectModal(false);
      setRejectReason('');
      fetchLeaveDetail();
    } catch (error: any) {
      console.error('Failed to reject:', error);
      toast.error(error.response?.data?.message || t('rejectFailedMsg'));
    }
  };

  const handleCancel = async () => {
    const confirmed = await confirm({
      title: t('confirmCancelTitle'),
      message: t('confirmCancelDesc'),
      confirmText: t('cancelApplication'),
      type: 'danger'
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await leaveService.cancel(id);
      closeModal();
      toast.success(t('cancelSuccess'));
      router.push('/dashboard/my-leaves');
    } catch (error: any) {
      console.error('Failed to cancel:', error);
      closeModal();
      toast.error(error.response?.data?.message || t('cancelFailedMsg'));
    }
  };

  const canCancel = leave?.status === 'PENDING' && leave?.employeeId === user?.employeeId;

  if (loading) {
    return (
      <>
        <div className="flex items-center justify-center h-96">
          <Loader2 className="w-8 h-8 animate-spin text-brand-primary" />
        </div>
      </>
    );
  }

  if (!leave) {
    return (
      <>
        <div className="text-center py-12">
          {/* neutral — not brand-specific */}
          <p className="text-text-muted">{t('noRequestFound')}</p>
        </div>
      </>
    );
  }

  const statusLabels = getStatusLabels(tc);
  const status = statusLabels[leave.status];

  return (
    <ProtectedRoute>
      <>
        <ConfirmDialog />
        <div className="space-y-6" data-testid="ess-leave-detail">
          {/* Back + breadcrumb + status. The title/request id live in the sticky
              TopHeader (declared via usePageHeader above). The parent crumb is
              gated on the same permission the destination enforces — an EMPLOYEE
              reaches this page for their own request but has no VIEW_ALL_LEAVES,
              so their list is /dashboard/my-leaves. */}
          <div data-testid="leave-detail" data-leave-id={leave.id} className="contents" />
          <PageActionRow
            onBack={() => router.back()}
            action={
              <div
                data-testid="leave-status"
                data-status={leave.status}
                className={`px-4 py-2 rounded-[--radius-button] border-2 font-semibold ${status.color}`}
              >
                {status.label}
              </div>
            }
          />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main Info */}
            <div className="lg:col-span-2 space-y-6">
              {/* Employee Info */}
              <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
                <h2 className="text-xl font-bold text-text-heading mb-4">{t('employeeInfo')}</h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    {/* neutral — not brand-specific */}
                    <p className="text-sm text-text-muted mb-1">{t('fullName')}</p>
                    <p className="font-semibold text-text-heading">{leave.employee?.fullName || tc('notAvailable')}</p>
                  </div>
                  <div>
                    {/* neutral — not brand-specific */}
                    <p className="text-sm text-text-muted mb-1">{t('employeeId')}</p>
                    <p className="font-semibold text-text-heading">{leave.employee?.employeeCode || tc('notAvailable')}</p>
                  </div>
                  <div>
                    {/* neutral — not brand-specific */}
                    <p className="text-sm text-text-muted mb-1">{tc('department')}</p>
                    <p className="font-semibold text-text-heading">{leave.employee?.department?.name || tc('notAvailable')}</p>
                  </div>
                </div>
              </div>

              {/* Leave Details */}
              <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
                <h2 className="text-xl font-bold text-text-heading mb-4">{t('leaveInfo')}</h2>
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-brand-primary-light/20 rounded-[--radius-card] flex items-center justify-center">
                      <FileText className="text-brand-primary" size={20} />
                    </div>
                    <div>
                      {/* neutral — not brand-specific */}
                      <p className="text-sm text-text-muted">{tc('leaveTypeLabel')}</p>
                      <p className="font-semibold text-text-heading">{getLeaveTypeLabel(leave.leaveType, tc)}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-status-success-bg rounded-[--radius-card] flex items-center justify-center">
                      <Calendar className="text-status-success" size={20} />
                    </div>
                    <div>
                      {/* neutral — not brand-specific */}
                      <p className="text-sm text-text-muted">{t('timeLabel')}</p>
                      <p className="font-semibold text-text-heading">
                        {new Date(leave.startDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })} - {new Date(leave.endDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-brand-accent/15 rounded-[--radius-card] flex items-center justify-center">
                      <Clock className="text-brand-accent" size={20} />
                    </div>
                    <div>
                      {/* neutral — not brand-specific */}
                      <p className="text-sm text-text-muted">{tc('totalDays')}</p>
                      <p data-testid="leave-total-days" data-days={leave.totalDays} className="font-semibold text-text-heading">{t('totalDaysValue', { days: leave.totalDays })}</p>
                    </div>
                  </div>

                  {balance && (
                    <div className="pt-4 border-t border-surface-border">
                      {/* neutral — not brand-specific */}
                      <p className="text-sm text-text-muted mb-2 font-medium">{t('balanceHeader', { year: balance.year })}</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {balance.leaveTypeBalances && balance.leaveTypeBalances.length > 0 ? (
                          balance.leaveTypeBalances.map((tb) => {
                            const isRequestedType = tb.leaveTypeKey.toUpperCase() === leave.leaveType.toUpperCase() ||
                                                    tb.leaveTypeKey === leave.leaveType;
                            return (
                              <div key={tb.id} data-testid="leave-balance-card" data-leave-type={tb.leaveTypeKey} data-remaining={tb.remaining} data-total={tb.allocated + tb.carriedOver} className={`p-3 rounded-xl border ${isRequestedType ? 'border-brand-primary/30 bg-brand-primary-light/10' : 'border-surface-border bg-surface-page/50'}`}>
                                <p className="text-xs text-text-muted font-medium">{tb.leaveTypeKey}</p>
                                <p className="text-lg font-bold text-text-heading mt-0.5">
                                  {t('daysLeft', { days: tb.remaining })}
                                </p>
                                <p className="text-[10px] text-text-muted mt-0.5">{t('totalCarried', { total: tb.allocated + tb.carriedOver, carried: tb.carriedOver })}</p>
                              </div>
                            );
                          })
                        ) : (
                          <>
                            <div className={`p-3 rounded-xl border ${leave.leaveType === 'ANNUAL' ? 'border-brand-primary/30 bg-brand-primary-light/10' : 'border-surface-border bg-surface-page/50'}`}>
                              <p className="text-xs text-text-muted font-medium">{tc('annualLeave')}</p>
                              <p className="text-lg font-bold text-text-heading mt-0.5">
                                {t('daysLeft', { days: balance.remainingAnnual ?? 0 })}
                              </p>
                              <p className="text-[10px] text-text-muted mt-0.5">{t('totalCarried', { total: balance.annualLeave + balance.carriedOver, carried: balance.carriedOver })}</p>
                            </div>
                            <div className={`p-3 rounded-xl border ${leave.leaveType === 'SICK' ? 'border-brand-primary/30 bg-brand-primary-light/10' : 'border-surface-border bg-surface-page/50'}`}>
                              <p className="text-xs text-text-muted font-medium">{tc('sickLeave')}</p>
                              <p className="text-lg font-bold text-text-heading mt-0.5">
                                {t('daysLeft', { days: balance.remainingSick ?? 0 })}
                              </p>
                              <p className="text-[10px] text-text-muted mt-0.5">{t('totalOnly', { total: balance.sickLeave })}</p>
                            </div>
                          </>
                        )}
                      </div>
                      {(() => {
                        const currentType = leave.leaveType;
                        let remaining = undefined;
                        if (balance.leaveTypeBalances && balance.leaveTypeBalances.length > 0) {
                          const tb = balance.leaveTypeBalances.find(b => b.leaveTypeKey.toUpperCase() === currentType.toUpperCase() || b.leaveTypeKey === currentType);
                          if (tb) {
                            remaining = tb.remaining;
                          }
                        } else {
                          remaining = currentType === 'SICK' ? balance.remainingSick : (currentType === 'ANNUAL' ? balance.remainingAnnual : undefined);
                        }
                        const isLow = remaining !== undefined && remaining < leave.totalDays;
                        if (isLow) {
                          return (
                            <div data-testid="leave-balance-warning" className="mt-3 p-3 bg-status-error-bg text-status-error rounded-[--radius-button] flex items-center gap-2 text-xs border border-status-error/20">
                              <AlertTriangle size={14} className="flex-shrink-0" />
                              <span>{t('warningExceed', { requested: leave.totalDays, type: getLeaveTypeLabel(currentType, tc).toLowerCase(), remaining: remaining as number })}</span>
                            </div>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  )}

                  <div className="pt-4 border-t border-surface-border">
                    {/* neutral — not brand-specific */}
                    <p className="text-sm text-text-muted mb-2">{tc('reason')}</p>
                    <p className="text-text-body whitespace-pre-wrap">{leave.reason}</p>
                  </div>
                </div>
              </div>

              {/* Attachments Section */}
              {leave.attachments && leave.attachments.length > 0 && (
                <div data-testid="leave-attachments" className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
                  <h2 className="text-xl font-bold text-text-heading mb-4 flex items-center gap-2">
                    <Paperclip size={20} className="text-text-muted" />
                    {t('attachmentsHeader')}
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {leave.attachments.map((file) => {
                      const isOwner = file.uploadedBy === user?.id;
                      const isAdminOrHR = user?.role && ['ADMIN', 'HR_MANAGER'].includes(user.role);
                      const isDeptManager = user?.role === 'MANAGER' && leave?.employee?.department?.managerId === user?.employeeId;
                      const canDelete = isOwner || isAdminOrHR || isDeptManager;

                      return (
                        <div key={file.id} data-testid="leave-attachment" data-attachment-id={file.id} data-file-name={file.fileName} className="flex items-center justify-between p-4 bg-surface-page border border-surface-border rounded-[--radius-card] hover:shadow-xs transition-shadow">
                          <div className="flex items-center gap-3 overflow-hidden">
                            <div className="w-10 h-10 bg-brand-primary-light/10 text-brand-primary rounded-[--radius-card] flex items-center justify-center flex-shrink-0">
                              <FileText size={20} />
                            </div>
                            <div className="overflow-hidden">
                              <a
                                href={file.fileUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="font-semibold text-sm text-brand-primary hover:underline truncate block"
                                title={file.fileName}
                              >
                                {file.fileName}
                              </a>
                              {file.fileSize && (
                                <p className="text-xs text-text-muted">
                                  {t('fileSizeMb', { size: (file.fileSize / (1024 * 1024)).toFixed(2) })}
                                </p>
                              )}
                            </div>
                          </div>

                          {canDelete && (
                            <button
                              data-testid="leave-attachment-delete"
                              onClick={async () => {
                                const confirmed = await confirm({
                                  title: t('deleteAttachmentTitle'),
                                  message: t('deleteAttachmentDesc', { name: file.fileName }),
                                  confirmText: tc('delete'),
                                  type: 'danger',
                                });
                                if (!confirmed) return;
                                try {
                                  await leaveService.deleteAttachment(leave.id, file.id);
                                  toast.success(t('attachmentDeleted'));
                                  fetchLeaveDetail();
                                } catch (err) {
                                  toast.error(t('attachmentDeleteFailed'));
                                }
                              }}
                              className="text-status-error hover:opacity-80 transition-colors p-2 hover:bg-status-error-bg rounded-[--radius-button] flex-shrink-0"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Configurable approval chain — the real steps, in order, with
                  the live one called out. The fixed 3-tier stepper below is the
                  LEGACY mechanism and only applies when no chain governs this
                  request; showing both would contradict each other. */}
              {trail?.engaged && (
                <div
                  data-testid="leave-trail"
                  data-engaged={trail.engaged}
                  data-can-act={trail.canAct}
                  data-active-step={trail.activeStep ?? ''}
                  className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border"
                >
                  <h2 className="text-xl font-bold text-text-heading mb-4">{t('hierarchyProgress')}</h2>
                  <div className="space-y-4">
                    {trail.steps.map((step) => {
                      const dot =
                        step.status === 'APPROVED'
                          ? 'bg-status-success'
                          : step.status === 'REJECTED'
                            ? 'bg-status-error'
                            : step.status === 'ACTIVE'
                              ? 'bg-status-warning'
                              : 'bg-surface-border';
                      const label =
                        step.status === 'ACTIVE'
                          ? 'Awaiting decision'
                          : step.status === 'SKIPPED'
                            ? 'Skipped — no eligible approver'
                            : step.status === 'PENDING'
                              ? 'Not started'
                              : step.status === 'APPROVED'
                                ? tc('approved')
                                : tc('rejected');
                      const who = step.approverType
                        .replace('HR_MANAGER', 'HR')
                        .replace('MANAGER', 'Dept. Manager')
                        .replace('SUPERVISOR', 'Supervisor')
                        .replace('ADMIN', 'Admin');
                      return (
                        <div
                          key={step.id}
                          data-testid="leave-trail-step"
                          data-step-order={step.stepOrder}
                          data-approver-type={step.approverType}
                          data-step-status={step.status}
                          className="flex gap-3"
                        >
                          <div className={`w-2 h-2 rounded-full mt-2 ${dot}`}></div>
                          <div>
                            <p className="text-sm font-semibold text-text-heading">
                              {step.stepOrder}. {who} — {label}
                            </p>
                            {step.decidedAt && (
                              <p className="text-xs text-text-muted">
                                {new Date(step.decidedAt).toLocaleString('en-IN', { timeZone: getCompanyTz() })}
                              </p>
                            )}
                            {step.comment && (
                              <p className="text-xs text-text-muted italic">{step.comment}</p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {leave.status === 'PENDING' && trail.activeStep && !trail.canAct && (
                    <p data-testid="leave-trail-waiting" className="mt-4 text-xs text-text-muted border-t border-surface-border pt-3">
                      Waiting on step {trail.activeStep}. You are not the approver for this step.
                    </p>
                  )}
                </div>
              )}

              {/* Approval Hierarchy Stepper (legacy tier model) */}
              {(!trail?.engaged && (hierarchyEnabled || (leave.approvals && leave.approvals.length > 0)) && (
                <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
                  <h2 className="text-xl font-bold text-text-heading mb-4">{t('hierarchyProgress')}</h2>
                  <div className="space-y-6 relative before:absolute before:start-4 before:top-2 before:bottom-2 before:w-[2px] before:bg-surface-border-light">
                    {[
                      { tier: 1, label: t('deptHeadStep'), role: 'MANAGER' },
                      { tier: 2, label: t('hrManagerStep'), role: 'HR_MANAGER' },
                      { tier: 3, label: t('adminStep'), role: 'ADMIN' },
                    ].map((step) => {
                      const approval = leave.approvals?.find((a) => a.tier === step.tier);
                      const isCurrent = leave.status === 'PENDING' && nextTier === step.tier;

                      let statusText = tc('pending');
                      let statusColor = 'text-text-muted bg-surface-page';
                      let iconColor = 'bg-surface-page border-surface-border text-text-muted';

                      if (approval) {
                        if (approval.status === 'APPROVED') {
                          statusText = tc('approved');
                          statusColor = 'text-status-success bg-status-success-bg';
                          iconColor = 'bg-status-success-bg border-status-success/20 text-status-success';
                        } else if (approval.status === 'REJECTED') {
                          statusText = tc('rejected');
                          statusColor = 'text-status-error bg-status-error-bg';
                          iconColor = 'bg-status-error-bg border-status-error/20 text-status-error';
                        }
                      } else if (isCurrent) {
                        statusText = t('awaitingAction');
                        statusColor = 'text-brand-primary bg-brand-primary-light/10 border border-brand-primary/20 animate-pulse';
                        iconColor = 'bg-brand-primary-light/20 border-brand-primary/30 text-brand-primary';
                      }

                      return (
                        <div key={step.tier} className="flex gap-4 relative z-10">
                          <div className={`w-8 h-8 rounded-full border-2 flex items-center justify-center font-bold text-xs ${iconColor}`}>
                            {step.tier}
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center justify-between">
                              <p className="font-semibold text-text-heading">{step.label}</p>
                              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${statusColor}`}>
                                {statusText}
                              </span>
                            </div>
                            {approval ? (
                              <div className="mt-1 text-sm text-text-body space-y-1">
                                <p className="text-xs text-text-muted">
                                  {t('decidedByOn', {
                                    name: approval.approver?.employee?.fullName || approval.approver?.email,
                                    date: approval.decidedAt ? new Date(approval.decidedAt).toLocaleString('en-IN', { timeZone: getCompanyTz() }) : tc('notAvailable'),
                                  })}
                                </p>
                                {approval.comment && (
                                  <p className="italic bg-surface-page p-2 rounded-[--radius-card] border border-surface-border-light mt-1">
                                    "{approval.comment}"
                                  </p>
                                )}
                              </div>
                            ) : isCurrent ? (
                              <p className="text-xs text-brand-primary mt-1">{t('underReviewStage')}</p>
                            ) : (
                              <p className="text-xs text-text-muted mt-1">{t('waitingPreviousStage')}</p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
 
              {/* Approval Info */}
              {!hierarchyEnabled && (!leave.approvals || leave.approvals.length === 0) && (leave.status === 'APPROVED' || leave.status === 'REJECTED') && (
                <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
                  <h2 className="text-xl font-bold text-text-heading mb-4">
                    {leave.status === 'APPROVED' ? t('approvalDetailsHeader') : t('rejectionDetailsHeader')}
                  </h2>
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${leave.status === 'APPROVED' ? 'bg-status-success-bg' : 'bg-status-error-bg'
                        }`}>
                        <User className={leave.status === 'APPROVED' ? 'text-status-success' : 'text-status-error'} size={20} />
                      </div>
                      <div>
                        {/* neutral — not brand-specific */}
                        <p className="text-sm text-text-muted">{t('reviewer')}</p>
                        <p className="font-semibold text-text-heading">{leave.approver?.email || tc('notAvailable')}</p>
                      </div>
                    </div>

                    {leave.approvedAt && (
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${leave.status === 'APPROVED' ? 'bg-status-success-bg' : 'bg-status-error-bg'
                          }`}>
                          <Clock className={leave.status === 'APPROVED' ? 'text-status-success' : 'text-status-error'} size={20} />
                        </div>
                        <div>
                          {/* neutral — not brand-specific */}
                          <p className="text-sm text-text-muted">{t('timeLabel')}</p>
                          <p className="font-semibold text-text-heading">{new Date(leave.approvedAt).toLocaleString('en-IN', { timeZone: getCompanyTz() })}</p>
                        </div>
                      </div>
                    )}

                    {leave.rejectedReason && (
                      <div className="pt-4 border-t border-surface-border">
                        {/* neutral — not brand-specific */}
                        <p className="text-sm text-text-muted mb-2">
                          {leave.status === 'APPROVED' ? t('approvalComment') : t('reasonForRefusal')}
                        </p>
                        <p className={`whitespace-pre-wrap ${leave.status === 'APPROVED' ? 'text-status-success' : 'text-status-error'}`}>
                          {leave.rejectedReason}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="space-y-4">
              {canApprove && (
                <>
                  <button
                    data-testid="leave-approve-open"
                    onClick={() => setShowApproveModal(true)}
                    className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-status-success text-white rounded-[--radius-button] font-semibold hover:opacity-90 transition-all shadow-sm"
                  >
                    <CheckCircle className="text-white" size={20} />
                    {t('approveApplicationBtn')}
                  </button>

                  <button
                    data-testid="leave-reject-open"
                    onClick={() => setShowRejectModal(true)}
                    className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-status-error text-white rounded-[--radius-button] font-semibold hover:opacity-90 transition-all shadow-sm"
                  >
                    <XCircle size={20} />
                    {tc('reject')}
                  </button>
                </>
              )}

              {canCancel && (
                <button
                  data-testid="leave-cancel"
                  onClick={handleCancel}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-surface-overlay border border-surface-border text-text-body rounded-[--radius-button] font-semibold hover:bg-surface-page transition-all shadow-sm"
                >
                  <XCircle size={20} />
                  {t('cancelApplication')}
                </button>
              )}

              {/* Timeline */}
              <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
                <h3 className="font-bold text-text-heading mb-4">{t('historyHeader')}</h3>
                <div className="space-y-4">
                  <div className="flex gap-3">
                    <div className="w-2 h-2 bg-brand-primary rounded-full mt-2"></div>
                    <div>
                      <p className="text-sm font-semibold text-text-heading">{t('createdLabel')}</p>
                      <p className="text-xs text-text-muted">{new Date(leave.createdAt).toLocaleString('en-IN', { timeZone: getCompanyTz() })}</p>
                    </div>
                  </div>

                  {leave.approvedAt && (
                    <div className="flex gap-3">
                      <div className={`w-2 h-2 rounded-full mt-2 ${leave.status === 'APPROVED' ? 'bg-status-success' : 'bg-status-error'
                        }`}></div>
                      <div>
                        <p className="text-sm font-semibold text-text-heading">{leave.status === 'APPROVED' ? tc('approved') : tc('rejected')}</p>
                        <p className="text-xs text-text-muted">{new Date(leave.approvedAt).toLocaleString('en-IN', { timeZone: getCompanyTz() })}</p>
                      </div>
                    </div>
                  )}
              </div>
            </div>
          </div>
        </div>
          {/* Reject Modal */}
          {showRejectModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="bg-surface-overlay rounded-[--radius-card] shadow-2xl max-w-md w-full animate-scale-in border border-surface-border">
              {/* Header */}
              <div className="flex items-center justify-between p-6 border-b border-surface-border">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-[--radius-button] bg-status-error-bg text-status-error">
                    <AlertTriangle className="h-6 w-6" />
                  </div>
                  <h3 className="text-lg font-semibold text-text-heading">{t('rejectModalTitle')}</h3>
                </div>
                <button
                  onClick={() => {
                    setShowRejectModal(false);
                    setRejectReason('');
                  }}
                  className="text-text-muted hover:text-text-body transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Body */}
              <div className="p-6 space-y-4">
                {balance && (
                  <div className="p-4 bg-surface-border-light border border-surface-border rounded-[--radius-card] space-y-3">
                    <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">{t('balanceContextHeader', { year: balance.year })}</p>
                    {(() => {
                      const currentType = leave.leaveType;
                      let remaining = undefined;
                      let allocated = 0;
                      let carriedOver = 0;
                      let hasTypeBalance = false;

                      if (balance.leaveTypeBalances && balance.leaveTypeBalances.length > 0) {
                        const tb = balance.leaveTypeBalances.find(b => b.leaveTypeKey.toUpperCase() === currentType.toUpperCase() || b.leaveTypeKey === currentType);
                        if (tb) {
                          remaining = tb.remaining;
                          allocated = tb.allocated;
                          carriedOver = tb.carriedOver;
                          hasTypeBalance = true;
                        }
                      }

                      if (!hasTypeBalance) {
                        if (currentType === 'ANNUAL') {
                           remaining = balance.remainingAnnual;
                           allocated = balance.annualLeave;
                           carriedOver = balance.carriedOver;
                        } else if (currentType === 'SICK') {
                           remaining = balance.remainingSick;
                           allocated = balance.sickLeave;
                        }
                      }

                      if (remaining !== undefined) {
                        return (
                          <div>
                            <p className="text-xs text-text-muted font-medium">{t('availableTypeLabel', { type: getLeaveTypeLabel(currentType, tc) })}</p>
                            <p className="text-sm font-bold text-text-heading mt-0.5">
                              {t('remainingOfTotalDays', { remaining, total: allocated + carriedOver })}
                            </p>
                          </div>
                        );
                      } else {
                        return (
                          <p className="text-xs text-text-muted font-medium">{t('noBalanceTracking')}</p>
                        );
                      }
                    })()}
                  </div>
                )}
                <p className="text-text-body font-medium text-sm">{t('confirmRejectDesc')}</p>
                <div>
                  <label htmlFor="reject-reason" className="block text-sm font-medium text-text-body mb-1">
                    {t('rejectReasonOptionalLabel')}
                  </label>
                  <textarea
                    data-testid="leave-reject-reason"
                    id="reject-reason"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    rows={3}
                    placeholder={t('enterReasonPlaceholder')}
                    className="w-full px-3 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-status-error/20 focus:border-status-error text-sm bg-surface-card text-text-body"
                  />
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-3 p-6 border-t border-surface-border bg-surface-border-light rounded-b-[--radius-card]">
                <button
                  onClick={() => {
                    setShowRejectModal(false);
                    setRejectReason('');
                  }}
                  className="px-4 py-2 border border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-page transition-colors"
                >
                  {tc('cancel')}
                </button>
                <button
                  data-testid="leave-reject-confirm"
                  onClick={handleReject}
                  className="px-4 py-2 text-text-on-brand bg-status-error hover:bg-status-error/90 rounded-[--radius-button] transition-colors"
                >
                  {t('rejectApplicationBtn')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Approve Modal */}
        {showApproveModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="bg-surface-overlay rounded-[--radius-card] shadow-2xl max-w-md w-full animate-scale-in border border-surface-border">
              {/* Header */}
              <div className="flex items-center justify-between p-6 border-b border-surface-border">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-[--radius-button] bg-status-success-bg text-status-success">
                    <CheckCircle className="h-6 w-6" />
                  </div>
                  <h3 className="text-lg font-semibold text-text-heading">{t('confirmApprovalTitle')}</h3>
                </div>
                <button
                  onClick={() => {
                    setShowApproveModal(false);
                    setApproveComment('');
                  }}
                  className="text-text-muted hover:text-text-body transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Body */}
              <div className="p-6 space-y-4">
                {balance && (
                  <div className="p-4 bg-surface-border-light border border-surface-border rounded-[--radius-card] space-y-3">
                    <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">{t('balanceContextHeader', { year: balance.year })}</p>
                    {(() => {
                      const currentType = leave.leaveType;
                      let remaining = undefined;
                      let allocated = 0;
                      let carriedOver = 0;
                      let hasTypeBalance = false;

                      if (balance.leaveTypeBalances && balance.leaveTypeBalances.length > 0) {
                        const tb = balance.leaveTypeBalances.find(b => b.leaveTypeKey.toUpperCase() === currentType.toUpperCase() || b.leaveTypeKey === currentType);
                        if (tb) {
                          remaining = tb.remaining;
                          allocated = tb.allocated;
                          carriedOver = tb.carriedOver;
                          hasTypeBalance = true;
                        }
                      }

                      if (!hasTypeBalance) {
                        if (currentType === 'ANNUAL') {
                          remaining = balance.remainingAnnual;
                          allocated = balance.annualLeave;
                          carriedOver = balance.carriedOver;
                        } else if (currentType === 'SICK') {
                          remaining = balance.remainingSick;
                          allocated = balance.sickLeave;
                        }
                      }

                      if (remaining !== undefined) {
                        return (
                          <div className="space-y-2">
                            <div>
                              <p className="text-xs text-text-muted font-medium">{t('availableTypeLabel', { type: getLeaveTypeLabel(currentType, tc) })}</p>
                              <p className="text-sm font-bold text-text-heading mt-0.5">
                                {t('remainingOfTotalDays', { remaining, total: allocated + carriedOver })}
                              </p>
                            </div>
                            {remaining < leave.totalDays && (
                              <div className="p-2.5 bg-status-error-bg text-status-error rounded-[--radius-button] flex items-center gap-2 text-xs border border-status-error/20">
                                <AlertTriangle size={14} className="flex-shrink-0" />
                                <span>{t('exceedsBalanceWarning', { requested: leave.totalDays, remaining })}</span>
                              </div>
                            )}
                          </div>
                        );
                      } else {
                        return (
                          <p className="text-xs text-text-muted font-medium">{t('noBalanceTracking')}</p>
                        );
                      }
                    })()}
                  </div>
                )}
                <p className="text-text-body font-medium text-sm">{t('confirmApproveDesc')}</p>
                <div>
                  <label htmlFor="approve-comment" className="block text-sm font-medium text-text-body mb-1">
                    {t('approvalCommentsOptionalLabel')}
                  </label>
                  <textarea
                    data-testid="leave-approve-comment"
                    id="approve-comment"
                    value={approveComment}
                    onChange={(e) => setApproveComment(e.target.value)}
                    rows={3}
                    placeholder={t('enterCommentsPlaceholder')}
                    className="w-full px-3 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-status-success/20 focus:border-status-success text-sm bg-surface-card text-text-body"
                  />
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-3 p-6 border-t border-surface-border bg-surface-border-light rounded-b-[--radius-card]">
                <button
                  onClick={() => {
                    setShowApproveModal(false);
                    setApproveComment('');
                  }}
                  className="px-4 py-2 border border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-page transition-colors"
                >
                  {tc('cancel')}
                </button>
                <button
                  data-testid="leave-approve-confirm"
                  onClick={handleApprove}
                  className="px-4 py-2 text-text-on-brand bg-status-success hover:bg-status-success/90 rounded-[--radius-button] transition-colors"
                >
                  {t('approveApplicationBtn')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  </ProtectedRoute>
  );
}
