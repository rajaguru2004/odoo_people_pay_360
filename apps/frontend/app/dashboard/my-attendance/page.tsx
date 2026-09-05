'use client';

import { useState, useEffect, Fragment, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import attendanceService from '@/services/attendanceService';
import faceRecognitionService from '@/services/faceRecognitionService';
import systemSettingsService from '@/services/systemSettingsService';
import { FaceCheckIn } from '@/components/face-recognition';
import { ScanFace, Clock, Settings, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { ArrowRightIcon } from '@/components/common/icons/directional';
import Link from 'next/link';
import { getDisplayTZ } from '@/utils/tzDate';
import { usePageHeader } from '@/hooks/usePageHeader';
import DataCard from '@/components/common/DataCard';
import { DateTime } from 'luxon';

const getBoundaryCheckOutTime = (attendanceDate: string, dayEndTimeStr: string, tz: string): Date => {
  const localDateStr = attendanceDate.split('T')[0];
  const [hStr, mStr] = dayEndTimeStr.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const boundaryMinutes = (isNaN(h) ? 23 : h) * 60 + (isNaN(m) ? 59 : m);
  
  const isNextDay = boundaryMinutes < 720;
  let dateStr = localDateStr;
  if (isNextDay) {
    const dt = DateTime.fromISO(localDateStr, { zone: 'utc' }).plus({ days: 1 });
    dateStr = dt.isValid ? dt.toISODate()! : localDateStr;
  }
  
  return DateTime.fromFormat(
    `${dateStr} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    'yyyy-MM-dd HH:mm',
    { zone: tz }
  ).toJSDate();
};

const adjustAttendanceRecord = (att: any, dayEndTimeStr: string, tz: string) => {
  if (!att) return att;
  if (att.status === 'MISSED_CHECKOUT') {
    const boundaryTime = getBoundaryCheckOutTime(att.date, dayEndTimeStr, tz);
    const boundaryTimeISO = boundaryTime.toISOString();
    
    let sessionsUpdated = false;
    const updatedSessions = att.sessions?.map((session: any) => {
      if (!session.checkOut) {
        sessionsUpdated = true;
        return { ...session, checkOut: boundaryTimeISO, isMissed: true };
      }
      return session;
    }) ?? [];
    
    const updatedCheckOut = att.checkOut || (sessionsUpdated ? boundaryTimeISO : null);
    
    return {
      ...att,
      checkOut: updatedCheckOut,
      sessions: updatedSessions,
    };
  }
  return att;
};

const statusBadgeClass = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium';

/** Attendance status chips — shared by the desktop table and the mobile cards. */
function renderStatusBadges(attendance: any) {
  if (attendance.status === 'MISSED_CHECKOUT')
    return <span className={`${statusBadgeClass} bg-status-error-bg/40 text-status-error`}>Missed Checkout</span>;
  if (attendance.status === 'ABSENT')
    return <span className={`${statusBadgeClass} bg-status-error-bg/40 text-status-error`}>Absent</span>;
  if (attendance.status === 'LEAVE')
    return <span className={`${statusBadgeClass} bg-status-info-bg/40 text-status-info`}>On leave</span>;

  const onTime = !attendance.isEarlyCheckIn && !attendance.isLate && !attendance.isLateCheckout && !attendance.isEarlyLeave;
  return (
    <>
      {attendance.isEarlyCheckIn && <span className={`${statusBadgeClass} bg-status-success-bg/40 text-status-success`}>Early Arrival</span>}
      {attendance.isLate && <span className={`${statusBadgeClass} bg-status-warning-bg/40 text-status-warning`}>Late Arrival</span>}
      {attendance.isLateCheckout && <span className={`${statusBadgeClass} bg-brand-primary-light/40 text-brand-primary`}>Extra Hours</span>}
      {attendance.isEarlyLeave && <span className={`${statusBadgeClass} bg-brand-accent/20 text-brand-accent`}>Early Departure</span>}
      {onTime && <span className={`${statusBadgeClass} bg-status-success-bg/40 text-status-success`}>On time</span>}
    </>
  );
}

const formatDuration = (start: string | Date, end: string | Date) => {
  if (!start || !end) return '-';
  const durationMs = new Date(end).getTime() - new Date(start).getTime();
  if (isNaN(durationMs) || durationMs < 0) return '-';
  const mins = Math.floor(durationMs / 1000 / 60);
  const hrs = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (hrs > 0) {
    return `${hrs}h ${remainingMins}m`;
  }
  return `${remainingMins}m`;
};

function ActiveSessionDuration({ checkIn }: { checkIn: string }) {
  const [elapsed, setElapsed] = useState('');

  useEffect(() => {
    const calculateElapsed = () => {
      const durationMs = new Date().getTime() - new Date(checkIn).getTime();
      if (isNaN(durationMs) || durationMs < 0) return '0m';
      const secs = Math.floor(durationMs / 1000);
      const mins = Math.floor(secs / 60);
      const hrs = Math.floor(mins / 60);
      const remainingMins = mins % 60;
      const remainingSecs = secs % 60;
      
      const parts = [];
      if (hrs > 0) parts.push(`${hrs}h`);
      parts.push(`${remainingMins}m`);
      parts.push(`${remainingSecs}s`);
      return parts.join(' ');
    };

    setElapsed(calculateElapsed());
    const interval = setInterval(() => {
      setElapsed(calculateElapsed());
    }, 1000);

    return () => clearInterval(interval);
  }, [checkIn]);

  return (
    <div className="flex flex-col items-end">
      <span className="text-[10px] text-status-success font-semibold uppercase tracking-wider animate-pulse">Running</span>
      <span className="text-sm font-bold text-status-success bg-status-success-bg px-2.5 py-1 rounded-[--radius-button] border border-status-success/20">
        {elapsed}
      </span>
    </div>
  );
}

function ActiveLunchDuration({ checkIn }: { checkIn: string }) {
  const [elapsed, setElapsed] = useState('');

  useEffect(() => {
    const calculateElapsed = () => {
      const durationMs = new Date().getTime() - new Date(checkIn).getTime();
      if (isNaN(durationMs) || durationMs < 0) return '0m';
      const secs = Math.floor(durationMs / 1000);
      const mins = Math.floor(secs / 60);
      const hrs = Math.floor(mins / 60);
      const remainingMins = mins % 60;
      const remainingSecs = secs % 60;
      
      const parts = [];
      if (hrs > 0) parts.push(`${hrs}h`);
      parts.push(`${remainingMins}m`);
      parts.push(`${remainingSecs}s`);
      return parts.join(' ');
    };

    setElapsed(calculateElapsed());
    const interval = setInterval(() => {
      setElapsed(calculateElapsed());
    }, 1000);

    return () => clearInterval(interval);
  }, [checkIn]);

  return (
    <div className="flex flex-col items-end">
      <span className="text-[10px] text-status-warning font-semibold uppercase tracking-wider animate-pulse">On Break</span>
      <span className="text-sm font-bold text-status-warning bg-status-warning-bg/40 px-2.5 py-1 rounded-[--radius-button] border border-status-warning/20">
        {elapsed}
      </span>
    </div>
  );
}

// Live progress toward a flexible shift's daily hours target. Sums all non-lunch
// sessions (adding the running session live) and shows worked vs required hours.
// `dayEndMs` is the attendance day boundary: the backend never pays past it, so
// the bar must not keep climbing past it either.
function FlexibleHoursProgress({ sessions, requiredHours, dayEndMs }: { sessions: any[]; requiredHours: number; dayEndMs?: number }) {
  const [worked, setWorked] = useState(0);

  useEffect(() => {
    const compute = () => {
      const limit = dayEndMs && dayEndMs > 0 ? dayEndMs : Infinity;
      let total = 0;
      for (const s of sessions || []) {
        if (s.type === 'LUNCH' || !s.checkIn) continue;
        const start = new Date(s.checkIn).getTime();
        const rawEnd = s.checkOut ? new Date(s.checkOut).getTime() : Date.now();
        const end = Math.min(rawEnd, limit);
        if (end > start) total += (end - start) / (1000 * 60 * 60);
      }
      return total;
    };

    setWorked(compute());
    const hasActive = (sessions || []).some((s: any) => s.type !== 'LUNCH' && s.checkIn && !s.checkOut);
    if (!hasActive) return;
    const interval = setInterval(() => setWorked(compute()), 1000);
    return () => clearInterval(interval);
  }, [sessions, dayEndMs]);

  const pct = requiredHours > 0 ? (worked / requiredHours) * 100 : 0;
  const met = worked >= requiredHours && requiredHours > 0;

  return (
    <div>
      <p className="text-xl sm:text-2xl font-semibold tabular-nums text-text-heading">
        {worked.toFixed(2).replace(/\.?0+$/, '')}
        <span className="text-sm font-medium text-text-muted"> / {requiredHours}h</span>
      </p>
      <div className="mt-2 h-2 w-full rounded-full bg-surface-border overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${met ? 'bg-status-success' : 'bg-brand-primary'}`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <p className={`text-xs mt-1 ${met ? 'text-status-success' : 'text-text-muted'}`}>
        {met ? `Target met (${Math.round(pct)}%)` : `${Math.round(pct)}% of ${requiredHours}h target`}
      </p>
    </div>
  );
}

export default function MyAttendancePage() {
  const t = useTranslations('myAttendancePage');
  const tc = useTranslations('common');
  const { user } = useAuthStore();
  const { branding } = useBrandingStore();
  const displayTZ = getDisplayTZ();

  // The one heading for this route, rendered by TopHeader. This page has no subtitle.
  usePageHeader(t('title'));

  const [attendances, setAttendances] = useState<any[]>([]);
  const [todayRecord, setTodayRecord] = useState<any>(null);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [isFlexible, setIsFlexible] = useState(false);
  const [requiredHours, setRequiredHours] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [faceCheckInMode, setFaceCheckInMode] = useState<'check-in' | 'check-out' | 'lunch-check-in' | 'lunch-check-out' | null>(null);
  const [isOnLunchBreak, setIsOnLunchBreak] = useState(false);
  const [lunchCheckOutTime, setLunchCheckOutTime] = useState<string | null>(null);
  const [lunchDuration, setLunchDuration] = useState(0);
  const [hasTakenLunchToday, setHasTakenLunchToday] = useState(false);
  const [faceRegistered, setFaceRegistered] = useState<boolean | null>(null);
  const [faceCount, setFaceCount] = useState(0);
  const [faceRecognitionEnabled, setFaceRecognitionEnabled] = useState(true);
  const [strictAttendanceMode, setStrictAttendanceMode] = useState(false);
  const [dayEndTime, setDayEndTime] = useState('23:59');
  const [lunchBreakStart, setLunchBreakStart] = useState('13:00');
  const [lunchBreakDurationMins, setLunchBreakDurationMins] = useState(60);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  const toggleExpandRow = (id: string) => {
    setExpandedRows(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const loadLunchStatus = async () => {
    try {
      const response = await attendanceService.getLunchStatus();
      const statusData = (response as any).data;
      if (statusData) {
        setIsOnLunchBreak(statusData.isOnLunchBreak);
        setLunchCheckOutTime(statusData.lunchCheckOutTime);
        setLunchDuration(statusData.lunchDurationMinutes);
        setHasTakenLunchToday(statusData.hasTakenLunchToday);
      }
    } catch (error) {
      console.error('Failed to load lunch status:', error);
    }
  };

  const loadPublicSettings = async () => {
    try {
      const response = await systemSettingsService.getPublic();
      const settings = (response as any).data;
      if (settings) {
        setFaceRecognitionEnabled(settings.face_recognition_enabled !== 'false');
        setStrictAttendanceMode(settings.strict_attendance_mode === true);
        if (settings.attendance_day_end_time) setDayEndTime(settings.attendance_day_end_time);
        if (settings.lunch_break_start) setLunchBreakStart(settings.lunch_break_start);
        const lunchMins = parseInt(settings.lunch_break_duration_minutes, 10);
        if (!isNaN(lunchMins)) setLunchBreakDurationMins(lunchMins);
      }
    } catch (error) {
      console.error('Failed to load public settings:', error);
    }
  };

  const loadAllData = async () => {
    await Promise.all([
      loadMyAttendances(),
      loadTodayAttendance(),
      checkFaceRegistration(),
      loadLunchStatus(),
      loadPublicSettings(),
    ]);
  };

  useEffect(() => {
    loadAllData();
  }, []);

  const checkFaceRegistration = async () => {
    try {
      const response = await faceRecognitionService.getRegistrationStatus();
      const data = (response as any).data;
      setFaceRegistered(data.isRegistered);
      setFaceCount(data.totalRegistered);
    } catch (error) {
      console.error('Failed to check face registration:', error);
      setFaceRegistered(false);
    }
  };

  const loadTodayAttendance = async () => {
    try {
      const res = await attendanceService.getTodayAttendance();
      const rec = (res as any)?.data ?? (res as any) ?? null;

      if (rec) {
        setAllowMultiple(rec.allowMultiple === true);
        // Flexible-shift info is present even before the first check-in.
        setIsFlexible(rec.isFlexible === true);
        setRequiredHours(
          rec.requiredHours != null ? Number(rec.requiredHours) : null,
        );
      }

      // Treat placeholder payload as "no record" so we can safely fallback to monthly list.
      if (!rec || rec.status === 'NOT_CHECKED_IN') {
        setTodayRecord(null);
        return;
      }

      setTodayRecord(rec);
    } catch {
      setTodayRecord(null);
    }
  };

  const loadMyAttendances = async () => {
    try {
      setLoading(true);
      const now = new Date();
      const data = await attendanceService.getMyAttendances(
        now.getMonth() + 1,
        now.getFullYear()
      );
      const records = (data as any)?.data?.data || (data as any)?.data || [];
      setAttendances(Array.isArray(records) ? records : []);
    } catch (error) {
      console.error('Failed to load attendances:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFaceSuccess = () => {
    loadAllData();
  };

  const handleFaceClose = () => {
    setFaceCheckInMode(null);
    loadAllData();
  };

  const getCheckInTime = (att: any) => {
    if (!att) return null;
    if (att.checkIn) return att.checkIn;
    if (att.sessions && att.sessions.length > 0 && att.sessions[0].checkIn) return att.sessions[0].checkIn;
    return null;
  };

  const getCheckOutTime = (att: any) => {
    if (!att) return null;
    if (att.checkOut) return att.checkOut;
    if (att.sessions && att.sessions.length > 0 && att.sessions[att.sessions.length - 1].checkOut) return att.sessions[att.sessions.length - 1].checkOut;
    return null;
  };

  const adjustedAttendances = useMemo(() => {
    return attendances.map(att => adjustAttendanceRecord(att, dayEndTime, displayTZ));
  }, [attendances, dayEndTime, displayTZ]);

  const adjustedTodayRecord = useMemo(() => {
    return todayRecord ? adjustAttendanceRecord(todayRecord, dayEndTime, displayTZ) : null;
  }, [todayRecord, dayEndTime, displayTZ]);

  // Use dedicated today endpoint first, then fallback to list item for the same date.
  const todayAttendance = (getCheckInTime(adjustedTodayRecord) || getCheckOutTime(adjustedTodayRecord) || (adjustedTodayRecord?.sessions && adjustedTodayRecord.sessions.length > 0))
    ? adjustedTodayRecord
    : adjustedAttendances.find(
    a => new Date(a.date).toDateString() === new Date().toDateString()
  );

  const isCurrentlyCheckedIn = !!getCheckInTime(todayAttendance) && !getCheckOutTime(todayAttendance);

  // Face check-in modal
  if (faceCheckInMode) {
    return (
      <>
      <div className="p-6">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-[--radius-card] bg-surface-card border border-surface-border p-6 shadow-lg">
            <FaceCheckIn
              mode={faceCheckInMode}
              onSuccess={handleFaceSuccess}
              onClose={handleFaceClose}
              recognitionEnabled={faceRecognitionEnabled}
              geofencingEnabled={branding.geofencing_enabled}
            />
          </div>
        </div>
      </div>
      </>
    );
  }

  return (
    <>
    <div className="p-0 md:p-6" data-testid="ess-my-attendance">
      {/* Live date. The title lives in the sticky TopHeader (declared via
          usePageHeader above), so this row only carries the date now. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2 mb-4 sm:mb-5">
        <div className="flex items-center gap-2 text-xs sm:text-sm text-text-muted">
          <Clock className="h-4 w-4" />
          {new Date().toLocaleDateString('en-IN', { timeZone: displayTZ,  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
      </div>

      {/* Strict Attendance Mode Notice */}
      {strictAttendanceMode && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-status-warning/30 bg-status-warning-bg/40 p-3">
          <AlertTriangle className="h-4 w-4 text-status-warning mt-0.5 shrink-0" />
          <p className="text-xs sm:text-sm text-text-body">
              {t('reminderPart1')} <span className="font-semibold text-text-heading">{t('reminderPart2')} {(() => {
                const [h = 23, m = 59] = dayEndTime.split(':').map(Number);
                const mins = (isNaN(h) ? 23 : h) * 60 + (isNaN(m) ? 59 : m);
                const hour12 = h % 12 === 0 ? 12 : h % 12;
                const label = `${hour12}:${String(isNaN(m) ? 59 : m).padStart(2, '0')} ${h < 12 ? t('am') : t('pm')}`;
                return mins < 720 ? `${label}${t('nextDaySuffix')}` : label;
              })()}</span>{t('reminderPart3')}
          </p>
        </div>
      )}

      {/* Face Registration Status Banner */}
      {faceRecognitionEnabled && faceRegistered === false && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-status-warning/20 bg-status-warning-bg/30 p-3">
          <AlertTriangle className="h-4 w-4 text-status-warning mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs sm:text-sm font-medium text-status-warning">{t('notRegisteredFace')}</p>
            <p className="text-xs text-status-warning/80">{t('registerFaceDesc')}</p>
          </div>
          <Link
            href="/dashboard/face-recognition"
            className="inline-flex items-center gap-1.5 min-w-11 h-9 px-4 md:px-3 rounded-lg bg-brand-accent text-sm font-medium text-white hover:bg-brand-accent-dark shrink-0 cursor-pointer touch-manipulation"
          >
            <ScanFace className="h-4 w-4" />
            {t('register')}
          </Link>
        </div>
      )}

      {/* Check In/Out Card */}
      <div className="bg-surface-card rounded-xl border border-surface-border shadow-sm p-4 sm:p-5 mb-4 sm:mb-5">
        <h2 className="text-sm sm:text-base font-semibold text-text-heading mb-3 sm:mb-4">{t('attendanceToday')}</h2>

        {/* Time display */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4 mb-4">
          <div className="bg-surface-card border border-surface-border rounded-xl p-3 sm:p-4">
            <p className="text-xs font-medium text-text-muted mb-1">{tc('checkIn')}</p>
            <p className="text-xl sm:text-2xl font-semibold tabular-nums text-text-heading">
              {getCheckInTime(todayAttendance)
                ? new Date(getCheckInTime(todayAttendance)).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })
                : '--:--'}
            </p>
            {todayAttendance?.isEarlyCheckIn && (
              <span className="inline-flex items-center mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-success-bg/40 text-status-success">{tc('earlyArrival')}</span>
            )}
            {todayAttendance?.isLate && (
              <span className="inline-flex items-center mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-warning-bg/40 text-status-warning">{tc('lateArrival')}</span>
            )}
          </div>

          <div className="bg-surface-card border border-surface-border rounded-xl p-3 sm:p-4">
            <p className="text-xs font-medium text-text-muted mb-1">{tc('checkOut')}</p>
            <p className="text-xl sm:text-2xl font-semibold tabular-nums text-text-heading">
              {getCheckOutTime(todayAttendance)
                ? new Date(getCheckOutTime(todayAttendance)).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })
                : '--:--'}
            </p>
            {todayAttendance?.isLateCheckout && (
              <span className="inline-flex items-center mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-brand-primary-light/40 text-brand-primary">{tc('extraHours')}</span>
            )}
            {todayAttendance?.isEarlyLeave && (
              <span className="inline-flex items-center mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-brand-accent/20 text-brand-accent">{t('earlyDeparture')}</span>
            )}
          </div>

          <div
            className="col-span-2 sm:col-span-1 bg-surface-card border border-surface-border rounded-xl p-3 sm:p-4"
            data-testid="attendance-hours"
            data-flexible={isFlexible && requiredHours != null ? 'true' : 'false'}
          >
            {isFlexible && requiredHours != null ? (
              <>
                <p className="text-xs font-medium text-text-muted mb-1">{t('hoursProgress')}</p>
                <FlexibleHoursProgress
                  sessions={todayAttendance?.sessions || []}
                  requiredHours={requiredHours}
                  dayEndMs={
                    todayAttendance?.date
                      ? getBoundaryCheckOutTime(todayAttendance.date, dayEndTime, displayTZ).getTime()
                      : undefined
                  }
                />
              </>
            ) : (
              <>
                <p className="text-xs font-medium text-text-muted mb-1">{t('hoursWorked')}</p>
                <p className="text-xl sm:text-2xl font-semibold tabular-nums text-text-heading">
                  {todayAttendance?.workHours || 0}h
                </p>
                {lunchBreakDurationMins > 0 && (
                  <p className="text-xs text-text-muted mt-1">
                    {lunchBreakDurationMins} {t('lunchDeductedNote')} {lunchBreakStart}
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* Status banners */}
        {isOnLunchBreak ? (
          <div data-testid="attendance-state" data-state="lunch" className="rounded-lg border border-status-warning/20 bg-status-warning-bg/30 p-3">
            <p className="text-xs sm:text-sm font-medium text-status-warning">
              {t('onLunchBreakSince')} {lunchCheckOutTime ? new Date(lunchCheckOutTime).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' }) : ''}
            </p>
            <p className="mt-0.5 text-xs text-status-warning/80">{t('rememberCheckBack')}</p>
          </div>
        ) : getCheckOutTime(todayAttendance) ? (
          <div data-testid="attendance-state" data-state="checked-out" className="rounded-lg border border-status-success/20 bg-status-success-bg/30 p-3">
            <p className="text-xs sm:text-sm font-medium text-status-success">
              {allowMultiple ? t('completedSession') : t('completedToday')}
            </p>
            <p className="mt-0.5 text-xs text-status-success/90">
              {t('inLabel')} {new Date(getCheckInTime(todayAttendance)).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })}{' '}·{' '}
              {t('outLabel')} {new Date(getCheckOutTime(todayAttendance)).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })}
              {todayAttendance.workHours ? ` · ${todayAttendance.workHours}${t('hWorked')}` : ''}
            </p>
            {allowMultiple && (
              <p className="mt-0.5 text-xs text-status-success/80">
                {t('multipleCheckInsEnabled')}
              </p>
            )}
          </div>
        ) : getCheckInTime(todayAttendance) ? (
          <div data-testid="attendance-state" data-state="checked-in" className="rounded-lg border border-brand-primary-light bg-brand-primary-light/10 p-3">
            <p className="text-xs sm:text-sm font-medium text-brand-primary flex items-center flex-wrap gap-2">
              <span>{t('checkedInAt')} {new Date(getCheckInTime(todayAttendance)).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })}</span>
              {todayAttendance.isEarlyCheckIn && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-success text-white">{tc('earlyArrival')}</span>}
              {todayAttendance.isLate && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-warning text-white">{tc('lateArrival')}</span>}
            </p>
            <p className="mt-0.5 text-xs text-brand-primary/80">{t('rememberCheckOut')}</p>
          </div>
        ) : null}

        {/* Action buttons */}
        <div className="space-y-3 mt-4">
          {/* Face Recognition buttons */}
          {(!getCheckOutTime(todayAttendance) || allowMultiple) && (
            <div className="flex flex-col gap-3">
              {isOnLunchBreak ? (
                <button
                  onClick={() => setFaceCheckInMode('lunch-check-in')}
                  disabled={faceRecognitionEnabled && !faceRegistered}
                  className="w-full inline-flex items-center justify-center gap-2 h-12 md:h-10 px-4 rounded-lg bg-brand-accent text-text-on-accent text-sm font-medium hover:bg-brand-accent-dark disabled:bg-surface-page disabled:text-text-muted disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <ScanFace className="h-4 w-4" />
                  {t('backFromLunch')}
                </button>
              ) : (
                <div className="flex flex-col sm:flex-row gap-3">
                  <button
                    data-testid="attendance-check-in"
                    onClick={() => setFaceCheckInMode('check-in')}
                    disabled={(faceRecognitionEnabled && !faceRegistered) || isCurrentlyCheckedIn}
                    title={isCurrentlyCheckedIn ? t('alreadyCheckedIn') : ''}
                    className="flex-1 inline-flex items-center justify-center gap-2 h-12 md:h-10 px-4 rounded-lg bg-status-success text-white text-sm font-medium hover:bg-status-success/90 disabled:bg-surface-page disabled:text-text-muted disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    <ScanFace className="h-4 w-4" />
                    {t('checkInBtn')}
                  </button>

                  <button
                    data-testid="attendance-check-out"
                    onClick={() => setFaceCheckInMode('check-out')}
                    disabled={(faceRecognitionEnabled && !faceRegistered) || !isCurrentlyCheckedIn}
                    title={!isCurrentlyCheckedIn ? t('notClockedIn') : ""}
                    className="flex-1 inline-flex items-center justify-center gap-2 h-12 md:h-10 px-4 rounded-lg bg-brand-primary text-text-on-brand text-sm font-medium hover:bg-brand-primary-dark disabled:bg-surface-page disabled:text-text-muted disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    <ScanFace className="h-4 w-4" />
                    {t('checkOutBtn')}
                  </button>

                  {/* Flexible shifts self-manage breaks by checking out, so no dedicated lunch button. */}
                  {isCurrentlyCheckedIn && !hasTakenLunchToday && !isFlexible && (
                    <button
                      onClick={() => setFaceCheckInMode('lunch-check-out')}
                      disabled={faceRecognitionEnabled && !faceRegistered}
                      className="flex-1 inline-flex items-center justify-center gap-2 h-12 md:h-10 px-4 rounded-lg bg-brand-accent text-text-on-accent text-sm font-medium hover:bg-brand-accent-dark disabled:bg-surface-page disabled:text-text-muted disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      <ScanFace className="h-4 w-4" />
                      {t('lunchBreak')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Face registration link */}
          {faceRecognitionEnabled && faceRegistered !== null && (
            <div className="flex items-center justify-center pt-2">
              <Link
                href="/dashboard/face-recognition"
                className="flex items-center gap-1.5 text-sm text-text-muted hover:text-brand-primary transition-colors"
              >
                <Settings className="h-3.5 w-3.5" />
                {faceRegistered
                  ? t('faceManagementPhotos', { count: faceCount })
                  : t('registerFace')}
              </Link>
            </div>
          )}
        </div>

        {/* Today's sessions timeline */}
        {todayAttendance?.sessions && todayAttendance.sessions.length > 0 && (
          <div className="mt-4 border-t border-surface-border-light pt-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-text-heading flex items-center gap-2">
                <Clock className="h-4 w-4 text-brand-primary" />
                {t('todaysSessions')}
              </h3>
              <span
                data-testid="attendance-session-count"
                data-count={todayAttendance.sessions.length}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-brand-primary-light/20 text-brand-primary border border-brand-primary-light/40"
              >
                {todayAttendance.sessions.length} {todayAttendance.sessions.length === 1 ? t('session') : t('sessions')}
              </span>
            </div>

            <div className="relative border-s border-surface-border ms-3.5 ps-6 space-y-4">
              {todayAttendance.sessions.map((session: any, idx: number) => {
                const isSessionActive = !session.checkOut;
                const isLunch = session.type === 'LUNCH';
                return (
                  <div key={idx} className="relative">
                    {/* Timeline Dot */}
                    <div className={`absolute -start-[31px] top-1.5 h-3.5 w-3.5 rounded-full border-2 bg-surface-card flex items-center justify-center transition-all duration-300
                      ${isLunch
                        ? isSessionActive
                          ? 'border-brand-accent ring-4 ring-brand-accent/20'
                          : 'border-brand-accent ring-4 ring-brand-accent/10'
                        : isSessionActive 
                          ? 'border-status-success ring-4 ring-status-success/20' 
                          : 'border-brand-primary ring-4 ring-brand-primary-light/20'
                      }`}
                    >
                      {isSessionActive && (
                        <span className={`h-1.5 w-1.5 rounded-full ${isLunch ? 'bg-brand-accent animate-pulse' : 'bg-status-success animate-pulse'}`} />
                      )}
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-page/50 hover:bg-surface-page/80 p-3 rounded-lg border border-surface-border transition-all duration-200 shadow-2xs">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-text-heading">
                            {isLunch ? t('lunchBreak') : `${t('session')} ${idx + 1}`}
                          </span>
                          {isSessionActive ? (
                            isLunch ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-status-warning-bg/40 px-2 py-0.5 text-[10px] font-bold text-status-warning animate-pulse">
                                <span className="h-1 w-1 rounded-full bg-status-warning"></span>
                                {t('onBreak')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-status-success-bg/40 px-2 py-0.5 text-[10px] font-bold text-status-success animate-pulse">
                                <span className="h-1 w-1 rounded-full bg-status-success"></span>
                                {t('active')}
                              </span>
                            )
                          ) : (
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${session.isMissed ? 'bg-status-error-bg/40 text-status-error' : 'bg-surface-page text-text-muted'}`}>
                              {session.isMissed ? tc('missed') : t('completed')}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-text-muted flex items-center flex-wrap gap-x-2 gap-y-1">
                          <span className="font-medium text-text-body bg-surface-card px-1.5 py-0.5 rounded border border-surface-border">
                            {isLunch ? t('out') : t('in')}: {new Date(session.checkIn).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </span>
                          <span className="text-text-muted/40">→</span>
                          {session.checkOut ? (
                            session.isMissed ? (
                              <span className="font-semibold text-status-error bg-status-error-bg/40 px-1.5 py-0.5 rounded border border-status-error/20">
                                {isLunch ? t('in') : t('out')}: {tc('missed')}
                              </span>
                            ) : (
                              <span className="font-medium text-text-body bg-surface-card px-1.5 py-0.5 rounded border border-surface-border">
                                {isLunch ? t('in') : t('out')}: {new Date(session.checkOut).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              </span>
                            )
                          ) : (
                            <span className={`${isLunch ? 'text-status-warning' : 'text-status-success'} font-semibold italic text-[11px]`}>
                              {isLunch ? t('currentlyOnBreak') : t('currentlyClockedIn')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="sm:text-end flex sm:flex-col items-start sm:items-end justify-between sm:justify-center">
                        {isSessionActive ? (
                          isLunch ? (
                            <ActiveLunchDuration checkIn={session.checkIn} />
                          ) : (
                            <ActiveSessionDuration checkIn={session.checkIn} />
                          )
                        ) : (
                          <div className="flex flex-col items-end">
                            <span className="text-[10px] text-text-muted font-medium uppercase tracking-wider">{t('duration')}</span>
                            <span className="text-sm font-bold text-text-body bg-surface-card px-2.5 py-1 rounded-[--radius-input] border border-surface-border shadow-2xs">
                              {formatDuration(session.checkIn, session.checkOut)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Attendance History */}
      <div className="bg-surface-card rounded-xl border border-surface-border shadow-sm">
        <div className="p-4 sm:p-5 border-b border-surface-border">
          <h2 className="text-sm sm:text-base font-semibold text-text-heading">{t('historyTitle')}</h2>
        </div>

        {loading ? (
          <div className="p-4 sm:p-5 text-center">
            <div className="inline-block h-6 w-6 animate-spin rounded-full border-4 border-brand-primary border-t-transparent"></div>
            <p className="mt-2 text-sm text-text-muted">{t('loading')}</p>
          </div>
        ) : adjustedAttendances.length === 0 ? (
          <div className="p-4 sm:p-5 text-center text-sm text-text-muted">
            {t('noHistoryData')}
          </div>
        ) : (
          <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-page">
                <tr>
                  <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium">{t('day')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium">{tc('checkIn')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium">{tc('checkOut')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium">{t('hoursWorked')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] uppercase tracking-wide text-text-muted font-medium">{tc('status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {adjustedAttendances.map((attendance) => {
                  const hasMultipleSessions = attendance.sessions && attendance.sessions.length > 1;
                  const isExpanded = !!expandedRows[attendance.id];
                  return (
                    <Fragment key={attendance.id}>
                      <tr className="hover:bg-surface-page/50 transition-colors">
                        <td className="px-3 py-2.5 whitespace-nowrap text-sm">
                          <div className="flex items-center gap-2">
                            {hasMultipleSessions && (
                              <button
                                onClick={() => toggleExpandRow(attendance.id)}
                                className="p-1 rounded-lg hover:bg-surface-page text-text-muted hover:text-brand-primary transition-colors focus:outline-hidden cursor-pointer"
                                title={t('viewSessionsBreakdown')}
                              >
                                {isExpanded ? (
                                  <ChevronUp className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                              </button>
                            )}
                            <span className={hasMultipleSessions ? "font-medium text-text-heading" : "text-text-body"}>
                              {new Date(attendance.date).toLocaleDateString('en-IN', { timeZone: displayTZ,  weekday: 'short', day: '2-digit', month: '2-digit' })}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-sm text-text-body">
                          {getCheckInTime(attendance) 
                            ? new Date(getCheckInTime(attendance)).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })
                            : '--:--'}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-sm text-text-body">
                          {attendance.status === 'MISSED_CHECKOUT' ? (
                            <span className="text-status-error font-medium">{tc('missed')}</span>
                          ) : getCheckOutTime(attendance) ? (
                            new Date(getCheckOutTime(attendance)).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })
                          ) : (
                            '--:--'
                          )}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-sm font-semibold text-text-heading">
                          <div className="flex flex-col">
                            <span>
                              {attendance.workHours != null && Number(attendance.workHours) > 0
                                ? `${Number(attendance.workHours).toFixed(2).replace(/\.?0+$/, '')}h`
                                : '-'}
                            </span>
                            {hasMultipleSessions && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-brand-primary bg-brand-primary-light/20 px-1.5 py-0.5 rounded-[--radius-button] mt-0.5 border border-brand-primary-light/40 w-fit">
                                {attendance.sessions.length} {t('sessions')}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex flex-wrap gap-1">{renderStatusBadges(attendance)}</div>
                        </td>
                      </tr>
                      {hasMultipleSessions && isExpanded && (
                        <tr className="bg-surface-page/30">
                          <td colSpan={5} className="px-4 py-4 border-t border-b border-surface-border-light bg-surface-page/10">
                            <div className="space-y-4">
                              <div className="flex items-center gap-2 text-xs font-bold text-text-muted uppercase tracking-wider">
                                <span className="h-1.5 w-1.5 rounded-full bg-brand-primary"></span>
                                <span>{t('sessionsBreakdown')}</span>
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {attendance.sessions.map((session: any, sIdx: number) => {
                                  const isSessActive = !session.checkOut;
                                  return (
                                    <div 
                                      key={sIdx} 
                                      className={`group relative bg-surface-card p-4 rounded-[--radius-card] border transition-all duration-200 hover:shadow-md hover:scale-[1.01] flex items-center justify-between gap-4
                                        ${isSessActive 
                                          ? 'border-status-success/30 bg-status-success-bg/10 shadow-xs' 
                                          : 'border-surface-border shadow-2xs hover:border-surface-border'
                                        }`}
                                    >
                                      {/* Accent line on left */}
                                      <div className={`absolute start-0 top-0 bottom-0 w-1 rounded-s-[--radius-card]
                                        ${isSessActive ? 'bg-status-success animate-pulse' : 'bg-text-muted/40 group-hover:bg-brand-primary'}
                                      `} />

                                      <div className="ps-1 space-y-1.5">
                                        <div className="flex items-center gap-1.5">
                                          <p className="text-xs font-bold text-text-heading">{t('session')} {sIdx + 1}</p>
                                          {isSessActive && (
                                            <span className="h-1.5 w-1.5 rounded-full bg-status-success animate-ping" />
                                          )}
                                        </div>
                                        <div className="flex items-center gap-1 text-[11px] text-text-muted font-medium">
                                          <span className="bg-surface-page text-text-body px-1.5 py-0.5 rounded-sm">
                                            {new Date(session.checkIn).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })}
                                          </span>
                                          <ArrowRightIcon className="h-3 w-3 text-text-muted/40 mx-0.5" />
                                          {session.checkOut ? (
                                            session.isMissed ? (
                                              <span className="bg-status-error-bg/40 text-status-error px-1.5 py-0.5 rounded-sm font-semibold">
                                                {tc('missed')}
                                              </span>
                                            ) : (
                                              <span className="bg-surface-page text-text-body px-1.5 py-0.5 rounded-sm">
                                                {new Date(session.checkOut).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })}
                                              </span>
                                            )
                                          ) : (
                                            <span className="bg-status-success-bg/40 text-status-success px-1.5 py-0.5 rounded-sm font-semibold animate-pulse">
                                              {t('active')}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                      
                                      <div className="flex flex-col items-end">
                                        {isSessActive ? (
                                          <ActiveSessionDuration checkIn={session.checkIn} />
                                        ) : (
                                          <div className="flex flex-col items-end">
                                            <span className="text-[9px] text-text-muted font-medium uppercase tracking-wider">{t('duration')}</span>
                                            <span className="text-xs font-bold text-text-body bg-surface-page px-2.5 py-1 rounded-[--radius-input] border border-surface-border shadow-2xs mt-1">
                                              {formatDuration(session.checkIn, session.checkOut)}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden p-4 space-y-3">
            {adjustedAttendances.map((attendance) => {
              const hasMultipleSessions = attendance.sessions && attendance.sessions.length > 1;
              const inT = getCheckInTime(attendance);
              const outT = getCheckOutTime(attendance);
              return (
                <DataCard
                  key={attendance.id}
                  title={<span>{new Date(attendance.date).toLocaleDateString('en-IN', { timeZone: displayTZ, weekday: 'short', day: '2-digit', month: '2-digit' })}</span>}
                  items={[
                    { label: tc('checkIn'), value: inT ? new Date(inT).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' }) : '--:--' },
                    { label: tc('checkOut'), value: attendance.status === 'MISSED_CHECKOUT' ? <span className="text-status-error font-medium">{tc('missed')}</span> : (outT ? new Date(outT).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' }) : '--:--') },
                    { label: 'Hours', value: attendance.workHours != null && Number(attendance.workHours) > 0 ? `${Number(attendance.workHours).toFixed(2).replace(/\.?0+$/, '')}h` : '-' },
                    { label: tc('status'), full: true, value: <div className="flex flex-wrap gap-1">{renderStatusBadges(attendance)}</div> },
                  ]}
                >
                  {hasMultipleSessions && (
                    <div className="mt-3 border-t border-surface-border-light pt-2 space-y-1">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-text-muted">{attendance.sessions.length} {t('sessions')}</p>
                      {attendance.sessions.map((s: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-xs text-text-muted">
                          <span>{t('session')} {i + 1}</span>
                          <span>
                            {new Date(s.checkIn).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })}
                            {' → '}
                            {s.checkOut ? (s.isMissed ? <span className="text-status-error font-medium">{tc('missed')}</span> : new Date(s.checkOut).toLocaleTimeString('en-IN', { timeZone: displayTZ, hour: '2-digit', minute: '2-digit' })) : t('active')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </DataCard>
              );
            })}
          </div>
          </>
        )}
      </div>
    </div>
    </>
  );
}
