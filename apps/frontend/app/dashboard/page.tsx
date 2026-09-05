'use client';

import { useState, Suspense, lazy } from 'react';
import { useTranslations } from 'next-intl';
import OverviewCards from '@/components/dashboard/OverviewCards';
import QuickActions from '@/components/dashboard/QuickActions';
import EmployeeDashboard from '@/components/dashboard/EmployeeDashboard';
import { useAuthStore } from '@/store/authStore';
import { LayoutDashboard, Users, Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import DashboardV2Page from '../dashboard-v2/page';
import { useBrandingStore } from '@/store/brandingStore';


const DepartmentDistribution = lazy(() => import('@/components/dashboard/DepartmentDistribution'));
const RecentActivities = lazy(() => import('@/components/dashboard/RecentActivities'));
const CriticalAlertsHub = lazy(() => import('@/components/dashboard/CriticalAlertsHub'));
const EmployeeGrowthChart = lazy(() => import('@/components/dashboard/EmployeeGrowthChart'));
const AbsenteeismRate = lazy(() => import('@/components/dashboard/AbsenteeismRate'));
const PayrollCostByDepartment = lazy(() => import('@/components/dashboard/PayrollCostByDepartment'));
const TodaySnapshot = lazy(() => import('@/components/dashboard/TodaySnapshot'));
const VisaExpiryWidget = lazy(() => import('@/components/dashboard/VisaExpiryWidget'));

// Skeleton matching new kpi-card aesthetic
const ChartSkeleton = () => (
  <div className="surface-panel p-6 animate-pulse">
    <div className="flex items-center justify-between mb-5">
      <div className="space-y-2">
        <div className="h-4 bg-surface-page rounded-lg w-32" />
        <div className="h-3 bg-surface-page rounded w-20" />
      </div>
      <div className="w-11 h-11 rounded-xl bg-surface-page" />
    </div>
    <div className="h-48 bg-surface-page rounded-xl" />
  </div>
);

interface DashboardGreetingProps {
  selectedDate: string;
  setSelectedDate: (date: string) => void;
}

function DashboardGreeting({ selectedDate, setSelectedDate }: DashboardGreetingProps) {
  const { user } = useAuthStore();
  const displayName = user?.employee?.fullName?.split(' ')[0] || user?.email?.split('@')[0] || 'Admin';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4"
    >
      {/* Left: Greeting */}
      <div>
        {/* Dashboard label */}
        <div className="flex items-center gap-2 mb-2">
          <LayoutDashboard size={14} className="text-brand-primary" strokeWidth={2.5} />
          <span className="text-xs font-bold text-text-muted uppercase tracking-[0.1em]">Dashboard</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold text-text-heading tracking-tight leading-none">
          {greeting}, <span className="text-brand-primary">{displayName}!</span> 👋
        </h1>
        <p className="text-sm text-text-muted mt-2 font-medium">
          Here's a snapshot of your organization's activity today.
        </p>
      </div>

      {/* Right: Action buttons (Commented out as requested)
      <div className="flex items-center gap-3 shrink-0">
        <button className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-surface-border bg-surface-card text-text-body text-sm font-semibold hover:border-brand-primary/40 hover:text-brand-primary hover:bg-brand-primary/5 transition-all duration-200 shadow-sm">
          <Download size={14} strokeWidth={2.5} className="shrink-0" />
          <span className="hidden sm:inline">Export Report</span>
        </button>
        <button className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-primary text-text-on-brand text-sm font-bold hover:bg-brand-primary-dark transition-all duration-200 shadow-lg shadow-brand-primary/25">
          <Sliders size={14} strokeWidth={2.5} className="shrink-0" />
          <span className="hidden sm:inline">Custom View</span>
        </button>
      </div>
      */}
    </motion.div>
  );
}

/** Section header with thick left accent bar + uppercase label */
function SectionHeader({
  label,
  icon: Icon,
  colorClass,
  dividerClass,
}: {
  label: string;
  icon?: React.ElementType;
  colorClass: string;
  dividerClass: string;
}) {
  return (
    <div className="flex items-center gap-3 mb-1">
      <div className={`h-6 w-1.5 rounded-full ${colorClass}`} />
      {Icon && <Icon size={15} className={colorClass.replace('bg-', 'text-')} strokeWidth={2.5} />}
      <h2 className={`text-xs font-extrabold uppercase tracking-[0.12em] ${colorClass.replace('bg-', 'text-')}`}>
        {label}
      </h2>
      <div className={`flex-1 h-px ${dividerClass}`} />
    </div>
  );
}

export default function DashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { user } = useAuthStore();
  const dashboardLayout = useBrandingStore((s) => s.branding.dashboard_layout);
  const t = useTranslations('dashboardPage');

  const getLocalDateString = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const [selectedDate, setSelectedDate] = useState(getLocalDateString());

  const handleRefresh = () => {
    setRefreshKey(prev => prev + 1);
  };

  // Employee role gets a personalized dashboard
  if (user?.role === 'EMPLOYEE') {
    return (
      <>
        <EmployeeDashboard />
      </>
    );
  }

  // Admin / HR_MANAGER / MANAGER get the full management dashboard —
  // layout is an org-wide setting (Settings → General → Dashboard layout),
  // persisted in the backend and loaded via the branding store.
  if (dashboardLayout === 'v1') {
    return (
      <div className="space-y-8 pb-6">

        {/* Greeting Header */}
        <DashboardGreeting selectedDate={selectedDate} setSelectedDate={setSelectedDate} />

        {/* KPI Overview Cards */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
        >
          <OverviewCards key={`overview-${selectedDate}`} date={selectedDate} />
        </motion.div>

        {/* SECTION 1: WORKFORCE OVERVIEW */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-5"
        >
          <SectionHeader
            label={t('personnelOverview')}
            icon={Users}
            colorClass="bg-brand-primary"
            dividerClass="bg-surface-border"
          />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Suspense fallback={<ChartSkeleton />}>
              <EmployeeGrowthChart key={`growth-${selectedDate}`} />
            </Suspense>
            <Suspense fallback={<ChartSkeleton />}>
              <DepartmentDistribution key={`department-${selectedDate}`} />
            </Suspense>
          </div>
        </motion.div>

        {/* SECTION 2: ATTENDANCE, ALERTS & PAYROLL */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-5"
        >
          <SectionHeader
            label="Operations & Alerts"
            icon={Clock}
            colorClass="bg-status-success"
            dividerClass="bg-surface-border"
          />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            {/* Left Column: Absenteeism + Critical Alerts */}
            <div className="flex flex-col gap-6">
              {user?.role !== 'MANAGER' && (
                <div className="shrink-0">
                  <Suspense fallback={<ChartSkeleton />}>
                    <AbsenteeismRate key={`absenteeism-${selectedDate}`} />
                  </Suspense>
                </div>
              )}
              <div className={user?.role === 'MANAGER' ? "w-full lg:col-span-2" : "flex-1"}>
                <Suspense fallback={<ChartSkeleton />}>
                  <CriticalAlertsHub key={`alerts-${selectedDate}`} />
                </Suspense>
              </div>
            </div>

            {/* Right Column: Payroll Costs + Visa Expiry */}
            {user?.role !== 'MANAGER' && (
              <div className="flex flex-col gap-6 h-full min-h-[400px]">
                <Suspense fallback={<ChartSkeleton />}>
                  <PayrollCostByDepartment key={`cost-${selectedDate}`} />
                </Suspense>
                <Suspense fallback={<ChartSkeleton />}>
                  <VisaExpiryWidget key={`visas-${selectedDate}`} />
                </Suspense>
              </div>
            )}
          </div>
        </motion.div>

        {/* Recent Activities — Full Width */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          <Suspense fallback={<ChartSkeleton />}>
            <RecentActivities key={`activities-${selectedDate}`} />
          </Suspense>
        </motion.div>

        {/* Two-column row: Today Snapshot + Quick Actions (Moved to bottom) */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.26, ease: [0.22, 1, 0.36, 1] }}
          className="grid grid-cols-1 xl:grid-cols-5 gap-6"
        >
          {/* Today Snapshot — wider column */}
          <div className="xl:col-span-3">
            <Suspense fallback={<ChartSkeleton />}>
              <TodaySnapshot key={`snapshot-${selectedDate}`} date={selectedDate} />
            </Suspense>
          </div>

          {/* Quick Actions — narrower column */}
          <div className="xl:col-span-2">
            <QuickActions />
          </div>
        </motion.div>
      </div>
    );
  }

  return <DashboardV2Page />;
}

