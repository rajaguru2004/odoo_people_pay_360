'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, Building2, RefreshCw } from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { useTranslations } from 'next-intl';
import axiosInstance from '@/lib/axios';
import { chartColors } from '@/theme/chartColors';
import { formatCurrency as formatCurrencyGlobal, getCurrencyPrefix } from '@/utils/formatters';

interface DepartmentCost {
  departmentName: string;
  employeeCount: number;
  totalCost: number;
  avgCost: number;
  percentage: number;
  color: string;
}

const PALETTE = [
  '#006c49', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6',
  '#ec4899', '#06b6d4', '#ef4444', '#84cc16', '#f97316',
];

export default function PayrollCostByDepartment() {
  const [data, setData] = useState<DepartmentCost[]>([]);
  const t = useTranslations('payrollCostByDepartment');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [totalCost, setTotalCost] = useState(0);
  const [month, setMonth] = useState('');

  useEffect(() => {
    fetchPayrollCost();
  }, []);

  const fetchPayrollCost = async () => {
    try {
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1; // 1-indexed

      // Step 1: Get all payrolls for this year (year as Number, NOT string)
      const payrollsRes: any = await axiosInstance.get('/payrolls', {
        params: { year: Number(currentYear) },
      });

      const payrolls: any[] = Array.isArray(payrollsRes?.data)
        ? payrollsRes.data
        : (payrollsRes?.data?.data || []);

      // Step 2: Filter payrolls for current month (could be multiple batches)
      let targetMonth = currentMonth;
      let targetYear = currentYear;

      let thisMonthPayrolls = payrolls.filter(
        (p: any) => p.month === targetMonth && p.year === targetYear,
      );

      if (thisMonthPayrolls.length === 0 && payrolls.length > 0) {
        // Fallback to the latest available payroll month
        const latestPayroll = payrolls[0];
        targetMonth = latestPayroll.month;
        targetYear = latestPayroll.year;
        thisMonthPayrolls = payrolls.filter(
          (p: any) => p.month === targetMonth && p.year === targetYear,
        );
      }

      if (thisMonthPayrolls.length === 0) {
        // No payroll at all — clear data
        setData([]);
        setTotalCost(0);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      // Set display month label
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      setMonth(`${monthNames[targetMonth - 1]} ${targetYear}`);

      // Step 3: Fetch full payroll items for each batch payroll (includes employee + department)
      const detailPromises = thisMonthPayrolls.map((p: any) =>
        axiosInstance.get(`/payrolls/${p.id}`).catch(() => null),
      );
      const detailResults = await Promise.all(detailPromises);

      // Step 4: Aggregate netSalary by department across all batches
      const deptCosts: Record<string, { count: number; totalSalary: number }> = {};
      let grandTotal = 0;

      for (const result of detailResults) {
        if (!result) continue;
        // Axios interceptor returns response.data directly (the { success, data } object)
        const payrollDetail = (result as any)?.data ?? result;
        const items: any[] = payrollDetail?.items ?? [];

        for (const item of items) {
          const deptName: string =
            item.employee?.department?.name || 'Unassigned';
          const net = Number(item.netSalary ?? 0);

          if (!deptCosts[deptName]) {
            deptCosts[deptName] = { count: 0, totalSalary: 0 };
          }
          deptCosts[deptName].count++;
          deptCosts[deptName].totalSalary += net;
          grandTotal += net;
        }
      }

      // Step 5: Sort and format
      const costData: DepartmentCost[] = Object.entries(deptCosts)
        .map(([deptName, d], index) => ({
          departmentName: deptName,
          employeeCount: d.count,
          totalCost: d.totalSalary,
          avgCost: d.count > 0 ? d.totalSalary / d.count : 0,
          percentage: grandTotal > 0 ? (d.totalSalary / grandTotal) * 100 : 0,
          color: PALETTE[index % PALETTE.length],
        }))
        .sort((a, b) => b.totalCost - a.totalCost)
        .slice(0, 6); // Top 6 departments

      setData(costData);
      setTotalCost(grandTotal);
    } catch (error) {
      console.error('Failed to fetch payroll cost by department:', error);
      setData([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchPayrollCost();
  };

  const formatCurrency = (amount: number) => formatCurrencyGlobal(amount);

  const formatShort = (amount: number) => {
    const p = getCurrencyPrefix();
    const sep = p.length > 2 ? ' ' : ''; // space after an ISO code, none after a glyph
    if (amount >= 1_000_000) return `${p}${sep}${(amount / 1_000_000).toFixed(2)}M`;
    if (amount >= 1_000) return `${p}${sep}${(amount / 1_000).toFixed(1)}K`;
    return `${p}${sep}${amount.toFixed(0)}`;
  };

  if (loading) {
    return (
      <div className="surface-panel p-6 animate-pulse h-full">
        <div className="h-5 bg-surface-page rounded w-1/3 mb-4" />
        <div className="space-y-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="space-y-2">
              <div className="h-4 bg-surface-page rounded w-full" />
              <div className="h-2 bg-surface-page rounded-full w-2/3" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="surface-panel overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-surface-border-light">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-status-success to-status-success/70 flex items-center justify-center shadow-md shadow-status-success/20">
            <CurrencyIcon size={18} className="text-white" strokeWidth={2} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-heading">{t('title')}</h3>
            <p className="text-xs text-text-muted mt-0.5">
              {month ? `${month} payroll` : t('subtitle')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-1.5 hover:bg-surface-page rounded-lg transition-colors text-text-muted hover:text-brand-primary disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-status-success-bg rounded-full border border-status-success/20">
            <CurrencyIcon size={12} className="text-status-success" />
            <span className="text-xs font-extrabold text-status-success">
              {formatShort(totalCost)}
            </span>
          </div>
        </div>
      </div>

      {/* Department List */}
      <div className="px-6 py-4 space-y-3 flex-1 overflow-y-auto">
        {data.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-muted gap-3">
            <Building2 size={36} className="text-surface-border" />
            <p className="text-sm font-medium">{t('noDataAvailable')}</p>
            <p className="text-xs text-text-muted">No payroll processed for this month yet</p>
          </div>
        ) : (
          data.map((dept, index) => (
            <motion.div
              key={dept.departmentName}
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.07, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-2"
            >
              {/* Row: dot + name + count + cost */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-sm"
                    style={{
                      backgroundColor: dept.color,
                      boxShadow: `0 0 6px ${dept.color}60`,
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-text-body truncate leading-tight">
                      {dept.departmentName}
                    </p>
                    <p className="text-xs text-text-muted leading-tight">
                      {t('employeesCount', { count: dept.employeeCount })}
                    </p>
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-text-heading">
                    {formatShort(dept.totalCost)}
                  </p>
                  <p className="text-xs text-text-muted">
                    {dept.percentage.toFixed(1)}%
                  </p>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="w-full h-1.5 bg-surface-page rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${dept.percentage}%` }}
                  transition={{ delay: index * 0.07 + 0.15, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                  className="h-full rounded-full"
                  style={{ backgroundColor: dept.color }}
                />
              </div>

              {/* Avg per person */}
              <div className="flex items-center justify-between text-xs text-text-muted">
                <span>{t('avgPerPerson')}</span>
                <span className="font-semibold text-text-body">{formatShort(dept.avgCost)}</span>
              </div>
            </motion.div>
          ))
        )}
      </div>

      {/* Footer Total */}
      <div className="px-6 pb-5 mt-auto border-t border-surface-border-light pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-text-muted">
            <TrendingUp size={15} className="text-status-success" />
            <span className="text-sm font-medium">{t('totalCost')}</span>
          </div>
          <span className="text-base font-extrabold text-status-success">
            {formatCurrency(totalCost)}
          </span>
        </div>
      </div>
    </div>
  );
}
