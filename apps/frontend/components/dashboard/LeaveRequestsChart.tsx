'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Calendar, CheckCircle, XCircle, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import axiosInstance from '@/lib/axios';

export default function LeaveRequestsChart() {
  const [stats, setStats] = useState({
    pending: 0,
    approved: 0,
    rejected: 0,
    total: 0,
  });
  const t = useTranslations('leaveRequestsChart');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchLeaveStats();
  }, []);

  const fetchLeaveStats = async () => {
    try {
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();
      
      // Fetch all leave requests for the current month (large limit to avoid pagination cutoff)
      const response = await axiosInstance.get('/leave-requests', {
        params: { limit: 1000, page: 1 },
      });

      if (response.data) {
        const requests: any[] = Array.isArray(response.data) ? response.data : [];

        // Filter by current month using createdAt
        const currentMonthRequests = requests.filter((req: any) => {
          const reqDate = new Date(req.createdAt);
          return reqDate.getMonth() + 1 === currentMonth && reqDate.getFullYear() === currentYear;
        });

        const pending = currentMonthRequests.filter((req: any) => req.status === 'PENDING').length;
        const approved = currentMonthRequests.filter((req: any) => req.status === 'APPROVED').length;
        const rejected = currentMonthRequests.filter((req: any) => req.status === 'REJECTED').length;
        
        setStats({
          pending,
          approved,
          rejected,
          total: currentMonthRequests.length,
        });
      }
    } catch (error: any) {
      console.error('Failed to fetch leave stats:', error?.message);
      setStats({ pending: 0, approved: 0, rejected: 0, total: 0 });
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-2xl p-6 border border-surface-border">
        <div className="animate-pulse">
          <div className="h-6 bg-surface-page rounded w-1/3 mb-4"></div>
          <div className="h-48 bg-surface-page rounded"></div>
        </div>
      </div>
    );
  }

  const items = [
    {
      label: t('pending'),
      value: stats.pending,
      color: 'bg-brand-accent',
      icon: Clock,
      iconColor: 'text-brand-accent',
      percentage: stats.total > 0 ? (stats.pending / stats.total) * 100 : 0,
    },
    {
      label: t('approved'),
      value: stats.approved,
      color: 'bg-status-success',
      icon: CheckCircle,
      iconColor: 'text-status-success',
      percentage: stats.total > 0 ? (stats.approved / stats.total) * 100 : 0,
    },
    {
      label: t('rejected'),
      value: stats.rejected,
      color: 'bg-status-error',
      icon: XCircle,
      iconColor: 'text-status-error',
      percentage: stats.total > 0 ? (stats.rejected / stats.total) * 100 : 0,
    },
  ];

  return (
    <div className="bg-surface-card rounded-2xl p-6 border border-surface-border h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-text-heading">{t('title')}</h3>
          <p className="text-sm text-text-muted mt-1">{t('thisMonth')}</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 bg-brand-primary/10 rounded-lg">
          <Calendar className="text-brand-primary" size={20} />
          <span className="text-sm font-bold text-brand-primary">{stats.total}</span>
        </div>
      </div>

      {/* Progress Bars */}
      <div className="space-y-6">
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <motion.div
              key={item.label}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              {/* Label and Value */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Icon className={item.iconColor} size={18} />
                  <span className="text-sm font-medium text-text-body">{item.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-text-heading">{item.value}</span>
                  <span className="text-xs text-text-muted">{item.percentage.toFixed(0)}%</span>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="w-full h-3 bg-surface-page rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${item.percentage}%` }}
                  transition={{ delay: index * 0.1 + 0.2, duration: 0.8 }}
                  className={`h-full ${item.color} rounded-full`}
                />
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Summary */}
      <div className="mt-6 pt-6 border-t border-surface-border-light">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-muted">{t('approvalRate')}</span>
          <span className="text-lg font-bold text-status-success">
            {stats.total > 0 ? ((stats.approved / stats.total) * 100).toFixed(0) : 0}%
          </span>
        </div>
      </div>
    </div>
  );
}
