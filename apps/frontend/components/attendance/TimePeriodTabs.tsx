'use client';

import { useTranslations } from 'next-intl';
import { Calendar, CalendarDays, CalendarRange } from 'lucide-react';

type Period = 'today' | 'week' | 'month' | 'custom';

interface TimePeriodTabsProps {
  activePeriod: Period;
  onPeriodChange: (period: Period) => void;
}

export default function TimePeriodTabs({ activePeriod, onPeriodChange }: TimePeriodTabsProps) {
  const tc = useTranslations('common');

  const tabs = [
    { value: 'today' as Period, label: tc('today'), icon: Calendar },
    { value: 'week' as Period, label: tc('thisWeek'), icon: CalendarDays },
    { value: 'month' as Period, label: tc('thisMonth'), icon: CalendarRange },
    { value: 'custom' as Period, label: tc('customRange'), icon: CalendarRange },
  ];

  return (
    <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activePeriod === tab.value;

        return (
          <button
            data-testid={`att-period-${tab.value}`}
            data-active={isActive}
            key={tab.value}
            onClick={() => onPeriodChange(tab.value)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all ${
              isActive
                ? 'bg-white text-brand-primary shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Icon size={16} strokeWidth={2} />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
