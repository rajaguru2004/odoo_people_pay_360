'use client';

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Building2, TrendingUp } from 'lucide-react';
import { chartColors } from '@/theme/chartColors';

interface DepartmentData {
  name: string;
  attendanceRate: number;
  lateRate: number;
  total: number;
}

interface DepartmentComparisonChartProps {
  data: DepartmentData[];
  loading?: boolean;
}

const CustomTooltip = ({ active, payload }: any) => {
  const t = useTranslations('departmentLatenessChart');
  if (active && payload && payload.length) {
    const toolData = payload[0].payload;
    return (
      <div className="bg-surface-overlay px-4 py-3 rounded-[--radius-card] shadow-xl border border-surface-border">
        <p className="font-semibold text-text-heading mb-2">{toolData.name}</p>
        <div className="space-y-1 text-sm">
          <p className="text-text-muted">
            {t('tooltipLateRate')} <span className="font-bold text-brand-accent">{toolData.lateRate}%</span>
          </p>
          <p className="text-text-muted">
            {t('tooltipAttendanceRate')} <span className="font-bold text-status-success">{toolData.attendanceRate}%</span>
          </p>
          <p className="text-text-muted">
            {t('tooltipTotalEmployees')} <span className="font-bold text-text-body">{toolData.total}</span>
          </p>
        </div>
      </div>
    );
  }
  return null;
};

const DepartmentComparisonChart = memo(function DepartmentComparisonChart({ data, loading = false }: DepartmentComparisonChartProps) {
  const t = useTranslations('departmentLatenessChart');
  const tc = useTranslations('common');

  if (loading) {
    return (
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6 shadow-sm">
        <div className="animate-pulse">
          <div className="h-6 bg-slate-100 rounded w-48 mb-4"></div> {/* neutral */}
          <div className="h-80 bg-slate-100 rounded"></div> {/* neutral */}
        </div>
      </div>
    );
  }

  // Sort by late rate descending and take top 5
  const sortedData = [...data]
    .filter(d => d.total > 0) // Only show departments with employees
    .sort((a, b) => b.lateRate - a.lateRate)
    .slice(0, 5);

  // If no data, show empty state
  if (sortedData.length === 0) {
    return (
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-surface-border bg-surface-page">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-brand-accent/10 rounded-[--radius-card]">
              <Building2 size={20} className="text-brand-accent" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-text-heading">{t('title')}</h3>
              <p className="text-sm text-text-muted mt-1">{t('emptySubtitle')}</p>
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="h-80 flex flex-col items-center justify-center text-text-muted">
            <Building2 size={48} className="mb-3 opacity-50" />
            <p className="text-sm font-medium">{t('noData')}</p>
          </div>
        </div>
      </div>
    );
  }

  const getBarColor = (rateVal: number) => {
    if (rateVal < 10) return chartColors.success;
    if (rateVal < 20) return chartColors.warning;
    return chartColors.error;
  };

  // Calculate summary stats
  const goodCount = sortedData.filter(d => d.lateRate < 10).length;
  const mediumCount = sortedData.filter(d => d.lateRate >= 10 && d.lateRate < 20).length;
  const badCount = sortedData.filter(d => d.lateRate >= 20).length;

  return (
    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-5 border-b border-surface-border bg-surface-page">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-brand-accent/10 rounded-[--radius-card]">
              <Building2 size={20} className="text-brand-accent" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-text-heading">{t('title')}</h3>
              <p className="text-sm text-text-muted mt-1">{t('subtitle')}</p>
            </div>
          </div>
          {badCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-brand-accent/5 rounded-[--radius-card] border border-brand-accent/20">
              <TrendingUp size={16} className="text-brand-accent" />
              <span className="text-sm font-semibold text-brand-accent">{t('needsImprovement')}</span>
            </div>
          )}
        </div>
      </div>

      {/* Chart */}
      <div className="p-6">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={sortedData} layout="horizontal" margin={{ top: 10, right: 50, left: 10, bottom: 10 }} >
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} strokeOpacity={0.5} horizontal={true} vertical={false} />
            <XAxis
              type="category"
              dataKey="name"
              stroke={chartColors.axisText}
              tick={{ fill: chartColors.axisText, fontSize: 12 }}
            />
            <YAxis
              type="number"
              stroke={chartColors.axisText}
              tick={{ fill: chartColors.axisText, fontSize: 12 }}
              tickFormatter={(value) => `${value}%`}
              domain={[0, 'auto']}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(148, 163, 184, 0.1)' }} /> {/* neutral background cursor */}
            <Bar
              dataKey="lateRate"
              radius={[8, 8, 0, 0]}
              label={{
                position: 'top',
                fill: chartColors.axisText,
                fontSize: 12,
                fontWeight: 600,
                formatter: (value: any) => `${value}%`
              }}
            >
              {sortedData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={getBarColor(entry.lateRate)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-4 mt-6 pt-6 border-t border-surface-border">
          <div className="p-4 bg-status-success-bg/30 rounded-[--radius-card] border border-status-success/20">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2.5 h-2.5 bg-status-success rounded-full"></div>
              <span className="text-xs font-bold text-status-success">{t('good')}</span>
            </div>
            <p className="text-2xl font-bold text-status-success">{goodCount}</p>
            <p className="text-xs text-status-success/80 mt-0.5">{t('lessThan10')}</p>
          </div>

          <div className="p-4 bg-status-warning-bg/30 rounded-[--radius-card] border border-status-warning/20">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2.5 h-2.5 bg-status-warning rounded-full"></div>
              <span className="text-xs font-bold text-status-warning">{tc('average')}</span>
            </div>
            <p className="text-2xl font-bold text-status-warning">{mediumCount}</p>
            <p className="text-xs text-status-warning/80 mt-0.5">{t('between10And20')}</p>
          </div>

          <div className="p-4 bg-status-error-bg/30 rounded-[--radius-card] border border-status-error/20">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2.5 h-2.5 bg-status-error rounded-full"></div>
              <span className="text-xs font-bold text-status-error">{t('needsImprovement')}</span>
            </div>
            <p className="text-2xl font-bold text-status-error">{badCount}</p>
            <p className="text-xs text-status-error/80 mt-0.5">{t('over20')}</p>
          </div>
        </div>
      </div>
    </div>
  );
});

export default DepartmentComparisonChart;
