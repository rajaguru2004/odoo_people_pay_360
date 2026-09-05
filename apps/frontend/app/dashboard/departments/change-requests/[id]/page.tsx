'use client';
import { getApiErrorMessage } from '@/lib/apiError';

import { useEffect, useState } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import { useParams, useRouter } from 'next/navigation';
import { Clock, CheckCircle2, XCircle, AlertCircle, User, Calendar, FileText, Users, TrendingUp } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import departmentChangeRequestService from '@/services/departmentChangeRequestService';
import { DepartmentChangeRequest } from '@/types/department-change-request';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function ChangeRequestDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('changeRequestDetailPage');
  const tc = useTranslations('common');
  const [request, setRequest] = useState<DepartmentChangeRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [reviewAction, setReviewAction] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reviewNote, setReviewNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // The one heading for this route, rendered by TopHeader. Declared above the
  // loading/not-found early-returns so the hook order never changes.
  usePageHeader(t('title'), request?.department?.name);

  useEffect(() => {
    if (params.id) {
      fetchRequest();
    }
  }, [params.id]);

  const fetchRequest = async () => {
    try {
      setLoading(true);
      const response = await departmentChangeRequestService.getChangeRequest(params.id as string);
      setRequest(response.data);
    } catch (error) {
      console.error('Failed to fetch request:', error);
      alert(t('noRequestFound'));
      router.back();
    } finally {
      setLoading(false);
    }
  };

  const handleReview = async () => {
    if (!request) return;

    try {
      setSubmitting(true);
      await departmentChangeRequestService.reviewChangeRequest(request.id, {
        action: reviewAction,
        reviewNote: reviewNote || undefined,
      });

      alert(t('reviewResultMsg', { action: reviewAction === 'APPROVE' ? t('actionApproval') : t('actionRefused') }));
      router.push('/dashboard/departments/change-requests');
    } catch (error: any) {
      console.error('Failed to review:', error);
      alert(getApiErrorMessage(error, t('genericError')));
    } finally {
      setSubmitting(false);
      setShowApprovalModal(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      PENDING: 'bg-status-warning-bg text-status-warning border-status-warning/20',
      APPROVED: 'bg-status-success-bg text-status-success border-status-success/20',
      REJECTED: 'bg-status-error-bg text-status-error border-status-error/20',
      CANCELLED: 'bg-surface-page text-text-muted border-surface-border',
    };

    const icons = {
      PENDING: Clock,
      APPROVED: CheckCircle2,
      REJECTED: XCircle,
      CANCELLED: AlertCircle,
    };

    const labels = {
      PENDING: t('statusPending'),
      APPROVED: t('statusApproved'),
      REJECTED: t('statusRefused'),
      CANCELLED: t('statusCancelled'),
    };

    const Icon = icons[status as keyof typeof icons];

    return (
      <span data-testid="cr-detail-status" className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[--radius-badge] text-sm font-semibold border-2 ${styles[status as keyof typeof styles]}`}>
        <Icon size={16} />
        {labels[status as keyof typeof labels]}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 bg-slate-200 rounded w-64"></div>
        <div className="bg-surface-card rounded-[--radius-card] p-8 space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-6 bg-slate-100 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  if (!request) return null;
  const canReview = request.status === 'PENDING';

  return (
    <div className="space-y-6">
      {/* Heading lives in TopHeader via usePageHeader — the back button and the
          status badge stay here. */}
      <PageActionRow onBack={() => router.back()} action={getStatusBadge(request.status)} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Request Info */}
          <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
            <h2 className="text-lg font-bold text-text-heading mb-4">{t('requestedInfo')}</h2>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <p className="text-sm text-text-muted mb-1">{t('requestType')}</p>
                <p className="font-semibold text-text-body">
                  {request.requestType === 'CHANGE_MANAGER' ? t('typeChangeHead') : request.requestType === 'CHANGE_PARENT' ? t('typeChangeSuperior') : t('typeRestructuring')}
                </p>
              </div>
              <div>
                <p className="text-sm text-text-muted mb-1">{t('effectiveDate')}</p>
                <p className="font-semibold text-text-body">
                  {request.requestType === 'CHANGE_MANAGER' ? t('immediatelyOnApproval') : new Date(request.effectiveDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}
                </p>
              </div>
              <div>
                <p className="text-sm text-text-muted mb-1">{t('requester')}</p>
                <p className="font-semibold text-text-body">
                  {request.requester?.employee?.fullName || tc('notAvailable')}
                </p>
              </div>
              <div>
                <p className="text-sm text-text-muted mb-1">{t('creationDate')}</p>
                <p className="font-semibold text-text-body">
                  {new Date(request.createdAt).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}
                </p>
              </div>
            </div>
            <div className="bg-surface-page rounded-[--radius-card] p-4">
              <p className="text-sm font-semibold text-text-heading mb-2">{t('reasonForChange')}</p>
              <p className="text-text-body">{request.reason}</p>
            </div>
          </div>

          {/* Manager Change Details */}
          {request.requestType === 'CHANGE_MANAGER' && (
            <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
              <h2 className="text-lg font-bold text-text-heading mb-4">{t('changeHeadSection')}</h2>
              <div className="grid grid-cols-2 gap-6">
                <div className="bg-status-error-bg/30 border-2 border-status-error/20 rounded-[--radius-card] p-4">
                  <p className="text-sm font-semibold text-status-error mb-3">{t('formerDeptHead')}</p>
                  {request.oldManager ? (
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-status-error-bg text-status-error flex items-center justify-center font-bold">
                        {request.oldManager.fullName.charAt(0)}
                      </div>
                      <div>
                        <p className="font-bold text-text-heading">{request.oldManager.fullName}</p>
                        <p className="text-sm text-text-muted">{request.oldManager.position}</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-text-muted italic">{tc('notYet')}</p>
                  )}
                </div>

                <div className="bg-status-success-bg/30 border-2 border-status-success/20 rounded-[--radius-card] p-4">
                  <p className="text-sm font-semibold text-status-success mb-3">{t('newDeptHead')}</p>
                  {request.newManager ? (
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-status-success-bg text-status-success flex items-center justify-center font-bold">
                        {request.newManager.fullName.charAt(0)}
                      </div>
                      <div>
                        <p className="font-bold text-text-heading">{request.newManager.fullName}</p>
                        <p className="text-sm text-text-muted">{request.newManager.position}</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-text-muted italic">{t('doNotSelect')}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Review Section */}
          {request.status !== 'PENDING' && (
            <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
              <h2 data-testid="cr-review-result" className="text-lg font-bold text-text-heading mb-4">{t('approvalResults')}</h2>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-text-muted">{t('reviewer')}</p>
                  <p data-testid="cr-reviewer" className="font-semibold text-text-body">
                    {request.reviewer?.employee?.fullName || tc('notAvailable')}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-text-muted">{t('reviewTime')}</p>
                  <p className="font-semibold text-text-body">
                    {request.reviewedAt ? new Date(request.reviewedAt).toLocaleString('en-IN', { timeZone: getCompanyTz() }) : tc('notAvailable')}
                  </p>
                </div>
                {request.reviewNote && (
                  <div className="bg-surface-page rounded-[--radius-card] p-4">
                    <p className="text-sm font-semibold text-text-heading mb-2">{t('notesLabel')}</p>
                    <p data-testid="cr-review-note-text" className="text-text-body">{request.reviewNote}</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Impact Analysis */}
          {request.impact && (
            <div className="bg-brand-primary-light/10 border-2 border-brand-primary/20 rounded-[--radius-card] p-6">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp className="text-brand-primary" size={20} />
                <h3 className="font-bold text-text-heading">{t('impactAnalysis')}</h3>
              </div>
              <div className="space-y-3">
                <div className="bg-surface-card rounded-[--radius-card] p-3 border border-surface-border">
                  <p className="text-sm text-text-muted">{t('affectedEmployees')}</p>
                  <p data-testid="cr-impact-employees" className="text-2xl font-bold text-text-heading">{request.impact.affectedEmployees}</p>
                </div>
                <div className="bg-surface-card rounded-[--radius-card] p-3 border border-surface-border">
                  <p className="text-sm text-text-muted">{t('teamsAffected')}</p>
                  <p data-testid="cr-impact-teams" className="text-2xl font-bold text-text-heading">{request.impact.affectedTeams}</p>
                </div>
                <div className="bg-surface-card rounded-[--radius-card] p-3 border border-surface-border">
                  <p className="text-sm text-text-muted">{t('pendingApprovalLabel')}</p>
                  <div className="flex gap-2 mt-1">
                    <span className="text-sm text-text-body">{t('leaveLabel')} <strong data-testid="cr-impact-leaves">{request.impact.pendingApprovals.leaves}</strong></span>
                    <span className="text-sm text-text-body">{t('otLabel')} <strong data-testid="cr-impact-overtime">{request.impact.pendingApprovals.overtime}</strong></span>
                  </div>
                </div>
                <div className="bg-surface-card rounded-[--radius-card] p-3 border border-surface-border">
                  <p className="text-sm text-text-muted">{t('estimatedDelivery')}</p>
                  <p data-testid="cr-impact-days" className="text-2xl font-bold text-text-heading">{request.impact.estimatedTransitionDays} {t('daysSuffix')}</p>
                </div>
              </div>
            </div>
          )}

          {/* Actions */}
          {canReview && (
            <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
              <h3 className="font-bold text-text-heading mb-4">{t('actionHeading')}</h3>
              <div className="space-y-3">
                <button
                  data-testid="cr-approve"
                  onClick={() => { setReviewAction('APPROVE'); setShowApprovalModal(true); }}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-status-success text-white rounded-[--radius-button] hover:bg-status-success/90 transition-colors font-semibold cursor-pointer"
                >
                  <CheckCircle2 size={18} /> {t('approve')}
                </button>
                <button
                  data-testid="cr-reject"
                  onClick={() => { setReviewAction('REJECT'); setShowApprovalModal(true); }}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-status-error text-white rounded-[--radius-button] hover:bg-status-error/90 transition-colors font-semibold cursor-pointer"
                >
                  <XCircle size={18} /> {t('rejectBtn')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Approval Modal */}
      {showApprovalModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-surface-overlay rounded-[--radius-card] max-w-md w-full p-6 border border-surface-border shadow-2xl"
          >
            <h3 className="text-xl font-bold text-text-heading mb-4">
              {reviewAction === 'APPROVE' ? t('approveRequestTitle') : t('rejectRequestTitle')}
            </h3>
            <div className="mb-4">
              <label className="block text-sm font-semibold text-text-body mb-2">
                {t('notesOptional')}
              </label>
              <textarea
                data-testid="cr-review-note"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                rows={4}
                placeholder={t('notesPlaceholder')}
                className="w-full px-4 py-3 border-2 border-surface-border bg-surface-card text-text-body rounded-[--radius-input] focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/20 transition-all"
              />
            </div>
            <div className="flex gap-3">
              <button
                data-testid="cr-review-cancel"
                onClick={() => setShowApprovalModal(false)}
                disabled={submitting}
                className="flex-1 px-4 py-3 border-2 border-surface-border bg-surface-card text-text-body rounded-[--radius-button] hover:bg-surface-page transition-colors font-semibold cursor-pointer"
              >
                {tc('cancel')}
              </button>
              <button
                data-testid="cr-review-confirm"
                onClick={handleReview}
                disabled={submitting}
                className={`flex-1 px-4 py-3 text-white rounded-[--radius-button] font-semibold transition-colors cursor-pointer ${
                  reviewAction === 'APPROVE'
                    ? 'bg-status-success hover:bg-status-success/90'
                    : 'bg-status-error hover:bg-status-error/90'
                } disabled:opacity-50`}
              >
                {submitting ? t('processing') : t('confirm')}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
