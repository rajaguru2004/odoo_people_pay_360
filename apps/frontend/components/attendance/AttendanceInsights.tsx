'use client';

import { useState } from 'react';
import { LucideIcon, TrendingUp, AlertCircle, CheckCircle, Clock, Calendar, Award, Zap, X, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AttendanceInsightsProps {
  totalEmployees: number;
  present: number;
  late: number;
  absent: number;
  notCheckedOut: number;
  earlyLeave?: number;
  avgWorkHours?: number;
  period?: 'today' | 'week' | 'month' | 'custom';
  lateUsers?: string[];
  absentUsers?: string[];
  earlyLeaveUsers?: string[];
  notCheckedOutUsers?: string[];
  notCheckedInUsers?: string[];
}

interface Insight {
  type: string;
  icon: LucideIcon;
  message: string;
  detail?: string;
  color: 'emerald' | 'orange' | 'red' | 'blue' | 'violet';
  users?: string[];
  count?: number;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

const avatarColors = [
  'bg-indigo-500',
  'bg-violet-500',
  'bg-sky-500',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-amber-500',
  'bg-teal-500',
  'bg-fuchsia-500',
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return avatarColors[Math.abs(hash) % avatarColors.length];
}

export default function AttendanceInsights({
  totalEmployees,
  present,
  late,
  absent,
  notCheckedOut,
  earlyLeave = 0,
  avgWorkHours = 0,
  period = 'today',
  lateUsers = [],
  absentUsers = [],
  earlyLeaveUsers = [],
  notCheckedOutUsers = [],
  notCheckedInUsers = [],
}: AttendanceInsightsProps) {
  const t = useTranslations('attendanceInsights');
  const tc = useTranslations('common');
  const [activeInsight, setActiveInsight] = useState<Insight | null>(null);

  const attendanceRate = totalEmployees > 0 ? Math.round((present / totalEmployees) * 100) : 0;
  const lateRate = present > 0 ? Math.round((late / present) * 100) : 0;
  const notCheckedIn = period === 'today' ? Math.max(0, totalEmployees - present - absent) : 0;

  const insights: Insight[] = [];

  if (period === 'today') {
    if (notCheckedIn > 0) {
      insights.push({
        type: 'warning',
        icon: AlertCircle,
        message: t('notCheckedInMsg', { count: notCheckedIn }),
        detail: t('mayStillArrive'),
        color: 'orange',
        users: notCheckedInUsers,
        count: notCheckedIn,
      });
    }

    if (lateRate > 20) {
      insights.push({
        type: 'alert',
        icon: TrendingUp,
        message: t('highLatenessRate', { rate: lateRate }),
        detail: t('lateOfPresent', { late, present }),
        color: 'red',
        users: lateUsers,
        count: late,
      });
      insights.push({
        type: 'info',
        icon: Clock,
        message: t('lateToday', { count: late }),
        detail: t('lateRatePercent', { rate: lateRate }),
        color: 'orange',
        users: lateUsers,
        count: late,
      });
    }

    if (notCheckedOut > 0) {
      insights.push({
        type: 'info',
        icon: AlertCircle,
        message: t('notCheckedOutMsg', { count: notCheckedOut }),
        detail: t('stillWorking'),
        color: 'blue',
        users: notCheckedOutUsers,
        count: notCheckedOut,
      });
    }

    if (attendanceRate >= 95 && lateRate < 10) {
      insights.push({
        type: 'success',
        icon: CheckCircle,
        message: t('excellentAttendance'),
        detail: t('presentOnTime', { rate: attendanceRate }),
        color: 'emerald',
      });
    } else if (attendanceRate >= 80) {
      insights.push({
        type: 'success',
        icon: Award,
        message: t('goodAttendance', { rate: attendanceRate }),
        color: 'emerald',
      });
    }

    if (absent > 0 && absent >= totalEmployees * 0.15) {
      insights.push({
        type: 'alert',
        icon: Calendar,
        message: t('highAbsenteeism', { count: absent }),
        detail: t('absenceRateToday', { rate: Math.round((absent / totalEmployees) * 100) }),
        color: 'red',
        users: absentUsers,
        count: absent,
      });
    }
  } else {
    const periodLabel =
      period === 'week'
        ? t('periodThisWeek')
        : period === 'month'
        ? t('periodThisMonth')
        : t('periodSelected');

    if (lateRate > 20) {
      insights.push({
        type: 'alert',
        icon: TrendingUp,
        message: t('highLatenessRatePeriod', { period: periodLabel, rate: lateRate }),
        detail: t('lateArrivalsOutOf', { late, present }),
        color: 'red',
        users: lateUsers,
        count: late,
      });
      insights.push({
        type: 'info',
        icon: Clock,
        message: t('lateArrivalsRecorded', { late, period: periodLabel }),
        detail: t('percentOfCheckedIn', { rate: lateRate }),
        color: 'orange',
        users: lateUsers,
        count: late,
      });
    }

    if (absent > 0) {
      const absentRate = present + absent > 0 ? Math.round((absent / (present + absent)) * 100) : 0;
      insights.push({
        type: absentRate > 15 ? 'alert' : 'info',
        icon: AlertCircle,
        message: t('absenceRecords', { count: absent, period: periodLabel }),
        detail: t('absenteeismRate', { rate: absentRate }),
        color: absentRate > 15 ? 'red' : 'orange',
        users: absentUsers,
        count: absent,
      });
    }

    if (earlyLeave > 0) {
      insights.push({
        type: 'info',
        icon: Calendar,
        message: t('earlyLeaveRecorded', { count: earlyLeave, period: periodLabel }),
        color: 'blue',
        users: earlyLeaveUsers,
        count: earlyLeave,
      });
    }

    if (avgWorkHours > 0) {
      const isGood = avgWorkHours >= 8;
      insights.push({
        type: isGood ? 'success' : 'info',
        icon: isGood ? Award : Clock,
        message: t('avgWorkHoursMsg', { hours: avgWorkHours.toFixed(1), period: periodLabel }),
        detail: isGood ? t('meetingExpected') : t('belowExpected'),
        color: isGood ? 'emerald' : 'orange',
      });
    }

    if (attendanceRate >= 90 && lateRate < 15) {
      insights.push({
        type: 'success',
        icon: Zap,
        message: t('strongPerformance', { period: periodLabel }),
        detail: t('presentRateWithLateRate', { presentRate: attendanceRate, lateRate }),
        color: 'violet',
      });
    }
  }

  if (insights.length === 0) {
    return null;
  }

  const colorClasses: Record<string, string> = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    blue: 'bg-brand-primary-light/10 border-brand-primary-light/30 text-brand-primary',
    violet: 'bg-violet-50 border-violet-200 text-violet-700',
  };

  const iconBgClasses: Record<string, string> = {
    emerald: 'bg-emerald-100',
    orange: 'bg-orange-100',
    red: 'bg-red-100',
    blue: 'bg-brand-primary-light/20',
    violet: 'bg-violet-100',
  };

  const popupHeaderClasses: Record<string, string> = {
    emerald: 'bg-emerald-50 border-emerald-100',
    orange: 'bg-orange-50 border-orange-100',
    red: 'bg-red-50 border-red-100',
    blue: 'bg-brand-primary-light/10 border-brand-primary-light/20',
    violet: 'bg-violet-50 border-violet-100',
  };

  const badgeClasses: Record<string, string> = {
    emerald: 'bg-emerald-100 text-emerald-700',
    orange: 'bg-orange-100 text-orange-700',
    red: 'bg-red-100 text-red-700',
    blue: 'bg-brand-primary-light/20 text-brand-primary',
    violet: 'bg-violet-100 text-violet-700',
  };

  const periodLabel =
    period === 'today'
      ? tc('today')
      : period === 'week'
      ? t('headerThisWeek')
      : period === 'month'
      ? t('headerThisMonth')
      : tc('customRange');

  return (
    <>
      <div className="surface-panel p-5">
        <h3 className="font-semibold text-slate-900 mb-4 flex items-center gap-2">
          <div className="p-1.5 bg-brand-primary-light/20 rounded-lg">
            <TrendingUp size={16} className="text-brand-primary" />
          </div>
          {t('hrInsightsHeader', { period: periodLabel })}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {insights.map((insight, index) => {
            const Icon = insight.icon;
            const hasUsers = insight.users && insight.users.length > 0;
            return (
              <div
                key={index}
                onClick={() => hasUsers && setActiveInsight(insight)}
                className={`flex items-start gap-3 p-3.5 rounded-xl border transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 ${hasUsers ? 'cursor-pointer' : ''} ${colorClasses[insight.color]}`}
              >
                <div className={`p-2 ${iconBgClasses[insight.color]} rounded-lg flex-shrink-0 mt-0.5`}>
                  <Icon size={16} strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{insight.message}</p>
                  {insight.detail && (
                    <p className="text-xs opacity-70 mt-0.5">{insight.detail}</p>
                  )}
                </div>
                {hasUsers && (
                  <div className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${badgeClasses[insight.color]}`}>
                    <Users size={11} />
                    <span>{insight.count ?? insight.users!.length}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Quick Stats */}
        <div className="mt-4 pt-4 border-t border-slate-200 grid grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-slate-500 mb-1">{t('presenceRate')}</p>
            <p className="text-lg font-bold text-slate-900">{attendanceRate}%</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-1">{t('lateRateLabel')}</p>
            <p className="text-lg font-bold text-slate-900">{lateRate}%</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-1">{tc('absent')}</p>
            <p className="text-lg font-bold text-slate-900">{absent}</p>
          </div>
        </div>
      </div>

      {/* Employee Popup */}
      {activeInsight && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => setActiveInsight(null)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />

          {/* Panel */}
          <div
            className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`p-5 border-b ${popupHeaderClasses[activeInsight.color]}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className={`p-2.5 ${iconBgClasses[activeInsight.color]} rounded-xl flex-shrink-0`}>
                    <activeInsight.icon size={20} strokeWidth={2} className={colorClasses[activeInsight.color].split(' ')[2]} />
                  </div>
                  <div>
                    <p className={`font-semibold text-sm leading-snug ${colorClasses[activeInsight.color].split(' ')[2]}`}>
                      {activeInsight.message}
                    </p>
                    {activeInsight.detail && (
                      <p className="text-xs text-slate-500 mt-0.5">{activeInsight.detail}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setActiveInsight(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors flex-shrink-0"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Count badge */}
              <div className="mt-3 flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${badgeClasses[activeInsight.color]}`}>
                  <Users size={12} />
                  {t('employeeCount', { count: activeInsight.count ?? activeInsight.users!.length })}
                </span>
                <span className="text-xs text-slate-400">
                  {activeInsight.count !== undefined && activeInsight.users!.length < activeInsight.count
                    ? t('showingCount', { shown: activeInsight.users!.length, total: activeInsight.count })
                    : `${activeInsight.users!.length} ${t('ofTotal', { total: totalEmployees })}`}
                </span>
              </div>
            </div>

            {/* Employee list */}
            <div className="p-4 max-h-80 overflow-y-auto">
              <div className="space-y-2">
                {activeInsight.users!.map((name, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-slate-50 transition-colors"
                  >
                    <div
                      className={`w-9 h-9 rounded-full ${getAvatarColor(name)} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}
                    >
                      {getInitials(name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{name}</p>
                    </div>
                    <span className="text-xs text-slate-400">#{i + 1}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 pb-4">
              <button
                onClick={() => setActiveInsight(null)}
                className="w-full py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium transition-colors"
              >
                {tc('close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
