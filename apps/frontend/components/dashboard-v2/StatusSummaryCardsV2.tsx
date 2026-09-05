'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Clock, ArrowDown, Briefcase, UserMinus, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { generateSparkPath } from '@/utils/sparkUtils';

interface StatusSummaryCardsV2Props {
  avgWorkHours?: number;
  earlyDeparturesToday?: number;
  activeProjects?: number;
  turnoverRate?: number;
  turnoverChange?: number;
  turnoverTrend?: number[];
  turnoverTopDepartment?: string;
}

export default function StatusSummaryCardsV2({
  avgWorkHours = 0,
  earlyDeparturesToday = 0,
  activeProjects = 0,
  turnoverRate = 0,
  turnoverChange = 0,
  turnoverTrend = [],
  turnoverTopDepartment = 'N/A',
}: StatusSummaryCardsV2Props) {
  const router = useRouter();
  const t = useTranslations('dashboardV2.status');

  const isHealthyTurnover = turnoverRate < 5;
  const isImprovingTurnover = turnoverChange < 0;
  const turnoverSparkPath = generateSparkPath(turnoverTrend, 40, 16);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full h-full">
      {/* 1. Average Daily Work Hours */}
      <div
        onClick={() => router.push('/dashboard/attendance')}
        className="kpi-card rounded-xl p-3 flex flex-col justify-between cursor-pointer group"
      >
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider leading-tight group-hover:text-slate-600">
            {t('avgShiftHours')}
          </span>
          <div className="p-1 rounded-md bg-white border border-slate-200/80 text-indigo-500">
            <Clock size={12} />
          </div>
        </div>
        <span className="text-xl font-black mt-2 text-slate-700">
          {avgWorkHours > 0 ? `${avgWorkHours.toFixed(1)} ${t('hrs')}` : '—'}
        </span>
      </div>

      {/* 2. Early Departures Today */}
      <div
        onClick={() => router.push('/dashboard/attendance')}
        className="kpi-card rounded-xl p-3 flex flex-col justify-between cursor-pointer group"
      >
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider leading-tight group-hover:text-slate-600">
            {t('earlyDepartures')}
          </span>
          <div className={`p-1 rounded-md bg-white border border-slate-200/80 ${earlyDeparturesToday > 0 ? 'text-amber-500 animate-pulse' : 'text-slate-400'}`}>
            <ArrowDown size={12} />
          </div>
        </div>
        <span className={`text-xl font-black mt-2 ${earlyDeparturesToday > 0 ? 'text-amber-600' : 'text-slate-700'}`}>
          {earlyDeparturesToday}
        </span>
      </div>

      {/* 3. Active Delivery Projects */}
      <div
        onClick={() => router.push('/dashboard/projects')}
        className="kpi-card rounded-xl p-3 flex flex-col justify-between cursor-pointer group"
      >
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider leading-tight group-hover:text-slate-600">
            {t('activeProjects')}
          </span>
          <div className="p-1 rounded-md bg-white border border-slate-200/80 text-emerald-500">
            <Briefcase size={12} />
          </div>
        </div>
        <span className="text-xl font-black mt-2 text-slate-700">
          {activeProjects}
        </span>
      </div>

      {/* 4. Turnover Rate */}
      <div
        onClick={() => router.push('/dashboard/employees')}
        className="kpi-card rounded-xl p-3 flex flex-col justify-between cursor-pointer group"
      >
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider leading-tight group-hover:text-slate-600">
            {t('turnoverRate')}
          </span>
          <div className={`p-1 rounded-md bg-white border border-slate-200/80 ${isHealthyTurnover ? 'text-emerald-500' : 'text-rose-500'}`}>
            <UserMinus size={12} />
          </div>
        </div>
        <div className="flex items-end justify-between mt-2">
          <div className="flex items-baseline gap-1">
            <span className={`text-xl font-black ${isHealthyTurnover ? 'text-slate-700' : 'text-rose-600'}`}>
              {turnoverRate.toFixed(1)}%
            </span>
            <span className={`inline-flex items-center gap-0.5 text-[8px] font-extrabold px-1 py-0.5 rounded-full ${
              isImprovingTurnover
                ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                : 'bg-amber-50 text-amber-600 border border-amber-100'
            }`}>
              {isImprovingTurnover ? <ArrowDownRight size={7} /> : <ArrowUpRight size={7} />}
              <span>{Math.abs(turnoverChange).toFixed(1)}%</span>
            </span>
          </div>
          <div className="w-9 h-4 flex items-end shrink-0">
            <svg viewBox="0 0 40 16" className="w-full h-full" fill="none">
              <path
                d={turnoverSparkPath}
                stroke={isHealthyTurnover ? '#10b981' : '#f43f5e'}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
        <p className="text-[8px] font-semibold text-slate-400 truncate mt-1">{t('top', { dept: turnoverTopDepartment })}</p>
      </div>
    </div>
  );
}
