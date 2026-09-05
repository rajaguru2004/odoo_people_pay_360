'use client';

import React, { useState, useEffect } from 'react';
import { getCompanyTz, formatWallClockDate, formatWallClockTime } from '@/utils/formatters';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import {
  Clock,
  LogIn,
  LogOut,
  Calendar,
  FileText,
  Bell,
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Timer,
  ScanFace,
  User,
  RefreshCw,
} from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import axiosInstance from '@/lib/axios';
import { getCurrentCoords } from '@/lib/geolocation';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import Avatar from '@/components/common/Avatar';
import LiveClock from '@/components/common/LiveClock';
import ProfileCompletionBar from '@/components/employees/ProfileCompletionBar';
import EmployeeDashboardMobile from './EmployeeDashboardMobile';
import { useIsMobile } from '@/hooks/useMediaQuery';
import type { LeaveTypeBalance } from '@/types/leave';

interface AttendanceToday {
  id?: string;
  checkIn?: string;
  checkOut?: string;
  checkInTime?: string;
  checkOutTime?: string;
  status?: string;
  isLate?: boolean;
  hoursWorked?: number;
  workHours?: number;
  allowMultiple?: boolean;
  attendanceFaceOnly?: boolean;
}

interface LeaveRequest {
  id: string;
  startDate: string;
  endDate: string;
  type: string;
  status: string;
  totalDays: number;
}

interface OvertimeRequest {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  hours: number;
}

export default function EmployeeDashboard() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { branding } = useBrandingStore();
  const t = useTranslations('employeeDashboard');
  const overtimeEnabled = branding?.overtime_enabled !== false;

  const [attendance, setAttendance] = useState<AttendanceToday | null>(null);
  const [recentLeaves, setRecentLeaves] = useState<LeaveRequest[]>([]);
  const [recentOvertime, setRecentOvertime] = useState<OvertimeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [profileCompletion, setProfileCompletion] = useState<number | null>(null);
  const [missingDocs, setMissingDocs] = useState(false);
  const [balances, setBalances] = useState<LeaveTypeBalance[]>([]);

  const employee = user?.employee;
  const employeeId = employee?.id || user?.employeeId;

  // The phone layout surfaces leave balances on the home screen; the approved
  // desktop one does not. Both trees are in the DOM (visibility is CSS, so the
  // breakpoint never causes a layout flash), so the extra request is gated on
  // the media query rather than on which tree rendered — a desktop session must
  // not pay for a card it will never show.
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!isMobile || !employeeId) return;
    let cancelled = false;
    axiosInstance
      .get(`/leave-balances/employee/${employeeId}`)
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data ?? res.data;
        setBalances(Array.isArray(data?.leaveTypeBalances) ? data.leaveTypeBalances : []);
      })
      // Non-fatal: an employee with no balance row for this year still gets the
      // rest of the dashboard, minus the rail.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isMobile, employeeId]);

  // Fetch all data
  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const [attendanceRes, leavesRes, overtimeRes, profileRes] = await Promise.all([
        axiosInstance.get('/attendances/today').catch(() => ({ data: null })),
        axiosInstance.get('/leave-requests/my-requests').catch(() => ({ data: [] })),
        axiosInstance.get('/overtime/my-requests').catch(() => ({ data: [] })),
        employeeId
          ? axiosInstance.get(`/employees/${employeeId}/profile`).catch(() => ({ data: null }))
          : Promise.resolve({ data: null }),
      ]);

      // Today's attendance
      if (attendanceRes.data) {
        const att = attendanceRes.data.data || attendanceRes.data;
        setAttendance(att);
      }

      // Recent leaves (last 5)
      const leaves = Array.isArray(leavesRes.data) ? leavesRes.data : (leavesRes.data?.data || []);
      setRecentLeaves(leaves.slice(0, 5));

      // Recent overtime (last 5)
      const overtime = Array.isArray(overtimeRes.data) ? overtimeRes.data : (overtimeRes.data?.data || []);
      setRecentOvertime(overtime.slice(0, 5));

      // Profile completion
      if (profileRes.data) {
        const profileData = profileRes.data.data ?? profileRes.data;
        const pct = profileData?.profileCompletionPercentage ?? profileData?.profile?.profileCompletionPercentage ?? null;
        setProfileCompletion(pct);
        const docs: any[] = (profileData?.documents ?? []).filter((d: any) => d.documentType !== 'AVATAR');
        const hasResume = docs.some((d: any) => d.documentType === 'Resume/CV' || d.documentType === 'RESUME');
        const hasId = docs.some((d: any) => d.documentType === 'ID Card Front' || d.documentType === 'ID_CARD_FRONT');
        setMissingDocs(!hasResume || !hasId);
      }
    } catch (error) {
      console.error('Failed to load employee dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  // Check in handler
  const handleCheckIn = async () => {
    setCheckingIn(true);
    try {
      let body: { latitude?: number; longitude?: number; accuracy?: number } = {};
      if (branding.geofencing_enabled) {
        try {
          body = await getCurrentCoords();
        } catch (geoErr: any) {
          alert(geoErr?.message || 'Could not determine your location.');
          return;
        }
      }
      let res;
      try {
        res = await axiosInstance.post('/attendances/check-in', body);
      } catch (error: any) {
        // The cached branding flag can be stale (fetched once at app mount).
        // If the server says geofencing requires location but we sent none,
        // request it now and retry once instead of surfacing a confusing error.
        const needsLocation =
          error?.response?.status === 400 &&
          /location access is required/i.test(error?.response?.data?.message || '') &&
          body.latitude === undefined;
        if (!needsLocation) throw error;
        const retryCoords = await getCurrentCoords();
        res = await axiosInstance.post('/attendances/check-in', retryCoords);
      }
      setAttendance(res.data?.data || res.data);
    } catch (error: any) {
      alert(error?.response?.data?.message || error?.message || 'Check-in failed');
    } finally {
      setCheckingIn(false);
    }
  };

  // Check out handler
  const handleCheckOut = async () => {
    try {
      setCheckingOut(true);
      const res = await axiosInstance.post('/attendances/check-out');
      setAttendance(res.data?.data || res.data);
    } catch (error: any) {
      alert(error?.response?.data?.message || error?.message || 'Check-out failed');
    } finally {
      setCheckingOut(false);
    }
  };

  const formatTime = (dateStr?: string | null) => {
    if (!dateStr) return '--:--';
    return new Date(dateStr).toLocaleTimeString('en-IN', { timeZone: getCompanyTz(),  hour: '2-digit', minute: '2-digit' });
  };

  const getCheckInTime = (att: any) => {
    if (!att) return null;
    if (att.checkIn) return att.checkIn;
    if (att.checkInTime) return att.checkInTime;
    if (att.sessions && att.sessions.length > 0 && att.sessions[0].checkIn) return att.sessions[0].checkIn;
    return null;
  };

  const getCheckOutTime = (att: any) => {
    if (!att) return null;
    if (att.checkOut) return att.checkOut;
    if (att.checkOutTime) return att.checkOutTime;
    if (att.sessions && att.sessions.length > 0 && att.sessions[att.sessions.length - 1].checkOut) return att.sessions[att.sessions.length - 1].checkOut;
    return null;
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      PENDING: 'bg-status-warning-bg text-status-warning',
      APPROVED: 'bg-status-success-bg text-status-success',
      REJECTED: 'bg-status-error-bg text-status-error',
      CANCELLED: 'bg-surface-page text-text-muted',
    };
    const labels: Record<string, string> = {
      PENDING: t('statusPending'),
      APPROVED: t('statusApproved'),
      REJECTED: t('statusRefused'),
      CANCELLED: t('statusCancelled'),
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-surface-page text-text-muted'}`}>
        {labels[status] || status}
      </span>
    );
  };

  const pendingLeaves = recentLeaves.filter(l => l.status === 'PENDING').length;
  const pendingOvertime = recentOvertime.filter(o => o.status === 'PENDING').length;

  const completionColor = profileCompletion !== null
    ? profileCompletion >= 80 ? 'text-green-600' : profileCompletion >= 50 ? 'text-yellow-600' : 'text-red-600'
    : 'text-slate-500';

  return (
    <>
      {/*
        Two presentations, one set of requests.

        The desktop tree below is the APPROVED layout and is unchanged — it is
        simply hidden under 768px, where the phone tree takes over. The split is
        pure CSS rather than a `useIsMobile()` branch on purpose: the hook
        returns false on the first client render, so branching on it would paint
        the desktop grid for a frame on every phone load.
      */}
      <div className="md:hidden">
        <EmployeeDashboardMobile
          fullName={employee?.fullName || user?.email?.split('@')[0] || ''}
          position={employee?.position || t('positionFallback')}
          department={employee?.department?.name || 'N/A'}
          avatarUrl={employee?.avatarUrl}
          attendance={attendance}
          checkInAt={getCheckInTime(attendance)}
          checkOutAt={getCheckOutTime(attendance)}
          leaves={recentLeaves}
          overtime={recentOvertime}
          balances={balances}
          profileCompletion={profileCompletion}
          missingDocs={missingDocs}
          overtimeEnabled={overtimeEnabled}
          checkingIn={checkingIn}
          checkingOut={checkingOut}
          onCheckIn={handleCheckIn}
          onCheckOut={handleCheckOut}
          onRefresh={fetchDashboardData}
          formatTime={formatTime}
          statusBadge={getStatusBadge}
        />
      </div>

      <div className="hidden md:block space-y-4 sm:space-y-5">
      {/* Enforcement banner — shown when profile is below 80% */}
      {profileCompletion !== null && profileCompletion < 80 && (
        <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs sm:text-sm font-medium text-amber-800">{t('profileIncomplete', { percentage: profileCompletion })}</p>
            <p className="text-xs text-amber-700 mt-0.5">
              {t('profileIncompleteDesc')}
            </p>
          </div>
          <button
            onClick={() => router.push('/dashboard/profile')}
            className="shrink-0 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {t('goToProfile')}
          </button>
        </div>
      )}

      {/* Welcome & Clock */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-linear-to-r from-brand-primary to-brand-primary-dark rounded-xl p-4 sm:p-5 text-white relative overflow-hidden"
      >
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/4" />
        <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/5 rounded-full translate-y-1/2 -translate-x-1/4" />
        <div className="relative z-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Avatar src={employee?.avatarUrl} name={employee?.fullName} size="lg" className="border-2 border-white/30" />
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-semibold truncate">
                {t('helloUser', { name: employee?.fullName || user?.email?.split('@')[0] || '' })}
              </h1>
              <p className="text-xs sm:text-sm text-brand-primary-light mt-0.5">
                {employee?.position || t('positionFallback')} • {employee?.department?.name || 'N/A'}
              </p>
            </div>
          </div>
          <div className="text-right hidden md:block">
            <LiveClock className="text-2xl font-semibold font-mono tabular-nums" />
          </div>
        </div>
      </motion.div>

      {/* Attendance Card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-surface-card rounded-xl border border-surface-border p-4 sm:p-5 shadow-sm"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm sm:text-base font-semibold text-text-heading flex items-center gap-2">
            <Clock size={18} className="text-brand-primary" />
            {t('attendanceToday')}
          </h2>
          <button
            onClick={fetchDashboardData}
            className="p-2 rounded-lg hover:bg-surface-page transition-colors"
            title={t('refresh')}
          >
            <RefreshCw size={16} className="text-text-muted" />
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {/* Check In */}
          <div className="bg-surface-card rounded-xl p-3 sm:p-4 border border-surface-border">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-8 h-8 rounded-lg bg-status-success-bg flex items-center justify-center shrink-0">
                <LogIn size={16} className="text-status-success" />
              </span>
              <span className="text-xs font-medium text-text-muted">{t('checkIn')}</span>
            </div>
            <p className="text-xl font-semibold tabular-nums text-text-heading">
              {formatTime(getCheckInTime(attendance))}
            </p>
            {attendance?.isLate && (
              <p className="text-xs text-status-warning mt-1 flex items-center gap-1">
                <AlertCircle size={12} />
                {t('late')}
              </p>
            )}
          </div>

          {/* Check Out */}
          <div className="bg-surface-card rounded-xl p-3 sm:p-4 border border-surface-border">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-8 h-8 rounded-lg bg-status-info-bg flex items-center justify-center shrink-0">
                <LogOut size={16} className="text-status-info" />
              </span>
              <span className="text-xs font-medium text-text-muted">{t('checkOut')}</span>
            </div>
            <p className="text-xl font-semibold tabular-nums text-text-heading">
              {formatTime(getCheckOutTime(attendance))}
            </p>
            {(attendance?.workHours != null || attendance?.hoursWorked != null) && (
              <p className="text-xs text-status-info mt-1 flex items-center gap-1">
                <Timer size={12} />
                {t('hoursWorked', { hours: Number(attendance.workHours ?? attendance.hoursWorked).toFixed(1) })}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="col-span-2 md:col-span-1 flex flex-col gap-2 justify-center">
            {attendance?.attendanceFaceOnly ? (
              (getCheckInTime(attendance) && !attendance?.allowMultiple && getCheckOutTime(attendance)) ? (
                <div className="inline-flex items-center justify-center gap-2 h-10 px-4 bg-surface-page text-text-muted rounded-lg text-sm font-medium">
                  <CheckCircle2 size={16} className="text-status-success" />
                  {t('completed')}
                </div>
              ) : (
                <>
                  <button
                    onClick={() => router.push('/dashboard/my-attendance')}
                    className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-lg bg-brand-primary hover:bg-brand-primary-dark text-white text-sm font-medium transition-colors"
                  >
                    <ScanFace size={16} />
                    {t('verifyFace')}
                  </button>
                  <p className="text-xs text-text-muted text-center mt-1">
                    {t('faceVerificationRequired')}
                  </p>
                </>
              )
            ) : (
              <>
                {(!getCheckInTime(attendance) || (getCheckOutTime(attendance) && attendance?.allowMultiple)) ? (
                  <button
                    onClick={handleCheckIn}
                    disabled={checkingIn}
                    className="inline-flex items-center justify-center gap-2 h-10 px-4 bg-status-success hover:opacity-90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    <LogIn size={16} />
                    {checkingIn ? t('processing') : t('checkIn')}
                  </button>
                ) : !getCheckOutTime(attendance) ? (
                  <button
                    onClick={handleCheckOut}
                    disabled={checkingOut}
                    className="inline-flex items-center justify-center gap-2 h-10 px-4 bg-status-info hover:opacity-90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    <LogOut size={16} />
                    {checkingOut ? t('processing') : t('checkOut')}
                  </button>
                ) : (
                  <div className="inline-flex items-center justify-center gap-2 h-10 px-4 bg-surface-page text-text-muted rounded-lg text-sm font-medium">
                    <CheckCircle2 size={16} className="text-status-success" />
                    {t('completed')}
                  </div>
                )}
                <button
                  onClick={() => router.push('/dashboard/face-recognition')}
                  className="inline-flex items-center justify-center gap-2 h-9 px-3 rounded-lg border border-surface-border text-sm font-medium text-text-body hover:bg-surface-page transition-colors"
                >
                  <ScanFace size={16} />
                  {t('faceTimekeeping')}
                </button>
              </>
            )}
          </div>
        </div>
      </motion.div>

      {/* Profile Completion Card */}
      {profileCompletion !== null && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-surface-card rounded-xl border border-surface-border p-4 sm:p-5 shadow-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm sm:text-base font-semibold text-text-heading">{t('profileCompletion')}</h2>
              {missingDocs && (
                <p className="text-xs text-amber-600 mt-0.5 flex items-center gap-1">
                  <AlertCircle size={12} />
                  {t('missingDocs')}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className={`text-xl font-semibold tabular-nums ${completionColor}`}>{profileCompletion}%</span>
              <button
                onClick={() => router.push('/dashboard/profile')}
                className="px-3 py-1.5 bg-brand-primary hover:bg-brand-primary-dark text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-1"
              >
                {t('completeProfile')} <ChevronRight size={14} />
              </button>
            </div>
          </div>
          <ProfileCompletionBar percentage={profileCompletion} />
        </motion.div>
      )}

      {/* Quick Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          {
            label: t('statPendingLeave'),
            value: pendingLeaves,
            icon: Calendar,
            color: 'text-status-warning',
            bg: 'bg-status-warning-bg',
            border: 'border-status-warning/20',
            onClick: () => router.push('/dashboard/my-leaves'),
          },
          ...(overtimeEnabled ? [
            {
              label: t('statPendingOvertime'),
              value: pendingOvertime,
              icon: FileText,
              color: 'text-status-info',
              bg: 'bg-status-info-bg',
              border: 'border-status-info/20',
              onClick: () => router.push('/dashboard/my-overtime'),
            },
          ] : []),
          {
            label: t('statTotalLeave'),
            value: recentLeaves.length,
            icon: Calendar,
            color: 'text-brand-primary',
            bg: 'bg-brand-primary/10',
            border: 'border-brand-primary/20',
            onClick: () => router.push('/dashboard/my-leaves'),
          },
          ...(overtimeEnabled ? [
            {
              label: t('statTotalOvertime'),
              value: recentOvertime.length,
              icon: FileText,
              color: 'text-status-success',
              bg: 'bg-status-success-bg',
              border: 'border-status-success/20',
              onClick: () => router.push('/dashboard/my-overtime'),
            },
          ] : []),
        ].map((stat, i) => {
          const Icon = stat.icon;
          return (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + i * 0.05 }}
              onClick={stat.onClick}
              className="bg-surface-card border border-surface-border rounded-xl p-3 sm:p-4 cursor-pointer hover:shadow-md transition-all"
            >
              <span className={`w-8 h-8 rounded-lg ${stat.bg} flex items-center justify-center`}>
                <Icon size={16} className={stat.color} />
              </span>
              <p className="text-xl font-semibold tabular-nums text-text-heading mt-2">{stat.value}</p>
              <p className="text-xs text-text-muted mt-1 line-clamp-1">{stat.label}</p>
            </motion.div>
          );
        })}
      </div>

      {/* Recent Requests Grid */}
      <div className={`grid grid-cols-1 ${overtimeEnabled ? 'lg:grid-cols-2' : ''} gap-3 sm:gap-4`}>
        {/* Recent Leave Requests */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-surface-card rounded-xl border border-surface-border p-4 sm:p-5 shadow-sm"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm sm:text-base font-semibold text-text-heading flex items-center gap-2">
              <Calendar size={16} className="text-brand-primary" />
              {t('recentLeaveApplications')}
            </h3>
            <button
              onClick={() => router.push('/dashboard/my-leaves')}
              className="text-xs sm:text-sm text-brand-primary hover:underline flex items-center gap-1"
            >
              {t('seeAll')} <ChevronRight size={14} />
            </button>
          </div>
          {recentLeaves.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-6">{t('noLeaveApplications')}</p>
          ) : (
            <div className="space-y-2">
              {recentLeaves.map(leave => (
                <div key={leave.id} className="flex items-center justify-between gap-2 p-3 bg-surface-page rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-text-heading">{leave.type}</p>
                    <p className="text-xs text-text-muted">
                      {new Date(leave.startDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })} - {new Date(leave.endDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })} ({leave.totalDays} days)
                    </p>
                  </div>
                  {getStatusBadge(leave.status)}
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Recent Overtime Requests */}
        {overtimeEnabled && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
            className="bg-surface-card rounded-xl border border-surface-border p-4 sm:p-5 shadow-sm"
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm sm:text-base font-semibold text-text-heading flex items-center gap-2">
                <FileText size={16} className="text-brand-accent" />
                {t('recentOvertimeRequests')}
              </h3>
              <button
                onClick={() => router.push('/dashboard/my-overtime')}
                className="text-xs sm:text-sm text-brand-primary hover:underline flex items-center gap-1"
              >
                {t('seeAll')} <ChevronRight size={14} />
              </button>
            </div>
            {recentOvertime.length === 0 ? (
              <p className="text-sm text-text-muted text-center py-6">{t('noOvertimeRequests')}</p>
            ) : (
              <div className="space-y-2">
                {recentOvertime.map(ot => (
                  <div key={ot.id} className="flex items-center justify-between gap-2 p-3 bg-surface-page rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-text-heading">
                        {formatWallClockDate(ot.date)}
                      </p>
                      <p className="text-xs text-text-muted">
                        {formatWallClockTime(ot.startTime)} - {formatWallClockTime(ot.endTime)} ({ot.hours}h)
                      </p>
                    </div>
                    {getStatusBadge(ot.status)}
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </div>

      {/* Quick Navigation */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="bg-surface-card rounded-xl border border-surface-border p-4 sm:p-5 shadow-sm"
      >
        <h3 className="text-sm sm:text-base font-semibold text-text-heading mb-3">{t('quickAccess')}</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: t('navAttendance'), icon: Clock, href: '/dashboard/my-attendance', color: 'text-status-success', bg: 'bg-status-success-bg' },
            { label: t('navLeave'), icon: Calendar, href: '/dashboard/my-leaves', color: 'text-brand-primary', bg: 'bg-brand-primary/10' },
            ...(overtimeEnabled ? [
              { label: t('navOvertime'), icon: FileText, href: '/dashboard/my-overtime', color: 'text-brand-accent', bg: 'bg-brand-accent/10' },
            ] : []),
            { label: t('navSalary'), icon: CurrencyIcon, href: '/dashboard/payroll', color: 'text-status-warning', bg: 'bg-status-warning-bg' },
            { label: t('navMyCalendar'), icon: Calendar, href: '/dashboard/my-calendar', color: 'text-status-info', bg: 'bg-status-info-bg' },
            { label: t('navFaceRecognition'), icon: ScanFace, href: '/dashboard/face-recognition', color: 'text-brand-primary', bg: 'bg-brand-primary/10' },
            { label: t('navProfile'), icon: User, href: '/dashboard/profile', color: 'text-brand-primary', bg: 'bg-brand-primary/10' },
            { label: t('navSettings'), icon: Bell, href: '/dashboard/settings', color: 'text-text-muted', bg: 'bg-surface-page' },
          ].map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                onClick={() => router.push(item.href)}
                className={`${item.bg} rounded-lg p-3 flex flex-col items-center gap-1.5 hover:shadow-md transition-all border border-transparent hover:border-surface-border`}
              >
                <Icon size={20} className={item.color} />
                <span className="text-xs sm:text-sm font-medium text-text-body">{item.label}</span>
              </button>
            );
          })}
        </div>
      </motion.div>
      </div>
    </>
  );
}
