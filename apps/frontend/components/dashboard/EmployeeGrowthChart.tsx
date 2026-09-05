'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Users, TrendingUp, UserPlus, UserMinus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import axiosInstance from '@/lib/axios';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot,
} from 'recharts';
import { chartColors } from '@/theme/chartColors';

interface MonthlyGrowth {
  month: string;
  total: number;
  joined: number;
  left: number;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="kpi-card px-3 py-2.5 rounded-xl shadow-xl text-xs border border-surface-border">
        <p className="font-bold text-text-heading mb-1">{label}</p>
        <p className="text-text-body">
          <span className="font-extrabold text-brand-primary">{payload[0]?.value}</span> employees
        </p>
      </div>
    );
  }
  return null;
};

export default function EmployeeGrowthChart() {
  const [data, setData] = useState<MonthlyGrowth[]>([]);
  const t = useTranslations('employeeGrowth');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    currentTotal: 0,
    monthlyGrowth: 0,
    joinedThisMonth: 0,
    leftThisMonth: 0,
  });

  useEffect(() => { fetchEmployeeGrowth(); }, []);

  const fetchEmployeeGrowth = async () => {
    try {
      const response = await axiosInstance.get('/employees', { params: { limit: 1000, page: 1 } });
      if (response.data) {
        const employees = Array.isArray(response.data) ? response.data : (response.data?.data || []);
        const currentTotal = employees.length;
        const now = new Date();
        const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const growthData: MonthlyGrowth[] = [];

        for (let i = 5; i >= 0; i--) {
          const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const monthIndex = targetDate.getMonth();
          const year = targetDate.getFullYear();
          const endOfMonth = new Date(year, monthIndex + 1, 0);

          const joined = employees.filter((emp: any) => {
            const startDate = emp.startDate ? new Date(emp.startDate) : null;
            if (!startDate) return false;
            return startDate.getMonth() === monthIndex && startDate.getFullYear() === year;
          }).length;

          const left = employees.filter((emp: any) => {
            const endDate = emp.endDate ? new Date(emp.endDate) : null;
            if (!endDate) return false;
            return endDate.getMonth() === monthIndex && endDate.getFullYear() === year;
          }).length;

          const total = employees.filter((emp: any) => {
            const startDate = emp.startDate ? new Date(emp.startDate) : null;
            if (!startDate) return false;
            if (startDate > endOfMonth) return false;
            const endDate = emp.endDate ? new Date(emp.endDate) : null;
            return !endDate || endDate >= endOfMonth;
          }).length;

          growthData.push({ month: monthNames[monthIndex], total, joined, left });
        }

        setData(growthData);

        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        const joinedThisMonth = employees.filter((emp: any) => {
          const startDate = emp.startDate ? new Date(emp.startDate) : null;
          if (!startDate) return false;
          return startDate.getMonth() === currentMonth && startDate.getFullYear() === currentYear;
        }).length;

        const previousMonthTotal = growthData.length > 1 ? growthData[growthData.length - 2].total : currentTotal;
        const monthlyGrowth = previousMonthTotal > 0
          ? ((currentTotal - previousMonthTotal) / previousMonthTotal) * 100
          : 0;

        setStats({ currentTotal, monthlyGrowth, joinedThisMonth, leftThisMonth: 0 });
      }
    } catch (error) {
      console.error('Failed to fetch employee growth:', error);
      setData([]);
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

  const isGrowthPositive = stats.monthlyGrowth >= 0;

  return (
    <div className="surface-panel overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-surface-border-light">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center shadow-md shadow-brand-primary/20">
            <TrendingUp size={17} className="text-white" strokeWidth={2.2} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-heading">{t('title')}</h3>
            <p className="text-xs text-text-muted mt-0.5">{t('subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-primary/10 rounded-full border border-brand-primary/15">
          <Users size={13} className="text-brand-primary" />
          <span className="text-xs font-extrabold text-brand-primary">{stats.currentTotal}</span>
        </div>
      </div>

      {/* Growth badge */}
      <div className="px-6 pt-4 pb-2">
        <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold ${
          isGrowthPositive
            ? 'bg-status-success-bg text-status-success border border-status-success/20'
            : 'bg-status-error-bg text-status-error border border-status-error/20'
        }`}>
          <TrendingUp size={11} strokeWidth={2.5} className={isGrowthPositive ? '' : 'rotate-180'} />
          {isGrowthPositive ? '+' : ''}{stats.monthlyGrowth.toFixed(1)}% growth this period
        </div>
      </div>

      {/* Recharts AreaChart */}
      <div className="flex-1 px-2 pb-2 min-h-[160px]">
        <ResponsiveContainer width="100%" height="99%">
          <AreaChart data={data} margin={{ top: 10, right: 10, left: -28, bottom: 0 }}>
            <defs>
              <linearGradient id="growthGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColors.primary} stopOpacity={0.25} />
                <stop offset="90%" stopColor={chartColors.primary} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke={chartColors.grid}
              strokeOpacity={0.6}
              vertical={false}
            />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 10, fill: chartColors.axisText, fontWeight: 600 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: chartColors.axisText }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: chartColors.primary, strokeWidth: 1, strokeDasharray: '4 2' }} />
            <Area
              type="monotone"
              dataKey="total"
              stroke={chartColors.primary}
              strokeWidth={2.5}
              fill="url(#growthGrad)"
              dot={{ fill: chartColors.primary, strokeWidth: 2, stroke: '#fff', r: 4 }}
              activeDot={{ r: 6, fill: chartColors.primary, stroke: '#fff', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-3 gap-0 border-t border-surface-border-light">
        {[
          {
            icon: TrendingUp,
            value: `${isGrowthPositive ? '+' : ''}${stats.monthlyGrowth.toFixed(1)}%`,
            label: t('growth'),
            color: isGrowthPositive ? 'text-status-success' : 'text-status-error',
          },
          {
            icon: UserPlus,
            value: `+${stats.joinedThisMonth}`,
            label: t('newRecruit'),
            color: 'text-brand-primary',
          },
          {
            icon: UserMinus,
            value: `${stats.leftThisMonth}`,
            label: t('leftJob'),
            color: 'text-text-muted',
          },
        ].map((stat, i) => {
          const Icon = stat.icon;
          return (
            <div key={i} className={`flex flex-col items-center py-4 ${i < 2 ? 'border-r border-surface-border-light' : ''}`}>
              <div className="flex items-center gap-1 mb-0.5">
                <Icon size={12} className={stat.color} strokeWidth={2.5} />
                <span className={`text-sm font-extrabold ${stat.color}`}>{stat.value}</span>
              </div>
              <p className="text-[10px] text-text-muted font-medium">{stat.label}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
