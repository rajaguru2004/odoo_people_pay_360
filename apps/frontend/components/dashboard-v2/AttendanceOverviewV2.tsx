'use client';

import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { ChevronDown, ArrowUp, AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AttendanceOverviewV2Props {
  totalEmployees?: number;
  present?: number;
  late?: number;
  absent?: number;
  onLeave?: number;
  halfDay?: number;
}

export default function AttendanceOverviewV2({
  totalEmployees = 0,
  present = 0,
  late = 0,
  absent = 0,
  onLeave = 0,
  halfDay = 0,
}: AttendanceOverviewV2Props) {
  const t = useTranslations('dashboardV2.attendance');
  const sum = present + absent + onLeave + halfDay;
  const total = Math.max(totalEmployees, sum) || 1;
  const unmarked = Math.max(0, total - sum);
  const onTime = Math.max(0, present - late);
  
  const presentRate = Math.round((present / total) * 100);

  const data = [
    { name: t('onTime'), value: onTime, percentage: `${Math.round((onTime / total) * 100)}%`, color: '#10b981' },
    { name: t('late'), value: late, percentage: `${Math.round((late / total) * 100)}%`, color: '#facc15' },
    { name: t('absent'), value: absent, percentage: `${Math.round((absent / total) * 100)}%`, color: '#f43f5e' },
    { name: t('onLeave'), value: onLeave, percentage: `${Math.round((onLeave / total) * 100)}%`, color: '#f59e0b' },
    ...(unmarked > 0 ? [{ name: t('notCheckedIn'), value: unmarked, percentage: `${Math.round((unmarked / total) * 100)}%`, color: '#cbd5e1' }] : []),
  ];

  const getAlertBarConfig = () => {
    if (onLeave > 10) {
      return {
        bg: 'bg-amber-50 border-amber-100',
        iconBg: 'bg-amber-500',
        textColor: 'text-amber-800',
        Icon: AlertCircle,
        text: t('alertHighLeave', { count: onLeave }),
      };
    }
    if (absent > 0) {
      return {
        bg: 'bg-rose-50 border-rose-100',
        iconBg: 'bg-rose-500',
        textColor: 'text-rose-800',
        Icon: AlertTriangle,
        text: t('alertAbsent', { count: absent }),
      };
    }
    if (presentRate >= 80) {
      return {
        bg: 'bg-emerald-50 border-emerald-100',
        iconBg: 'bg-emerald-500',
        textColor: 'text-emerald-800',
        Icon: ArrowUp,
        text: t('alertStrong', { rate: presentRate }),
      };
    }
    return {
      bg: 'bg-blue-50 border-blue-100',
      iconBg: 'bg-blue-500',
      textColor: 'text-blue-800',
      Icon: CheckCircle2,
      text: t('alertStable', { rate: presentRate }),
    };
  };

  const alertConfig = getAlertBarConfig();
  const AlertIcon = alertConfig.Icon;

  return (
    <div className="surface-panel p-4 flex flex-col justify-between h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-slate-800">{t('title')}</h4>
      </div>

      {/* Donut Chart & Legend wrapper */}
      <div className="flex items-center justify-center gap-4 my-2 flex-1 min-h-0">
        {/* Donut chart */}
        <div className="relative w-[130px] h-[130px] flex-shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={45}
                outerRadius={60}
                paddingAngle={2}
                dataKey="value"
                startAngle={90}
                endAngle={-270}
                stroke="none"
              >
                {data.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} style={{ outline: 'none' }} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>

          {/* Center text */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-xl font-black text-slate-800 leading-none">{presentRate}%</span>
            <span className="text-[9px] font-bold text-slate-400 uppercase mt-0.5">{t('present')}</span>
          </div>
        </div>

        {/* Legend */}
        <div className="flex-1 space-y-1.5 text-xs">
          {data.filter(item => item.name !== 'Unmarked').map((item) => (
            <div key={item.name} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: item.color }} />
                <span className="font-semibold text-slate-600 text-[11px]">{item.name}</span>
              </div>
              <div className="text-right flex items-center justify-end">
                <span className="font-bold text-slate-800 text-[11px] mr-2">{item.value}</span>
                <span className="text-slate-400 font-bold text-[10px] w-8 text-right">{item.percentage}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Alert bar */}
      <div className={`${alertConfig.bg} border rounded-lg p-2 flex items-center gap-2 mt-1`}>
        <div className={`w-5 h-5 rounded-md ${alertConfig.iconBg} flex items-center justify-center text-white shrink-0`}>
          <AlertIcon size={12} strokeWidth={2.5} />
        </div>
        <span className={`text-[10px] font-bold ${alertConfig.textColor}`}>
          {alertConfig.text}
        </span>
      </div>
    </div>
  );
}
