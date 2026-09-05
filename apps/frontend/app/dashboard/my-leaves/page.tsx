'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Plus, Clock, CheckCircle, XCircle, AlertCircle, Eye } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import leaveService from '@/services/leaveService';
import { useAuthStore } from '@/store/authStore';
import { LeaveRequest, LeaveBalance } from '@/types/leave';
import { formatDate } from '@/utils/formatters';
import DataCard from '@/components/common/DataCard';
import EmptyState from '@/components/common/EmptyState';
import { SkeletonList } from '@/components/common/Skeleton';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';

export default function MyLeavesPage() {
  const router = useRouter();
  const t = useTranslations('myLeavesPage');
  const tc = useTranslations('common');
  const { user } = useAuthStore();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    if (!user?.employeeId) return;

    try {
      setLoading(true);
      const [balanceRes, requestsRes] = await Promise.all([
        leaveService.getBalance(user.employeeId).catch(() => ({ data: null })),
        leaveService.getMyRequests(),
      ]);

      setBalance(balanceRes.data);
      setRequests(Array.isArray(requestsRes.data) ? requestsRes.data : []);
    } catch (error) {
      console.error('Failed to fetch leave data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      PENDING: 'bg-status-warning-bg text-status-warning border-status-warning/20',
      APPROVED: 'bg-status-success-bg text-status-success border-status-success/20',
      REJECTED: 'bg-status-error-bg text-status-error border-status-error/20',
      CANCELLED: 'bg-surface-page text-text-muted border-surface-border',
    };
    const icons: Record<string, React.ComponentType<{ size?: number }>> = {
      PENDING: Clock,
      APPROVED: CheckCircle,
      REJECTED: XCircle,
    };
    const labels: Record<string, string> = {
      PENDING: tc('pending'),
      APPROVED: tc('approved'),
      REJECTED: tc('rejected'),
      CANCELLED: tc('cancelled'),
    };
    const Icon = icons[status] || AlertCircle;

    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border whitespace-nowrap ${styles[status] || 'bg-surface-page text-text-muted'}`}>
        <Icon size={12} />
        {labels[status] || status}
      </span>
    );
  };

  const getLeaveTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      ANNUAL: tc('annualLeave'),
      SICK: tc('sickLeave'),
      UNPAID: tc('unpaidLeave'),
      MATERNITY: tc('maternityLeave'),
      PATERNITY: tc('paternityLeave'),
      BEREAVEMENT: tc('bereavementLeave'),
    };
    return labels[type.toUpperCase()] || type;
  };

  const filteredRequests = filter === 'all'
    ? requests
    : requests.filter(r => r.status === filter);

  const stats = {
    total: requests.length,
    pending: requests.filter(r => r.status === 'PENDING').length,
    approved: requests.filter(r => r.status === 'APPROVED').length,
    rejected: requests.filter(r => r.status === 'REJECTED').length,
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-5" data-testid="ess-my-leaves">
        {/* Primary action. The title/description live in the sticky TopHeader
            (declared via usePageHeader above). */}
        <PageActionRow
          action={
            <button
              onClick={() => router.push('/dashboard/leaves/new')}
              data-testid="ess-my-leaves-new"
              // Full width and 48px on a phone — this is the screen's only
              // primary action, and a 40px pill floated to one edge is both
              // under the thumb floor and easy to miss. Unchanged at ≥768px.
              className="inline-flex w-full md:w-auto items-center justify-center gap-2 h-12 md:h-10 px-4 rounded-lg bg-brand-primary hover:bg-brand-primary-dark text-white text-sm font-medium transition-colors touch-manipulation active:scale-[0.99]"
            >
              <Plus size={18} />
              {t('createRequest')}
            </button>
          }
        />

        {/* Leave Balance Cards */}
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="bg-surface-card rounded-xl p-3 border border-surface-border animate-pulse">
                <div className="h-16 bg-surface-page rounded"></div>
              </div>
            ))}
          </div>
        ) : balance ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {balance.leaveTypeBalances && balance.leaveTypeBalances.length > 0 ? (
              balance.leaveTypeBalances.map((tb, idx) => {
                // Show the same figures the admin/HR views use: the stored
                // yearly entitlement (allocated + carried over) and remaining.
                // No client-side monthly proration — that produced numbers
                // that disagreed with the admin portal for the same employee.
                const totalEntitled = tb.allocated + tb.carriedOver;
                const remaining = tb.remaining;

                return (
                  <motion.div
                    key={tb.id || idx}
                    data-testid="my-leave-balance-card"
                    data-leave-type={tb.leaveTypeKey}
                    data-remaining={remaining}
                    data-total={totalEntitled}
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.04 }}
                    className="bg-surface-card rounded-xl p-3 border border-surface-border transition-all hover:shadow-sm"
                  >
                    <div className="flex items-center justify-between gap-1 mb-1.5">
                      <p className="text-[11px] font-medium uppercase tracking-wide truncate text-text-muted" title={tb.leaveTypeKey}>
                        {tb.leaveTypeKey}
                      </p>
                      <Calendar size={14} className="text-text-muted" />
                    </div>

                    <div className="flex items-baseline gap-1">
                      <span className="text-xl font-semibold tabular-nums text-text-heading">{remaining}</span>
                      <span className="text-xs text-text-muted">
                        {t('perDaySuffix', { total: totalEntitled })}
                      </span>
                    </div>

                    <p className="text-[10px] mt-0.5 text-text-muted truncate">
                      {t('remainingAllocatedLabel')}
                    </p>
                  </motion.div>
                );
              })
            ) : (
              <>
                {/* Fallback to legacy Annual Leave card */}
                {(() => {
                  const totalEntitled = balance.annualLeave + balance.carriedOver;
                  const remaining = totalEntitled - balance.usedAnnual;

                  return (
                    <motion.div
                      initial={{ opacity: 0, y: 15 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="bg-surface-card rounded-xl p-3 border border-surface-border transition-all hover:shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-1 mb-1.5">
                        <p className="text-[11px] font-medium uppercase tracking-wide truncate text-text-muted">
                          {tc('annualLeave')}
                        </p>
                        <Calendar size={14} className="text-text-muted" />
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xl font-semibold tabular-nums text-text-heading">{remaining}</span>
                        <span className="text-xs text-text-muted">
                          {t('perDaySuffix', { total: totalEntitled })}
                        </span>
                      </div>
                      <p className="text-[10px] mt-0.5 text-text-muted truncate">
                        {t('remainingAllocatedLabel')}
                      </p>
                    </motion.div>
                  );
                })()}

                {/* Fallback to legacy Sick Leave card */}
                {(() => {
                  const totalEntitled = balance.sickLeave;
                  const remaining = totalEntitled - balance.usedSick;

                  return (
                    <motion.div
                      initial={{ opacity: 0, y: 15 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 }}
                      className="bg-surface-card rounded-xl p-3 border border-surface-border transition-all hover:shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-1 mb-1.5">
                        <p className="text-[11px] font-medium uppercase tracking-wide truncate text-text-muted">
                          {tc('sickLeave')}
                        </p>
                        <Calendar size={14} className="text-text-muted" />
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xl font-semibold tabular-nums text-text-heading">{remaining}</span>
                        <span className="text-xs text-text-muted">
                          {t('perDaySuffix', { total: totalEntitled })}
                        </span>
                      </div>
                      <p className="text-[10px] mt-0.5 text-text-muted truncate">
                        {t('remainingAllocatedLabel')}
                      </p>
                    </motion.div>
                  );
                })()}

                {/* Fallback to legacy Carried Over card */}
                <motion.div
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="bg-surface-card rounded-xl p-3 border border-surface-border transition-all hover:shadow-sm"
                >
                  <div className="flex items-center justify-between gap-1 mb-1.5">
                    <p className="text-[11px] font-medium uppercase tracking-wide truncate text-text-muted">
                      {t('accumulatedLeave')}
                    </p>
                    <Calendar size={14} className="text-text-muted" />
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-semibold tabular-nums text-text-heading">{balance.carriedOver || 0}</span>
                    <span className="text-xs text-text-muted">
                      {t('perDaySuffix', { total: balance.carriedOver || 0 })}
                    </span>
                  </div>
                  <p className="text-[10px] mt-0.5 text-text-muted truncate">
                    {t('fromLastYear')}
                  </p>
                </motion.div>
              </>
            )}
          </div>
        ) : null}

        {/* Quick Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { key: 'total', label: t('statTotalRequests'), value: stats.total, icon: Calendar, iconClass: 'bg-brand-primary/10 text-brand-primary' },
            { key: 'pending', label: tc('pending'), value: stats.pending, icon: Clock, iconClass: 'bg-status-warning-bg text-status-warning' },
            { key: 'approved', label: tc('approved'), value: stats.approved, icon: CheckCircle, iconClass: 'bg-status-success-bg text-status-success' },
            { key: 'rejected', label: tc('rejected'), value: stats.rejected, icon: XCircle, iconClass: 'bg-status-error-bg text-status-error' },
          ].map((stat, index) => (
            <motion.div
              key={stat.label}
              data-testid="my-leave-stat"
              data-key={stat.key}
              data-value={stat.value}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.1 + index * 0.05 }}
              className="bg-surface-card rounded-xl p-3 sm:p-4 border border-surface-border flex items-center gap-3"
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${stat.iconClass}`}>
                <stat.icon size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-xl font-semibold tabular-nums text-text-heading">{stat.value}</p>
                <p className="text-xs text-text-muted truncate">{stat.label}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Filter */}
        <div className="flex flex-wrap gap-2">
          {[
            { key: 'all', label: t('filterAll') },
            { key: 'PENDING', label: tc('pending') },
            { key: 'APPROVED', label: tc('approved') },
            { key: 'REJECTED', label: tc('rejected') },
          ].map(({ key, label }) => (
            <button
              key={key}
              data-testid="my-leave-filter"
              data-key={key}
              data-active={filter === key}
              onClick={() => setFilter(key)}
              className={`inline-flex items-center min-w-11 h-11 md:h-9 px-3 rounded-lg text-sm font-medium transition-colors touch-manipulation ${
                filter === key
                  ? 'bg-brand-primary text-white shadow-sm'
                  : 'bg-surface-card text-text-muted hover:bg-surface-page border border-surface-border'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Requests Table */}
        <div className="bg-surface-card rounded-xl border border-surface-border shadow-sm">
          <div className="p-4 sm:p-5 border-b border-surface-border">
            <h2 className="text-sm sm:text-base font-semibold text-text-heading">{t('myRequestsTitle')}</h2>
          </div>

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-page border-b border-surface-border">
                <tr>
                  <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">{tc('leaveTypeLabel')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">{tc('startDate')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">{tc('endDate')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">{tc('totalDays')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">{tc('reason')}</th>
                  <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">{tc('status')}</th>
                  <th className="px-3 py-2.5 text-end text-[11px] font-medium text-text-muted uppercase tracking-wide">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {loading ? (
                  [...Array(5)].map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded w-20"></div></td>
                      <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded w-24"></div></td>
                      <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded w-24"></div></td>
                      <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded w-10"></div></td>
                      <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded w-32"></div></td>
                      <td className="px-3 py-2.5"><div className="h-6 bg-surface-page rounded-full w-20"></div></td>
                      <td className="px-3 py-2.5 text-end"><div className="h-11 md:h-8 bg-surface-page rounded w-16 ms-auto"></div></td>
                    </tr>
                  ))
                ) : filteredRequests.length === 0 ? (
                  <tr>
                    <td data-testid="my-leave-empty" colSpan={7} className="px-3 py-10 text-center text-sm text-text-muted">
                      {filter === 'all' ? t('noRequestsYet') : t('noRequestsInStatus')}
                    </td>
                  </tr>
                ) : (
                  filteredRequests.map((request, index) => (
                    <motion.tr
                      key={request.id}
                      data-testid="my-leave-row"
                      data-leave-id={request.id}
                      data-leave-status={request.status}
                      data-leave-type={request.leaveType}
                      data-total-days={request.totalDays}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: index * 0.03 }}
                      className="hover:bg-surface-page transition-colors cursor-pointer"
                      onClick={() => router.push(`/dashboard/leaves/${request.id}`)}
                    >
                      <td className="px-3 py-2.5">
                        <span className="text-sm font-medium text-text-heading">
                          {getLeaveTypeLabel(request.leaveType)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-sm text-text-body">{formatDate(request.startDate)}</td>
                      <td className="px-3 py-2.5 text-sm text-text-body">{formatDate(request.endDate)}</td>
                      <td className="px-3 py-2.5">
                        <span className="text-sm font-semibold text-brand-primary">{request.totalDays}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="text-sm text-text-muted line-clamp-1 max-w-xs">{request.reason}</p>
                      </td>
                      <td className="px-3 py-2.5">{getStatusBadge(request.status)}</td>
                      <td className="px-3 py-2.5 text-end whitespace-nowrap">
                        <button
                          data-testid="my-leave-review"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/dashboard/leaves/${request.id}`);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2.5 md:py-1.5 text-xs font-semibold text-brand-primary bg-brand-primary-light border border-brand-primary/20 rounded-lg hover:bg-brand-primary hover:text-white hover:shadow-sm transition-all"
                        >
                          <Eye size={14} />
                          {t('review')}
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
              // Shaped like the card it becomes, so the list does not jump when
              // the data lands. `.shimmer`, not `animate-pulse` — this app uses
              // the pulse for live-state dots.
              <SkeletonList count={4} testId="my-leave-loading-card" />
            ) : filteredRequests.length === 0 ? (
              // On a phone the empty state IS the screen, so it offers the next
              // step rather than one muted sentence. Filtered-empty and
              // truly-empty say different things: "nothing matches this filter"
              // must not read as "your requests are gone".
              filter === 'all' ? (
                <EmptyState
                  icon={Calendar}
                  title={t('noRequestsYet')}
                  action={{
                    label: t('createRequest'),
                    onClick: () => router.push('/dashboard/leaves/new'),
                    testId: 'my-leave-empty-new',
                  }}
                  testId="my-leave-empty-card"
                />
              ) : (
                <EmptyState
                  icon={Calendar}
                  title={t('noRequestsInStatus')}
                  action={{
                    label: t('filterAll'),
                    onClick: () => setFilter('all'),
                    testId: 'my-leave-empty-clear',
                  }}
                  testId="my-leave-empty-card"
                />
              )
            ) : (
              filteredRequests.map((request) => (
                <DataCard
                  key={request.id}
                  // NOT `my-leave-row`: this list and the desktop table render
                  // the SAME rows, and Playwright's `.count()` includes hidden
                  // elements — sharing one id would silently double every count.
                  testId="my-leave-card"
                  onClick={() => router.push(`/dashboard/leaves/${request.id}`)}
                  title={getLeaveTypeLabel(request.leaveType)}
                  headerRight={getStatusBadge(request.status)}
                  items={[
                    { label: t('dcStart'), value: formatDate(request.startDate) },
                    { label: t('dcEnd'), value: formatDate(request.endDate) },
                    { label: tc('totalDays'), value: <span className="font-semibold text-brand-primary">{request.totalDays}</span> },
                    { label: tc('reason'), value: request.reason || '—', full: true },
                  ]}
                  footer={
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/dashboard/leaves/${request.id}`);
                      }}
                      className="inline-flex h-11 touch-manipulation items-center gap-1.5 px-4 text-sm font-semibold text-brand-primary bg-brand-primary-light border border-brand-primary/20 rounded-lg hover:bg-brand-primary hover:text-white transition-all active:scale-[0.98]"
                    >
                      <Eye size={14} />
                      {t('review')}
                    </button>
                  }
                />
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
