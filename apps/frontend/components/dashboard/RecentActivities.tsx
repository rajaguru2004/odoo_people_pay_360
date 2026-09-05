'use client';

import React, { useEffect, useState, memo, useCallback } from 'react';
import { Clock, User, FileText, CheckCircle, XCircle, UserPlus, Calendar, Activity, RefreshCw } from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import dashboardService, { RecentActivity } from '@/services/dashboardService';
import { formatDistanceToNow } from 'date-fns';
import { enUS } from 'date-fns/locale';

const RecentActivities = memo(function RecentActivities() {
  const [activities, setActivities] = useState<RecentActivity[]>([]);
  const t = useTranslations('recentActivities');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchActivities();
  }, []);

  const fetchActivities = async () => {
    try {
      setLoading(true);
      const response = await dashboardService.getRecentActivities(10);
      if (response.data) {
        setActivities(Array.isArray(response.data) ? response.data : []);
      }
    } catch (error) {
      console.error('Failed to fetch activities:', error);
      setActivities([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchActivities();
  };

  const getActivityConfig = useCallback((type: string) => {
    switch (type.toLowerCase()) {
      case 'employee_created':
        return { icon: UserPlus, colorClass: 'text-brand-primary', bgClass: 'bg-brand-primary/10', borderClass: 'border-brand-primary/30' };
      case 'employee_updated':
        return { icon: User, colorClass: 'text-status-info', bgClass: 'bg-status-info-bg', borderClass: 'border-status-info/30' };
      case 'leave_created':
      case 'leave_pending':
        return { icon: Calendar, colorClass: 'text-brand-accent', bgClass: 'bg-brand-accent/10', borderClass: 'border-brand-accent/30' };
      case 'leave_approved':
        return { icon: CheckCircle, colorClass: 'text-status-success', bgClass: 'bg-status-success-bg', borderClass: 'border-status-success/30' };
      case 'leave_rejected':
        return { icon: XCircle, colorClass: 'text-status-error', bgClass: 'bg-status-error-bg', borderClass: 'border-status-error/30' };
      case 'attendance_checkin':
        return { icon: CheckCircle, colorClass: 'text-status-success', bgClass: 'bg-status-success-bg', borderClass: 'border-status-success/30' };
      case 'attendance_checkout':
        return { icon: Clock, colorClass: 'text-status-warning', bgClass: 'bg-status-warning-bg', borderClass: 'border-status-warning/30' };
      case 'payroll_created':
      case 'payroll_finalized':
        return { icon: CurrencyIcon, colorClass: 'text-status-success', bgClass: 'bg-status-success-bg', borderClass: 'border-status-success/30' };
      default:
        return { icon: FileText, colorClass: 'text-text-muted', bgClass: 'bg-surface-page', borderClass: 'border-surface-border' };
    }
  }, []);

  if (loading) {
    return (
      <div className="bg-surface-card rounded-2xl border border-surface-border p-6">
        <div className="animate-pulse space-y-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-surface-page" />
              <div className="space-y-2">
                <div className="h-4 w-36 bg-surface-page rounded" />
                <div className="h-3 w-24 bg-surface-page rounded" />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="h-16 bg-surface-page rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface-card rounded-2xl border border-surface-border shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-surface-border-light">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-primary to-brand-accent flex items-center justify-center shadow-md">
            <Activity className="text-white" size={18} />
          </div>
          <div>
            <h3 className="text-base font-bold text-text-heading">{t('title')}</h3>
            <p className="text-sm text-text-muted mt-0.5">{t('subtitle')}</p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-xs font-semibold text-brand-primary hover:text-brand-primary-dark transition-colors"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          {t('refresh')}
        </button>
      </div>

      {/* Activities Grid */}
      <div className="p-6">
        {activities.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <div className="w-16 h-16 rounded-2xl bg-surface-page flex items-center justify-center mx-auto mb-4">
              <Clock size={28} className="text-text-muted" />
            </div>
            <p className="text-base font-medium text-text-body">{t('noActivities')}</p>
            <p className="text-sm text-text-muted mt-1">Recent actions will appear here</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {activities.map((activity, index) => {
              const config = getActivityConfig(activity.type);
              const Icon = config.icon;

              return (
                <motion.div
                  key={activity.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className={`flex items-start gap-3 p-4 rounded-xl border ${config.borderClass} hover:shadow-sm transition-all duration-200 group`}
                >
                  {/* Icon */}
                  <div className={`w-9 h-9 rounded-lg ${config.bgClass} border ${config.borderClass} flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform duration-200`}>
                    <Icon size={17} className={config.colorClass} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-heading font-medium line-clamp-1 leading-snug">
                      {activity.description}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-text-muted mt-1">
                      <span className="font-semibold text-text-body truncate max-w-[100px]">{activity.user}</span>
                      <span className="text-surface-border">•</span>
                      <span className="shrink-0">
                        {formatDistanceToNow(new Date(activity.timestamp), {
                          addSuffix: true,
                          locale: enUS,
                        })}
                      </span>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

export default RecentActivities;
