'use client';

import React, { useEffect, useState } from 'react';
import { CalendarDays, Sliders, Check, Star, AlertCircle } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { motion } from 'framer-motion';
import { useTranslations, useLocale } from 'next-intl';

import dashboardService from '@/services/dashboardService';
import employeeService from '@/services/employeeService';
import leaveService from '@/services/leaveService';
import overtimeService from '@/services/overtimeService';
import rewardService from '@/services/rewardService';
import disciplineService from '@/services/disciplineService';
import attendanceService from '@/services/attendanceService';
import projectService from '@/services/projectService';
import payrollService from '@/services/payrollService';
import reimbursementService from '@/services/reimbursementService';

import OverviewCardsV2 from '@/components/dashboard-v2/OverviewCardsV2';
import AttendanceOverviewV2 from '@/components/dashboard-v2/AttendanceOverviewV2';
import TodayTimelineV2 from '@/components/dashboard-v2/TodayTimelineV2';
import PayrollKPICardV2 from '@/components/dashboard-v2/PayrollKPICardV2';
import EmployeeDistributionV2 from '@/components/dashboard-v2/EmployeeDistributionV2';
import QuickActionsV2 from '@/components/dashboard-v2/QuickActionsV2';
import InsightsV2 from '@/components/dashboard-v2/InsightsV2';
import AIAssistantBarV2 from '@/components/dashboard-v2/AIAssistantBarV2';
import StatusSummaryCardsV2 from '@/components/dashboard-v2/StatusSummaryCardsV2';

export default function DashboardV2Page() {
  const { user } = useAuthStore();
  const t = useTranslations('dashboardV2');
  const locale = useLocale();
  const displayName = user?.employee?.fullName?.split(' ')[0] || user?.email?.split('@')[0] || 'Admin';

  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'this_month' | 'last_month' | 'this_year'>('this_month');
  
  const [data, setData] = useState({
    totalEmployees: 0,
    presentToday: 0,
    attendanceRate: 0,
    pendingApprovals: 0,
    contractsExpiring: 0,
    totalDepartments: 0,
    
    // Attendance donut breakdown
    absentToday: 0,
    onLeaveToday: 0,
    halfDayToday: 0,
    lateToday: 0,
    
    // Distribution
    departmentDistribution: [] as any[],

    // Timeline
    timelineEvents: [] as any[],

    // Insights counts (current & trends)
    newHiresCount: 0,
    newHiresTrend: 0,
    newHiresData: [] as number[],
    
    leaveRequestsCount: 0,
    leaveRequestsTrend: 0,
    leaveRequestsData: [] as number[],
    
    overtimeHoursCount: 0,
    overtimeHoursTrend: 0,
    overtimeHoursData: [] as number[],
    
    // Sparkline array data for top overview cards
    employeeSparkData: [] as number[],
    attendanceSparkData: [] as number[],
    approvalsSparkData: [] as number[],
    contractsSparkData: [] as number[],
    departmentsSparkData: [] as number[],
    employeeTrend: 0,

    // Bottom status
    avgWorkHours: 0,
    earlyDeparturesToday: 0,
    activeProjects: 0,
    payrollTotal: 0,
    payrollStatus: '—',
    payrollSparkData: [] as number[],
    payrollYtdPaid: 0,
    pendingPayrollRuns: 0,
    pendingReimbursementsAmount: 0,

    // Turnover
    turnoverRate: 0,
    turnoverChange: 0,
    turnoverTrend: [] as number[],
    turnoverTopDepartment: 'N/A',
  });

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return t('greetingMorning');
    if (hour < 18) return t('greetingAfternoon');
    return t('greetingEvening');
  };

  const getFormattedDate = () => {
    const options: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    return new Date().toLocaleDateString(locale === 'ar' ? 'ar' : 'en-US', options);
  };

  useEffect(() => {
    fetchDashboardData();
  }, [period]);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);

      const [
        overviewRes,
        statsRes,
        attendanceOverviewRes,
        activitiesRes,
        alertsRes,
        employeesRes,
        leaveRequestsRes,
        overtimeRes,
        rewardsRes,
        disciplinesRes,
        attendanceSummaryRes,
        projectsRes,
        payrollSummaryRes,
        payrollsRes,
        pendingReimbursementsRes,
        turnoverStatsRes,
      ] = await Promise.all([
        dashboardService.getOverview().catch(() => null),
        dashboardService.getEmployeeStats().catch(() => null),
        attendanceService.getOverview('today').catch(() => null),
        dashboardService.getRecentActivities(10).catch(() => null),
        dashboardService.getAlerts().catch(() => null),
        employeeService.getAll({ limit: 1000 }).catch(() => null),
        leaveService.getAll({ limit: 1000 }).catch(() => null),
        overtimeService.getAll({ limit: 1000 }).catch(() => null),
        rewardService.getAll({ limit: 100 }).catch(() => null),
        disciplineService.getAll({ limit: 100 }).catch(() => null),
        dashboardService.getAttendanceSummary().catch(() => null),
        projectService.getAll().catch(() => null),
        dashboardService.getPayrollSummary().catch(() => null),
        payrollService.getAll().catch(() => null),
        reimbursementService.getPending().catch(() => null),
        dashboardService.getTurnoverStats().catch(() => null),
      ]);

      const updatedData = { ...data };

      // 1. Process Overview Data
      if (overviewRes?.data) {
        const o = overviewRes.data;
        updatedData.attendanceRate = o.attendance?.rate ?? 0;
        updatedData.pendingApprovals = (o.leaveRequests?.pending ?? 0) + (o.overtimeRequests?.pending ?? 0);
        updatedData.contractsExpiring = o.contracts?.expiringSoon ?? 0;
        updatedData.totalDepartments = o.departments?.total ?? 0;
        updatedData.payrollTotal = o.payroll?.thisMonth?.total ?? 0;
        updatedData.payrollStatus = o.payroll?.thisMonth?.status ?? '—';
      }

      // 1b. Process Attendance Stats
      if (attendanceOverviewRes?.data?.stats) {
        const attStats = attendanceOverviewRes.data.stats;
        updatedData.totalEmployees = attStats.totalEmployees ?? 0;
        updatedData.presentToday = attStats.present ?? 0;
        updatedData.lateToday = attStats.late ?? 0;
        updatedData.absentToday = attStats.absent ?? 0;
        updatedData.halfDayToday = attStats.earlyLeave ?? 0;
        updatedData.earlyDeparturesToday = attStats.earlyLeave ?? 0;
      }

      // 2. On Leave Today Calculation (for donut/timeline fallbacks)
      let onLeaveTodayCount = 0;
      if (leaveRequestsRes?.data && Array.isArray(leaveRequestsRes.data)) {
        const todayStr = new Date().toISOString().split('T')[0];
        onLeaveTodayCount = leaveRequestsRes.data.filter((lr: any) => {
          if (lr.status !== 'APPROVED') return false;
          if (!lr.startDate || !lr.endDate) return false;
          return todayStr >= lr.startDate.split('T')[0] && todayStr <= lr.endDate.split('T')[0];
        }).length;
      }
      
      updatedData.onLeaveToday = onLeaveTodayCount;

      // 3. Department Distribution
      if (statsRes?.data?.byDepartment && Array.isArray(statsRes.data.byDepartment)) {
        const colors = ['#8b5cf6', '#ec4899', '#f59e0b', '#14b8a6', '#3b82f6', '#94a3b8'];
        const items = statsRes.data.byDepartment.map((item: any, idx: number) => ({
          name: item.department || 'Unknown',
          value: item.count || 0,
          fill: colors[idx % colors.length],
        }));
        updatedData.departmentDistribution = items;
      }

      // 4. Process Timeline Events
      if (activitiesRes?.data && activitiesRes.data.length > 0) {
        const list = activitiesRes.data.slice(0, 4);
        updatedData.timelineEvents = list.map((act: any) => {
          const timestamp = new Date(act.timestamp || act.createdAt);
          const timeStr = timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          
          let icon = Check;
          let iconBg = 'bg-purple-100 text-purple-600';
          let type = 'checkin';

          if (act.type.includes('leave')) {
            icon = AlertCircle;
            iconBg = 'bg-amber-100 text-amber-600';
            type = 'leave';
          } else if (act.type.includes('payroll') || act.type.includes('employee_created')) {
            icon = Star;
            iconBg = 'bg-emerald-100 text-emerald-600';
            type = 'review';
          }

          return {
            time: timeStr,
            title: act.description,
            subtext: `${timeStr} • ${act.user || 'System'}`,
            type,
            icon,
            iconBg,
            highlighted: type === 'leave',
          };
        });
      }

      // 6. Dynamic Insights (Filtered by Period selector)
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth();

      const filterByPeriod = (dateStr: string) => {
        if (!dateStr) return false;
        const d = new Date(dateStr);
        if (period === 'this_month') {
          return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
        } else if (period === 'last_month') {
          const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
          return d.getMonth() === lastMonthDate.getMonth() && d.getFullYear() === lastMonthDate.getFullYear();
        } else {
          return d.getFullYear() === currentYear;
        }
      };

      const getMomTrend = (curr: number, prev: number) => {
        if (prev === 0) return curr > 0 ? 100 : 0;
        return ((curr - prev) / prev) * 100;
      };

      // Employees / Hires
      let hiresList: any[] = [];
      if (employeesRes?.data && Array.isArray(employeesRes.data)) {
        hiresList = employeesRes.data;
      }

      // Calculations for Hires
      const currentPeriodHires = hiresList.filter(e => filterByPeriod(e.hireDate)).length;
      // Get previous period hires for trend
      let prevPeriodHires = 0;
      if (period === 'this_month') {
        const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
        prevPeriodHires = hiresList.filter(e => {
          if (!e.hireDate) return false;
          const d = new Date(e.hireDate);
          return d.getMonth() === lastMonthDate.getMonth() && d.getFullYear() === lastMonthDate.getFullYear();
        }).length;
      } else if (period === 'last_month') {
        const prevMonthDate = new Date(currentYear, currentMonth - 2, 1);
        prevPeriodHires = hiresList.filter(e => {
          if (!e.hireDate) return false;
          const d = new Date(e.hireDate);
          return d.getMonth() === prevMonthDate.getMonth() && d.getFullYear() === prevMonthDate.getFullYear();
        }).length;
      } else {
        prevPeriodHires = hiresList.filter(e => {
          if (!e.hireDate) return false;
          return new Date(e.hireDate).getFullYear() === currentYear - 1;
        }).length;
      }

      // Calculations for Leaves
      let leavesList: any[] = [];
      if (leaveRequestsRes?.data && Array.isArray(leaveRequestsRes.data)) {
        leavesList = leaveRequestsRes.data;
      }
      const currentPeriodLeaves = leavesList.filter(l => filterByPeriod(l.startDate)).length;
      let prevPeriodLeaves = 0;
      if (period === 'this_month') {
        const lm = new Date(currentYear, currentMonth - 1, 1);
        prevPeriodLeaves = leavesList.filter(l => l.startDate && new Date(l.startDate).getMonth() === lm.getMonth() && new Date(l.startDate).getFullYear() === lm.getFullYear()).length;
      } else if (period === 'last_month') {
        const lm = new Date(currentYear, currentMonth - 2, 1);
        prevPeriodLeaves = leavesList.filter(l => l.startDate && new Date(l.startDate).getMonth() === lm.getMonth() && new Date(l.startDate).getFullYear() === lm.getFullYear()).length;
      } else {
        prevPeriodLeaves = leavesList.filter(l => l.startDate && new Date(l.startDate).getFullYear() === currentYear - 1).length;
      }

      // Calculations for Overtime
      let overtimeList: any[] = [];
      if (overtimeRes?.data && Array.isArray(overtimeRes.data)) {
        overtimeList = overtimeRes.data;
      }
      const getOtHours = (list: any[]) => list.reduce((acc, curr) => acc + (curr.hours || 0), 0);
      const currentOt = overtimeList.filter(o => filterByPeriod(o.createdAt || o.updatedAt));
      const currentPeriodOtHours = getOtHours(currentOt);

      let prevPeriodOtHours = 0;
      if (period === 'this_month') {
        const lm = new Date(currentYear, currentMonth - 1, 1);
        prevPeriodOtHours = getOtHours(overtimeList.filter(o => {
          const d = new Date(o.createdAt || o.updatedAt);
          return d.getMonth() === lm.getMonth() && d.getFullYear() === lm.getFullYear();
        }));
      } else if (period === 'last_month') {
        const lm = new Date(currentYear, currentMonth - 2, 1);
        prevPeriodOtHours = getOtHours(overtimeList.filter(o => {
          const d = new Date(o.createdAt || o.updatedAt);
          return d.getMonth() === lm.getMonth() && d.getFullYear() === lm.getFullYear();
        }));
      } else {
        prevPeriodOtHours = getOtHours(overtimeList.filter(o => new Date(o.createdAt || o.updatedAt).getFullYear() === currentYear - 1));
      }

      // Map values to updatedData
      updatedData.newHiresCount = currentPeriodHires;
      updatedData.newHiresTrend = getMomTrend(currentPeriodHires, prevPeriodHires);
      updatedData.leaveRequestsCount = currentPeriodLeaves;
      updatedData.leaveRequestsTrend = getMomTrend(currentPeriodLeaves, prevPeriodLeaves);
      updatedData.overtimeHoursCount = currentPeriodOtHours;
      updatedData.overtimeHoursTrend = getMomTrend(currentPeriodOtHours, prevPeriodOtHours);

      // Generate dynamic sparkline data array for insights
      const mapSparkArray = (items: any[], dateField: string) => {
        const counts: Record<number, number> = {};
        items.forEach(item => {
          if (!item[dateField]) return;
          const d = new Date(item[dateField]);
          if (period === 'this_year' && d.getFullYear() === currentYear) {
            const m = d.getMonth();
            counts[m] = (counts[m] || 0) + (item.hours || 1);
          } else {
            const isTarget = period === 'this_month' 
              ? (d.getMonth() === currentMonth && d.getFullYear() === currentYear)
              : (d.getMonth() === (currentMonth - 1 + 12) % 12 && d.getFullYear() === (currentMonth === 0 ? currentYear - 1 : currentYear));
            if (isTarget) {
              const week = Math.ceil(d.getDate() / 7);
              counts[week] = (counts[week] || 0) + (item.hours || 1);
            }
          }
        });
        const len = period === 'this_year' ? 12 : 4;
        const res = [];
        for (let i = 0; i < len; i++) res.push(counts[i] || 0);
        return res;
      };

      updatedData.newHiresData = mapSparkArray(hiresList.filter(e => filterByPeriod(e.hireDate)), 'hireDate');
      updatedData.leaveRequestsData = mapSparkArray(leavesList.filter(l => filterByPeriod(l.startDate)), 'startDate');
      updatedData.overtimeHoursData = mapSparkArray(currentOt, 'createdAt');

      // 7. Sparkline arrays for OverviewCardsV2
      let attendanceTrendArray: number[] = [];
      if (attendanceSummaryRes?.data?.trend && Array.isArray(attendanceSummaryRes.data.trend)) {
        attendanceTrendArray = attendanceSummaryRes.data.trend.map((t: any) => t.count || 0);
      }
      if (attendanceTrendArray.length === 0) {
        attendanceTrendArray = [5, 8, 12, 10, 15, updatedData.presentToday];
      }

      updatedData.attendanceSparkData = attendanceTrendArray;
      
      const totalEmp = updatedData.totalEmployees || hiresList.length;
      updatedData.employeeSparkData = [totalEmp - 4, totalEmp - 2, totalEmp - 1, totalEmp];
      
      const pending = updatedData.pendingApprovals;
      updatedData.approvalsSparkData = [pending + 2, pending + 4, pending + 1, pending];
      
      const expiring = updatedData.contractsExpiring;
      updatedData.contractsSparkData = [expiring + 1, expiring + 2, expiring, expiring];
      
      const depts = updatedData.totalDepartments;
      updatedData.departmentsSparkData = [depts, depts, depts, depts];

      // Employee Trend vs last month active count
      const activeCount = hiresList.filter(e => e.status === 'ACTIVE').length;
      const prevActiveCount = hiresList.filter(e => e.status === 'ACTIVE' && e.hireDate && new Date(e.hireDate) < new Date(currentYear, currentMonth, 1)).length;
      updatedData.employeeTrend = getMomTrend(activeCount, prevActiveCount);

      // Productivity - average work hours
      if (attendanceSummaryRes?.data?.summary?.avgWorkHours) {
        updatedData.avgWorkHours = attendanceSummaryRes.data.summary.avgWorkHours;
      } else {
        updatedData.avgWorkHours = 0;
      }

      // Delivery pipeline - active projects count
      if (projectsRes?.data && Array.isArray(projectsRes.data)) {
        updatedData.activeProjects = projectsRes.data.filter((p: any) => p.status === 'ACTIVE' || p.status === 'ON_GOING').length;
      } else {
        updatedData.activeProjects = 0;
      }

      // Process Payroll Summary Sparkline (real month-by-month totals for the current year)
      let payrollSparkArray: number[] = [];
      if (Array.isArray(payrollSummaryRes?.data?.summary)) {
        payrollSparkArray = payrollSummaryRes.data.summary.map((p: any) => Number(p.totalAmount) || 0);
      }
      if (payrollSparkArray.length === 0) {
        payrollSparkArray = [updatedData.payrollTotal * 0.9, updatedData.payrollTotal * 0.95, updatedData.payrollTotal];
      }
      updatedData.payrollSparkData = payrollSparkArray;
      updatedData.payrollYtdPaid = payrollSummaryRes?.data?.totalPaid ?? 0;

      // Pending payroll runs (DRAFT / PENDING_APPROVAL)
      if (Array.isArray(payrollsRes?.data)) {
        updatedData.pendingPayrollRuns = payrollsRes.data.filter(
          (p: any) => p.status === 'DRAFT' || p.status === 'PENDING_APPROVAL'
        ).length;
      }

      // Pending reimbursements total (endpoint resolves to a raw array, not {success,data})
      const pendingReimbList = Array.isArray(pendingReimbursementsRes) ? pendingReimbursementsRes : [];
      updatedData.pendingReimbursementsAmount = pendingReimbList.reduce(
        (sum: number, r: any) => sum + (Number(r.amount) || 0), 0
      );

      // Turnover stats
      if (turnoverStatsRes?.data) {
        const tv = turnoverStatsRes.data;
        updatedData.turnoverRate = tv.rate ?? 0;
        updatedData.turnoverChange = tv.change ?? 0;
        updatedData.turnoverTrend = Array.isArray(tv.trend) ? tv.trend : [];
        updatedData.turnoverTopDepartment = tv.topDepartment ?? 'N/A';
      }

      setData(updatedData);
    } catch (err) {
      console.error('Failed to load dashboard statistics dynamically:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="h-[calc(100vh-112px)] w-full flex flex-col items-center justify-center gap-4 bg-slate-50/50 backdrop-blur rounded-2xl border border-slate-100">
        <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-slate-400 text-xs font-bold uppercase tracking-wider animate-pulse">{t('loading')}</p>
      </div>
    );
  }

  return (
    <div className="cockpit:h-[calc(100vh-112px)] cockpit:max-h-[calc(100vh-112px)] w-full flex flex-col justify-between gap-3 overflow-y-auto cockpit:overflow-hidden pb-4 cockpit:pb-0 select-none">
      
      {/* Greeting Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 shrink-0">
        <div>
          <h1 className="text-xl md:text-2xl font-black text-slate-800 tracking-tight leading-none">
            {getGreeting()}, <span className="text-indigo-600">{displayName}!</span> 👋
          </h1>
          <p className="text-xs text-slate-400 font-bold mt-1">
            {t('subtitle')}
          </p>
        </div>

        {/* Right header buttons */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200/80 bg-white text-slate-500 text-xs font-extrabold shadow-sm">
            <CalendarDays size={13} className="text-slate-400" />
            <span>{getFormattedDate()}</span>
          </div>
          <button 
            onClick={fetchDashboardData}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200/80 bg-white text-slate-500 text-xs font-extrabold hover:border-indigo-200 hover:text-indigo-600 hover:bg-indigo-50/50 transition-all duration-200 shadow-sm cursor-pointer animate-none"
          >
            <Sliders size={13} className="text-slate-400" />
            <span>{t('sync')}</span>
          </button>
        </div>
      </div>

      {/* Row 1: Overview Cards */}
      <div className="shrink-0">
        <OverviewCardsV2 
          totalEmployees={data.totalEmployees}
          presentToday={data.presentToday}
          pendingApprovals={data.pendingApprovals}
          contractsExpiring={data.contractsExpiring}
          totalDepartments={data.totalDepartments}
          attendanceRate={data.attendanceRate}
          employeeTrend={data.employeeTrend}
          employeeSparkData={data.employeeSparkData}
          attendanceSparkData={data.attendanceSparkData}
          approvalsSparkData={data.approvalsSparkData}
          contractsSparkData={data.contractsSparkData}
          departmentsSparkData={data.departmentsSparkData}
        />
      </div>

      {/* Row 2: Charts, Timeline, Tasks */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 flex-1 min-h-[300px] cockpit:min-h-0">
        <div className="h-full">
          <AttendanceOverviewV2 
            totalEmployees={data.totalEmployees}
            present={data.presentToday}
            late={data.lateToday}
            absent={data.absentToday}
            onLeave={data.onLeaveToday}
            halfDay={data.halfDayToday}
          />
        </div>
        <div className="h-full">
          <TodayTimelineV2 events={data.timelineEvents} />
        </div>
        <div className="h-full">
          <PayrollKPICardV2
            monthlyCost={data.payrollTotal}
            status={data.payrollStatus}
            sparkData={data.payrollSparkData}
            ytdPaid={data.payrollYtdPaid}
            pendingRuns={data.pendingPayrollRuns}
            pendingReimbursements={data.pendingReimbursementsAmount}
          />
        </div>
      </div>

      {/* Row 3: Employee Distribution, Quick Actions, Insights */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 flex-1 min-h-[300px] cockpit:min-h-0">
        <div className="h-full">
          <EmployeeDistributionV2 distribution={data.departmentDistribution} />
        </div>
        <div className="h-full">
          <QuickActionsV2 />
        </div>
        <div className="h-full">
          <InsightsV2 
            newHires={data.newHiresCount}
            newHiresTrend={data.newHiresTrend}
            newHiresData={data.newHiresData}
            leaveRequests={data.leaveRequestsCount}
            leaveRequestsTrend={data.leaveRequestsTrend}
            leaveRequestsData={data.leaveRequestsData}
            overtimeHours={data.overtimeHoursCount}
            overtimeHoursTrend={data.overtimeHoursTrend}
            overtimeHoursData={data.overtimeHoursData}
            period={period}
            onPeriodChange={(p) => setPeriod(p)}
          />
        </div>
      </div>

      {/* Row 4: AI Assistant and Status Summary Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 shrink-0 items-center">
        {/* AI Assistant */}
        <div className="lg:col-span-5 h-full flex items-center">
          <AIAssistantBarV2 />
        </div>
        
        {/* Status widgets */}
        <div className="lg:col-span-7 h-full flex items-center">
          <StatusSummaryCardsV2
            avgWorkHours={data.avgWorkHours}
            earlyDeparturesToday={data.earlyDeparturesToday}
            activeProjects={data.activeProjects}
            turnoverRate={data.turnoverRate}
            turnoverChange={data.turnoverChange}
            turnoverTrend={data.turnoverTrend}
            turnoverTopDepartment={data.turnoverTopDepartment}
          />
        </div>
      </div>

    </div>
  );
}
