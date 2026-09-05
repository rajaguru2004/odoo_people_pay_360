'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { useTranslations } from 'next-intl';
import { generateSparkPath } from '@/utils/sparkUtils';
import { formatCurrency } from '@/utils/formatters';

interface PayrollKPICardV2Props {
  monthlyCost?: number;
  status?: string;
  sparkData?: number[];
  ytdPaid?: number;
  pendingRuns?: number;
  pendingReimbursements?: number;
}

const getStatusBadgeClass = (status?: string) => {
  switch (status) {
    case 'LOCKED':
    case 'APPROVED':
      return 'bg-emerald-400/20 text-emerald-100 border border-emerald-300/30';
    case 'PENDING_APPROVAL':
      return 'bg-amber-400/20 text-amber-100 border border-amber-300/30';
    case 'REJECTED':
      return 'bg-rose-400/20 text-rose-100 border border-rose-300/30';
    default:
      return 'bg-white/15 text-purple-100 border border-white/20';
  }
};

export default function PayrollKPICardV2({
  monthlyCost = 0,
  status = '—',
  sparkData = [],
  ytdPaid = 0,
  pendingRuns = 0,
  pendingReimbursements = 0,
}: PayrollKPICardV2Props) {
  const router = useRouter();
  const t = useTranslations('dashboardV2.payroll');
  const sparkPath = generateSparkPath(sparkData, 60, 20);
  const statusLabel = status && status !== '—' ? status.replace('_', ' ') : t('notRunYet');

  return (
    <div className="surface-panel p-4 flex flex-col justify-between h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
          <CurrencyIcon size={16} className="text-indigo-500" />
          <span>{t('title')}</span>
        </h4>
        <button
          onClick={() => router.push('/dashboard/payroll')}
          className="text-[10px] font-bold text-indigo-600 hover:text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded transition-all cursor-pointer"
        >
          {t('viewAll')}
        </button>
      </div>

      {/* Hero gradient — Monthly Payroll Cost */}
      <div
        onClick={() => router.push('/dashboard/payroll')}
        className="relative overflow-hidden rounded-xl bg-gradient-to-br from-purple-600 to-indigo-600 p-3 text-white shadow-md hover:shadow-lg transition-shadow cursor-pointer group"
      >
        <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

        <div className="flex items-start justify-between relative z-10">
          <span className="text-[9px] font-black uppercase tracking-wider text-purple-100">
            {t('monthlyCost')}
          </span>
          <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide ${getStatusBadgeClass(status)}`}>
            {statusLabel}
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-2 mt-2 relative z-10">
          <span className="text-base font-black tracking-tight leading-tight flex-1 min-w-0 break-words">
            {formatCurrency(monthlyCost)}
          </span>
          <div className="w-10 h-5 flex items-end shrink-0">
            <svg viewBox="0 0 60 20" className="w-full h-full" fill="none">
              <path d={sparkPath} stroke="#a7f3d0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      {/* Mini stat row */}
      <div className="grid grid-cols-3 gap-1.5 mt-2">
        <div className="bg-slate-50 border border-slate-100 rounded-lg p-1.5 text-center">
          <p className="text-[7px] font-bold text-slate-400 uppercase tracking-wide leading-tight">{t('ytdPaid')}</p>
          <p className="text-[11px] font-black text-slate-700 mt-0.5 truncate">{formatCurrency(ytdPaid)}</p>
        </div>
        <div className="bg-slate-50 border border-slate-100 rounded-lg p-1.5 text-center">
          <p className="text-[7px] font-bold text-slate-400 uppercase tracking-wide leading-tight">{t('pendingRuns')}</p>
          <p className="text-[11px] font-black text-slate-700 mt-0.5">{pendingRuns}</p>
        </div>
        <div className="bg-slate-50 border border-slate-100 rounded-lg p-1.5 text-center">
          <p className="text-[7px] font-bold text-slate-400 uppercase tracking-wide leading-tight">{t('reimburse')}</p>
          <p className="text-[11px] font-black text-slate-700 mt-0.5 truncate">{formatCurrency(pendingReimbursements)}</p>
        </div>
      </div>
    </div>
  );
}
