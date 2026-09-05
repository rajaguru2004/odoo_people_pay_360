'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Loader2, Trash2, Clock, Timer } from 'lucide-react';
import { useTranslations } from 'next-intl';
import workLogService from '@/services/workLogService';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Decimal hours → "1h 30m" / "45m" / "<1m". */
function fmtHm(hours: number): string {
  const totalMin = Math.round((Number(hours) || 0) * 60);
  if (totalMin <= 0) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
}

function fmtWhen(d?: string): string {
  if (!d) return '';
  return new Date(d).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const UNSTAGED = '__unstaged__';

interface StageGroup {
  key: string;
  name: string | null;
  color?: string;
  total: number;
  entries: any[];
}

export default function TaskTimeTracking({ taskId, reloadKey }: { taskId: string; reloadKey?: string | number }) {
  const t = useTranslations('taskTimeTracking');
  const tc = useTranslations('common');
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Only show the full spinner on the very first fetch; later refreshes swap
  // data in silently so start/stop/move never blanks the section.
  const firstLoad = useRef(true);

  const load = async () => {
    if (firstLoad.current) setLoading(true);
    try {
      const res = (await workLogService.getByTask(taskId)) as any;
      setLogs(res.data || []);
    } finally {
      firstLoad.current = false;
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [taskId, reloadKey]);

  const add = async () => {
    const h = parseFloat(hours);
    if (!h || h <= 0) return;
    setSaving(true);
    try {
      const now = new Date();
      const start = new Date(now.getTime() - h * 3600 * 1000);
      await workLogService.create({ taskId, startTime: start.toISOString(), endTime: now.toISOString(), notes });
      setHours(''); setNotes('');
      await load();
    } finally { setSaving(false); }
  };

  const del = async (id: string) => {
    const snapshot = logs;
    setLogs((prev) => prev.filter((l) => l.id !== id)); // optimistic
    try {
      await workLogService.delete(id);
    } catch {
      setLogs(snapshot); // revert on failure
    }
  };

  const totalHours = useMemo(
    () => logs.reduce((s, l) => s + (Number(l.duration) || 0), 0),
    [logs],
  );

  // Group finished logs by stage (preserve first-seen order), newest entries first.
  const groups = useMemo<StageGroup[]>(() => {
    const map = new Map<string, StageGroup>();
    for (const l of logs) {
      const name = l.status?.name || l.statusName || null;
      const key = l.status?.id || name || UNSTAGED;
      if (!map.has(key)) {
        map.set(key, { key, name, color: l.status?.color, total: 0, entries: [] });
      }
      const g = map.get(key)!;
      g.total += Number(l.duration) || 0;
      g.entries.push(l);
    }
    return Array.from(map.values());
  }, [logs]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Timer className="h-4 w-4 text-text-muted" />
          <h3 className="text-sm font-semibold text-text-heading">{t('heading')}</h3>
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-surface-page px-3 py-1 text-xs">
          <Clock className="h-3.5 w-3.5 text-text-muted" />
          <span className="text-text-muted">{tc('total')}</span>
          <span className="font-semibold text-text-body">{fmtHm(totalHours)}</span>
        </div>
      </div>

      {/* Per-stage summary chips */}
      {groups.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <div
              key={g.key}
              className="flex items-center gap-1.5 rounded-full border border-surface-border px-2.5 py-1 text-xs">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: g.color || 'var(--color-surface-border-light, #cbd5e1)' }} />
              <span className="text-text-body">{g.name || t('fallbackUnstaged')}</span>
              <span className="font-semibold text-text-heading">{fmtHm(g.total)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Manual log form */}
      <div className="flex items-end gap-2 rounded-[--radius-card] border border-dashed border-surface-border bg-surface-page/50 p-3">
        <div>
          <label className="mb-1 block text-xs text-text-muted">{t('hoursLabel')}</label>
          <input type="number" step="0.25" min="0" value={hours} data-testid="time-log-hours" onChange={(e) => setHours(e.target.value)}
            placeholder={t('hoursPlaceholder')}
            className="w-24 rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-1.5 text-sm text-text-body" />
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-xs text-text-muted">{tc('notes')}</label>
          <input value={notes} data-testid="time-log-notes" onChange={(e) => setNotes(e.target.value)}
            placeholder={t('notesPlaceholder')}
            className="w-full rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-1.5 text-sm text-text-body" />
        </div>
        <button onClick={add} disabled={saving || !hours} data-testid="time-log-add"
          className="flex items-center gap-1 rounded-[--radius-button] bg-brand-primary px-3 py-1.5 text-sm text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {t('logBtn')}
        </button>
      </div>

      {/* Grouped entries */}
      {loading ? (
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-text-muted" />
      ) : logs.length === 0 ? (
        <div data-testid="time-log-empty" className="rounded-[--radius-card] border border-dashed border-surface-border py-8 text-center">
          <Clock className="mx-auto mb-2 h-6 w-6 text-text-muted opacity-40" />
          <p className="text-sm text-text-muted">{t('emptyNoLogs')}</p>
          <p className="text-xs text-text-muted">{t('emptyNoLogsDesc')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.key}>
              {/* Stage header */}
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: g.color || 'var(--color-surface-border-light, #cbd5e1)' }} />
                <span className="text-xs font-semibold uppercase tracking-wide text-text-body">
                  {g.name || t('fallbackUnstaged')}
                </span>
                <span className="text-xs text-text-muted">· {fmtHm(g.total)}</span>
                <div className="ms-2 flex-1 border-t border-surface-border" />
              </div>

              {/* Entries */}
              <div className="space-y-1.5">
                {g.entries.map((l) => (
                  <div
                    key={l.id}
                    data-testid={`time-log-row-${l.id}`}
                    className="flex items-center justify-between rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2 text-sm">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-primary/15 text-[10px] font-semibold text-brand-primary">
                        {(l.employee?.fullName || '?').slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-text-body">{fmtHm(l.duration)}</span>
                          <span className="truncate text-xs text-text-muted">{l.employee?.fullName}</span>
                        </div>
                        {l.notes && <p className="truncate text-xs text-text-muted">{l.notes}</p>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-text-muted">{fmtWhen(l.startTime)}</span>
                      <button onClick={() => del(l.id)} data-testid={`time-log-delete-${l.id}`} className="text-text-muted hover:text-status-error">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
