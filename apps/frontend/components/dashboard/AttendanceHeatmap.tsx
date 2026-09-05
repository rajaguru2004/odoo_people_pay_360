'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

export default function AttendanceHeatmap() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchHeatmapData();
  }, []);

  const fetchHeatmapData = async () => {
    try {
      // Generate last 4 weeks of data
      const weeks = [];
      const today = new Date();
      
      for (let week = 3; week >= 0; week--) {
        const weekData = [];
        for (let day = 0; day < 7; day++) {
          const date = new Date(today);
          date.setDate(date.getDate() - (week * 7 + (6 - day)));
          
          // Mock attendance rate (70-100%)
          const rate = Math.floor(Math.random() * 30) + 70;
          weekData.push({
            date: date.toISOString().split('T')[0],
            rate,
            day: date.getDay(),
          });
        }
        weeks.push(weekData);
      }
      
      setData(weeks);
    } catch (error) {
      console.error('Failed to fetch heatmap data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-2xl p-6 border border-surface-border">
        <div className="animate-pulse">
          <div className="h-6 bg-surface-page rounded w-1/3 mb-4"></div>
          <div className="h-40 bg-surface-page rounded"></div>
        </div>
      </div>
    );
  }

  const getColorByRate = (rate: number) => {
    if (rate >= 95) return 'bg-status-success';
    if (rate >= 85) return 'bg-status-success/70';
    if (rate >= 75) return 'bg-brand-accent';
    if (rate >= 60) return 'bg-brand-accent/70';
    return 'bg-status-error';
  };

  const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

  return (
    <div className="bg-surface-card rounded-2xl p-6 border border-surface-border h-full flex flex-col">
      {/* Header */}
      <div className="mb-6">
        <h3 className="text-lg font-bold text-text-heading">Timekeeping Map</h3>
        <p className="text-sm text-text-muted mt-1">Latest 4 weeks</p>
      </div>

      {/* Heatmap */}
      <div className="space-y-2">
        {/* Day labels */}
        <div className="flex gap-2">
          <div className="w-8"></div>
          {dayNames.map((day) => (
            <div key={day} className="flex-1 text-center">
              <span className="text-xs font-medium text-text-muted">{day}</span>
            </div>
          ))}
        </div>

        {/* Weeks */}
        {data.map((week, weekIndex) => (
          <div key={weekIndex} className="flex gap-2">
            <div className="w-8 flex items-center">
              <span className="text-xs text-text-muted">T{4 - weekIndex}</span>
            </div>
            {week.map((day: any, dayIndex: number) => (
              <motion.div
                key={dayIndex}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: (weekIndex * 7 + dayIndex) * 0.02 }}
                className="flex-1 group relative"
              >
                <div
                  className={`aspect-square rounded-lg ${getColorByRate(day.rate)} cursor-pointer hover:scale-110 transition-transform`}
                >
                  {/* Tooltip */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-surface-overlay text-text-body border border-surface-border text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none shadow-md">
                    <div className="font-bold">{day.rate}%</div>
                    <div className="text-text-muted">{day.date}</div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-4 mt-6 pt-6 border-t border-surface-border-light">
        <span className="text-xs text-text-muted">Low</span>
        <div className="flex gap-1">
          <div className="w-4 h-4 rounded bg-status-error"></div>
          <div className="w-4 h-4 rounded bg-brand-accent/70"></div>
          <div className="w-4 h-4 rounded bg-brand-accent"></div>
          <div className="w-4 h-4 rounded bg-status-success/70"></div>
          <div className="w-4 h-4 rounded bg-status-success"></div>
        </div>
        <span className="text-xs text-text-muted">Cao</span>
      </div>
    </div>
  );
}
