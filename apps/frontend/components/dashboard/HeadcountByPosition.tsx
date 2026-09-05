'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Users, TrendingUp } from 'lucide-react';
import axiosInstance from '@/lib/axios';
import { useTheme } from '@/theme/provider';

import { chartColors } from '@/theme/chartColors';

interface PositionData {
  position: string;
  count: number;
  percentage: number;
  color: string;
}

export default function HeadcountByPosition() {
  const theme = useTheme();
  const c = theme.colors;
  const [data, setData] = useState<PositionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    fetchHeadcount();
  }, []);

  const fetchHeadcount = async () => {
    try {
      const response = await axiosInstance.get('/employees');
      
      if (response.data) {
        const employees = response.data;
        setTotal(employees.length);

        // Group by position
        const positionCounts: Record<string, number> = {};
        employees.forEach((emp: any) => {
          const position = emp.position || 'Not determined';
          positionCounts[position] = (positionCounts[position] || 0) + 1;
        });

        // Convert to array and sort
        const positionData: PositionData[] = Object.entries(positionCounts)
          .map(([position, count], index) => ({
            position,
            count,
            percentage: (count / employees.length) * 100,
            color: getColor(index),
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 6); // Top 6 positions

        setData(positionData);
      }
    } catch (error) {
      console.error('Failed to fetch headcount:', error);
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  const getColor = (index: number) => {
    return chartColors.palette[index % chartColors.palette.length];
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-xl border border-surface-border p-6 shadow-sm">
        <div className="animate-pulse">
          <div className="h-5 bg-surface-page rounded w-1/3 mb-4"></div>
          <div className="h-48 bg-surface-page rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface-card rounded-xl border border-surface-border p-6 shadow-sm hover:shadow-md transition-all h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-text-heading">Distribution by location</h3>
          <p className="text-sm text-text-muted mt-1">Top 6 positions</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 bg-brand-primary-light rounded-lg">
          <Users className="text-brand-primary" size={20} />
          <span className="text-sm font-bold text-brand-primary">{total}</span>
        </div>
      </div>

      {/* Position List */}
      <div className="space-y-4 flex-1">
        {data.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            <Users size={40} className="mx-auto mb-2" />
            <p>No data available</p>
          </div>
        ) : (
          data.map((item, index) => (
            <motion.div
              key={item.position}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1 }}
              className="space-y-2"
            >
              {/* Position Name & Count */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-sm font-medium text-text-body">
                    {item.position}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-text-heading">{item.count}</span>
                  <span className="text-xs text-text-muted">({item.percentage.toFixed(1)}%)</span>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="w-full h-2 bg-surface-page rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${item.percentage}%` }}
                  transition={{ delay: index * 0.1 + 0.2, duration: 0.8 }}
                  className="h-full rounded-full"
                  style={{ backgroundColor: item.color }}
                />
              </div>
            </motion.div>
          ))
        )}
      </div>

      {/* Summary */}
      <div className="mt-6 pt-4 border-t border-surface-border">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2 text-text-muted">
            <TrendingUp size={16} className="text-status-success" />
            <span>Diversity of locations</span>
          </div>
          <span className="font-bold text-text-heading">{data.length} location</span>
        </div>
      </div>
    </div>
  );
}
