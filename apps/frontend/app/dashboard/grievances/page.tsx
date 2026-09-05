'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  MessageSquareWarning,
  Loader2,
  Lock,
  ChevronDown,
  ChevronRight,
  Send,
  EyeOff,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import grievanceService from '@/services/grievanceService';
import { Grievance, GrievanceStatus } from '@/types/grievance';

const STATUSES: GrievanceStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'RESOLVED',
  'CLOSED',
  'WITHDRAWN',
];

const STATUS_STYLE: Record<GrievanceStatus, string> = {
  OPEN: 'bg-amber-50 text-amber-700',
  ACKNOWLEDGED: 'bg-blue-50 text-blue-700',
  INVESTIGATING: 'bg-indigo-50 text-indigo-700',
  RESOLVED: 'bg-emerald-50 text-emerald-700',
  CLOSED: 'bg-slate-100 text-slate-600',
  WITHDRAWN: 'bg-slate-100 text-slate-500',
};

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30';

function fmtDateTime(d?: string | null) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(d);
  }
}

function GrievancesQueueInner() {
  const [rows, setRows] = useState<Grievance[]>([]);
  const [detail, setDetail] = useState<Grievance | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<GrievanceStatus | ''>('');
  const [note, setNote] = useState('');
  const [internal, setInternal] = useState(true);
  const [resolution, setResolution] = useState('');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Grievances', 'Employee concerns and how they are being handled');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await grievanceService.getAll(status || undefined);
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to load grievances');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (row: Grievance) => {
    if (expanded === row.id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(row.id);
    setDetail(null);
    try {
      const res = await grievanceService.getById(row.id);
      setDetail(res.data);
      setResolution(res.data.resolution ?? '');
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to load the grievance');
    }
  };

  const setGrievanceStatus = async (row: Grievance, next: GrievanceStatus) => {
    setBusy(true);
    try {
      await grievanceService.update(row.id, {
        status: next,
        ...(next === 'RESOLVED' && resolution.trim()
          ? { resolution: resolution.trim() }
          : {}),
      });
      toast.success(`Marked ${next.toLowerCase()}`);
      await load();
      if (expanded === row.id) {
        const res = await grievanceService.getById(row.id);
        setDetail(res.data);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to update');
    } finally {
      setBusy(false);
    }
  };

  const addNote = async (row: Grievance) => {
    if (!note.trim()) {
      toast.warning('Write something first');
      return;
    }
    setBusy(true);
    try {
      await grievanceService.addNote(row.id, note.trim(), internal);
      toast.success(internal ? 'Internal note added' : 'Note shared with the employee');
      setNote('');
      const res = await grievanceService.getById(row.id);
      setDetail(res.data);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to add the note');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <select
          className={`${inputCls} !w-auto`}
          value={status}
          onChange={(e) => setStatus(e.target.value as GrievanceStatus | '')}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm">
          No grievances.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const open = expanded === row.id;
            return (
              <div key={row.id} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <button
                  onClick={() => openDetail(row)}
                  className="flex w-full items-start justify-between gap-3 p-4 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <MessageSquareWarning size={15} className="text-brand-primary" />
                      <span className="text-sm font-semibold text-slate-800">
                        {row.subject}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[row.status]}`}
                      >
                        {row.status}
                      </span>
                      {row.isConfidential && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                          <Lock size={10} /> Confidential
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {row.employee?.fullName} ({row.employee?.employeeCode}) ·{' '}
                      {row.category}
                      {row.againstEmployee
                        ? ` · about ${row.againstEmployee.fullName}`
                        : ''}
                    </p>
                  </div>
                  {open ? (
                    <ChevronDown size={16} className="shrink-0 text-slate-400" />
                  ) : (
                    <ChevronRight size={16} className="shrink-0 text-slate-400" />
                  )}
                </button>

                {open && (
                  <div className="border-t border-slate-100 p-4">
                    {!detail ? (
                      <div className="flex items-center gap-2 text-sm text-slate-500">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                      </div>
                    ) : (
                      <>
                        <p className="mb-4 whitespace-pre-wrap text-sm text-slate-700">
                          {detail.description}
                        </p>

                        <div className="mb-4 flex flex-wrap items-center gap-2">
                          {STATUSES.filter(
                            (s) => s !== detail.status && s !== 'WITHDRAWN',
                          ).map((s) => (
                            <button
                              key={s}
                              onClick={() => setGrievanceStatus(detail, s)}
                              disabled={busy}
                              className="h-8 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            >
                              Mark {s.toLowerCase()}
                            </button>
                          ))}
                        </div>

                        <label className="mb-4 block">
                          <span className="text-xs font-medium text-slate-500">
                            Resolution (recorded when marked resolved)
                          </span>
                          <textarea
                            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none"
                            rows={2}
                            value={resolution}
                            onChange={(e) => setResolution(e.target.value)}
                          />
                        </label>

                        <div className="mb-4">
                          <p className="mb-2 text-xs font-semibold uppercase text-slate-500">
                            Trail
                          </p>
                          <ol className="space-y-2">
                            {(detail.events ?? []).map((ev) => (
                              <li
                                key={ev.id}
                                className="rounded-lg bg-slate-50 px-3 py-2 text-sm"
                              >
                                <div className="flex items-center gap-2 text-xs text-slate-500">
                                  <span>{fmtDateTime(ev.createdAt)}</span>
                                  {ev.actor?.email && <span>· {ev.actor.email}</span>}
                                  {ev.isInternal && (
                                    <span className="inline-flex items-center gap-1 text-amber-700">
                                      <EyeOff size={10} /> internal
                                    </span>
                                  )}
                                </div>
                                <p className="mt-0.5 text-slate-700">
                                  {ev.type === 'STATUS_CHANGE'
                                    ? `${ev.fromStatus ?? '—'} → ${ev.toStatus}`
                                    : ''}
                                  {ev.note ? ` ${ev.note}` : ''}
                                </p>
                              </li>
                            ))}
                          </ol>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            className={inputCls}
                            style={{ flex: '1 1 240px' }}
                            placeholder="Add a note…"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                          />
                          <label className="flex items-center gap-1.5 text-xs text-slate-600">
                            <input
                              type="checkbox"
                              checked={internal}
                              onChange={(e) => setInternal(e.target.checked)}
                            />
                            Internal only
                          </label>
                          <button
                            onClick={() => addNote(detail)}
                            disabled={busy}
                            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white disabled:opacity-50"
                          >
                            <Send size={14} /> Add
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function GrievancesQueuePage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <GrievancesQueueInner />
    </ProtectedRoute>
  );
}
