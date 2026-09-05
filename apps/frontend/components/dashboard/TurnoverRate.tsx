'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { UserMinus, TrendingDown, TrendingUp, AlertCircle, Activity } from 'lucide-react';
import { useTranslations } from 'next-intl';
import axiosInstance from '@/lib/axios';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid,
} from 'recharts';
import { chartColors } from '@/theme/chartColors';

interface TurnoverData {
  thisMonth: number;
  lastMonth: number;
  rate: number;
  change: number;
  topDepartment: string;
  trend: number[];
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="kpi-card px-3 py-2 rounded-xl shadow-xl text-xs border border-surface-border">
        <p className="font-bold text-text-heading mb-0.5">{label}</p>
        <p className="text-text-body"><span className="font-extrabold text-brand-primary">{payload[0]?.value?.toFixed(1)}</span>% turnover</p>
      </div>
    );
  }
  return null;
};

export default function TurnoverRate() {
  const [data, setData] = useState<TurnoverData>({
    thisMonth: 0, lastMonth: 0, rate: 0, change: 0,
    topDepartment: 'N/A', trend: [0, 0, 0, 0, 0, 0],
  });
  const t = useTranslations('turnoverRate');
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchTurnover(); }, []);

  const fetchTurnover = async () => {
    try {
      const response: any = await axiosInstance.get('/dashboard/turnover-stats?months=6');
      if (response?.success && response?.data) {
        const d = response.data;
        setData({
          thisMonth: d.thisMonth || 0, lastMonth: d.lastMonth || 0,
          rate: d.rate || 0, change: d.change || 0,
          topDepartment: d.topDepartment || 'N/A',
          trend: d.trend || [0, 0, 0, 0, 0, 0],
        });
      }
    } catch (error: any) {
      console.error('Failed to fetch turnover:', { message: error?.message });
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="surface-panel p-6 animate-pulse h-full">
        <div className="h-5 bg-surface-page rounded w-1/3 mb-4" />
        <div className="h-48 bg-surface-page rounded-xl" />
      </div>
    );
  }

  const isImproving = data.change < 0;
  const isHealthy = data.rate < 5;

  const monthLabels = ['6m', '5m', '4m', '3m', '2m', 'Now'];
  const trendChartData = data.trend.map((v, i) => ({ month: monthLabels[i], rate: v }));
  const maxTrend = Math.max(...data.trend, 1);

  return (
    <div className="surface-panel overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-surface-border-light">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-md ${
            isHealthy ? 'bg-status-success shadow-status-success/20' : 'bg-status-error shadow-status-error/20'
          }`}>
            <UserMinus size={17} className="text-white" strokeWidth={2.2} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-heading">{t('title')}</h3>
            <p className="text-xs text-text-muted mt-0.5">{t('subtitle')}</p>
          </div>
        </div>
        {/* Rate pill */}
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-extrabold ${
          isHealthy
            ? 'bg-status-success-bg text-status-success border-status-success/20'
            : 'bg-status-error-bg text-status-error border-status-error/20'
        }`}>
          {data.rate.toFixed(1)}%
        </div>
      </div>

      {/* Big rate display */}
      <div className="px-6 pt-5 pb-4">
        <div className="flex items-end gap-2 mb-1">
          <span className={`text-5xl font-extrabold tracking-tight leading-none ${
            isHealthy ? 'text-status-success' : 'text-status-error'
          }`}>
            {data.rate.toFixed(1)}%
          </span>
          <span className="text-sm text-text-muted font-medium mb-1">turnover this month</span>
        </div>
        {/* Trend change badge */}
        <div className={`inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-full text-xs font-bold ${
          isImproving
            ? 'bg-status-success-bg text-status-success border border-status-success/20'
            : 'bg-status-error-bg text-status-error border border-status-error/20'
        }`}>
          {isImproving
            ? <TrendingDown size={11} strokeWidth={2.5} />
            : <TrendingUp size={11} strokeWidth={2.5} />
          }
          {isImproving ? 'Down' : 'Up'} {Math.abs(data.change).toFixed(1)}% vs last month
        </div>
      </div>

      {/* This Month / Last Month */}
      <div className="grid grid-cols-2 gap-3 px-6 mb-3">
        <div className="py-2.5 px-3 bg-surface-page rounded-xl border border-surface-border-light text-center">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-[0.08em] mb-0.5">{t('thisMonth')}</p>
          <p className="text-2xl font-extrabold text-text-heading">{data.thisMonth}</p>
          <p className="text-[10px] text-text-muted mt-0.5">{t('people')}</p>
        </div>
        <div className="py-2.5 px-3 bg-surface-page rounded-xl border border-surface-border-light text-center">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-[0.08em] mb-0.5">{t('lastMonth')}</p>
          <p className="text-2xl font-extrabold text-text-heading">{data.lastMonth}</p>
          <p className="text-[10px] text-text-muted mt-0.5">{t('people')}</p>
        </div>
      </div>

      {/* 6-month bar trend chart */}
      <div className="px-5 pb-1 flex-1 min-h-[120px]">
        <p className="text-[10px] font-bold text-text-muted uppercase tracking-[0.08em] mb-2">{t('sixMonthTrend')}</p>
        <ResponsiveContainer width="100%" height="99%">
          <BarChart data={trendChartData} barSize={18} margin={{ top: 2, right: 4, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} strokeOpacity={0.5} vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 9, fill: chartColors.axisText, fontWeight: 600 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 9, fill: chartColors.axisText }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
            <Bar dataKey="rate" radius={[4, 4, 0, 0]}>
              {trendChartData.map((entry, index) => {
                const isLast = index === trendChartData.length - 1;
                const healthy = entry.rate < 5;
                return (
                  <Cell
                    key={`cell-${index}`}
                    fill={isLast
                      ? (healthy ? chartColors.success : chartColors.error)
                      : chartColors.grid
                    }
                  />
                );
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Footer: top department + health status */}
      <div className="px-5 pb-5 mt-3 space-y-2">
        <div className="flex items-start gap-2 p-3 bg-surface-page rounded-xl border border-surface-border-light">
          <AlertCircle size={14} className="text-status-warning flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-[0.06em]">{t('topDepartmentLabel')}</p>
            <p className="text-sm font-bold text-text-heading mt-0.5 truncate">{data.topDepartment}</p>
          </div>
        </div>
        <div className={`flex items-center gap-2 px-3 py-2 rounded-xl ${
          isHealthy ? 'bg-status-success-bg' : 'bg-status-warning-bg'
        }`}>
          <Activity size={13} className={isHealthy ? 'text-status-success' : 'text-status-warning'} />
          <p className={`text-xs font-semibold ${isHealthy ? 'text-status-success' : 'text-status-warning'}`}>
            {isHealthy ? t('healthGood') : t('healthWarning')}
          </p>
        </div>
      </div>
    </div>
  );
}
