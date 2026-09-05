'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePermission } from '@/hooks/usePermission';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import { Calendar, Plus, Clock, CheckCircle, XCircle, AlertCircle, Search, RefreshCw, X } from 'lucide-react';
import { motion } from 'framer-motion';
import leaveService from '@/services/leaveService';
import libraryService from '@/services/libraryService';
import { useAuthStore } from '@/store/authStore';
import { LeaveRequest, LeaveBalance } from '@/types/leave';
import { formatDate } from '@/utils/formatters';

export default function LeavesPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { can } = usePermission();
  const t = useTranslations('leavesPage');
  const tc = useTranslations('common');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [companyOverview, setCompanyOverview] = useState<any | null>(null);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filtering and pagination states
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    const fetchLeaveTypes = async () => {
      try {
        const res = await libraryService.getAll('LEAVE_TYPE', true);
        if (res.success) {
          setLeaveTypes(res.data);
        }
      } catch (error) {
        console.error('Failed to fetch leave types:', error);
      }
    };
    fetchLeaveTypes();
  }, []);

  useEffect(() => {
    // Check for success message from sessionStorage
    if (typeof window !== 'undefined') {
      const message = sessionStorage.getItem('leaveRequestSuccess');
      if (message) {
        setSuccessMessage(message);
        sessionStorage.removeItem('leaveRequestSuccess');

        // Auto-hide after 5 seconds
        setTimeout(() => {
          setSuccessMessage(null);
        }, 5000);
      }
    }
  }, []);

  const fetchData = useCallback(async () => {
    const isAdminOrHR = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';
    if (!isAdminOrHR && !user?.employeeId) return;

    try {
      setLoading(true);

      if (isAdminOrHR) {
        const overviewRes = await leaveService.getCompanyOverview();
        setCompanyOverview(overviewRes.data);
      } else {
        const balanceRes = await leaveService.getBalance(user!.employeeId!);
        setBalance(balanceRes.data);
      }

      const params: any = {
        page,
        limit: 10,
        status: statusFilter || undefined,
        leaveType: typeFilter || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      };

      if (isAdminOrHR) {
        params.search = search || undefined;
        const requestsRes = await leaveService.getAll(params);
        setRequests(requestsRes.data || []);
        setTotalPages(requestsRes.meta?.totalPages || 1);
      } else {
        const requestsRes = await leaveService.getMyRequests(params);
        setRequests(requestsRes.data || []);
        setTotalPages(1);
      }
    } catch (error) {
      console.error('Failed to fetch leave data:', error);
    } finally {
      setLoading(false);
    }
  }, [user, page, statusFilter, typeFilter, startDate, endDate, search]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const getStatusBadge = (status: string) => {
    const styles = {
      PENDING: 'bg-status-warning-bg text-status-warning border-status-warning/20',
      APPROVED: 'bg-status-success-bg text-status-success border-status-success/20',
      REJECTED: 'bg-status-error-bg text-status-error border-status-error/20',
      CANCELLED: 'bg-surface-page text-text-muted border-surface-border',
    };
    const icons = {
      PENDING: Clock,
      APPROVED: CheckCircle,
      REJECTED: XCircle,
      CANCELLED: XCircle,
    };
    const Icon = icons[status as keyof typeof icons] || AlertCircle;
    const labels = {
      PENDING: tc('pending'),
      APPROVED: tc('approved'),
      REJECTED: tc('rejected'),
      CANCELLED: tc('cancelled'),
    };

    return (
      <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border whitespace-nowrap ${styles[status as keyof typeof styles] || 'bg-surface-page text-text-muted'}`}>
        <Icon size={14} />
        {labels[status as keyof typeof labels] || status}
      </span>
    );
  };

  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_LEAVES">
      <>
        <div className="space-y-6">
          {/* Success Message */}
          {successMessage && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-status-success-bg border border-status-success/20 rounded-xl p-4 flex items-center gap-3"
            >
              <CheckCircle className="text-status-success" size={24} />
              <div className="flex-1">
                <p className="text-status-success font-medium">{successMessage}</p>
              </div>
              <button
                onClick={() => setSuccessMessage(null)}
                className="text-status-success hover:opacity-80"
              >
                <XCircle size={20} />
              </button>
            </motion.div>
          )}

          {/* Primary action. The title/description live in the sticky TopHeader
              (declared via usePageHeader above). */}
          <PageActionRow
            action={
              can('CREATE_LEAVE') && user?.employeeId && !['ADMIN', 'HR_MANAGER'].includes(user?.role || '') ? (
                <button
                  data-testid="lv-new"
                  onClick={() => router.push('/dashboard/leaves/new')}
                  className="flex items-center gap-2 px-4 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark hover:shadow-lg transition-all"
                >
                  <Plus size={20} />
                  {t('createRequest')}
                </button>
              ) : undefined
            }
          />

          {/* Leave Balance / Overview Cards */}
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="bg-surface-card rounded-2xl p-6 border border-surface-border animate-pulse">
                  <div className="h-20 bg-surface-page rounded"></div>
                </div>
              ))}
            </div>
          ) : (user?.role === 'ADMIN' || user?.role === 'HR_MANAGER') ? (
            /* ── Admin / HR: Company-wide overview ── */
            <div className="space-y-4">
              {/* Request stats row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { key: 'pending', label: t('statPendingRequests'), value: companyOverview?.requestStats?.pending ?? 0, colorClass: 'text-status-warning', bg: 'bg-status-warning-bg', icon: '⏳' },
                  { key: 'approved', label: t('statApprovedThisYear'), value: companyOverview?.requestStats?.approved ?? 0, colorClass: 'text-status-success', bg: 'bg-status-success-bg', icon: '✓' },
                  { key: 'rejected', label: tc('rejected'), value: companyOverview?.requestStats?.rejected ?? 0, colorClass: 'text-status-error', bg: 'bg-status-error-bg', icon: '✕' },
                  { key: 'employees', label: t('statTotalEmployees'), value: companyOverview?.totalEmployees ?? 0, colorClass: 'text-brand-primary', bg: 'bg-brand-primary-light/10', icon: '👥' },
                ].map((stat, i) => (
                  <motion.div
                    key={stat.label}
                    data-testid={`lv-stat-${stat.key}`}
                    data-value={stat.value}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className={`${stat.bg} rounded-[--radius-card] p-5 border border-surface-border`}
                  >
                    <p className="text-sm text-text-muted mb-2">{stat.label}</p>
                    <p className={`text-3xl font-bold ${stat.colorClass}`}>{stat.value}</p>
                  </motion.div>
                ))}
              </div>

              {/* Per-leave-type usage breakdown */}
              {companyOverview?.leaveTypes && companyOverview.leaveTypes.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {companyOverview.leaveTypes.map((lt: any, idx: number) => {
                    const usedPct = lt.totalAllocated > 0 ? Math.round((lt.totalUsed / lt.totalAllocated) * 100) : 0;
                    const isAnnual = lt.leaveTypeKey.toLowerCase().includes('annual');
                    return (
                      <motion.div
                        key={lt.leaveTypeKey}
                        data-testid="lv-type-card"
                        data-leave-type={lt.leaveTypeKey}
                        data-used={lt.totalUsed}
                        data-remaining={lt.totalRemaining}
                        data-allocated={lt.totalAllocated}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 + idx * 0.05 }}
                        className={`rounded-[--radius-card] p-5 border-2 relative overflow-hidden ${
                          isAnnual ? 'bg-brand-primary text-text-on-brand border-transparent' : 'bg-surface-card border-surface-border'
                        }`}
                      >
                        {isAnnual && (
                          <div className="absolute top-0 end-0 w-28 h-28 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2" />
                        )}
                        <div className="relative z-10">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isAnnual ? 'bg-white/20' : 'bg-surface-page'}`}>
                                <Calendar size={16} className={isAnnual ? 'text-text-on-brand' : 'text-text-muted'} />
                              </div>
                              <p className={`text-xs font-medium ${isAnnual ? 'text-text-on-brand/80' : 'text-text-muted'}`}>
                                {lt.leaveTypeKey}
                              </p>
                            </div>
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${isAnnual ? 'bg-white/20 text-text-on-brand' : 'bg-surface-page text-text-muted'}`}>
                              {t('empCount', { count: lt.employeeCount })}
                            </span>
                          </div>
                          <p className={`text-2xl font-bold mb-1 ${isAnnual ? 'text-text-on-brand' : 'text-text-heading'}`}>
                            {t('daysUsed', { days: lt.totalUsed })}
                          </p>
                          <p className={`text-xs mb-2 ${isAnnual ? 'text-text-on-brand/70' : 'text-text-muted'}`}>
                            {t('remainingOfAllocated', { remaining: lt.totalRemaining, allocated: lt.totalAllocated })}
                          </p>
                          {/* Usage bar */}
                          <div className={`h-1.5 rounded-full ${isAnnual ? 'bg-white/20' : 'bg-surface-page'}`}>
                            <div
                              className={`h-1.5 rounded-full ${isAnnual ? 'bg-white/70' : 'bg-brand-primary'}`}
                              style={{ width: `${Math.min(usedPct, 100)}%` }}
                            />
                          </div>
                          <p className={`text-xs mt-1 ${isAnnual ? 'text-text-on-brand/60' : 'text-text-muted'}`}>{t('utilisedPercent', { percent: usedPct })}</p>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* ── Employee: personal leave balance ── */
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {balance && balance.leaveTypeBalances && balance.leaveTypeBalances.length > 0 ? (
                balance.leaveTypeBalances.map((tb, idx) => (
                  <motion.div
                    key={tb.id || idx}
                    data-testid="lv-balance-card"
                    data-leave-type={tb.leaveTypeKey}
                    data-remaining={tb.remaining}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    className={`rounded-[--radius-card] p-6 border-2 relative overflow-hidden ${
                      tb.leaveTypeKey.toLowerCase().includes('annual')
                        ? 'bg-brand-primary text-text-on-brand border-transparent'
                        : 'bg-surface-card text-text-body border-surface-border'
                    }`}
                  >
                    {tb.leaveTypeKey.toLowerCase().includes('annual') && (
                      <div className="absolute top-0 end-0 w-32 h-32 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2"></div>
                    )}
                    <div className="relative z-10">
                      <div className="flex items-center gap-3 mb-4">
                        <div className={`w-12 h-12 rounded-[--radius-card] flex items-center justify-center ${
                          tb.leaveTypeKey.toLowerCase().includes('annual') ? 'bg-white/20' : 'bg-surface-page'
                        }`}>
                          <Calendar className={tb.leaveTypeKey.toLowerCase().includes('annual') ? 'text-text-on-brand' : 'text-text-muted'} size={24} />
                        </div>
                        <p className={`text-sm ${tb.leaveTypeKey.toLowerCase().includes('annual') ? 'text-text-on-brand/80' : 'text-text-muted'}`}>
                          {tb.leaveTypeKey}
                        </p>
                      </div>
                      <p className="text-4xl font-bold">{tb.remaining}</p>
                      <p className={`text-sm mt-2 ${tb.leaveTypeKey.toLowerCase().includes('annual') ? 'text-text-on-brand/70' : 'text-text-muted'}`}>
                        {t('remainingOfDays', { total: tb.allocated + tb.carriedOver })}
                      </p>
                    </div>
                  </motion.div>
                ))
              ) : (
                <>
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-brand-primary rounded-[--radius-card] p-6 text-text-on-brand relative overflow-hidden border-2 border-transparent"
                  >
                    <div className="absolute top-0 end-0 w-32 h-32 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2"></div>
                    <div className="relative z-10">
                      <div className="flex items-center gap-3 mb-4">
                        <div className="w-12 h-12 bg-white/20 rounded-[--radius-card] flex items-center justify-center">
                          <Calendar size={24} />
                        </div>
                        <p className="text-text-on-brand/80 text-sm">{tc('annualLeave')}</p>
                      </div>
                      <p className="text-4xl font-bold">{balance ? (balance.remainingAnnual ?? (balance.annualLeave + balance.carriedOver - balance.usedAnnual)) : 0}</p>
                      <p className="text-text-on-brand/70 text-sm mt-2">
                        {t('remainingOfDays', { total: balance ? (balance.annualLeave + balance.carriedOver) : 0 })}
                      </p>
                    </div>
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                    className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border"
                  >
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-12 h-12 bg-status-success-bg rounded-[--radius-card] flex items-center justify-center">
                        <Calendar className="text-status-success" size={24} />
                      </div>
                      <p className="text-text-muted text-sm">{tc('sickLeave')}</p>
                    </div>
                    <p className="text-4xl font-bold text-text-heading">{balance ? (balance.remainingSick ?? (balance.sickLeave - balance.usedSick)) : 0}</p>
                    <p className="text-text-muted text-sm mt-2">
                      {t('remainingOfDays', { total: balance?.sickLeave || 0 })}
                    </p>
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border"
                  >
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-12 h-12 bg-brand-primary-light/20 rounded-[--radius-card] flex items-center justify-center">
                        <Calendar className="text-brand-primary" size={24} />
                      </div>
                      <p className="text-text-muted text-sm">{t('accumulatedLeave')}</p>
                    </div>
                    <p className="text-4xl font-bold text-text-heading">{balance?.carriedOver || 0}</p>
                    <p className="text-text-muted text-sm mt-2">{t('fromLastYear')}</p>
                  </motion.div>
                </>
              )}
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap gap-3 items-center">
            {/* Search Input (Admin/HR Only) */}
            {(user?.role === 'ADMIN' || user?.role === 'HR_MANAGER') && (
              <div className="flex-1 min-w-[240px] relative">
                <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
                <input
                  data-testid="lv-search"
                  type="text"
                  placeholder={t('searchPlaceholder')}
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  className="w-full rounded-[--radius-input] border border-surface-border bg-surface-card ps-9 pe-4 py-2.5 text-sm text-text-body placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all"
                />
              </div>
            )}

            {/* Leave Type Select */}
            <select
              data-testid="lv-filter-type"
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
              className="rounded-[--radius-input] border border-surface-border bg-surface-card px-4 py-2.5 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all cursor-pointer"
            >
              <option value="">{t('allLeaveTypes')}</option>
              {leaveTypes.map((t) => (
                <option key={t.id} value={t.label}>
                  {t.label}
                </option>
              ))}
            </select>

            {/* Status Select */}
            <select
              data-testid="lv-filter-status"
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="rounded-[--radius-input] border border-surface-border bg-surface-card px-4 py-2.5 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all cursor-pointer"
            >
              <option value="">{t('allStatuses')}</option>
              <option value="PENDING">{tc('pending')}</option>
              <option value="APPROVED">{tc('approved')}</option>
              <option value="REJECTED">{tc('rejected')}</option>
              <option value="CANCELLED">{tc('cancelled')}</option>
            </select>

            {/* Start Date */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">{tc('from')}</span>
              <input
                data-testid="lv-filter-from"
                type="date"
                value={startDate}
                onChange={(e) => { setStartDate(e.target.value); setPage(1); }}
                className="rounded-[--radius-input] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all cursor-pointer"
              />
            </div>

            {/* End Date */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">{tc('to')}</span>
              <input
                data-testid="lv-filter-to"
                type="date"
                value={endDate}
                onChange={(e) => { setEndDate(e.target.value); setPage(1); }}
                className="rounded-[--radius-input] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all cursor-pointer"
              />
            </div>

            {/* Reset Filters / Refresh button */}
            <div className="flex gap-2">
              {(search || statusFilter || typeFilter || startDate || endDate) && (
                <button
                  data-testid="lv-filter-clear"
                  onClick={() => {
                    setSearch('');
                    setStatusFilter('');
                    setTypeFilter('');
                    setStartDate('');
                    setEndDate('');
                    setPage(1);
                  }}
                  className="flex items-center gap-1 px-3 py-2.5 rounded-[--radius-button] border border-status-error/20 bg-status-error-bg text-xs font-semibold text-status-error hover:opacity-85 transition-all shadow-sm animate-fadeIn"
                  title={tc('clearFilters')}
                >
                  <X className="h-4 w-4" />
                  {tc('clear')}
                </button>
              )}
              <button
                data-testid="lv-refresh"
                onClick={fetchData}
                className="flex items-center gap-2 rounded-[--radius-button] border border-surface-border bg-surface-card px-4 py-2.5 text-sm text-text-muted hover:bg-surface-page transition-all shadow-sm"
                title={tc('refresh')}
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Recent Requests */}
          <div className="bg-surface-card rounded-[--radius-card] border border-surface-border">
            <div className="p-6 border-b border-surface-border">
              <h2 className="text-xl font-bold text-text-heading">{t('requestsTitle')}</h2>
              <p className="text-sm text-text-muted mt-1">{t('requestsSubtitle')}</p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-surface-page border-b border-surface-border">
                  <tr>
                    {(user?.role === 'ADMIN' || user?.role === 'HR_MANAGER') && (
                      <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                        {tc('employee')}
                      </th>
                    )}
                    <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                      {tc('leaveTypeLabel')}
                    </th>
                    <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                      {tc('startDate')}
                    </th>
                    <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                      {tc('endDate')}
                    </th>
                    <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                      {tc('totalDays')}
                    </th>
                    <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                      {tc('reason')}
                    </th>
                    <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase tracking-wider">
                      {tc('status')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {loading ? (
                    [...Array(5)].map((_, i) => (
                      <tr key={i} className="animate-pulse">
                        <td className="px-6 py-4"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-6 py-4"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-6 py-4"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-6 py-4"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-6 py-4"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-6 py-4"><div className="h-6 bg-surface-page rounded-full"></div></td>
                      </tr>
                    ))
                  ) : requests.length === 0 ? (
                    <tr>
                      <td
                        data-testid="lv-empty"
                        colSpan={(user?.role === 'ADMIN' || user?.role === 'HR_MANAGER') ? 7 : 6}
                        className="px-6 py-12 text-center text-text-muted"
                      >
                        {t('noRequestsYet')}
                      </td>
                    </tr>
                  ) : (
                    requests.map((request, index) => (
                      <motion.tr
                        key={request.id}
                        data-testid="lv-row"
                        data-leave-id={request.id}
                        data-status={request.status}
                        data-leave-type={request.leaveType}
                        data-total-days={request.totalDays}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: index * 0.05 }}
                        className="hover:bg-surface-page transition-colors cursor-pointer"
                        onClick={() => router.push(`/dashboard/leaves/${request.id}`)}
                      >
                        {(user?.role === 'ADMIN' || user?.role === 'HR_MANAGER') && (
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <div className="w-8 h-8 rounded-full bg-brand-primary-light flex items-center justify-center text-brand-primary font-semibold text-xs">
                                {request.employee?.fullName?.split(' ').map(n => n[0]).join('').slice(0, 2) || 'NA'}
                              </div>
                              <div>
                                <p className="text-sm font-medium text-text-heading">{request.employee?.fullName || tc('notAvailable')}</p>
                                <p className="text-xs text-text-muted">{request.employee?.employeeCode || ''}</p>
                              </div>
                            </div>
                          </td>
                        )}
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-text-heading">
                            {request.leaveType === 'ANNUAL' ? tc('annualLeave') :
                              request.leaveType === 'SICK' ? tc('sickLeave') :
                                request.leaveType === 'UNPAID' ? tc('unpaidLeave') :
                                  request.leaveType === 'MATERNITY' ? tc('maternityLeave') :
                                    request.leaveType === 'PATERNITY' ? tc('paternityLeave') :
                                      request.leaveType === 'BEREAVEMENT' ? tc('bereavementLeave') : request.leaveType}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-text-body">{formatDate(request.startDate)}</td>
                        <td className="px-6 py-4 text-sm text-text-body">{formatDate(request.endDate)}</td>
                        <td className="px-6 py-4">
                          <span className="text-sm font-semibold text-brand-primary">{request.totalDays}</span>
                        </td>
                        <td className="px-6 py-4">
                          <p className="text-sm text-text-muted line-clamp-1">{request.reason}</p>
                        </td>
                        <td className="px-6 py-4">{getStatusBadge(request.status)}</td>
                      </motion.tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="p-4 border-t border-surface-border flex justify-center gap-2">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    // The shared `Pagination` component already emits this id
                    // shape (`${prefix}-page-${n}` + `data-active`). This screen
                    // hand-rolls its pager — one button per page, no truncation
                    // — so it borrows the SAME shape, and a later swap to the
                    // shared component stays selector-compatible.
                    data-testid={`lv-pg-page-${p}`}
                    data-active={p === page}
                    onClick={() => setPage(p)}
                    className={`h-9 w-9 rounded-[--radius-button] text-sm font-medium transition-all ${
                      p === page
                        ? 'bg-brand-primary text-text-on-brand font-bold'
                        : 'border border-surface-border bg-surface-card text-text-muted hover:bg-surface-page'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>

        </div>
      </>
    </ProtectedRoute>
  );
}
