'use client';

import React, { useEffect, useState } from 'react';
import { Users, Clock, Calendar, AlertCircle, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import dashboardService from '@/services/dashboardService';
import { useAuthStore } from '@/store/authStore';

interface CardData {
  title: string;
  value: string | number;
  change: number;
  icon: React.ElementType;
  color: string;
  bgColor: string;
  accentClass: string;
  iconGradient: string;
  glowColor: string;
  subtitle?: string;
  sparkPath: string;
  strokeColor: string;
}

/** Animated SVG wave sparkline */
function Sparkline({ path, strokeColor }: { path: string; strokeColor: string }) {
  return (
    <div className="sparkline-mask w-full h-9 overflow-hidden">
      <svg
        viewBox="0 0 120 32"
        preserveAspectRatio="none"
        className="w-full h-full"
        fill="none"
      >
        {/* Fill area */}
        <defs>
          <linearGradient id={`fill-${strokeColor.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.18" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d={path + ' L120,32 L0,32 Z'}
          fill={`url(#fill-${strokeColor.replace('#', '')})`}
        />
        {/* Line */}
        <path
          d={path}
          stroke={strokeColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** Mini bar sparkline in card footer */
function MiniBarSparkline({ positive }: { positive: boolean }) {
  const heights = [35, 52, 42, 68, 58, 80, 72];
  return (
    <div className="flex items-end gap-[2px] h-7">
      {heights.map((h, i) => (
        <div
          key={i}
          className={`w-[3px] rounded-sm transition-all duration-300 ${
            positive ? 'bg-status-success/50' : 'bg-status-error/50'
          }`}
          style={{ height: `${h}%` }}
        />
      ))}
    </div>
  );
}

const SPARK_PATHS = {
  staff:    'M0,22 C10,20 20,16 30,18 C40,20 50,12 60,14 C70,16 80,8 90,10 C100,12 110,6 120,8',
  active:   'M0,18 C10,22 20,14 30,20 C40,26 50,10 60,16 C70,22 80,12 90,8 C100,4 110,10 120,6',
  approval: 'M0,24 C20,22 40,20 60,22 C80,24 100,18 120,20',
  contract: 'M0,16 L120,16',
};

export default function OverviewCards({ date }: { date?: string }) {
  const { user } = useAuthStore();
  const t = useTranslations('overviewCards');

  const [data, setData] = useState<CardData[]>([
    {
      title: t('generalStaff'),
      value: '—',
      change: 0,
      icon: Users,
      color: 'text-brand-primary',
      bgColor: 'bg-brand-primary/10',
      accentClass: 'border-l-brand-primary',
      iconGradient: 'from-brand-primary to-brand-primary-dark',
      glowColor: 'shadow-brand-primary/20',
      subtitle: 'Total employees',
      sparkPath: SPARK_PATHS.staff,
      strokeColor: 'var(--color-brand-primary)',
    },
    {
      title: t('active'),
      value: '—',
      change: 0,
      icon: Clock,
      color: 'text-brand-accent',
      bgColor: 'bg-brand-accent/10',
      accentClass: 'border-l-brand-accent',
      iconGradient: 'from-brand-accent to-brand-accent-dark',
      glowColor: 'shadow-brand-accent/20',
      subtitle: 'Present / Total',
      sparkPath: SPARK_PATHS.active,
      strokeColor: 'var(--color-brand-accent)',
    },
    {
      title: t('pendingApproval'),
      value: '—',
      change: 0,
      icon: Calendar,
      color: 'text-status-info',
      bgColor: 'bg-status-info-bg',
      accentClass: 'border-l-status-info',
      iconGradient: 'from-status-info to-status-info/70',
      glowColor: 'shadow-status-info/20',
      subtitle: 'Requires your action',
      sparkPath: SPARK_PATHS.approval,
      strokeColor: 'var(--color-status-info)',
    },
    {
      title: t('expiringContract'),
      value: '—',
      change: 0,
      icon: AlertCircle,
      color: 'text-status-warning',
      bgColor: 'bg-status-warning-bg',
      accentClass: 'border-l-status-warning',
      iconGradient: 'from-status-warning to-status-warning/70',
      glowColor: 'shadow-status-warning/20',
      subtitle: 'In next 30 days',
      sparkPath: SPARK_PATHS.contract,
      strokeColor: 'var(--color-status-warning)',
    },
  ]);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOverview();
  }, [date]);

  const fetchOverview = async () => {
    try {
      setLoading(true);
      const response = await dashboardService.getOverview(date);
      const overviewData = response.data;
      if (!overviewData) return;

      const totalEmployees = overviewData.employees?.total || 0;
      const activeEmployees = overviewData.employees?.active || 0;
      const pendingLeaveRequests = overviewData.leaveRequests?.pending || 0;
      const pendingOvertimeRequests = overviewData.overtimeRequests?.pending || 0;
      const totalPendingRequests = pendingLeaveRequests + pendingOvertimeRequests;
      const expiringContracts = overviewData.contracts?.expiringSoon || 0;
      const attendanceRate = overviewData.attendance?.rate || 0;

      setData([
        {
          title: t('generalStaff'),
          value: totalEmployees,
          change: attendanceRate,
          icon: Users,
          color: 'text-brand-primary',
          bgColor: 'bg-brand-primary/10',
          accentClass: 'border-l-brand-primary',
          iconGradient: 'from-brand-primary to-brand-primary-dark',
          glowColor: 'shadow-brand-primary/20',
          subtitle: 'Total employees',
          sparkPath: SPARK_PATHS.staff,
          strokeColor: 'var(--color-brand-primary)',
        },
        {
          title: t('active'),
          value: `${activeEmployees}/${totalEmployees}`,
          change: totalEmployees > 0 ? Math.round((activeEmployees / totalEmployees) * 100) : 0,
          icon: Clock,
          color: 'text-brand-accent',
          bgColor: 'bg-brand-accent/10',
          accentClass: 'border-l-brand-accent',
          iconGradient: 'from-brand-accent to-brand-accent-dark',
          glowColor: 'shadow-brand-accent/20',
          subtitle: `${totalEmployees > 0 ? Math.round((activeEmployees / totalEmployees) * 100) : 0}% attendance`,
          sparkPath: SPARK_PATHS.active,
          strokeColor: 'var(--color-brand-accent)',
        },
        {
          title: t('pendingApproval'),
          value: totalPendingRequests,
          change: totalPendingRequests > 0 ? totalPendingRequests : 0,
          icon: Calendar,
          color: 'text-status-info',
          bgColor: 'bg-status-info-bg',
          accentClass: 'border-l-status-info',
          iconGradient: 'from-status-info to-status-info/70',
          glowColor: 'shadow-status-info/20',
          subtitle: 'Requires your action',
          sparkPath: SPARK_PATHS.approval,
          strokeColor: 'var(--color-status-info)',
        },
        {
          title: t('expiringContract'),
          value: expiringContracts,
          change: expiringContracts > 0 ? -expiringContracts : 0,
          icon: AlertCircle,
          color: 'text-status-warning',
          bgColor: 'bg-status-warning-bg',
          accentClass: 'border-l-status-warning',
          iconGradient: 'from-status-warning to-status-warning/70',
          glowColor: 'shadow-status-warning/20',
          subtitle: 'In next 30 days',
          sparkPath: SPARK_PATHS.contract,
          strokeColor: 'var(--color-status-warning)',
        },
      ]);
    } catch (error) {
      console.error('Failed to fetch overview:', error);
    } finally {
      setLoading(false);
    }
  };

  const isManager = user?.role === 'MANAGER';
  const filteredCards = data.filter(card => {
    if (isManager && card.title === t('expiringContract')) return false;
    return true;
  });

  if (loading) {
    return (
      <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5`}>
        {[1, 2, 3, 4].slice(0, isManager ? 3 : 4).map(i => (
          <div key={i} className="kpi-card rounded-2xl border-l-4 border-l-surface-border animate-pulse overflow-hidden">
            <div className="p-6 space-y-5">
              <div className="flex items-start justify-between">
                <div className="w-12 h-12 rounded-xl bg-surface-page" />
                <div className="h-6 w-16 bg-surface-page rounded-full" />
              </div>
              <div className="space-y-2">
                <div className="h-3 bg-surface-page rounded w-24" />
                <div className="h-9 bg-surface-page rounded-lg w-2/3" />
                <div className="h-3 bg-surface-page rounded w-1/2" />
              </div>
              <div className="h-9 bg-surface-page rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-${filteredCards.length} gap-5`}>
      {filteredCards.map((card, index) => {
        const Icon = card.icon;
        const isPositive = card.change >= 0;
        const TrendIcon = isPositive ? TrendingUp : TrendingDown;
        const ArrowIcon = isPositive ? ArrowUpRight : ArrowDownRight;

        return (
          <motion.div
            key={card.title}
            initial={{ opacity: 0, y: 28, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ delay: index * 0.09, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className={`kpi-card group relative rounded-2xl border-l-4 ${card.accentClass} overflow-hidden cursor-pointer`}
          >
            {/* Hover ambient glow */}
            <div className={`absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none bg-gradient-to-br from-brand-primary/3 to-transparent`} />

            <div className="p-6">
              {/* Top row: icon + trend badge */}
              <div className="flex items-start justify-between mb-5">
                {/* Icon container — gradient with glow shadow */}
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${card.iconGradient} flex items-center justify-center shadow-lg ${card.glowColor} group-hover:scale-110 group-hover:shadow-xl transition-all duration-300`}>
                  <Icon className="text-white" size={22} strokeWidth={2} />
                </div>

                {/* Trend badge */}
                <div className={`flex items-center gap-1 text-xs font-bold px-2.5 py-1.5 rounded-full border ${
                  isPositive
                    ? 'bg-status-success-bg text-status-success border-status-success/20'
                    : 'bg-status-error-bg text-status-error border-status-error/20'
                }`}>
                  <TrendIcon size={10} strokeWidth={2.5} />
                  <span>{Math.abs(card.change)}%</span>
                </div>
              </div>

              {/* Label */}
              <p className="text-[11px] font-bold text-text-muted uppercase tracking-[0.08em] mb-2">
                {card.title}
              </p>

              {/* Value — large, bold, tight */}
              <h3 className="text-4xl font-extrabold text-text-heading tracking-tight leading-none mb-1">
                {card.value}
              </h3>

              {/* Subtitle with arrow icon */}
              {card.subtitle && (
                <p className={`text-xs font-medium mt-1.5 flex items-center gap-1 ${
                  isPositive ? 'text-status-success' : 'text-status-error'
                }`}>
                  <ArrowIcon size={11} strokeWidth={2.5} />
                  {card.subtitle}
                </p>
              )}

              {/* Sparkline — bottom of card */}
              <div className="mt-5 -mx-1">
                <Sparkline path={card.sparkPath} strokeColor={card.strokeColor} />
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
