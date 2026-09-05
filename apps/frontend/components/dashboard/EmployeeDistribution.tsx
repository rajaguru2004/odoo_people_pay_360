'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import dashboardService from '@/services/dashboardService';

interface DepartmentStat {
  department: string;
  count: number;
}

export default function EmployeeDistribution() {
  const [departments, setDepartments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    fetchEmployeeStats();
  }, []);

  const fetchEmployeeStats = async () => {
    try {
      const response = await dashboardService.getEmployeeStats();
      
      // Axios interceptor returns response.data directly, so response = { success: true, data: {...} }
      if (response.data?.byDepartment) {
        const deptData = response.data.byDepartment;
        const totalCount = deptData.reduce((sum: number, dept: DepartmentStat) => sum + dept.count, 0);
        setTotal(totalCount);

        // Assign colors to departments
        const colors = [
          'bg-brand-primary',
          'bg-brand-accent',
          'bg-purple-500',
          'bg-green-500',
          'bg-brand-accent',
          'bg-pink-500',
          'bg-brand-primary-light/100',
          'bg-slate-400',
        ];

        const formattedDepts = deptData.map((dept: DepartmentStat, index: number) => ({
          name: dept.department,
          count: dept.count,
          color: colors[index % colors.length],
          percentage: totalCount > 0 ? Math.round((dept.count / totalCount) * 100) : 0,
        }));

        setDepartments(formattedDepts);
      }
    } catch (error) {
      console.error('Failed to fetch employee stats:', error);
      setDepartments([]);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="surface-panel p-6">
        <div className="animate-pulse">
          <div className="h-6 bg-slate-200 rounded w-1/3 mb-4"></div>
          <div className="h-64 bg-slate-100 rounded"></div>
        </div>
      </div>
    );
  }

  if (departments.length === 0) {
    return (
      <div className="surface-panel p-6">
        <div className="mb-6">
          <h3 className="text-lg font-bold text-primary">Staff distribution</h3>
          <p className="text-sm text-slate-500 mt-1">According to department</p>
        </div>
        <div className="h-64 flex items-center justify-center text-slate-400">
          No employee data available
        </div>
      </div>
    );
  }

  return (
    <div className="surface-panel p-6 h-full flex flex-col">
      {/* Header */}
      <div className="mb-6">
        <h3 className="text-lg font-bold text-primary">Staff distribution</h3>
        <p className="text-sm text-slate-500 mt-1">According to department</p>
      </div>

      {/* Donut Chart */}
      <div className="flex items-center justify-center mb-6">
        <div className="relative w-48 h-48">
          {/* Center Circle */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <p className="text-3xl font-bold text-primary">{total}</p>
              <p className="text-sm text-slate-500">Employee</p>
            </div>
          </div>

          {/* SVG Donut */}
          <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
            {departments.map((dept, index) => {
              const prevPercentages = departments
                .slice(0, index)
                .reduce((sum, d) => sum + d.percentage, 0);
              const circumference = 2 * Math.PI * 40;
              const offset = circumference - (dept.percentage / 100) * circumference;
              const rotation = (prevPercentages / 100) * 360;

              return (
                <motion.circle
                  key={dept.name}
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke={dept.color.replace('bg-', '')}
                  strokeWidth="12"
                  strokeDasharray={circumference}
                  strokeDashoffset={offset}
                  initial={{ strokeDashoffset: circumference }}
                  animate={{ strokeDashoffset: offset }}
                  transition={{ delay: index * 0.2, duration: 1 }}
                  style={{
                    transformOrigin: '50% 50%',
                    transform: `rotate(${rotation}deg)`,
                  }}
                  className="transition-all hover:stroke-[14]"
                />
              );
            })}
          </svg>
        </div>
      </div>

      {/* Legend */}
      <div className="space-y-3">
        {departments.map((dept, index) => (
          <motion.div
            key={dept.name}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.1 }}
            className="flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${dept.color}`}></div>
              <span className="text-sm text-slate-600">{dept.name}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-primary">{dept.count}</span>
              <span className="text-xs text-slate-400 w-12 text-right">{dept.percentage}%</span>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
