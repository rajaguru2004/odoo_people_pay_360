'use client';

import { Search, X, Calendar, Building2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AttendanceSearchFilterBarProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  departmentFilter: string;
  onDepartmentChange: (value: string) => void;
  dateFilter: string;
  onDateChange: (value: string) => void;
  startDateFilter: string;
  onStartDateChange: (value: string) => void;
  endDateFilter: string;
  onEndDateChange: (value: string) => void;
  departments: Array<{ id: string; name: string }>;
  activePeriod: 'today' | 'week' | 'month' | 'custom';
}

export default function AttendanceSearchFilterBar({
  searchTerm,
  onSearchChange,
  departmentFilter,
  onDepartmentChange,
  dateFilter,
  onDateChange,
  startDateFilter,
  onStartDateChange,
  endDateFilter,
  onEndDateChange,
  departments,
  activePeriod,
}: AttendanceSearchFilterBarProps) {
  const t = useTranslations('attendanceFilterPanel');

  return (
    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-3 shadow-md">
      <div className="flex flex-col lg:flex-row gap-3">
        {/* Search */}
        <div className="flex-1 relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
          <input
            type="text"
            data-testid="att-search"
            placeholder={t('searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full ps-10 pe-10 py-2.5 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body text-sm transition-all"
          />
          {searchTerm && (
            <button
              data-testid="att-search-clear"
              onClick={() => onSearchChange('')}
              className="absolute end-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-heading hover:bg-surface-page rounded transition-all"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Date Picker(s) */}
        {activePeriod === 'custom' ? (
          <>
            {/* Start Date Picker */}
            <div className="flex items-center gap-2 min-w-[210px]">
              <span className="text-xs font-bold text-text-muted uppercase tracking-wider">{t('from')}</span>
              <div className="relative flex-1">
                <Calendar className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" size={16} />
                <input
                  type="date"
                  value={startDateFilter}
                  data-testid="att-date-from"
                  onChange={(e) => onStartDateChange(e.target.value)}
                  className="w-full ps-10 pe-3 py-2.5 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body text-sm transition-all"
                />
              </div>
            </div>

            {/* End Date Picker */}
            <div className="flex items-center gap-2 min-w-[210px]">
              <span className="text-xs font-bold text-text-muted uppercase tracking-wider">{t('to')}</span>
              <div className="relative flex-1">
                <Calendar className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" size={16} />
                <input
                  type="date"
                  value={endDateFilter}
                  data-testid="att-date-to"
                  onChange={(e) => onEndDateChange(e.target.value)}
                  className="w-full ps-10 pe-3 py-2.5 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body text-sm transition-all"
                />
              </div>
            </div>
          </>
        ) : activePeriod === 'today' ? (
          <div className="relative min-w-[180px]">
            <Calendar className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" size={16} />
            <input
              type="date"
              value={dateFilter}
              data-testid="att-date"
              onChange={(e) => onDateChange(e.target.value)}
              className="w-full ps-10 pe-3 py-2.5 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-card text-text-body text-sm transition-all"
            />
          </div>
        ) : null}

        {/* Department Dropdown */}
        <div className="relative min-w-[200px]">
          <Building2 className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" size={16} />
          <select
            data-testid="att-dept"
            value={departmentFilter}
            onChange={(e) => onDepartmentChange(e.target.value)}
            className="w-full ps-10 pe-8 py-2.5 border border-surface-border rounded-[--radius-input] text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all appearance-none bg-surface-card text-text-body cursor-pointer"
          >
            <option value="all">{t('allDepartments')}</option>
            {departments.map((dept) => (
              <option key={dept.id} value={dept.id}>
                {dept.name}
              </option>
            ))}
          </select>
          <div className="absolute end-3 top-1/2 -translate-y-1/2 pointer-events-none">
            <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
