'use client';

import { useTranslations } from 'next-intl';
import { Users, Clock, AlertCircle, CheckCircle, LogOut, Timer, Building } from 'lucide-react';
import { todayStr } from '@/utils/tzDate';

interface AttendanceQuickStatsProps {
  totalEmployees: number;
  present: number;
  late: number;
  absent: number;
  notCheckedOut: number;
  earlyLeave?: number;
  avgWorkHours?: number;
  loading?: boolean;
  period?: 'today' | 'week' | 'month' | 'custom';
  dateFilter?: string;
}

export default function AttendanceQuickStats({
  totalEmployees,
  present,
  late,
  absent,
  notCheckedOut,
  earlyLeave = 0,
  avgWorkHours = 0,
  loading = false,
  period = 'today',
  dateFilter,
}: AttendanceQuickStatsProps) {
  const t = useTranslations('attendanceQuickStats');
  const tc = useTranslations('common');

  if (loading) {
    return (
      <div className="surface-panel p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-slate-100 rounded w-32" />
          <div className="space-y-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-14 bg-slate-100 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const attendanceRate = totalEmployees > 0 ? Math.round((present / totalEmployees) * 100) : 0;
  const lateRate = present > 0 ? Math.round((late / present) * 100) : 0;

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

  const periodLabel =
    period === 'today'
      ? isToday
        ? t('todaysOverview')
        : t('overviewFor', { date: formatDate(dateFilter) })
      : period === 'week'
      ? tc('thisWeek')
      : period === 'month'
      ? tc('thisMonth')
      : tc('customRange');

  const stats = [
    {
      label: t('totalEmployees'),
      value: totalEmployees,
      icon: Users,
      bgColor: 'bg-brand-primary-light/10',
      textColor: 'text-brand-primary',
      borderColor: 'border-brand-primary-light/30',
    },
    {
      label: period === 'today' ? t('checkedIn') : t('presentRecords'),
      value: present,
      percentage: attendanceRate,
      icon: CheckCircle,
      bgColor: 'bg-emerald-50',
      textColor: 'text-emerald-600',
      borderColor: 'border-emerald-200',
    },
    {
      label: period === 'today' ? tc('late') : t('avgLate'),
      value: late,
      percentage: lateRate,
      icon: Clock,
      bgColor: 'bg-orange-50',
      textColor: 'text-brand-accent-dark',
      borderColor: 'border-orange-200',
    },
    {
      label: period === 'today' ? tc('absent') : t('avgAbsent'),
      value: absent,
      icon: AlertCircle,
      bgColor: 'bg-red-50',
      textColor: 'text-red-600',
      borderColor: 'border-red-200',
    },
    ...(period === 'today'
      ? [
          {
            label: t('notCheckedOut'),
            value: notCheckedOut,
            icon: Building,
            bgColor: 'bg-blue-50',
            textColor: 'text-blue-600',
            borderColor: 'border-blue-200',
          },
        ]
      : [
          {
            label: tc('earlyLeave'),
            value: earlyLeave,
            icon: LogOut,
            bgColor: 'bg-amber-50',
            textColor: 'text-amber-600',
            borderColor: 'border-amber-200',
          },
          {
            label: t('avgWorkHours'),
            value: avgWorkHours ? `${avgWorkHours.toFixed(1)}h` : '—',
            icon: Timer,
            bgColor: 'bg-violet-50',
            textColor: 'text-violet-600',
            borderColor: 'border-violet-200',
          },
        ]),
  ];

  return (
    <div className="surface-panel overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white">
        <h3 className="text-lg font-bold text-slate-900">{periodLabel}</h3>
        <p className="text-sm text-slate-600 mt-1">{t('subtitle')}</p>
      </div>

      {/* Stats Grid */}
      <div className="p-4 flex-1 flex flex-col justify-between gap-2">
        {stats.map((stat, index) => {
          const Icon = stat.icon;
          return (
            <div
              key={index}
              className={`flex items-center justify-between p-3 rounded-lg border ${stat.borderColor} ${stat.bgColor} transition-all hover:shadow-sm`}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 ${stat.bgColor} rounded-lg`}>
                  <Icon size={16} className={stat.textColor} />
                </div>
                <div>
                  <p className="text-xs text-slate-600 font-medium">{stat.label}</p>
                  <div className="flex items-baseline gap-1.5">
                    <p className={`text-lg font-bold ${stat.textColor}`}>{stat.value}</p>
                    {(stat as any).percentage !== undefined && (
                      <span className="text-xs text-slate-400">({(stat as any).percentage}%)</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
