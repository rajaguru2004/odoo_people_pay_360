'use client';

import React from 'react';

const PRIORITY_CONFIG = {
  LOW: { label: 'Low', bg: 'bg-slate-100', text: 'text-slate-600', dot: 'bg-slate-400' },
  MEDIUM: { label: 'Medium', bg: 'bg-brand-primary-light/10', text: 'text-brand-primary', dot: 'bg-brand-primary-light/100' },
  HIGH: { label: 'High', bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  CRITICAL: { label: 'Critical', bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
};

interface Props {
  priority: keyof typeof PRIORITY_CONFIG;
  size?: 'sm' | 'md';
}

export const TaskPriorityBadge: React.FC<Props> = ({ priority, size = 'md' }) => {
  const cfg = PRIORITY_CONFIG[priority] ?? PRIORITY_CONFIG.MEDIUM;
  const px = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';

  return (
    <span data-testid={`task-priority-badge-${priority}`} className={`inline-flex items-center gap-1.5 rounded-full font-medium ${px} ${cfg.bg} ${cfg.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
};
