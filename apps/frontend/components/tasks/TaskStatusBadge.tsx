'use client';

import React from 'react';

const STATUS_CONFIG = {
  TODO: { label: 'To Do', bg: 'bg-slate-100', text: 'text-slate-600' },
  IN_PROGRESS: { label: 'In Progress', bg: 'bg-brand-primary-light/10', text: 'text-brand-primary' },
  IN_REVIEW: { label: 'In Review', bg: 'bg-purple-50', text: 'text-purple-700' },
  COMPLETED: { label: 'Completed', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  CANCELLED: { label: 'Cancelled', bg: 'bg-gray-100', text: 'text-gray-500' },
  BLOCKED: { label: 'Blocked', bg: 'bg-red-50', text: 'text-red-700' },
};

interface Props {
  status: keyof typeof STATUS_CONFIG;
  size?: 'sm' | 'md';
}

export const TaskStatusBadge: React.FC<Props> = ({ status, size = 'md' }) => {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.TODO;
  const px = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';

  return (
    <span data-testid={`task-status-badge-${status}`} className={`inline-flex items-center rounded-full font-medium ${px} ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
    </span>
  );
};
