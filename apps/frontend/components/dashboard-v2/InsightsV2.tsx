'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { generateSparkPath } from '@/utils/sparkUtils';

interface InsightsV2Props {
  newHires?: number;
  newHiresTrend?: number;
  newHiresData?: number[];
  leaveRequests?: number;
  leaveRequestsTrend?: number;
  leaveRequestsData?: number[];
  overtimeHours?: number;
  overtimeHoursTrend?: number;
  overtimeHoursData?: number[];
  period?: 'this_month' | 'last_month' | 'this_year';
  onPeriodChange?: (period: 'this_month' | 'last_month' | 'this_year') => void;
}

export default function InsightsV2({
  newHires = 0,
  newHiresTrend = 0,
  newHiresData = [],
  leaveRequests = 0,
  leaveRequestsTrend = 0,
  leaveRequestsData = [],
  overtimeHours = 0,
  overtimeHoursTrend = 0,
  overtimeHoursData = [],
  period = 'this_month',
  onPeriodChange,
}: InsightsV2Props) {
  const router = useRouter();
  const t = useTranslations('dashboardV2.insights');

  const getSparkline = (trend: number, dataArr: number[]) => {
    const hasTrend = trend >= 0;
    const path = generateSparkPath(dataArr);
    return {
      color: hasTrend ? '#10b981' : '#f59e0b',
      path,
      isPositive: hasTrend,
    };
  };

  const formatTrendPct = (trend: number) => (Number.isFinite(trend) ? `${Math.abs(trend).toFixed(1)}%` : '—');

  const nhSpark = getSparkline(newHiresTrend, newHiresData);
  const lrSpark = getSparkline(leaveRequestsTrend, leaveRequestsData);
  const ohSpark = getSparkline(overtimeHoursTrend, overtimeHoursData);

  const items = [
    {
      label: t('newHires'),
      value: newHires,
      trend: formatTrendPct(newHiresTrend),
      isPositive: nhSpark.isPositive,
      sparklineColor: nhSpark.color,
      sparklinePath: nhSpark.path,
      link: '/dashboard/employees',
    },
    {
      label: t('leaveRequests'),
      value: leaveRequests,
      trend: formatTrendPct(leaveRequestsTrend),
      isPositive: lrSpark.isPositive,
      sparklineColor: lrSpark.color,
      sparklinePath: lrSpark.path,
      link: '/dashboard/leaves',
    },
    {
      label: t('overtimeHours'),
      value: overtimeHours,
      trend: formatTrendPct(overtimeHoursTrend),
      isPositive: ohSpark.isPositive,
      sparklineColor: ohSpark.color,
      sparklinePath: ohSpark.path,
      link: '/dashboard/overtime',
    },
  ];

  return (
    <div className="surface-panel p-4 flex flex-col justify-between h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-slate-800">{t('title')}</h4>
        <select 
          value={period}
          onChange={(e) => onPeriodChange?.(e.target.value as any)}
          className="text-[11px] font-semibold text-slate-500 bg-slate-50 border border-slate-200/80 px-2 py-1 rounded-lg hover:bg-slate-100 transition-colors outline-none cursor-pointer"
        >
          <option value="this_month">{t('thisMonth')}</option>
          <option value="last_month">{t('lastMonth')}</option>
          <option value="this_year">{t('thisYear')}</option>
        </select>
      </div>

      {/* Rows */}
      <div className="flex-1 mt-3 flex flex-col justify-between min-h-0">
        {items.map((item) => (
          <div
            key={item.label}
            onClick={() => router.push(item.link)}
            className="flex items-center justify-between gap-4 p-2 rounded-xl hover:bg-slate-50/50 transition-colors duration-200 cursor-pointer"
          >
            {/* Value Label block */}
            <div className="flex-1 min-w-[80px]">
              <span className="text-[10px] font-bold text-slate-400 block">{item.label}</span>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-base font-black text-slate-700">{item.value}</span>
                <span className={`inline-flex items-center gap-0.5 text-[9px] font-extrabold px-1 py-0.5 rounded-full ${
                  item.isPositive 
                    ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' 
                    : 'bg-amber-50 text-amber-600 border border-amber-100'
                }`}>
                  {item.isPositive ? <ArrowUpRight size={8} /> : <ArrowDownRight size={8} />}
                  <span>{item.trend}</span>
                </span>
              </div>
            </div>

            {/* Sparkline block */}
            <div className="w-[120px] h-8 flex-shrink-0">
              <svg viewBox="0 0 120 32" className="w-full h-full" fill="none">
                <path
                  d={item.sparklinePath}
                  stroke={item.sparklineColor}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
