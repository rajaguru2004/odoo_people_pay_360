'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, Pause, Square, Timer, Clock, Loader2 } from 'lucide-react';
import workLogService, { WorkLog } from '@/services/workLogService';

interface Props {
  taskId?: string;
  taskTitle?: string;
  onLogCreated?: () => void;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [
    h.toString().padStart(2, '0'),
    m.toString().padStart(2, '0'),
    s.toString().padStart(2, '0'),
  ].join(':');
}

export const TimerWidget: React.FC<Props> = ({ taskId, taskTitle, onLogCreated }) => {
  const [activeLog, setActiveLog] = useState<WorkLog | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);

  // Restore timer state on mount
  useEffect(() => {
    workLogService.getTimerStatus().then((res) => {
      const log = res.data;
      if (log) {
        setActiveLog(log);
        // Only show if relevant to this taskId (or show always if no taskId filter)
        if (!taskId || log.taskId === taskId) setIsExpanded(true);
      }
    }).catch(() => {});
  }, [taskId]);

  // Live clock
  useEffect(() => {
    if (!activeLog || !activeLog.timerActive) return;

    const calc = () => {
      const startMs = new Date(activeLog.startTime).getTime();
      const nowMs = activeLog.timerPausedAt
        ? new Date(activeLog.timerPausedAt).getTime()
        : Date.now();
      const pausedMs = activeLog.timerPausedSecs * 1000;
      const netMs = nowMs - startMs - pausedMs;
      setElapsed(Math.max(0, Math.floor(netMs / 1000)));
    };

    calc();

    if (activeLog.timerPausedAt) return;

    const interval = setInterval(calc, 1000);
    return () => clearInterval(interval);
  }, [activeLog]);

  const handleStart = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const res = await workLogService.startTimer(taskId, notes || undefined);
      setActiveLog(res.data);
      setIsExpanded(true);
      setElapsed(0);
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Failed to start timer');
    } finally {
      setLoading(false);
    }
  }, [taskId, notes]);

  const handlePause = useCallback(async () => {
    setLoading(true);
    try {
      const res = await workLogService.pauseTimer();
      setActiveLog(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleResume = useCallback(async () => {
    setLoading(true);
    try {
      const res = await workLogService.resumeTimer();
      setActiveLog(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleStop = useCallback(async () => {
    setLoading(true);
    try {
      await workLogService.stopTimer(notes || undefined);
      setActiveLog(null);
      setElapsed(0);
      setNotes('');
      setIsExpanded(false);
      onLogCreated?.();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Failed to stop timer');
    } finally {
      setLoading(false);
    }
  }, [notes, onLogCreated]);

  const isRunning = activeLog?.timerActive && !activeLog?.timerPausedAt;
  const isPaused = activeLog?.timerActive && !!activeLog?.timerPausedAt;
  const hasActiveTimer = !!activeLog?.timerActive;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${isRunning ? 'bg-green-500 animate-pulse' : isPaused ? 'bg-brand-accent' : 'bg-slate-400'}`} />
          <span className="text-sm font-semibold text-slate-800">
            {isRunning ? 'Timer Running' : isPaused ? 'Timer Paused' : 'Work Timer'}
          </span>
        </div>
        <Timer className="h-4 w-4 text-slate-400" />
      </div>

      {/* Task label */}
      {(taskTitle || activeLog?.task?.title) && (
        <p className="text-xs text-slate-500 mb-3 truncate">
          {activeLog?.task ? `[${activeLog.task.taskCode}] ${activeLog.task.title}` : taskTitle}
        </p>
      )}

      {/* Clock display */}
      <motion.div
        className="text-center py-3"
        key={Math.floor(elapsed / 1)}
      >
        <span className={`font-mono text-4xl font-bold tracking-wider ${isRunning ? 'text-green-600' : isPaused ? 'text-brand-accent-dark' : 'text-slate-700'}`}>
          {formatDuration(elapsed)}
        </span>
      </motion.div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-3 mt-3">
        {!hasActiveTimer && taskId && (
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleStart}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl bg-brand-primary hover:bg-brand-primary-dark px-5 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Start Timer
          </motion.button>
        )}

        {isRunning && (
          <>
            <motion.button
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              onClick={handlePause} disabled={loading}
              className="flex items-center gap-2 rounded-xl bg-brand-accent hover:bg-brand-accent-dark px-4 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
              Pause
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              onClick={handleStop} disabled={loading}
              className="flex items-center gap-2 rounded-xl bg-red-600 hover:bg-red-700 px-4 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50"
            >
              <Square className="h-4 w-4" />
              Stop
            </motion.button>
          </>
        )}

        {isPaused && (
          <>
            <motion.button
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              onClick={handleResume} disabled={loading}
              className="flex items-center gap-2 rounded-xl bg-brand-primary hover:bg-brand-primary-dark px-4 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Resume
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              onClick={handleStop} disabled={loading}
              className="flex items-center gap-2 rounded-xl bg-red-600 hover:bg-red-700 px-4 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50"
            >
              <Square className="h-4 w-4" />
              Stop
            </motion.button>
          </>
        )}
      </div>

      {/* Notes input */}
      <AnimatePresence>
        {(hasActiveTimer || taskId) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-4"
          >
            <textarea
              rows={2}
              placeholder="Add notes for this session..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-xl bg-white border border-slate-200 text-sm text-slate-700 placeholder-slate-400 px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
