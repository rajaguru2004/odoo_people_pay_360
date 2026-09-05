'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Check, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';

export interface TimelineEvent {
  time: string;
  title: string;
  subtext: string;
  type: 'checkin' | 'review' | 'leave' | 'meeting';
  icon?: React.ElementType;
  iconBg?: string;
  iconColor?: string;
  highlighted?: boolean;
}

interface TodayTimelineV2Props {
  events?: TimelineEvent[];
}

export default function TodayTimelineV2({ events }: TodayTimelineV2Props) {
  const router = useRouter();
  const t = useTranslations('dashboardV2.timeline');

  const fallbackEvents: TimelineEvent[] = [
    {
      time: '09:00 AM',
      title: t('syncedTitle'),
      subtext: t('syncedDesc'),
      type: 'checkin',
    },
    {
      time: '12:00 PM',
      title: t('backupTitle'),
      subtext: t('backupDesc'),
      type: 'checkin',
    },
    {
      time: '03:00 PM',
      title: t('healthTitle'),
      subtext: t('healthDesc'),
      type: 'checkin',
    },
    {
      time: '06:00 PM',
      title: t('shiftTitle'),
      subtext: t('shiftDesc'),
      type: 'checkin',
    },
  ];

  const displayEvents = events && events.length > 0 ? [...events].slice(0, 4) : [];

  // Pad the array to make sure it always has exactly 4 items to preserve layout structure
  while (displayEvents.length < 4) {
    displayEvents.push(fallbackEvents[displayEvents.length] || {
      time: '--:--',
      title: t('noEventsTitle'),
      subtext: t('noEventsDesc'),
      type: 'checkin',
    });
  }

  return (
    <div className="surface-panel p-4 flex flex-col justify-between h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-slate-800">{t('title')}</h4>
        <button 
          onClick={() => router.push('/dashboard/audit-logs')}
          className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-50 transition-colors cursor-pointer"
        >
          <MoreHorizontal size={16} />
        </button>
      </div>

      {/* Timeline items list */}
      <div className="flex-1 mt-3 relative min-h-0 flex flex-col justify-between">
        {/* Timeline connecting line */}
        <div className="absolute ltr:left-[91px] rtl:right-[91px] top-4 bottom-4 w-[2px] bg-slate-100" />

        {displayEvents.map((event, i) => {
          const Icon = event.icon || Check;
          const bg = event.iconBg || 'bg-purple-100 text-purple-600';
          return (
            <div
              key={i}
              className={`flex gap-3 items-center px-1.5 py-1 rounded-xl transition-all duration-200 ${
                event.highlighted
                  ? 'bg-amber-50/75 border border-amber-100/60 shadow-sm'
                  : 'border border-transparent'
              }`}
            >
              {/* Time column */}
              <div className="w-[60px] text-right">
                <span className="text-[10px] font-bold text-slate-400 block tracking-tight">
                  {event.time}
                </span>
              </div>

              {/* Bullet node */}
              <div className="relative z-10 flex items-center justify-center">
                <div className={`w-[26px] h-[26px] rounded-full ${bg} border border-white flex items-center justify-center shadow-sm`}>
                  <Icon size={12} strokeWidth={2.5} />
                </div>
              </div>

              {/* Text content column */}
              <div className="flex-1 min-w-0">
                <h5 className="text-[11px] font-extrabold text-slate-700 truncate">
                  {event.title}
                </h5>
                <span className="text-[9px] font-semibold text-slate-400 mt-0.5 block truncate">
                  {event.subtext}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
