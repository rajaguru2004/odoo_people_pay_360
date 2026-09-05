'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import {
  Activity, RefreshCw,
  PlusCircle, Pencil, Trash2, FolderOpen, ListTodo, Loader2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/common/icons/directional';
import projectService from '@/services/projectService';

interface ActivityEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  oldData: any;
  newData: any;
  createdAt: string;
  user: {
    id: string;
    email: string;
    employee?: { fullName: string };
  } | null;
}

const SKIP_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', 'companyId', 'password']);

const fmtVal = (v: any, t: ReturnType<typeof useTranslations>): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? t('valYes') : t('valNo');
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    try { return new Date(v).toLocaleString('en-IN', { timeZone: getCompanyTz(), dateStyle: 'medium', timeStyle: 'short' }); } catch { return v; }
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    return v.fullName || v.name || v.title || v.email || v.code || '—';
  }
  if (Array.isArray(v)) return v.length ? t('valItemsCount', { count: v.length }) : '—';
  return String(v);
};

const fmtLabel = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();

const changedFields = (o: any, n: any, t: ReturnType<typeof useTranslations>) => {
  const fields: { label: string; from: string; to: string }[] = [];
  const keys = new Set([...Object.keys(o ?? {}), ...Object.keys(n ?? {})]);
  keys.forEach(k => {
    if (SKIP_KEYS.has(k) || k.endsWith('Id')) return;
    const a = fmtVal(o?.[k], t);
    const b = fmtVal(n?.[k], t);
    if (a !== b) fields.push({ label: fmtLabel(k), from: a, to: b });
  });
  return fields;
};

function ActionIcon({ action, resourceType }: { action: string; resourceType: string }) {
  const isTask = resourceType === 'Task';
  if (action === 'CREATE') return <PlusCircle className="h-4 w-4 text-status-success" />;
  if (action === 'DELETE') return <Trash2 className="h-4 w-4 text-status-error" />;
  if (isTask) return <ListTodo className="h-4 w-4 text-brand-primary" />;
  return <Pencil className="h-4 w-4 text-brand-accent" />;
}

function actionBadge(action: string) {
  const map: Record<string, string> = {
    CREATE: 'bg-status-success-bg text-status-success',
    UPDATE: 'bg-brand-primary-light/20 text-brand-primary',
    DELETE: 'bg-status-error-bg text-status-error',
  };
  return map[action] ?? 'bg-surface-page text-text-muted';
}

function resourceLabel(resourceType: string, t: ReturnType<typeof useTranslations>) {
  return resourceType === 'Task' ? t('resourceLabelTask') : t('resourceLabelProject');
}

function summaryLine(entry: ActivityEntry, t: ReturnType<typeof useTranslations>): string {
  const actor = entry.user?.employee?.fullName || entry.user?.email || t('fallbackSystemUser');
  const resource = resourceLabel(entry.resourceType, t);
  const name = entry.newData?.title || entry.newData?.name || entry.oldData?.title || entry.oldData?.name || '';
  if (entry.action === 'CREATE') return t('summaryCreated', { actor, resource, name });
  if (entry.action === 'DELETE') return t('summaryDeleted', { actor, resource, name });
  return t('summaryUpdated', { actor, resource, name });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: getCompanyTz(), dateStyle: 'medium', timeStyle: 'short',
  });
}

function EntryRow({ entry }: { entry: ActivityEntry }) {
  const t = useTranslations('projectActivityLog');
  const [expanded, setExpanded] = useState(false);
  const diffs = entry.action === 'UPDATE' ? changedFields(entry.oldData, entry.newData, t) : [];

  return (
    <div data-testid={`activity-row-${entry.id}`} className="border-b border-surface-border last:border-0">
      <button
        onClick={() => setExpanded(p => !p)}
        data-testid={`activity-row-toggle-${entry.id}`}
        className="flex w-full items-start gap-3 px-5 py-4 text-start hover:bg-surface-page transition"
      >
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-page">
          <ActionIcon action={entry.action} resourceType={entry.resourceType} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-heading">{summaryLine(entry, t)}</p>
          <p className="mt-0.5 text-xs text-text-muted">{fmtTime(entry.createdAt)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${actionBadge(entry.action)}`}>
            {entry.action}
          </span>
          <span className="rounded-full border border-surface-border px-2 py-0.5 text-xs text-text-muted">
            {resourceLabel(entry.resourceType, t)}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="mx-5 mb-4 rounded-[--radius-card] border border-surface-border bg-surface-page p-4 text-xs">
          {entry.action === 'UPDATE' && diffs.length > 0 && (
            <div className="space-y-2">
              {diffs.map(d => (
                <div key={d.label} className="grid grid-cols-3 gap-2">
                  <span className="font-medium text-text-muted">{d.label}</span>
                  <span className="line-through text-status-error">{d.from}</span>
                  <span className="text-status-success">{d.to}</span>
                </div>
              ))}
            </div>
          )}
          {entry.action === 'UPDATE' && diffs.length === 0 && (
            <p className="text-text-muted">{t('emptyNoFieldChanges')}</p>
          )}
          {entry.action === 'CREATE' && entry.newData && (
            <pre className="overflow-auto text-text-muted whitespace-pre-wrap break-words">
              {JSON.stringify(entry.newData, null, 2)}
            </pre>
          )}
          {entry.action === 'DELETE' && entry.oldData && (
            <pre className="overflow-auto text-text-muted whitespace-pre-wrap break-words">
              {JSON.stringify(entry.oldData, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProjectActivityLog({ projectId }: { projectId: string }) {
  const t = useTranslations('projectActivityLog');
  const tc = useTranslations('common');
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await projectService.getActivity(projectId, { page, limit })) as any;
      setEntries(res.data ?? []);
      setTotalPages(res.meta?.totalPages ?? 1);
      setTotal(res.meta?.total ?? 0);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-brand-primary" />
          <h3 className="font-semibold text-text-heading">{t('heading')}</h3>
          {!loading && (
            <span className="rounded-full bg-surface-page px-2 py-0.5 text-xs text-text-muted border border-surface-border">
              {t('eventsCountBadge', { count: total })}
            </span>
          )}
        </div>
        <button
          onClick={() => { setPage(1); load(); }}
          data-testid="activity-refresh"
          className="flex items-center gap-1.5 rounded-[--radius-button] border border-surface-border px-3 py-1.5 text-xs text-text-muted hover:bg-surface-page"
        >
          <RefreshCw className="h-3.5 w-3.5" /> {tc('refresh')}
        </button>
      </div>

      <div className="rounded-[--radius-card] border border-surface-border bg-surface-card">
        {loading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-brand-primary" />
          </div>
        ) : entries.length === 0 ? (
          <div data-testid="activity-empty" className="flex h-48 flex-col items-center justify-center gap-2 text-text-muted">
            <FolderOpen className="h-8 w-8 opacity-40" />
            <p className="text-sm">{t('emptyNoActivity')}</p>
          </div>
        ) : (
          <div data-testid="activity-list">
            {entries.map(e => <EntryRow key={e.id} entry={e} />)}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-text-muted">
          <span>{t('paginationPage', { page, totalPages })}</span>
          <div className="flex gap-2">
            <button
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
              data-testid="activity-prev"
              className="flex items-center gap-1 rounded-[--radius-button] border border-surface-border px-3 py-1.5 disabled:opacity-40 hover:bg-surface-page"
            >
              <ChevronLeftIcon className="h-4 w-4" /> {t('prevBtn')}
            </button>
            <button
              disabled={page === totalPages}
              onClick={() => setPage(p => p + 1)}
              data-testid="activity-next"
              className="flex items-center gap-1 rounded-[--radius-button] border border-surface-border px-3 py-1.5 disabled:opacity-40 hover:bg-surface-page"
            >
              {t('nextBtn')} <ChevronRightIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
