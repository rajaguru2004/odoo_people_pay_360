'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Clock, CheckCircle, XCircle, AlertCircle, Eye, UserPlus, Info } from 'lucide-react';
import { Attendance } from '@/types/attendance';
import { formatTime } from '@/utils/formatters';
import Pagination from '@/components/common/Pagination';
import { useBrandingStore } from '@/store/brandingStore';
import { todayStr } from '@/utils/tzDate';

const formatTimeString = (timeStr: string): string => {
  if (!timeStr) return '';
  const [hour, min] = timeStr.split(':').map(Number);
  if (isNaN(hour) || isNaN(min)) return timeStr;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  const displayMin = min < 10 ? `0${min}` : min;
  return `${displayHour}:${displayMin} ${ampm}`;
};

interface TodayAttendanceTableProps {
  attendances: Attendance[];
  loading?: boolean;
  onViewDetail?: (attendance: Attendance) => void;
  onManualCheckIn?: (employeeId: string) => void;
  currentPage?: number;
  itemsPerPage?: number;
  totalItems?: number;
  onPageChange?: (page: number) => void;
  onItemsPerPageChange?: (itemsPerPage: number) => void;
  period?: 'today' | 'week' | 'month' | 'custom';
  dateFilter?: string;
}

// Simple Tooltip Component
function Tooltip({ children, content }: { children: React.ReactNode; content: React.ReactNode }) {
  const [show, setShow] = useState(false);

  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      >
        {children}
      </div>
      {show && (
        <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-slate-900 text-white text-xs rounded-[--radius-badge] shadow-lg whitespace-nowrap">
          {content}
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900"></div>
        </div>
      )}
    </div>
  );
}

export default function TodayAttendanceTable({
  attendances,
  loading = false,
  onViewDetail,
  onManualCheckIn,
  currentPage = 1,
  itemsPerPage = 20,
  totalItems,
  onPageChange,
  onItemsPerPageChange,
  period = 'today',
  dateFilter,
}: TodayAttendanceTableProps) {
  const t = useTranslations('todayAttendanceTable');
  const tc = useTranslations('common');
  const [sortBy, setSortBy] = useState<'name' | 'checkIn' | 'status'>('checkIn');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const { branding } = useBrandingStore();
  const officeStart = branding?.office_start_time || '08:30';

  const calculateLateMinutes = (checkIn: string) => {
    const checkInTime = new Date(checkIn);
    const workStart = new Date(checkInTime);
    const [startHour, startMin] = officeStart.split(':').map(Number);
    workStart.setHours(isNaN(startHour) ? 8 : startHour, isNaN(startMin) ? 30 : startMin, 0, 0);
    
    const diffMs = checkInTime.getTime() - workStart.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    return diffMins > 0 ? diffMins : 0;
  };

  const getStatusBadge = (attendance: Attendance) => {
    if (attendance.status === 'ABSENT') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-status-error-bg text-status-error rounded-[--radius-badge] text-xs font-medium border border-status-error/20">
          <XCircle size={14} strokeWidth={2} />
          {tc('absent')}
        </span>
      );
    }
    if (attendance.status === 'MISSED_CHECKOUT') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-status-error-bg/60 text-status-error rounded-[--radius-badge] text-xs font-medium border border-status-error/20">
          <AlertCircle size={14} strokeWidth={2} />
          {t('missedCheckout')}
        </span>
      );
    }
    if (attendance.isLate && attendance.checkIn) {
      const lateMinutes = calculateLateMinutes(attendance.checkIn);
      return (
        <Tooltip
          content={
            <div className="text-center">
              <p className="font-semibold">{t('lateMinutes', { count: lateMinutes })}</p>
              <p className="text-[10px] mt-0.5 opacity-80">{t('checkInLabel')} {formatTime(attendance.checkIn)}</p>
              <p className="text-[10px] opacity-80">{t('standardTime')} {formatTimeString(officeStart)}</p>
            </div>
          }
        >
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-status-warning-bg text-status-warning rounded-[--radius-badge] text-xs font-medium border border-status-warning/20 cursor-help">
            <Clock size={14} strokeWidth={2} />
            {tc('late')}
            <Info size={12} className="opacity-60" />
          </span>
        </Tooltip>
      );
    }
    if (attendance.checkIn) {
      return (
        <Tooltip
          content={
            <div className="text-center">
              <p className="font-semibold">{tc('onTime')}</p>
              <p className="text-[10px] mt-0.5 opacity-80">{t('checkInLabel')} {formatTime(attendance.checkIn)}</p>
            </div>
          }
        >
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-status-success-bg text-status-success rounded-[--radius-badge] text-xs font-medium border border-status-success/20 cursor-help">
            <CheckCircle size={14} strokeWidth={2} />
            {tc('onTime')}
          </span>
        </Tooltip>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-surface-page text-text-muted rounded-[--radius-badge] text-xs font-medium border border-surface-border">
        <AlertCircle size={14} strokeWidth={2} />
        {t('notCheckedIn')}
      </span>
    );
  };

  const sortedAttendances = [...attendances].sort((a, b) => {
    let comparison = 0;
    switch (sortBy) {
      case 'name':
        comparison = (a.employee?.fullName || '').localeCompare(b.employee?.fullName || '');
        break;
      case 'checkIn':
        comparison = (a.checkIn || '').localeCompare(b.checkIn || '');
        break;
      case 'status':
        comparison = a.status.localeCompare(b.status);
        break;
    }
    return sortOrder === 'asc' ? comparison : -comparison;
  });

  const handleSort = (column: 'name' | 'checkIn' | 'status') => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('asc');
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const [year, month, day] = dateStr.split('-').map(Number);
      const d = new Date(Date.UTC(year, month - 1, day));
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  // `todayStr()` resolves the DISPLAY timezone. Comparing against
  // `new Date().toISOString()` compared the user's chosen day to a UTC day, so
  // between local midnight and the UTC offset this branch flipped to false on
  // the very day it was meant to describe (finding F19).
  const isToday = !dateFilter || dateFilter === todayStr();

  const tableTitle =
    period === 'today'
      ? isToday
        ? t('titleToday')
        : t('titleFor', { date: formatDate(dateFilter) })
      : period === 'week'
      ? t('titleWeek')
      : period === 'month'
      ? t('titleMonth')
      : t('titleCustom');

  if (loading) {
    return (
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden shadow-sm">
        <div className="p-6">
          <div className="h-6 bg-surface-border-light rounded-[--radius-input] w-48 mb-4"></div>
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="animate-pulse flex items-center gap-4 p-4 bg-surface-page rounded-[--radius-input]">
                <div className="w-12 h-12 bg-surface-border-light rounded-[--radius-badge]"></div>
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-surface-border-light rounded-[--radius-input] w-32"></div>
                  <div className="h-3 bg-surface-border-light rounded-[--radius-input] w-24"></div>
                </div>
                <div className="h-8 bg-surface-border-light rounded-[--radius-button] w-20"></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-6 py-4 border-b border-surface-border bg-surface-page">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-text-heading">{tableTitle}</h3>
            <p className="text-sm text-text-muted mt-0.5">{t('subtitle')}</p>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-card rounded-[--radius-button] border border-surface-border">
            {period === 'today' && isToday && (
              <div className="w-2 h-2 bg-status-success rounded-full animate-pulse" />
            )}
            <span className="text-xs font-medium text-text-body">
              {period === 'today' && isToday ? t('live') : t('recordsCount', { count: totalItems ?? attendances.length })}
            </span>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-surface-page border-b border-surface-border">
            <tr>
              <th
                className="px-6 py-3 text-start text-xs font-bold text-text-body uppercase tracking-wider cursor-pointer hover:bg-surface-border-light transition-colors"
                data-testid="att-sort-name"
                data-order={sortBy === 'name' ? sortOrder : undefined}
                onClick={() => handleSort('name')}
              >
                {tc('employee')}
                {sortBy === 'name' && (
                  <span className="ms-1">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </th>
              {period !== 'today' && (
                <th className="px-6 py-3 text-start text-xs font-bold text-text-body uppercase tracking-wider">
                  {tc('date')}
                </th>
              )}
              <th className="px-6 py-3 text-start text-xs font-bold text-text-body uppercase tracking-wider">
                {tc('department')}
              </th>
              <th
                className="px-6 py-3 text-start text-xs font-bold text-text-body uppercase tracking-wider cursor-pointer hover:bg-surface-border-light transition-colors"
                data-testid="att-sort-checkIn"
                data-order={sortBy === 'checkIn' ? sortOrder : undefined}
                onClick={() => handleSort('checkIn')}
              >
                {tc('checkInLower')}
                {sortBy === 'checkIn' && (
                  <span className="ms-1">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </th>
              <th className="px-6 py-3 text-start text-xs font-bold text-text-body uppercase tracking-wider">
                {tc('checkOutLower')}
              </th>
              <th className="px-6 py-3 text-start text-xs font-bold text-text-body uppercase tracking-wider">
                {tc('hours')}
              </th>
              <th
                className="px-6 py-3 text-start text-xs font-bold text-text-body uppercase tracking-wider cursor-pointer hover:bg-surface-border-light transition-colors"
                data-testid="att-sort-status"
                data-order={sortBy === 'status' ? sortOrder : undefined}
                onClick={() => handleSort('status')}
              >
                {tc('status')}
                {sortBy === 'status' && (
                  <span className="ms-1">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </th>
              <th className="px-6 py-3 text-end text-xs font-bold text-text-body uppercase tracking-wider">
                {t('action')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-surface-card">
            {sortedAttendances.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-16 h-16 bg-surface-page rounded-[--radius-badge] flex items-center justify-center">
                      <Clock className="text-text-muted" size={32} />
                    </div>
                    <p data-testid="att-empty" className="text-text-muted font-medium">{t('noData')}</p>
                  </div>
                </td>
              </tr>
            ) : (
              sortedAttendances.map((attendance) => (
                <tr
                  key={attendance.id}
                  data-testid="att-row"
                  data-attendance-id={attendance.id}
                  data-employee-id={attendance.employeeId ?? attendance.employee?.id}
                  data-status={attendance.status}
                  data-late={Boolean(attendance.isLate)}
                  className="hover:bg-surface-border-light/50 transition-colors"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="w-10 h-10 bg-brand-primary rounded-[--radius-input] flex items-center justify-center text-text-on-brand font-semibold text-sm">
                          {attendance.employee?.fullName?.charAt(0) || '?'}
                        </div>
                        {attendance.checkIn && (
                          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-status-success rounded-full border-2 border-surface-card" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-text-heading">
                          {attendance.employee?.fullName || 'N/A'}
                        </p>
                        <p className="text-xs text-text-muted">
                          {attendance.employee?.employeeCode || 'N/A'}
                        </p>
                      </div>
                    </div>
                  </td>
                  {period !== 'today' && (
                    <td className="px-6 py-4">
                      <p className="text-sm font-medium text-text-body">
                        {attendance.date
                          ? new Date(attendance.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' })
                          : '—'}
                      </p>
                    </td>
                  )}
                  <td className="px-6 py-4">
                    <p className="text-sm text-text-body font-medium">
                      {attendance.employee?.department?.name || 'N/A'}
                    </p>
                  </td>
                  <td className="px-6 py-4">
                    <p className="text-sm font-semibold text-text-heading">
                      {attendance.checkIn ? formatTime(attendance.checkIn) : '--:--'}
                    </p>
                  </td>
                  <td className="px-6 py-4">
                    {attendance.status === 'MISSED_CHECKOUT' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-status-error-bg/50 text-status-error rounded-[--radius-badge] text-xs font-medium border border-status-error/20">
                        <XCircle size={11} strokeWidth={2} />
                        {tc('missed')}
                      </span>
                    ) : (
                      <p className="text-sm font-semibold text-text-heading">
                        {attendance.checkOut ? formatTime(attendance.checkOut) : '--:--'}
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {attendance.workHours ? (
                      <Tooltip
                        content={
                          <div className="text-center text-text-on-accent">
                            <p className="font-semibold">{Number(attendance.workHours).toFixed(1)} {t('businessHours')}</p>
                            <p className="text-[10px] mt-0.5 opacity-80">
                              {attendance.checkIn && formatTime(attendance.checkIn)} - {attendance.checkOut ? formatTime(attendance.checkOut) : '...'}
                            </p>
                          </div>
                        }
                      >
                        <div className="cursor-help">
                          <p className="text-sm font-semibold text-text-heading">{Number(attendance.workHours).toFixed(1)}h</p>
                          <p className="text-xs text-text-muted">
                            {attendance.checkIn && attendance.checkOut ? t('complete') : t('working')}
                          </p>
                        </div>
                      </Tooltip>
                    ) : (
                      <p className="text-sm text-text-muted">--</p>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {getStatusBadge(attendance)}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-2">
                      {onViewDetail && (
                        <button
                          data-testid={`att-row-view-${attendance.id}`}
                          onClick={() => onViewDetail(attendance)}
                          className="p-2 text-brand-primary hover:bg-brand-primary-light/20 rounded-[--radius-button] transition-colors"
                          title={t('viewDetails')}
                        >
                          <Eye size={16} strokeWidth={2} />
                        </button>
                      )}
                      {onManualCheckIn && !attendance.checkIn && (
                        <button
                          onClick={() => onManualCheckIn(attendance.employeeId)}
                          className="p-2 text-status-success hover:bg-status-success-bg/40 rounded-[--radius-button] transition-colors"
                          title={t('manualCheckIn')}
                        >
                          <UserPlus size={16} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      {sortedAttendances.length > 0 && onPageChange && (
        <Pagination
          testIdPrefix="att-pg"
          currentPage={currentPage}
          totalPages={Math.ceil((totalItems || attendances.length) / itemsPerPage)}
          totalItems={totalItems || attendances.length}
          itemsPerPage={itemsPerPage}
          onPageChange={onPageChange}
          onItemsPerPageChange={onItemsPerPageChange}
        />
      )}
    </div>
  );
}
