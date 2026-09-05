'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Clock, TrendingUp } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import timesheetService from '@/services/timesheetService';
import { TimesheetStatusBadge } from '@/components/timesheets/TimesheetStatusBadge';

export default function MyTimesheetsPage() {
  // The one heading for this route, rendered by TopHeader.
  usePageHeader('My Timesheets', 'Your time tracking summary');

  const [view, setView] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);

  const getWeekStart = (offset = 0) => {
    const d = new Date();
    const day = d.getDay();
    d.setDate(d.getDate() - day + 1 + offset * 7);
    return d.toISOString().split('T')[0];
  };

  const getMonthYear = (offset = 0) => {
    const d = new Date();
    d.setMonth(d.getMonth() + offset);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      let res: any;
      if (view === 'daily') res = await timesheetService.getDailySummary();
      else if (view === 'weekly') res = await timesheetService.getWeeklySummary(getWeekStart(weekOffset));
      else {
        const { year, month } = getMonthYear(monthOffset);
        res = await timesheetService.getMonthlySummary(year, month);
      }
      setData(res.data);
    } finally { setLoading(false); }
  }, [view, weekOffset, monthOffset]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <ProtectedRoute requiredPermission="VIEW_TIMESHEETS">
      <div className="space-y-6" data-testid="ess-my-timesheets">
        <div className="max-w-4xl mx-auto">
          {/* The title/subtitle live in the sticky TopHeader, declared via
              usePageHeader above. */}

          {/* View toggle */}
          <div className="mb-6 flex items-center gap-4">
            <div className="flex rounded-[--radius-button] border border-surface-border bg-surface-card overflow-hidden shadow-sm">
              {(['daily', 'weekly', 'monthly'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-4 py-2.5 text-sm font-semibold capitalize transition-all cursor-pointer ${view === v ? 'bg-brand-primary text-text-on-brand' : 'text-text-body hover:bg-surface-page'}`}
                >
                  {v}
                </button>
              ))}
            </div>

            {/* Navigation */}
            {view === 'weekly' && (
              <div className="flex items-center gap-2">
                <button onClick={() => setWeekOffset((o) => o - 1)} className="inline-flex min-w-11 md:min-w-0 items-center justify-center rounded-[--radius-button] border border-surface-border bg-surface-card p-1.5 text-text-body hover:bg-surface-page transition-all shadow-sm cursor-pointer touch-manipulation">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm text-text-body font-bold min-w-[80px] text-center">{weekOffset === 0 ? 'This Week' : `${weekOffset > 0 ? '+' : ''}${weekOffset}w`}</span>
                <button onClick={() => setWeekOffset((o) => o + 1)} className="inline-flex min-w-11 md:min-w-0 items-center justify-center rounded-[--radius-button] border border-surface-border bg-surface-card p-1.5 text-text-body hover:bg-surface-page transition-all shadow-sm cursor-pointer touch-manipulation">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
            {view === 'monthly' && (
              <div className="flex items-center gap-2">
                <button onClick={() => setMonthOffset((o) => o - 1)} className="inline-flex min-w-11 md:min-w-0 items-center justify-center rounded-[--radius-button] border border-surface-border bg-surface-card p-1.5 text-text-body hover:bg-surface-page transition-all shadow-sm cursor-pointer touch-manipulation">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm text-text-body font-bold min-w-[80px] text-center">{monthOffset === 0 ? 'This Month' : `${monthOffset > 0 ? '+' : ''}${monthOffset}m`}</span>
                <button onClick={() => setMonthOffset((o) => o + 1)} className="inline-flex min-w-11 md:min-w-0 items-center justify-center rounded-[--radius-button] border border-surface-border bg-surface-card p-1.5 text-text-body hover:bg-surface-page transition-all shadow-sm cursor-pointer touch-manipulation">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {loading ? (
            <div className="flex justify-center py-20">
              <div className="h-10 w-10 rounded-full border-2 border-brand-primary border-t-transparent animate-spin" />
            </div>
          ) : data && (
            <div className="space-y-6">
              {/* Summary card */}
              <motion.div
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                className="bg-surface-card border border-surface-border rounded-[--radius-card] p-6 shadow-sm"
              >
                <div className="flex items-center gap-3 mb-2">
                  <Clock className="h-5 w-5 text-brand-primary" />
                  <span className="text-sm font-semibold text-text-muted">Total Hours</span>
                </div>
                <p className="text-4xl font-bold font-mono text-brand-primary">{Number(data.totalHours).toFixed(1)}h</p>
              </motion.div>

              {/* Daily breakdown */}
              {data.byDay && (
                <div className="space-y-3">
                  <h3 className="text-xs font-bold text-text-muted uppercase tracking-wider">Daily Breakdown</h3>
                  {data.byDay.map((day: any, i: number) => (
                    <motion.div
                      key={day.date}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.05 }}
                      className="bg-surface-card border border-surface-border rounded-[--radius-card] p-4 shadow-sm"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-bold text-text-heading">{new Date(day.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                        <span className="text-sm font-mono font-bold text-status-success">{Number(day.totalHours).toFixed(1)}h</span>
                      </div>
                      {day.items.map((ts: any) => (
                        <div key={ts.id} className="flex items-center justify-between text-xs text-text-body py-2 border-t border-surface-border-light font-semibold">
                          <span>{ts.task ? `[${ts.task.taskCode}] ${ts.task.title}` : ts.description || 'General'}</span>
                          <div className="flex items-center gap-3">
                            <TimesheetStatusBadge status={ts.status} size="sm" />
                            <span className="font-mono text-text-heading">{ts.hoursWorked}h</span>
                          </div>
                        </div>
                      ))}
                    </motion.div>
                  ))}
                </div>
              )}

              {/* Daily view */}
              {view === 'daily' && data.timesheets && (
                <div className="space-y-3">
                  {data.timesheets.length === 0
                    ? <p className="text-text-muted text-sm text-center py-8 bg-surface-card border border-surface-border rounded-[--radius-card] shadow-sm">No entries for this day</p>
                    : data.timesheets.map((ts: any) => (
                      <div key={ts.id} className="bg-surface-card border border-surface-border rounded-[--radius-card] p-4 flex justify-between shadow-sm">
                        <div>
                          <p className="text-sm font-bold text-text-heading">{ts.description || 'General'}</p>
                          {ts.task && <p className="text-xs text-brand-primary font-bold mt-0.5">[{ts.task.taskCode}] {ts.task.title}</p>}
                        </div>
                        <div className="flex items-center gap-3">
                          <TimesheetStatusBadge status={ts.status} size="sm" />
                          <span className="text-sm font-mono font-bold text-status-success">{ts.hoursWorked}h</span>
                        </div>
                      </div>
                    ))
                  }
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </ProtectedRoute>
  );
}
