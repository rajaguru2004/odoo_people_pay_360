'use client';

import React, { useEffect, useState } from 'react';
import { ListChecks, Plus, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import projectTaskService from '@/services/projectTaskService';
import type { ProjectTask } from '@/types/project';

export default function Subtasks({ taskId, onChanged }: { taskId: string; onChanged?: () => void }) {
  const t = useTranslations('subtasks');
  const [subtasks, setSubtasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading]   = useState(true);
  const [adding, setAdding]     = useState(false);
  const [title, setTitle]       = useState('');
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = (await projectTaskService.getSubtasks(taskId)) as any;
      setSubtasks(res.data || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [taskId]);

  const add = async () => {
    if (!title.trim()) return;
    setAdding(true);
    try {
      await projectTaskService.createSubtask(taskId, { title });
      setTitle('');
      setShowForm(false);
      await load();
      onChanged?.();
    } finally { setAdding(false); }
  };

  const toggle = async (st: ProjectTask) => {
    const done = st.workflowStatus?.category === 'DONE' || st.status === 'COMPLETED';
    await projectTaskService.update(st.id, { status: done ? 'TODO' : 'COMPLETED' } as any);
    await load();
  };

  const completed = subtasks.filter(
    (s) => s.workflowStatus?.category === 'DONE' || s.status === 'COMPLETED',
  ).length;
  const pct = subtasks.length ? Math.round((completed / subtasks.length) * 100) : 0;

  return (
    <div>
      {/* Section header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-brand-primary" />
          <h3 className="text-sm font-semibold text-text-heading">
            {t('heading')}
            {subtasks.length > 0 && (
              <span className="ms-1.5 text-text-muted">{t('progressSuffix', { completed, total: subtasks.length })}</span>
            )}
          </h3>
        </div>
      </div>

      {/* Progress bar */}
      {subtasks.length > 0 && (
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-border-light">
          <div className="h-full rounded-full bg-status-success transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}

      {/* Subtask list */}
      {loading ? (
        <Loader2 className="mx-auto h-4 w-4 animate-spin text-text-muted" />
      ) : (
        <div className="space-y-1">
          {subtasks.map((st) => {
            const done = st.workflowStatus?.category === 'DONE' || st.status === 'COMPLETED';
            return (
              <div key={st.id} data-testid={`subtask-row-${st.taskCode}`}
                className="flex items-center gap-2 rounded-[--radius-button] px-2 py-1.5 hover:bg-surface-page">
                <button onClick={() => toggle(st)} data-testid={`subtask-toggle-${st.taskCode}`} className={done ? 'text-status-success' : 'text-text-muted'}>
                  {done ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                </button>
                <span className="text-xs text-text-muted">{st.taskCode}</span>
                <span className={`text-sm ${done ? 'text-text-muted line-through' : 'text-text-body'}`}>
                  {st.title}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Inline add form */}
      {showForm ? (
        <div className="mt-3 flex items-center gap-2">
          <input
            autoFocus value={title}
            data-testid="subtask-title"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
              if (e.key === 'Escape') { setShowForm(false); setTitle(''); }
            }}
            placeholder={t('addPlaceholder')}
            className="flex-1 rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-1.5 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
          />
          <button
            onClick={add} disabled={adding || !title.trim()}
            data-testid="subtask-submit"
            className="flex items-center justify-center rounded-[--radius-button] bg-brand-primary p-2 text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60">
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          data-testid="subtask-add"
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[--radius-button] border border-dashed border-surface-border px-4 py-2 text-sm text-text-muted hover:border-brand-primary hover:text-brand-primary">
          <Plus className="h-4 w-4" />
          {t('addBtn')}
        </button>
      )}
    </div>
  );
}
