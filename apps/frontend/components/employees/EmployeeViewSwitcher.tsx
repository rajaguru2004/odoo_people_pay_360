'use client';

import { LayoutGrid, List, Kanban } from 'lucide-react';
import { useTranslations } from 'next-intl';

export type ViewType = 'table' | 'card' | 'kanban';

interface EmployeeViewSwitcherProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
}

export default function EmployeeViewSwitcher({ currentView, onViewChange }: EmployeeViewSwitcherProps) {
  const t = useTranslations('employeeViewSwitcher');

  const views = [
    { id: 'table' as ViewType, icon: List, label: t('table') },
    { id: 'card' as ViewType, icon: LayoutGrid, label: t('card') },
    { id: 'kanban' as ViewType, icon: Kanban, label: t('kanban') },
  ];

  return (
    <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
      {views.map((view) => {
        const Icon = view.icon;
        const isActive = currentView === view.id;
        
        return (
          <button
            key={view.id}
            data-testid={`emp-view-${view.id}`}
            onClick={() => onViewChange(view.id)}
            className={`
              flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all
              ${isActive 
                ? 'bg-white text-brand-primary shadow-sm' 
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
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
