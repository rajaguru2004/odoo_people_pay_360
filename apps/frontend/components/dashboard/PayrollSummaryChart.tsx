'use client';

import React, { useEffect, useState, memo } from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { useTranslations } from 'next-intl';
import dashboardService from '@/services/dashboardService';
import { getCurrencyCode } from '@/utils/formatters';

const PayrollSummaryChart = memo(function PayrollSummaryChart() {
  const [data, setData] = useState<any[]>([]);
  const t = useTranslations('payrollSummaryChart');
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<any>(null);

  useEffect(() => {
    fetchPayrollData();
  }, []);

  const fetchPayrollData = async () => {
    try {
      const response = await dashboardService.getPayrollSummary();
      if (response.data) {
        const { summary: summaryData } = response.data;
        setSummary(summaryData);

        // Get last 6 months
        const monthNames = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12'];
        const formattedData = summaryData.slice(-6).map((item: any) => ({
          month: monthNames[item.month - 1],
          amount: item.totalAmount,
          employees: item.employeeCount,
          status: item.status,
        }));
        setData(formattedData);
      }
    } catch (error) {
      console.error('Failed to fetch payroll data:', error);
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-2xl p-6 border border-surface-border-light">
        <div className="animate-pulse">
          <div className="h-6 bg-surface-page rounded w-1/3 mb-4"></div>
          <div className="h-64 bg-surface-page rounded"></div>
        </div>
      </div>
    );
  }

  const maxValue = Math.max(...data.map(d => d.amount), 1);
  const totalPayroll = data.reduce((sum, d) => sum + d.amount, 0);
  const avgPayroll = data.length > 0 ? totalPayroll / data.length : 0;

  return (
    <div className="bg-surface-card rounded-2xl p-6 border border-surface-border h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-text-heading">{t('title')}</h3>
          <p className="text-sm text-text-muted mt-1">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 bg-status-success-bg rounded-lg">
          <CurrencyIcon className="text-status-success" size={20} />
          <span className="text-sm font-bold text-status-success">
            {(totalPayroll / 1000000).toFixed(1)}M
          </span>
        </div>
      </div>

      {/* Chart */}
      <div className="h-64 flex items-end justify-between gap-3">
        {data.length === 0 ? (
          <div className="w-full h-full flex items-center justify-center text-text-muted">
            {t('noDataAvailable')}
          </div>
        ) : (
          data.map((item, index) => {
            const height = maxValue > 0 ? (item.amount / maxValue) * 100 : 0;
            const isAboveAvg = item.amount > avgPayroll;

            return (
              <div key={item.month} className="flex-1 flex flex-col items-center gap-2">
                {/* Bar */}
                <div className="w-full flex flex-col-reverse gap-1 h-48">
                  {item.amount > 0 && (
                    <motion.div
                      initial={{ height: 0 }}
                      animate={{ height: `${height}%` }}
                      transition={{ delay: index * 0.1, duration: 0.5 }}
                      className={`w-full rounded-t-lg relative group cursor-pointer ${
                        isAboveAvg ? 'bg-status-success' : 'bg-brand-primary'
                      }`}
                    >
                      <div className="absolute -top-16 left-1/2 -translate-x-1/2 bg-surface-overlay text-text-body border border-surface-border text-xs px-3 py-2 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 shadow-md">
                        <div className="font-bold">{(item.amount / 1000000).toFixed(1)}M {getCurrencyCode()}</div>
                        <div className="text-text-muted">{item.employees} {t('employeeSuffix')}</div>
                      </div>
                    </motion.div>
                  )}
                </div>
                {/* Month Label */}
                <span className="text-sm font-medium text-text-muted">{item.month}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mt-6 pt-6 border-t border-surface-border-light">
        <div className="text-center">
          <p className="text-xs text-text-muted mb-1">{t('total')}</p>
          <p className="text-lg font-bold text-text-heading">
            {(totalPayroll / 1000000).toFixed(1)}M
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs text-text-muted mb-1">{t('average')}</p>
          <p className="text-lg font-bold text-brand-primary">
            {(avgPayroll / 1000000).toFixed(1)}M
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs text-text-muted mb-1">{t('thisMonth')}</p>
          <p className="text-lg font-bold text-status-success">
            {data.length > 0 ? (data[data.length - 1].amount / 1000000).toFixed(1) : 0}M
          </p>
        </div>
      </div>
    </div>
  );
});

export default PayrollSummaryChart;
