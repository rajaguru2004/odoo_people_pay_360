'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, TrendingDown, TrendingUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import axiosInstance from '@/lib/axios';

export default function AbsenteeismRate() {
  const [stats, setStats] = useState({
    todayAbsent: 0,
    weekAbsent: 0,
    monthAbsent: 0,
    absentRate: 0,
    lateRate: 0,
    trend: 0, // positive = increasing, negative = decreasing
  });
  const t = useTranslations('absenteeismRate');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAbsenteeism();
  }, []);

  const fetchAbsenteeism = async () => {
    try {
      const response = await axiosInstance.get('/attendances/absenteeism-stats');
      
      // Axios interceptor returns response.data already, so response = { data: { today, week, month, trend } }
      const data = response.data;
      if (data) {
        setStats({
          todayAbsent: data.today?.absent ?? 0,
          weekAbsent: data.week?.absent ?? 0,
          monthAbsent: data.month?.absent ?? 0,
          absentRate: data.today?.absentRate ?? 0,
          lateRate: data.today?.lateRate ?? 0,
          trend: data.trend ?? 0,
        });
      }
    } catch (error) {
      console.error('Failed to fetch absenteeism:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-xl border border-surface-border p-6 shadow-sm">
        <div className="animate-pulse">
          <div className="h-5 bg-surface-page rounded w-1/3 mb-4"></div>
          <div className="h-48 bg-surface-page rounded-lg"></div>
        </div>
      </div>
    );
  }

  const isImproving = stats.trend < 0;

  return (
    <div className="bg-surface-card rounded-xl border border-surface-border p-6 shadow-sm hover:shadow-md transition-all h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-text-heading">{t('title')}</h3>
          <p className="text-sm text-text-muted mt-1">{t('today')}</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 bg-status-error-bg rounded-lg">
          <AlertCircle className="text-status-error" size={20} />
          <span className="text-sm font-bold text-status-error">{stats.todayAbsent}</span>
        </div>
      </div>

      {/* Main Stats */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        {/* Absent Rate */}
        <div className="text-center p-4 bg-status-error-bg rounded-xl border border-status-error/20">
          <div className="text-3xl font-bold text-status-error mb-1">
            {stats.absentRate.toFixed(1)}%
          </div>
          <p className="text-xs text-status-error font-medium">{t('absent')}</p>
        </div>

        {/* Late Rate */}
        <div className="text-center p-4 bg-status-warning-bg rounded-xl border border-status-warning/20">
          <div className="text-3xl font-bold text-status-warning mb-1">
            {stats.lateRate.toFixed(1)}%
          </div>
          <p className="text-xs text-status-warning font-medium">{t('goLate')}</p>
        </div>
      </div>

      {/* Trend Indicator */}
      <div className={`p-4 rounded-xl border-2 mb-4 ${
        isImproving 
          ? 'bg-status-success-bg border-status-success/30' 
          : 'bg-status-error-bg border-status-error/30'
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isImproving ? (
              <TrendingDown className="text-status-success" size={20} />
            ) : (
              <TrendingUp className="text-status-error" size={20} />
            )}
            <span className={`text-sm font-semibold ${
              isImproving ? 'text-status-success' : 'text-status-error'
            }`}>
              {isImproving ? t('improve') : t('increase')}
            </span>
          </div>
          <span className={`text-lg font-bold ${
            isImproving ? 'text-status-success' : 'text-status-error'
          }`}>
            {Math.abs(stats.trend).toFixed(1)}%
          </span>
        </div>
        <p className="text-xs text-text-muted mt-1">{t('comparedToLastWeek')}</p>
      </div>

      {/* Period Stats */}
      <div className="grid grid-cols-3 gap-3 mt-auto">
        <div className="text-center p-3 bg-surface-page rounded-lg">
          <p className="text-xs text-text-muted mb-1">{t('today')}</p>
          <p className="text-lg font-bold text-text-heading">{stats.todayAbsent}</p>
        </div>
        <div className="text-center p-3 bg-surface-page rounded-lg">
          <p className="text-xs text-text-muted mb-1">{t('thisWeek')}</p>
          <p className="text-lg font-bold text-text-heading">{stats.weekAbsent}</p>
        </div>
        <div className="text-center p-3 bg-surface-page rounded-lg">
          <p className="text-xs text-text-muted mb-1">{t('thisMonth')}</p>
          <p className="text-lg font-bold text-text-heading">{stats.monthAbsent}</p>
        </div>
      </div>
    </div>
  );
}
