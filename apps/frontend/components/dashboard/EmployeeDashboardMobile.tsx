'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  FolderOpen,
  LogIn,
  LogOut,
  RefreshCw,
  ScanFace,
  User,
  Wallet,
} from 'lucide-react';
import Avatar from '@/components/common/Avatar';
import { getDisplayTZ } from '@/utils/tzDate';
import { formatWallClockDate, formatWallClockTime, getCompanyTz } from '@/utils/formatters';
import type { LeaveTypeBalance } from '@/types/leave';

/**
 * The ESS home screen as a phone app — everything below Tailwind's `md`.
 *
 * This is a SECOND presentation of the same data `EmployeeDashboard` already
 * fetches, not a second dashboard: it takes the state as props so there is one
 * set of requests and one set of handlers, and the approved desktop tree above
 * 768px is left byte-for-byte as it was.
 *
 * What the phone layout does differently, and why:
 *
 * - **One column, no shared rows.** The desktop puts check-in, check-out and
 *   the action button in a 3-up grid; at 390px that grid gave the primary
 *   button a 44px-tall slot squeezed against two figures. Here the figures are
 *   a pair and the action is a full-width 56px bar on its own line.
 * - **Every target ≥44px.** The desktop's 28px icon button and 24px text links
 *   are below both Apple's 44pt and Material's 48dp floors. Refresh, the "see
 *   all" links, the stat tiles and the quick actions are all sized for a thumb.
 * - **The shift is live.** A phone is opened mid-shift to answer "how long have
 *   I been on?", so the card carries a ticking elapsed time rather than making
 *   the reader subtract two clock faces.
 * - **More on screen, not less.** Leave balances (the single most-asked ESS
 *   figure) and a merged recent-activity list are surfaced here; on desktop
 *   they live one click away in their own screens, which is fine with a
 *   sidebar always visible and wrong when navigation costs two taps.
 */

interface AttendanceLike {
  isLate?: boolean;
  workHours?: number;
  hoursWorked?: number;
  allowMultiple?: boolean;
  attendanceFaceOnly?: boolean;
}

interface LeaveRow {
  id: string;
  startDate: string;
  endDate: string;
  type: string;
  status: string;
  totalDays: number;
}

interface OvertimeRow {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  hours: number;
}

export interface EmployeeDashboardMobileProps {
  fullName: string;
  position: string;
  department: string;
  avatarUrl?: string | null;
  attendance: AttendanceLike | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  leaves: LeaveRow[];
  overtime: OvertimeRow[];
  balances: LeaveTypeBalance[];
  profileCompletion: number | null;
  missingDocs: boolean;
  overtimeEnabled: boolean;
  checkingIn: boolean;
  checkingOut: boolean;
  onCheckIn: () => void;
  onCheckOut: () => void;
  onRefresh: () => void;
  formatTime: (value?: string | null) => string;
  statusBadge: (status: string) => React.ReactNode;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Ticking shift duration, `HH:MM:SS`.
 *
 * Only runs the interval while the shift is actually open — a closed day is a
 * fixed figure, and a dashboard left on screen should not hold a timer for it.
 */
function useShiftElapsed(startAt: string | null, endAt: string | null): string | null {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!startAt || endAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startAt, endAt]);

  if (!startAt) return null;
  const started = new Date(startAt).getTime();
  if (Number.isNaN(started)) return null;
  const ended = endAt ? new Date(endAt).getTime() : now;
  const ms = Math.max(0, ended - started);
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(
    Math.floor((ms % 60_000) / 1000),
  )}`;
}

/** Wall-clock date line under the greeting, in the company's zone. */
function useTodayLabel(): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    // After mount only: the server has no company timezone and rendering a
    // date during SSR is a guaranteed hydration mismatch.
    setLabel(
      new Date().toLocaleDateString('en-IN', {
        timeZone: getDisplayTZ(),
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      }),
    );
  }, []);
  return label;
}

/** Small progress ring — reads faster than a bar at this size. */
function CompletionRing({ percentage }: { percentage: number }) {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const stroke =
    percentage >= 80 ? 'var(--color-status-success)'
      : percentage >= 50 ? 'var(--color-status-warning)'
        : 'var(--color-status-error)';

  return (
    <span className="relative inline-flex h-12 w-12 shrink-0 items-center justify-center">
      <svg viewBox="0 0 48 48" className="h-12 w-12 -rotate-90">
        <circle cx="24" cy="24" r={radius} fill="none" strokeWidth="4" stroke="var(--color-surface-border)" />
        <circle
          cx="24"
          cy="24"
          r={radius}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          stroke={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.min(100, Math.max(0, percentage)) / 100)}
        />
      </svg>
      <span className="absolute text-[11px] font-bold tabular-nums text-text-heading">{percentage}%</span>
    </span>
  );
}

export default function EmployeeDashboardMobile({
  fullName,
  position,
  department,
  avatarUrl,
  attendance,
  checkInAt,
  checkOutAt,
  leaves,
  overtime,
  balances,
  profileCompletion,
  missingDocs,
  overtimeEnabled,
  checkingIn,
  checkingOut,
  onCheckIn,
  onCheckOut,
  onRefresh,
  formatTime,
  statusBadge,
}: EmployeeDashboardMobileProps) {
  const router = useRouter();
  const t = useTranslations('employeeDashboard');
  const elapsed = useShiftElapsed(checkInAt, checkOutAt);
  const today = useTodayLabel();
  const [activityTab, setActivityTab] = useState<'leave' | 'overtime'>('leave');

  // Greeting is time-of-day, so it is mount-only for the same hydration reason
  // as the date line above.
  const [greetingKey, setGreetingKey] = useState<'goodMorning' | 'goodAfternoon' | 'goodEvening'>('goodMorning');
  useEffect(() => {
    const h = new Date().getHours();
    setGreetingKey(h < 12 ? 'goodMorning' : h < 18 ? 'goodAfternoon' : 'goodEvening');
  }, []);

  const pendingLeaves = leaves.filter((l) => l.status === 'PENDING').length;
  const pendingOvertime = overtime.filter((o) => o.status === 'PENDING').length;

  const faceOnly = Boolean(attendance?.attendanceFaceOnly);
  const canCheckIn = !checkInAt || (checkOutAt && attendance?.allowMultiple);
  const dayClosed = Boolean(checkInAt && checkOutAt && !attendance?.allowMultiple);

  const stats = useMemo(
    () => [
      {
        key: 'pendingLeave',
        label: t('statPendingLeave'),
        value: pendingLeaves,
        icon: CalendarDays,
        tone: 'text-status-warning',
        bg: 'bg-status-warning-bg',
        href: '/dashboard/my-leaves',
      },
      ...(overtimeEnabled
        ? [{
          key: 'pendingOvertime',
          label: t('statPendingOvertime'),
          value: pendingOvertime,
          icon: FileText,
          tone: 'text-status-info',
          bg: 'bg-status-info-bg',
          href: '/dashboard/my-overtime',
        }]
        : []),
      {
        key: 'totalLeave',
        label: t('statTotalLeave'),
        value: leaves.length,
        icon: CalendarDays,
        tone: 'text-brand-primary',
        bg: 'bg-brand-primary/10',
        href: '/dashboard/my-leaves',
      },
      ...(overtimeEnabled
        ? [{
          key: 'totalOvertime',
          label: t('statTotalOvertime'),
          value: overtime.length,
          icon: FileText,
          tone: 'text-status-success',
          bg: 'bg-status-success-bg',
          href: '/dashboard/my-overtime',
        }]
        : []),
    ],
    [t, pendingLeaves, pendingOvertime, leaves.length, overtime.length, overtimeEnabled],
  );

  const quickActions = useMemo(
    () => [
      { label: t('navAttendance'), icon: Clock, href: '/dashboard/my-attendance', tone: 'text-status-success', bg: 'bg-status-success-bg' },
      { label: t('navLeave'), icon: CalendarDays, href: '/dashboard/my-leaves', tone: 'text-brand-primary', bg: 'bg-brand-primary/10' },
      ...(overtimeEnabled
        ? [{ label: t('navOvertime'), icon: FileText, href: '/dashboard/my-overtime', tone: 'text-brand-accent', bg: 'bg-brand-accent/10' }]
        : []),
      // `/dashboard/payroll`, NOT `/dashboard/my-payroll`: that segment holds
      // only `[id]/` and `gratuity/` and has no page of its own, so this tile
      // 404'd. Same defect as D-01 in the tab bar, in a second place — which is
      // why the route guard now covers every href in this file too.
      { label: t('navSalary'), icon: Wallet, href: '/dashboard/payroll', tone: 'text-status-warning', bg: 'bg-status-warning-bg' },
      { label: t('navMyCalendar'), icon: CalendarDays, href: '/dashboard/my-calendar', tone: 'text-status-info', bg: 'bg-status-info-bg' },
      { label: t('navDocuments'), icon: FolderOpen, href: '/dashboard/my-documents', tone: 'text-brand-primary', bg: 'bg-brand-primary/10' },
      { label: t('navFaceRecognition'), icon: ScanFace, href: '/dashboard/face-recognition', tone: 'text-status-info', bg: 'bg-status-info-bg' },
      { label: t('navProfile'), icon: User, href: '/dashboard/profile', tone: 'text-text-body', bg: 'bg-surface-page' },
    ],
    [t, overtimeEnabled],
  );

  return (
    // `-mx-4 -mt-4`: `DashboardLayout`'s `<main>` pads the page by 16px, and a
    // hero that stops short of the screen edge is the single thing that makes a
    // web view read as a website rather than an app. The padding is put back on
    // the inner sections below.
    <div className="-mx-4 -mt-4" data-testid="ess-mobile-dashboard">
      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <motion.header
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative overflow-hidden bg-linear-to-br from-brand-primary to-brand-primary-dark px-4 pt-5 pb-14 text-white"
      >
        {/* Logical insets, not physical: under dir="rtl" these decorative
            blobs should follow the layout rather than stay pinned to the
            reader's right. */}
        <div className="absolute -top-16 -end-10 h-48 w-48 rounded-full bg-white/10" aria-hidden="true" />
        <div className="absolute -bottom-20 -start-12 h-40 w-40 rounded-full bg-white/5" aria-hidden="true" />

        <div className="relative flex items-start gap-3">
          <Avatar src={avatarUrl} name={fullName} size="lg" className="border-2 border-white/40 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/70">{today}</p>
            <h1 className="mt-0.5 truncate text-xl font-bold leading-tight">
              {t(greetingKey)}, {fullName.split(' ')[0]}
            </h1>
            <p className="mt-0.5 truncate text-xs text-white/80">
              {position} · {department}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            aria-label={t('refresh')}
            data-testid="ess-mobile-refresh"
            className="-me-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/90 transition-colors active:bg-white/15"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </motion.header>

      <div className="space-y-4 px-4">
        {/* ── Shift card, lifted onto the hero ─────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          // `relative z-10` is load-bearing: the hero above is a `motion`
          // element, so framer-motion's transform gives it a stacking context
          // of its own and it paints OVER this card's negative margin. Without
          // the z-index the card's whole header row — title and duty chip —
          // sits underneath the gradient.
          className="relative z-10 -mt-10 rounded-2xl border border-surface-border bg-surface-card p-4 shadow-lg shadow-black/5"
          data-testid="ess-mobile-shift-card"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-heading">
              <Clock size={16} className="text-brand-primary" />
              {t('attendanceToday')}
            </h2>
            {/* The chip reports the SESSION, not the day. With multiple
                sessions allowed, a closed one still leaves check-in and
                check-out on screen and offers another check-in — reading
                "Not clocked in" beside two stamped times was simply wrong. */}
            {checkInAt && !checkOutAt ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-status-success-bg px-2.5 py-1 text-[11px] font-semibold text-status-success">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-success" />
                {t('onDuty')}
              </span>
            ) : checkInAt && checkOutAt ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-page px-2.5 py-1 text-[11px] font-semibold text-text-muted">
                <CheckCircle2 size={12} className="text-status-success" />
                {t('completed')}
              </span>
            ) : (
              <span className="rounded-full bg-status-warning-bg px-2.5 py-1 text-[11px] font-semibold text-status-warning">
                {t('notClockedIn')}
              </span>
            )}
          </div>

          {/* Live elapsed time — the figure a phone is opened for. Shown only
              while the session is open: once it closes, the hours worked are
              already in the check-out tile, and a frozen counter labelled
              "time on shift" reads as a still-running one. */}
          {elapsed && !checkOutAt && (
            <div className="mt-3 rounded-xl bg-surface-page px-3 py-2.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{t('timeOnShift')}</p>
              <p
                className="mt-0.5 font-mono text-2xl font-bold tabular-nums text-text-heading"
                data-testid="ess-mobile-elapsed"
              >
                {elapsed}
              </p>
            </div>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <div className="rounded-xl border border-surface-border p-3">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
                <LogIn size={13} className="text-status-success" />
                {t('checkIn')}
              </span>
              <p className="mt-1 text-lg font-bold tabular-nums text-text-heading">{formatTime(checkInAt)}</p>
              {attendance?.isLate && (
                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-status-warning">
                  <AlertCircle size={11} />
                  {t('late')}
                </p>
              )}
            </div>
            <div className="rounded-xl border border-surface-border p-3">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
                <LogOut size={13} className="text-status-info" />
                {t('checkOut')}
              </span>
              <p className="mt-1 text-lg font-bold tabular-nums text-text-heading">{formatTime(checkOutAt)}</p>
              {(attendance?.workHours != null || attendance?.hoursWorked != null) && (
                <p className="mt-0.5 text-[11px] text-status-info">
                  {t('hoursWorked', {
                    hours: Number(attendance.workHours ?? attendance.hoursWorked).toFixed(1),
                  })}
                </p>
              )}
            </div>
          </div>

          {/* Primary action — full width, 56px, in the thumb's reach. */}
          <div className="mt-3 space-y-2">
            {faceOnly ? (
              dayClosed ? (
                <div className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-surface-page text-sm font-semibold text-text-muted">
                  <CheckCircle2 size={18} className="text-status-success" />
                  {t('completed')}
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => router.push('/dashboard/my-attendance')}
                    data-testid="ess-mobile-primary-action"
                    className="flex h-14 w-full touch-manipulation items-center justify-center gap-2 rounded-2xl bg-brand-primary text-base font-semibold text-white transition-transform active:scale-[0.98]"
                  >
                    <ScanFace size={19} />
                    {t('verifyFace')}
                  </button>
                  <p className="text-center text-[11px] text-text-muted">{t('faceVerificationRequired')}</p>
                </>
              )
            ) : canCheckIn ? (
              <button
                type="button"
                onClick={onCheckIn}
                disabled={checkingIn}
                data-testid="ess-mobile-primary-action"
                className="flex h-14 w-full touch-manipulation items-center justify-center gap-2 rounded-2xl bg-status-success text-base font-semibold text-white transition-transform active:scale-[0.98] disabled:opacity-60"
              >
                <LogIn size={19} />
                {checkingIn ? t('processing') : t('checkIn')}
              </button>
            ) : !checkOutAt ? (
              <button
                type="button"
                onClick={onCheckOut}
                disabled={checkingOut}
                data-testid="ess-mobile-primary-action"
                className="flex h-14 w-full touch-manipulation items-center justify-center gap-2 rounded-2xl bg-status-info text-base font-semibold text-white transition-transform active:scale-[0.98] disabled:opacity-60"
              >
                <LogOut size={19} />
                {checkingOut ? t('processing') : t('checkOut')}
              </button>
            ) : (
              <div className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-surface-page text-sm font-semibold text-text-muted">
                <CheckCircle2 size={18} className="text-status-success" />
                {t('completed')}
              </div>
            )}

            {!faceOnly && (
              <button
                type="button"
                onClick={() => router.push('/dashboard/face-recognition')}
                className="flex h-12 w-full touch-manipulation items-center justify-center gap-2 rounded-2xl border border-surface-border text-sm font-medium text-text-body transition-transform active:scale-[0.98]"
              >
                <ScanFace size={17} />
                {t('faceTimekeeping')}
              </button>
            )}
          </div>
        </motion.section>

        {/* ── Profile strength ─────────────────────────────────────────────── */}
        {profileCompletion !== null && profileCompletion < 100 && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            onClick={() => router.push('/dashboard/profile')}
            data-testid="ess-mobile-profile-card"
            className="flex w-full touch-manipulation items-center gap-3 rounded-2xl border border-surface-border bg-surface-card p-3.5 text-start transition-transform active:scale-[0.99]"
          >
            <CompletionRing percentage={profileCompletion} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-text-heading">{t('profileCompletion')}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-text-muted">
                {missingDocs ? t('missingDocs') : t('profileIncompleteDesc')}
              </span>
            </span>
            <ChevronRight size={18} className="shrink-0 text-text-muted" />
          </motion.button>
        )}

        {/* ── Leave balance ────────────────────────────────────────────────── */}
        {balances.length > 0 && (
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            data-testid="ess-mobile-balances"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-heading">{t('leaveBalanceTitle')}</h2>
              <button
                type="button"
                onClick={() => router.push('/dashboard/my-leaves')}
                className="-me-2 flex h-11 items-center gap-0.5 px-2 text-xs font-medium text-brand-primary"
              >
                {t('seeAll')}
                <ChevronRight size={14} />
              </button>
            </div>
            {/* Horizontal snap rail: a phone fits two of these, and a wrapped
                grid of six would push the rest of the page below the fold. */}
            <div className="-mx-4 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-4 pb-1 no-scrollbar">
              {balances.map((b) => {
                const total = b.allocated + b.carriedOver;
                const used = Math.max(0, total - b.remaining);
                const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
                return (
                  <div
                    key={b.id || b.leaveTypeKey}
                    data-testid="ess-mobile-balance-card"
                    className="w-[43%] shrink-0 snap-start rounded-2xl border border-surface-border bg-surface-card p-3"
                  >
                    <p className="truncate text-[11px] font-medium uppercase tracking-wide text-text-muted">
                      {b.leaveTypeKey}
                    </p>
                    <p className="mt-1 flex items-baseline gap-1">
                      <span className="text-2xl font-bold tabular-nums text-text-heading">{b.remaining}</span>
                      <span className="text-[11px] text-text-muted">/ {total}</span>
                    </p>
                    <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-surface-page">
                      <span
                        className="block h-full rounded-full bg-brand-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                  </div>
                );
              })}
            </div>
          </motion.section>
        )}

        {/* ── Stat tiles ───────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-2.5">
          {stats.map((stat, i) => {
            const Icon = stat.icon;
            return (
              <motion.button
                key={stat.key}
                type="button"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 + i * 0.04 }}
                onClick={() => router.push(stat.href)}
                data-testid="ess-mobile-stat"
                className="flex min-h-[92px] touch-manipulation flex-col rounded-2xl border border-surface-border bg-surface-card p-3 text-start transition-transform active:scale-[0.98]"
              >
                <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${stat.bg}`}>
                  <Icon size={16} className={stat.tone} />
                </span>
                <span className="mt-1.5 text-2xl font-bold leading-none tabular-nums text-text-heading">
                  {stat.value}
                </span>
                <span className="mt-1 line-clamp-2 text-[11px] leading-snug text-text-muted">{stat.label}</span>
              </motion.button>
            );
          })}
        </div>

        {/* ── Quick actions ────────────────────────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="rounded-2xl border border-surface-border bg-surface-card p-4"
        >
          <h2 className="mb-3 text-sm font-semibold text-text-heading">{t('quickAccess')}</h2>
          <div className="grid grid-cols-4 gap-2">
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.href}
                  type="button"
                  onClick={() => router.push(action.href)}
                  data-testid="ess-mobile-quick-action"
                  className="flex touch-manipulation flex-col items-center gap-1.5 rounded-xl py-2 transition-transform active:scale-[0.95]"
                >
                  <span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${action.bg}`}>
                    <Icon size={20} className={action.tone} />
                  </span>
                  <span className="line-clamp-2 text-center text-[10px] font-medium leading-tight text-text-body">
                    {action.label}
                  </span>
                </button>
              );
            })}
          </div>
        </motion.section>

        {/* ── Recent activity ──────────────────────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="rounded-2xl border border-surface-border bg-surface-card p-4"
          data-testid="ess-mobile-activity"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-text-heading">{t('activityTitle')}</h2>
            <button
              type="button"
              onClick={() =>
                router.push(activityTab === 'leave' ? '/dashboard/my-leaves' : '/dashboard/my-overtime')
              }
              className="-me-2 flex h-11 items-center gap-0.5 px-2 text-xs font-medium text-brand-primary"
            >
              {t('seeAll')}
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Segmented control rather than two stacked panels: the desktop's
              side-by-side pair becomes 700px of scrolling on a phone. */}
          {overtimeEnabled && (
            <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-surface-page p-1">
              {(['leave', 'overtime'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActivityTab(tab)}
                  data-testid={`ess-mobile-activity-tab-${tab}`}
                  aria-pressed={activityTab === tab}
                  // h-11 rather than the h-9 a segmented control usually wears:
                  // 44px is the floor for a thumb, and this one switches the
                  // list under it rather than merely styling it.
                  className={`h-11 touch-manipulation rounded-lg text-xs font-semibold transition-colors ${
                    activityTab === tab
                      ? 'bg-surface-card text-text-heading shadow-sm'
                      : 'text-text-muted'
                  }`}
                >
                  {tab === 'leave' ? t('navLeave') : t('navOvertime')}
                </button>
              ))}
            </div>
          )}

          <div className="mt-3 space-y-2">
            {activityTab === 'leave' || !overtimeEnabled ? (
              leaves.length === 0 ? (
                <p className="py-6 text-center text-sm text-text-muted">{t('noLeaveApplications')}</p>
              ) : (
                leaves.map((leave) => (
                  <button
                    key={leave.id}
                    type="button"
                    onClick={() => router.push('/dashboard/my-leaves')}
                    className="flex w-full touch-manipulation items-center justify-between gap-2 rounded-xl bg-surface-page p-3 text-start transition-transform active:scale-[0.99]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-text-heading">{leave.type}</span>
                      <span className="mt-0.5 block text-[11px] text-text-muted">
                        {new Date(leave.startDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })} –{' '}
                        {new Date(leave.endDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })} ·{' '}
                        {leave.totalDays}d
                      </span>
                    </span>
                    <span className="shrink-0">{statusBadge(leave.status)}</span>
                  </button>
                ))
              )
            ) : overtime.length === 0 ? (
              <p className="py-6 text-center text-sm text-text-muted">{t('noOvertimeRequests')}</p>
            ) : (
              overtime.map((ot) => (
                <button
                  key={ot.id}
                  type="button"
                  onClick={() => router.push('/dashboard/my-overtime')}
                  className="flex w-full touch-manipulation items-center justify-between gap-2 rounded-xl bg-surface-page p-3 text-start transition-transform active:scale-[0.99]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-text-heading">
                      {formatWallClockDate(ot.date)}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-text-muted">
                      {formatWallClockTime(ot.startTime)} – {formatWallClockTime(ot.endTime)} · {ot.hours}h
                    </span>
                  </span>
                  <span className="shrink-0">{statusBadge(ot.status)}</span>
                </button>
              ))
            )}
          </div>
        </motion.section>
      </div>
    </div>
  );
}
