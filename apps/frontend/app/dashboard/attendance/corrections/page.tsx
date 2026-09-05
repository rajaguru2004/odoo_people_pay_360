'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search, Eye, X as XIcon, Filter as FilterIcon } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import attendanceService from '@/services/attendanceService';
import departmentService from '@/services/departmentService';
import { useAuthStore } from '@/store/authStore';
import { AttendanceCorrection } from '@/types/attendance';
import { formatDate, formatTime, formatDateTime } from '@/utils/formatters';
import { buildUTCFromLocal } from '@/utils/tzDate';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import DataCard from '@/components/common/DataCard';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';

export default function AttendanceCorrectionsPage() {
  const router = useRouter();
  const t = useTranslations('correctionsPage');
  const tc = useTranslations('common');
  const { user } = useAuthStore();
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [corrections, setCorrections] = useState<AttendanceCorrection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formData, setFormData] = useState({
    date: '',
    requestedCheckIn: '',
    requestedCheckOut: '',
    reason: ''
  });
  const [submitting, setSubmitting] = useState(false);
  const [reviewModal, setReviewModal] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [usage, setUsage] = useState<{ used: number; limit: number; unlimited: boolean; remaining: number | null } | null>(null);
  const [expandedReasons, setExpandedReasons] = useState<Set<string>>(new Set());
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([]);
  const [viewCorrection, setViewCorrection] = useState<AttendanceCorrection | null>(null);

  // Filters (HR/Admin view lists every request, so client-side filtering keeps this simple)
  const [filterSearch, setFilterSearch] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterDepartment, setFilterDepartment] = useState('all');

  const toggleReason = (id: string) => {
    setExpandedReasons((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeFilterCount = [filterSearch !== '', filterDate !== '', filterStatus !== 'all', filterDepartment !== 'all'].filter(Boolean).length;

  const handleClearFilters = () => {
    setFilterSearch('');
    setFilterDate('');
    setFilterStatus('all');
    setFilterDepartment('all');
  };

  const filteredCorrections = useMemo(() => {
    return corrections.filter((correction) => {
      const employee = (correction as any).employee;
      if (filterSearch) {
        const term = filterSearch.toLowerCase();
        const matchesSearch =
          employee?.fullName?.toLowerCase().includes(term) ||
          employee?.employeeCode?.toLowerCase().includes(term);
        if (!matchesSearch) return false;
      }
      if (filterDate) {
        const correctionDateKey = new Date(correction.date).toISOString().split('T')[0];
        if (correctionDateKey !== filterDate) return false;
      }
      if (filterStatus !== 'all' && correction.status !== filterStatus) return false;
      if (filterDepartment !== 'all' && employee?.department?.id !== filterDepartment) return false;
      return true;
    });
  }, [corrections, filterSearch, filterDate, filterStatus, filterDepartment]);

  const isHROrAdmin = ['ADMIN', 'HR_MANAGER'].includes(user?.role || '');

  useEffect(() => {
    // Only fetch when user is loaded
    if (user?.id) {
      fetchCorrections();
    }
  }, [user?.id]); // Use user.id instead of user object to avoid array size change

  useEffect(() => {
    if (!isHROrAdmin) return;
    departmentService
      .getAll()
      .then((res: any) => setDepartments((res.data || []).map((d: any) => ({ id: d.id, name: d.name }))))
      .catch(() => {
        // Non-fatal — department filter just won't populate.
      });
  }, [isHROrAdmin]);

  const fetchCorrections = async () => {
    if (!user) return; // Guard clause

    try {
      setLoading(true);
      // HR/ADMIN see all corrections; everyone else sees only their own + usage.
      const response = isHROrAdmin
        ? await attendanceService.getCorrections()
        : await attendanceService.getMyCorrections();

      // Response is already an array (axios interceptor returns response.data)
      const correctionsData = Array.isArray(response) ? response : [];
      setCorrections(correctionsData);

      if (!isHROrAdmin) {
        try {
          const u: any = await attendanceService.getMyCorrectionUsage();
          const data = u?.data ?? u;
          if (data && typeof data.used === 'number') setUsage(data);
        } catch {
          // Non-fatal — badge just won't render.
        }
      }
    } catch (error) {
      console.error('Failed to fetch corrections:', error);
      setCorrections([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.date || !formData.reason) {
      toast.warning(t('fillAllInfo'));
      return;
    }

    if (!formData.requestedCheckIn && !formData.requestedCheckOut) {
      toast.warning(t('fillAtLeastOne'));
      return;
    }

    try {
      setSubmitting(true);

      // Combine date with time into ISO instants — resolved in the COMPANY TZ,
      // since that is the zone the office-hours rules and the daily report use.
      const requestedCheckIn = formData.requestedCheckIn
        ? buildUTCFromLocal(formData.date, formData.requestedCheckIn)
        : undefined;

      const requestedCheckOut = formData.requestedCheckOut
        ? buildUTCFromLocal(formData.date, formData.requestedCheckOut)
        : undefined;

      await attendanceService.createCorrection({
        date: formData.date,
        requestedCheckIn,
        requestedCheckOut,
        reason: formData.reason
      });

      toast.success(t('createSuccess'));
      setShowCreateModal(false);
      setFormData({ date: '', requestedCheckIn: '', requestedCheckOut: '', reason: '' });
      fetchCorrections();
    } catch (error: any) {
      console.error('Failed to create correction:', error);
      let errorMessage = t('createFailed');

      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }

      toast.error(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    const confirmed = await confirm({
      title: t('confirmCancelTitle'),
      message: t('confirmCancelDesc'),
      confirmText: t('cancelRequestBtn'),
      type: 'danger'
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await attendanceService.cancelCorrection(id);
      closeModal();
      toast.success(t('cancelSuccess'));
      fetchCorrections();
    } catch (error: any) {
      console.error('Failed to cancel correction:', error);
      closeModal();
      const errorMessage = error.message || error.response?.data?.message || t('cancelFailed');
      toast.error(errorMessage);
    }
  };

  const openReview = (id: string, action: 'approve' | 'reject') => {
    setReviewNote('');
    setReviewModal({ id, action });
  };

  const handleApproveClick = async (correction: AttendanceCorrection) => {
    const employeeName = (correction as any).employee?.fullName || '';
    const confirmed = await confirm({
      title: t('confirmApproveTitle'),
      message: t('confirmApproveDesc', { name: employeeName, date: formatDate(correction.date) }),
      confirmText: tc('approve'),
      type: 'success',
    });
    if (!confirmed) return;
    closeModal();
    openReview(correction.id, 'approve');
  };

  const handleRejectClick = async (correction: AttendanceCorrection) => {
    const employeeName = (correction as any).employee?.fullName || '';
    const confirmed = await confirm({
      title: t('confirmRejectTitle'),
      message: t('confirmRejectDesc', { name: employeeName, date: formatDate(correction.date) }),
      confirmText: tc('reject'),
      type: 'danger',
    });
    if (!confirmed) return;
    closeModal();
    openReview(correction.id, 'reject');
  };

  const handleReviewSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewModal) return;

    const note = reviewNote.trim();
    if (reviewModal.action === 'reject' && !note) {
      toast.warning(t('enterRejectReason'));
      return;
    }

    try {
      setReviewSubmitting(true);
      if (reviewModal.action === 'approve') {
        await attendanceService.approveCorrection(reviewModal.id, note || undefined);
        toast.success(t('approveSuccess'));
      } else {
        await attendanceService.rejectCorrection(reviewModal.id, note);
        toast.success(t('rejectSuccess'));
      }
      setReviewModal(null);
      setReviewNote('');
      fetchCorrections();
    } catch (error: any) {
      console.error('Failed to review correction:', error);
      const errorMessage = error.message || error.response?.data?.message || t('actionFailed');
      toast.error(errorMessage);
    } finally {
      setReviewSubmitting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      PENDING: 'bg-status-warning-bg text-status-warning',
      APPROVED: 'bg-status-success-bg text-status-success',
      REJECTED: 'bg-status-error-bg text-status-error',
      CANCELLED: 'bg-surface-page text-text-muted'
    };
    const labels = {
      PENDING: tc('pending'),
      APPROVED: tc('approved'),
      REJECTED: tc('rejected'),
      CANCELLED: tc('cancelled')
    };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${styles[status as keyof typeof styles]}`}>
        {labels[status as keyof typeof labels]}
      </span>
    );
  };

  return (
    <>
      <ConfirmDialog />
      <div className="space-y-4 sm:space-y-5" data-testid="ess-corrections">
        {/* Back navigation + request action. The title/description live in the
            sticky TopHeader (declared via usePageHeader above) — repeating them
            here is what made the page render its heading twice. */}
        <PageActionRow
          onBack={() => router.back()}
          action={
            user?.employeeId && !isHROrAdmin ? (
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                {usage && (
                  <div>
                    {usage.unlimited ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-success-bg text-status-success">
                        {usage.used} {t('usedThisMonthUnlimited')}
                      </span>
                    ) : (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                          (usage.remaining ?? 0) <= 0
                            ? 'bg-status-error-bg text-status-error'
                            : 'bg-status-warning-bg text-status-warning'
                        }`}
                      >
                        {usage.used}/{usage.limit} {t('usedThisMonth')} {usage.remaining} {t('left')}
                      </span>
                    )}
                  </div>
                )}
                <button
                  data-testid="correction-new"
                  onClick={() => setShowCreateModal(true)}
                  disabled={!!usage && !usage.unlimited && (usage.remaining ?? 0) <= 0}
                  title={!!usage && !usage.unlimited && (usage.remaining ?? 0) <= 0 ? t('limitReached') : undefined}
                  className="inline-flex w-full md:w-auto items-center justify-center gap-2 h-12 md:h-10 px-4 rounded-lg bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
                >
                  <Plus size={16} />
                  {t('createRequest')}
                </button>
              </div>
            ) : undefined
          }
        />

        {/* Filters */}
        <div className="bg-surface-card rounded-xl border border-surface-border shadow-sm p-3 sm:p-4">
          <div className="flex flex-col lg:flex-row gap-3">
            {isHROrAdmin && (
              <div className="flex-1 relative">
                <Search className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
                <input
                  type="text"
                  placeholder={t('searchEmployeePlaceholder')}
                  value={filterSearch}
                  onChange={(e) => setFilterSearch(e.target.value)}
                  className="w-full ps-9 pe-3 py-2 border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body transition-all"
                />
              </div>
            )}
            <input
              type="date"
              value={filterDate}
              onChange={(e) => setFilterDate(e.target.value)}
              className="w-full md:w-auto md:min-w-[160px] px-3 h-12 md:h-auto md:py-2 border border-surface-border rounded-lg text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body transition-all"
            />
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="w-full md:w-auto md:min-w-[150px] px-3 h-12 md:h-auto md:py-2 border border-surface-border rounded-lg text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body cursor-pointer transition-all"
            >
              <option value="all">{t('statusAll')}</option>
              <option value="PENDING">{tc('pending')}</option>
              <option value="APPROVED">{tc('approved')}</option>
              <option value="REJECTED">{tc('rejected')}</option>
              <option value="CANCELLED">{tc('cancelled')}</option>
            </select>
            {isHROrAdmin && (
              <select
                value={filterDepartment}
                onChange={(e) => setFilterDepartment(e.target.value)}
                className="w-full md:w-auto md:min-w-[180px] px-3 h-12 md:h-auto md:py-2 border border-surface-border rounded-lg text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body cursor-pointer transition-all"
              >
                <option value="all">{t('allDepartments')}</option>
                {departments.map((dept) => (
                  <option key={dept.id} value={dept.id}>{dept.name}</option>
                ))}
              </select>
            )}
            {activeFilterCount > 0 && (
              <button
                onClick={handleClearFilters}
                className="flex items-center justify-center gap-1.5 px-3 py-2 bg-status-error-bg text-status-error rounded-lg border border-status-error/20 hover:bg-status-error-bg/85 font-medium text-sm transition-all"
              >
                <XIcon size={14} />
                {tc('clear')}
              </button>
            )}
          </div>
          {activeFilterCount > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-text-muted">
              <FilterIcon size={12} />
              <span>{t('filteredResultCount', { shown: filteredCorrections.length, total: corrections.length })}</span>
            </div>
          )}
        </div>

        {/* Corrections List */}
        <div className="bg-surface-card rounded-xl border border-surface-border shadow-sm overflow-hidden">
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-page border-b border-surface-border">
                <tr>
                  {user?.role && ['ADMIN', 'HR_MANAGER'].includes(user.role) && (
                    <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium min-w-[150px]">{tc('employee')}</th>
                  )}
                  <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium min-w-[110px]">{tc('date')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium min-w-[120px]">{t('colOriginalTime')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium min-w-[120px]">{t('colRequestedTime')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium min-w-[200px]">{tc('reason')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium min-w-[100px] whitespace-nowrap">{tc('status')}</th>
                  <th className="px-3 py-2.5 text-end text-[11px] uppercase tracking-wide text-text-muted font-medium min-w-[150px]">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {loading ? (
                  [...Array(5)].map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded"></div></td>
                      <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded"></div></td>
                      <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded"></div></td>
                      <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded"></div></td>
                      <td className="px-3 py-2.5"><div className="h-5 bg-surface-page rounded-full"></div></td>
                      <td className="px-3 py-2.5"><div className="h-11 md:h-8 bg-surface-page rounded"></div></td>
                    </tr>
                  ))
                ) : !corrections || corrections.length === 0 ? (
                  <tr>
                    <td colSpan={user?.role && ['ADMIN', 'HR_MANAGER'].includes(user.role) ? 7 : 6} className="px-3 py-10 text-center text-sm text-text-muted">
                      {t('noRequests')}
                    </td>
                  </tr>
                ) : filteredCorrections.length === 0 ? (
                  <tr>
                    <td colSpan={user?.role && ['ADMIN', 'HR_MANAGER'].includes(user.role) ? 7 : 6} className="px-3 py-10 text-center text-sm text-text-muted">
                      {t('noRequestsFiltered')}
                    </td>
                  </tr>
                ) : (
                  filteredCorrections.map((correction, index) => (
                    <motion.tr
                      key={correction.id}
                      data-testid="correction-row"
                      data-correction-id={correction.id}
                      data-status={correction.status}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: index * 0.05 }}
                      className="hover:bg-surface-page transition-colors"
                    >
                      {user?.role && ['ADMIN', 'HR_MANAGER'].includes(user.role) && (
                        <td className="px-3 py-2.5 text-sm text-text-body">
                          <div className="font-medium">{(correction as any).employee?.fullName}</div>
                          <div className="text-xs text-text-muted">{(correction as any).employee?.employeeCode}</div>
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-sm font-medium text-text-heading whitespace-nowrap">
                        {formatDate(correction.date)}
                        <div className="mt-0.5 text-[11px] font-normal text-text-muted whitespace-nowrap">
                          {t('requestDateTime')}: {formatDateTime(correction.createdAt)}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-sm text-text-body min-w-[120px]">
                        {correction.originalCheckIn || correction.originalCheckOut ? (
                          <div className="space-y-1">
                            <div>In: {correction.originalCheckIn ? formatTime(correction.originalCheckIn) : '--:--'}</div>
                            <div>Out: {correction.originalCheckOut ? formatTime(correction.originalCheckOut) : '--:--'}</div>
                          </div>
                        ) : (
                          <span className="text-text-muted italic">{t('noRecord')}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-sm font-medium text-brand-primary min-w-[120px]">
                        <div className="space-y-1">
                          <div>In: {correction.requestedCheckIn ? formatTime(correction.requestedCheckIn) : '--:--'}</div>
                          <div>Out: {correction.requestedCheckOut ? formatTime(correction.requestedCheckOut) : '--:--'}</div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-sm text-text-body max-w-xs">
                        <button
                          type="button"
                          onClick={() => toggleReason(correction.id)}
                          title={correction.reason}
                          className={`text-start w-full ${expandedReasons.has(correction.id) ? 'whitespace-normal break-words' : 'truncate'}`}
                        >
                          {correction.reason}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {getStatusBadge(correction.status)}
                        {correction.status !== 'PENDING' && correction.status !== 'CANCELLED' && (
                          <p className="mt-1 text-[11px] text-text-muted whitespace-normal">
                            {t('reviewedBy')}: {correction.reviewer?.fullName || '—'}
                            {correction.approvedAt && <> · {formatDate(correction.approvedAt)}</>}
                          </p>
                        )}
                        {correction.status === 'REJECTED' && correction.rejectedReason && (
                          <p className="mt-1 text-xs text-status-error max-w-[200px] whitespace-normal">{correction.rejectedReason}</p>
                        )}
                        {correction.status === 'APPROVED' && correction.approverNotes && (
                          <p className="mt-1 text-xs text-text-muted max-w-[200px] whitespace-normal">{correction.approverNotes}</p>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-end">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => setViewCorrection(correction)}
                            title={t('viewDetails')}
                            className="h-8 w-8 inline-flex items-center justify-center text-text-muted hover:text-text-heading hover:bg-surface-page rounded-lg transition-colors"
                          >
                            <Eye size={16} />
                          </button>
                          {correction.status === 'PENDING' && user?.role && ['ADMIN', 'HR_MANAGER'].includes(user.role) && (
                            <>
                              <button
                                data-testid="correction-approve"
                                onClick={() => handleApproveClick(correction)}
                                className="h-11 md:h-8 px-3 text-sm font-medium text-status-success hover:bg-status-success-bg rounded-lg transition-colors"
                              >
                                {tc('approve')}
                              </button>
                              <button
                                data-testid="correction-reject"
                                onClick={() => handleRejectClick(correction)}
                                className="h-11 md:h-8 px-3 text-sm font-medium text-status-error hover:bg-status-error-bg rounded-lg transition-colors"
                              >
                                {tc('reject')}
                              </button>
                            </>
                          )}
                          {correction.status === 'PENDING' && correction.employeeId === user?.employeeId && (
                            <button
                              onClick={() => handleCancel(correction.id)}
                              className="h-11 md:h-8 px-3 text-sm font-medium text-status-error hover:bg-status-error-bg rounded-lg transition-colors"
                            >
                              {t('cancelRequestBtn')}
                            </button>
                          )}
                        </div>
                      </td>
                    </motion.tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden p-4 space-y-3">
            {loading ? (
              [...Array(4)].map((_, i) => (
                <div key={i} className="rounded-xl border border-surface-border bg-surface-card p-4 animate-pulse">
                  <div className="h-4 w-32 bg-surface-page rounded" />
                  <div className="mt-3 h-3 w-full bg-surface-page rounded" />
                  <div className="mt-2 h-3 w-2/3 bg-surface-page rounded" />
                </div>
              ))
            ) : !corrections || corrections.length === 0 ? (
              <div className="py-10 text-center text-sm text-text-muted">
                {t('noRequests')}
              </div>
            ) : filteredCorrections.length === 0 ? (
              <div className="py-10 text-center text-sm text-text-muted">
                {t('noRequestsFiltered')}
              </div>
            ) : (
              filteredCorrections.map((correction) => (
                <DataCard
                  key={correction.id}
                  title={
                    isHROrAdmin ? (
                      <div className="min-w-0">
                        <div className="truncate">{(correction as any).employee?.fullName}</div>
                        <div className="text-xs font-normal text-text-muted">
                          {(correction as any).employee?.employeeCode} · {formatDate(correction.date)}
                        </div>
                      </div>
                    ) : (
                      formatDate(correction.date)
                    )
                  }
                  headerRight={getStatusBadge(correction.status)}
                  items={[
                    { label: t('requestDateTime'), value: formatDateTime(correction.createdAt), full: true },
                    {
                      label: t('colOriginalTime'),
                      value: correction.originalCheckIn || correction.originalCheckOut ? (
                        <>
                          <div>In: {correction.originalCheckIn ? formatTime(correction.originalCheckIn) : '--:--'}</div>
                          <div>Out: {correction.originalCheckOut ? formatTime(correction.originalCheckOut) : '--:--'}</div>
                        </>
                      ) : (
                        <span className="text-text-muted italic">{t('noRecord')}</span>
                      ),
                    },
                    {
                      label: t('colRequestedTime'),
                      value: (
                        <span className="font-medium text-brand-primary">
                          <div>In: {correction.requestedCheckIn ? formatTime(correction.requestedCheckIn) : '--:--'}</div>
                          <div>Out: {correction.requestedCheckOut ? formatTime(correction.requestedCheckOut) : '--:--'}</div>
                        </span>
                      ),
                    },
                    { label: tc('reason'), value: correction.reason || '—', full: true },
                    ...(correction.status !== 'PENDING' && correction.status !== 'CANCELLED'
                      ? [{
                          label: t('reviewedBy'),
                          value: `${correction.reviewer?.fullName || '—'}${correction.approvedAt ? ` · ${formatDate(correction.approvedAt)}` : ''}`,
                          full: true,
                        }]
                      : []),
                    ...(correction.status === 'REJECTED' && correction.rejectedReason
                      ? [{ label: t('rejectionReason'), value: <span className="text-status-error">{correction.rejectedReason}</span>, full: true }]
                      : []),
                    ...(correction.status === 'APPROVED' && correction.approverNotes
                      ? [{ label: t('approverRemarks'), value: correction.approverNotes, full: true }]
                      : []),
                  ]}
                  footer={
                    <>
                      <button
                        onClick={() => setViewCorrection(correction)}
                        className="h-11 md:h-8 px-3 text-sm font-medium text-text-body hover:bg-surface-page rounded-lg transition-colors inline-flex items-center gap-1.5"
                      >
                        <Eye size={14} />
                        {t('viewDetails')}
                      </button>
                      {correction.status === 'PENDING' && isHROrAdmin && (
                        <>
                          <button
                            onClick={() => handleApproveClick(correction)}
                            className="h-11 md:h-8 px-3 text-sm font-medium text-status-success hover:bg-status-success-bg rounded-lg transition-colors"
                          >
                            {tc('approve')}
                          </button>
                          <button
                            onClick={() => handleRejectClick(correction)}
                            className="h-11 md:h-8 px-3 text-sm font-medium text-status-error hover:bg-status-error-bg rounded-lg transition-colors"
                          >
                            {tc('reject')}
                          </button>
                        </>
                      )}
                      {correction.status === 'PENDING' && correction.employeeId === user?.employeeId && (
                        <button
                          onClick={() => handleCancel(correction.id)}
                          className="h-11 md:h-8 px-3 text-sm font-medium text-status-error hover:bg-status-error-bg rounded-lg transition-colors"
                        >
                          {t('cancelRequestBtn')}
                        </button>
                      )}
                    </>
                  }
                />
              ))
            )}
          </div>
        </div>

        {/* Create Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50 md:items-center md:p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-surface-overlay rounded-t-2xl md:rounded-xl p-4 sm:p-6 max-w-2xl w-full max-h-[88svh] md:max-h-[90vh] overflow-y-auto border border-surface-border"
            >
              <h2 className="text-lg sm:text-xl font-semibold text-text-heading mb-4">{t('createRequestTitle')}</h2>

              <form data-testid="correction-form" onSubmit={handleSubmit} className="space-y-3">
                {/* Date */}
                <div>
                  <label className="block text-xs font-medium text-text-body mb-1">
                    {t('dateToAdjust')} <span className="text-status-error">*</span>
                  </label>
                  <input
                    data-testid="correction-date"
                    type="date"
                    value={formData.date}
                    onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                    max={new Date().toISOString().split('T')[0]}
                    required
                    className="h-10 px-3 rounded-lg border border-surface-border text-sm w-full focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {/* Check-in Time */}
                  <div>
                    <label className="block text-xs font-medium text-text-body mb-1">
                      {tc('checkInLower')}
                    </label>
                    <input
                      data-testid="correction-in"
                      type="time"
                      value={formData.requestedCheckIn}
                      onChange={(e) => setFormData({ ...formData, requestedCheckIn: e.target.value })}
                      className="h-10 px-3 rounded-lg border border-surface-border text-sm w-full focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body"
                    />
                  </div>

                  {/* Check-out Time */}
                  <div>
                    <label className="block text-xs font-medium text-text-body mb-1">
                      {tc('checkOutLower')}
                    </label>
                    <input
                      data-testid="correction-out"
                      type="time"
                      value={formData.requestedCheckOut}
                      onChange={(e) => setFormData({ ...formData, requestedCheckOut: e.target.value })}
                      className="h-10 px-3 rounded-lg border border-surface-border text-sm w-full focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body"
                    />
                  </div>
                </div>

                {/* Reason */}
                <div>
                  <label className="block text-xs font-medium text-text-body mb-1">
                    {tc('reason')} <span className="text-status-error">*</span>
                  </label>
                  <textarea
                    data-testid="correction-reason"
                    value={formData.reason}
                    onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                    rows={4}
                    required
                    placeholder={t('reasonPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg border border-surface-border text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body"
                  />
                </div>

                {/* Actions */}
                <div className="flex gap-3 pt-1">
                  <button
                    data-testid="correction-submit"
                    type="submit"
                    disabled={submitting}
                    className="flex-1 inline-flex items-center justify-center h-10 px-4 rounded-lg bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitting ? tc('sending') : 'Send request'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="inline-flex items-center justify-center h-10 px-4 rounded-lg border border-surface-border text-sm font-medium text-text-body hover:bg-surface-page transition-colors"
                  >
                    {tc('cancel')}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {/* Approve / Reject Modal */}
        {reviewModal && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50 md:items-center md:p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-surface-overlay rounded-xl p-4 sm:p-6 max-w-lg w-full border border-surface-border"
            >
              <h2 className="text-lg sm:text-xl font-semibold text-text-heading mb-1">
                {reviewModal.action === 'approve' ? t('approveRequestTitle') : t('rejectRequestTitle')}
              </h2>
              <p className="text-xs sm:text-sm text-text-muted mb-4">
                {reviewModal.action === 'approve'
                  ? t('approveDesc')
                  : t('rejectDesc')}
              </p>

              <form data-testid="correction-review-modal" onSubmit={handleReviewSubmit} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-text-body mb-1">
                    {reviewModal.action === 'approve' ? t('noteOptional') : t('rejectionReason')}
                    {reviewModal.action === 'reject' && <span className="text-status-error"> *</span>}
                  </label>
                  <textarea
                    data-testid="correction-review-note"
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                    rows={4}
                    required={reviewModal.action === 'reject'}
                    autoFocus
                    placeholder={reviewModal.action === 'approve' ? t('rejectReasonExample') : t('rejectReasonPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg border border-surface-border text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body"
                  />
                </div>

                <div className="flex gap-3 pt-1">
                  <button
                    data-testid="correction-review-submit"
                    type="submit"
                    disabled={reviewSubmitting}
                    className={`flex-1 inline-flex items-center justify-center h-10 px-4 rounded-lg text-sm font-medium text-text-on-brand transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${reviewModal.action === 'approve' ? 'bg-status-success hover:opacity-90' : 'bg-status-error hover:opacity-90'}`}
                  >
                    {reviewSubmitting ? tc('submitting') : reviewModal.action === 'approve' ? tc('approve') : tc('reject')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setReviewModal(null)}
                    className="inline-flex items-center justify-center h-10 px-4 rounded-lg border border-surface-border text-sm font-medium text-text-body hover:bg-surface-page transition-colors"
                  >
                    {tc('cancel')}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {/* View Details Modal */}
        {viewCorrection && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50 md:items-center md:p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-surface-overlay rounded-xl p-4 sm:p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto border border-surface-border"
            >
              <div className="flex items-start justify-between gap-3 mb-4">
                <h2 className="text-lg sm:text-xl font-semibold text-text-heading">{t('requestDetailsTitle')}</h2>
                <button
                  onClick={() => setViewCorrection(null)}
                  className="p-1.5 text-text-muted hover:text-text-heading hover:bg-surface-page rounded-lg transition-colors"
                >
                  <XIcon size={18} />
                </button>
              </div>

              <div className="space-y-3 text-sm">
                {isHROrAdmin && (
                  <div className="flex justify-between gap-3">
                    <span className="text-text-muted">{t('requestedBy')}</span>
                    <span className="font-medium text-text-heading text-end">
                      {(viewCorrection as any).employee?.fullName}
                      {(viewCorrection as any).employee?.employeeCode && (
                        <span className="text-text-muted"> ({(viewCorrection as any).employee.employeeCode})</span>
                      )}
                    </span>
                  </div>
                )}

                <div className="flex justify-between gap-3">
                  <span className="text-text-muted">{t('dateBeingAdjusted')}</span>
                  <span className="font-medium text-text-heading">{formatDate(viewCorrection.date)}</span>
                </div>

                <div className="flex justify-between gap-3">
                  <span className="text-text-muted">{t('requestDateTime')}</span>
                  <span className="font-medium text-text-heading">{formatDateTime(viewCorrection.createdAt)}</span>
                </div>

                <div className="flex justify-between gap-3">
                  <span className="text-text-muted">{t('colOriginalTime')}</span>
                  <span className="font-medium text-text-heading text-end">
                    {viewCorrection.originalCheckIn || viewCorrection.originalCheckOut ? (
                      <>In: {viewCorrection.originalCheckIn ? formatTime(viewCorrection.originalCheckIn) : '--:--'} · Out: {viewCorrection.originalCheckOut ? formatTime(viewCorrection.originalCheckOut) : '--:--'}</>
                    ) : (
                      <span className="text-text-muted italic">{t('noRecord')}</span>
                    )}
                  </span>
                </div>

                <div className="flex justify-between gap-3">
                  <span className="text-text-muted">{t('colRequestedTime')}</span>
                  <span className="font-medium text-brand-primary text-end">
                    In: {viewCorrection.requestedCheckIn ? formatTime(viewCorrection.requestedCheckIn) : '--:--'} · Out: {viewCorrection.requestedCheckOut ? formatTime(viewCorrection.requestedCheckOut) : '--:--'}
                  </span>
                </div>

                <div>
                  <div className="text-text-muted mb-1">{tc('reason')}</div>
                  <div className="font-medium text-text-heading whitespace-normal break-words bg-surface-page rounded-lg p-2.5">
                    {viewCorrection.reason}
                  </div>
                </div>

                <div className="flex justify-between gap-3 items-center">
                  <span className="text-text-muted">{tc('status')}</span>
                  {getStatusBadge(viewCorrection.status)}
                </div>

                {viewCorrection.status !== 'PENDING' && viewCorrection.status !== 'CANCELLED' && (
                  <>
                    <div className="flex justify-between gap-3">
                      <span className="text-text-muted">{t('reviewedBy')}</span>
                      <span className="font-medium text-text-heading">{viewCorrection.reviewer?.fullName || t('notReviewedYet')}</span>
                    </div>
                    {viewCorrection.approvedAt && (
                      <div className="flex justify-between gap-3">
                        <span className="text-text-muted">{t('decisionDate')}</span>
                        <span className="font-medium text-text-heading">{formatDateTime(viewCorrection.approvedAt)}</span>
                      </div>
                    )}
                    {(viewCorrection.approverNotes || viewCorrection.rejectedReason) && (
                      <div>
                        <div className="text-text-muted mb-1">{t('approverRemarks')}</div>
                        <div className={`font-medium whitespace-normal break-words rounded-lg p-2.5 ${viewCorrection.status === 'REJECTED' ? 'text-status-error bg-status-error-bg' : 'text-text-heading bg-surface-page'}`}>
                          {viewCorrection.approverNotes || viewCorrection.rejectedReason}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="pt-4">
                <button
                  onClick={() => setViewCorrection(null)}
                  className="w-full inline-flex items-center justify-center h-10 px-4 rounded-lg border border-surface-border text-sm font-medium text-text-body hover:bg-surface-page transition-colors"
                >
                  {tc('close')}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </div>
    </>
  );
}
