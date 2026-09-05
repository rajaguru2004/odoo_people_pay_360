'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CalendarDays, Search, Download, Clock, X, LogIn, LogOut, Timer, Layers } from 'lucide-react';
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/common/icons/directional';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import { motion, AnimatePresence } from 'framer-motion';
import attendanceService from '@/services/attendanceService';
import systemSettingsService from '@/services/systemSettingsService';
import holidayService from '@/services/holidayService';
import { useBranchStore } from '@/store/branchStore';
import { formatTime } from '@/utils/formatters';
import { format, isFuture, isSameDay, getDaysInMonth, differenceInMinutes } from 'date-fns';
import * as XLSX from 'xlsx';

interface AttendanceSession {
  checkIn: string | Date;
  checkOut?: string | Date | null;
  type?: string;
}

interface SelectedSessionCell {
  sessions: AttendanceSession[];
  employeeName: string;
  date: Date;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default function CompanyAttendanceHistoryPage() {
  const router = useRouter();
  const t = useTranslations('historyPage');
  const tc = useTranslations('common');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [reportData, setReportData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [searchQuery, setSearchQuery] = useState('');
  const [weeklyHolidays, setWeeklyHolidays] = useState<number[]>([0]); // Default Sunday only
  const [holidayMap, setHolidayMap] = useState<Record<string, string>>({}); // 'YYYY-MM-DD' -> holiday name
  const [selectedSessionCell, setSelectedSessionCell] = useState<SelectedSessionCell | null>(null);
  const selectedBranchId = useBranchStore((s) => s.selectedBranchId);

  useEffect(() => {
    fetchMonthlyReport();
  }, [month, year]);

  useEffect(() => {
    fetchWeeklyHolidays();
  }, []);

  // Declared holidays (company-wide + the selected branch) for the shown year.
  useEffect(() => {
    fetchHolidays();
  }, [year, selectedBranchId]);

  const fetchWeeklyHolidays = async () => {
    try {
      const res = await systemSettingsService.getPublic();
      if (res?.success && res.data?.calendar_weekly_holidays) {
        const parsed = res.data.calendar_weekly_holidays.split(',').map(Number);
        setWeeklyHolidays(parsed);
      }
    } catch (error) {
      console.error('Failed to load weekly holidays setting:', error);
    }
  };

  const fetchHolidays = async () => {
    try {
      const res = await holidayService.getAll({
        year,
        branchId: selectedBranchId || undefined,
      });
      const map: Record<string, string> = {};
      (res?.data || []).forEach((h: any) => {
        map[String(h.date).slice(0, 10)] = h.name;
      });
      setHolidayMap(map);
    } catch (error) {
      console.error('Failed to load holidays:', error);
    }
  };

  const fetchMonthlyReport = async () => {
    try {
      setLoading(true);
      const response = await attendanceService.getMonthlyReport(month, year);
      setReportData((response.data as any) || []);
    } catch (error) {
      console.error('Failed to fetch monthly report:', error);
    } finally {
      setLoading(false);
    }
  };

  const handlePreviousMonth = () => {
    if (month === 1) {
      setMonth(12);
      setYear(year - 1);
    } else {
      setMonth(month - 1);
    }
  };

  const handleNextMonth = () => {
    if (month === 12) {
      setMonth(1);
      setYear(year + 1);
    } else {
      setMonth(month + 1);
    }
  };

  const daysInMonth = getDaysInMonth(new Date(year, month - 1));
  const daysArray = Array.from({ length: daysInMonth }, (_, i) => {
    const date = new Date(year, month - 1, i + 1);
    const dayOfWeek = date.getDay();
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
    const holidayName = holidayMap[dateStr];
    return {
      date,
      dayNumber: i + 1,
      isWeekend: weeklyHolidays.includes(dayOfWeek),
      isHoliday: !!holidayName,
      holidayName,
      isFuture: isFuture(date) && !isSameDay(date, new Date()),
      isToday: isSameDay(date, new Date()),
    };
  });

  const filteredData = useMemo(() => {
    if (!searchQuery) return reportData;
    const lowerQuery = searchQuery.toLowerCase();
    return reportData.filter((empRecord) => 
      empRecord.employee?.fullName?.toLowerCase().includes(lowerQuery) ||
      empRecord.employee?.employeeCode?.toLowerCase().includes(lowerQuery) ||
      empRecord.employee?.department?.name?.toLowerCase().includes(lowerQuery)
    );
  }, [reportData, searchQuery]);

  const getCellStatus = (record: any, day: any) => {
    // A declared holiday (company-wide or branch) shows as HOLIDAY unless the
    // employee actually worked that day. Takes precedence over weekend shading.
    if (day.isHoliday && (!record || record.status === 'ABSENT' || record.status === 'HOLIDAY')) {
      return { type: 'HOLIDAY', label: tc('holiday'), holidayName: day.holidayName };
    }

    // Override historical ABSENT records on weekends
    if (day.isWeekend && (!record || record.status === 'ABSENT')) {
      return { type: 'WEEKEND', label: tc('weekend') };
    }

    if (!record) {
      if (day.isFuture) return { type: 'FUTURE', label: '' };
      return { type: 'NO_RECORD', label: '-' };
    }

    if (record.status === 'ABSENT') return { type: 'ABSENT', label: tc('absent') };
    if (record.status === 'LEAVE') return { type: 'LEAVE', label: tc('leave') };
    if (record.status === 'HOLIDAY') return { type: 'HOLIDAY', label: tc('holiday') };
    if (record.status === 'MISSED_CHECKOUT') return { type: 'MISSED_CHECKOUT', label: t('missedCheckout'), record };

    return { type: 'PRESENT', record };
  };

  const getCellClassName = (type: string, isWeekend: boolean, isToday: boolean) => {
    let base = "min-w-[120px] p-2 border-e border-b border-surface-border text-center relative transition-colors ";
    if (isToday) base += "bg-brand-primary-light/10 ";
    else if (isWeekend) base += "bg-surface-page ";

    switch (type) {
      case 'ABSENT': return base + "text-status-error font-medium bg-status-error-bg/40";
      case 'MISSED_CHECKOUT': return base + "text-status-error font-medium bg-status-error-bg/20";
      case 'LEAVE': return base + "text-status-warning font-medium bg-status-warning-bg/40";
      case 'HOLIDAY': return base + "text-brand-primary font-medium bg-brand-primary-light/20";
      case 'NO_RECORD': return base + "text-text-muted";
      case 'FUTURE': return base + "text-transparent";
      default: return base;
    }
  };

  const handleExport = () => {
    const exportData: any[] = [];
    
    // Header row
    const headerRow = [tc('employee'), tc('employeeCode'), tc('department')];
    daysArray.forEach(day => {
      headerRow.push(format(day.date, 'MMM dd (EEE)'));
    });
    headerRow.push(tc('present'), tc('absent'), t('colLateEarly'), tc('hours'), t('colEarlyIn'), t('colLateOut'));
    exportData.push(headerRow);

    // Data rows
    filteredData.forEach(empData => {
      const row = [
        empData.employee.fullName,
        empData.employee.employeeCode,
        empData.employee.department?.name || tc('notAvailable')
      ];

      daysArray.forEach(day => {
        const record = empData.attendances.find((a: any) => {
          const d = new Date(a.date);
          return d.getUTCDate() === day.dayNumber;
        });
        
        const cellInfo = getCellStatus(record, day);
        
        if (cellInfo.type === 'PRESENT') {
           const inTime = cellInfo.record.checkIn ? formatTime(cellInfo.record.checkIn) : '--:--';
           const outTime = cellInfo.record.checkOut ? formatTime(cellInfo.record.checkOut) : '--:--';
           row.push(`${inTime} - ${outTime}`);
        } else {
           row.push(cellInfo.label || '');
        }
      });

      row.push(
        empData.summary.present,
        empData.attendances.filter((a: any) => a.status === 'ABSENT').length,
        (empData.summary.late || 0) + (empData.summary.earlyLeave || 0),
        Number(empData.summary.totalHours).toFixed(1),
        empData.summary.earlyCheckIn || 0,
        empData.summary.lateCheckout || 0
      );

      exportData.push(row);
    });

    const worksheet = XLSX.utils.aoa_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Attendance History');
    
    XLSX.writeFile(workbook, `Attendance_Log_${format(new Date(year, month - 1), 'MMMM_yyyy')}.xlsx`);
  };

  return (
    <div className="space-y-6">
      {/* Back navigation + export action. The title/description live in the
          sticky TopHeader (declared via usePageHeader above) — repeating them
          here is what made the page render its heading twice. */}
      <PageActionRow
        onBack={() => router.back()}
        action={
          <button
            data-testid="attlog-export"
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 bg-surface-card border border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-border-light font-medium transition-colors shadow-sm">
            <Download size={18} className="text-brand-primary" />
            <span>{tc('export')}</span>
          </button>
        }
      />

      {/* Controls & Search */}
      <div className="bg-surface-card rounded-[--radius-card] p-4 border border-surface-border shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center justify-between gap-2 bg-surface-page p-1.5 rounded-[--radius-input] border border-surface-border">
          <button
            data-testid="attlog-prev-month"
            onClick={handlePreviousMonth}
            className="p-2 hover:bg-surface-card hover:shadow-sm rounded-[--radius-button] transition-all text-text-body"
          >
            <ChevronLeftIcon size={18} />
          </button>
          <div className="flex items-center gap-2 px-4">
            <CalendarDays className="text-brand-primary" size={20} />
            <h2
              data-testid="attlog-month"
              data-month={month}
              data-year={year}
              className="text-base font-bold text-text-heading w-32 text-center"
            >
              {format(new Date(year, month - 1), 'MMMM yyyy')}
            </h2>
          </div>
          <button
            data-testid="attlog-next-month"
            onClick={handleNextMonth}
            className="p-2 hover:bg-surface-card hover:shadow-sm rounded-[--radius-button] transition-all text-text-body"
            disabled={month === new Date().getMonth() + 1 && year === new Date().getFullYear()}
          >
            <ChevronRightIcon size={18} />
          </button>
        </div>

        <div className="relative flex-1 max-w-md">
          <div className="absolute inset-y-0 start-0 ps-3 flex items-center pointer-events-none">
            <Search size={18} className="text-text-muted" />
          </div>
          <input
            type="text"
            className="block w-full ps-10 pe-3 py-2 border border-surface-border rounded-[--radius-input] leading-5 bg-surface-page placeholder-text-muted text-text-body focus:outline-none focus:bg-surface-card focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary sm:text-sm transition-colors"
            placeholder={t('searchPlaceholder')}
            value={searchQuery}
            data-testid="attlog-search"
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Company Grid */}
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-sm overflow-hidden flex flex-col">
        <div className="overflow-auto w-full max-h-[calc(100vh-320px)] pb-4 scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent">
          <table className="w-full text-start border-collapse min-w-max">
            <thead>
              <tr>
                {/* Frozen Employee Column */}
                <th className="sticky start-0 top-0 z-30 bg-surface-page px-4 py-3 border-b border-e border-surface-border min-w-[280px] shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                  <span className="text-xs font-bold text-text-muted uppercase tracking-wider">{tc('employee')}</span>
                </th>

                {/* Day Columns */}
                {daysArray.map((day) => (
                  <th
                    key={day.dayNumber}
                    title={day.isHoliday ? day.holidayName : undefined}
                    className={`sticky top-0 z-20 px-2 py-3 border-b border-e border-surface-border text-center min-w-[120px] ${day.isHoliday ? 'bg-brand-primary-light/30' : day.isWeekend ? 'bg-surface-border-light' : 'bg-surface-page'}`}
                  >
                    <div className="flex flex-col items-center">
                      <span className={`text-xs font-bold ${day.isToday ? 'text-brand-primary' : day.isHoliday ? 'text-brand-primary' : 'text-text-body'}`}>
                        {format(day.date, 'MMM dd')}
                      </span>
                      <span className={`text-[10px] font-medium mt-0.5 ${day.isHoliday ? 'text-brand-primary' : 'text-text-muted'}`}>
                        {day.isHoliday ? tc('holiday') : format(day.date, 'EEE')}
                      </span>
                    </div>
                  </th>
                ))}

                {/* Summary Column */}
                <th className="sticky end-0 top-0 z-30 bg-surface-page px-4 py-3 border-b border-s border-surface-border min-w-[200px] shadow-[-2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                  <span className="text-xs font-bold text-text-muted uppercase tracking-wider">{t('summary')}</span>
                </th>
              </tr>
            </thead>

            <tbody className="bg-surface-card">
              {loading ? (
                [...Array(10)].map((_, i) => (
                  <tr key={i} className="animate-pulse border-b border-surface-border">
                    <td className="sticky start-0 z-10 bg-surface-card px-4 py-3 border-e border-surface-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                      <div className="flex flex-col gap-2"><div className="h-4 bg-surface-border-light rounded-[--radius-input] w-32"></div><div className="h-3 bg-surface-border-light rounded-[--radius-input] w-20"></div></div>
                    </td>
                    {daysArray.map((d) => (
                      <td key={d.dayNumber} className="p-2 border-e border-surface-border">
                        <div className="h-8 bg-surface-page rounded-[--radius-input] w-full"></div>
                      </td>
                    ))}
                    <td className="sticky end-0 z-10 bg-surface-card px-4 py-3 border-s border-surface-border shadow-[-2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                       <div className="h-8 bg-surface-border-light rounded-[--radius-input] w-full"></div>
                    </td>
                  </tr>
                ))
              ) : filteredData.length === 0 ? (
                <tr>
                  <td colSpan={daysArray.length + 2} className="px-6 py-20 text-center">
                    <div className="flex flex-col items-center justify-center text-text-muted">
                      <CalendarDays size={48} className="mb-4 opacity-30 text-brand-primary" />
                      <p data-testid="attlog-empty" className="text-lg font-medium text-text-body">{t('noData')}</p>
                      <p className="text-sm mt-1 text-text-muted">{t('noDataDesc')}</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredData.map((empData, index) => (
                  <motion.tr 
                    key={empData.employee.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: index * 0.02 }}
                    data-testid={`attlog-row-${empData.employee.id}`}
                    className="group hover:bg-surface-border-light/50 transition-colors"
                  >
                    {/* Employee Info (Frozen Left) */}
                    <td className="sticky start-0 z-10 bg-surface-card group-hover:bg-surface-border-light px-4 py-3 border-b border-e border-surface-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)] transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-brand-primary text-text-on-brand flex items-center justify-center font-bold text-sm shadow-sm flex-shrink-0">
                          {empData.employee.fullName.charAt(0)}
                        </div>
                        <div className="flex flex-col overflow-hidden">
                          <span className="text-sm font-bold text-text-heading truncate" title={empData.employee.fullName}>
                            {empData.employee.fullName}
                          </span>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-xs font-medium text-text-muted">{empData.employee.employeeCode}</span>
                            <span className="w-1 h-1 rounded-full bg-surface-border"></span>
                            <span className="text-[11px] font-medium text-brand-primary truncate bg-brand-primary-light/20 px-1.5 py-0.5 rounded-[--radius-badge]">
                              {empData.employee.department?.name || tc('notAvailable')}
                            </span>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Daily Cells */}
                    {daysArray.map((day) => {
                      const record = empData.attendances.find((a: any) => {
                        const d = new Date(a.date);
                        return d.getUTCDate() === day.dayNumber;
                      });

                      const cellInfo = getCellStatus(record, day);
                      const className = getCellClassName(cellInfo.type, day.isWeekend, day.isToday);

                      const sessions: AttendanceSession[] = cellInfo.record?.sessions
                        ? (cellInfo.record.sessions as AttendanceSession[])
                        : cellInfo.record
                          ? [{ checkIn: cellInfo.record.checkIn, checkOut: cellInfo.record.checkOut }]
                          : [];
                      const hasMultipleSessions = sessions.length > 1;

                      return (
                        <td
                          key={day.dayNumber}
                          data-testid={`attlog-cell-${empData.employee.id}-${day.dayNumber}`}
                          data-cell-status={cellInfo.type}
                          data-sessions={sessions.length}
                          data-weekend={day.isWeekend}
                          data-holiday={day.isHoliday}
                          className={`${className} ${hasMultipleSessions ? 'cursor-pointer hover:brightness-95' : ''}`}
                          onClick={hasMultipleSessions ? () => setSelectedSessionCell({
                            sessions,
                            employeeName: empData.employee.fullName,
                            date: day.date,
                          }) : undefined}
                        >
                          {cellInfo.type === 'PRESENT' ? (
                            <div className="flex flex-col items-center justify-center gap-1 w-full h-full">
                              <div className="flex items-center gap-1.5">
                                <span className={`text-xs font-semibold ${cellInfo.record.isLate ? 'text-status-error' : cellInfo.record.isEarlyCheckIn ? 'text-status-success font-bold' : 'text-status-success'}`}>
                                  {cellInfo.record.checkIn ? formatTime(cellInfo.record.checkIn) : '--:--'}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className={`text-xs font-semibold ${cellInfo.record.isEarlyLeave ? 'text-status-warning' : cellInfo.record.isLateCheckout ? 'text-status-info font-bold' : 'text-text-muted'}`}>
                                  {cellInfo.record.checkOut ? formatTime(cellInfo.record.checkOut) : '--:--'}
                                </span>
                              </div>
                              {/* Small indicator dots for late/early/positive check-ins/outs */}
                              {(cellInfo.record.isLate || cellInfo.record.isEarlyLeave || cellInfo.record.isEarlyCheckIn || cellInfo.record.isLateCheckout) && (
                                <div className="absolute top-1 end-1 flex gap-0.5">
                                  {cellInfo.record.isEarlyCheckIn && <div className="w-1.5 h-1.5 rounded-full bg-status-success" title={tc('earlyArrival')}></div>}
                                  {cellInfo.record.isLate && <div className="w-1.5 h-1.5 rounded-full bg-status-error" title={tc('lateArrival')}></div>}
                                  {cellInfo.record.isEarlyLeave && <div className="w-1.5 h-1.5 rounded-full bg-status-warning" title="Early Departure"></div>}
                                  {cellInfo.record.isLateCheckout && <div className="w-1.5 h-1.5 rounded-full bg-status-info" title={t('extraHoursLateCheckout')}></div>}
                                </div>
                              )}
                              {/* Multiple sessions badge */}
                              {hasMultipleSessions && (
                                <div
                                  className="absolute bottom-1 end-1 flex items-center gap-0.5 bg-brand-primary text-text-on-brand rounded-full px-1.5 py-0.5 text-[9px] font-bold shadow-sm leading-none"
                                  title={`${sessions.length} ${t('sessionsClickView')}`}
                                >
                                  <Layers size={8} />
                                  <span>{sessions.length}</span>
                                </div>
                              )}
                            </div>
                          ) : cellInfo.type === 'MISSED_CHECKOUT' ? (
                            <div className="flex flex-col items-center justify-center gap-1 w-full h-full">
                              <span className="text-xs font-semibold text-status-success">
                                {cellInfo.record?.checkIn ? formatTime(cellInfo.record.checkIn) : '--:--'}
                              </span>
                              <span className="inline-flex items-center px-1.5 py-0.5 bg-status-error-bg text-status-error rounded text-[10px] font-semibold leading-tight border border-status-error/20">
                                {tc('missed')}
                              </span>
                              {hasMultipleSessions && (
                                <div
                                  className="absolute bottom-1 end-1 flex items-center gap-0.5 bg-brand-primary text-text-on-brand rounded-full px-1.5 py-0.5 text-[9px] font-bold shadow-sm leading-none"
                                  title={`${sessions.length} ${t('sessionsClickView')}`}
                                >
                                  <Layers size={8} />
                                  <span>{sessions.length}</span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div
                              className="flex items-center justify-center h-full text-xs"
                              title={(cellInfo as any).holidayName || undefined}
                            >
                              {cellInfo.label}
                            </div>
                          )}
                        </td>
                      );
                    })}

                    {/* Monthly Summary (Frozen Right) */}
                    <td className="sticky end-0 z-10 bg-surface-card group-hover:bg-surface-border-light px-4 py-3 border-b border-s border-surface-border shadow-[-2px_0_5px_-2px_rgba(0,0,0,0.05)] transition-colors">
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-xs">
                        <div className="flex justify-between items-center bg-status-success-bg/40 px-1.5 py-1 rounded-[--radius-badge] gap-1">
                          <span className="text-status-success font-medium text-[10px] truncate">{tc('present')}</span>
                          <span className="font-bold text-status-success">{empData.summary.present}</span>
                        </div>
                        <div className="flex justify-between items-center bg-status-error-bg/40 px-1.5 py-1 rounded-[--radius-badge] gap-1">
                          <span className="text-status-error font-medium text-[10px] truncate">{tc('absent')}</span>
                          <span className="font-bold text-status-error">
                            {empData.attendances.filter((a: any) => a.status === 'ABSENT').length}
                          </span>
                        </div>
                        <div className="flex justify-between items-center bg-status-warning-bg/40 px-1.5 py-1 rounded-[--radius-badge] gap-1" title={t('lateEarlyDays')}>
                          <span className="text-status-warning font-medium text-[10px] truncate">{t('colLateEarly')}</span>
                          <span className="font-bold text-status-warning">
                            {(empData.summary.late || 0) + (empData.summary.earlyLeave || 0)}
                          </span>
                        </div>
                        <div className="flex justify-between items-center bg-brand-primary-light/20 px-1.5 py-1 rounded-[--radius-badge] gap-1">
                          <span className="text-brand-primary font-medium text-[10px] truncate">{tc('hours')}</span>
                          <span className="font-bold text-brand-primary">{Number(empData.summary.totalHours).toFixed(1)}</span>
                        </div>
                        <div className="flex justify-between items-center bg-status-success-bg/30 px-1.5 py-1 rounded-[--radius-badge] gap-1" title={t('earlyArrivalCount')}>
                          <span className="text-status-success font-medium text-[10px] truncate">{t('colEarlyIn')}</span>
                          <span className="font-bold text-status-success">{empData.summary.earlyCheckIn || 0}</span>
                        </div>
                        <div className="flex justify-between items-center bg-status-info-bg/40 px-1.5 py-1 rounded-[--radius-badge] gap-1" title={t('extraHoursLateCheckoutCount')}>
                          <span className="text-status-info font-medium text-[10px] truncate">{t('colLateOut')}</span>
                          <span className="font-bold text-status-info">{empData.summary.lateCheckout || 0}</span>
                        </div>
                      </div>
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sessions Popup */}
      <AnimatePresence>
        {selectedSessionCell && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => setSelectedSessionCell(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.15 }}
              data-testid="attlog-sessions-modal"
              data-count={selectedSessionCell.sessions.length}
              className="bg-surface-card rounded-[--radius-card] border border-surface-border shadow-2xl w-full max-w-sm overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-surface-border bg-surface-page">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <Layers size={15} className="text-brand-primary" />
                    <span className="text-xs font-bold text-brand-primary uppercase tracking-wider">
                      {selectedSessionCell.sessions.length} Sessions
                    </span>
                  </div>
                  <h3 className="text-base font-bold text-text-heading leading-tight">
                    {selectedSessionCell.employeeName}
                  </h3>
                  <p className="text-xs text-text-muted mt-0.5">
                    {format(selectedSessionCell.date, 'EEEE, MMMM d, yyyy')}
                  </p>
                </div>
                <button
                  data-testid="attlog-sessions-close"
                  onClick={() => setSelectedSessionCell(null)}
                  className="p-1.5 rounded-[--radius-button] hover:bg-surface-border-light text-text-muted hover:text-text-heading transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Sessions list */}
              <div className="px-5 py-4 space-y-3 max-h-80 overflow-y-auto">
                {selectedSessionCell.sessions.map((session, idx) => {
                  const checkInDate = session.checkIn ? new Date(session.checkIn) : null;
                  const checkOutDate = session.checkOut ? new Date(session.checkOut) : null;
                  const durationMins = checkInDate && checkOutDate
                    ? differenceInMinutes(checkOutDate, checkInDate)
                    : null;

                  return (
                    <div
                      key={idx}
                      className="flex items-start gap-3 p-3 rounded-[--radius-input] bg-surface-page border border-surface-border"
                    >
                      {/* Session number */}
                      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-primary/10 border border-brand-primary/20 flex items-center justify-center">
                        <span className="text-[11px] font-bold text-brand-primary">{idx + 1}</span>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <span className="text-xs font-semibold text-text-body">
                            {session.type === 'LUNCH' ? 'Lunch Break' : `Session ${idx + 1}`}
                          </span>
                          {durationMins !== null && durationMins > 0 && (
                            <span className="flex items-center gap-1 text-[10px] font-medium text-text-muted bg-surface-border px-1.5 py-0.5 rounded-[--radius-badge]">
                              <Timer size={9} />
                              {formatDuration(durationMins)}
                            </span>
                          )}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div className="flex items-center gap-1.5">
                            <LogIn size={12} className="text-status-success flex-shrink-0" />
                            <div>
                              <div className="text-[10px] text-text-muted leading-none mb-0.5">{tc('checkIn')}</div>
                              <div className={`text-xs font-semibold ${checkInDate ? 'text-status-success' : 'text-text-muted'}`}>
                                {checkInDate ? formatTime(session.checkIn as string) : '--:--'}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <LogOut size={12} className={`flex-shrink-0 ${checkOutDate ? 'text-text-muted' : 'text-status-error'}`} />
                            <div>
                              <div className="text-[10px] text-text-muted leading-none mb-0.5">{tc('checkOut')}</div>
                              <div className={`text-xs font-semibold ${checkOutDate ? 'text-text-muted' : 'text-status-error'}`}>
                                {checkOutDate ? formatTime(session.checkOut as string) : tc('missed')}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Footer — total hours */}
              {(() => {
                const totalMins = selectedSessionCell.sessions.reduce((acc, s) => {
                  if (!s.checkIn || !s.checkOut) return acc;
                  const diff = differenceInMinutes(new Date(s.checkOut), new Date(s.checkIn));
                  return acc + (diff > 0 ? diff : 0);
                }, 0);
                return totalMins > 0 ? (
                  <div className="px-5 py-3 border-t border-surface-border bg-surface-page flex items-center justify-between">
                    <span className="text-xs text-text-muted font-medium">{t('totalWorkTime')}</span>
                    <span className="flex items-center gap-1.5 text-sm font-bold text-brand-primary">
                      <Clock size={13} />
                      {formatDuration(totalMins)}
                    </span>
                  </div>
                ) : null;
              })()}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}


