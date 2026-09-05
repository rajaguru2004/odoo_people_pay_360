'use client';

import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';

export interface DistributionItem {
  name: string;
  value: number;
  fill: string;
}

interface EmployeeDistributionV2Props {
  distribution?: DistributionItem[];
}

/** 3D-style donut: per-slice drop shadow + blurred glow ring behind the chart */
function Donut3D({ data, total }: { data: DistributionItem[]; total: number }) {
  const t = useTranslations('dashboardV2.distribution');
  return (
    <div className="relative flex items-center justify-center w-[130px] h-[130px] flex-shrink-0">
      <div
        className="absolute w-[120px] h-[120px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(99,102,241,0.10) 0%, transparent 70%)',
          filter: 'blur(8px)',
        }}
      />
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <defs>
            {data.map((entry, i) => (
              <filter key={i} id={`emp-dist-shadow-${i}`} x="-30%" y="-30%" width="160%" height="160%">
                <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor={entry.fill} floodOpacity="0.4" />
              </filter>
            ))}
          </defs>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={40}
            outerRadius={58}
            paddingAngle={3}
            dataKey="value"
            startAngle={90}
            endAngle={-270}
            strokeWidth={0}
          >
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.fill}
                filter={`url(#emp-dist-shadow-${index})`}
                style={{ outline: 'none' }}
              />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-lg font-black text-slate-800 leading-none">{total}</span>
        <span className="text-[8px] font-bold text-slate-400 uppercase tracking-wide mt-0.5">{t('total')}</span>
      </div>
    </div>
  );
}

export default function EmployeeDistributionV2({ distribution }: EmployeeDistributionV2Props) {
  const t = useTranslations('dashboardV2.distribution');
  const fallbackDistribution: DistributionItem[] = [
    { name: 'No Departments', value: 0, fill: '#94a3b8' },
  ];

  const displayDistribution = distribution && distribution.length > 0 ? distribution : fallbackDistribution;
  const isEmpty = displayDistribution[0]?.name === 'No Departments';
  const total = displayDistribution.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="surface-panel p-4 flex flex-col justify-between h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-slate-800">{t('title')}</h4>
      </div>

      {/* Donut & Legend wrapper */}
      <div className="flex items-center justify-center gap-4 my-1 flex-1 min-h-0">
        {isEmpty ? (
          <div className="w-[130px] h-[130px] flex flex-col items-center justify-center text-slate-300 text-[10px] font-bold">
            <span>{t('noActive')}</span>
            <span>{t('distribution')}</span>
          </div>
        ) : (
          <Donut3D data={displayDistribution} total={total} />
        )}

        {/* Legend table */}
        <div className="flex-1 space-y-1 text-xs max-h-[130px] overflow-y-auto pr-1">
          {displayDistribution.map((item, index) => (
            <motion.div
              key={item.name}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.04, duration: 0.3 }}
              className="flex items-center justify-between"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-sm"
                  style={{ backgroundColor: item.fill, boxShadow: `0 0 6px ${item.fill}60` }}
                />
                <span className="font-semibold text-slate-600 text-[11px] truncate max-w-[80px]">{item.name}</span>
              </div>
              <span className="font-bold text-slate-800 text-[11px] shrink-0">{item.value}</span>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Footer Link */}
      <Link href="/dashboard/employees" className="flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-slate-600 self-start transition-colors pt-1">
        <span>{t('viewReport')}</span>
        <ArrowRight size={10} strokeWidth={2.5} className="rtl:-scale-x-100" />
      </Link>
    </div>
  );
}
