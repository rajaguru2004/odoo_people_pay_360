'use client';

import { Search, X, Filter, Download, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

interface DepartmentFilterPanelProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
  managerFilter: string;
  onManagerChange: (value: string) => void;
  typeFilter: string;
  onTypeChange: (value: string) => void;
  activeFilterCount: number;
  onClearFilters: () => void;
  onExport?: () => void;
  resultCount: number;
  totalCount: number;
}

export default function DepartmentFilterPanel({
  searchTerm,
  onSearchChange,
  statusFilter,
  onStatusChange,
  managerFilter,
  onManagerChange,
  typeFilter,
  onTypeChange,
  activeFilterCount,
  onClearFilters,
  onExport,
  resultCount,
  totalCount,
}: DepartmentFilterPanelProps) {
  const t = useTranslations('departmentFilterPanel');
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="bg-surface-card rounded-[--radius-card] border-2 border-surface-border p-5 space-y-4 shadow-lg">
      {/* Search & Actions Row */}
      <div className="flex flex-col md:flex-row gap-3">
        {/* Search */}
        <div className="flex-1 relative group">
          <Search className="absolute start-4 top-1/2 -translate-y-1/2 text-text-muted group-focus-within:text-brand-primary transition-colors" size={20} />
          <input
            type="text"
            placeholder={t('searchPlaceholder')}
            data-testid="dept-search"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full ps-12 pe-10 py-3 border-2 border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-4 focus:ring-brand-primary/20 focus:border-brand-primary text-sm font-medium transition-all text-text-body bg-surface-card"
          />
          {searchTerm && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute end-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-body hover:bg-slate-100 rounded-full transition-all" /* neutral */
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2">
          <button
            data-testid="dept-filter-toggle"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={`flex items-center gap-2 px-4 py-3 rounded-[--radius-button] font-semibold text-sm transition-all ${
              showAdvanced || activeFilterCount > 0
                ? 'bg-brand-primary text-text-on-brand shadow-lg shadow-brand-primary/30'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200' /* neutral */
            }`}
          >
            <SlidersHorizontal size={18} />
            <span className="hidden sm:inline">{t('filter')}</span>
            {activeFilterCount > 0 && (
              <span className="px-2 py-0.5 bg-surface-card text-brand-primary rounded-[--radius-badge] text-xs font-bold shadow-md">
                {activeFilterCount}
              </span>
            )}
          </button>

          {onExport && (
            <button
              onClick={onExport}
              className="flex items-center gap-2 px-4 py-3 bg-status-success text-white rounded-[--radius-button] hover:bg-status-success/90 font-semibold text-sm transition-all shadow-lg shadow-status-success/30"
            >
              <Download size={18} />
              <span className="hidden sm:inline">{t('export')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Advanced Filters */}
      {showAdvanced && (
        <div className="pt-4 border-t border-surface-border space-y-3">
          <div className="flex items-center gap-2 mb-3">
            <Filter size={16} className="text-brand-primary" />
            <span className="text-sm font-bold text-text-heading">{t('advancedFilters')}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Status Filter */}
            <div>
              <label className="block text-xs font-semibold text-text-muted mb-1.5">{t('status')}</label>
              <select
                data-testid="dept-filter-status"
                value={statusFilter}
                onChange={(e) => onStatusChange(e.target.value)}
                className="w-full px-3 py-2 border-2 border-surface-border rounded-[--radius-input] text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all text-text-body bg-surface-card"
              >
                <option value="all">{t('all')}</option>
                <option value="active">{t('active')}</option>
                <option value="inactive">{t('inactive')}</option>
              </select>
            </div>
            {/* Manager Filter */}
            <div>
              <label className="block text-xs font-semibold text-text-muted mb-1.5">{t('managementLabel')}</label>
              <select
                data-testid="dept-filter-manager"
                value={managerFilter}
                onChange={(e) => onManagerChange(e.target.value)}
                className="w-full px-3 py-2 border-2 border-surface-border rounded-[--radius-input] text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all text-text-body bg-surface-card"
              >
                <option value="all">{t('all')}</option>
                <option value="assigned">{t('managed')}</option>
                <option value="unassigned">{t('unmanaged')}</option>
              </select>
            </div>
            {/* Type Filter */}
            <div>
              <label className="block text-xs font-semibold text-text-muted mb-1.5">{t('type')}</label>
              <select
                data-testid="dept-filter-type"
                value={typeFilter}
                onChange={(e) => onTypeChange(e.target.value)}
                className="w-full px-3 py-2 border-2 border-surface-border rounded-[--radius-input] text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all text-text-body bg-surface-card"
              >
                <option value="all">{t('all')}</option>
                <option value="ceo">{t('leadership')}</option>
                <option value="main">{t('mainDepartment')}</option>
                <option value="sub">{t('department')}</option>
              </select>
            </div>
          </div>
          {activeFilterCount > 0 && (
            <button
              data-testid="dept-filter-clear"
              onClick={onClearFilters}
              className="w-full md:w-auto px-4 py-2 bg-status-error-bg text-status-error rounded-[--radius-button] text-sm font-semibold hover:bg-status-error/10 transition-colors border border-status-error/20"
            >
              {t('clearFilterCount', { count: activeFilterCount })}
            </button>
          )}
        </div>
      )}
      {/* Result Count */}
      <div className="flex items-center justify-between text-sm pt-2 border-t border-surface-border-light">
        <span className="text-text-muted font-medium">
          {t('displayCount', { shown: resultCount, total: totalCount })}
        </span>
      </div>
    </div>
  );
}
