'use client';

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePermission } from '@/hooks/usePermission';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import {
  Plus,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  Calendar,
  Search,
  RefreshCw,
  X,
  ChevronRight,
  Filter,
} from 'lucide-react';
import Pagination from '@/components/common/Pagination';
import overtimeService from '@/services/overtimeService';
import { Overtime } from '@/types/overtime';
import { useAuthStore } from '@/store/authStore';
import { formatCurrency, formatWallClockDate, formatWallClockTime } from '@/utils/formatters';

export default function OvertimePage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { can } = usePermission();
  const t = useTranslations('overtimePage');
  const tc = useTranslations('common');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  // Data state
  const [overtimes, setOvertimes] = useState<Overtime[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters & Search
  const [filter, setFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [otTypeFilter, setOtTypeFilter] = useState<string>('all');
  const [startDateFilter, setStartDateFilter] = useState('');
  const [endDateFilter, setEndDateFilter] = useState('');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);

  const isAdminOrHR = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';

  const statusLabels: Record<string, { label: string; color: string }> = {
    PENDING: {
      label: tc('pending'),
      color: 'bg-status-warning-bg text-status-warning border border-status-warning/20',
    },
    APPROVED: {
      label: tc('approved'),
      color: 'bg-status-success-bg text-status-success border border-status-success/20',
    },
    REJECTED: {
      label: tc('rejected'),
      color: 'bg-status-error-bg text-status-error border border-status-error/20',
    },
    CANCELLED: {
      label: tc('cancelled'),
      color: 'bg-surface-page text-text-muted border border-surface-border',
    },
  };

  const otTypeLabels: Record<string, { label: string; color: string }> = {
    REGULAR: {
      label: t('otTypeRegular'),
      color: 'bg-brand-primary-light/20 text-brand-primary border border-brand-primary/20',
    },
    LATE: {
      label: t('otTypeLateOt'),
      color: 'bg-amber-500/10 text-amber-700 border border-amber-500/20',
    },
    DOUBLE: {
      label: t('otTypeDoubleOt'),
      color: 'bg-status-error-bg text-status-error border border-status-error/20',
    },
    DOUBLE_LATE: {
      label: t('otTypeDoubleLate'),
      color: 'bg-status-error-bg/60 text-status-error border border-status-error/40 font-bold',
    },
  };

  const renderOtTypeBadge = (otType?: string) => {
    const type = otType || 'REGULAR';
    const meta = otTypeLabels[type] || otTypeLabels.REGULAR;
    return (
      <span className={`px-2.5 py-1 rounded-[--radius-badge] text-xs font-semibold whitespace-nowrap inline-flex items-center gap-1 ${meta.color}`}>
        {meta.label}
      </span>
    );
  };

  // Fetch overtimes from backend
  const fetchOvertimes = useCallback(async () => {
    try {
      setLoading(true);
      // Admin / HR Manager see all branch requests, employees/managers see scoped
      const response = await (isAdminOrHR
        ? overtimeService.getAll({ page: 1, limit: 1000 })
        : overtimeService.getMyRequests()
      );

      const data = Array.isArray(response.data) ? response.data : [];
      setOvertimes(data);
    } catch (error) {
      console.error('Failed to fetch overtimes:', error);
      setOvertimes([]);
    } finally {
      setLoading(false);
    }
  }, [isAdminOrHR]);

  useEffect(() => {
    if (user) {
      fetchOvertimes();
    }
  }, [user?.role, fetchOvertimes]);

  // Client-side filtering across status, search, type and date range
  const filteredOvertimes = useMemo(() => {
    if (!Array.isArray(overtimes)) return [];

    return overtimes.filter((o) => {
      // 1. Status Filter
      if (filter !== 'all' && o.status !== filter) {
        return false;
      }

      // 2. OT Type Filter
      if (otTypeFilter !== 'all' && o.otType !== otTypeFilter) {
        return false;
      }

      // 3. Date Range Filter
      if (startDateFilter) {
        const itemDate = new Date(o.date).toISOString().slice(0, 10);
        if (itemDate < startDateFilter) return false;
      }
      if (endDateFilter) {
        const itemDate = new Date(o.date).toISOString().slice(0, 10);
        if (itemDate > endDateFilter) return false;
      }

      // 4. Search Filter (Employee name, employee code, reason, department)
      if (searchTerm.trim()) {
        const query = searchTerm.toLowerCase().trim();
        const empName = (o.employee?.fullName || '').toLowerCase();
        const empCode = (o.employee?.employeeCode || '').toLowerCase();
        const deptName = (o.employee?.department?.name || '').toLowerCase();
        const reason = (o.reason || '').toLowerCase();

        const match =
          empName.includes(query) ||
          empCode.includes(query) ||
          deptName.includes(query) ||
          reason.includes(query);

        if (!match) return false;
      }

      return true;
    });
  }, [overtimes, filter, otTypeFilter, startDateFilter, endDateFilter, searchTerm]);

  // Statistics calculated from active dataset
  const stats = useMemo(() => {
    if (!Array.isArray(overtimes) || overtimes.length === 0) {
      return { total: 0, pending: 0, approved: 0, rejected: 0, totalHours: 0 };
    }

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const currentMonthData = overtimes.filter((o) => {
      const overtimeDate = new Date(o.date);
      return (
        overtimeDate.getMonth() === currentMonth &&
        overtimeDate.getFullYear() === currentYear
      );
    });

    const totalHours = currentMonthData
      .filter((o) => o.status === 'APPROVED')
      .reduce((sum, o) => sum + (Number(o.hours) || 0), 0);

    return {
      total: overtimes.length,
      pending: overtimes.filter((o) => o.status === 'PENDING').length,
      approved: overtimes.filter((o) => o.status === 'APPROVED').length,
      rejected: overtimes.filter((o) => o.status === 'REJECTED').length,
      totalHours,
    };
  }, [overtimes]);

  // Pagination calculation
  const totalFiltered = filteredOvertimes.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / itemsPerPage));

  // Clamped paginated slice
  const paginatedOvertimes = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredOvertimes.slice(start, start + itemsPerPage);
  }, [filteredOvertimes, currentPage, itemsPerPage]);

  const handlePageChange = (newPage: number) => {
    setCurrentPage(Math.max(1, Math.min(newPage, totalPages)));
  };

  const handleItemsPerPageChange = (newLimit: number) => {
    setItemsPerPage(newLimit);
    setCurrentPage(1);
  };

  const handleFilterChange = (status: string) => {
    setFilter(status);
    setCurrentPage(1);
  };

  const handleClearFilters = () => {
    setFilter('all');
    setSearchTerm('');
    setOtTypeFilter('all');
    setStartDateFilter('');
    setEndDateFilter('');
    setCurrentPage(1);
  };

  const hasActiveFilters =
    filter !== 'all' ||
    searchTerm !== '' ||
    otTypeFilter !== 'all' ||
    startDateFilter !== '' ||
    endDateFilter !== '';

  const totalCols = isAdminOrHR ? 8 : 7;

  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_OVERTIME">
      <div className="space-y-5 pb-8 max-w-full">
        {/* The title and subtitle live in the sticky TopHeader (declared via
            usePageHeader above) — rendering them here as well is the
            duplicate-title defect PageActionRow exists to prevent. What is
            genuinely page-local, the result count and the actions, stays. */}
        <PageActionRow
          action={
            <>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-primary-light/20 text-brand-primary border border-brand-primary/20">
                {t('recordCount', { count: totalFiltered })}
              </span>

              <button
                onClick={fetchOvertimes}
                disabled={loading}
                title={t('refresh')}
                className="p-2.5 rounded-[--radius-button] border border-surface-border bg-surface-card text-text-muted hover:text-text-heading hover:bg-surface-page hover:shadow-sm transition-all cursor-pointer disabled:opacity-50"
              >
                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
              </button>

              {can('CREATE_OVERTIME') && (
                <button
                  data-testid="ot-new"
                  onClick={() => router.push('/dashboard/overtime/new')}
                  className="flex items-center gap-2 px-5 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button] font-semibold text-sm hover:bg-brand-primary-dark hover:shadow-lg transition-all shadow-md shadow-brand-primary/20 cursor-pointer"
                >
                  <Plus size={18} />
                  {t('signUpBtn')}
                </button>
              )}
            </>
          }
        />

        {/* Metric KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
          {/* 1. Total Requests */}
          <div className="bg-surface-card rounded-[--radius-card] p-4 sm:p-5 border border-surface-border shadow-sm flex flex-col justify-between hover:border-brand-primary/30 transition-colors">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs sm:text-sm text-text-muted font-medium truncate">
                {t('statTotalRequests')}
              </span>
              <div className="w-8 h-8 rounded-lg bg-brand-primary-light/20 flex items-center justify-center shrink-0">
                <Calendar className="text-brand-primary" size={16} />
              </div>
            </div>
            <div>
              <p className="text-2xl sm:text-3xl font-bold text-text-heading">
                {stats.total}
              </p>
              <p className="text-[11px] text-text-muted mt-0.5">{t('statAllTheTime')}</p>
            </div>
          </div>

          {/* 2. Pending */}
          <div className="bg-surface-card rounded-[--radius-card] p-4 sm:p-5 border border-status-warning/30 shadow-sm flex flex-col justify-between hover:border-status-warning/50 transition-colors">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs sm:text-sm text-text-muted font-medium truncate">
                {tc('pending')}
              </span>
              <div className="w-8 h-8 rounded-lg bg-status-warning-bg flex items-center justify-center shrink-0">
                <AlertCircle className="text-status-warning" size={16} />
              </div>
            </div>
            <div>
              <p
                data-testid="ot-stat"
                data-key="pending"
                data-value={stats.pending}
                className="text-2xl sm:text-3xl font-bold text-status-warning"
              >
                {stats.pending}
              </p>
              <p className="text-[11px] text-text-muted mt-0.5">
                {t('statNeedsProcessing')}
              </p>
            </div>
          </div>

          {/* 3. Approved */}
          <div className="bg-surface-card rounded-[--radius-card] p-4 sm:p-5 border border-status-success/30 shadow-sm flex flex-col justify-between hover:border-status-success/50 transition-colors">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs sm:text-sm text-text-muted font-medium truncate">
                {tc('approved')}
              </span>
              <div className="w-8 h-8 rounded-lg bg-status-success-bg flex items-center justify-center shrink-0">
                <CheckCircle className="text-status-success" size={16} />
              </div>
            </div>
            <div>
              <p
                data-testid="ot-stat"
                data-key="approved"
                data-value={stats.approved}
                className="text-2xl sm:text-3xl font-bold text-status-success"
              >
                {stats.approved}
              </p>
              <p className="text-[11px] text-text-muted mt-0.5">{tc('approved')}</p>
            </div>
          </div>

          {/* 4. Rejected */}
          <div className="bg-surface-card rounded-[--radius-card] p-4 sm:p-5 border border-status-error/30 shadow-sm flex flex-col justify-between hover:border-status-error/50 transition-colors">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs sm:text-sm text-text-muted font-medium truncate">
                {tc('rejected')}
              </span>
              <div className="w-8 h-8 rounded-lg bg-status-error-bg flex items-center justify-center shrink-0">
                <XCircle className="text-status-error" size={16} />
              </div>
            </div>
            <div>
              <p
                data-testid="ot-stat"
                data-key="rejected"
                data-value={stats.rejected}
                className="text-2xl sm:text-3xl font-bold text-status-error"
              >
                {stats.rejected}
              </p>
              <p className="text-[11px] text-text-muted mt-0.5">{t('statNotApproved')}</p>
            </div>
          </div>

          {/* 5. Approved OT Hours */}
          <div className="col-span-2 lg:col-span-1 bg-brand-primary rounded-[--radius-card] p-4 sm:p-5 text-text-on-brand shadow-sm flex flex-col justify-between border border-brand-primary/30">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs sm:text-sm text-white/80 font-medium truncate">
                {t('statTotalHoursApproved')}
              </span>
              <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center shrink-0">
                <Clock size={16} className="text-white" />
              </div>
            </div>
            <div>
              <p
                data-testid="ot-stat"
                data-key="hours"
                data-value={stats.totalHours ?? 0}
                className="text-2xl sm:text-3xl font-bold text-white tracking-tight"
              >
                {typeof stats.totalHours === 'number'
                  ? stats.totalHours.toLocaleString('en-IN')
                  : '0'}
                h
              </p>
              <p className="text-[11px] text-white/70 mt-0.5">{tc('thisMonth')}</p>
            </div>
          </div>
        </div>

        {/* Filter and Search Toolbar */}
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-4 shadow-sm space-y-3">
          {/* Top row: Search and Status Tabs */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            {/* Status Pills */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 lg:pb-0 scrollbar-none">
              {['all', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((status) => {
                const isActive = filter === status;
                const count =
                  status === 'all'
                    ? overtimes.length
                    : overtimes.filter((o) => o.status === status).length;

                return (
                  <button
                    key={status}
                    data-testid="ot-filter"
                    data-key={status}
                    data-active={isActive}
                    onClick={() => handleFilterChange(status)}
                    className={`px-3.5 py-1.5 rounded-[--radius-button] text-xs font-semibold transition-all cursor-pointer whitespace-nowrap flex items-center gap-1.5 ${
                      isActive
                        ? 'bg-brand-primary text-text-on-brand shadow-sm'
                        : 'bg-surface-page text-text-muted hover:text-text-heading hover:bg-surface-border/50 border border-surface-border'
                    }`}
                  >
                    <span>{status === 'all' ? t('filterAll') : (statusLabels[status]?.label ?? status)}</span>
                    <span
                      className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                        isActive
                          ? 'bg-white/20 text-white'
                          : 'bg-surface-card text-text-muted'
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Quick Search */}
            <div className="relative min-w-[260px] flex-1 lg:max-w-md">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted pointer-events-none" />
              <input
                type="text"
                placeholder={t('searchPlaceholder')}
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full rounded-[--radius-input] border border-surface-border bg-surface-page ps-9 pe-8 py-2 text-xs sm:text-sm text-text-body placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all"
              />
              {searchTerm && (
                <button
                  onClick={() => {
                    setSearchTerm('');
                    setCurrentPage(1);
                  }}
                  className="absolute end-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-heading"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Bottom row: OT Type, Date Range & Clear */}
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-surface-border/50 text-xs">
            {/* OT Type Filter */}
            <div className="flex items-center gap-1.5">
              <span className="text-text-muted font-medium">{t('filterOtType')}:</span>
              <select
                value={otTypeFilter}
                onChange={(e) => {
                  setOtTypeFilter(e.target.value);
                  setCurrentPage(1);
                }}
                className="px-2.5 py-1.5 bg-surface-page border border-surface-border rounded-lg text-text-body text-xs focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary cursor-pointer"
              >
                <option value="all">{t('allOtTypes')}</option>
                <option value="REGULAR">{t('otTypeRegular')}</option>
                <option value="LATE">{t('otTypeLateOt')}</option>
                <option value="DOUBLE">{t('otTypeDoubleOt')}</option>
                <option value="DOUBLE_LATE">{t('otTypeDoubleLate')}</option>
              </select>
            </div>

            {/* Date From */}
            <div className="flex items-center gap-1.5">
              <span className="text-text-muted font-medium">{tc('from')}:</span>
              <input
                type="date"
                value={startDateFilter}
                onChange={(e) => {
                  setStartDateFilter(e.target.value);
                  setCurrentPage(1);
                }}
                className="px-2.5 py-1.5 bg-surface-page border border-surface-border rounded-lg text-text-body text-xs focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary cursor-pointer"
              />
            </div>

            {/* Date To */}
            <div className="flex items-center gap-1.5">
              <span className="text-text-muted font-medium">{tc('to')}:</span>
              <input
                type="date"
                value={endDateFilter}
                onChange={(e) => {
                  setEndDateFilter(e.target.value);
                  setCurrentPage(1);
                }}
                className="px-2.5 py-1.5 bg-surface-page border border-surface-border rounded-lg text-text-body text-xs focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary cursor-pointer"
              />
            </div>

            {/* Clear Filters button */}
            {hasActiveFilters && (
              <button
                onClick={handleClearFilters}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-status-error/20 bg-status-error-bg text-status-error text-xs font-semibold hover:bg-status-error-bg/80 transition-colors ms-auto cursor-pointer"
              >
                <X size={12} />
                {t('clearFilters')}
              </button>
            )}
          </div>
        </div>

        {/* Data Table Card */}
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm overflow-hidden flex flex-col">
          <div className="w-full overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead className="bg-surface-page border-b border-surface-border sticky top-0 z-10">
                <tr>
                  {isAdminOrHR && (
                    <th className="ps-4 pe-2 py-3 text-start text-xs font-bold text-text-muted uppercase tracking-wider">
                      {tc('employee')}
                    </th>
                  )}
                  <th className="px-2.5 py-3 text-start text-xs font-bold text-text-muted uppercase tracking-wider whitespace-nowrap">
                    {t('colDay')}
                  </th>
                  <th className="px-2.5 py-3 text-start text-xs font-bold text-text-muted uppercase tracking-wider whitespace-nowrap">
                    {t('colTime')}
                  </th>
                  <th className="px-2 py-3 text-center text-xs font-bold text-text-muted uppercase tracking-wider whitespace-nowrap">
                    {t('colNumberOfHours')}
                  </th>
                  <th className="px-2 py-3 text-center text-xs font-bold text-text-muted uppercase tracking-wider whitespace-nowrap">
                    {t('colOtType')}
                  </th>
                  <th className="px-2 py-3 text-center text-xs font-bold text-text-muted uppercase tracking-wider whitespace-nowrap">
                    {t('colFoodAllowance')}
                  </th>
                  <th className="px-2 py-3 text-center text-xs font-bold text-text-muted uppercase tracking-wider whitespace-nowrap">
                    {tc('status')}
                  </th>
                  <th className="ps-2 pe-4 py-3 text-end text-xs font-bold text-text-muted uppercase tracking-wider whitespace-nowrap">
                    {tc('actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border bg-surface-card text-xs sm:text-sm">
                {loading ? (
                  <tr>
                    <td
                      data-testid="ot-loading"
                      colSpan={totalCols}
                      className="px-6 py-16 text-center"
                    >
                      <div className="flex flex-col items-center justify-center gap-3">
                        <div className="w-8 h-8 border-3 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                        <p className="text-xs text-text-muted font-medium">
                          {tc('loading')}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : filteredOvertimes.length === 0 ? (
                  <tr>
                    <td
                      data-testid="ot-empty"
                      colSpan={totalCols}
                      className="px-6 py-16 text-center"
                    >
                      <div className="flex flex-col items-center justify-center max-w-sm mx-auto text-center">
                        <div className="w-12 h-12 rounded-full bg-surface-page flex items-center justify-center mb-3 text-text-muted">
                          <Filter size={24} />
                        </div>
                        <p className="text-sm font-semibold text-text-heading mb-1">
                          {hasActiveFilters ? t('noMatchingRecords') : t('emptyNoOrders')}
                        </p>
                        <p className="text-xs text-text-muted mb-4">
                          {hasActiveFilters
                            ? 'Try refining or clearing your search filters.'
                            : 'No overtime requests have been recorded yet.'}
                        </p>
                        {hasActiveFilters ? (
                          <button
                            onClick={handleClearFilters}
                            className="px-3.5 py-1.5 bg-surface-page hover:bg-surface-border text-text-body rounded-lg text-xs font-medium border border-surface-border transition-colors cursor-pointer"
                          >
                            {t('resetFilters')}
                          </button>
                        ) : can('CREATE_OVERTIME') ? (
                          <button
                            onClick={() => router.push('/dashboard/overtime/new')}
                            className="px-4 py-2 bg-brand-primary text-text-on-brand rounded-lg text-xs font-semibold hover:bg-brand-primary-dark transition-colors cursor-pointer"
                          >
                            {t('signUpBtn')}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ) : (
                  paginatedOvertimes.map((overtime) => (
                    <tr
                      key={overtime.id}
                      data-testid="overtime-row"
                      data-overtime-id={overtime.id}
                      data-status={overtime.status}
                      data-date={overtime.date}
                      data-hours={overtime.hours ?? 0}
                      data-ot-type={overtime.otType ?? ''}
                      data-food-allowance={Number(overtime.foodAllowance || 0)}
                      className="hover:bg-surface-page/70 transition-colors group"
                      title={overtime.reason ? `${overtime.reason}` : undefined}
                    >
                      {/* Employee Cell (Admin/HR Only) */}
                      {isAdminOrHR && (
                        <td data-testid="ot-employee-cell" className="ps-4 pe-2 py-3">
                          <div className="flex items-center gap-2.5 min-w-[170px] max-w-[240px]">
                            <div className="w-8 h-8 rounded-full bg-brand-primary-light/20 flex items-center justify-center text-brand-primary font-bold text-xs shrink-0 border border-brand-primary/10">
                              {overtime.employee?.fullName
                                ?.split(' ')
                                .map((n) => n[0])
                                .join('')
                                .slice(0, 2)
                                .toUpperCase() || 'NA'}
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs sm:text-sm font-semibold text-text-heading truncate group-hover:text-brand-primary transition-colors">
                                {overtime.employee?.fullName || 'N/A'}
                              </p>
                              <div className="flex items-center gap-1 text-[11px] text-text-muted mt-0.5 truncate">
                                <span className="font-mono font-medium">{overtime.employee?.employeeCode || ''}</span>
                                {overtime.employee?.department?.name && (
                                  <>
                                    <span>•</span>
                                    <span className="truncate">{overtime.employee.department.name}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      )}

                      {/* Date Cell */}
                      <td className="px-2.5 py-3 whitespace-nowrap">
                        <span className="font-medium text-text-heading text-xs sm:text-sm">
                          {formatWallClockDate(overtime.date)}
                        </span>
                      </td>

                      {/* Time Window Cell */}
                      <td className="px-2.5 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 text-[11px] text-text-body font-mono bg-surface-page px-2 py-0.5 rounded border border-surface-border">
                          <Clock size={11} className="text-text-muted" />
                          {formatWallClockTime(overtime.startTime)} - {formatWallClockTime(overtime.endTime)}
                        </span>
                      </td>

                      {/* Number of Hours Cell */}
                      <td className="px-2 py-3 text-center whitespace-nowrap">
                        <span className="font-bold text-brand-primary text-xs sm:text-sm px-2 py-0.5 rounded bg-brand-primary-light/10">
                          {t('hoursSuffix', { hours: overtime.hours ?? 0 })}
                        </span>
                      </td>

                      {/* OT Type Cell */}
                      <td className="px-2 py-3 text-center whitespace-nowrap">
                        {renderOtTypeBadge(overtime.otType)}
                      </td>

                      {/* Food Allowance Cell */}
                      <td className="px-2 py-3 text-center whitespace-nowrap">
                        {Number(overtime.foodAllowance || 0) > 0 ? (
                          <span className="px-2 py-0.5 rounded-[--radius-badge] bg-brand-accent/15 text-brand-accent text-xs font-bold whitespace-nowrap inline-block">
                            {formatCurrency(Number(overtime.foodAllowance))}
                          </span>
                        ) : (
                          <span className="text-text-muted text-xs">—</span>
                        )}
                      </td>

                      {/* Status Cell */}
                      <td className="px-2 py-3 text-center whitespace-nowrap">
                        <span
                          className={`px-2.5 py-0.5 rounded-[--radius-badge] text-xs font-semibold border whitespace-nowrap inline-block ${
                            statusLabels[overtime.status]?.color ??
                            'bg-surface-page text-text-muted border-surface-border'
                          }`}
                        >
                          {statusLabels[overtime.status]?.label ?? overtime.status}
                        </span>
                      </td>

                      {/* Actions Cell */}
                      <td className="ps-2 pe-4 py-3 text-end whitespace-nowrap">
                        <button
                          data-testid="overtime-details"
                          onClick={() => router.push(`/dashboard/overtime/${overtime.id}`)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-brand-primary hover:bg-brand-primary-light/20 hover:underline transition-all cursor-pointer border border-transparent hover:border-brand-primary/20"
                        >
                          <span>{t('detailsBtn')}</span>
                          <ChevronRight size={13} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          {!loading && totalFiltered > 0 && (
            <Pagination
              testIdPrefix="ot-pg"
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={totalFiltered}
              itemsPerPage={itemsPerPage}
              onPageChange={handlePageChange}
              onItemsPerPageChange={handleItemsPerPageChange}
            />
          )}
        </div>
      </div>
    </ProtectedRoute>
  );
}
