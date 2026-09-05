'use client';

import React, { useEffect, useState, memo, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Building2, TrendingUp, TrendingDown } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import axiosInstance from '@/lib/axios';
import { chartColors } from '@/theme/chartColors';

interface DepartmentStats {
  departmentName: string;
  employeeCount: number;
  attendanceRate: number;
  performanceScore: number;
  trend: 'up' | 'down' | 'stable';
}

const DepartmentPerformance = memo(function DepartmentPerformance() {
  const [departments, setDepartments] = useState<DepartmentStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDepartmentStats();
  }, []);

  const fetchDepartmentStats = async () => {
    try {
      const response = await axiosInstance.get('/departments/performance-stats');

      if (response.data?.data) {
        const deptData = response.data.data;

        // Take top 5 departments
        const topDepts = deptData.slice(0, 5);

        setDepartments(topDepts);
      }
    } catch (error) {
      console.error('Failed to fetch department stats:', error);
      setDepartments([]);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
        <div className="animate-pulse">
          <div className="h-6 bg-slate-200 rounded w-1/3 mb-4"></div>
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-16 bg-slate-100 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const getPerformanceColor = useCallback((performanceScore: number) => {
    if (performanceScore >= 90) return chartColors.success;
    if (performanceScore >= 80) return chartColors.info;
    if (performanceScore >= 70) return chartColors.warning;
    return chartColors.error;
  }, []);

  // Custom tooltip
  const CustomTooltip = useCallback(({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-surface-overlay p-3 rounded-[--radius-input] shadow-lg border border-surface-border">
          <p className="font-semibold text-text-heading mb-1">{data.departmentName}</p>
          <p className="text-sm text-text-body">Efficiency: <span className="font-bold">{data.performanceScore}%</span></p>
          <p className="text-sm text-text-body">Staff: <span className="font-bold">{data.employeeCount}</span></p>
          <p className="text-sm text-text-body">Timekeeping: <span className="font-bold">{data.attendanceRate}%</span></p>
        </div>
      );
    }
    return null;
  }, []);

  // Truncate long department names
  const truncateName = useCallback((name: string, maxLength: number = 15) => {
    if (name.length <= maxLength) return name;
    return name.substring(0, maxLength) + '...';
  }, []);

  // Memoize stats calculations
  const stats = useMemo(() => {
    if (departments.length === 0) {
      return { average: 0, highest: 0, lowest: 0 };
    }
    return {
      average: (departments.reduce((sum, d) => sum + d.performanceScore, 0) / departments.length).toFixed(0),
      highest: Math.max(...departments.map(d => d.performanceScore)),
      lowest: Math.min(...departments.map(d => d.performanceScore)),
    };
  }, [departments]);

  return (
    <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-text-heading">Top 5 Excellent Departments</h3>
          <p className="text-sm text-text-muted mt-1">According to this month's performance</p>
        </div>
        <Building2 className="text-brand-primary" size={24} />
      </div>

      {/* Chart */}
      <div className="flex-1 min-h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={departments}
            margin={{ top: 20, right: 30, left: 20, bottom: 60 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis
              dataKey="departmentName"
              angle={-45}
              textAnchor="end"
              height={80}
              tick={{ fill: chartColors.axisText, fontSize: 12 }}
              tickFormatter={truncateName}
            />
            <YAxis
              tick={{ fill: chartColors.axisText, fontSize: 12 }}
              domain={[0, 100]}
              label={{ value: 'Efficiency (%)', angle: -90, position: 'insideLeft', style: { fill: chartColors.axisText, fontSize: 12 } }}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(59, 130, 246, 0.1)' }} />
            <Bar dataKey="performanceScore" radius={[8, 8, 0, 0]}>
              {departments.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={getPerformanceColor(entry.performanceScore)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-4 mt-6 pt-6 border-t border-surface-border">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center"
        >
          <p className="text-xs text-text-muted mb-1">Medium</p>
          <p className="text-lg font-bold text-brand-primary">{stats.average}%</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-center"
        >
          <p className="text-xs text-text-muted mb-1">Highest</p>
          <p className="text-lg font-bold text-status-success">{stats.highest}%</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="text-center"
        >
          <p className="text-xs text-text-muted mb-1">Lowest</p>
          <p className="text-lg font-bold text-status-warning">{stats.lowest}%</p>
        </motion.div>
      </div>
    </div>
  );
});

export default DepartmentPerformance;
