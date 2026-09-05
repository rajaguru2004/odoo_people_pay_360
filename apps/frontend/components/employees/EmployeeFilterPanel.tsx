'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { X, ChevronDown, Check } from 'lucide-react';
import { Department } from '@/types/department';

export interface FilterState {
  departments: string[];
  positions: string[];
  statuses: string[];
  dateRange: { from?: string; to?: string };
}

interface EmployeeFilterPanelProps {
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  departments: Department[];
  positions: string[];
  onClose: () => void;
}

export default function EmployeeFilterPanel({
  filters,
  onFiltersChange,
  departments,
  positions,
  onClose,
}: EmployeeFilterPanelProps) {
  const t = useTranslations('employeeFilterPanel');
  const tc = useTranslations('common');
  const [localFilters, setLocalFilters] = useState<FilterState>(filters);

  // Sync with parent filters
  useEffect(() => {
    setLocalFilters(filters);
  }, [filters]);

  const statuses = [
    { value: 'ACTIVE', label: tc('active') },
    { value: 'ON_LEAVE', label: tc('onLeaveStatus') },
    { value: 'TERMINATED', label: tc('terminated') },
  ];

  const toggleArrayFilter = (key: keyof FilterState, value: string) => {
    const current = localFilters[key] as string[];
    const updated = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    
    setLocalFilters({ ...localFilters, [key]: updated });
  };

  const handleApply = () => {
    console.log('Applying filters:', localFilters);
    onFiltersChange(localFilters);
  };

  const handleReset = () => {
    const resetFilters: FilterState = {
      departments: [],
      positions: [],
      statuses: [],
      dateRange: {},
    };
    setLocalFilters(resetFilters);
    onFiltersChange(resetFilters);
  };

  const hasDateRangeFilter = () => {
    return !!(localFilters.dateRange?.from || localFilters.dateRange?.to);
  };

  const activeFilterCount = 
    localFilters.departments.length +
    localFilters.positions.length +
    localFilters.statuses.length +
    (hasDateRangeFilter() ? 1 : 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/20 backdrop-blur-sm">
      <div className="w-full max-w-md h-full bg-white shadow-2xl animate-slide-in-right overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">{t('advancedFilters')}</h2>
            {activeFilterCount > 0 && (
              <p className="text-sm text-slate-500 mt-0.5">
                {t('filtersActive', { count: activeFilterCount })}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Filter Sections */}
        <div className="p-6 space-y-6">
          {/* Department Filter */}
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-3">
              {tc('department')}
            </label>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {departments.map((dept) => (
                <label
                  key={dept.id}
                  className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg cursor-pointer group"
                >
                  <div className="relative">
                    <input
                      type="checkbox"
                      data-testid={`emp-filter-dept-${dept.code ?? dept.id}`}
                      checked={localFilters.departments.includes(dept.id)}
                      onChange={() => toggleArrayFilter('departments', dept.id)}
                      className="sr-only"
                    />
                    <div
                      className={`w-5 h-5 border-2 rounded flex items-center justify-center transition-all ${
                        localFilters.departments.includes(dept.id)
                          ? 'bg-brand-primary border-brand-primary'
                          : 'border-slate-300 group-hover:border-brand-primary'
                      }`}
                    >
                      {localFilters.departments.includes(dept.id) && (
                        <Check size={14} className="text-white" />
                      )}
                    </div>
                  </div>
                  <span className="text-sm text-slate-700 font-medium">{dept.name}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Position Filter */}
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-3">
              {tc('position')}
            </label>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {positions.map((position) => (
                <label
                  key={position}
                  className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg cursor-pointer group"
                >
                  <div className="relative">
                    <input
                      type="checkbox"
                      data-testid={`emp-filter-position-${position}`}
                      checked={localFilters.positions.includes(position)}
                      onChange={() => toggleArrayFilter('positions', position)}
                      className="sr-only"
                    />
                    <div
                      className={`w-5 h-5 border-2 rounded flex items-center justify-center transition-all ${
                        localFilters.positions.includes(position)
                          ? 'bg-brand-primary border-brand-primary'
                          : 'border-slate-300 group-hover:border-brand-primary'
                      }`}
                    >
                      {localFilters.positions.includes(position) && (
                        <Check size={14} className="text-white" />
                      )}
                    </div>
                  </div>
                  <span className="text-sm text-slate-700 font-medium">{position}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Status Filter */}
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-3">
              {tc('status')}
            </label>
            <div className="space-y-2">
              {statuses.map((status) => (
                <label
                  key={status.value}
                  className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg cursor-pointer group"
                >
                  <div className="relative">
                    <input
                      type="checkbox"
                      data-testid={`emp-filter-status-${status.value}`}
                      checked={localFilters.statuses.includes(status.value)}
                      onChange={() => toggleArrayFilter('statuses', status.value)}
                      className="sr-only"
                    />
                    <div
                      className={`w-5 h-5 border-2 rounded flex items-center justify-center transition-all ${
                        localFilters.statuses.includes(status.value)
                          ? 'bg-brand-primary border-brand-primary'
                          : 'border-slate-300 group-hover:border-brand-primary'
                      }`}
                    >
                      {localFilters.statuses.includes(status.value) && (
                        <Check size={14} className="text-white" />
                      )}
                    </div>
                  </div>
                  <span className="text-sm text-slate-700 font-medium">{status.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Date Range Filter */}
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-3">
              {t('startDateRange')}
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">{tc('from')}</label>
                <input
                  type="date"
                  data-testid="emp-filter-date-from"
                  value={localFilters.dateRange.from || ''}
                  onChange={(e) =>
                    setLocalFilters({
                      ...localFilters,
                      dateRange: { ...localFilters.dateRange, from: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">{tc('to')}</label>
                <input
                  type="date"
                  data-testid="emp-filter-date-to"
                  value={localFilters.dateRange.to || ''}
                  onChange={(e) =>
                    setLocalFilters({
                      ...localFilters,
                      dateRange: { ...localFilters.dateRange, to: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="sticky bottom-0 bg-white border-t border-slate-200 px-6 py-4 flex items-center gap-3">
          <button
            data-testid="emp-filter-reset"
            onClick={handleReset}
            className="flex-1 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors font-medium"
          >
            {t('reset')}
          </button>
          <button
            data-testid="emp-filter-apply"
            onClick={() => {
              handleApply();
              // Close after a small delay to ensure state is updated
              setTimeout(() => onClose(), 100);
            }}
            className="flex-1 px-4 py-2 bg-brand-primary text-white rounded-lg hover:bg-brand-primary-dark transition-colors font-medium shadow-lg shadow-brand-primary/20"
          >
            {t('applyFilters')}
          </button>
        </div>
      </div>
    </div>
  );
}
