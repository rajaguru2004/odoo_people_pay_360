'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Clock, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import axiosInstance from '@/lib/axios';

export default function OvertimeSummary() {
  const [stats, setStats] = useState({
    pending: 0,
    approved: 0,
    rejected: 0,
    total: 0,
    totalHours: 0,
  });
  const t = useTranslations('overtimeSummary');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOvertimeStats();
  }, []);

  const fetchOvertimeStats = async () => {
    try {
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();
      
      // Fetch overtime requests for current month
      const response = await axiosInstance.get('/overtime', {
        params: { limit: 1000, page: 1 },
      });

      if (response.data) {
        const requests: any[] = Array.isArray(response.data) ? response.data : [];
        
        // Filter by current month
        const currentMonthRequests = requests.filter((req: any) => {
          const reqDate = new Date(req.createdAt);
          return reqDate.getMonth() + 1 === currentMonth && reqDate.getFullYear() === currentYear;
        });

        const pending = currentMonthRequests.filter((req: any) => req.status === 'PENDING').length;
        const approved = currentMonthRequests.filter((req: any) => req.status === 'APPROVED').length;
        const rejected = currentMonthRequests.filter((req: any) => req.status === 'REJECTED').length;
        
        // Calculate total hours from approved requests
        const totalHours = currentMonthRequests
          .filter((req: any) => req.status === 'APPROVED')
          .reduce((sum: number, req: any) => sum + (req.hours || 0), 0);

        setStats({
          pending,
          approved,
          rejected,
          total: currentMonthRequests.length,
          totalHours,
        });
      }
    } catch (error: any) {
      console.error('Failed to fetch overtime stats:', error);
      // Set default values on error
      setStats({ pending: 0, approved: 0, rejected: 0, total: 0, totalHours: 0 });
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

  const items = [
    {
      label: t('pending'),
      value: stats.pending,
      color: 'bg-status-warning',
      lightColor: 'bg-status-warning-bg',
      textColor: 'text-status-warning',
      icon: Clock,
      percentage: stats.total > 0 ? (stats.pending / stats.total) * 100 : 0,
    },
    {
      label: t('approved'),
      value: stats.approved,
      color: 'bg-status-success',
      lightColor: 'bg-status-success-bg',
      textColor: 'text-status-success',
      icon: CheckCircle,
      percentage: stats.total > 0 ? (stats.approved / stats.total) * 100 : 0,
    },
    {
      label: t('rejected'),
      value: stats.rejected,
      color: 'bg-status-error',
      lightColor: 'bg-status-error-bg',
      textColor: 'text-status-error',
      icon: XCircle,
      percentage: stats.total > 0 ? (stats.rejected / stats.total) * 100 : 0,
    },
  ];

  return (
    <div className="bg-surface-card rounded-xl border border-surface-border p-6 shadow-sm hover:shadow-md transition-all h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-text-heading">{t('title')}</h3>
          <p className="text-sm text-text-muted mt-1">{t('thisMonth')}</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 bg-brand-accent/10 rounded-lg">
          <Clock className="text-brand-accent" size={20} />
          <span className="text-sm font-bold text-brand-accent">{stats.total}</span>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <motion.div
              key={item.label}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: index * 0.1 }}
              className={`${item.lightColor} rounded-lg p-3 text-center`}
            >
              <Icon className={`${item.textColor} mx-auto mb-2`} size={20} />
              <p className={`text-2xl font-bold ${item.textColor} mb-1`}>{item.value}</p>
              <p className="text-xs text-text-muted">{item.label}</p>
            </motion.div>
          );
        })}
      </div>

      {/* Progress Bars */}
      <div className="space-y-3 mb-6">
        {items.map((item, index) => (
          <div key={item.label}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-text-muted">{item.label}</span>
              <span className="text-xs font-bold text-text-body">{item.percentage.toFixed(0)}%</span>
            </div>
            <div className="w-full h-2 bg-surface-page rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${item.percentage}%` }}
                transition={{ delay: index * 0.1 + 0.3, duration: 0.8 }}
                className={`h-full ${item.color} rounded-full`}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Total Hours Summary */}
      <div className="mt-auto pt-4 border-t border-surface-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-brand-primary/10 rounded-lg flex items-center justify-center">
              <AlertCircle className="text-brand-primary" size={16} />
            </div>
            <span className="text-sm text-text-muted">{t('totalHours')}</span>
          </div>
          <span className="text-xl font-bold text-brand-primary">{stats.totalHours}h</span>
        </div>
      </div>
    </div>
  );
}
