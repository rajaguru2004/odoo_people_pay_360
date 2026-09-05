'use client';

import { LayoutGrid, List, Calendar } from 'lucide-react';
import { useTranslations } from 'next-intl';

export type ContractViewType = 'table' | 'card' | 'timeline';

interface ContractViewSwitcherProps {
    currentView: ContractViewType;
    onViewChange: (view: ContractViewType) => void;
}

export default function ContractViewSwitcher({ currentView, onViewChange }: ContractViewSwitcherProps) {
    const t = useTranslations('contractViewSwitcher');
    const views = [
        { type: 'table' as ContractViewType, icon: List, label: t('table') },
        { type: 'card' as ContractViewType, icon: LayoutGrid, label: t('card') },
        { type: 'timeline' as ContractViewType, icon: Calendar, label: t('timeline') },
    ];

    return (
        <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {views.map((view) => {
                const Icon = view.icon;
                const isActive = currentView === view.type;
                return (
                    <button
                        key={view.type}
                        onClick={() => onViewChange(view.type)}
                        className={`
              flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm transition-all
              ${isActive
                                ? 'bg-white text-brand-primary shadow-sm'
                                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                            }
            `}
                    >
                        <Icon size={18} />
                        <span className="hidden sm:inline">{view.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
