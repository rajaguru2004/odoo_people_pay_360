'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { BarChart2, TrendingUp } from 'lucide-react';
import dashboardService from '@/services/dashboardService';

interface DailyAttendance {
  date: string;
  count: number;
}

export default function AttendanceChart({ date }: { date?: string }) {
  const [data, setData] = useState<any[]>([]);
  const t = useTranslations('attendanceChart');
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<any>(null);

  useEffect(() => {
    fetchAttendanceData();
  }, [date]);

  const fetchAttendanceData = async () => {
    try {
      // Derive month/year from selected date (or today)
      const ref = date ? new Date(date) : new Date();
      const month = ref.getMonth() + 1;
      const year = ref.getFullYear();
      const response = await dashboardService.getAttendanceSummary(month, year);

      if (response.data) {
        const { trend, summary: summaryData } = response.data;
        setSummary(summaryData);

        const trendMap = new Map<string, number>(
          (trend || []).map((item: DailyAttendance) => [item.date, item.count])
        );

        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const formattedData = [];
        const refDate = date ? new Date(date) : new Date();
        for (let i = 6; i >= 0; i--) {
          const d = new Date(refDate);
          d.setDate(d.getDate() - i);
          const dateStr = d.toISOString().split('T')[0];
          formattedData.push({
            day: dayNames[d.getDay()],
            count: trendMap.get(dateStr) ?? 0,
            date: dateStr,
            isToday: i === 0,
          });
        }
        setData(formattedData);
      }
    } catch (error) {
      console.error('Failed to fetch attendance data:', error);
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-2xl border border-surface-border p-6 animate-pulse">
        <div className="flex items-center justify-between mb-5">
          <div className="space-y-2">
            <div className="h-4 w-32 bg-surface-page rounded" />
            <div className="h-3 w-20 bg-surface-page rounded" />
          </div>
          <div className="w-10 h-10 rounded-xl bg-surface-page" />
        </div>
        <div className="h-52 bg-surface-page rounded-xl" />
      </div>
    );
  }

  const maxValue = Math.max(...data.map(d => d.count), 1);
  const presentRate = summary?.presentRate ?? 0;

  return (
    <div className="bg-surface-card rounded-2xl border border-surface-border hover:border-brand-primary/30 hover:shadow-lg transition-all duration-300 h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-surface-border-light">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center shadow-md">
            <BarChart2 className="text-white" size={18} />
          </div>
          <div>
            <h3 className="text-base font-bold text-text-heading">{t('title')}</h3>
            <p className="text-sm text-text-muted mt-0.5">{t('subtitle')}</p>
          </div>
        </div>
      </div>

      {/* Chart */}
      {/* Chart */}
      <div className="flex-1 px-6 pt-4 pb-5 flex flex-col">
        <div className="flex-1 min-h-[160px] flex items-end justify-between gap-2">
          {data.length === 0 ? (
            <div className="w-full h-full flex items-center justify-center text-text-muted text-sm">
              {t('noDataAvailable')}
            </div>
          ) : (
            data.map((item, index) => {
              const height = maxValue > 0 ? (item.count / maxValue) * 100 : 0;
              return (
                <div key={item.date} className="flex-1 flex flex-col items-center gap-2 group h-full">
                  {/* Bar */}
                  <div className="w-full flex flex-col-reverse gap-1 flex-1 relative min-h-[120px]">
                    {item.count > 0 && (
                      <>
                        {/* Hover tooltip */}
                        <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-surface-overlay border border-surface-border text-text-body text-xs px-2 py-1 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap shadow-lg z-10 pointer-events-none">
                          {item.count} {t('tooltipTimekeeping', { count: '' }).trim()}
                        </div>
                        <motion.div
                          initial={{ height: 0 }}
                          animate={{ height: `${height}%` }}
                          transition={{ delay: index * 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                          className={`w-full rounded-t-lg relative cursor-pointer transition-all group-hover:brightness-110 ${
                            item.isToday
                              ? 'bg-gradient-to-t from-brand-primary to-brand-primary-light'
                              : 'bg-gradient-to-t from-brand-primary/60 to-brand-primary/30'
                          }`}
                        >
                          {/* Today indicator dot */}
                          {item.isToday && (
                            <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-brand-primary shadow-md" />
                          )}
                        </motion.div>
                      </>
                    )}
                    {item.count === 0 && (
                      <div className="w-full h-1 bg-surface-page rounded-full mt-auto" />
                    )}
                  </div>

                  {/* Day label */}
                  <span className={`text-xs font-medium ${item.isToday ? 'text-brand-primary font-bold' : 'text-text-muted'}`}>
                    {item.day}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Summary Stats */}
        {summary && (
          <div className="flex items-center justify-between mt-auto pt-5 border-t border-surface-border-light gap-3">
            <div className="text-center flex-1">
              <p className="text-2xl font-bold text-brand-primary">{summary.present}</p>
              <p className="text-xs text-text-muted mt-0.5">{t('present')}</p>
            </div>
            {/* Divider */}
            <div className="w-px h-10 bg-surface-border-light" />
            <div className="text-center flex-1">
              <p className="text-2xl font-bold text-brand-accent">{summary.late}</p>
              <p className="text-xs text-text-muted mt-0.5">{t('goLate')}</p>
            </div>
            {/* Divider */}
            <div className="w-px h-10 bg-surface-border-light" />
            <div className="text-center flex-1">
              <div className="flex items-center justify-center gap-1">
                <p className="text-2xl font-bold text-status-success">{presentRate}%</p>
                <TrendingUp size={14} className="text-status-success mb-1" />
              </div>
              <p className="text-xs text-text-muted mt-0.5">{t('proportion')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
