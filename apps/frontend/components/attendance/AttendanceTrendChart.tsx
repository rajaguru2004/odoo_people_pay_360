'use client';

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Area, AreaChart } from 'recharts';
import { TrendingUp } from 'lucide-react';
import { chartColors } from '@/theme/chartColors';

interface TrendData {
  date: string;
  attendanceRate: number;
  lateRate: number;
  present?: number;
  absent?: number;
  total: number;
}

interface AttendanceTrendChartProps {
  data: TrendData[];
  loading?: boolean;
  period?: 'today' | 'week' | 'month' | 'custom';
}

const CustomTooltip = ({ active, payload }: any) => {
  const t = useTranslations('attendanceTrendChart');
  if (active && payload && payload.length) {
    return (
      <div className="bg-white px-4 py-3 rounded-xl shadow-lg border border-slate-200">
        <p className="font-semibold text-slate-900 mb-2">{payload[0].payload.date}</p>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-emerald-500 rounded-full"></div>
            <span className="text-sm text-slate-600">{t('tooltipPresent')}</span>
            <span className="text-sm font-semibold text-emerald-600">{payload[0].value}%</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-brand-accent rounded-full"></div>
            <span className="text-sm text-slate-600">{t('tooltipLate')}</span>
            <span className="text-sm font-semibold text-brand-accent-dark">{payload[1].value}%</span>
          </div>
        </div>
      </div>
    );
  }
  return null;
};

const AttendanceTrendChart = memo(function AttendanceTrendChart({ data, loading = false, period = 'today' }: AttendanceTrendChartProps) {
  const t = useTranslations('attendanceTrendChart');
  const tc = useTranslations('common');

  if (loading) {
    return (
      <div className="surface-panel p-6">
        <div className="animate-pulse">
          <div className="h-6 bg-slate-100 rounded w-48 mb-4"></div>
          <div className="h-64 bg-slate-100 rounded"></div>
        </div>
      </div>
    );
  }

  // Check if we have valid data
  const hasData = data && data.length > 0;
  const avgAttendanceVal = hasData ? data.reduce((sum, d) => sum + d.attendanceRate, 0) / data.length : 0;
  const avgLateVal = hasData ? data.reduce((sum, d) => sum + d.lateRate, 0) / data.length : 0;
  const avgAttendance = period === 'today' ? avgAttendanceVal.toFixed(1) : Math.round(avgAttendanceVal);
  const avgLate = period === 'today' ? avgLateVal.toFixed(1) : Math.round(avgLateVal);
  const trend = hasData && data.length >= 2 ? data[data.length - 1].attendanceRate - data[0].attendanceRate : 0;

  const isToday = period === 'today';
  const hasChartData = hasData && (
    isToday
      ? data.some((d) => (d.present ?? 0) > 0)
      : data.some((d) => (d.total ?? 0) > 0 || (d.present ?? 0) > 0)
  );
  const chartTitle =
    isToday
      ? t('titleToday')
      : period === 'week'
      ? t('title7Day')
      : period === 'month'
      ? t('titleMonthly')
      : t('titleCustom');
  const chartSubtitle =
    isToday
      ? t('subtitleToday')
      : period === 'week'
      ? t('subtitle7Day')
      : period === 'month'
      ? t('subtitleMonthly')
      : t('subtitleCustom');
  const yAxisFormatter = isToday ? (v: number) => `${v}` : (v: number) => `${v}%`;
  const presentLabel = isToday ? t('checkIns') : t('presenceRate');
  const lateLabel = isToday ? t('lateArrivals') : t('lateRate');
  const avgPresentLabel = isToday ? t('avgHrCheckIns') : t('avgPresence');
  const avgPresentUnit = isToday ? '' : '%';
  const avgLateUnit = isToday ? '' : '%';



  return (
    <div className="surface-panel overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <div className="p-2 bg-brand-primary-light/20 rounded-lg">
                <TrendingUp size={20} className="text-brand-primary" />
              </div>
              {chartTitle}
            </h3>
            <p className="text-sm text-slate-600 mt-1 ms-11">{chartSubtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            {trend > 0 ? (
              <div className="flex items-center gap-1 px-3 py-1.5 bg-emerald-50 rounded-lg border border-emerald-200">
                <TrendingUp size={16} className="text-emerald-600" />
                <span className="text-sm font-semibold text-emerald-600">+{trend.toFixed(1)}%</span>
              </div>
            ) : trend < 0 ? (
              <div className="flex items-center gap-1 px-3 py-1.5 bg-red-50 rounded-lg border border-red-200">
                <TrendingUp size={16} className="text-red-600 rotate-180" />
                <span className="text-sm font-semibold text-red-600">{trend.toFixed(1)}%</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="p-6">
        {hasChartData ? (
          <>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="colorAttendance" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartColors.success} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={chartColors.success} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorLate" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartColors.warning} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={chartColors.warning} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke={chartColors.axisText}
                  style={{ fontSize: '13px', fontWeight: 500 }}
                  tick={{ fill: chartColors.axisText }}
                />
                <YAxis
                  stroke={chartColors.axisText}
                  style={{ fontSize: '12px' }}
                  tickFormatter={yAxisFormatter}
                  tick={{ fill: chartColors.axisText }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: '13px', fontWeight: 500 }}
                  iconType="circle"
                />
                <Area
                  type="monotone"
                  dataKey="attendanceRate"
                  stroke={chartColors.success}
                  strokeWidth={3}
                  fill="url(#colorAttendance)"
                  dot={{ fill: chartColors.success, r: 5, strokeWidth: 2, stroke: '#ffffff' }}
                  activeDot={{ r: 7, strokeWidth: 2 }}
                  name={presentLabel}
                />
                <Area
                  type="monotone"
                  dataKey="lateRate"
                  stroke={chartColors.warning}
                  strokeWidth={3}
                  fill="url(#colorLate)"
                  dot={{ fill: chartColors.warning, r: 5, strokeWidth: 2, stroke: '#ffffff' }}
                  activeDot={{ r: 7, strokeWidth: 2 }}
                  name={lateLabel}
                />
              </AreaChart>
            </ResponsiveContainer>

            {/* Summary Stats */}
            <div className="mt-4 pt-4 border-t border-slate-200">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-200">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                    <p className="text-xs font-semibold text-emerald-700 uppercase">{avgPresentLabel}</p>
                  </div>
                  <p className="text-xl font-bold text-emerald-600">{avgAttendance}{avgPresentUnit}</p>
                  <p className="text-xs text-emerald-600 mt-0.5">
                    {isToday ? tc('today') : period === 'week' ? t('last7Days') : period === 'month' ? tc('thisMonth') : t('selectedRange')}
                  </p>
                </div>
                <div className="p-3 bg-orange-50 rounded-lg border border-orange-200">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-2 h-2 bg-brand-accent rounded-full"></div>
                    <p className="text-xs font-semibold text-orange-700 uppercase">{t('averageLate')}</p>
                  </div>
                  <p className="text-xl font-bold text-brand-accent-dark">{avgLate}{avgLateUnit}</p>
                  <p className="text-xs text-brand-accent-dark mt-0.5">
                    {isToday ? tc('today') : period === 'week' ? t('last7Days') : period === 'month' ? tc('thisMonth') : t('selectedRange')}
                  </p>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-3">
              <TrendingUp size={32} className="text-slate-400" />
            </div>
            <p className="text-sm font-medium text-slate-600 mb-1">
              {isToday ? t('noCheckIns') : t('noData')}
            </p>
            <p className="text-xs text-slate-500">
              {isToday ? t('noCheckInsDesc') : t('noDataDesc')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
});

export default AttendanceTrendChart;
