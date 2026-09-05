'use client';

import { Clock, TrendingUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Attendance } from '@/types/attendance';
import { formatTime } from '@/utils/formatters';
import { todayStr } from '@/utils/tzDate';

interface AttendanceLiveFeedProps {
  recentCheckIns: Attendance[];
  loading?: boolean;
  period?: 'today' | 'week' | 'month' | 'custom';
  dateFilter?: string;
}

export default function AttendanceLiveFeed({
  recentCheckIns,
  loading = false,
  period = 'today',
  dateFilter,
}: AttendanceLiveFeedProps) {
  const t = useTranslations('attendanceLiveFeed');
  const tc = useTranslations('common');

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const [year, month, day] = dateStr.split('-').map(Number);
      const d = new Date(Date.UTC(year, month - 1, day));
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  // `todayStr()` resolves the DISPLAY timezone. Comparing against
  // `new Date().toISOString()` compared the user's chosen day to a UTC day, so
  // between local midnight and the UTC offset this branch flipped to false on
  // the very day it was meant to describe (finding F19).
  const isToday = !dateFilter || dateFilter === todayStr();

  const periodHeader =
    period === 'today'
      ? isToday
        ? t('recentCheckIns')
        : t('checkInsFor', { date: formatDate(dateFilter) })
      : period === 'week'
      ? t('latestThisWeek')
      : period === 'month'
      ? t('latestThisMonth')
      : t('latestCheckIns');

  if (loading) {
    return (
      <div className="surface-panel p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
          <h3 className="font-semibold text-slate-900">{periodHeader}</h3>
        </div>
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="animate-pulse flex items-center gap-3">
              <div className="w-10 h-10 bg-slate-100 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-slate-100 rounded w-24" />
                <div className="h-2 bg-slate-100 rounded w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="surface-panel overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
          <h3 className="font-semibold text-slate-900">{periodHeader}</h3>
        </div>
        <span className="text-xs text-slate-500">{t('employeeCount', { count: recentCheckIns.length })}</span>
      </div>

      {/* Feed List */}
      <div className="p-5">
        <div className="space-y-3 max-h-[380px] overflow-y-auto">
          {recentCheckIns.length === 0 ? (
            <div className="text-center py-8">
              <Clock className="mx-auto text-slate-300 mb-2" size={32} />
              <p className="text-sm text-slate-500">{t('noCheckIns')}</p>
            </div>
          ) : (
            recentCheckIns.map((attendance, index) => (
              <div
                key={attendance.id}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 transition-colors"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                {/* Avatar */}
                <div className="relative flex-shrink-0">
                  <div className="w-10 h-10 bg-brand-primary rounded-lg flex items-center justify-center text-white font-semibold text-sm">
                    {attendance.employee?.fullName?.charAt(0) || '?'}
                  </div>
                  {attendance.isLate ? (
                    <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-brand-accent rounded-full border-2 border-white" />
                  ) : (
                    <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white" />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">
                    {attendance.employee?.fullName || tc('notAvailable')}
                  </p>
                  <div className="flex items-center gap-1.5">
                    {period !== 'today' && attendance.date && (
                      <span className="text-xs text-slate-400">
                        {new Date(attendance.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ·
                      </span>
                    )}
                    <p className="text-xs text-slate-500">
                      {attendance.checkIn ? formatTime(attendance.checkIn) : '--:--'}
                    </p>
                  </div>
                </div>

                {/* Status */}
                {attendance.isLate ? (
                  <span className="text-xs text-brand-accent-dark font-medium bg-orange-50 px-2 py-0.5 rounded-md">{tc('late')}</span>
                ) : (
                  <span className="text-xs text-emerald-600 font-medium bg-emerald-50 px-2 py-0.5 rounded-md">{tc('onTime')}</span>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer Stats */}
        {recentCheckIns.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-200">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-600">{t('onTimeRate')}</span>
              <div className="flex items-center gap-1">
                <TrendingUp size={12} className="text-emerald-600" />
                <span className="font-semibold text-emerald-600">
                  {Math.round((recentCheckIns.filter((a) => !a.isLate).length / recentCheckIns.length) * 100)}%
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
