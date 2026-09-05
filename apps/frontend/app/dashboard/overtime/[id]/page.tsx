'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Clock, User, FileText, CheckCircle, XCircle, Loader2, Calendar } from 'lucide-react';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import overtimeService from '@/services/overtimeService';
import approvalWorkflowService, { ApprovalTrail } from '@/services/approvalWorkflowService';
import holidayService from '@/services/holidayService';
import { Overtime, OtType, ApproveOvertimeData } from '@/types/overtime';
import OvertimeReviewModal from '@/components/approvals/OvertimeReviewModal';
import { apiErrorMessage } from '@/utils/apiError';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { usePermission } from '@/hooks/usePermission';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { formatCurrency, getCompanyTz, formatWallClockDate, formatWallClockTime } from '@/utils/formatters';
import { computeOvertimePreview, parseThresholdMinutes } from '@/utils/overtimeCalc';
import { hourlyRateFor, isDailyWage, toSalaryBasis } from '@/utils/payBasis';

const getStatusLabels = (tc: (key: string) => string): Record<string, { label: string; color: string }> => ({
  PENDING: { label: tc('pending'), color: 'bg-status-warning-bg text-status-warning border-status-warning/20' },
  APPROVED: { label: tc('approved'), color: 'bg-status-success-bg text-status-success border-status-success/20' },
  REJECTED: { label: tc('rejected'), color: 'bg-status-error-bg text-status-error border-status-error/20' },
  CANCELLED: { label: tc('cancelled'), color: 'bg-surface-page text-text-muted border-surface-border' },
});

const otTypeColors: Record<OtType, string> = {
  REGULAR: 'bg-brand-primary-light/20 text-brand-primary border-brand-primary/20',
  LATE: 'bg-status-warning-bg text-status-warning border-status-warning/20',
  DOUBLE: 'bg-status-error-bg text-status-error border-status-error/20',
  DOUBLE_LATE: 'bg-status-error-bg text-status-error border-status-error/20',
};

export default function OvertimeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useTranslations('overtimeDetailPage');
  const tc = useTranslations('common');
  const tOvertime = useTranslations('overtimePage');
  const tMyOvertime = useTranslations('myOvertimePage');
  const router = useRouter();
  const { id } = use(params);
  const { user } = useAuthStore();
  const { branding } = useBrandingStore();
  const { can } = usePermission();
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();

  // The one heading for this route, rendered by TopHeader. Declared ahead of the
  // loading / not-found returns below so the hook always runs.
  usePageHeader(t('title'));

  const [overtime, setOvertime] = useState<Overtime | null>(null);
  const [trail, setTrail] = useState<ApprovalTrail | null>(null);
  const [loading, setLoading] = useState(true);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  // Actual work days for the overtime's month/branch, feeding the same
  // hourlyRateFor() formula the payroll engine uses
  // (apps/backend/src/payrolls/payroll-earnings.util.ts) instead of a hardcoded
  // "22 days" assumption. Not needed for daily-wage staff, whose day rate is
  // divided by one day's hours regardless of the month's length.
  const [workDays, setWorkDays] = useState<number | null>(null);
  const [holidays, setHolidays] = useState<any[]>([]);

  useEffect(() => {
    fetchOvertimeDetail();
  }, [id]);

  useEffect(() => {
    holidayService
      .getAll()
      .then((res: any) => {
        if (res?.success && Array.isArray(res.data)) setHolidays(res.data);
      })
      .catch((err) => console.error('Failed to load holidays:', err));
  }, []);

  useEffect(() => {
    if (!overtime?.date) return;
    // A daily-wage employee's hourly rate has no work-days denominator, so skip
    // the request entirely rather than gating the rate on a response we ignore.
    if (isDailyWage(overtime.employee?.salaryType)) return;
    const d = new Date(overtime.date);
    // Pass the employee's branchId so the workDays denominator matches the
    // branch-aware value payroll uses (weekly-offs + holidays per branch).
    // Without it the hourly rate diverges and the OT estimate mismatches the payslip.
    holidayService
      .calculateWorkDays(d.getUTCMonth() + 1, d.getUTCFullYear(), overtime.employee?.branchId ?? undefined)
      .then((res: any) => {
        const data = res?.data ?? res;
        if (data?.workDays) setWorkDays(data.workDays);
      })
      .catch((err) => console.error('Failed to load work days:', err));
  }, [overtime?.date, overtime?.employee?.branchId]);

  const fetchOvertimeDetail = async () => {
    try {
      setLoading(true);
      const response = await overtimeService.getById(id);
      // Handle both wrapped and unwrapped responses
      const data = response.data || response;
      setOvertime(data);
      // Who may decide is a property of the CHAIN, not of the viewer's role —
      // ask the engine rather than guessing here.
      try {
        const tr = await approvalWorkflowService.trail('OVERTIME', id);
        setTrail((tr as any)?.data ?? null);
      } catch {
        setTrail(null);
      }
    } catch (error) {
      console.error('Failed to fetch overtime detail:', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  /**
   * The SAME payload path the approvals inbox uses. Both screens approve
   * overtime, so a correction offered on one and not the other would be a
   * screen that quietly refuses a supported action — and worse, two approve
   * calls that could drift apart.
   */
  const handleApprove = async (payload?: ApproveOvertimeData) => {
    try {
      setConfirmLoading(true);
      const res: any = await overtimeService.approve(id, payload);
      closeModal();
      const updated = res?.data ?? res;
      if (updated?.status === 'APPROVED') {
        toast.success(t('approveSuccess'));
      } else {
        // A multi-step chain: this step is done but the request is still open.
        toast.success('Your approval is recorded. The request now moves to the next approver.');
      }
      setShowReviewModal(false);
      fetchOvertimeDetail();
    } catch (error: any) {
      console.error('Failed to approve:', error);
      closeModal();
      toast.error(apiErrorMessage(error, t('approveFailedFallback')));
      // Rethrown so the review modal stays open on a refusal, with the
      // approver's typed corrections still on screen.
      throw error;
    }
  };

  const handleReject = async (explicitReason?: string) => {
    const text = (explicitReason ?? rejectReason).trim();
    if (!text) {
      toast.warning(t('enterRejectReason'));
      return;
    }

    try {
      await overtimeService.reject(id, { rejectedReason: text });
      toast.success(t('rejectSuccess'));
      setShowRejectModal(false);
      setShowReviewModal(false);
      fetchOvertimeDetail();
    } catch (error: any) {
      console.error('Failed to reject:', error);
      toast.error(apiErrorMessage(error, t('rejectFailedFallback')));
      throw error;
    }
  };

  const handleCancel = async () => {
    const confirmed = await confirm({
      title: t('cancelConfirmTitle'),
      message: t('cancelConfirmMessage'),
      confirmText: t('cancelConfirmText'),
      type: 'danger'
    });

    if (!confirmed) return;

    try {
      setConfirmLoading(true);
      await overtimeService.cancel(id);
      closeModal();
      toast.success(t('cancelSuccess'));
      router.push(user?.role === 'EMPLOYEE' ? '/dashboard/my-overtime' : '/dashboard/overtime');
    } catch (error: any) {
      console.error('Failed to cancel:', error);
      closeModal();
      toast.error(error.response?.data?.message || t('cancelFailedFallback'));
    }
  };

  // With a configured approval chain the eligible approver may be a supervisor
  // (an EMPLOYEE-role user) or a department manager, so the caller's role says
  // nothing about whether they may decide — the engine does. Only fall back to
  // the legacy role rule when no chain governs this request.
  const legacyCanApprove =
    !!user?.role && ['ADMIN', 'HR_MANAGER'].includes(user.role);
  const canApprove =
    overtime?.status === 'PENDING' &&
    (trail?.engaged ? trail.canAct : legacyCanApprove);
  const canCancel = overtime?.status === 'PENDING' && overtime?.employeeId === user?.employeeId;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-primary" />
      </div>
    );
  }

  if (!overtime) {
    return (
      <div data-testid="ot-not-found" className="text-center py-12">
        <p className="text-text-muted">{t('notFound')}</p>
      </div>
    );
  }

  const statusLabels = getStatusLabels(tc);
  const status = statusLabels[overtime.status] ?? { label: overtime.status, color: 'bg-surface-page text-text-muted border-surface-border' };

  const serverPreview = overtime.preview ?? null;
  const num = (v: number | string | undefined) => Number(v ?? 0) || 0;

  // A double day's post-threshold hours live in their own bucket
  // (doubleLateHours) with their own multiplier; they are folded into the
  // "late" display row, so that row's rate follows whichever bucket is filled.
  const serverLateHours = num(serverPreview?.lateHours);
  const serverDoubleLateHours = num(serverPreview?.doubleLateHours);

  const regularRate = serverPreview
    ? serverPreview.regularRate
    : parseFloat(branding?.overtime_regular_rate || '1.5') || 1.5;
  const lateRate = serverPreview
    ? serverDoubleLateHours > 0 && serverLateHours === 0
      ? serverPreview.doubleLateRate
      : serverPreview.lateRate
    : parseFloat(branding?.overtime_late_rate || '1.5') || 1.5;
  const doubleRate = serverPreview
    ? serverPreview.doubleRate
    : parseFloat(branding?.overtime_double_rate || '2.0') || 2.0;

  // Day classification for the overtime date (UTC — dates are stored UTC-midnight).
  const otDate = new Date(overtime.date);
  const dateKey = overtime.date?.slice(0, 10);
  const isSunday = otDate.getUTCDay() === 0;
  const isHoliday = holidays.some(
    (h) => new Date(h.date).toISOString().split('T')[0] === dateKey,
  );
  const isDoubleDay = (isSunday || isHoliday) && !!branding?.overtime_double_ot_enabled;

  // Fallback recomputation from the GLOBAL settings, used only when the API
  // response carries no server `preview` (older backend build). It cannot see
  // per-employee Overtime Policy overrides — prefer `preview` below.
  const localPreview = computeOvertimePreview(
    new Date(overtime.startTime),
    new Date(overtime.endTime),
    isDoubleDay,
    {
      regularRate,
      lateRate,
      doubleRate,
      doubleOtEnabled: !!branding?.overtime_double_ot_enabled,
      lateThresholdMinutes: parseThresholdMinutes(branding?.overtime_late_threshold || '22:00', 1320),
      dayBoundaryMinutes: parseThresholdMinutes(branding?.attendance_day_end_time || '23:59', 1439),
      foodAllowanceEnabled: !!branding?.overtime_food_allowance_enabled,
      foodAllowanceThresholdMinutes: parseThresholdMinutes(
        branding?.overtime_food_allowance_threshold || branding?.overtime_late_threshold || '22:00',
        1320,
      ),
      foodAllowanceAmount: parseFloat(branding?.overtime_food_allowance_amount || '150') || 0,
      doubleFoodAllowanceAnyTime: !!branding?.overtime_double_food_allowance_any_time,
    },
  );

  // The server ships the breakdown it will actually persist on approval:
  // resolved Overtime Policy thresholds/rates + branch-aware day type. The
  // local mirror reads the GLOBAL settings only, so any policy override made
  // this page disagree with the list and the payslip — a request the server
  // classified LATE with a food allowance rendered here as REGULAR with a
  // blank allowance. Keep the mirror solely as a fallback for payloads
  // without `preview` (older API build).
  const preview = serverPreview
    ? {
        totalHours: num(serverPreview.hours),
        regularHours: num(serverPreview.regularHours),
        lateHours: serverLateHours + serverDoubleLateHours,
        doubleHours: num(serverPreview.doubleHours),
        otType: serverPreview.otType,
        foodAllowance: num(serverPreview.foodAllowance),
      }
    : localPreview;

  const workHoursPerDay = parseFloat(branding?.payroll_work_hours_per_day || '8') || 8;
  // Use the full-precision hourly rate when applying tier rates, matching the
  // backend payslip (overtimeRowTier). The rate is displayed rounded to 2dp for
  // readability, but rounding it BEFORE multiplying would drop the sub-cent
  // portion of every hour and understate the total.
  // Mirrors the backend's hourlyRateFor: a monthly salary spreads over the
  // month's work days AND the day's hours; a daily rate divides by the day's
  // hours alone. Using the monthly formula on a day rate understated every
  // daily-wage OT estimate by a factor of the month's work days (~26x).
  const employeeBasis = toSalaryBasis(overtime.employee?.salaryType);
  const hourlyRate = hourlyRateFor(
    employeeBasis,
    Number(overtime.employee?.baseSalary) || 0,
    workDays ?? 0,
    workHoursPerDay,
  );
  const overtimePay =
    hourlyRate *
    (preview.regularHours * regularRate +
      preview.lateHours * lateRate +
      preview.doubleHours * doubleRate);
  const foodAllowance = preview.foodAllowance;
  const otTypeLabels: Record<OtType, string> = {
    REGULAR: t('otTypeRegular'),
    LATE: t('otTypeLateOt'),
    DOUBLE: t('otTypeDoubleOt'),
    DOUBLE_LATE: t('otTypeDoubleLate'),
  };
  const otType = preview.otType;

  return (
    <>
      <ConfirmDialog />
      <div className="space-y-6" data-testid="ess-overtime-detail">
        {/* Back + breadcrumb + status. The title lives in the sticky TopHeader
            (declared via usePageHeader above). The parent crumb is gated on the
            same permission the destination enforces — an EMPLOYEE reaches this
            page for their own request but has no VIEW_ALL_OVERTIME, so their
            list is /dashboard/my-overtime. */}
        <div data-testid="ot-detail" data-overtime-id={overtime.id} className="contents" />
        <PageActionRow
          onBack={() => router.back()}
          action={
            <div data-testid="overtime-status" data-status={overtime.status} className={`px-4 py-2 rounded-[--radius-button] border-2 font-semibold ${status.color}`}>
              {status.label}
            </div>
          }
        />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Info */}
          <div className="lg:col-span-2 space-y-6">
            {/* Employee Info */}
            <div className="bg-surface-card rounded-[--radius-card] p-4 md:p-6 border border-surface-border">
              <h2 className="text-xl font-bold text-text-heading mb-4">{t('employeeInfoHeading')}</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-text-muted mb-1">{t('fullNameLabel')}</p>
                  <p className="font-semibold text-text-heading wrap-break-word">{overtime.employee?.fullName || tc('notAvailable')}</p>
                </div>
                <div>
                  <p className="text-sm text-text-muted mb-1">{t('employeeIdLabel')}</p>
                  <p className="font-semibold text-text-heading">{overtime.employee?.employeeCode || tc('notAvailable')}</p>
                </div>
                <div>
                  <p className="text-sm text-text-muted mb-1">{tc('department')}</p>
                  <p className="font-semibold text-text-heading">{overtime.employee?.department?.name || tc('notAvailable')}</p>
                </div>
                <div>
                  <p className="text-sm text-text-muted mb-1">{tc('email')}</p>
                  <p className="font-semibold text-text-heading">{overtime.employee?.email || tc('notAvailable')}</p>
                </div>
              </div>
            </div>

            {/* Overtime Details */}
            <div className="bg-surface-card rounded-[--radius-card] p-4 md:p-6 border border-surface-border">
              <h2 className="text-xl font-bold text-text-heading mb-4">{t('overtimeInfoHeading')}</h2>
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-brand-primary-light/20 rounded-[--radius-button] flex items-center justify-center">
                    <Calendar className="text-brand-primary" size={20} />
                  </div>
                  <div>
                    <p className="text-sm text-text-muted">{t('overtimeDayLabel')}</p>
                    <p className="font-semibold text-text-heading">{formatWallClockDate(overtime.date)}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-status-success-bg rounded-[--radius-button] flex items-center justify-center">
                    <Clock className="text-status-success" size={20} />
                  </div>
                  <div>
                    <p className="text-sm text-text-muted">{t('timeLabel')}</p>
                    <p className="font-semibold text-text-heading">
                      {formatWallClockTime(overtime.startTime)} - {formatWallClockTime(overtime.endTime)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-brand-primary-light/20 rounded-[--radius-button] flex items-center justify-center">
                    <Clock className="text-brand-primary" size={20} />
                  </div>
                  <div>
                    <p className="text-sm text-text-muted">{t('colNumberOfHours')}</p>
                    <p className="font-semibold text-text-heading">{t('hoursValue', { hours: preview.totalHours })}</p>
                  </div>
                </div>

                {/* Payable calculation (live, per current settings — what approval persists) */}
                <div
                  data-testid="ot-breakdown"
                  data-ot-type={otType}
                  data-total-hours={preview.totalHours}
                  data-food-allowance={foodAllowance}
                  className="bg-surface-page/60 border border-surface-border rounded-[--radius-card] p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-text-heading">{t('calcBreakdownHeading')}</p>
                    <span className={`inline-block px-2.5 py-1 rounded-[--radius-badge] text-xs font-medium border ${otTypeColors[otType]}`}>
                      {otTypeLabels[otType]}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                    {preview.regularHours > 0 && (
                      <div>
                        <p className="text-text-muted">{t('tierRegular')} · {t('rateRegularOt', { rate: regularRate })}</p>
                        <p data-testid="ot-breakdown-tier" data-tier="regular" data-hours={preview.regularHours} className="font-semibold text-text-heading mt-0.5">{t('hoursShort', { hours: preview.regularHours })}</p>
                      </div>
                    )}
                    {preview.lateHours > 0 && (
                      <div>
                        <p className="text-text-muted">{t('tierLate')} · {t('rateLateOt', { rate: lateRate })}</p>
                        <p data-testid="ot-breakdown-tier" data-tier="late" data-hours={preview.lateHours} className="font-semibold text-text-heading mt-0.5">{t('hoursShort', { hours: preview.lateHours })}</p>
                      </div>
                    )}
                    {preview.doubleHours > 0 && (
                      <div>
                        <p className="text-text-muted">{t('tierDouble')} · {t('rateDoubleOt', { rate: doubleRate })}</p>
                        <p data-testid="ot-breakdown-tier" data-tier="double" data-hours={preview.doubleHours} className="font-semibold text-text-heading mt-0.5">{t('hoursShort', { hours: preview.doubleHours })}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-text-muted">{t('foodAllowanceLabel')}</p>
                      <p className={`font-semibold mt-0.5 ${foodAllowance > 0 ? 'text-status-success' : 'text-text-muted'}`}>
                        {foodAllowance > 0 ? formatCurrency(foodAllowance) : '—'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-surface-border">
                  <p className="text-sm text-text-muted mb-2">{tc('reason')}</p>
                  <p className="text-text-body whitespace-pre-wrap">{overtime.reason}</p>
                </div>
              </div>
            </div>

            {/* Rejection Reason */}
            {overtime.status === 'REJECTED' && overtime.rejectedReason && (
              <div className="bg-status-error-bg border border-status-error/20 rounded-[--radius-card] p-6">
                <h2 className="text-xl font-bold text-status-error mb-4">{t('rejectionReasonHeading')}</h2>
                <p data-testid="ot-rejection-reason" className="text-status-error whitespace-pre-wrap">{overtime.rejectedReason}</p>
              </div>
            )}
          </div>

          {/* Actions & Info */}
          <div className="space-y-4">
            {canApprove && (
              <>
                <button
                  data-testid="overtime-approve"
                  onClick={() => setShowReviewModal(true)}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-status-success text-white rounded-[--radius-button] font-semibold hover:opacity-90 hover:shadow-lg transition-all"
                >
                  <CheckCircle size={20} />
                  {t('acceptBtn')}
                </button>

                <button
                  data-testid="overtime-reject-open"
                  onClick={() => setShowRejectModal(true)}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-status-error text-white rounded-[--radius-button] font-semibold hover:opacity-90 hover:shadow-lg transition-all"
                >
                  <XCircle size={20} />
                  {t('rejectBtn')}
                </button>
              </>
            )}

            {canCancel && (
              <button
                data-testid="overtime-cancel"
                onClick={handleCancel}
                className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-surface-border-light text-text-body border border-surface-border rounded-[--radius-button] font-semibold hover:bg-surface-border transition-all"
              >
                <XCircle size={20} />
                {t('cancelOrderBtn')}
              </button>
            )}

            {/* Expected overtime pay — shown for ALL statuses (incl. PENDING) so
                the approver sees the payable amount before deciding. */}
            {(overtimePay > 0 || foodAllowance > 0) && (
              <div
                data-testid="ot-pay"
                data-total={overtimePay + foodAllowance}
                data-hourly-rate={hourlyRate}
                className="bg-gradient-to-br from-brand-primary to-brand-primary-dark rounded-[--radius-card] p-6 text-white shadow-lg"
              >
                <h3 className="font-bold mb-2">{t('expectedSalaryHeading')}</h3>
                <p className="text-3xl font-bold">{formatCurrency(overtimePay + foodAllowance)}</p>

                {/* Step-by-step breakdown so the number is self-explanatory */}
                {hourlyRate > 0 && (
                  <div className="mt-4 pt-3 border-t border-white/20 space-y-1.5 text-sm">
                    <p className="text-white/70 font-medium text-xs uppercase tracking-wide mb-1">{t('calcBreakdownTitle')}</p>
                    <div className="flex justify-between text-white/80">
                      <span>
                        {t('calcHourlyRate')}
                        <span className="block text-[11px] text-white/55 font-normal">
                          {isDailyWage(employeeBasis)
                            ? t('hourlyRateFromDaily', {
                                rate: formatCurrency(Number(overtime.employee?.baseSalary) || 0),
                                hours: workHoursPerDay,
                              })
                            : t('hourlyRateFromMonthly', {
                                rate: formatCurrency(Number(overtime.employee?.baseSalary) || 0),
                                days: workDays ?? 0,
                                hours: workHoursPerDay,
                              })}
                        </span>
                      </span>
                      <span>{formatCurrency(hourlyRate)}</span>
                    </div>
                    {preview.regularHours > 0 && (
                      <div className="flex justify-between">
                        <span className="text-white/80">{t('calcTierRegular')} · {t('calcTierLine', { hours: preview.regularHours, mult: regularRate })}</span>
                        <span className="font-medium">{formatCurrency(hourlyRate * preview.regularHours * regularRate)}</span>
                      </div>
                    )}
                    {preview.lateHours > 0 && (
                      <div className="flex justify-between">
                        <span className="text-white/80">{t('calcTierLate')} · {t('calcTierLine', { hours: preview.lateHours, mult: lateRate })}</span>
                        <span className="font-medium">{formatCurrency(hourlyRate * preview.lateHours * lateRate)}</span>
                      </div>
                    )}
                    {preview.doubleHours > 0 && (
                      <div className="flex justify-between">
                        <span className="text-white/80">{t('calcTierDouble')} · {t('calcTierLine', { hours: preview.doubleHours, mult: doubleRate })}</span>
                        <span className="font-medium">{formatCurrency(hourlyRate * preview.doubleHours * doubleRate)}</span>
                      </div>
                    )}
                    {foodAllowance > 0 && (
                      <div className="flex justify-between">
                        <span className="text-white/80">{t('foodAllowanceLabel')}</span>
                        <span className="font-medium">{formatCurrency(foodAllowance)}</span>
                      </div>
                    )}
                    <div className="flex justify-between pt-1.5 mt-1.5 border-t border-white/20 font-bold">
                      <span>{t('calcTotal')}</span>
                      <span>{formatCurrency(overtimePay + foodAllowance)}</span>
                    </div>
                  </div>
                )}

                {/* Fallback when hourly rate can't be resolved (no base salary / work days) */}
                {hourlyRate <= 0 && overtimePay > 0 && foodAllowance > 0 && (
                  <p className="text-white/80 text-sm mt-1">
                    {formatCurrency(overtimePay)} + {formatCurrency(foodAllowance)} {t('foodAllowanceLabel').toLowerCase()}
                  </p>
                )}

                <p className="text-white/70 text-sm mt-3">{t('hourlyRateNote')}</p>
              </div>
            )}

            {/* Timeline */}
            <div className="bg-surface-card rounded-[--radius-card] p-4 md:p-6 border border-surface-border">
              <h3 className="font-bold text-text-heading mb-4">{t('historyHeading')}</h3>
              <div className="space-y-4">
                <div className="flex gap-3">
                  <div className="w-2 h-2 bg-brand-primary rounded-full mt-2"></div>
                  <div>
                    <p className="text-sm font-semibold text-text-heading">{t('createApplicationEvent')}</p>
                    <p className="text-xs text-text-muted">{new Date(overtime.createdAt).toLocaleString('en-IN', { timeZone: getCompanyTz() })}</p>
                  </div>
                </div>

                {/* Approval chain — without this a multi-step request just reads
                    "Pending" with no clue which approver it is waiting on. */}
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
                  trail.steps.map((step) => {
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
                        data-testid="ot-trail-step"
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

                {overtime.approvedAt && (
                  <div className="flex gap-3">
                    <div className={`w-2 h-2 rounded-full mt-2 ${overtime.status === 'APPROVED' ? 'bg-status-success' : 'bg-status-error'
                      }`}></div>
                    <div>
                      <p className="text-sm font-semibold text-text-heading">{overtime.status === 'APPROVED' ? tc('approved') : tc('rejected')}</p>
                      <p className="text-xs text-text-muted">{new Date(overtime.approvedAt).toLocaleString('en-IN', { timeZone: getCompanyTz() })}</p>
                    </div>
                  </div>
                )}
              </div>

              {trail?.engaged && overtime.status === 'PENDING' && trail.activeStep && !trail.canAct && (
                <p data-testid="ot-trail-waiting" className="mt-4 text-xs text-text-muted border-t border-surface-border pt-3">
                  Waiting on step {trail.activeStep}. You are not the approver for this step.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Reject Modal */}
      {showRejectModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end justify-center z-50 md:items-center md:p-4">
          <div className="bg-surface-overlay rounded-t-2xl md:rounded-[--radius-card] p-4 md:p-8 max-w-md w-full md:mx-4 max-h-[88svh] md:max-h-none overflow-y-auto shadow-2xl">
            <h3 className="text-xl font-bold text-text-heading mb-4">{t('refuseModalTitle')}</h3>
            <p className="text-text-muted mb-4">{t('refuseModalPrompt')}</p>
            <textarea
              data-testid="overtime-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={4}
              placeholder={t('refuseModalPlaceholder')}
              className="w-full px-4 py-3 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-status-error bg-surface-card text-text-body"
            />
            <div className="flex gap-4 mt-6">
              <button
                data-testid="overtime-reject-confirm"
                onClick={() => handleReject()}
                disabled={!rejectReason.trim()}
                className="flex-1 px-6 py-3 bg-status-error text-white rounded-[--radius-button] font-semibold hover:bg-status-error/90 transition-colors disabled:opacity-50"
              >
                {t('confirmRefusalBtn')}
              </button>
              <button
                onClick={() => {
                  setShowRejectModal(false);
                  setRejectReason('');
                }}
                className="px-6 py-3 border border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-border-light transition-colors"
              >
                {tc('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReviewModal && overtime ? (
        <OvertimeReviewModal
          request={overtime}
          onClose={() => setShowReviewModal(false)}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      ) : null}
    </>
  );
}
