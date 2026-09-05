'use client';

import React, { useState, useEffect } from 'react';
import {
  UserPlus, Clock, FileText, Users, Calendar,
  Award, TrendingUp, ChevronDown, Search, Zap, BarChart3, ArrowRight
} from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import axiosInstance from '@/lib/axios';
import { useAuthStore } from '@/store/authStore';

interface BadgeCounts {
  pendingLeaves: number;
  expiringContracts: number;
  pendingCorrections: number;
  todayAttendance: number;
}

interface ActionItem {
  icon: any;
  label: string;
  description: string;
  link: string;
  category: string;
  badge: number | null;
  badgeColor?: string;
  bgGradient?: string;
  iconColor?: string;
  urgent?: boolean;
}

export default function QuickActions() {
  const router = useRouter();
  const { user } = useAuthStore();
  const t = useTranslations('quickActions');
  const [showAllActions, setShowAllActions] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [badges, setBadges] = useState<BadgeCounts>({
    pendingLeaves: 0,
    expiringContracts: 0,
    pendingCorrections: 0,
    todayAttendance: 0,
  });

  const fetchBadgeCounts = async () => {
    if (!user) return;
    try {
      const isAdminOrHR = user.role === 'ADMIN' || user.role === 'HR_MANAGER';
      const calls: Promise<any>[] = [
        axiosInstance.get('/leave-requests').catch(() => ({ data: [] })),
      ];

      if (isAdminOrHR) {
        calls.push(axiosInstance.get('/contracts').catch(() => ({ data: [] })));
        calls.push(axiosInstance.get('/attendances/today/all').catch(() => ({ data: [] })));
      } else {
        calls.push(Promise.resolve({ data: [] }));
        calls.push(axiosInstance.get('/dashboard/today-snapshot').catch(() => ({ data: null })));
      }

      const [leavesRes, contractsRes, attendanceOrSnapshotRes] = await Promise.all(calls);

      const pendingLeaves = leavesRes.data?.filter((l: any) => l.status === 'PENDING').length || 0;

      let expiringContracts = 0;
      if (isAdminOrHR && contractsRes.data) {
        const now = new Date();
        const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        expiringContracts = contractsRes.data.filter((c: any) => {
          if (c.status !== 'ACTIVE' || !c.endDate) return false;
          const endDate = new Date(c.endDate);
          return endDate >= now && endDate <= in30Days;
        }).length;
      }

      const todayAttendance = isAdminOrHR
        ? (attendanceOrSnapshotRes.data?.length || 0)
        : (attendanceOrSnapshotRes?.data?.workingNow || 0);

      setBadges({ pendingLeaves, expiringContracts, pendingCorrections: 0, todayAttendance });
    } catch (error) {
      console.error('Failed to fetch badge counts:', error);
    }
  };

  useEffect(() => {
    if (!user) return;
    fetchBadgeCounts();
    const interval = setInterval(fetchBadgeCounts, 60000);
    return () => clearInterval(interval);
  }, [user]);

  const primaryActions: ActionItem[] = [
    ...(user?.role === 'ADMIN' || user?.role === 'HR_MANAGER' ? [{
      icon: UserPlus,
      label: t('moreStaffLabel'),
      description: t('moreStaffDesc'),
      iconColor: 'text-white',
      bgGradient: 'from-brand-primary to-brand-primary-dark',
      link: '/dashboard/employees/new',
      category: t('categoryHumanResources'),
      badge: null,
    }] : []),
    {
      icon: Clock,
      label: t('checkInTodayLabel'),
      description: t('checkInTodayDesc'),
      iconColor: 'text-white',
      bgGradient: 'from-brand-accent to-brand-accent-dark',
      link: '/dashboard/attendance',
      category: t('categoryTime'),
      badge: badges.todayAttendance,
      badgeColor: 'bg-white text-brand-accent',
    },
    ...(user?.role === 'ADMIN' || user?.role === 'HR_MANAGER' || user?.role === 'MANAGER' ? [{
      icon: FileText,
      label: t('approveLeaveLabel'),
      description: t('approveLeaveDesc'),
      iconColor: 'text-white',
      bgGradient: 'from-status-info to-status-info/80',
      link: '/dashboard/leaves?status=pending',
      category: t('categoryApprove'),
      badge: badges.pendingLeaves,
      badgeColor: 'bg-white text-status-info',
      urgent: badges.pendingLeaves > 10,
    }] : []),
    ...(user?.role === 'ADMIN' || user?.role === 'HR_MANAGER' ? [{
      icon: CurrencyIcon,
      label: t('contractExtensionLabel'),
      description: t('contractExtensionDesc'),
      iconColor: 'text-white',
      bgGradient: 'from-status-success to-status-success/80',
      link: '/dashboard/employees?filter=expiring-contracts',
      category: t('categoryContract'),
      badge: badges.expiringContracts,
      badgeColor: 'bg-white text-status-success',
      urgent: badges.expiringContracts > 5,
    }] : []),
  ];

  const secondaryActions: ActionItem[] = [
    {
      icon: Users,
      label: t('departmentsLabel'),
      description: t('departmentsDesc'),
      link: user?.role === 'MANAGER' ? '/dashboard/my-department' : '/dashboard/departments',
      category: t('categoryHumanResources'),
      badge: null,
    },
    {
      icon: Award,
      label: t('rewardLabel'),
      description: t('rewardDesc'),
      link: user?.role === 'MANAGER' ? '/dashboard/rewards-disciplines' : '/dashboard/rewards',
      category: t('categoryWelfare'),
      badge: null,
    },
    {
      icon: TrendingUp,
      label: t('reportLabel'),
      description: t('reportDesc'),
      link: '/dashboard/attendance/reports',
      category: t('categoryReport'),
      badge: null,
    },
    ...(user?.role === 'ADMIN' || user?.role === 'HR_MANAGER' ? [{
      icon: BarChart3,
      label: t('salaryManagementLabel'),
      description: t('salaryManagementDesc'),
      link: '/dashboard/payroll',
      category: t('categoryWage'),
      badge: null,
    }] : []),
  ];

  const allActions = [...primaryActions, ...secondaryActions];
  const filteredActions = searchQuery
    ? allActions.filter(action =>
        action.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        action.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        action.category.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : allActions;

  return (
    <div className="surface-panel overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-surface-border-light">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand-primary to-brand-accent flex items-center justify-center shadow-lg shadow-brand-primary/20">
            <Zap className="text-white" size={18} strokeWidth={2} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-heading">{t('title')}</h3>
            <p className="text-xs text-text-muted mt-0.5">{t('subtitle')}</p>
          </div>
        </div>

        <button
          onClick={() => setShowAllActions(!showAllActions)}
          className="flex items-center gap-1 text-xs font-semibold text-brand-primary hover:text-brand-primary-dark transition-colors"
        >
          {showAllActions ? t('collapse') : t('seeAll')}
          <ChevronDown
            size={13}
            className={`transition-transform duration-200 ${showAllActions ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {/* Primary Actions — 2×2 gradient tiles */}
      <div className="grid grid-cols-2 gap-3 p-4">
        {primaryActions.map((action, index) => {
          const Icon = action.icon;
          return (
            <motion.button
              key={action.label}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: index * 0.07, duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              onClick={() => router.push(action.link)}
              className={`
                group relative flex flex-col items-center justify-center gap-2.5 p-4 rounded-xl
                bg-gradient-to-br ${action.bgGradient}
                transition-all duration-200 shadow-md hover:shadow-xl hover:scale-[1.04] cursor-pointer
                min-h-[108px]
              `}
            >
              {/* Urgent ring pulse */}
              {action.urgent && action.badge && action.badge > 0 && (
                <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 z-10">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-error opacity-75" />
                  <span className="relative inline-flex rounded-full h-4 w-4 bg-status-error items-center justify-center text-white text-[9px] font-bold">!</span>
                </span>
              )}

              {/* Badge count */}
              {action.badge !== null && action.badge > 0 && !action.urgent && (
                <div className={`absolute -top-2 -right-2 min-w-[22px] h-5 px-1.5 rounded-full ${action.badgeColor} flex items-center justify-center font-bold text-xs shadow-lg z-10`}>
                  {action.badge > 99 ? '99+' : action.badge}
                </div>
              )}

              {/* White sheen on hover */}
              <div className="absolute inset-0 opacity-0 group-hover:opacity-15 transition-opacity duration-300 bg-white rounded-xl pointer-events-none" />

              <div className="relative">
                <Icon className="text-white" size={26} strokeWidth={1.8} />
              </div>
              <div className="text-center">
                <span className="block text-sm font-bold text-white leading-tight">
                  {action.label}
                </span>
                <span className="block text-[11px] text-white/75 mt-0.5 leading-tight">
                  {action.description}
                </span>
              </div>
            </motion.button>
          );
        })}
      </div>

      {/* Secondary Actions — expandable */}
      <AnimatePresence>
        {showAllActions && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 border-t border-surface-border-light pt-3">
              {/* Search */}
              <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={13} />
                <input
                  type="text"
                  placeholder={t('searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 border border-surface-border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-surface-page text-text-body"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                {(searchQuery ? filteredActions : secondaryActions).map((action, index) => {
                  const Icon = action.icon;
                  return (
                    <motion.button
                      key={action.label}
                      initial={{ opacity: 0, scale: 0.92 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: index * 0.04 }}
                      onClick={() => router.push(action.link)}
                      className="group relative flex items-center gap-2.5 p-3 rounded-xl bg-surface-page border border-surface-border hover:border-brand-primary/40 hover:bg-brand-primary/5 transition-all cursor-pointer text-start"
                    >
                      {action.badge !== null && action.badge > 0 && (
                        <div className={`absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full ${action.badgeColor || 'bg-status-error text-white'} flex items-center justify-center font-bold text-[10px] shadow-md z-10`}>
                          {action.badge > 99 ? '99+' : action.badge}
                        </div>
                      )}
                      <div className="w-8 h-8 rounded-lg bg-surface-card border border-surface-border group-hover:bg-brand-primary/10 group-hover:border-brand-primary/30 flex items-center justify-center transition-colors flex-shrink-0">
                        <Icon className="text-text-muted group-hover:text-brand-primary transition-colors" size={15} />
                      </div>
                      <div className="min-w-0">
                        <span className="block text-xs font-semibold text-text-body group-hover:text-brand-primary transition-colors truncate">
                          {action.label}
                        </span>
                        <span className="block text-[10px] text-text-muted truncate mt-0.5">
                          {action.category}
                        </span>
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
