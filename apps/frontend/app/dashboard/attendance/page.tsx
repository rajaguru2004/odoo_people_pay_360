'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import AttendanceStatsBar from '@/components/attendance/AttendanceStatsBar';
import AttendanceSearchFilterBar from '@/components/attendance/AttendanceSearchFilterBar';
import AttendanceFilterPanel from '@/components/attendance/AttendanceFilterPanel';
import TodayAttendanceTable from '@/components/attendance/TodayAttendanceTable';
import AttendanceLiveFeed from '@/components/attendance/AttendanceLiveFeed';
import AttendanceInsights from '@/components/attendance/AttendanceInsights';
import AttendanceTrendChart from '@/components/attendance/AttendanceTrendChart';
import AttendanceQuickStats from '@/components/attendance/AttendanceQuickStats';
import DepartmentBreakdownChart from '@/components/attendance/DepartmentBreakdownChart';
import TimePeriodTabs from '@/components/attendance/TimePeriodTabs';
import { FileText, Settings, BarChart2, Download } from 'lucide-react';
import attendanceService from '@/services/attendanceService';
import departmentService from '@/services/departmentService';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { Attendance } from '@/types/attendance';
import { formatDate, formatTime } from '@/utils/formatters';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import * as XLSX from 'xlsx';
import { todayStr } from '@/utils/tzDate';
import { DateTime } from 'luxon';

type Period = 'today' | 'week' | 'month' | 'custom';

interface OverviewStats {
  totalEmployees: number;
  present: number;
  late: number;
  absent: number;
  earlyLeave: number;
  notCheckedOut: number;
  avgWorkHours: number;
  presentRate: number;
  lateRate: number;
  lateUsers?: string[];
  absentUsers?: string[];
  earlyLeaveUsers?: string[];
  notCheckedOutUsers?: string[];
  notCheckedInUsers?: string[];
}

interface DeptBreakdown {
  department: string;
  present: number;
  late: number;
  absent: number;
  total: number;
}

export default function AttendancePage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const t = useTranslations('attendancePage');
  const tc = useTranslations('common');
  // Multi-branch: re-scope overview + list when the active branch changes.
  const selectedBranchId = useBranchStore((s) => s.selectedBranchId);

  const [loading, setLoading] = useState(true);
  const [tableLoading, setTableLoading] = useState(false);

  // Period selection
  const [activePeriod, setActivePeriod] = useState<Period>('today');

  // Date range filters
  // `toISOString()` converts an INSTANT to a UTC date, so
  // `new Date().toISOString().split('T')[0]` answers "today" wrongly for the
  // whole window between local midnight and the UTC offset — 00:00-05:29 at
  // Asia/Kolkata. `todayStr()` resolves the display timezone, which is the day
  // the user (and the attendance record) actually belongs to.
  const [startDateFilter, setStartDateFilter] = useState(() =>
    DateTime.fromISO(todayStr()).minus({ days: 7 }).toISODate() ?? todayStr(),
  );
  const [endDateFilter, setEndDateFilter] = useState(() => todayStr());

  // Overview data (stats, trend, recent check-ins, department breakdown)
  const [stats, setStats] = useState<OverviewStats>({
    totalEmployees: 0,
    present: 0,
    late: 0,
    absent: 0,
    earlyLeave: 0,
    notCheckedOut: 0,
    avgWorkHours: 0,
    presentRate: 0,
    lateRate: 0,
    lateUsers: [],
    absentUsers: [],
    earlyLeaveUsers: [],
    notCheckedOutUsers: [],
    notCheckedInUsers: [],
  });
  const [trendData, setTrendData] = useState<any[]>([]);
  const [recentCheckIns, setRecentCheckIns] = useState<Attendance[]>([]);
  const [deptBreakdown, setDeptBreakdown] = useState<DeptBreakdown[]>([]);

  // Table / list data
  const [attendances, setAttendances] = useState<Attendance[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [unfilteredTotal, setUnfilteredTotal] = useState(0);

  // Departments (for filter dropdown)
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([]);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState(() => todayStr());

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);

  const isAdmin = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';

  // ── Fetch overview data (stats, trend, dept breakdown, recent check-ins) ──────
  const fetchOverview = useCallback(async (period: Period, date: string, startDate?: string, endDate?: string) => {
    try {
      setLoading(true);
      const [overviewRes, deptRes] = await Promise.all([
        attendanceService.getOverview(period, date, startDate, endDate),
        departmentService.getAll(),
      ]);

      const overview = overviewRes.data;
      setStats(overview.stats);
      setTrendData(overview.trendData);
      setRecentCheckIns(overview.recentCheckIns as Attendance[]);
      setDeptBreakdown(overview.departmentBreakdown);
      setDepartments(deptRes.data.map((d: any) => ({ id: d.id, name: d.name })));
    } catch (error) {
      console.error('Failed to fetch attendance overview:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Fetch paginated attendance list (table) ──────────────────────────────────
  const fetchList = useCallback(
    async (
      period: Period,
      page: number,
      perPage: number,
      status: string,
      deptId: string,
      search: string,
      date: string,
      startDate?: string,
      endDate?: string,
    ) => {
      try {
        setTableLoading(true);
        const res = await attendanceService.getAttendanceList({
          period,
          page,
          limit: perPage,
          status: status !== 'all' ? status : undefined,
          departmentId: deptId !== 'all' ? deptId : undefined,
          search: search || undefined,
          date,
          startDate,
          endDate,
        });
        setAttendances(res.data || []);
        setTotalItems(res.meta?.total || 0);
        setUnfilteredTotal(res.meta?.totalUnfiltered ?? res.meta?.total ?? 0);
      } catch (error) {
        console.error('Failed to fetch attendance list:', error);
      } finally {
        setTableLoading(false);
      }
    },
    [],
  );

  // ── Re-fetch overview when period, date or date range changes ──────────────────────────
  useEffect(() => {
    fetchOverview(activePeriod, dateFilter, startDateFilter, endDateFilter);
    // Reset filters and pagination on period change
    setCurrentPage(1);
  }, [activePeriod, dateFilter, startDateFilter, endDateFilter, fetchOverview, selectedBranchId]);

  // ── Re-fetch list when any filter / pagination changes ───────────────────────
  useEffect(() => {
    fetchList(
      activePeriod,
      currentPage,
      itemsPerPage,
      statusFilter,
      departmentFilter,
      searchTerm,
      dateFilter,
      startDateFilter,
      endDateFilter,
    );
  }, [
    activePeriod,
    currentPage,
    itemsPerPage,
    statusFilter,
    departmentFilter,
    searchTerm,
    dateFilter,
    startDateFilter,
    endDateFilter,
    fetchList,
    selectedBranchId,
  ]);

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handlePeriodChange = (period: Period) => {
    setActivePeriod(period);
    setCurrentPage(1);
    setSearchTerm('');
    setDepartmentFilter('all');
    setStatusFilter('all');
  };

  const handleClearFilters = () => {
    setDepartmentFilter('all');
    setStatusFilter('all');
    setSearchTerm('');
    setCurrentPage(1);
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleItemsPerPageChange = (newItemsPerPage: number) => {
    setItemsPerPage(newItemsPerPage);
    setCurrentPage(1);
  };

  const handleExport = async () => {
    try {
      const res = await attendanceService.getAttendanceList({
        period: activePeriod,
        page: 1,
        limit: 10000,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        departmentId: departmentFilter !== 'all' ? departmentFilter : undefined,
        search: searchTerm || undefined,
        date: dateFilter,
        startDate: startDateFilter,
        endDate: endDateFilter,
      });
      
      const recordsToExport = res.data || [];
      if (recordsToExport.length === 0) {
        alert(t('noDataToExport'));
        return;
      }

      const exportData: any[] = [];

      // Header row
      exportData.push([
        t('colDate'),
        t('colEmployee'),
        t('colEmployeeCode'),
        t('colDepartment'),
        t('colStatus'),
        t('colCheckIn'),
        t('colCheckOut'),
        t('colWorkHours'),
        t('colLate'),
        t('colEarlyLeave')
      ]);

      // Data rows
      recordsToExport.forEach((item: any) => {
        exportData.push([
          formatDate(item.date),
          item.employee?.fullName,
          item.employee?.employeeCode,
          item.employee?.department?.name || '--',
          item.status,
          item.checkIn ? formatTime(item.checkIn) : '--:--',
          item.checkOut ? formatTime(item.checkOut) : '--:--',
          item.workHours ? Number(item.workHours).toFixed(1) : '0.0',
          item.isLate ? tc('yes') : tc('no'),
          item.isEarlyLeave ? tc('yes') : tc('no')
        ]);
      });

      const worksheet = XLSX.utils.aoa_to_sheet(exportData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Attendance Overview');
      
      const fileName = activePeriod === 'today'
        ? `Attendance_Overview_${dateFilter}.xlsx`
        : activePeriod === 'custom'
        ? `Attendance_Overview_${startDateFilter}_to_${endDateFilter}.xlsx`
        : `Attendance_Overview_${activePeriod}.xlsx`;
      XLSX.writeFile(workbook, fileName);
    } catch (error) {
      console.error('Export failed:', error);
      alert(t('failedExport'));
    }
  };

  const handleViewDetail = (attendance: Attendance) => {
    router.push(`/dashboard/attendance/detail/${attendance.id}`);
  };

  const activeFilterCount = [departmentFilter !== 'all', statusFilter !== 'all', searchTerm !== ''].filter(Boolean).length;

  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_ATTENDANCE">
      <>
        <div className="space-y-6">

          {/* ── Top Bar: Period tabs + action buttons (scrolls normally) ─────── */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <TimePeriodTabs activePeriod={activePeriod} onPeriodChange={handlePeriodChange} />
            <div className="flex items-center gap-2">
              <button
                data-testid="att-nav-reports"
                onClick={() => router.push('/dashboard/attendance/reports')}
                className="flex items-center gap-2 px-4 py-2.5 bg-surface-card border border-surface-border text-text-body rounded-xl hover:bg-surface-page font-medium text-sm transition-all"
              >
                <BarChart2 size={16} />
                {t('reports')}
              </button>
              <button
                data-testid="att-export"
                onClick={handleExport}
                className="flex items-center gap-2 px-4 py-2.5 bg-brand-primary text-white rounded-xl hover:bg-brand-primary-dark font-semibold text-sm transition-all shadow-lg shadow-brand-primary/30"
              >
                <Download size={16} />
                Export
              </button>
            </div>
          </div>

          {/* ── Sticky slim bar: search + date + department only ─────────────── */}
          <div className="sticky top-0 z-20 py-3">
            <AttendanceSearchFilterBar
              searchTerm={searchTerm}
              onSearchChange={(v) => { setSearchTerm(v); setCurrentPage(1); }}
              departmentFilter={departmentFilter}
              onDepartmentChange={(v) => { setDepartmentFilter(v); setCurrentPage(1); }}
              dateFilter={dateFilter}
              onDateChange={setDateFilter}
              startDateFilter={startDateFilter}
              onStartDateChange={(v) => { setStartDateFilter(v); setCurrentPage(1); }}
              endDateFilter={endDateFilter}
              onEndDateChange={(v) => { setEndDateFilter(v); setCurrentPage(1); }}
              departments={departments}
              activePeriod={activePeriod}
            />
          </div>

          {/* ── Status chips + result count (scrolls normally) ────────────────── */}
          <AttendanceFilterPanel
            statusFilter={statusFilter}
            onStatusChange={(v) => { setStatusFilter(v); setCurrentPage(1); }}
            activeFilterCount={activeFilterCount}
            onClearFilters={handleClearFilters}
            resultCount={totalItems}
            totalCount={unfilteredTotal}
            period={activePeriod}
          />

          {/* ── Stats Bar ─────────────────────────────────────────────────── */}
          <AttendanceStatsBar
            totalEmployees={stats.totalEmployees}
            present={stats.present}
            late={stats.late}
            absent={stats.absent}
            pendingCorrections={0}
            loading={loading}
            period={activePeriod}
            onViewCorrections={() => router.push('/dashboard/attendance/corrections')}
          />

          {/* ── Analytics Row: Trend + Quick Stats + Live Feed ──────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5">
              <AttendanceTrendChart data={trendData} loading={loading} period={activePeriod} />
            </div>
            <div className="lg:col-span-3">
              <AttendanceQuickStats
                totalEmployees={stats.totalEmployees}
                present={stats.present}
                late={stats.late}
                absent={stats.absent}
                notCheckedOut={stats.notCheckedOut}
                earlyLeave={stats.earlyLeave}
                avgWorkHours={stats.avgWorkHours}
                loading={loading}
                period={activePeriod}
                dateFilter={dateFilter}
              />
            </div>
            <div className="lg:col-span-4">
              <AttendanceLiveFeed
                recentCheckIns={recentCheckIns}
                loading={loading}
                period={activePeriod}
                dateFilter={dateFilter}
              />
            </div>
          </div>

          {/* ── Department Breakdown Chart ─────────────────────────────── */}
          <DepartmentBreakdownChart
            data={deptBreakdown}
            loading={loading}
            period={activePeriod}
            dateFilter={dateFilter}
          />

          {/* ── Attendance Table ──────────────────────────────────────────── */}
          <TodayAttendanceTable
            attendances={attendances}
            loading={tableLoading}
            onViewDetail={handleViewDetail}
            onManualCheckIn={isAdmin ? undefined : undefined}
            currentPage={currentPage}
            itemsPerPage={itemsPerPage}
            totalItems={totalItems}
            onPageChange={handlePageChange}
            onItemsPerPageChange={handleItemsPerPageChange}
            period={activePeriod}
            dateFilter={dateFilter}
          />

          {/* ── HR Insights ───────────────────────────────────────────────── */}
          <AttendanceInsights
            totalEmployees={stats.totalEmployees}
            present={stats.present}
            late={stats.late}
            absent={stats.absent}
            notCheckedOut={stats.notCheckedOut}
            earlyLeave={stats.earlyLeave}
            avgWorkHours={stats.avgWorkHours}
            period={activePeriod}
            lateUsers={stats.lateUsers}
            absentUsers={stats.absentUsers}
            earlyLeaveUsers={stats.earlyLeaveUsers}
            notCheckedOutUsers={stats.notCheckedOutUsers}
            notCheckedInUsers={stats.notCheckedInUsers}
          />

          {/* ── Quick Navigation Cards ────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <button
              data-testid="att-nav-history"
              onClick={() => router.push('/dashboard/attendance/history')}
              className="bg-surface-card rounded-xl p-5 border border-surface-border hover:border-brand-primary/30 hover:shadow-md transition-all text-start group"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 bg-brand-primary-light rounded-lg flex items-center justify-center group-hover:bg-brand-primary-light/50 transition-colors">
                  <FileText size={20} className="text-brand-primary" strokeWidth={2} />
                </div>
                <h3 className="font-semibold text-text-heading">{t('historyTitle')}</h3>
              </div>
              <p className="text-sm text-text-muted">{t('historyDesc')}</p>
            </button>

            <button
              data-testid="att-nav-corrections"
              onClick={() => router.push('/dashboard/attendance/corrections')}
              className="bg-surface-card rounded-xl p-5 border border-surface-border hover:border-status-warning/30 hover:shadow-md transition-all text-start group"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 bg-status-warning-bg rounded-lg flex items-center justify-center group-hover:bg-status-warning-bg/50 transition-colors">
                  <Settings size={20} className="text-status-warning" strokeWidth={2} />
                </div>
                <h3 className="font-semibold text-text-heading">{t('correctionTitle')}</h3>
              </div>
              <p className="text-sm text-text-muted">{t('correctionDesc')}</p>
            </button>

            <button
              onClick={() => router.push('/dashboard/attendance/reports')}
              className="bg-surface-card rounded-xl p-5 border border-surface-border hover:border-status-success/30 hover:shadow-md transition-all text-start group"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 bg-status-success-bg rounded-lg flex items-center justify-center group-hover:bg-status-success-bg/50 transition-colors">
                  <BarChart2 size={20} className="text-status-success" strokeWidth={2} />
                </div>
                <h3 className="font-semibold text-text-heading">{t('reportsTitle')}</h3>
              </div>
              <p className="text-sm text-text-muted">{t('reportsDesc')}</p>
            </button>
          </div>

        </div>
      </>
    </ProtectedRoute>
  );
}
