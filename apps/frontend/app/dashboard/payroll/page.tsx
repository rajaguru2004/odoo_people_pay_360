'use client';

import { toast } from '@/lib/toast';
import { apiErrorMessage } from '@/utils/apiError';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Eye, Calendar, TrendingUp, AlertCircle, Info } from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { motion } from 'framer-motion';
import payrollService from '@/services/payrollService';
import systemSettingsService from '@/services/systemSettingsService';
import { useAuthStore } from '@/store/authStore';
import { PayrollItem, Payroll } from '@/types/payroll';

// RBAC
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePermission } from '@/hooks/usePermission';
import { usePageHeader } from '@/hooks/usePageHeader';
import DataCard from '@/components/common/DataCard';
import EmptyState from '@/components/common/EmptyState';
import { SkeletonList } from '@/components/common/Skeleton';

// Extended type to include parent payroll info
type PayrollItemWithPeriod = PayrollItem & {
  month?: number;
  year?: number;
  status?: string;
};
import { formatCurrency, formatCurrencyWithConfig, formatDate, getCompanyTz } from '@/utils/formatters';
import { impliedDailyRate, isDailyWage } from '@/utils/payBasis';

// Payroll config read from system settings (defaults = Indian rules)
interface PayrollDisplayConfig {
  currencySymbol: string;
  currency: string;
  pfEnabled: boolean;
  pfEmployeeRate: number;
  pfSalaryCap: number;
  esiEnabled: boolean;
  esiEmployeeRate: number;
  esiSalaryCap: number;
  taxRegime: string;
  standardDeduction: number;
  taxRebateEnabled: boolean;
  taxRebateLimit: number;
  cessEnabled: boolean;
  cessRate: number;
  // Dynamic labels
  pfLabel: string;
  taxLabel: string;
  netSalaryLabel: string;
}

const INDIA_DISPLAY_CONFIG: PayrollDisplayConfig = {
  currencySymbol: '₹',
  currency: 'INR',
  pfEnabled: true,
  pfEmployeeRate: 0.12,
  pfSalaryCap: 15000,
  esiEnabled: true,
  esiEmployeeRate: 0.0075,
  esiSalaryCap: 21000,
  taxRegime: 'new',
  standardDeduction: 75000,
  taxRebateEnabled: true,
  taxRebateLimit: 700000,
  cessEnabled: true,
  cessRate: 0.04,
  pfLabel: 'EPF',
  taxLabel: 'Income Tax / TDS',
  netSalaryLabel: 'Net Salary',
};

// Shared row math so the desktop table and the mobile cards stay in sync.
function derivePayroll(payroll: PayrollItemWithPeriod) {
  const baseSalary = Number(payroll.baseSalary) || 0;
  const allowances = Number(payroll.allowances) || 0;
  const bonus = Number(payroll.bonus) || 0;
  const overtimePay = Number(payroll.overtimePay) || 0;
  const foodAllowance = Number(payroll.foodAllowance) || 0;
  const deduction = Number(payroll.deduction) || 0;
  const insurance = Number(payroll.insurance) || 0;
  const tax = Number(payroll.tax) || 0;
  const netSalary = Number(payroll.netSalary) || 0;

  // There is no separate "attendance deduction" to reconstruct. Loss of Pay is
  // already inside `deduction` (the engine stores disciplineDeduction +
  // lopDeduction there), so backing net out to a "pro-rated salary" only ever
  // reproduced baseSalary. The old reconstruction was structurally zero AND
  // double-counted, since the same money was then added to the total again.
  const totalDeductions = deduction + insurance + tax;
  const daily = isDailyWage(payroll.employee?.salaryType);
  // A daily-wage worker's unworked days are simply unpaid, so `deduction` for
  // them is discipline only, never LOP.
  const deductionLabelKey = daily ? 'deductionsOther' : 'deductionsAbsenceAndOther';

  return { baseSalary, daily, deductionLabelKey, foodAllowance, totalDeductions };
}

export default function PayrollPage() {
  const router = useRouter();
  const t = useTranslations('payrollPage');
  const tc = useTranslations('common');
  const { user } = useAuthStore();
  const { can } = usePermission();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [payrollConfig, setPayrollConfig] = useState<PayrollDisplayConfig>(() => ({
    ...INDIA_DISPLAY_CONFIG,
    netSalaryLabel: t('colNetSalary'),
  }));
  const [payrolls, setPayrolls] = useState<PayrollItemWithPeriod[]>([]);
  const [filteredPayrolls, setFilteredPayrolls] = useState<PayrollItemWithPeriod[]>([]);
  const [stats, setStats] = useState({
    currentMonth: 0,
    lastMonth: 0,
    avgSalary: 0,
    ytd: 0,
  });
  const [loading, setLoading] = useState(true);
  // A failed read is not an empty payslip list. Kept in state so the table
  // can say so where the rows would have been, not only in a toast the
  // reader may have missed.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');

  useEffect(() => {
    fetchData();
    fetchPayrollConfig();
  }, []);

  const fetchPayrollConfig = async () => {
    try {
      const res: any = await systemSettingsService.getPublic();
      if (res?.success) {
        const find = (key: string) => res.data[key] ?? '';
        const country = find('payroll_country') || 'IN';
        const customPf = find('payroll_label_pf')?.trim();
        const customTax = find('payroll_label_income_tax')?.trim();
        
        let defaultPf = 'Insurance';
        let defaultTax = 'Personal income tax';
        
        if (country === 'IN') {
          defaultPf = 'EPF';
          defaultTax = 'Income Tax / TDS';
        } else if (country === 'US') {
          defaultPf = 'FICA';
          defaultTax = 'Federal Tax';
        } else if (country === 'GB') {
          defaultPf = 'National Insurance';
          defaultTax = 'Income Tax (PAYE)';
        } else if (country === 'AE') {
          defaultPf = 'GPSSA';
          defaultTax = 'Income Tax';
        } else if (country === 'SG') {
          defaultPf = 'CPF';
          defaultTax = 'Income Tax';
        } else if (country === 'DE') {
          defaultPf = 'Social Security';
          defaultTax = 'Income Tax';
        } else if (country === 'OM') {
          defaultPf = 'SPF';
          defaultTax = 'Income Tax';
        }

        setPayrollConfig({
          currencySymbol: find('payroll_currency_symbol') || '₹',
          currency: find('payroll_currency') || 'INR',
          pfEnabled: find('payroll_pf_enabled') !== 'false',
          pfEmployeeRate: parseFloat(find('payroll_pf_employee_rate') || '0.12'),
          pfSalaryCap: parseFloat(find('payroll_pf_salary_cap') || '15000'),
          esiEnabled: find('payroll_esi_enabled') !== 'false',
          esiEmployeeRate: parseFloat(find('payroll_esi_employee_rate') || '0.0075'),
          esiSalaryCap: parseFloat(find('payroll_esi_salary_cap') || '21000'),
          taxRegime: find('payroll_tax_regime') || 'new',
          standardDeduction: parseFloat(find('payroll_standard_deduction') || '75000'),
          taxRebateEnabled: find('payroll_tax_rebate_enabled') !== 'false',
          taxRebateLimit: parseFloat(find('payroll_tax_rebate_limit') || '700000'),
          cessEnabled: find('payroll_cess_enabled') !== 'false',
          cessRate: parseFloat(find('payroll_cess_rate') || '0.04'),
          pfLabel: customPf || defaultPf,
          taxLabel: customTax || defaultTax,
          netSalaryLabel: t('colNetSalary'),
        });
      }
    } catch {
      // fallback to Indian defaults already set in state
    }
  };

  const fetchData = useCallback(async () => {
    if (!user?.employeeId) return;

    try {
      setLoading(true);
      setLoadError(null);
      // Use new API endpoint for employee payslips
      const payrollsRes = await payrollService.getMyPayslips();

      setPayrolls(payrollsRes.data);

      // Calculate stats from payroll items
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();
      const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

      const currentMonthPayroll = payrollsRes.data.find((p: PayrollItemWithPeriod) => {
        return p.month === currentMonth && p.year === currentYear;
      });

      const lastMonthPayroll = payrollsRes.data.find((p: PayrollItemWithPeriod) => {
        return p.month === lastMonth && p.year === lastMonthYear;
      });

      const yearPayrolls = payrollsRes.data.filter((p: PayrollItemWithPeriod) => {
        return p.year === currentYear;
      });

      const calculatedStats = {
        currentMonth: Number(currentMonthPayroll?.netSalary || 0),
        lastMonth: Number(lastMonthPayroll?.netSalary || 0),
        avgSalary: yearPayrolls.length > 0 ? yearPayrolls.reduce((sum: number, p: PayrollItemWithPeriod) => sum + Number(p.netSalary), 0) / yearPayrolls.length : 0,
        ytd: yearPayrolls.reduce((sum: number, p: PayrollItemWithPeriod) => sum + Number(p.netSalary), 0),
      };

      setStats(calculatedStats);
    } catch (error) {
      // Was swallowed into console.error: the screen rendered an empty payslip
      // list, which is indistinguishable from "you have never been paid". The
      // server words its refusals carefully — a 403 on a colleague's record
      // reads very differently from a dead API — and `apiErrorMessage` is how
      // that wording survives, because `lib/axios` rejects with a FLAT object
      // and `err.response.data.message` is always undefined.
      console.error('Failed to fetch payroll data:', error);
      setLoadError(apiErrorMessage(error, t('loadFailed')));
      toast.error(apiErrorMessage(error, t('loadFailed')));
    } finally {
      setLoading(false);
    }
  }, [user?.employeeId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Filter payrolls based on selected year and status
  useEffect(() => {
    let filtered = payrolls;

    // Filter by year
    if (selectedYear) {
      filtered = filtered.filter(p => p.year === selectedYear);
    }

    // Filter by status
    if (selectedStatus !== 'ALL') {
      filtered = filtered.filter(p => p.status === selectedStatus);
    }

    setFilteredPayrolls(filtered);
  }, [payrolls, selectedYear, selectedStatus]);

  // Get available years from payrolls
  const availableYears = useMemo(() => {
    const years = [...new Set(payrolls.map(p => p.year).filter((y): y is number => y !== undefined))].sort((a, b) => b - a);
    return years;
  }, [payrolls]);

  const getStatusBadge = useCallback((status: string) => {
    const styles = {
      DRAFT: 'bg-surface-page text-text-muted border-surface-border',
      PENDING_APPROVAL: 'bg-status-warning-bg text-status-warning border-status-warning/20',
      APPROVED: 'bg-status-info-bg text-status-info border-status-info/20',
      REJECTED: 'bg-status-error-bg text-status-error border-status-error/20',
      LOCKED: 'bg-status-success-bg text-status-success border-status-success/20',
    };

    const labels = {
      DRAFT: tc('draft'),
      PENDING_APPROVAL: tc('pending'),
      APPROVED: tc('approved'),
      REJECTED: tc('rejected'),
      LOCKED: tc('locked'),
    };

    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${styles[status as keyof typeof styles] || 'bg-surface-page'}`}>
        {labels[status as keyof typeof labels] || status}
      </span>
    );
  }, [tc]);

  // Memoize payroll rows
  const payrollRows = useMemo(() => {
    return filteredPayrolls.map((payroll, index) => {
      const { baseSalary, daily, deductionLabelKey, foodAllowance, totalDeductions } = derivePayroll(payroll);
      const isFinalized = payroll.status === 'APPROVED' || payroll.status === 'LOCKED';

      return (
        <motion.tr
          key={payroll.id}
          data-testid="payslip-row"
          data-payroll-id={payroll.id}
          data-status={payroll.status ?? ''}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: index * 0.05 }}
          className="hover:bg-surface-page transition-colors"
        >
          <td className="px-3 py-2.5">
            <div className="text-sm font-medium text-text-heading">
              {t('rowMonthYear', { month: payroll.month ?? 0, year: payroll.year ?? 0 })}
            </div>
            <div className="text-xs text-text-muted">
              {formatDate(payroll.createdAt)}
            </div>
          </td>
          <td className="px-3 py-2.5 text-sm text-text-body">
            {formatCurrency(baseSalary)}
            {daily && (
              <span className="block text-xs text-text-muted">
                {t('daysTimesRate', {
                  days: Number(payroll.actualWorkDays) || 0,
                  rate: formatCurrency(impliedDailyRate(baseSalary, payroll.actualWorkDays) ?? 0),
                })}
              </span>
            )}
          </td>
          <td className="px-3 py-2.5 text-sm text-status-success">
            +{formatCurrency(Number(payroll.allowances))}
          </td>
          <td className="px-3 py-2.5">
            <div className="flex flex-col">
              <span className="text-sm text-brand-primary font-medium">
                +{formatCurrency(Number(payroll.overtimePay))}
              </span>
              {foodAllowance > 0 && (
                <span className="text-xs text-status-success font-medium">
                  {t('foodAllowanceSuffix', { amount: formatCurrency(foodAllowance) })}
                </span>
              )}
            </div>
          </td>
          <td className="px-3 py-2.5">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-status-error">
                -{formatCurrency(totalDeductions)}
              </span>
              <div className="text-xs text-text-muted space-y-0.5">
                <div>{t('bulletLabelAmount', { label: payrollConfig.pfLabel, amount: formatCurrency(Number(payroll.insurance)) })}</div>
                <div>{t('bulletLabelAmount', { label: payrollConfig.taxLabel, amount: formatCurrency(Number(payroll.tax)) })}</div>
                {Number(payroll.deduction) > 0 && (
                  <div>{t('bulletLabelAmount', { label: t(deductionLabelKey), amount: formatCurrency(Number(payroll.deduction)) })}</div>
                )}
              </div>
            </div>
          </td>
          <td className="px-3 py-2.5">
            <span className="text-sm font-bold text-status-success">
              {formatCurrency(Number(payroll.netSalary))}
            </span>
          </td>
          <td className="px-3 py-2.5">{payroll.status ? getStatusBadge(payroll.status) : '-'}</td>
          <td className="px-3 py-2.5">
            <div className="flex items-center justify-end gap-2">
              {isFinalized ? (
                <>
                  <button
                    data-testid="payslip-view"
                    onClick={() => router.push(`/dashboard/my-payroll/${payroll.id}`)}
                    className="p-2 hover:bg-brand-primary-light rounded-lg text-brand-primary transition-colors"
                    title={t('viewDetailsTooltip')}
                  >
                    <Eye size={16} />
                  </button>
                  {/* A payslip download does not exist yet — `my-payroll/[id]`
                      labels its own equivalent "Coming soon". The control here
                      carried no onClick at all, so it looked live and silently
                      did nothing; better absent than lying. Restore it with the
                      handler when the PDF endpoint lands. */}
                </>
              ) : (
                <span className="text-xs text-text-muted">{t('notFinalizedYet')}</span>
              )}
            </div>
          </td>
        </motion.tr>
      );
    });
  }, [filteredPayrolls, getStatusBadge, router, payrollConfig, t]);

  return (
    <ProtectedRoute requiredPermission="VIEW_DASHBOARD">
      <>
        <div className="space-y-4 sm:space-y-5" data-testid="ess-payroll">
          {/* Current Month Salary Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-gradient-to-br from-status-success via-status-success/90 to-status-success/80 rounded-xl p-4 sm:p-5 text-white relative overflow-hidden"
          >
            <div className="absolute top-0 end-0 w-40 h-40 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2"></div>

            <div className="relative z-10">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-white/70 text-xs font-medium">{t('thisMonthSalary')}</p>
                  <h2 className="text-sm sm:text-base font-semibold mt-0.5">
                    {new Date().toLocaleDateString('en-IN', { timeZone: getCompanyTz(),  month: 'long', year: 'numeric' })}
                  </h2>
                </div>
                <div className="w-9 h-9 bg-white/20 rounded-lg flex items-center justify-center">
                  <CurrencyIcon size={18} />
                </div>
              </div>

              <div className="mb-4">
                <p className="text-white/70 text-xs font-medium mb-1">{payrollConfig.netSalaryLabel}</p>
                <p className="text-2xl sm:text-3xl font-semibold tabular-nums wrap-break-word">{formatCurrency(stats.currentMonth)}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="flex items-center justify-between gap-2 bg-white/10 rounded-lg p-2.5">
                  <p className="text-white/70 text-xs">{tc('lastMonth')}</p>
                  <p className="text-sm font-semibold tabular-nums">{formatCurrency(stats.lastMonth)}</p>
                </div>
                <div className="flex items-center justify-between gap-2 bg-white/10 rounded-lg p-2.5">
                  <p className="text-white/70 text-xs">{t('averagePerMonth')}</p>
                  <p className="text-sm font-semibold tabular-nums">{formatCurrency(stats.avgSalary)}</p>
                </div>
                <div className="flex items-center justify-between gap-2 bg-white/10 rounded-lg p-2.5">
                  <p className="text-white/70 text-xs">{t('totalThisYear')}</p>
                  <p className="text-sm font-semibold tabular-nums">{formatCurrency(stats.ytd)}</p>
                </div>
              </div>

              {stats.currentMonth > stats.lastMonth && (
                <div className="mt-3 bg-white/10 rounded-lg p-2.5 flex items-center gap-2">
                  <TrendingUp size={16} />
                  <p className="text-xs sm:text-sm">
                    {t('upFromLastMonth', { amount: formatCurrency(stats.currentMonth - stats.lastMonth) })}
                  </p>
                </div>
              )}
            </div>
          </motion.div>

          {/* Quick Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: t('statTotalPayStubs'), value: payrolls.length.toString(), colorClass: 'text-brand-primary', bgClass: 'bg-brand-primary-light', icon: Calendar },
              { label: t('statPaid'), value: payrolls.filter(p => p.status === 'LOCKED').length.toString(), colorClass: 'text-status-success', bgClass: 'bg-status-success-bg', icon: CurrencyIcon },
              { label: tc('processing'), value: payrolls.filter(p => p.status === 'DRAFT' || p.status === 'PENDING_APPROVAL').length.toString(), colorClass: 'text-status-warning', bgClass: 'bg-status-warning-bg', icon: AlertCircle },
              { label: t('statThisYear'), value: formatCurrency(stats.ytd), colorClass: 'text-brand-accent', bgClass: 'bg-brand-primary-light/35', icon: TrendingUp },
            ].map((stat, index) => {
              const Icon = stat.icon;
              return (
                <motion.div
                  key={stat.label}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 + index * 0.1 }}
                  className="bg-surface-card rounded-xl p-3 sm:p-4 border border-surface-border shadow-sm"
                >
                  <div className="flex items-center gap-2.5 mb-2">
                    <div className={`w-8 h-8 ${stat.bgClass} rounded-lg flex items-center justify-center shrink-0`}>
                      <Icon className={stat.colorClass} size={16} />
                    </div>
                    <p className="text-xs text-text-muted truncate">{stat.label}</p>
                  </div>
                  <p className="text-xl font-semibold tabular-nums text-text-heading truncate">{stat.value}</p>
                </motion.div>
              );
            })}
          </div>

          {/* A failed read says so, in the server's own words. An empty table
              here would read as "you have never been paid". */}
          {loadError && (
            <div
              data-testid="payslip-load-error"
              className="rounded-xl border border-status-error/30 bg-status-error-bg px-4 py-3 text-sm font-medium text-status-error"
            >
              {loadError}
            </div>
          )}

          {/* Payroll History */}
          <div className="bg-surface-card rounded-xl border border-surface-border shadow-sm">
            <div className="p-4 sm:p-5 border-b border-surface-border">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm sm:text-base font-semibold text-text-heading">{t('salaryHistoryHeading')}</h2>
                  <p className="text-xs text-text-muted mt-0.5">{t('salaryHistorySubtitle')}</p>
                </div>
              </div>

              {/* Filters */}
              {/* One column below md. A `flex-wrap` row of `min-w-[140px]`
                  children is the pattern that breaks 390px: two wrap and the
                  third overflows. Unchanged at and above md. */}
              <div className="grid grid-cols-1 gap-3 md:flex md:flex-wrap md:items-end">
                <div className="md:flex-1 md:min-w-[140px]">
                  <label className="block text-xs font-medium text-text-muted mb-1">{t('yearLabel')}</label>
                  <select
                    data-testid="payslip-year"
                    value={selectedYear}
                    onChange={(e) => setSelectedYear(Number(e.target.value))}
                    className="w-full h-12 md:h-10 px-3 border border-surface-border bg-surface-card text-text-body rounded-lg text-base md:text-sm focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary"
                  >
                    <option value="">{t('allYears')}</option>
                    {availableYears.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="md:flex-1 md:min-w-[140px]">
                  <label className="block text-xs font-medium text-text-muted mb-1">{tc('status')}</label>
                  <select
                    value={selectedStatus}
                    onChange={(e) => setSelectedStatus(e.target.value)}
                    className="w-full h-12 md:h-10 px-3 border border-surface-border bg-surface-card text-text-body rounded-lg text-base md:text-sm focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary"
                  >
                    <option value="ALL">{t('statusAll')}</option>
                    <option value="DRAFT">{tc('draft')}</option>
                    <option value="PENDING_APPROVAL">{tc('pending')}</option>
                    <option value="APPROVED">{tc('approved')}</option>
                    <option value="REJECTED">{tc('rejected')}</option>
                    <option value="LOCKED">{tc('locked')}</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setSelectedYear(new Date().getFullYear());
                      setSelectedStatus('ALL');
                    }}
                    className="inline-flex items-center justify-center min-w-11 h-9 px-4 md:px-3 rounded-lg border border-surface-border text-sm font-medium text-text-body hover:bg-surface-page transition-colors whitespace-nowrap touch-manipulation"
                  >
                    {t('resetBtn')}
                  </button>
                  <div className="text-xs text-text-muted whitespace-nowrap">
                    {t('slipsCountSummary', { count: filteredPayrolls.length, total: payrolls.length })}
                  </div>
                </div>
              </div>
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead className="bg-surface-page border-b border-surface-border">
                  <tr>
                    <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">
                      {t('colMonth')}
                    </th>
                    <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">
                      {t('colBasicSalary')}
                    </th>
                    <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">
                      {t('colAllowance')}
                    </th>
                    <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">
                      {t('colOvertime')}
                    </th>
                    <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">
                      {t('colDeduction')}
                    </th>
                    <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">
                      {payrollConfig.netSalaryLabel}
                    </th>
                    <th className="px-3 py-2.5 text-start text-[11px] font-medium text-text-muted uppercase tracking-wide">
                      {tc('status')}
                    </th>
                    <th className="px-3 py-2.5 text-end text-[11px] font-medium text-text-muted uppercase tracking-wide">
                      {tc('actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {loading ? (
                    [...Array(5)].map((_, i) => (
                      <tr key={i} className="animate-pulse">
                        <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-3 py-2.5"><div className="h-4 bg-surface-page rounded"></div></td>
                        <td className="px-3 py-2.5"><div className="h-6 bg-surface-page rounded-full"></div></td>
                        <td className="px-3 py-2.5"><div className="h-11 md:h-8 bg-surface-page rounded"></div></td>
                      </tr>
                    ))
                  ) : filteredPayrolls.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-10">
                        <div className="flex flex-col items-center justify-center text-center">
                          <CurrencyIcon size={32} className="text-text-muted mb-3" />
                          <p className="text-text-muted font-medium">
                            {payrolls.length === 0
                              ? t('emptyNoSlips')
                              : t('emptyNoMatchingSlips')}
                          </p>
                          <p className="text-sm text-text-muted mt-1">
                            {payrolls.length === 0
                              ? t('emptyNoSlipsDesc')
                              : t('emptyNoMatchingDesc')}
                          </p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    payrollRows
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden p-4 space-y-3">
              {loading ? (
                <SkeletonList count={3} testId="payslip-loading-card" />
              ) : filteredPayrolls.length === 0 ? (
                // Filtered-empty offers a way back to the full list; genuinely
                // empty does not pretend there is one.
                payrolls.length === 0 ? (
                  <EmptyState icon={CurrencyIcon} title={t('emptyNoSlips')} testId="payslip-empty-card" />
                ) : (
                  <EmptyState
                    icon={CurrencyIcon}
                    title={t('emptyNoMatchingSlips')}
                    action={{
                      label: t('resetBtn'),
                      onClick: () => {
                        setSelectedYear(new Date().getFullYear());
                        setSelectedStatus('ALL');
                      },
                      testId: 'payslip-empty-reset',
                    }}
                    testId="payslip-empty-card"
                  />
                )
              ) : (
                filteredPayrolls.map((payroll) => {
                  const { baseSalary, daily, deductionLabelKey, foodAllowance, totalDeductions } = derivePayroll(payroll);
                  const isFinalized = payroll.status === 'APPROVED' || payroll.status === 'LOCKED';
                  return (
                    <DataCard
                      key={payroll.id}
                      // NOT the desktop row's id: both trees render the same
                      // records and Playwright's `.count()` includes hidden
                      // elements (see components/common/DataCard.tsx).
                      testId="payslip-card"
                      title={<span>{t('rowMonthYear', { month: payroll.month ?? 0, year: payroll.year ?? 0 })}</span>}
                      headerRight={payroll.status ? getStatusBadge(payroll.status) : undefined}
                      items={[
                        { label: t('mobileCreatedLabel'), value: formatDate(payroll.createdAt) },
                        {
                          label: t('mobileBasicLabel'),
                          value: daily
                            ? `${formatCurrency(baseSalary)} · ${t('daysTimesRate', {
                                days: Number(payroll.actualWorkDays) || 0,
                                rate: formatCurrency(impliedDailyRate(baseSalary, payroll.actualWorkDays) ?? 0),
                              })}`
                            : formatCurrency(baseSalary),
                        },
                        { label: t('colAllowance'), value: <span className="text-status-success">+{formatCurrency(Number(payroll.allowances))}</span> },
                        {
                          label: t('colOvertime'),
                          value: (
                            <span className="text-brand-primary">
                              +{formatCurrency(Number(payroll.overtimePay))}
                              {foodAllowance > 0 ? ` ${t('foodAllowanceSuffix', { amount: formatCurrency(foodAllowance) })}` : ''}
                            </span>
                          ),
                        },
                        { label: payrollConfig.netSalaryLabel, value: <span className="font-bold text-status-success">{formatCurrency(Number(payroll.netSalary))}</span> },
                        {
                          label: t('colDeduction'),
                          full: true,
                          value: (
                            <div>
                              <span className="font-semibold text-status-error">-{formatCurrency(totalDeductions)}</span>
                              <div className="mt-0.5 space-y-0.5 text-xs text-text-muted">
                                <div>{t('bulletLabelAmount', { label: payrollConfig.pfLabel, amount: formatCurrency(Number(payroll.insurance)) })}</div>
                                <div>{t('bulletLabelAmount', { label: payrollConfig.taxLabel, amount: formatCurrency(Number(payroll.tax)) })}</div>
                                {Number(payroll.deduction) > 0 && <div>{t('bulletLabelAmount', { label: t(deductionLabelKey), amount: formatCurrency(Number(payroll.deduction)) })}</div>}
                              </div>
                            </div>
                          ),
                        },
                      ]}
                      footer={
                        isFinalized ? (
                          <>
                            <button
                              onClick={() => router.push(`/dashboard/my-payroll/${payroll.id}`)}
                              data-testid="payslip-card-open"
                              // A labelled 44px button, not a bare 32px glyph:
                              // opening the payslip is the only thing this card
                              // is for, and an unlabelled eye is guesswork.
                              className="inline-flex h-11 touch-manipulation items-center gap-1.5 rounded-lg px-4 text-sm font-semibold text-brand-primary transition-colors hover:bg-brand-primary-light active:scale-[0.98]"
                            >
                              <Eye size={16} />
                              {t('viewDetailsTooltip')}
                            </button>
                          </>
                        ) : (
                          <span className="text-xs text-text-muted">{t('notFinalizedYet')}</span>
                        )
                      }
                    />
                  );
                })
              )}
            </div>
          </div>

          {/* Payroll Info Card — Dynamic (reads from system settings) */}
          <div className="bg-surface-card border border-surface-border rounded-xl p-4 sm:p-5 shadow-sm">
            <h4 className="text-sm font-semibold text-brand-primary mb-2.5 flex items-center gap-2">
              <Info size={16} /> {t('payrollInfoHeading')}
            </h4>
            <ul className="text-xs sm:text-sm text-text-body space-y-1.5">
              <li>{t('payrollInfoGeneric')}</li>
              {payrollConfig.pfEnabled && (
                <li>
                  <strong>Provident Fund (EPF):</strong> {Math.round(payrollConfig.pfEmployeeRate * 100)}% of Basic Salary
                  {payrollConfig.pfSalaryCap > 0 && ` (capped at ${payrollConfig.currencySymbol}${payrollConfig.pfSalaryCap.toLocaleString('en-IN')})`}
                </li>
              )}
              {payrollConfig.esiEnabled && (
                <li>
                  <strong>ESI:</strong> {(payrollConfig.esiEmployeeRate * 100).toFixed(2)}% of Gross Salary
                  {` (applies when gross ≤ ${payrollConfig.currencySymbol}${payrollConfig.esiSalaryCap.toLocaleString('en-IN')})`}
                </li>
              )}
              <li>
                <strong>Income Tax:</strong> {payrollConfig.taxRegime === 'new' ? 'New Tax Regime' : payrollConfig.taxRegime === 'old' ? 'Old Tax Regime' : 'Progressive Monthly Slabs'}
                {payrollConfig.taxRegime !== 'progressive' && ` — ${payrollConfig.currencySymbol}${payrollConfig.standardDeduction.toLocaleString('en-IN')} standard deduction`}
              </li>
              {payrollConfig.taxRebateEnabled && (
                <li>
                  <strong>Section 87A Rebate:</strong> No tax if annual taxable income ≤ {payrollConfig.currencySymbol}{payrollConfig.taxRebateLimit.toLocaleString('en-IN')}
                </li>
              )}
              {payrollConfig.cessEnabled && (
                <li>
                  <strong>Health &amp; Education Cess:</strong> {Math.round(payrollConfig.cessRate * 100)}% added on income tax
                </li>
              )}
              <li>{t('grossFormula')}</li>
            </ul>
          </div>
        </div>
      </>
    </ProtectedRoute>
  );
}
