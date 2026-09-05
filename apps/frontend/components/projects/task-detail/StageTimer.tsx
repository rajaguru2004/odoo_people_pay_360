'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Play, Square, Loader2, Timer } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';
import workLogService, { WorkLog } from '@/services/workLogService';
import { triggerPermissionError } from '@/lib/permissionError';

interface Props {
  taskId: string;
  /** Employee ids assigned to the task. */
  assigneeIds: string[];
  /** True when the viewer holds TASK_ASSIGN (project manager / owner / admin). */
  canManage?: boolean;
  /** Name of the stage the task is currently in (shown on the Start button). */
  currentStatusName?: string;
  /** Current stage id — when it changes the timer re-syncs (a move auto-stops it server-side). */
  statusId?: string | null;
  /** Called after a timer starts or stops so the parent can refresh. */
  onChanged?: () => void;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => n.toString().padStart(2, '0')).join(':');
}

export default function StageTimer({
  taskId,
  assigneeIds,
  canManage,
  currentStatusName,
  statusId,
  onChanged,
}: Props) {
  const t = useTranslations('stageTimer');
  const { user } = useAuthStore();
  const [activeLog, setActiveLog] = useState<WorkLog | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);

  const myEmployeeId = user?.employeeId;
  const isAssignee = !!myEmployeeId && assigneeIds.includes(myEmployeeId);
  const canStart = isAssignee || !!canManage;

  // Restore my active timer for this task on mount.
  const refreshStatus = useCallback(async () => {
    try {
      const res = (await workLogService.getTimerStatus()) as any;
      const log: WorkLog | null = res.data;
      setActiveLog(log && log.taskId === taskId ? log : null);
    } catch {
      setActiveLog(null);
    }
  }, [taskId]);

  // Re-sync on mount and whenever the stage changes (a move auto-stops the timer).
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus, statusId]);

  // Live clock while running (not paused).
  useEffect(() => {
    if (!activeLog?.timerActive) return;

    const calc = () => {
      const startMs = new Date(activeLog.startTime).getTime();
      const nowMs = activeLog.timerPausedAt
        ? new Date(activeLog.timerPausedAt).getTime()
        : Date.now();
      const pausedMs = (activeLog.timerPausedSecs || 0) * 1000;
      setElapsed(Math.max(0, Math.floor((nowMs - startMs - pausedMs) / 1000)));
    };

    calc();
    if (activeLog.timerPausedAt) return;
    const id = setInterval(calc, 1000);
    return () => clearInterval(id);
  }, [activeLog]);

  const handleStart = useCallback(async () => {
    if (!canStart) {
      triggerPermissionError(
        t('permissionError'),
      );
      return;
    }
    setLoading(true);
    try {
      const res = (await workLogService.startTimer(taskId)) as any;
      setActiveLog(res.data);
      setElapsed(0);
      onChanged?.();
    } catch (e: any) {
      const status = e?.statusCode || e?.response?.status;
      // 403 is handled globally by the axios interceptor (permission modal).
      if (status !== 403) {
        toast.error(e?.message || t('startFailedFallback'));
      }
    } finally {
      setLoading(false);
    }
  }, [canStart, taskId, onChanged]);

  const handleStop = useCallback(async () => {
    setLoading(true);
    try {
      await workLogService.stopTimer();
      setActiveLog(null);
      setElapsed(0);
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.message || t('stopFailedFallback'));
    } finally {
      setLoading(false);
    }
  }, [onChanged]);

  const running = !!activeLog?.timerActive;

  return (
    <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <Timer className="h-4 w-4 text-text-muted" />
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          {t('heading')}
        </span>
        {running && (
          <span className="ms-auto flex items-center gap-1.5 text-[11px] font-medium text-status-success">
            <span className="h-2 w-2 animate-pulse rounded-full bg-status-success" />
            {t('runningBadge')}
          </span>
        )}
      </div>

      {running ? (
        <div className="space-y-2.5">
          <div className="text-center">
            <span className="font-mono text-2xl font-bold tracking-wider text-text-heading">
              {formatDuration(elapsed)}
            </span>
            {activeLog?.statusName && (
              <p className="mt-0.5 text-[11px] text-text-muted">
                {t('elapsedInStage', { stage: activeLog.statusName })}
              </p>
            )}
          </div>
          <button
            onClick={handleStop}
            disabled={loading}
            data-testid="stage-timer-stop"
            className="flex w-full items-center justify-center gap-2 rounded-[--radius-button] bg-status-error px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            {t('stopAndLogBtn')}
          </button>
        </div>
      ) : (
        <button
          onClick={handleStart}
          disabled={loading}
          data-testid="stage-timer-start"
          className={`flex w-full items-center justify-center gap-2 rounded-[--radius-button] px-3 py-2 text-sm font-medium transition ${
            canStart
              ? 'bg-brand-primary text-text-on-brand hover:bg-brand-primary-dark'
              : 'cursor-not-allowed bg-brand-primary/40 text-text-on-brand opacity-50 blur-[0.4px]'
          } disabled:opacity-50`}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {currentStatusName ? t('startWithStage', { stage: currentStatusName }) : t('startTimerBtn')}
        </button>
      )}
    </div>
  );
}
