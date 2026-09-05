'use client';

import React, { useEffect, useState } from 'react';
import { Plus, X, Loader2, Link2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import projectTaskService from '@/services/projectTaskService';

interface DepTask { id: string; taskCode: string; title: string; status: string }
interface Dep { id: string; type: string; blockingTask?: DepTask; dependentTask?: DepTask }

export default function TaskDependencies({ taskId, projectId }: { taskId: string; projectId?: string }) {
  const t = useTranslations('taskDependencies');
  const [dependsOn, setDependsOn] = useState<Dep[]>([]);
  const [blocks, setBlocks] = useState<Dep[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [options, setOptions] = useState<any[]>([]);
  const [selected, setSelected] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = (await projectTaskService.getDependencies(taskId)) as any;
      setDependsOn(res.data?.dependsOn || []);
      setBlocks(res.data?.blocks || []);
      if (projectId) {
        const t = (await projectTaskService.list(projectId)) as any;
        setOptions((t.data || []).filter((x: any) => x.id !== taskId));
      }
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [taskId]);

  const add = async () => {
    if (!selected) return;
    setAdding(true);
    try {
      await projectTaskService.addDependency(taskId, selected, 'BLOCKS');
      setSelected('');
      await load();
    } finally { setAdding(false); }
  };
  const remove = async (id: string) => { await projectTaskService.removeDependency(id); await load(); };

  const Row = ({ t, depId }: { t?: DepTask; depId: string }) => t ? (
    <div data-testid={`dependency-row-${t.taskCode}`} className="flex items-center justify-between rounded-[--radius-button] border border-surface-border px-3 py-1.5">
      <span className="flex items-center gap-2 text-sm">
        <span className="text-xs text-text-muted">{t.taskCode}</span>
        <span className="text-text-body">{t.title}</span>
      </span>
      <button onClick={() => remove(depId)} data-testid={`dependency-remove-${depId}`} className="text-text-muted hover:text-status-error"><X className="h-3.5 w-3.5" /></button>
    </div>
  ) : null;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Link2 className="h-4 w-4 text-brand-primary" />
        <h3 className="text-sm font-semibold text-text-heading">{t('heading')}</h3>
      </div>
      {loading ? <Loader2 className="mx-auto h-4 w-4 animate-spin text-text-muted" /> : (
        <div className="space-y-3">
          {dependsOn.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-text-muted">{t('blockedByLabel')}</p>
              <div className="space-y-1.5">{dependsOn.map((d) => <Row key={d.id} t={d.blockingTask} depId={d.id} />)}</div>
            </div>
          )}
          {blocks.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-text-muted">{t('blocksLabel')}</p>
              <div className="space-y-1.5">{blocks.map((d) => <Row key={d.id} t={d.dependentTask} depId={d.id} />)}</div>
            </div>
          )}
          {dependsOn.length === 0 && blocks.length === 0 && <p data-testid="dependency-empty" className="text-sm text-text-muted">{t('emptyNoDependencies')}</p>}
          {projectId && (
            <div className="flex items-center gap-2 pt-1">
              <select value={selected} onChange={(e) => setSelected(e.target.value)} data-testid="dependency-select"
                className="flex-1 rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-1.5 text-sm text-text-body">
                <option value="">{t('addBlockingPlaceholder')}</option>
                {options.map((o) => <option key={o.id} value={o.id}>{o.taskCode} — {o.title}</option>)}
              </select>
              <button onClick={add} disabled={!selected || adding} data-testid="dependency-add"
                className="flex items-center gap-1 rounded-[--radius-button] bg-brand-primary px-3 py-1.5 text-sm text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60">
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
