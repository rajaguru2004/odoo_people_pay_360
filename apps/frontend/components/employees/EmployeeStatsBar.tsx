'use client';

import { Employee } from '@/types/employee';
import { Users, UserCheck, UserX, UserMinus, Building2, TrendingUp } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface EmployeeStatsBarProps {
  employees: Employee[];
  departmentCount: number;
  totalEmployees?: number;
  statistics?: {
    byStatus: Array<{ status: string; count: number }>;
  };
}

export default function EmployeeStatsBar({ employees, departmentCount, totalEmployees, statistics }: EmployeeStatsBarProps) {
  const t = useTranslations('employeeStatsBarEmp');
  const tc = useTranslations('common');
  // Get real counts from statistics if available, otherwise fallback to current page
  const getStatusCount = (status: string) => {
    if (statistics?.byStatus) {
      const stat = statistics.byStatus.find(s => s.status === status);
      return stat?.count || 0;
    }
    // Fallback to current page data
    return employees.filter(e => e.status === status).length;
  };

  const stats = {
    total: totalEmployees || employees.length,
    active: getStatusCount('ACTIVE'),
    onLeave: getStatusCount('ON_LEAVE'),
    terminated: getStatusCount('TERMINATED'),
    departments: departmentCount,
  };

  const activeRate = stats.total > 0 ? ((stats.active / stats.total) * 100).toFixed(1) : 0;

  const statCards = [
    {
      key: 'total',
      label: t('totalEmployees'),
      value: stats.total,
      icon: Users,
      color: 'text-brand-primary',
      bgColor: 'bg-gradient-to-br from-blue-50 to-blue-100',
      borderColor: 'border-brand-primary-light/50',
      iconBg: 'bg-brand-primary-light/100',
    },
    {
      key: 'active',
      label: tc('active'),
      value: stats.active,
      icon: UserCheck,
      color: 'text-green-600',
      bgColor: 'bg-gradient-to-br from-green-50 to-green-100',
      borderColor: 'border-green-300',
      iconBg: 'bg-green-500',
      badge: `${activeRate}%`,
    },
    {
      key: 'onLeave',
      label: tc('onLeaveStatus'),
      value: stats.onLeave,
      icon: UserX,
      color: 'text-amber-600',
      bgColor: 'bg-gradient-to-br from-amber-50 to-amber-100',
      borderColor: 'border-amber-300',
      iconBg: 'bg-amber-500',
    },
    {
      key: 'terminated',
      label: tc('terminated'),
      value: stats.terminated,
      icon: UserMinus,
      color: 'text-red-600',
      bgColor: 'bg-gradient-to-br from-red-50 to-red-100',
      borderColor: 'border-red-300',
      iconBg: 'bg-red-500',
    },
    {
      key: 'departments',
      label: t('departments'),
      value: stats.departments,
      icon: Building2,
      color: 'text-purple-600',
      bgColor: 'bg-gradient-to-br from-purple-50 to-purple-100',
      borderColor: 'border-purple-300',
      iconBg: 'bg-purple-500',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
      {statCards.map((stat, index) => {
        const Icon = stat.icon;
        return (
          <div
            key={index}
            data-testid={`emp-stat-${stat.key}`}
            className={`${stat.bgColor} rounded-xl p-5 border-2 ${stat.borderColor} hover:shadow-xl hover:scale-105 transition-all duration-300 relative overflow-hidden`}
          >
            {/* Background decoration */}
            <div className="absolute top-0 end-0 w-24 h-24 bg-white/20 rounded-full -me-12 -mt-12"></div>
            
            <div className="relative">
              <div className="flex items-start justify-between mb-3">
                <div className={`p-3 rounded-xl ${stat.iconBg} text-white shadow-lg`}>
                  <Icon size={24} />
                </div>
                {stat.badge && (
                  <span className={`px-3 py-1 bg-white/80 backdrop-blur-sm ${stat.color} rounded-full text-xs font-bold border-2 ${stat.borderColor} shadow-md`}>
                    {stat.badge}
                  </span>
                )}
              </div>
              <p data-testid={`emp-stat-${stat.key}-value`} className="text-3xl font-bold text-slate-900 mb-1">{stat.value}</p>
              <p className="text-xs text-slate-600 font-semibold uppercase tracking-wide">{stat.label}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
