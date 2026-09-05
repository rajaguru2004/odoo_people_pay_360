'use client';

import React from 'react';
import { Users, CheckCircle, Clock, AlertTriangle, Building2, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { generateSparkPath } from '@/utils/sparkUtils';

interface CardProps {
  title: string;
  value: string | number;
  subtext: string;
  trend?: string;
  isPositive?: boolean;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  borderColor: string;
  sparklineColor: string;
  sparklinePath?: string;
  barChart?: boolean;
  barChartData?: number[];
}

function Sparkline({ path, strokeColor }: { path: string; strokeColor: string }) {
  return (
    <div className="w-full h-8 overflow-hidden opacity-80">
      <svg viewBox="0 0 120 32" preserveAspectRatio="none" className="w-full h-full" fill="none">
        <path d={path} stroke={strokeColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function MiniBarChart({ data }: { data?: number[] }) {
  const heights = data && data.length > 0 ? data : [30, 60, 45, 90, 75, 100, 85];
  const max = Math.max(...heights) || 1;
  const normalized = heights.map((h) => Math.round((h / max) * 100));

  return (
    <div className="flex items-end gap-[3px] h-9">
      {normalized.map((h, i) => (
        <div
          key={i}
          className="w-[4px] rounded-sm bg-emerald-500/80 transition-all duration-300 hover:bg-emerald-600"
          style={{ height: `${h}%` }}
        />
      ))}
    </div>
  );
}

interface OverviewCardsV2Props {
  totalEmployees?: number;
  presentToday?: number;
  pendingApprovals?: number;
  contractsExpiring?: number;
  totalDepartments?: number;
  attendanceRate?: number;
  
  // Dynamic trend & sparkline values
  employeeTrend?: number;
  employeeSparkData?: number[];
  attendanceSparkData?: number[];
  approvalsSparkData?: number[];
  contractsSparkData?: number[];
  departmentsSparkData?: number[];
}

export default function OverviewCardsV2({
  totalEmployees = 0,
  presentToday = 0,
  pendingApprovals = 0,
  contractsExpiring = 0,
  totalDepartments = 0,
  attendanceRate = 0,
  employeeTrend = 0,
  employeeSparkData = [],
  attendanceSparkData = [],
  approvalsSparkData = [],
  contractsSparkData = [],
  departmentsSparkData = [],
}: OverviewCardsV2Props) {
  const t = useTranslations('dashboardV2.overview');
  const cards: CardProps[] = [
    {
      title: t('totalEmployees'),
      value: totalEmployees.toLocaleString(),
      subtext: t('vsLastMonth', { value: `${employeeTrend >= 0 ? '+' : ''}${employeeTrend.toFixed(1)}%` }),
      trend: `${Math.abs(employeeTrend).toFixed(1)}%`,
      isPositive: employeeTrend >= 0,
      icon: Users,
      iconBg: 'bg-purple-50 text-purple-600 border border-purple-100',
      iconColor: 'text-purple-600',
      borderColor: 'border-purple-200 hover:border-purple-300',
      sparklineColor: '#9333ea',
      sparklinePath: generateSparkPath(employeeSparkData),
    },
    {
      title: t('presentToday'),
      value: presentToday.toLocaleString(),
      subtext: t('attendance', { value: `${attendanceRate.toFixed(1)}%` }),
      trend: `${attendanceRate.toFixed(1)}%`,
      isPositive: attendanceRate >= 80,
      icon: CheckCircle,
      iconBg: 'bg-emerald-50 text-emerald-600 border border-emerald-100',
      iconColor: 'text-emerald-600',
      borderColor: 'border-emerald-200 hover:border-emerald-300',
      sparklineColor: '#10b981',
      barChart: true,
      barChartData: attendanceSparkData.slice(-7), // Last 7 data points
    },
    {
      title: t('pendingApprovals'),
      value: pendingApprovals,
      subtext: t('requiresAction'),
      icon: Clock,
      iconBg: 'bg-amber-50 text-amber-600 border border-amber-100',
      iconColor: 'text-amber-600',
      borderColor: 'border-amber-200 hover:border-amber-300',
      sparklineColor: '#d97706',
      sparklinePath: generateSparkPath(approvalsSparkData),
    },
    {
      title: t('contractExpiring'),
      value: contractsExpiring,
      subtext: t('next30Days'),
      trend: contractsExpiring > 0 ? `${contractsExpiring}` : '0',
      isPositive: contractsExpiring === 0,
      icon: AlertTriangle,
      iconBg: 'bg-rose-50 text-rose-600 border border-rose-100',
      iconColor: 'text-rose-600',
      borderColor: 'border-rose-200 hover:border-rose-300',
      sparklineColor: '#e11d48',
      sparklinePath: generateSparkPath(contractsSparkData),
    },
    {
      title: t('totalDepartments'),
      value: totalDepartments,
      subtext: t('orgUnits'),
      icon: Building2,
      iconBg: 'bg-blue-50 text-blue-600 border border-blue-100',
      iconColor: 'text-blue-600',
      borderColor: 'border-blue-200 hover:border-blue-300',
      sparklineColor: '#2563eb',
      sparklinePath: generateSparkPath(departmentsSparkData),
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 w-full">
      {cards.map((card, i) => {
        const Icon = card.icon;
        return (
          <motion.div
            key={card.title}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05 }}
            className={`bg-white/90 backdrop-blur-md border ${card.borderColor} rounded-xl p-3.5 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col justify-between h-[120px]`}
          >
            {/* Top row */}
            <div className="flex items-start justify-between">
              <div className={`p-1.5 rounded-lg ${card.iconBg} flex items-center justify-center`}>
                <Icon size={16} strokeWidth={2.2} />
              </div>
              
              {card.trend && (
                <div className={`flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                  card.isPositive 
                    ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' 
                    : 'bg-rose-50 text-rose-600 border border-rose-100'
                }`}>
                  {card.isPositive ? <ArrowUpRight size={8} /> : <ArrowDownRight size={8} />}
                  <span>{card.trend}</span>
                </div>
              )}
            </div>

            {/* Middle row: Label + value */}
            <div className="mt-1">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">
                {card.title}
              </span>
              <div className="flex items-baseline justify-between mt-0.5">
                <span className="text-2xl font-black text-slate-800 tracking-tight">
                  {card.value}
                </span>
                
                {/* Visual sparklines right-aligned inside card */}
                <div className="w-16 h-8 flex items-end justify-end">
                  {card.barChart ? (
                    <MiniBarChart data={card.barChartData} />
                  ) : (
                    card.sparklinePath && (
                      <Sparkline path={card.sparklinePath} strokeColor={card.sparklineColor} />
                    )
                  )}
                </div>
              </div>
            </div>

            {/* Bottom row: subtext */}
            <div className="text-[10px] text-slate-500 font-medium truncate mt-1">
              {card.subtext}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
