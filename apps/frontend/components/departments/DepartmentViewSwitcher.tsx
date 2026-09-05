'use client';

import { LayoutGrid, List, Network } from 'lucide-react';
import { useTranslations } from 'next-intl';

export type DepartmentViewType = 'card' | 'table' | 'org-structure';

interface DepartmentViewSwitcherProps {
  currentView: DepartmentViewType;
  onViewChange: (view: DepartmentViewType) => void;
}

export default function DepartmentViewSwitcher({ currentView, onViewChange }: DepartmentViewSwitcherProps) {
  const t = useTranslations('departmentViewSwitcher');

  const views = [
    { id: 'card' as DepartmentViewType, icon: LayoutGrid, label: t('cards') },
    { id: 'table' as DepartmentViewType, icon: List, label: t('table') },
    { id: 'org-structure' as DepartmentViewType, icon: Network, label: t('orgChart') },
  ];

  return (
    <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-[--radius-input]" /* neutral */>
      {views.map((view) => {
        const Icon = view.icon;
        const isActive = currentView === view.id;
        
        return (
          <button
            key={view.id}
            data-testid={`dept-view-${view.id}`}
            onClick={() => onViewChange(view.id)}
            className={`
              flex items-center gap-2 px-3 py-1.5 rounded-[--radius-button] text-sm font-medium transition-all
              ${isActive 
                ? 'bg-surface-card text-brand-primary shadow-sm' 
                : 'text-text-muted hover:text-text-heading hover:bg-slate-50' /* neutral hover */
              }
            `}
            title={view.label}
          >
            <Icon size={16} />
            <span className="hidden sm:inline">{view.label}</span>
          </button>
        );
      })}
    </div>
  );
}
