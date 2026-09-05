'use client';

import { Users, CheckCircle, Clock, XCircle, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AttendanceStatsBarProps {
  totalEmployees: number;
  present: number;
  late: number;
  absent: number;
  pendingCorrections?: number;
  loading?: boolean;
  period?: 'today' | 'week' | 'month' | 'custom';
  onViewCorrections?: () => void;
}

export default function AttendanceStatsBar({
  totalEmployees,
  present,
  late,
  absent,
  pendingCorrections = 0,
  loading = false,
  period = 'today',
  onViewCorrections,
}: AttendanceStatsBarProps) {
  const t = useTranslations('attendanceStatsBar');
  const tc = useTranslations('common');
  const attendanceRate = totalEmployees > 0 ? Math.round((present / totalEmployees) * 100) : 0;
  const isToday = period === 'today';

  const stats = [
    {
      label: t('totalPersonnel'),
      key: 'total',
      value: totalEmployees,
      icon: Users,
      color: 'blue',
      bgColor: 'bg-brand-primary-light/10',
      textColor: 'text-brand-primary',
      borderColor: 'border-brand-primary-light/30',
    },
    {
      label: isToday ? tc('present') : t('avgPresent'),
      key: 'present',
      value: present,
      icon: CheckCircle,
      color: 'emerald',
      bgColor: 'bg-emerald-50',
      textColor: 'text-emerald-600',
      borderColor: 'border-emerald-200',
      badge: `${attendanceRate}%`,
    },
    {
      label: isToday ? tc('late') : t('avgLate'),
      key: 'late',
      value: late,
      icon: Clock,
      color: 'orange',
      bgColor: 'bg-orange-50',
      textColor: 'text-brand-accent-dark',
      borderColor: 'border-orange-200',
    },
    {
      label: isToday ? tc('absent') : t('avgAbsent'),
      key: 'absent',
      value: absent,
      icon: XCircle,
      color: 'red',
      bgColor: 'bg-red-50',
      textColor: 'text-red-600',
      borderColor: 'border-red-200',
    },
  ];

  if (loading) { return ( <div className="grid grid-cols-2 md:grid-cols-4 gap-4"> {[...Array(4)].map((_, i) => ( <div key={i} className="animate-pulse surface-panel p-5"> <div className="h-10 bg-slate-100 rounded mb-3"></div> <div className="h-8 bg-slate-100 rounded mb-2"></div> <div className="h-4 bg-slate-100 rounded w-24"></div> </div> ))} </div> ); } return ( <div className="space-y-4"> {/* Main Stats */} <div className="grid grid-cols-2 md:grid-cols-4 gap-4"> {stats.map((stat) => { const Icon = stat.icon; return ( <div key={stat.label} data-testid={`att-stat-${stat.key}`} data-value={stat.value} className={`bg-white rounded-xl p-5 border ${stat.borderColor} hover:shadow-md transition-shadow`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                  <Icon className={stat.textColor} size={20} strokeWidth={2} />
                </div>
                {stat.badge && (
                  <span className={`px-2 py-0.5 ${stat.bgColor} ${stat.textColor} text-xs font-semibold rounded`}>
                    {stat.badge}
                  </span>
                )}
              </div>
              <p className="text-2xl font-bold text-slate-900 mb-1">{stat.value}</p>
              <p className="text-sm text-slate-600">{stat.label}</p>
            </div>
          );
        })}
      </div>

      {/* Pending Corrections Alert */}
      {pendingCorrections > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
          <div className="p-2 bg-amber-100 rounded-lg">
            <AlertTriangle className="text-amber-600" size={20} strokeWidth={2} />
          </div>
          <div className="flex-1">
            <p data-testid="att-pending-banner" data-count={pendingCorrections} className="text-sm font-semibold text-amber-900"> {t('pendingAdjustments', { count: pendingCorrections })} </p> <p className="text-xs text-amber-700 mt-0.5">{t('pleaseReview')}</p> </div> {onViewCorrections && ( <button data-testid="att-pending-view" onClick={onViewCorrections} className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 transition-colors"
            >
              {t('viewNow')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
