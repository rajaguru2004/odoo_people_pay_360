'use client';

import React, { useMemo } from 'react';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

export interface QuickFilter {
  id: string;
  label: string;
  filter: {
    departments?: string[];
    positions?: string[];
    statuses?: string[];
    dateRange?: { from?: string; to?: string };
  };
}

interface QuickFilterChipsProps {
  onFilterSelect: (filter: QuickFilter['filter']) => void;
  activeFilters?: string[];
}

export default function QuickFilterChips({ onFilterSelect, activeFilters = [] }: QuickFilterChipsProps) {
  const t = useTranslations('quickFilterChips');

  const quickFilters: QuickFilter[] = useMemo(() => [
    {
      id: 'new-hires',
      label: t('newHires'),
      filter: {
        dateRange: {
          from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        },
      },
    },
    {
      id: 'active-only',
      label: t('activeOnly'),
      filter: {
        statuses: ['ACTIVE'],
      },
    },
    {
      id: 'on-leave',
      label: t('onLeave'),
      filter: {
        statuses: ['ON_LEAVE'],
      },
    },
    {
      id: 'probation',
      label: t('probationPeriod'),
      filter: {
        dateRange: {
          from: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        },
        statuses: ['ACTIVE'],
      },
    },
  ], [t]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
        {t('label')}
      </span>
      {quickFilters.map((qf) => {
        const isActive = activeFilters.includes(qf.id);
        
        return (
          <button
            key={qf.id}
            onClick={() => onFilterSelect(qf.filter)}
            className={`
              inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all
              ${isActive
                ? 'bg-brand-primary text-white shadow-md'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }
            `}
          >
            {qf.label}
            {isActive && <X size={12} />}
          </button>
        );
      })}
    </div>
  );
}
