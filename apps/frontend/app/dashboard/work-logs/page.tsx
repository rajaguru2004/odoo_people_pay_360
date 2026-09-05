'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Trash2, Clock } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import workLogService, { WorkLog } from '@/services/workLogService';
import { TimerWidget } from '@/components/work-logs/TimerWidget';
import { formatDateTime } from '@/utils/formatters';

export default function WorkLogsPage() {
  const { user } = useAuthStore();
  const [logs, setLogs] = useState<WorkLog[]>([]);
  const [loading, setLoading] = useState(true);

  const totalHours = logs.reduce((sum, l) => sum + (l.duration ? Number(l.duration) : 0), 0);

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Work Logs', `Total: ${totalHours.toFixed(1)}h logged`);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await workLogService.getMine();
      setLogs(res.data || []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this work log?')) return;
    await workLogService.delete(id);
    fetchLogs();
  };

  return (
    <ProtectedRoute requiredPermission="VIEW_TASKS">
      {/* The title/subtitle live in the sticky TopHeader, declared via
          usePageHeader above. */}
      <div className="space-y-6" data-testid="ess-work-logs">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Timer */}
          <div>
            <TimerWidget onLogCreated={fetchLogs} />
          </div>

          {/* Logs list */}
          <div className="lg:col-span-2 space-y-3">
            {loading ? (
              <div className="flex justify-center py-16">
                <div className="h-10 w-10 rounded-full border-2 border-brand-primary border-t-transparent animate-spin" />
              </div>
            ) : logs.length === 0 ? (
              <div className="bg-surface-card border border-surface-border rounded-[--radius-card] p-12 text-center">
                <Clock className="h-10 w-10 text-text-muted mx-auto mb-3" />
                <p className="text-text-muted">No work logs yet. Start a timer above!</p>
              </div>
            ) : (
              logs.map((log, i) => (
                <motion.div
                  key={log.id}
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="bg-surface-card border border-surface-border rounded-[--radius-card] p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      {log.task && (
                        <p className="text-xs font-mono font-bold text-brand-primary mb-1">[{log.task.taskCode}] {log.task.title}</p>
                      )}
                      <div className="flex items-center gap-3 text-sm text-text-muted">
                        <span>{formatDateTime(log.startTime)}</span>
                        {log.endTime && <span>→ {formatDateTime(log.endTime)}</span>}
                        {log.timerActive && (
                          <span className="flex items-center gap-1.5 text-status-success font-bold">
                            <span className="h-1.5 w-1.5 rounded-full bg-status-success animate-pulse" />
                            Running
                          </span>
                        )}
                      </div>
                      {log.notes && <p className="text-xs text-text-body mt-1.5">{log.notes}</p>}
                    </div>
                    <div className="flex items-center gap-3 ml-4 shrink-0">
                      {log.duration && (
                        <span className="text-sm font-mono font-bold text-status-success">
                          {Number(log.duration).toFixed(1)}h
                        </span>
                      )}
                      {!log.timerActive && (
                        <button onClick={() => handleDelete(log.id)} className="text-text-muted hover:text-status-error transition-colors">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
