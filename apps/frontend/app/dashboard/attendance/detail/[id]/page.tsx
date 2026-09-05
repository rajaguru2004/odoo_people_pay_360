'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Calendar,
  Clock,
  AlertCircle,
  CheckCircle,
  XCircle,
  FileText,
  Check,
  X,
  Shield,
  Info,
  Edit,
  User,
  Clock3,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import attendanceService from '@/services/attendanceService';
import { useAuthStore } from '@/store/authStore';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { toast } from '@/lib/toast';
import { formatDate, formatTime, formatWorkHours } from '@/utils/formatters';
import { Attendance, AttendanceCorrection } from '@/types/attendance';
import { ArrowLeftIcon } from '@/components/common/icons/directional';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function AttendanceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { id } = use(params);
  const { user } = useAuthStore();
  const t = useTranslations('detailPage');
  const tc = useTranslations('common');
  const tm = useTranslations('manualAttendanceEntry');

  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Correction Submission Form State (for Employees)
  const [showCorrectionForm, setShowCorrectionForm] = useState(false);
  const [requestedCheckIn, setRequestedCheckIn] = useState('');
  const [requestedCheckOut, setRequestedCheckOut] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [submittingCorrection, setSubmittingCorrection] = useState(false);

  // Correction Approval/Rejection State (for Admins)
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [processingCorrection, setProcessingCorrection] = useState(false);

  // Manual Override Form State (for Admins)
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [overrideStatus, setOverrideStatus] = useState('PRESENT');
  const [overrideCheckIn, setOverrideCheckIn] = useState('');
  const [overrideCheckOut, setOverrideCheckOut] = useState('');
  const [overrideNotes, setOverrideNotes] = useState('');
  const [submittingOverride, setSubmittingOverride] = useState(false);

  const isAdminOrHR = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';

  // Declared above the early-returns so hook order never changes. Feeds both
  // TopHeader's title and the record crumb of the global breadcrumb trail — the
  // trail this page used to hand-write a second copy of, two trails answering
  // one question.
  usePageHeader(
    attendance
      ? [attendance.employee?.fullName, formatDate(attendance.date, 'dd/MM/yyyy')].filter(Boolean).join(' — ')
      : t('detail'),
  );

  const getLocalTime24h = (isoString?: string): string => {
    if (!isoString) return '';
    const date = new Date(isoString);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  };

  useEffect(() => {
    const fetchAttendance = async () => {
      try {
        setLoading(true);
        const res = await attendanceService.getAttendanceById(id);
        const data = res.data;
        setAttendance(data);

        // Prepopulate override values
        if (data) {
          setOverrideStatus(data.status);
          setOverrideCheckIn(getLocalTime24h(data.checkIn));
          setOverrideCheckOut(getLocalTime24h(data.checkOut));
          setOverrideNotes(data.note || '');
          
          // Prepopulate correction form default values
          setRequestedCheckIn(getLocalTime24h(data.checkIn) || '08:30');
          setRequestedCheckOut(getLocalTime24h(data.checkOut) || '17:30');
        }
      } catch (err: any) {
        console.error('Failed to fetch attendance details:', err);
        toast.error(err.response?.data?.message || t('loadFailed'));
      } finally {
        setLoading(false);
      }
    };

    fetchAttendance();
  }, [id, refreshKey]);

  // Handle Correction Submission
  const handleCorrectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!attendance) return;

    if (!correctionReason.trim()) {
      toast.error(t('enterAdjustmentReason'));
      return;
    }

    setSubmittingCorrection(true);
    try {
      // API expects date as YYYY-MM-DD
      const formattedDate = new Date(attendance.date).toISOString().split('T')[0];
      await attendanceService.createCorrection({
        date: formattedDate,
        requestedCheckIn: requestedCheckIn || undefined,
        requestedCheckOut: requestedCheckOut || undefined,
        reason: correctionReason,
      });

      toast.success(t('correctionSubmitted'));
      setShowCorrectionForm(false);
      setCorrectionReason('');
      setRefreshKey((prev) => prev + 1);
    } catch (err: any) {
      console.error('Failed to submit correction:', err);
      toast.error(err.response?.data?.message || t('correctionSubmitFailed'));
    } finally {
      setSubmittingCorrection(false);
    }
  };

  // Handle Correction Approval
  const handleApproveCorrection = async (correctionId: string) => {
    if (!confirm(t('confirmApprove'))) return;

    setProcessingCorrection(true);
    try {
      await attendanceService.approveCorrection(correctionId);
      toast.success(t('correctionApproved'));
      setRefreshKey((prev) => prev + 1);
    } catch (err: any) {
      console.error('Failed to approve correction:', err);
      toast.error(err.response?.data?.message || t('correctionApproveFailed'));
    } finally {
      setProcessingCorrection(false);
    }
  };

  // Handle Correction Rejection
  const handleRejectCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingId) return;

    if (!rejectionReason.trim()) {
      toast.error(t('enterRejectionReason'));
      return;
    }

    setProcessingCorrection(true);
    try {
      await attendanceService.rejectCorrection(rejectingId, rejectionReason);
      toast.success(t('correctionRejected'));
      setRejectingId(null);
      setRejectionReason('');
      setRefreshKey((prev) => prev + 1);
    } catch (err: any) {
      console.error('Failed to reject correction:', err);
      toast.error(err.response?.data?.message || t('correctionRejectFailed'));
    } finally {
      setProcessingCorrection(false);
    }
  };

  // Handle Manual Override
  const handleManualOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!attendance) return;

    setSubmittingOverride(true);
    try {
      const formattedDate = new Date(attendance.date).toISOString().split('T')[0];
      await attendanceService.createManualAttendance({
        employeeId: attendance.employeeId,
        date: formattedDate,
        status: overrideStatus,
        checkIn: overrideStatus === 'PRESENT' && overrideCheckIn ? overrideCheckIn : undefined,
        checkOut: overrideStatus === 'PRESENT' && overrideCheckOut ? overrideCheckOut : undefined,
        notes: overrideNotes.trim() || undefined,
      });

      toast.success(t('recordUpdated'));
      setShowOverrideModal(false);
      setRefreshKey((prev) => prev + 1);
    } catch (err: any) {
      console.error('Failed to override attendance:', err);
      toast.error(err.response?.data?.message || t('recordUpdateFailed'));
    } finally {
      setSubmittingOverride(false);
    }
  };

  const getStatusBadgeClass = (status: string, isLate: boolean) => {
    if (status === 'ABSENT') {
      return 'bg-status-error-bg text-status-error border-status-error/20';
    }
    if (status === 'LEAVE') {
      return 'bg-status-warning-bg text-status-warning border-status-warning/20';
    }
    if (status === 'HOLIDAY') {
      return 'bg-status-info-bg text-status-info border-status-info/20';
    }
    if (isLate) {
      return 'bg-status-warning-bg text-status-warning border-status-warning/20';
    }
    return 'bg-status-success-bg text-status-success border-status-success/20';
  };

  const getStatusLabel = (status: string, isLate: boolean) => {
    if (status === 'ABSENT') return tc('absent');
    if (status === 'LEAVE') return t('onLeave');
    if (status === 'HOLIDAY') return tc('holiday');
    if (isLate) return tc('late');
    return tc('onTime');
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="animate-pulse space-y-6">
          <div className="h-6 bg-slate-200 rounded w-48"></div>
          <div className="h-32 bg-slate-100 rounded-xl"></div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="h-96 bg-slate-100 rounded-xl"></div>
            <div className="md:col-span-2 space-y-4">
              <div className="h-64 bg-slate-100 rounded-xl"></div>
              <div className="h-48 bg-slate-100 rounded-xl"></div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!attendance) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-12 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-status-error-bg border border-status-error/10 text-status-error mb-4">
          <AlertCircle size={32} />
        </div>
        <h2 className="text-xl font-bold text-slate-900 mb-2">{t('recordNotFound')}</h2>
        <p className="text-slate-600 mb-6">{t('recordNotFoundDesc')}</p>
        <button
          onClick={() => router.push('/dashboard/attendance')}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-brand-primary text-text-on-brand rounded-xl hover:bg-brand-primary-dark font-semibold text-sm transition-all"
        >
          <ArrowLeftIcon size={16} /> {t('backToOverview')}
        </button>
      </div>
    );
  }

  // Find active PENDING correction if any
  const pendingCorrection = attendance.corrections?.find((c) => c.status === 'PENDING');
  // Check if there is already a PENDING correction request, meaning user shouldn't submit another one
  const hasPendingRequest = !!pendingCorrection;

  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_ATTENDANCE">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Header bar */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <button
            onClick={() => router.push('/dashboard/attendance')}
            className="flex items-center gap-2 text-slate-700 hover:text-brand-primary font-medium transition-all"
          >
            <ArrowLeftIcon size={18} />
            {t('backToOverview')}
          </button>
          {isAdminOrHR && (
            <button
              onClick={() => setShowOverrideModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-white rounded-xl hover:shadow-lg hover:shadow-brand-primary/20 font-semibold text-sm transition-all"
            >
              <Edit size={16} />
              {t('manualOverride')}
            </button>
          )}
        </div>

        {/* Main Columns layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Column 1: Employee Card */}
          <div className="lg:col-span-4 space-y-6">
            <div className="surface-panel p-6 overflow-hidden relative">
              <div className="absolute top-0 end-0 w-32 h-32 bg-brand-primary-light/10 rounded-full -me-16 -mt-16 pointer-events-none" />
              
              <div className="flex flex-col items-center text-center space-y-4">
                <div className="w-20 h-20 bg-brand-primary text-text-on-brand rounded-2xl flex items-center justify-center font-bold text-2xl shadow-md border-2 border-white shadow-brand-primary/20">
                  {attendance.employee?.fullName?.charAt(0) || '?'}
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900">{attendance.employee?.fullName || 'N/A'}</h3>
                  <p className="text-sm text-slate-500 font-medium mt-0.5">{attendance.employee?.employeeCode || 'N/A'}</p>
                </div>

                <div className="w-full border-t border-slate-100 my-4 pt-4 text-start space-y-3">
                  <div>
                    <span className="text-xs text-slate-400 font-semibold uppercase">{tc('department')}</span>
                    <p className="text-sm font-semibold text-slate-800">{attendance.employee?.department?.name || 'N/A'}</p>
                  </div>
                  <div>
                    <span className="text-xs text-slate-400 font-semibold uppercase">{t('email')}</span>
                    <p className="text-sm font-semibold text-slate-800 break-all">{attendance.employee?.email || 'N/A'}</p>
                  </div>
                  <div>
                    <span className="text-xs text-slate-400 font-semibold uppercase">{t('shiftSettings')}</span>
                    <p className="text-sm font-semibold text-slate-800">{t('standardShift')}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Column 2: Details & Adjustments */}
          <div className="lg:col-span-8 space-y-6">
            
            {/* Record details */}
            <div className="surface-panel overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-900 font-semibold">
                  <Calendar size={18} className="text-brand-primary" />
                  <span>{t('timekeepingFor')} {formatDate(attendance.date, 'EEEE, MMMM dd, yyyy')}</span>
                </div>
                <span className={`px-2.5 py-1 text-xs font-bold rounded-md border ${getStatusBadgeClass(attendance.status, attendance.isLate)}`}>
                  {getStatusLabel(attendance.status, attendance.isLate)}
                </span>
              </div>

              <div className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Check-In widget */}
                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-status-success-bg text-status-success flex items-center justify-center flex-shrink-0">
                      <Clock size={20} />
                    </div>
                    <div>
                      <span className="text-xs text-slate-500 font-semibold block">{t('checkInTimeLabel')}</span>
                      <span className="text-lg font-bold text-slate-950 mt-0.5">
                        {attendance.checkIn ? formatTime(attendance.checkIn) : '--:--'}
                      </span>
                      {attendance.isLate && attendance.checkIn && (
                        <span className="text-xs text-status-warning font-medium block mt-0.5">{tc('lateArrival')}</span>
                      )}
                      {!attendance.isLate && attendance.checkIn && (
                        <span className="text-xs text-status-success font-medium block mt-0.5">{tc('onTime')}</span>
                      )}
                    </div>
                  </div>

                  {/* Check-Out widget */}
                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-brand-primary-light/20 text-brand-primary flex items-center justify-center flex-shrink-0">
                      <Clock size={20} />
                    </div>
                    <div>
                      <span className="text-xs text-slate-500 font-semibold block">{t('checkOutTimeLabel')}</span>
                      <span className="text-lg font-bold text-slate-950 mt-0.5">
                        {attendance.checkOut ? formatTime(attendance.checkOut) : '--:--'}
                      </span>
                      {attendance.isEarlyLeave && (
                        <span className="text-xs text-status-warning font-medium block mt-0.5">{tc('earlyLeave')}</span>
                      )}
                    </div>
                  </div>

                  {/* Total hours widget */}
                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-status-info-bg text-status-info flex items-center justify-center flex-shrink-0">
                      <Clock3 size={20} />
                    </div>
                    <div>
                      <span className="text-xs text-slate-500 font-semibold block">{tc('workHours')}</span>
                      <span className="text-lg font-bold text-slate-950 mt-0.5">
                        {attendance.workHours ? formatWorkHours(Number(attendance.workHours)) : '0h'}
                      </span>
                      {attendance.workHours && (
                        <span className="text-xs text-slate-500 font-medium block mt-0.5">
                          {Number(attendance.workHours).toFixed(1)} {t('hoursDecimal')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Other details */}
                <div className="mt-6 border-t border-slate-100 pt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <h4 className="font-semibold text-slate-950 text-sm">{t('statusAnalysis')}</h4>
                    <ul className="space-y-2">
                      <li className="flex items-center justify-between text-sm py-1 border-b border-slate-50">
                        <span className="text-slate-600">{t('lateCheckIn')}</span>
                        <span className={`font-semibold ${attendance.isLate ? 'text-status-warning' : 'text-slate-900'}`}>
                          {attendance.isLate ? tc('yes') : tc('no')}
                        </span>
                      </li>
                      <li className="flex items-center justify-between text-sm py-1 border-b border-slate-50">
                        <span className="text-slate-600">{t('earlyLeaveLabel')}</span>
                        <span className={`font-semibold ${attendance.isEarlyLeave ? 'text-status-warning' : 'text-slate-900'}`}>
                          {attendance.isEarlyLeave ? tc('yes') : tc('no')}
                        </span>
                      </li>
                      <li className="flex items-center justify-between text-sm py-1 border-b border-slate-50">
                        <span className="text-slate-600">{t('earlyCheckIn')}</span>
                        <span className={`font-semibold ${attendance.isEarlyCheckIn ? 'text-status-success' : 'text-slate-900'}`}>
                          {attendance.isEarlyCheckIn ? tc('yes') : tc('no')}
                        </span>
                      </li>
                      <li className="flex items-center justify-between text-sm py-1">
                        <span className="text-slate-600">{t('lateCheckout')}</span>
                        <span className={`font-semibold ${attendance.isLateCheckout ? 'text-brand-primary' : 'text-slate-900'}`}>
                          {attendance.isLateCheckout ? tc('yes') : tc('no')}
                        </span>
                      </li>
                    </ul>
                  </div>

                  <div className="space-y-4">
                    <h4 className="font-semibold text-slate-950 text-sm">{t('notesAndRemarks')}</h4>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 min-h-[100px] flex flex-col justify-between">
                      <p className="text-sm text-slate-700 italic">
                        {attendance.note || t('noNotesAttached')}
                      </p>
                      <div className="text-[10px] text-slate-400 mt-2 font-medium">
                        {t('lastUpdated')} {formatDate(attendance.updatedAt, 'dd/MM/yyyy HH:mm')}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Adjustments and Corrections Panel */}
            <div className="surface-panel overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-900 font-semibold">
                  <FileText size={18} className="text-status-warning" />
                  <span>{t('adjustmentRequests')}</span>
                </div>
                {!isAdminOrHR && !hasPendingRequest && (
                  <button
                    onClick={() => setShowCorrectionForm(!showCorrectionForm)}
                    className="px-3.5 py-1.5 bg-status-warning-bg text-status-warning rounded-lg hover:bg-status-warning-bg/60 border border-status-warning/20 font-bold text-xs transition-all"
                  >
                    {showCorrectionForm ? t('cancelRequest') : t('requestAdjustment')}
                  </button>
                )}
              </div>

              <div className="p-6 space-y-6">
                {/* Correction Form for Employees */}
                {showCorrectionForm && (
                  <form onSubmit={handleCorrectionSubmit} className="p-5 bg-status-warning-bg/10 border-2 border-dashed border-status-warning/20 rounded-xl space-y-4 animate-fadeIn">
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-full bg-status-warning-bg text-status-warning flex items-center justify-center flex-shrink-0">
                        <Info size={16} />
                      </div>
                      <div>
                        <h4 className="font-bold text-slate-900 text-sm">{t('adjustmentRequestForm')}</h4>
                        <p className="text-xs text-slate-600 mt-0.5">{t('submitCorrectTimesDesc')}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1.5">{t('requestedCheckIn')}</label>
                        <input
                          type="time"
                          value={requestedCheckIn}
                          onChange={(e) => setRequestedCheckIn(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1.5">{t('requestedCheckOut')}</label>
                        <input
                          type="time"
                          value={requestedCheckOut}
                          onChange={(e) => setRequestedCheckOut(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1.5">{t('reasonForCorrection')} <span className="text-red-500">*</span></label>
                      <textarea
                        value={correctionReason}
                        onChange={(e) => setCorrectionReason(e.target.value)}
                        placeholder={t('reasonPlaceholder')}
                        rows={2}
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 focus:ring-1 focus:ring-brand-primary focus:border-brand-primary"
                        required
                      />
                    </div>

                    <div className="flex justify-end gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          setShowCorrectionForm(false);
                          setCorrectionReason('');
                        }}
                        className="px-4 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 font-semibold text-xs rounded-lg transition-all"
                      >
                        {tc('cancel')}
                      </button>
                      <button
                        type="submit"
                        disabled={submittingCorrection}
                        className="px-4 py-2 bg-gradient-to-r from-brand-accent to-brand-accent-dark hover:from-brand-accent-dark hover:to-brand-accent-dark text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-brand-accent/20 disabled:opacity-50"
                      >
                        {submittingCorrection ? tc('submitting') : t('submitRequest')}
                      </button>
                    </div>
                  </form>
                )}

                {/* Action panel for Admins when correction is PENDING */}
                {isAdminOrHR && pendingCorrection && (
                  <div className="p-5 bg-status-warning-bg/30 border border-status-warning/20 rounded-xl space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-xl bg-status-warning-bg text-status-warning flex items-center justify-center flex-shrink-0">
                          <AlertCircle size={20} />
                        </div>
                        <div>
                          <h4 className="font-bold text-slate-950 text-sm">{t('pendingRequestFrom')} {pendingCorrection.employee?.fullName}</h4>
                          <p className="text-xs text-slate-500 mt-0.5">{t('submittedOn')} {formatDate(pendingCorrection.createdAt, 'dd/MM/yyyy HH:mm')}</p>
                        </div>
                      </div>
                      <span className="px-2 py-0.5 bg-status-warning-bg text-status-warning text-[10px] font-bold rounded uppercase">{t('pendingApproval')}</span>
                    </div>

                    <div className="grid grid-cols-2 gap-4 py-2 border-y border-status-warning/20 text-sm">
                      <div>
                        <span className="text-[10px] text-slate-400 font-bold uppercase block">{t('currentTimes')}</span>
                        <div className="mt-1 font-medium text-slate-700">
                          {t('inOutSeparator', { inTime: attendance.checkIn ? formatTime(attendance.checkIn) : '--:--', outTime: attendance.checkOut ? formatTime(attendance.checkOut) : '--:--' })}
                        </div>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 font-bold uppercase block">{t('requestedTimes')}</span>
                        <div className="mt-1 font-bold text-slate-900">
                          {t('inOutSeparator', {
                            inTime: pendingCorrection.requestedCheckIn ? pendingCorrection.requestedCheckIn.split('T')[1]?.substring(0, 5) || formatTime(pendingCorrection.requestedCheckIn) : '--:--',
                            outTime: pendingCorrection.requestedCheckOut ? pendingCorrection.requestedCheckOut.split('T')[1]?.substring(0, 5) || formatTime(pendingCorrection.requestedCheckOut) : '--:--',
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="p-3 bg-surface-card rounded-lg text-sm border border-slate-100">
                      <span className="text-[10px] text-slate-400 font-bold uppercase block">{tc('reason')}</span>
                      <p className="mt-1 text-slate-800 italic">"{pendingCorrection.reason}"</p>
                    </div>

                    {rejectingId === pendingCorrection.id ? (
                      <form onSubmit={handleRejectCorrection} className="space-y-2 pt-2 animate-fadeIn">
                        <label className="block text-xs font-semibold text-slate-700">{t('rejectionReason')} <span className="text-red-500">*</span></label>
                        <input
                          type="text"
                          value={rejectionReason}
                          onChange={(e) => setRejectionReason(e.target.value)}
                          placeholder={t('rejectionReasonPlaceholder')}
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-900"
                          required
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setRejectingId(null);
                              setRejectionReason('');
                            }}
                            className="px-3.5 py-1.5 bg-white border border-slate-200 text-slate-700 font-semibold text-xs rounded-lg"
                          >
                            {tc('cancel')}
                          </button>
                          <button
                            type="submit"
                            disabled={processingCorrection}
                            className="px-3.5 py-1.5 bg-status-error hover:bg-status-error/80 text-white font-bold text-xs rounded-lg"
                          >
                            {processingCorrection ? tc('processing') : t('confirmReject')}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="flex justify-end gap-2.5 pt-2">
                        <button
                          type="button"
                          onClick={() => setRejectingId(pendingCorrection.id)}
                          className="flex items-center gap-1.5 px-4 py-2 bg-white border border-slate-200 text-status-error hover:bg-status-error-bg hover:border-status-error/30 font-bold text-xs rounded-lg transition-all"
                        >
                          <X size={14} /> {t('rejectRequestTitle')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleApproveCorrection(pendingCorrection.id)}
                          disabled={processingCorrection}
                          className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-status-success to-green-600 hover:from-status-success hover:to-green-700 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-status-success/10 disabled:opacity-50"
                        >
                          <Check size={14} /> {t('approveRequestTitle')}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Display list of adjustment requests */}
                <div className="space-y-3">
                  <h4 className="font-semibold text-slate-950 text-sm">{t('adjustmentLogs')}</h4>
                  {!attendance.corrections || attendance.corrections.length === 0 ? (
                    <div className="p-8 text-center bg-slate-50/50 border border-slate-100 rounded-xl">
                      <p className="text-slate-500 text-sm">{t('noLogsYet')}</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100 max-h-[300px] overflow-y-auto pe-1">
                      {attendance.corrections.map((corr) => (
                        <div key={corr.id} className="py-3.5 first:pt-0 last:pb-0 flex flex-col md:flex-row md:items-center justify-between gap-3 text-sm">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-800">
                                {t('inOutSeparator', {
                                  inTime: corr.requestedCheckIn ? corr.requestedCheckIn.split('T')[1]?.substring(0, 5) || formatTime(corr.requestedCheckIn) : '--:--',
                                  outTime: corr.requestedCheckOut ? corr.requestedCheckOut.split('T')[1]?.substring(0, 5) || formatTime(corr.requestedCheckOut) : '--:--',
                                })}
                              </span>
                              <span className="text-[10px] text-slate-400 font-semibold">{t('dateLabel')} {formatDate(corr.date)}</span>
                            </div>
                            <p className="text-xs text-slate-600 italic">{t('reasonQuoted')}{corr.reason}"</p>
                            {corr.rejectedReason && (
                              <p className="text-xs text-status-error font-medium bg-status-error-bg px-2.5 py-1 rounded-md border border-status-error/20 mt-1.5 inline-block">
                                {t('rejectedReasonQuoted')}{corr.rejectedReason}"
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              corr.status === 'APPROVED' ? 'bg-status-success-bg text-status-success' :
                              corr.status === 'REJECTED' ? 'bg-status-error-bg text-status-error' :
                              corr.status === 'CANCELLED' ? 'bg-slate-100 text-slate-800' :
                              'bg-status-warning-bg text-status-warning'
                            }`}>
                              {corr.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Modal: Manual Override Override */}
        {showOverrideModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fadeIn">
            <div className="bg-white rounded-2xl max-w-lg w-full shadow-2xl border border-slate-200 overflow-hidden animate-scaleIn">
              <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-slate-900">
                  <Shield size={18} className="text-brand-primary" />
                  <span>{t('manualOverrideTitle')}</span>
                </div>
                <button
                  onClick={() => setShowOverrideModal(false)}
                  className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleManualOverride} className="p-6 space-y-4">
                <div className="bg-status-info-bg border border-status-info/20 rounded-xl p-4 flex gap-3 text-xs text-status-info mb-2">
                  <Info size={16} className="text-status-info flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">{t('administratorAction')}</p>
                    <p className="mt-0.5 opacity-90">{t('bypassDesc')}</p>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">{tc('date')}</label>
                  <input
                    type="text"
                    value={formatDate(attendance.date, 'dd/MM/yyyy')}
                    disabled
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">{tc('status')}</label>
                  <select
                    value={overrideStatus}
                    onChange={(e) => setOverrideStatus(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-white border border-slate-200 focus:ring-2 focus:ring-brand-primary focus:border-brand-primary rounded-xl text-sm text-slate-950 font-semibold"
                  >
                    <option value="PRESENT">{tm('statusPresent')}</option>
                    <option value="ABSENT">{tm('statusAbsent')}</option>
                    <option value="LEAVE">{tm('statusLeave')}</option>
                    <option value="HOLIDAY">{tm('statusHoliday')}</option>
                  </select>
                </div>

                {overrideStatus === 'PRESENT' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1.5">{t('checkInTimeLabel')}</label>
                      <input
                        type="time"
                        value={overrideCheckIn}
                        onChange={(e) => setOverrideCheckIn(e.target.value)}
                        className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-950 font-semibold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1.5">{t('checkOutTimeLabel')}</label>
                      <input
                        type="time"
                        value={overrideCheckOut}
                        onChange={(e) => setOverrideCheckOut(e.target.value)}
                        className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-950 font-semibold"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">{tm('notesLabel')}</label>
                  <textarea
                    value={overrideNotes}
                    onChange={(e) => setOverrideNotes(e.target.value)}
                    placeholder={t('manualNotesPlaceholder')}
                    rows={3}
                    className="w-full px-3.5 py-2 bg-white border border-slate-200 focus:ring-2 focus:ring-brand-primary focus:border-brand-primary rounded-xl text-sm text-slate-900"
                  />
                </div>

                <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setShowOverrideModal(false)}
                    className="px-4 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 font-semibold text-sm rounded-xl transition-all"
                  >
                    {tc('cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={submittingOverride}
                    className="px-5 py-2 bg-gradient-to-r from-brand-primary to-brand-primary-dark hover:from-brand-primary-dark hover:to-brand-primary-dark text-white font-bold text-sm rounded-xl transition-all shadow-md shadow-brand-primary/20"
                  >
                    {submittingOverride ? tc('saving') : t('saveOverride')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

      </div>
    </ProtectedRoute>
  );
}
