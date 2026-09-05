'use client';

import React from 'react';

const TS_STATUS_CONFIG = {
  DRAFT: { label: 'Draft', bg: 'bg-slate-100', text: 'text-slate-600' },
  SUBMITTED: { label: 'Submitted', bg: 'bg-brand-primary-light/10', text: 'text-brand-primary' },
  APPROVED: { label: 'Approved', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  REJECTED: { label: 'Rejected', bg: 'bg-red-50', text: 'text-red-700' },
};

interface Props {
  status: keyof typeof TS_STATUS_CONFIG;
  size?: 'sm' | 'md';
}

export const TimesheetStatusBadge: React.FC<Props> = ({ status, size = 'md' }) => {
  const cfg = TS_STATUS_CONFIG[status] ?? TS_STATUS_CONFIG.DRAFT;
  const px = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';

  return (
    <span className={`inline-flex items-center rounded-full font-medium ${px} ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
    </span>
  );
};
