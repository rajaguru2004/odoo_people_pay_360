'use client';

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Loader2, Calendar, AlertTriangle, CheckCircle2, Clock,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import projectTaskService from '@/services/projectTaskService';
import TaskDetailDrawer from '@/components/projects/TaskDetailDrawer';
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge';
import type { Project, ProjectTask } from '@/types/project';

// ── Constants ────────────────────────────────────────────────────────────────

type ViewMode = 'days' | 'weeks' | 'months';
const DAY = 86400000;
const LEFT_PANEL = 280;
const ROW_H = 48;
const COMPACT_H = 32;
const MIN_ROWS = 10;

const CELL_W: Record<ViewMode, number> = { days: 40, weeks: 120, months: 90 };

// ── Date helpers ─────────────────────────────────────────────────────────────

const parseDate = (d: string | null | undefined): Date => {
  if (!d) return new Date();
  const p = new Date(d);
  return isNaN(p.getTime()) ? new Date() : p;
};

const startOfWeek = (d: Date) => {
  const c = new Date(d);
  c.setDate(d.getDate() - d.getDay());
  c.setHours(0, 0, 0, 0);
  return c;
};
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

const fmtShort = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtMonthYear = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
const fmtWeek = (d: Date) => {
  const end = new Date(d); end.setDate(d.getDate() + 6);
  return `${fmtShort(d)} – ${fmtShort(end)}`;
};

function isWeekend(d: Date) { const day = d.getDay(); return day === 0 || day === 6; }

function addDays(d: Date, n: number) { const c = new Date(d); c.setDate(d.getDate() + n); return c; }

// ── Time scale generation ────────────────────────────────────────────────────

function buildScale(start: Date, end: Date, mode: ViewMode): Date[] {
  const scale: Date[] = [];
  const cur = mode === 'weeks' ? startOfWeek(new Date(start))
    : mode === 'months' ? startOfMonth(new Date(start))
    : new Date(start);
  cur.setHours(0, 0, 0, 0);
  const limit = mode === 'months' ? 120 : mode === 'weeks' ? 400 : 800;
  while (cur <= end && scale.length < limit) {
    scale.push(new Date(cur));
    if (mode === 'days') cur.setDate(cur.getDate() + 1);
    else if (mode === 'weeks') cur.setDate(cur.getDate() + 7);
    else cur.setMonth(cur.getMonth() + 1);
  }
  return scale;
}

// ── Bar position calc ────────────────────────────────────────────────────────

function barPosition(
  taskStart: Date, taskEnd: Date,
  scaleStart: Date, mode: ViewMode,
): { left: number; width: number } {
  const cellW = CELL_W[mode];
  let msPerCell: number;
  if (mode === 'days') msPerCell = DAY;
  else if (mode === 'weeks') msPerCell = 7 * DAY;
  else msPerCell = 30.44 * DAY;

  const left = ((taskStart.getTime() - scaleStart.getTime()) / msPerCell) * cellW;
  const width = Math.max(cellW, ((taskEnd.getTime() - taskStart.getTime()) / msPerCell) * cellW);
  return { left, width };
}

// ── Task row component ────────────────────────────────────────────────────────

interface RowTask extends ProjectTask {
  _startMs: number;
  _endMs: number;
  _isEstimated?: boolean;
}

function GanttRow({
  task, scale, mode, scaleStart, compact, onOpen, onDateChange, slug,
}: {
  task: RowTask;
  scale: Date[];
  mode: ViewMode;
  scaleStart: Date;
  compact: boolean;
  onOpen: () => void;
  onDateChange: (id: string, start: Date, end: Date) => void;
  slug: string;
}) {
  const t = useTranslations('projectGantt');
  const rowH = compact ? COMPACT_H : ROW_H;
  const cellW = CELL_W[mode];
  const totalW = scale.length * cellW;

  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);

  const [hover, setHover] = useState(false);
  const [resizing, setResizing] = useState<'left' | 'right' | null>(null);
  const [tempStart, setTempStart] = useState<Date | null>(null);
  const [tempEnd, setTempEnd] = useState<Date | null>(null);
  const dragRef = useRef({ startX: 0, initStart: new Date(task._startMs), initEnd: new Date(task._endMs) });
  const justResized = useRef(false);

  const currentStart = (resizing && tempStart) ? tempStart : new Date(task._startMs);
  const currentEnd = (resizing && tempEnd) ? tempEnd : new Date(task._endMs);

  const { left, width } = barPosition(currentStart, currentEnd, scaleStart, mode);

  const isOverdue = currentEnd < today && task.workflowStatus?.category !== 'DONE';
  const isDone = task.workflowStatus?.category === 'DONE';
  const isInProgress = task.workflowStatus?.category === 'IN_PROGRESS';

  const startResize = (e: React.MouseEvent, dir: 'left' | 'right') => {
    e.stopPropagation();
    e.preventDefault();
    justResized.current = false;
    dragRef.current = {
      startX: e.clientX,
      initStart: new Date(task._startMs),
      initEnd: new Date(task._endMs),
    };
    setTempStart(new Date(task._startMs));
    setTempEnd(new Date(task._endMs));
    setResizing(dir);
  };

  useEffect(() => {
    if (!resizing) return;

    const onMove = (e: MouseEvent) => {
      justResized.current = true;
      const dx = e.clientX - dragRef.current.startX;
      let msPerCellLocal: number;
      if (mode === 'days') msPerCellLocal = DAY;
      else if (mode === 'weeks') msPerCellLocal = 7 * DAY;
      else msPerCellLocal = 30.44 * DAY;
      const deltaMs = (dx / cellW) * msPerCellLocal;

      if (resizing === 'left') {
        const ns = new Date(dragRef.current.initStart.getTime() + deltaMs);
        const maxS = new Date(dragRef.current.initEnd.getTime() - DAY);
        setTempStart(ns < maxS ? ns : maxS);
      } else {
        const ne = new Date(dragRef.current.initEnd.getTime() + deltaMs);
        const minE = new Date(dragRef.current.initStart.getTime() + DAY);
        setTempEnd(ne > minE ? ne : minE);
      }
    };

    const onUp = () => {
      setResizing(null);
      if (justResized.current) {
        const s = tempStart ?? new Date(task._startMs);
        const en = tempEnd ?? new Date(task._endMs);
        if (s.getTime() !== task._startMs || en.getTime() !== task._endMs) {
          onDateChange(task.id, s, en);
        }
      }
      setTempStart(null);
      setTempEnd(null);
      setTimeout(() => { justResized.current = false; }, 100);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizing, cellW, mode, task._startMs, task._endMs]);

  const barColor = isOverdue ? '#ef4444'
    : isDone ? '#22c55e'
    : (task.workflowStatus?.color || '#6366f1');

  return (
    <div
      className={`flex items-center border-b border-surface-border transition-colors ${
        isOverdue ? 'bg-status-error-bg/30' : hover ? 'bg-surface-page' : ''
      }`}
      style={{ height: `${rowH}px` }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Left panel */}
      <div
        className="sticky start-0 z-10 flex shrink-0 items-center gap-2 border-e border-surface-border bg-inherit px-3"
        style={{ width: LEFT_PANEL, height: rowH }}
      >
        <span className="text-[10px] font-mono text-text-muted shrink-0">{task.taskCode}</span>
        <span
          className="flex-1 truncate text-xs font-medium text-text-body cursor-pointer hover:text-brand-primary"
          onClick={onOpen}
          title={task.title}
        >
          {task.title}
        </span>
        {!compact && <TaskPriorityBadge priority={task.priority} />}
        {task._isEstimated && (
          <span className="text-[9px] text-text-muted italic shrink-0">{t('estAbbrev')}</span>
        )}
      </div>

      {/* Timeline area */}
      <div className="relative flex-1" style={{ height: rowH, minWidth: totalW }}>
        {/* Grid cells */}
        <div className="absolute inset-0 flex">
          {scale.map((day, i) => {
            const isToday = day.toDateString() === today.toDateString();
            return (
              <div
                key={i}
                className={`h-full border-r border-surface-border/40 shrink-0 ${
                  mode === 'days' && isWeekend(day) ? 'bg-surface-page/60' : ''
                } ${isToday && mode === 'days' ? 'bg-brand-primary/5' : ''}`}
                style={{ width: cellW }}
              />
            );
          })}
        </div>

        {/* Today vertical line */}
        {(() => {
          const todayIdx = scale.findIndex((d) => d.toDateString() === today.toDateString());
          if (todayIdx === -1) return null;
          return (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-brand-primary/60 z-10 pointer-events-none"
              style={{ left: todayIdx * cellW + cellW / 2 }}
            />
          );
        })()}

        {/* Task bar */}
        <div
          className={`absolute group rounded shadow-sm border cursor-pointer select-none transition-shadow hover:shadow-md ${
            isOverdue ? 'animate-pulse' : ''
          }`}
          style={{
            left: Math.max(0, left),
            width: Math.max(cellW * 0.5, width),
            top: '50%',
            height: compact ? 20 : 28,
            transform: 'translateY(-50%)',
            backgroundColor: barColor,
            borderColor: `${barColor}cc`,
            zIndex: resizing || hover ? 10 : 2,
          }}
          onClick={() => { if (!justResized.current) onOpen(); }}
          title={`${task.title}\n${t('dateRangeArrow', { start: fmtShort(currentStart), end: fmtShort(currentEnd) })}`}
        >
          {/* Resize left */}
          {!isDone && (
            <div
              className="absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-black/20 hover:bg-black/30 z-20 rounded-l"
              onMouseDown={(e) => startResize(e, 'left')}
              onClick={(e) => e.stopPropagation()}
            />
          )}

          {/* Label */}
          <div className="h-full flex items-center justify-between px-2 overflow-hidden">
            {width > 64 && !compact && (
              <span className="text-[10px] font-medium text-white truncate leading-tight">
                {task.title}
              </span>
            )}
            <div className="flex items-center gap-0.5 ms-auto shrink-0">
              {isDone && <CheckCircle2 className="h-3 w-3 text-white/90" />}
              {isOverdue && !isDone && <AlertTriangle className="h-3 w-3 text-white/90" />}
              {isInProgress && !isOverdue && <Clock className="h-3 w-3 text-white/90" />}
            </div>
          </div>

          {/* Resize right */}
          {!isDone && (
            <div
              className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-black/20 hover:bg-black/30 z-20 rounded-r"
              onMouseDown={(e) => startResize(e, 'right')}
              onClick={(e) => e.stopPropagation()}
            />
          )}

          {/* Hover tooltip */}
          {(hover || resizing) && (
            <div
              className="absolute -top-16 left-1/2 -translate-x-1/2 z-50 whitespace-nowrap rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2 shadow-xl text-xs pointer-events-none"
              style={{ minWidth: 180 }}
            >
              <div className="font-semibold text-text-heading mb-1 truncate max-w-[200px]">{task.title}</div>
              <div className="text-text-muted">{t('dateRangeArrow', { start: fmtShort(currentStart), end: fmtShort(currentEnd) })}</div>
              {task.workflowStatus && (
                <div className="mt-1 flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: task.workflowStatus.color }} />
                  <span className="text-text-body">{task.workflowStatus.name}</span>
                </div>
              )}
              {isOverdue && <div className="mt-1 text-status-error font-medium">{t('legendOverdue')}</div>}
              {/* Caret */}
              <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-surface-border" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Timeline header (two-level) ───────────────────────────────────────────────

type GroupCell = { label: string; span: number };

function buildGroupRow(scale: Date[], mode: ViewMode): GroupCell[] {
  const groups: GroupCell[] = [];
  let cur = '';
  let span = 0;

  const groupKey = (d: Date) => {
    if (mode === 'days') return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (mode === 'weeks') return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return String(d.getFullYear());
  };

  for (const d of scale) {
    const k = groupKey(d);
    if (k !== cur) {
      if (span > 0) groups.push({ label: cur, span });
      cur = k; span = 1;
    } else {
      span++;
    }
  }
  if (span > 0) groups.push({ label: cur, span });
  return groups;
}

function TimelineHeader({ scale, mode }: { scale: Date[]; mode: ViewMode }) {
  const t = useTranslations('projectGantt');
  const cellW = CELL_W[mode];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const groups = buildGroupRow(scale, mode);

  const detailLabel = (d: Date): string => {
    if (mode === 'days') return String(d.getDate());
    if (mode === 'weeks') {
      const end = addDays(d, 6);
      // If month changes within the week, show "Jun 28 – Jul 4"
      if (d.getMonth() !== end.getMonth()) {
        return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      }
      return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.getDate()}`;
    }
    // months
    return d.toLocaleDateString(undefined, { month: 'short' });
  };

  const isToday = (d: Date) => {
    if (mode === 'days') return d.toDateString() === today.toDateString();
    if (mode === 'weeks') return d <= today && addDays(d, 7) > today;
    return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth();
  };

  return (
    <div className="sticky top-0 z-20 border-b border-surface-border bg-surface-card shadow-sm">
      {/* ── Row 1: group labels (month / year) ── */}
      <div className="flex border-b border-surface-border/50">
        {/* Left panel corner */}
        <div
          className="sticky start-0 z-20 shrink-0 border-e border-surface-border bg-surface-page"
          style={{ width: LEFT_PANEL, height: 24 }}
        />
        {/* Group cells */}
        <div className="flex">
          {groups.map((g, i) => (
            <div
              key={i}
              className="shrink-0 border-r border-surface-border/40 bg-surface-page px-3 flex items-center"
              style={{ width: g.span * cellW, height: 24 }}
            >
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider truncate">
                {g.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Row 2: detail cells (day / week-range / month) ── */}
      <div className="flex">
        {/* Left panel label */}
        <div
          className="sticky start-0 z-20 flex shrink-0 items-center border-e border-surface-border bg-surface-page px-3"
          style={{ width: LEFT_PANEL, height: 36 }}
        >
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">{t('tasksCornerLabel')}</span>
        </div>
        {/* Detail cells */}
        <div className="flex">
          {scale.map((d, i) => {
            const todayCell = isToday(d);
            const weekend = mode === 'days' && isWeekend(d);
            return (
              <div
                key={i}
                className={`shrink-0 border-r border-surface-border/40 flex flex-col items-center justify-center text-center ${
                  weekend
                    ? 'bg-surface-page/60 text-text-muted'
                    : todayCell
                    ? 'bg-brand-primary/10 text-brand-primary'
                    : 'text-text-muted hover:bg-surface-page'
                }`}
                style={{ width: cellW, height: 36 }}
              >
                {mode === 'days' ? (
                  <>
                    <span className="text-[9px] leading-none opacity-70">
                      {d.toLocaleDateString(undefined, { weekday: 'narrow' })}
                    </span>
                    <span className={`text-[11px] font-semibold leading-tight mt-0.5 ${todayCell ? 'text-brand-primary' : ''}`}>
                      {d.getDate()}
                    </span>
                    {todayCell && <span className="mt-0.5 h-1 w-1 rounded-full bg-brand-primary" />}
                  </>
                ) : (
                  <span className={`px-2 text-xs font-medium leading-tight text-center ${todayCell ? 'text-brand-primary font-semibold' : ''}`}>
                    {detailLabel(d)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProjectGantt({ project }: { project: Project }) {
  const t = useTranslations('projectGantt');
  const te = useTranslations('projectEnums');
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>('weeks');
  const [compact, setCompact] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await projectTaskService.list(project.id)) as any;
      setTasks(res.data || []);
    } finally { setLoading(false); }
  }, [project.id]);

  useEffect(() => { load(); }, [load]);

  // Process tasks — assign default dates for those without
  const rowTasks = useMemo((): RowTask[] => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return tasks.map((t, i): RowTask => {
      let s: Date, e: Date, estimated = false;
      if (t.startDate && t.dueDate) {
        s = parseDate(t.startDate); e = parseDate(t.dueDate);
      } else if (!t.startDate && t.dueDate) {
        e = parseDate(t.dueDate); s = addDays(e, -7);
        estimated = true;
      } else if (t.startDate && !t.dueDate) {
        s = parseDate(t.startDate); e = addDays(s, 7);
        estimated = true;
      } else {
        s = addDays(today, i * 2); e = addDays(s, 7);
        estimated = true;
      }
      return { ...t, _startMs: s.getTime(), _endMs: e.getTime(), _isEstimated: estimated };
    });
  }, [tasks]);

  // Build time scale
  const { scale, scaleStart } = useMemo(() => {
    if (rowTasks.length === 0) {
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const end = addDays(now, 60);
      const s = buildScale(addDays(now, -7), end, mode);
      return { scale: s, scaleStart: s[0] ?? now };
    }
    const allMs = rowTasks.flatMap((t) => [t._startMs, t._endMs]);
    const minMs = Math.min(...allMs);
    const maxMs = Math.max(...allMs);
    const start = addDays(new Date(minMs), -7);
    const end = addDays(new Date(maxMs), 14);
    const s = buildScale(start, end, mode);
    return { scale: s, scaleStart: s[0] ?? new Date(minMs) };
  }, [rowTasks, mode]);

  // Scroll to today on mount / mode change
  useEffect(() => {
    if (!scrollRef.current || scale.length === 0) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const idx = scale.findIndex((d) => {
      if (mode === 'days') return d.toDateString() === today.toDateString();
      if (mode === 'weeks') return d <= today && addDays(d, 7) > today;
      return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth();
    });
    if (idx !== -1) {
      const x = idx * CELL_W[mode] - scrollRef.current.clientWidth / 3;
      scrollRef.current.scrollTo({ left: Math.max(0, x), behavior: 'smooth' });
    }
  }, [scale, mode]);

  const handleDateChange = useCallback(async (id: string, start: Date, end: Date) => {
    setTasks((prev) => prev.map((t) =>
      t.id === id ? { ...t, startDate: start.toISOString(), dueDate: end.toISOString() } : t,
    ));
    try {
      await projectTaskService.update(id, { startDate: start.toISOString(), dueDate: end.toISOString() } as any);
    } catch {
      load();
    }
  }, [load]);

  const scrollToToday = () => {
    if (!scrollRef.current || scale.length === 0) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const idx = scale.findIndex((d) => d.toDateString() === today.toDateString());
    if (idx !== -1) {
      const x = idx * CELL_W[mode] - scrollRef.current.clientWidth / 3;
      scrollRef.current.scrollTo({ left: Math.max(0, x), behavior: 'smooth' });
    }
  };

  const emptyRows = Math.max(0, MIN_ROWS - rowTasks.length);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand-primary" />
      </div>
    );
  }

  return (
    <>
      <div className="rounded-[--radius-card] border border-surface-border bg-surface-card overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-page px-4 py-2">
          <div className="flex items-center gap-1 rounded-[--radius-button] border border-surface-border bg-surface-card p-0.5">
            {(['days', 'weeks', 'months'] as ViewMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-[--radius-button] px-3 py-1 text-xs font-medium capitalize transition ${
                  mode === m ? 'bg-brand-primary text-text-on-brand' : 'text-text-muted hover:text-text-body'
                }`}
              >
                {{ days: t('viewModeDays'), weeks: t('viewModeWeeks'), months: t('viewModeMonths') }[m]}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setCompact((v) => !v)}
              className={`rounded-[--radius-button] border px-3 py-1 text-xs transition ${
                compact ? 'border-brand-primary/40 bg-brand-primary-light text-brand-primary' : 'border-surface-border text-text-muted hover:text-text-body'
              }`}
            >
              {t('compactToggle')}
            </button>
            <button
              onClick={scrollToToday}
              className="flex items-center gap-1.5 rounded-[--radius-button] border border-surface-border px-3 py-1 text-xs text-text-muted hover:text-text-body transition"
            >
              <Calendar className="h-3.5 w-3.5" /> {t('todayBtn')}
            </button>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 border-b border-surface-border/50 bg-surface-page/50 px-4 py-1.5 text-[10px] text-text-muted">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-status-success" /> {te('categoryDone')}</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand-primary" /> {te('categoryInProgress')}</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-status-error" /> {t('legendOverdue')}</span>
          <span className="flex items-center gap-1 italic">{t('legendEstNote')}</span>
        </div>

        {/* Grid */}
        <div
          className="overflow-x-auto overflow-y-auto"
          ref={scrollRef}
          style={{ maxHeight: 'calc(100vh - 280px)' }}
        >
          <div style={{ minWidth: LEFT_PANEL + scale.length * CELL_W[mode] }}>
            <TimelineHeader scale={scale} mode={mode} />

            {/* Task rows */}
            {rowTasks.map((t) => (
              <GanttRow
                key={t.id}
                task={t}
                scale={scale}
                mode={mode}
                scaleStart={scaleStart}
                compact={compact}
                onOpen={() => setOpenTaskId(t.id)}
                onDateChange={handleDateChange}
                slug={project.slug}
              />
            ))}

            {/* Filler rows */}
            {Array.from({ length: emptyRows }).map((_, i) => (
              <div
                key={`empty-${i}`}
                className="flex border-b border-surface-border/40"
                style={{ height: compact ? COMPACT_H : ROW_H }}
              >
                <div
                  className="sticky start-0 z-10 shrink-0 border-e border-surface-border bg-surface-card"
                  style={{ width: LEFT_PANEL }}
                />
                <div className="flex flex-1">
                  {scale.map((d, si) => (
                    <div
                      key={si}
                      className={`shrink-0 border-r border-surface-border/30 ${
                        mode === 'days' && isWeekend(d) ? 'bg-surface-page/60' : ''
                      }`}
                      style={{ width: CELL_W[mode] }}
                    />
                  ))}
                </div>
              </div>
            ))}

            {rowTasks.length === 0 && (
              <div
                className="flex items-center justify-center text-text-muted text-sm"
                style={{ height: 200 }}
              >
                {t('emptyNoTasks')}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-surface-border bg-surface-page px-4 py-2 text-xs text-text-muted">
          {t('footerSummary', { count: rowTasks.length })}
        </div>
      </div>

      <TaskDetailDrawer
        taskId={openTaskId}
        slug={project.slug}
        onClose={() => setOpenTaskId(null)}
        onChanged={load}
      />
    </>
  );
}
