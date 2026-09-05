'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, Clock, CheckCircle, XCircle, AlertCircle, Calendar } from 'lucide-react';
import { motion } from 'framer-motion';
import overtimeService from '@/services/overtimeService';
import { Overtime } from '@/types/overtime';
import { useAuthStore } from '@/store/authStore';
import { formatCurrency, formatWallClockDate, formatWallClockTime } from '@/utils/formatters';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import DataCard from '@/components/common/DataCard';
import EmptyState from '@/components/common/EmptyState';
import { SkeletonList } from '@/components/common/Skeleton';

const statusColors: Record<string, string> = {
  PENDING: 'bg-status-warning-bg text-status-warning border border-status-warning/20',
  APPROVED: 'bg-status-success-bg text-status-success border border-status-success/20',
  REJECTED: 'bg-status-error-bg text-status-error border border-status-error/20',
  CANCELLED: 'bg-surface-page text-text-muted border border-surface-border',
};

const otTypeColors: Record<string, string> = {
  REGULAR: 'bg-brand-primary-light/20 text-brand-primary border border-brand-primary/20',
  LATE: 'bg-brand-accent/10 text-brand-accent border border-brand-accent/20',
  DOUBLE: 'bg-status-error-bg text-status-error border border-status-error/20',
  DOUBLE_LATE: 'bg-status-error-bg/60 text-status-error border border-status-error/40 font-bold',
};

export default function MyOvertimePage() {
  const router = useRouter();
  const t = useTranslations('myOvertimePage');
  const tc = useTranslations('common');
  const { user } = useAuthStore();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const statusLabels: Record<string, { label: string; color: string }> = {
    PENDING: { label: tc('pending'), color: statusColors.PENDING },
    APPROVED: { label: tc('approved'), color: statusColors.APPROVED },
    REJECTED: { label: tc('rejected'), color: statusColors.REJECTED },
    CANCELLED: { label: tc('cancelled'), color: statusColors.CANCELLED },
  };

  const otTypeLabels: Record<string, { label: string; color: string }> = {
    REGULAR: { label: t('otTypeRegular'), color: otTypeColors.REGULAR },
    LATE: { label: t('otTypeLateOt'), color: otTypeColors.LATE },
    DOUBLE: { label: t('otTypeDoubleOt'), color: otTypeColors.DOUBLE },
    DOUBLE_LATE: { label: t('otTypeDoubleLate'), color: otTypeColors.DOUBLE_LATE },
  };

  const renderOtTypeBadge = (otType?: string) => {
    const type = otType || 'REGULAR';
    const meta = otTypeLabels[type] || otTypeLabels.REGULAR;
    return (
      <span className={`px-2.5 py-1 rounded-[--radius-badge] text-xs font-medium whitespace-nowrap ${meta.color}`}>
        {meta.label}
      </span>
    );
  };

  const [overtimes, setOvertimes] = useState<Overtime[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  const stats = useMemo(() => {
    if (!Array.isArray(overtimes) || overtimes.length === 0) {
      return { total: 0, pending: 0, approved: 0, rejected: 0, totalHours: 0 };
    }

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const currentMonthData = overtimes.filter(o => {
      const overtimeDate = new Date(o.date);
      return overtimeDate.getMonth() === currentMonth &&
        overtimeDate.getFullYear() === currentYear;
    });

    const totalHours = currentMonthData
      .filter(o => o.status === 'APPROVED')
      .reduce((sum, o) => sum + (Number(o.hours) || 0), 0);

    return {
      total: overtimes.length,
      pending: overtimes.filter(o => o.status === 'PENDING').length,
      approved: overtimes.filter(o => o.status === 'APPROVED').length,
      rejected: overtimes.filter(o => o.status === 'REJECTED').length,
      totalHours,
    };
  }, [overtimes]);

  useEffect(() => {
    if (user) {
      fetchOvertimes();
    }
  }, [user?.employeeId]);

  const fetchOvertimes = async () => {
    try {
      setLoading(true);
      const response = await overtimeService.getMyRequests();
      const data = Array.isArray(response.data) ? response.data : [];
      setOvertimes(data);
    } catch (error) {
      console.error('Failed to fetch overtimes:', error);
      setOvertimes([]);
    } finally {
      setLoading(false);
    }
  };

  const filteredOvertimes = Array.isArray(overtimes)
    ? (filter === 'all' ? overtimes : overtimes.filter(o => o.status === filter))
    : [];

  return (
    <div className="space-y-6" data-testid="ess-my-overtime">
      {/* Primary action. The title/description live in the sticky TopHeader
          (declared via usePageHeader above). */}
      <PageActionRow
        action={
          <button
            data-testid="my-ot-new"
            onClick={() => router.push('/dashboard/overtime/new')}
            className="flex items-center gap-2 px-6 py-3 bg-brand-primary text-text-on-brand rounded-[--radius-button] font-semibold hover:bg-brand-primary-dark hover:shadow-lg transition-all cursor-pointer"
          >
            <Plus size={20} />
            {t('signUpBtn')}
          </button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-brand-primary-light/20 rounded-[--radius-card] flex items-center justify-center">
              <Calendar className="text-brand-primary" size={20} />
            </div>
            <p className="text-sm text-text-muted font-medium">{t('statTotalRequests')}</p>
          </div>
          <p data-testid="my-ot-stat" data-key="total" data-value={stats.total} className="text-3xl font-bold text-text-heading">{stats.total}</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="bg-surface-card rounded-[--radius-card] p-6 border-2 border-status-warning/20"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-status-warning-bg rounded-[--radius-card] flex items-center justify-center">
              <AlertCircle className="text-status-warning" size={20} />
            </div>
            <p className="text-sm text-text-muted font-medium">{tc('pending')}</p>
          </div>
          <p data-testid="my-ot-stat" data-key="pending" data-value={stats.pending} className="text-3xl font-bold text-status-warning">{stats.pending}</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-surface-card rounded-[--radius-card] p-6 border-2 border-status-success/20"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-status-success-bg rounded-[--radius-card] flex items-center justify-center">
              <CheckCircle className="text-status-success" size={20} />
            </div>
            <p className="text-sm text-text-muted font-medium">{tc('approved')}</p>
          </div>
          <p data-testid="my-ot-stat" data-key="approved" data-value={stats.approved} className="text-3xl font-bold text-status-success">{stats.approved}</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-surface-card rounded-[--radius-card] p-6 border-2 border-status-error/20"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-status-error-bg rounded-[--radius-card] flex items-center justify-center">
              <XCircle className="text-status-error" size={20} />
            </div>
            <p className="text-sm text-text-muted font-medium">{tc('rejected')}</p>
          </div>
          <p data-testid="my-ot-stat" data-key="rejected" data-value={stats.rejected} className="text-3xl font-bold text-status-error">{stats.rejected}</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-brand-primary rounded-[--radius-card] p-6 text-text-on-brand border-2 border-brand-primary/20"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-surface-card/20 rounded-[--radius-card] flex items-center justify-center">
              <Clock size={20} />
            </div>
            <p className="text-sm text-white/80">{t('statNowApproved')}</p>
          </div>
          <p className="text-3xl font-bold">
            <span data-testid="my-ot-stat" data-key="hours" data-value={stats.totalHours ?? 0}>
              {typeof stats.totalHours === 'number' ? stats.totalHours.toLocaleString('en-IN') : '0'}h
            </span>
          </p>
          <p className="text-xs text-white/60 mt-1">{tc('thisMonth')}</p>
        </motion.div>
      </div>

      {/* Filter */}
      <div className="flex gap-2 overflow-x-auto no-scrollbar snap-x md:flex-wrap md:overflow-visible">
        {[
          { key: 'all', label: t('filterAll') },
          { key: 'PENDING', label: statusLabels.PENDING.label },
          { key: 'APPROVED', label: statusLabels.APPROVED.label },
          { key: 'REJECTED', label: statusLabels.REJECTED.label },
        ].map(({ key, label }) => (
          <button
            key={key}
            data-testid="my-ot-filter"
            data-key={key}
            data-active={filter === key}
            onClick={() => setFilter(key)}
            className={`shrink-0 snap-start whitespace-nowrap px-4 py-2 rounded-[--radius-button] font-medium transition-colors cursor-pointer touch-manipulation ${
              filter === key
                ? 'bg-brand-primary text-text-on-brand'
                : 'bg-surface-card text-text-muted hover:bg-surface-page border border-surface-border'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden">
        {/* Desktop table. An eight-column table in an `overflow-x-auto` box was
            the whole mobile story here: on a phone it meant sideways-swiping a
            row at a time to read one claim. The card list below is the same
            records, priority fields first. */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full">
            <thead className="bg-surface-page border-b border-surface-border">
              <tr>
                <th className="px-6 py-4 text-start text-sm font-semibold text-text-heading">{t('colDay')}</th>
                <th className="px-6 py-4 text-start text-sm font-semibold text-text-heading">{t('colTime')}</th>
                <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading">{t('colNumberOfHours')}</th>
                <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading">{t('colOtType')}</th>
                <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading">{t('colFoodAllowance')}</th>
                <th className="px-6 py-4 text-start text-sm font-semibold text-text-heading">{tc('reason')}</th>
                <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading">{tc('status')}</th>
                <th className="px-6 py-4 text-center text-sm font-semibold text-text-heading">{tc('actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border-light bg-surface-card">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center">
                    <div className="flex items-center justify-center">
                      <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                    </div>
                  </td>
                </tr>
              ) : filteredOvertimes.length === 0 ? (
                <tr>
                  <td data-testid="my-ot-empty" colSpan={8} className="px-6 py-12 text-center text-text-muted">
                    {filter === 'all' ? t('emptyNoOrdersAll') : t('emptyNoOrdersFiltered')}
                  </td>
                </tr>
              ) : (
                filteredOvertimes.map((overtime) => (
                  <motion.tr
                    key={overtime.id}
                    // The SAME id as the admin list on purpose: the two screens
                    // never mount together, and sharing it makes the
                    // already-shipped OvertimeListPage.openMine()/hasRow() work
                    // instead of silently returning false. Revisit only if some
                    // future screen renders both.
                    data-testid="overtime-row"
                    data-overtime-id={overtime.id}
                    data-status={overtime.status}
                    data-date={overtime.date}
                    data-hours={overtime.hours ?? 0}
                    data-ot-type={overtime.otType ?? ''}
                    data-food-allowance={Number(overtime.foodAllowance || 0)}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="hover:bg-surface-page transition-colors border-b border-surface-border-light"
                  >
                    <td className="px-6 py-4 text-sm font-medium text-text-heading">
                      {formatWallClockDate(overtime.date)}
                    </td>
                    <td className="px-6 py-4 text-sm text-text-body">
                      {formatWallClockTime(overtime.startTime)} -{' '}
                      {formatWallClockTime(overtime.endTime)}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className="font-bold text-brand-primary">{t('hoursSuffix', { hours: overtime.hours ?? 0 })}</span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      {renderOtTypeBadge(overtime.otType)}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {Number(overtime.foodAllowance || 0) > 0 ? (
                        <span className="px-2.5 py-1 rounded-[--radius-badge] bg-brand-accent/15 text-brand-accent text-xs font-bold whitespace-nowrap">
                          {formatCurrency(Number(overtime.foodAllowance))}
                        </span>
                      ) : (
                        <span className="text-text-muted text-xs">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-text-body max-w-xs truncate">
                      {overtime.reason}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`px-3 py-1.5 rounded-[--radius-badge] text-xs font-bold border whitespace-nowrap ${statusLabels[overtime.status]?.color || 'bg-surface-page text-text-muted'}`}>
                        {statusLabels[overtime.status]?.label || overtime.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button
                        data-testid="my-ot-details"
                        onClick={() => router.push(`/dashboard/overtime/${overtime.id}`)}
                        className="text-brand-primary hover:underline text-sm font-medium cursor-pointer"
                      >
                        {t('detailsBtn')}
                      </button>
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden p-4 space-y-3">
          {loading ? (
            <SkeletonList count={4} testId="my-ot-loading-card" />
          ) : filteredOvertimes.length === 0 ? (
            <EmptyState
              icon={Clock}
              title={filter === 'all' ? t('emptyNoOrdersAll') : t('emptyNoOrdersFiltered')}
              action={
                filter === 'all'
                  ? {
                      label: t('signUpBtn'),
                      onClick: () => router.push('/dashboard/overtime/new'),
                      testId: 'my-ot-empty-new',
                    }
                  : { label: t('filterAll'), onClick: () => setFilter('all'), testId: 'my-ot-empty-clear' }
              }
              // NOT `my-ot-empty`: that id is on the desktop table's empty row,
              // and Playwright's `.count()` sees hidden elements too.
              testId="my-ot-empty-card"
            />
          ) : (
            filteredOvertimes.map((overtime) => (
              <DataCard
                key={overtime.id}
                testId="my-ot-card"
                onClick={() => router.push(`/dashboard/overtime/${overtime.id}`)}
                title={formatWallClockDate(overtime.date)}
                headerRight={
                  <span
                    className={`px-2.5 py-1 rounded-[--radius-badge] text-[11px] font-bold border whitespace-nowrap ${
                      statusLabels[overtime.status]?.color || 'bg-surface-page text-text-muted'
                    }`}
                  >
                    {statusLabels[overtime.status]?.label || overtime.status}
                  </span>
                }
                items={[
                  {
                    label: t('colTime'),
                    value: `${formatWallClockTime(overtime.startTime)} – ${formatWallClockTime(overtime.endTime)}`,
                  },
                  {
                    label: t('colNumberOfHours'),
                    value: (
                      <span className="font-bold text-brand-primary">
                        {t('hoursSuffix', { hours: overtime.hours ?? 0 })}
                      </span>
                    ),
                  },
                  { label: t('colOtType'), value: renderOtTypeBadge(overtime.otType) },
                  {
                    label: t('colFoodAllowance'),
                    value:
                      Number(overtime.foodAllowance || 0) > 0
                        ? formatCurrency(Number(overtime.foodAllowance))
                        : '—',
                  },
                  { label: tc('reason'), value: overtime.reason || '—', full: true },
                ]}
                footer={
                  <button
                    data-testid="my-ot-card-details"
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/dashboard/overtime/${overtime.id}`);
                    }}
                    className="inline-flex h-11 touch-manipulation items-center rounded-lg px-4 text-sm font-semibold text-brand-primary transition-colors hover:bg-brand-primary-light active:scale-[0.98]"
                  >
                    {t('detailsBtn')}
                  </button>
                }
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
