'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus, CalendarDays, Building2, TrendingUp } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface QuickActionProps {
  label: string;
  icon: React.ElementType;
  colorClass: string;
  bgHover: string;
  textColor: string;
  link: string;
}

export default function QuickActionsV2() {
  const router = useRouter();
  const t = useTranslations('dashboardV2.quickActions');

  const actions: QuickActionProps[] = [
    {
      label: t('addEmployee'),
      icon: UserPlus,
      colorClass: 'bg-purple-50 text-purple-600 border border-purple-100 hover:border-purple-200',
      bgHover: 'group-hover:bg-purple-100',
      textColor: 'text-purple-700',
      link: '/dashboard/employees?action=new',
    },
    {
      label: t('requestLeave'),
      icon: CalendarDays,
      colorClass: 'bg-emerald-50 text-emerald-600 border border-emerald-100 hover:border-emerald-200',
      bgHover: 'group-hover:bg-emerald-100',
      textColor: 'text-emerald-700',
      link: '/dashboard/leaves?action=new',
    },
    {
      label: t('addDepartment'),
      icon: Building2,
      colorClass: 'bg-blue-50 text-blue-600 border border-blue-100 hover:border-blue-200',
      bgHover: 'group-hover:bg-blue-100',
      textColor: 'text-blue-700',
      link: '/dashboard/departments?action=new',
    },
    {
      label: t('attendanceInsights'),
      icon: TrendingUp,
      colorClass: 'bg-amber-50 text-amber-600 border border-amber-100 hover:border-amber-200',
      bgHover: 'group-hover:bg-amber-100',
      textColor: 'text-amber-700',
      link: '/dashboard/attendance',
    },
  ];

  return (
    <div className="surface-panel p-4 flex flex-col justify-between h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-slate-800">{t('title')}</h4>
        <button
          onClick={() => router.push('/dashboard/my-calendar')}
          className="text-[10px] font-bold text-slate-400 hover:text-slate-600 transition-colors"
        >
          {t('viewCalendar')}
        </button>
      </div>

      {/* 2x2 Grid */}
      <div className="grid grid-cols-2 gap-2.5 mt-3 flex-1">
        {actions.map((act) => {
          const Icon = act.icon;
          return (
            <button
              key={act.label}
              onClick={() => router.push(act.link)}
              className={`group flex flex-col items-center justify-center p-3 rounded-xl transition-all duration-200 ${act.colorClass} shadow-sm hover:shadow active:scale-95 cursor-pointer`}
            >
              <div className={`p-2 rounded-lg bg-white/70 group-hover:scale-110 transition-transform duration-200`}>
                <Icon size={16} strokeWidth={2.2} />
              </div>
              <span className={`text-[10px] font-extrabold mt-2 text-center leading-tight ${act.textColor}`}>
                {act.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
