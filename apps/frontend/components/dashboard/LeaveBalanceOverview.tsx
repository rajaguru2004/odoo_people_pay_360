'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Calendar, Umbrella, Heart, Plane } from 'lucide-react';
import axiosInstance from '@/lib/axios';

interface LeaveTypeBalance {
  type: string;
  label: string;
  used: number;
  remaining: number;
  total: number;
  icon: any;
  color: string;
  bgColor: string;
}

export default function LeaveBalanceOverview() {
  const [balances, setBalances] = useState<LeaveTypeBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalUsed, setTotalUsed] = useState(0);
  const [totalRemaining, setTotalRemaining] = useState(0);

  useEffect(() => {
    fetchLeaveBalances();
  }, []);

  const fetchLeaveBalances = async () => {
    try {
      // Fetch leave requests to calculate usage
      const response = await axiosInstance.get('/leave-requests');
      
      if (response.data) {
        const requests = response.data;
        
        // Calculate by leave type
        const annualUsed = requests
          .filter((r: any) => r.leaveType === 'ANNUAL' && r.status === 'APPROVED')
          .reduce((sum: number, r: any) => sum + (r.totalDays || 0), 0);
        
        const sickUsed = requests
          .filter((r: any) => r.leaveType === 'SICK' && r.status === 'APPROVED')
          .reduce((sum: number, r: any) => sum + (r.totalDays || 0), 0);
        
        const personalUsed = requests
          .filter((r: any) => r.leaveType === 'PERSONAL' && r.status === 'APPROVED')
          .reduce((sum: number, r: any) => sum + (r.totalDays || 0), 0);

        // Standard allocations (would come from policy)
        const annualTotal = 12;
        const sickTotal = 10;
        const personalTotal = 5;

        const leaveData: any[] = [
          {
            type: 'ANNUAL',
            label: 'Annual Leave',
            used: annualUsed,
            remaining: annualTotal - annualUsed,
            total: annualTotal,
            icon: Plane,
            color: 'text-brand-primary',
            bgColor: 'bg-brand-primary-light/10',
            borderColor: 'border-brand-primary/20',
            barBg: 'bg-brand-primary',
          },
          {
            type: 'SICK',
            label: 'Sick Leave',
            used: sickUsed,
            remaining: sickTotal - sickUsed,
            total: sickTotal,
            icon: Heart,
            color: 'text-status-error',
            bgColor: 'bg-status-error-bg',
            borderColor: 'border-status-error/20',
            barBg: 'bg-status-error',
          },
          {
            type: 'PERSONAL',
            label: 'Personal leave',
            used: personalUsed,
            remaining: personalTotal - personalUsed,
            total: personalTotal,
            icon: Umbrella,
            color: 'text-status-warning',
            bgColor: 'bg-status-warning-bg',
            borderColor: 'border-status-warning/20',
            barBg: 'bg-status-warning',
          },
        ];

        setBalances(leaveData);
        setTotalUsed(annualUsed + sickUsed + personalUsed);
        setTotalRemaining((annualTotal - annualUsed) + (sickTotal - sickUsed) + (personalTotal - personalUsed));
      }
    } catch (error) {
      console.error('Failed to fetch leave balances:', error);
      setBalances([]);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6 shadow-sm">
        <div className="animate-pulse">
          <div className="h-5 bg-surface-border-light rounded w-1/3 mb-4"></div>
          <div className="h-48 bg-surface-border-light rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6 shadow-sm hover:shadow-md transition-all h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-text-heading">Leave balance</h3>
          <p className="text-sm text-text-muted mt-1">Company-wide average</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 bg-brand-primary-light/20 rounded-[--radius-button]">
          <Calendar className="text-brand-primary" size={20} />
          <span className="text-sm font-bold text-brand-primary">{totalRemaining}</span>
        </div>
      </div>

      {/* Leave Types */}
      <div className="space-y-4 flex-1">
        {balances.map((balance: any, index) => {
          const Icon = balance.icon;
          const usagePercentage = (balance.used / balance.total) * 100;

          return (
            <motion.div
              key={balance.type}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className={`p-4 rounded-[--radius-card] border-2 ${balance.bgColor} ${balance.borderColor}`}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className={`p-2 ${balance.bgColor} rounded-[--radius-button]`}>
                    <Icon className={balance.color} size={18} />
                  </div>
                  <span className="text-sm font-semibold text-text-body">
                    {balance.label}
                  </span>
                </div>
                <span className={`text-lg font-bold ${balance.color}`}>
                  {balance.remaining}/{balance.total}
                </span>
              </div>

              {/* Progress Bar */}
              <div className="w-full h-2 bg-surface-card rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${usagePercentage}%` }}
                  transition={{ delay: index * 0.1 + 0.2, duration: 0.8 }}
                  className={`h-full rounded-full ${balance.barBg}`}
                />
              </div>

              {/* Stats */}
              <div className="flex items-center justify-between mt-2 text-xs">
                <span className="text-text-body">Used: {balance.used} days</span>
                <span className={`font-bold ${balance.color}`}>
                  {usagePercentage.toFixed(0)}%
                </span>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Summary */}
      <div className="mt-6 pt-4 border-t border-surface-border">
        <div className="grid grid-cols-2 gap-4">
          <div className="text-center">
            <p className="text-xs text-text-muted mb-1">Used</p>
            <p className="text-2xl font-bold text-text-heading">{totalUsed}</p>
            <p className="text-xs text-text-muted">days</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-text-muted mb-1">Remaining</p>
            <p className="text-2xl font-bold text-brand-primary">{totalRemaining}</p>
            <p className="text-xs text-text-muted">days</p>
          </div>
        </div>
      </div>
    </div>
  );
}
