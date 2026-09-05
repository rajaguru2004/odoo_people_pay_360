'use client';

import { useEffect, useState } from 'react';
import {
  Clock, User, FileText, Upload, Edit,
  Calendar, Award, AlertCircle, Briefcase, ChevronDown, Filter
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { employeeActivityService } from '@/services/employeeActivityService';
import { EmployeeActivity } from '@/types/employee-activity';
import { formatDate } from '@/utils/formatters';
import { resolveFileUrl } from '@/utils/fileUrl';

interface ActivityTimelineProps {
  employeeId: string;
}

const activityIcons: Record<string, any> = {
  profile_update: Edit,
  document_upload: Upload,
  attendance: Calendar,
  leave_request: Calendar,
  overtime: Clock,
  reward: Award,
  discipline: AlertCircle,
  contract: FileText,
  default: Briefcase,
};

const activityColors: Record<string, string> = {
  profile_update: 'bg-brand-primary-light/20 text-brand-primary',
  document_upload: 'bg-purple-100 text-purple-600',
  attendance: 'bg-green-100 text-green-600',
  leave_request: 'bg-orange-100 text-brand-accent-dark',
  overtime: 'bg-yellow-100 text-yellow-600',
  reward: 'bg-pink-100 text-pink-600',
  discipline: 'bg-red-100 text-red-600',
  contract: 'bg-brand-primary-light/20 text-brand-primary',
  default: 'bg-slate-100 text-slate-600',
};

export default function ActivityTimeline({ employeeId }: ActivityTimelineProps) {
  const t = useTranslations('activityTimeline');
  const [activities, setActivities] = useState<EmployeeActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filterType, setFilterType] = useState<string>('');
  const [showFilter, setShowFilter] = useState(false);

  const actionLabels: Record<string, string> = {
    created: t('actionCreate'),
    updated: t('actionUpdate'),
    deleted: t('actionDelete'),
    approved: t('actionApprove'),
    rejected: t('actionRefused'),
    submitted: t('actionSendRequest'),
  };

  useEffect(() => {
    fetchActivities();
  }, [employeeId, page, filterType]);

  const fetchActivities = async () => {
    try {
      setLoading(true);
      const response = await employeeActivityService.getActivities(employeeId, {
        page,
        limit: 20,
        type: filterType || undefined,
      });

      setActivities(response.data || []);
      setTotalPages(response.meta?.totalPages || 1);
    } catch (error) {
      console.error('Failed to fetch activities:', error);
      setActivities([]);
      setTotalPages(1);
    } finally {
      setLoading(false);
    }
  };

  const getActivityIcon = (type: string) => {
    return activityIcons[type] || activityIcons.default;
  };

  const getActivityColor = (type: string) => {
    return activityColors[type] || activityColors.default;
  };

  const getPerformerName = (activity: EmployeeActivity) => {
    if (!activity.performer) return t('systemFallback');
    return activity.performer.employee?.fullName || activity.performer.email;
  };

  const getPerformerAvatar = (activity: EmployeeActivity) => {
    return resolveFileUrl(activity.performer?.employee?.avatarUrl);
  };

  const getFilterLabel = (type: string) => {
    const labels: Record<string, string> = {
      profile_update: t('filterUpdateProfile'),
      document_upload: t('filterDocuments'),
      attendance: t('filterTimekeeping'),
      leave_request: t('filterLeave'),
      overtime: t('filterOvertime'),
      reward: t('filterCommendation'),
      discipline: t('filterDiscipline'),
      contract: t('filterContract'),
    };
    return labels[type] || type;
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('justFinished');
    if (diffMins < 60) return t('minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('hoursAgo', { count: diffHours });
    if (diffDays < 7) return t('daysAgo', { count: diffDays });
    return formatDate(dateString);
  };

  if (loading && activities.length === 0) {
    return (
      <div className="space-y-4">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex gap-4 animate-pulse">
            <div className="w-10 h-10 bg-slate-200 rounded-full"></div>
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-slate-200 rounded w-3/4"></div>
              <div className="h-3 bg-slate-100 rounded w-1/2"></div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (activities.length === 0 && !loading) {
    return (
      <div className="text-center py-12">
        <Clock className="mx-auto text-slate-300 mb-4" size={48} />
        <p className="text-slate-500 font-medium">
          {filterType ? t('noActivityFiltered', { filter: getFilterLabel(filterType) }) : t('noActivityYet')}
        </p>
        {filterType && (
          <button
            onClick={() => {
              setFilterType('');
              setPage(1);
            }}
            className="mt-4 text-sm text-brand-primary hover:underline font-medium"
          >
            {t('clearFilter')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filter */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-600 uppercase">
            {t('activityHistoryCount', { count: activities.length })}
          </h3>
          {filterType && (
            <p className="text-xs text-slate-500 mt-1">
              {t('filteringLabel')} <span className="font-semibold text-brand-primary">{getFilterLabel(filterType)}</span>
            </p>
          )}
        </div>
        <button
          onClick={() => setShowFilter(!showFilter)}
          className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-all ${
            showFilter
              ? 'bg-brand-primary text-white shadow-md'
              : 'text-slate-600 hover:bg-slate-50 border border-slate-200'
          }`}
        >
          <Filter size={16} />
          <span>{t('filterToggle')}</span>
          {filterType && !showFilter && (
            <span className="ms-1 px-1.5 py-0.5 bg-white/20 rounded text-xs font-bold">1</span>
          )}
          <ChevronDown size={16} className={`transition-transform ${showFilter ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <AnimatePresence>
        {showFilter && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex flex-wrap gap-2"
          >
            {[
              { type: '', label: t('filterAll') },
              { type: 'profile_update', label: t('filterUpdateProfile') },
              { type: 'document_upload', label: t('filterDocuments') },
              { type: 'attendance', label: t('filterTimekeeping') },
              { type: 'leave_request', label: t('filterLeave') },
              { type: 'overtime', label: t('filterOvertime') },
              { type: 'reward', label: t('filterCommendation') },
              { type: 'discipline', label: t('filterDiscipline') },
              { type: 'contract', label: t('filterContract') },
            ].map((btn) => (
              <button
                key={btn.type}
                onClick={() => {
                  setFilterType(btn.type);
                  setPage(1);
                }}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  filterType === btn.type
                    ? 'bg-brand-primary text-white shadow-md'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Timeline */}
      <div className="relative">
        {/* Loading overlay */}
        {loading && activities.length > 0 && (
          <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-10 flex items-center justify-center rounded-xl">
            <div className="flex items-center gap-3 px-6 py-3 bg-white rounded-xl shadow-lg border border-slate-200">
              <div className="w-5 h-5 border-3 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
              <span className="text-sm font-medium text-slate-700">{t('loading')}</span>
            </div>
          </div>
        )}

        {/* Timeline line */}
        <div className="absolute start-5 top-0 bottom-0 w-0.5 bg-slate-200"></div>

        {/* Activities */}
        <div className="space-y-6">
          {activities.map((activity, index) => {
            const Icon = getActivityIcon(activity.activityType);
            const colorClass = getActivityColor(activity.activityType);
            const performerAvatar = getPerformerAvatar(activity);

            return (
              <motion.div
                key={activity.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                className="relative flex gap-4"
              >
                {/* Icon */}
                <div className={`relative z-10 w-10 h-10 rounded-full ${colorClass} flex items-center justify-center flex-shrink-0 shadow-sm`}>
                  <Icon size={18} />
                </div>

                {/* Content */}
                <div className="flex-1 pb-6">
                  <div className="surface-panel surface-panel-interactive p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-primary mb-1">
                          {activity.description}
                        </p>
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          {performerAvatar ? (
                            <img
                              src={performerAvatar}
                              alt={getPerformerName(activity)}
                              className="w-5 h-5 rounded-full object-cover"
                            />
                          ) : (
                            <User size={14} />
                          )}
                          <span>{getPerformerName(activity)}</span>
                          <span>•</span>
                          <span>{formatTimeAgo(activity.createdAt)}</span>
                        </div>
                      </div>
                      {activity.action && (
                        <span className="px-2 py-1 bg-slate-100 text-slate-600 text-xs font-medium rounded-md">
                          {actionLabels[activity.action] || activity.action}
                        </span>
                      )}
                    </div>

                    {/* Metadata */}
                    {activity.metadata && Object.keys(activity.metadata).length > 0 && (
                      <div className="mt-3 pt-3 border-t border-slate-100">
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(activity.metadata).map(([key, value]) => (
                            <span key={key} className="text-xs text-slate-500">
                              <span className="font-medium">{key}:</span> {String(value)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('previous')}
          </button>
          <span className="text-sm text-slate-600">
            {t('pageOf', { page, total: totalPages })}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('next')}
          </button>
        </div>
      )}
    </div>
  );
}
