'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/common/icons/directional';
import projectTaskService from '@/services/projectTaskService';
import TaskDetailDrawer from '@/components/projects/TaskDetailDrawer';
import type { Project, ProjectTask } from '@/types/project';

export default function ProjectCalendar({ project }: { project: Project }) {
  const t = useTranslations('projectCalendar');
  const DOW = [t('dowSun'), t('dowMon'), t('dowTue'), t('dowWed'), t('dowThu'), t('dowFri'), t('dowSat')];
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = (await projectTaskService.list(project.id)) as any;
        setTasks(res.data || []);
      } finally { setLoading(false); }
    })();
  }, [project.id]);

  const { weeks, monthLabel } = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks: (Date | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return { weeks, monthLabel: cursor.toLocaleString(undefined, { month: 'long', year: 'numeric' }) };
  }, [cursor]);

  const tasksByDay = useMemo(() => {
    const map: Record<string, ProjectTask[]> = {};
    tasks.forEach((t) => {
      if (!t.dueDate) return;
      const key = new Date(t.dueDate).toDateString();
      (map[key] ||= []).push(t);
    });
    return map;
  }, [tasks]);

  const move = (delta: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
  const today = new Date().toDateString();

  if (loading) return <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-brand-primary" /></div>;

  return (
    <>
    <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold text-text-heading">{monthLabel}</h3>
        <div className="flex gap-1">
          <button onClick={() => move(-1)} className="rounded-[--radius-button] border border-surface-border p-1.5 text-text-body hover:bg-surface-page"><ChevronLeftIcon className="h-4 w-4" /></button>
          <button onClick={() => setCursor(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })} className="rounded-[--radius-button] border border-surface-border px-3 py-1.5 text-xs text-text-body hover:bg-surface-page">{t('todayBtn')}</button>
          <button onClick={() => move(1)} className="rounded-[--radius-button] border border-surface-border p-1.5 text-text-body hover:bg-surface-page"><ChevronRightIcon className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {DOW.map((d) => <div key={d} className="px-1 py-1 text-center text-xs font-medium text-text-muted">{d}</div>)}
        {weeks.flat().map((day, i) => {
          const key = day?.toDateString();
          const dayTasks = key ? tasksByDay[key] || [] : [];
          return (
            <div key={i} className={`min-h-[90px] rounded-[--radius-button] border p-1 ${day ? 'border-surface-border-light bg-surface-card' : 'border-transparent'} ${key === today ? 'ring-1 ring-brand-primary' : ''}`}>
              {day && <div className="mb-1 text-xs text-text-muted">{day.getDate()}</div>}
              <div className="space-y-1">
                {dayTasks.slice(0, 3).map((dt) => (
                  <button key={dt.id} onClick={() => setOpenTaskId(dt.id)}
                    className="block w-full truncate rounded px-1 py-0.5 text-start text-[10px] font-medium text-white"
                    style={{ backgroundColor: dt.workflowStatus?.color || '#64748B' }} title={dt.title}>
                    {dt.title}
                  </button>
                ))}
                {dayTasks.length > 3 && <p className="text-[10px] text-text-muted">{t('moreOverflow', { count: dayTasks.length - 3 })}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
    <TaskDetailDrawer taskId={openTaskId} slug={project.slug} onClose={() => setOpenTaskId(null)} onChanged={() => {}} />
    </>
  );
}
