'use client';

import { useEffect, useState } from 'react';
import { Download, Calendar, Clock, TrendingDown, Search } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import attendanceService from '@/services/attendanceService';
import holidayService from '@/services/holidayService';
import { useAuthStore } from '@/store/authStore';
import { useGlobalSearchStore } from '@/store/globalSearchStore';
import * as XLSX from 'xlsx';
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/common/icons/directional';

export function getAttendanceStatus(present: number, late: number, earlyLeave: number, t: (key: string) => string) {
  if (present === 0) return { band: 'none', label: t('noRecords'), cls: 'text-text-muted bg-surface-border-light' };
  if (late > 5 || earlyLeave > 5) return { band: 'risk', label: t('atRisk'), cls: 'text-status-error bg-status-error/10' };
  if (late > 2 || earlyLeave > 2) return { band: 'attention', label: t('needsAttention'), cls: 'text-status-warning bg-status-warning/10' };
  return { band: 'good', label: t('goodStanding'), cls: 'text-status-success bg-status-success/10' };
}

export default function AttendanceReportsPage() {
  const t = useTranslations('reportsPage');
  const tc = useTranslations('common');
  const { user } = useAuthStore();
  const [report, setReport] = useState<any>(null);
  const [statistics, setStatistics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [workingDays, setWorkingDays] = useState(0);
  const [search, setSearch] = useState('');
  const globalQuery = useGlobalSearchStore((s) => s.query);
  const setGlobalQuery = useGlobalSearchStore((s) => s.setQuery);

  // The header search box is shared app-wide; mirror it into this page's
  // own filter so typing there also filters the summary table below.
  useEffect(() => {
    setSearch(globalQuery);
  }, [globalQuery]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setGlobalQuery(value);
  };

  const monthLabel = new Date(year, month - 1).toLocaleString('default', { month: 'long', year: 'numeric' });

  useEffect(() => {
    fetchReport();
  }, [month, year]);

  const fetchReport = async () => {
    if (!user?.employeeId) return;
    try {
      setLoading(true);
      const [reportResponse, statsResponse, workDaysResponse] = await Promise.all([
        attendanceService.getMonthlyReport(month, year),
        attendanceService.getStatistics(month, year),
        // Branch weekly-off + holiday aware, so this matches payroll's denominator.
        holidayService.calculateWorkDays(month, year),
      ]);
      setReport({ data: reportResponse.data, meta: reportResponse.meta });
      setStatistics(statsResponse.data);
      setWorkingDays(workDaysResponse.data?.workDays ?? 0);
    } catch (error) {
      console.error('Failed to fetch report:', error);
    } finally {
      setLoading(false);
    }
  };

  const handlePreviousMonth = () => {
    if (month === 1) { setMonth(12); setYear(year - 1); } else { setMonth(month - 1); }
  };
  const handleNextMonth = () => {
    if (month === 12) { setMonth(1); setYear(year + 1); } else { setMonth(month + 1); }
  };

  const filteredData = (report?.data ?? []).filter((item: any) =>
    item.employee.fullName.toLowerCase().includes(search.toLowerCase()) ||
    (item.employee.department?.name ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const handleExport = () => {
    if (!report?.data) { alert(t('noDataToExport')); return; }
    const rows: any[][] = [[
      '#', tc('employee'), tc('employeeCode'), tc('department'),
      t('colDaysPresent'), t('colAbsentDays'), t('colLateArrivals'), t('colEarlyDepartures'),
      t('colAvgHrsDay'), t('colTotalHoursWorked'), tc('status'),
    ]];
    report.data.forEach((item: any, idx: number) => {
      const present = item.summary.present || 0;
      const absent = Math.max(0, workingDays - present);
      const totalHours = item.summary.totalHours ? Number(item.summary.totalHours) : 0;
      const avgHrs = present > 0 ? (totalHours / present).toFixed(1) : '0.0';
      const status = getAttendanceStatus(present, item.summary.late || 0, item.summary.earlyLeave || 0, t);
      rows.push([
        idx + 1,
        item.employee.fullName,
        item.employee.employeeCode,
        item.employee.department?.name || '--',
        present,
        absent,
        item.summary.late || 0,
        item.summary.earlyLeave || 0,
        avgHrs,
        totalHours.toFixed(1),
        status.label,
      ]);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance Report');
    XLSX.writeFile(wb, `Attendance_Report_${month}_${year}.xlsx`);
  };

  return (
    <div className="space-y-5">
      {/* Controls bar — month nav + export */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-surface-card border border-surface-border rounded-[--radius-button] px-1 py-1">
          <button
            data-testid="attrep-prev-month"
            onClick={handlePreviousMonth}
            className="p-1.5 hover:bg-surface-border-light rounded-[--radius-button] transition-colors text-text-muted"
          >
            <ChevronLeftIcon size={16} />
          </button>
          <span className="px-3 text-sm font-semibold text-text-heading min-w-[120px] text-center">
            {monthLabel}
          </span>
          <button
            data-testid="attrep-next-month"
            onClick={handleNextMonth}
            className="p-1.5 hover:bg-surface-border-light rounded-[--radius-button] transition-colors text-text-muted"
          >
            <ChevronRightIcon size={16} />
          </button>
        </div>
        <button
          data-testid="attrep-export"
          onClick={handleExport}
          className="flex items-center gap-2 px-4 py-2 bg-status-success text-text-on-brand rounded-[--radius-button] hover:bg-status-success/90 transition-colors text-sm font-medium shadow-sm"
        >
          <Download size={16} />
          {t('exportExcel')}
        </button>
      </div>

      {/* Statistics Cards */}
      {statistics && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-status-info-bg/40 rounded-[--radius-input] flex items-center justify-center shrink-0">
                <Calendar className="text-status-info" size={24} />
              </div>
              <div>
                <p className="text-sm text-text-muted">{t('totalCheckIns')}</p>
                <p data-testid="attrep-kpi-checkins" data-value={statistics.totalRecords} className="text-2xl font-bold text-text-heading">{statistics.totalRecords}</p>
                <p className="text-xs text-text-muted mt-0.5">{t('acrossAllEmployees')}</p>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-status-warning-bg/40 rounded-[--radius-input] flex items-center justify-center shrink-0">
                <Clock className="text-status-warning" size={24} />
              </div>
              <div>
                <p className="text-sm text-text-muted">{t('lateArrivalRate')}</p>
                <p data-testid="attrep-kpi-lateRate" data-value={statistics.lateRate} className="text-2xl font-bold text-status-warning">{statistics.lateRate}%</p>
                <p className="text-xs text-text-muted mt-0.5">{t('checkedInAfterStart')}</p>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-status-error/10 rounded-[--radius-input] flex items-center justify-center shrink-0">
                <TrendingDown className="text-status-error" size={24} />
              </div>
              <div>
                <p className="text-sm text-text-muted">{t('earlyDepartureRate')}</p>
                <p data-testid="attrep-kpi-earlyRate" data-value={statistics.earlyLeaveRate} className="text-2xl font-bold text-status-error">{statistics.earlyLeaveRate}%</p>
                <p className="text-xs text-text-muted mt-0.5">{t('leftBeforeShiftEnd')}</p>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-status-success-bg/30 rounded-[--radius-input] flex items-center justify-center shrink-0">
                <Clock className="text-status-success" size={24} />
              </div>
              <div>
                <p className="text-sm text-text-muted">{t('avgWorkHoursPerDay')}</p>
                <p data-testid="attrep-kpi-avgHours" data-value={statistics.avgWorkHours} className="text-2xl font-bold text-status-success">{statistics.avgWorkHours}h</p>
                <p className="text-xs text-text-muted mt-0.5">{t('companyWideAverage')}</p>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Company-wide Report */}
      {(user?.role === 'ADMIN' || user?.role === 'HR_MANAGER') && report && (
        <div data-testid="attrep-summary" className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden">
          <div className="p-6 border-b border-surface-border">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <h3 className="text-lg font-bold text-text-heading">{t('employeeAttendanceSummary')}</h3>
                <p className="text-sm text-text-muted mt-1">
                  {loading
                    ? tc('loading')
                    : <>{filteredData.length} {t('employeeCountSuffix', { count: filteredData.length })} — {monthLabel}</>}
                </p>
              </div>
              <div className="relative">
                <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                <input
                  type="text"
                  placeholder={t('searchPlaceholder')}
                  value={search}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="ps-9 pe-4 py-2 text-sm border border-surface-border rounded-[--radius-input] bg-surface-page text-text-body placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/30 w-64"
                />
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-page border-b border-surface-border">
                <tr>
                  <th className="px-4 py-3 text-center text-xs font-medium text-text-muted uppercase w-10">#</th>
                  <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase">{tc('employee')}</th>
                  <th className="px-6 py-3 text-start text-xs font-medium text-text-muted uppercase">{tc('department')}</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-text-muted uppercase">{t('colDaysPresent')}</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-text-muted uppercase">{t('colAbsentDays')}</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-text-muted uppercase">{t('colLateArrivals')}</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-text-muted uppercase">{t('colEarlyDepartures')}</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-text-muted uppercase">{t('colAvgHrsDay')}</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-text-muted uppercase">{t('colTotalHrsWorked')}</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-text-muted uppercase">{tc('status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {loading ? (
                  [...Array(10)].map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      {[...Array(10)].map((_, j) => (
                        <td key={j} className="px-6 py-4">
                          <div className="h-4 bg-surface-border-light rounded-[--radius-input]" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : filteredData.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-12 text-center text-text-muted">
                      {search ? t('noEmployeesMatch') : t('noDataForPeriod')}
                    </td>
                  </tr>
                ) : (
                  filteredData.map((item: any, index: number) => {
                    const present = item.summary.present || 0;
                    const late = item.summary.late || 0;
                    const earlyLeave = item.summary.earlyLeave || 0;
                    const absent = Math.max(0, workingDays - present);
                    const totalHours = item.summary.totalHours ? Number(item.summary.totalHours) : 0;
                    const avgHrs = present > 0 ? (totalHours / present).toFixed(1) : '0.0';
                    const status = getAttendanceStatus(present, late, earlyLeave, t);
                    return (
                      <motion.tr
                        key={item.employee.id}
                        data-testid={`attrep-row-${item.employee.id}`}
                        data-standing={status.band}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: index * 0.02 }}
                        className="hover:bg-surface-border-light/50 transition-colors"
                      >
                        <td className="px-4 py-4 text-center text-sm text-text-muted">{index + 1}</td>
                        <td className="px-6 py-4">
                          <p className="font-medium text-brand-primary">{item.employee.fullName}</p>
                          <p className="text-xs text-text-muted">{item.employee.employeeCode}</p>
                        </td>
                        <td className="px-6 py-4 text-sm text-text-body">
                          {item.employee.department?.name || '--'}
                        </td>
                        <td className="px-6 py-4 text-center font-medium text-text-body">{present}</td>
                        <td className="px-6 py-4 text-center">
                          <span className={`font-medium ${absent > 0 ? 'text-status-error' : 'text-text-muted'}`}>
                            {absent}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span className={`font-medium ${late > 0 ? 'text-status-warning' : 'text-text-muted'}`}>
                            {late}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span className={`font-medium ${earlyLeave > 0 ? 'text-status-error' : 'text-text-muted'}`}>
                            {earlyLeave}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-center text-sm font-medium text-text-body">{avgHrs}h</td>
                        <td className="px-6 py-4 text-center font-medium text-status-success">
                          {totalHours.toFixed(1)}h
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${status.cls}`}>
                            {status.label}
                          </span>
                        </td>
                      </motion.tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
