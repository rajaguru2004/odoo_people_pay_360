'use client';

import React from 'react';
import { Activity } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatDateTime } from '@/utils/formatters';

export default function TaskActivity({ activities }: { activities: any[] }) {
  const t = useTranslations('taskActivity');
  if (!activities || activities.length === 0) {
    return <p data-testid="task-activity-empty" className="py-4 text-center text-sm text-text-muted">{t('emptyNoActivity')}</p>;
  }
  return (
    <div className="space-y-3">
      {activities.map((a) => {
        const name = a.actor?.employee?.fullName || a.actor?.email || t('fallbackSystem');
        return (
          <div key={a.id} data-testid={`task-activity-row-${a.id}`} className="flex gap-3">
            <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-surface-page text-text-muted">
              <Activity className="h-3.5 w-3.5" />
            </div>
            <div className="flex-1">
              <p className="text-sm text-text-body"><span className="font-medium">{name}</span> {a.description}</p>
              <p className="text-xs text-text-muted">{formatDateTime(a.createdAt)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
