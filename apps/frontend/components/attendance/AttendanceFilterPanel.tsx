'use client';

import { useTranslations } from 'next-intl';
import { X, Filter as FilterIcon } from 'lucide-react';

interface AttendanceFilterPanelProps {
  statusFilter: string;
  onStatusChange: (value: string) => void;
  activeFilterCount: number;
  onClearFilters: () => void;
  resultCount: number;
  totalCount: number;
  period?: 'today' | 'week' | 'month' | 'custom';
}

export default function AttendanceFilterPanel({
  statusFilter,
  onStatusChange,
  activeFilterCount,
  onClearFilters,
  resultCount,
  totalCount,
  period = 'today',
}: AttendanceFilterPanelProps) {
  const t = useTranslations('attendanceFilterPanel');
  const tc = useTranslations('common');

  const statusOptions = [
    { value: 'all', label: t('statusAll'), color: 'slate' },
    { value: 'on-time', label: tc('onTime'), color: 'emerald' },
    { value: 'late', label: tc('late'), color: 'orange' },
    { value: 'absent', label: tc('absent'), color: 'red' },
    { value: 'not-checked-out', label: t('statusNotCheckedOut'), color: 'blue' },
  ];

  return (
    <div className="space-y-4">
      {/* Status Filter Chips */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-text-body me-1">
          <FilterIcon size={16} />
          <span>{t('statusLabel')}</span>
        </div>

        {statusOptions.map((option) => {
          const isActive = statusFilter === option.value;
          const colorClasses = {
            slate: {
              active: 'bg-brand-primary text-text-on-brand border-brand-primary',
              inactive: 'bg-surface-card text-text-heading border-surface-border hover:border-text-heading hover:bg-surface-page',
            },
            emerald: {
              active: 'bg-status-success text-text-on-brand border-status-success',
              inactive: 'bg-surface-card text-status-success border-surface-border hover:border-status-success hover:bg-status-success-bg',
            },
            orange: {
              active: 'bg-status-warning text-text-on-brand border-status-warning',
              inactive: 'bg-surface-card text-status-warning border-surface-border hover:border-status-warning hover:bg-status-warning-bg',
            },
            red: {
              active: 'bg-status-error text-text-on-brand border-status-error',
              inactive: 'bg-surface-card text-status-error border-surface-border hover:border-status-error hover:bg-status-error-bg',
            },
            blue: {
              active: 'bg-status-info text-text-on-brand border-status-info',
              inactive: 'bg-surface-card text-status-info border-surface-border hover:border-status-info hover:bg-status-info-bg',
            },
          };

          const classes = isActive
            ? colorClasses[option.color as keyof typeof colorClasses].active
            : colorClasses[option.color as keyof typeof colorClasses].inactive;

          return (
            <button
              key={option.value}
              data-testid={`att-chip-${option.value}`}
              data-active={isActive}
              onClick={() => onStatusChange(option.value)}
              className={`px-3 py-1.5 rounded-[--radius-button] border font-medium text-sm transition-all ${classes}`}
            >
              {option.label}
            </button>
          );
        })}

        {/* Clear Filters */}
        {activeFilterCount > 0 && (
          <button
            data-testid="att-clear"
            data-count={activeFilterCount}
            onClick={onClearFilters}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-status-error-bg text-status-error rounded-[--radius-button] border border-status-error/20 hover:bg-status-error-bg/85 font-medium text-sm transition-all ms-2"
          >
            <X size={14} />
            <span>{t('clearFilters', { count: activeFilterCount })}</span>
          </button>
        )}
      </div>

      {/* Result Count */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-body">
          <span
            data-testid="att-count"
            data-shown={resultCount}
            data-total={totalCount}
          >
            {t(period === 'today' ? 'displayCount' : 'displayCountRecords', { shown: resultCount, total: totalCount })}
          </span>
        </span>
        {totalCount - resultCount > 0 && (
          <span className="text-xs text-text-muted bg-surface-page px-2 py-1 rounded-[--radius-button] font-medium">
            {t('filteredCount', { count: totalCount - resultCount })}
          </span>
        )}
      </div>
    </div>
  );
}
