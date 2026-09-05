'use client';

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Building2 } from 'lucide-react';
import { chartColors } from '@/theme/chartColors';
import { todayStr } from '@/utils/tzDate';

interface DeptData {
  department: string;
  present: number;
  late: number;
  absent: number;
  total: number;
}

interface DepartmentBreakdownChartProps {
  data: DeptData[];
  loading?: boolean;
  period: 'today' | 'week' | 'month' | 'custom';
  dateFilter?: string;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  const t = useTranslations('departmentBreakdownChart');
  if (active && payload && payload.length) {
    const total = payload.reduce((s: number, p: any) => s + (p.value || 0), 0);
    return (
      <div className="bg-white px-4 py-3 rounded-xl shadow-lg border border-slate-200">
        <p className="font-semibold text-slate-900 mb-2 text-sm">{label}</p>
        <div className="space-y-1">
          {payload.map((p: any) => (
            <div key={p.name} className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ background: p.fill }} />
              <span className="text-xs text-slate-600">{p.name}:</span>
              <span className="text-xs font-semibold" style={{ color: p.fill }}>{p.value}</span>
            </div>
          ))}
          {total > 0 && (
            <div className="pt-1 mt-1 border-t border-slate-100 flex items-center justify-between">
              <span className="text-xs text-slate-500">{t('tooltipAttendanceRate')}</span>
              <span className="text-xs font-bold text-slate-700">
                {Math.round(((payload[0]?.value || 0) / total) * 100)}%
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }
  return null;
};

const DepartmentBreakdownChart = memo(function DepartmentBreakdownChart({
  data,
  loading = false,
  period,
  dateFilter,
}: DepartmentBreakdownChartProps) {
  const t = useTranslations('departmentBreakdownChart');
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

  const periodLabel =
    period === 'today'
      ? isToday
        ? tc('today')
        : formatDate(dateFilter)
      : period === 'week'
      ? tc('thisWeek')
      : period === 'month'
      ? tc('thisMonth')
      : tc('customRange');

  if (loading) {
    return (
      <div className="surface-panel p-6">
        <div className="animate-pulse">
          <div className="h-6 bg-slate-100 rounded w-56 mb-4" />
          <div className="h-56 bg-slate-100 rounded" />
        </div>
      </div>
    );
  }

  const hasData = data && data.length > 0;

  // Truncate long department names
  const chartData = data.map((d) => ({
    ...d,
    department: d.department.length > 12 ? d.department.slice(0, 12) + '…' : d.department,
  }));

  return (
    <div className="surface-panel overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-violet-100 rounded-lg">
              <Building2 size={20} className="text-violet-600" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-900">{t('title')}</h3>
              <p className="text-sm text-slate-500 mt-0.5">{t('subtitle', { period: periodLabel })}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="p-6">
        {hasData ? (
          <>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }} barSize={18}>
                <defs>
                  <linearGradient id="presentGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={chartColors.success} stopOpacity={1} />
                    <stop offset="100%" stopColor={chartColors.success} stopOpacity={0.6} />
                  </linearGradient>
                  <linearGradient id="lateGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={chartColors.warning} stopOpacity={1} />
                    <stop offset="100%" stopColor={chartColors.warning} stopOpacity={0.6} />
                  </linearGradient>
                  <linearGradient id="absentGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={chartColors.error} stopOpacity={1} />
                    <stop offset="100%" stopColor={chartColors.error} stopOpacity={0.6} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} vertical={false} />
                <XAxis
                  dataKey="department"
                  tick={{ fill: chartColors.axisText, fontSize: 11, fontWeight: 500 }}
                  stroke={chartColors.grid}
                />
                <YAxis tick={{ fill: chartColors.axisText, fontSize: 11 }} stroke={chartColors.grid} allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: '12px', fontWeight: 500, paddingTop: '8px' }}
                  iconType="circle"
                  iconSize={8}
                />
                <Bar dataKey="present" name={tc('present')} fill="url(#presentGrad)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="late" name={tc('late')} fill="url(#lateGrad)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="absent" name={tc('absent')} fill="url(#absentGrad)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>

            {/* Department Cards */}
            <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 lg:grid-cols-3 gap-2">
              {data.slice(0, 6).map((dept) => {
                const rate = dept.total > 0 ? Math.round((dept.present / dept.total) * 100) : 0;
                const rateColor = rate >= 90 ? 'text-emerald-600' : rate >= 70 ? 'text-brand-accent' : 'text-red-500';
                return (
                  <div key={dept.department} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                    <p className="text-xs font-medium text-slate-700 truncate max-w-[60%]">{dept.department}</p>
                    <span className={`text-xs font-bold ${rateColor}`}>{rate}%</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-3">
              <Building2 size={32} className="text-slate-400" />
            </div>
            <p className="text-sm font-medium text-slate-600 mb-1">{t('noData')}</p>
            <p className="text-xs text-slate-400">{t('noDataDesc')}</p>
          </div>
        )}
      </div>
    </div>
  );
});

export default DepartmentBreakdownChart;
