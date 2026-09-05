'use client';

import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  History,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import attendanceIntegrationsService from '@/services/attendanceIntegrationsService';
import branchService from '@/services/branchService';
import {
  AttendanceIntegration,
  CandidateEmployee,
  MappingSuggestion,
  ProviderCatalogue,
  ProviderConfigField,
  ProviderDescriptor,
  SyncOutcome,
  SyncRunRow,
  SyncRunSummary,
  TestIntegrationResult,
  UnmappedExternalEmployee,
  UpsertIntegrationInput,
} from '@/types/attendanceIntegrations';

// ── local primitives (the Settings page keeps its own inline; mirrored here) ──

function Card({
  title,
  subtitle,
  icon,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-primary/10 text-brand-primary">
            {icon}
          </div>
          <div>
            <h3 className="font-semibold text-slate-800">{title}</h3>
            {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
          </div>
        </div>
        {actions}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ms-1 text-rose-500">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-primary/30 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-brand-primary' : 'bg-slate-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all';

const btnPrimary =
  'inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 h-10 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const btnGhost =
  'inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 h-10 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

/** Colour + copy for each dry-run / sync outcome. */
const OUTCOME_STYLE: Record<SyncOutcome, { cls: string; label: string }> = {
  CREATED: { cls: 'bg-emerald-50 text-emerald-700', label: 'Created' },
  UPDATED: { cls: 'bg-sky-50 text-sky-700', label: 'Updated' },
  WOULD_CREATE: { cls: 'bg-emerald-50 text-emerald-700', label: 'Would create' },
  WOULD_UPDATE: { cls: 'bg-sky-50 text-sky-700', label: 'Would update' },
  UNCHANGED: { cls: 'bg-slate-100 text-slate-600', label: 'Unchanged' },
  UNMAPPED: { cls: 'bg-amber-50 text-amber-700', label: 'Unmapped' },
  SKIP_LEAVE: { cls: 'bg-violet-50 text-violet-700', label: 'Skip — leave' },
  SKIP_MANUAL: { cls: 'bg-violet-50 text-violet-700', label: 'Skip — manual' },
  SKIP_CORRECTED: { cls: 'bg-violet-50 text-violet-700', label: 'Skip — corrected' },
  SKIP_BEFORE_START_DATE: { cls: 'bg-slate-100 text-slate-600', label: 'Skip — pre-hire' },
  SKIP_NO_PUNCH: { cls: 'bg-slate-100 text-slate-600', label: 'Skip — no punch' },
  SKIP_INACTIVE_EMPLOYEE: { cls: 'bg-slate-100 text-slate-600', label: 'Skip — inactive' },
  ERROR: { cls: 'bg-rose-50 text-rose-700', label: 'Error' },
};

const STATUS_STYLE: Record<string, string> = {
  OK: 'bg-emerald-50 text-emerald-700',
  PARTIAL: 'bg-amber-50 text-amber-700',
  ERROR: 'bg-rose-50 text-rose-700',
  RUNNING: 'bg-sky-50 text-sky-700',
};

function todayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function errMsg(e: any, fallback: string): string {
  return e?.response?.data?.message || e?.message || fallback;
}

// ─────────────────────────── Section ───────────────────────────

/**
 * Settings ▸ Integrations ▸ Attendance.
 *
 * Self-contained (own load/save), which is why it is excluded from the page's
 * global save bar. Every vendor-specific field is rendered from the provider's
 * configSchema, so connecting a new system needs no change here.
 */
export default function AttendanceIntegrationsSection() {
  const [catalogue, setCatalogue] = useState<ProviderCatalogue | null>(null);
  const [integrations, setIntegrations] = useState<AttendanceIntegration[]>([]);
  const [branches, setBranches] = useState<{ id: string; code: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AttendanceIntegration | 'new' | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cat, list, branchList] = await Promise.all([
        attendanceIntegrationsService.getProviders(),
        attendanceIntegrationsService.getAll(),
        branchService.getAll(),
      ]);
      setCatalogue(cat.data);
      setIntegrations(list.data);
      setBranches(
        (branchList.data as any[]).map((b) => ({ id: b.id, code: b.code, name: b.name })),
      );
    } catch (e: any) {
      toast.error(errMsg(e, 'Failed to load attendance integrations'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggleEnabled = async (row: AttendanceIntegration, enabled: boolean) => {
    try {
      const res = await attendanceIntegrationsService.update(row.id, { enabled });
      setIntegrations((list) => list.map((r) => (r.id === row.id ? res.data : r)));
      toast.success(enabled ? 'Scheduled sync enabled' : 'Scheduled sync paused');
    } catch (e: any) {
      toast.error(errMsg(e, 'Could not change the schedule'));
    }
  };

  const handleDelete = async (row: AttendanceIntegration) => {
    if (
      !window.confirm(
        `Remove "${row.displayName}"? Attendance already synced is kept — only the connection and its run history are deleted.`,
      )
    ) {
      return;
    }
    try {
      await attendanceIntegrationsService.remove(row.id);
      setIntegrations((list) => list.filter((r) => r.id !== row.id));
      toast.success('Integration removed');
    } catch (e: any) {
      toast.error(errMsg(e, 'Could not remove the integration'));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const usedBranchIds = new Set(integrations.map((i) => i.branchId));
  const freeBranches = branches.filter((b) => !usedBranchIds.has(b.id));

  return (
    <div className="space-y-5">
      <Card
        title="Attendance integrations"
        subtitle="Mirror attendance from an external system into this branch. Read-only — employees keep checking in here as usual."
        icon={<Plug className="h-5 w-5" />}
        actions={
          <button
            type="button"
            className={btnPrimary}
            disabled={freeBranches.length === 0}
            title={
              freeBranches.length === 0
                ? 'Every branch already has an integration'
                : undefined
            }
            onClick={() => setEditing('new')}
          >
            <Plus className="h-4 w-4" />
            Connect a system
          </button>
        }
      >
        {integrations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center">
            <Plug className="mx-auto mb-3 h-8 w-8 text-slate-300" />
            <p className="text-sm font-medium text-slate-600">No integrations yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-slate-400">
              Connect a branch to an external attendance system to mirror its records here.
              Nothing is written until you run a sync, and a dry run shows exactly what would
              change first.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {integrations.map((row) => (
              <IntegrationRow
                key={row.id}
                row={row}
                provider={catalogue?.providers.find((p) => p.key === row.provider)}
                expanded={expandedId === row.id}
                onToggleExpand={() =>
                  setExpandedId((cur) => (cur === row.id ? null : row.id))
                }
                onToggleEnabled={(v) => handleToggleEnabled(row, v)}
                onEdit={() => setEditing(row)}
                onDelete={() => handleDelete(row)}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </Card>

      {editing && catalogue && (
        <IntegrationForm
          catalogue={catalogue}
          branches={editing === 'new' ? freeBranches : branches}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────── Row ───────────────────────────

function IntegrationRow({
  row,
  provider,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onEdit,
  onDelete,
  onChanged,
}: {
  row: AttendanceIntegration;
  provider?: ProviderDescriptor;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (v: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-800">{row.displayName}</span>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {provider?.displayName ?? row.provider}
            </span>
            {row.branch && (
              <span className="rounded bg-brand-primary/10 px-2 py-0.5 text-xs text-brand-primary">
                {row.branch.name}
              </span>
            )}
            {row.lastSyncStatus && (
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  STATUS_STYLE[row.lastSyncStatus] ?? 'bg-slate-100 text-slate-600'
                }`}
              >
                {row.lastSyncStatus}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {row.externalBranchId} · every {row.syncIntervalMinutes} min · last sync{' '}
            {relative(row.lastSyncAt)}
            {row.lastSyncError ? ` · ${row.lastSyncError}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Scheduled</span>
          <Toggle
            checked={row.enabled}
            onChange={onToggleEnabled}
            disabled={!row.authSecretConfigured}
          />
          <button type="button" className={btnGhost} onClick={onToggleExpand}>
            {expanded ? <X className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {expanded ? 'Close' : 'Manage'}
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50"
            title="Edit connection"
            onClick={onEdit}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-200 p-2 text-rose-500 hover:bg-rose-50"
            title="Remove connection"
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!row.authSecretConfigured && (
        <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No authentication secret stored. Edit the connection and enter one — scheduled
            sync cannot be enabled without it.
          </span>
        </div>
      )}

      {expanded && <IntegrationWorkspace row={row} onChanged={onChanged} />}
    </div>
  );
}

// ─────────────────────── Manage workspace ───────────────────────

function IntegrationWorkspace({
  row,
  onChanged,
}: {
  row: AttendanceIntegration;
  onChanged: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestIntegrationResult | null>(null);

  const [from, setFrom] = useState(todayISO(-1));
  const [to, setTo] = useState(todayISO(-1));
  const [busy, setBusy] = useState<'preview' | 'sync' | null>(null);
  const [summary, setSummary] = useState<SyncRunSummary | null>(null);

  const [unmapped, setUnmapped] = useState<UnmappedExternalEmployee[]>([]);
  const [runs, setRuns] = useState<SyncRunRow[]>([]);

  const refreshPanels = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([
        attendanceIntegrationsService.getUnmapped(row.id),
        attendanceIntegrationsService.getRuns(row.id, 10),
      ]);
      setUnmapped(u.data);
      setRuns(r.data);
    } catch {
      // non-fatal — panels stay as they were
    }
  }, [row.id]);

  useEffect(() => {
    void refreshPanels();
  }, [refreshPanels]);

  const spanDays = useMemo(() => {
    const a = new Date(from).getTime();
    const b = new Date(to).getTime();
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return -1;
    return Math.round((b - a) / 86_400_000) + 1;
  }, [from, to]);

  const rangeError =
    spanDays < 0
      ? 'End date must be on or after the start date.'
      : spanDays > 31
        ? `${spanDays} days selected. The provider caps a single read at 31 days — sync in smaller windows.`
        : null;

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await attendanceIntegrationsService.testConnection(row.id);
      setTestResult(res.data);
    } catch (e: any) {
      setTestResult({ ok: false, message: errMsg(e, 'Connection test failed') });
    } finally {
      setTesting(false);
    }
  };

  const run = async (mode: 'preview' | 'sync') => {
    if (rangeError) return;
    setBusy(mode);
    setSummary(null);
    try {
      const res =
        mode === 'preview'
          ? await attendanceIntegrationsService.preview(row.id, from, to)
          : await attendanceIntegrationsService.sync(row.id, from, to);
      setSummary(res.data);
      if (mode === 'sync') {
        toast.success(
          `Sync ${res.data.status}: ${res.data.created} created, ${res.data.updated} updated`,
        );
        onChanged();
      }
      await refreshPanels();
    } catch (e: any) {
      toast.error(errMsg(e, mode === 'preview' ? 'Dry run failed' : 'Sync failed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5 border-t border-slate-100 bg-slate-50/60 p-4">
      {/* Connection test */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnGhost} disabled={testing} onClick={handleTest}>
          {testing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="h-4 w-4" />
          )}
          Test connection
        </button>
        {testResult && (
          <span
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
              testResult.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
            }`}
          >
            {testResult.ok ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            {testResult.message}
            {testResult.latencyMs != null && ` (${testResult.latencyMs}ms)`}
          </span>
        )}
      </div>

      {/* Window + actions */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <p className="mb-3 text-sm font-medium text-slate-700">Read a date range</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <input
              type="date"
              className={inputCls}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              className={inputCls}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <button
            type="button"
            className={btnGhost}
            disabled={busy !== null || !!rangeError}
            onClick={() => run('preview')}
          >
            {busy === 'preview' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
            Dry run
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={busy !== null || !!rangeError}
            onClick={() => run('sync')}
          >
            {busy === 'sync' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Sync now
          </button>
        </div>
        {rangeError ? (
          <p className="mt-2 text-xs text-rose-600">{rangeError}</p>
        ) : (
          <p className="mt-2 text-xs text-slate-400">
            A dry run writes nothing — it shows exactly which rows would be created,
            updated or skipped. Always dry-run a new connection before syncing.
          </p>
        )}
      </div>

      {summary && <SummaryPanel summary={summary} />}

      {unmapped.length > 0 && (
        <UnmappedPanel
          integrationId={row.id}
          rows={unmapped}
          onMapped={async () => {
            await refreshPanels();
          }}
        />
      )}

      <RunsPanel runs={runs} />
    </div>
  );
}

// ─────────────────────────── Panels ───────────────────────────

function SummaryPanel({ summary }: { summary: SyncRunSummary }) {
  const dry = summary.trigger === 'DRY_RUN';
  const stats: [string, number][] = [
    ['Fetched', summary.fetched],
    ['Matched', summary.matched],
    [dry ? 'Would create' : 'Created', summary.created],
    [dry ? 'Would update' : 'Updated', summary.updated],
    ['Skipped', summary.skipped],
    ['Unmapped', summary.unmapped],
    ['Errors', summary.errorCount],
  ];

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-700">
          {dry ? 'Dry run' : 'Sync'} result
        </span>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            STATUS_STYLE[summary.status] ?? 'bg-slate-100 text-slate-600'
          }`}
        >
          {summary.status}
        </span>
        <span className="text-xs text-slate-400">
          {summary.windowStart} → {summary.windowEnd} · {Math.round(summary.durationMs / 100) / 10}s
        </span>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-slate-50 p-2 text-center">
            <p className="text-lg font-semibold text-slate-800">{value}</p>
            <p className="text-[11px] text-slate-500">{label}</p>
          </div>
        ))}
      </div>

      {summary.message && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{summary.message}</span>
        </div>
      )}

      {summary.records.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-start text-xs uppercase text-slate-400">
                <th className="py-2 text-start font-medium">External id</th>
                <th className="py-2 text-start font-medium">Employee</th>
                <th className="py-2 text-start font-medium">Date</th>
                <th className="py-2 text-start font-medium">In</th>
                <th className="py-2 text-start font-medium">Out</th>
                <th className="py-2 text-start font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {summary.records.map((rec, i) => {
                const style = OUTCOME_STYLE[rec.outcome];
                return (
                  <tr key={`${rec.externalEmployeeId}-${rec.date}-${i}`} className="border-b border-slate-50">
                    <td className="py-2 font-mono text-xs text-slate-600">
                      {rec.externalEmployeeId}
                      {rec.externalEmployeeName && (
                        <span className="ms-2 font-sans text-slate-400">
                          {rec.externalEmployeeName}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-slate-700">
                      {rec.employeeName ? (
                        <>
                          {rec.employeeName}
                          <span className="ms-1 text-xs text-slate-400">{rec.employeeCode}</span>
                        </>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="py-2 text-slate-600">{rec.date}</td>
                    <td className="py-2 text-slate-600">{fmtTime(rec.checkIn)}</td>
                    <td className="py-2 text-slate-600">{fmtTime(rec.checkOut)}</td>
                    <td className="py-2">
                      <span className={`rounded px-2 py-0.5 text-xs ${style.cls}`} title={rec.error || rec.reason}>
                        {style.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Bulk mapping workspace.
 *
 * A provider branch can easily hold 90 people, so linking them one dropdown at a
 * time is not a real workflow. This loads name-scored proposals, pre-selects
 * only the confident ones, and applies everything in a single call. Proposals
 * are never auto-applied — a wrong link silently attributes one person's
 * attendance to another, and that flows straight into payroll.
 */
function UnmappedPanel({
  integrationId,
  rows,
  onMapped,
}: {
  integrationId: string;
  rows: UnmappedExternalEmployee[];
  onMapped: () => void;
}) {
  const [candidates, setCandidates] = useState<CandidateEmployee[]>([]);
  const [suggestions, setSuggestions] = useState<MappingSuggestion[] | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    attendanceIntegrationsService
      .getCandidates(integrationId)
      .then((res) => setCandidates(res.data))
      .catch(() => setCandidates([]));
  }, [integrationId]);

  const loadSuggestions = async () => {
    setLoading(true);
    try {
      const res = await attendanceIntegrationsService.getSuggestions(integrationId);
      setSuggestions(res.data);
      // Pre-select only the confident ones; everything else stays deliberate.
      const preset: Record<string, string> = {};
      for (const s of res.data) {
        if (s.confident && s.suggestions[0]) {
          preset[s.externalId] = s.suggestions[0].employeeId;
        }
      }
      setSelection(preset);
      const n = Object.keys(preset).length;
      toast.success(
        n > 0
          ? `${n} confident match${n === 1 ? '' : 'es'} pre-selected — review before applying`
          : 'No confident matches. Names differ too much; pick manually.',
      );
    } catch (e: any) {
      toast.error(errMsg(e, 'Could not load suggestions'));
    } finally {
      setLoading(false);
    }
  };

  const applyAll = async () => {
    const entries = Object.entries(selection)
      .filter(([, employeeId]) => employeeId)
      .map(([externalId, employeeId]) => ({ externalId, employeeId }));
    if (!entries.length) return;

    setApplying(true);
    try {
      const res = await attendanceIntegrationsService.bulkMap(integrationId, entries);
      const { linked, failed, results } = res.data;
      if (failed === 0) {
        toast.success(`Linked ${linked} employee${linked === 1 ? '' : 's'}`);
      } else {
        toast.warning(`Linked ${linked}, ${failed} failed`);
        results
          .filter((r) => !r.ok)
          .slice(0, 3)
          .forEach((r) => toast.error(`${r.externalId}: ${r.message}`));
      }
      setSelection({});
      setSuggestions(null);
      onMapped();
      const fresh = await attendanceIntegrationsService.getCandidates(integrationId);
      setCandidates(fresh.data);
    } catch (e: any) {
      toast.error(errMsg(e, 'Bulk linking failed'));
    } finally {
      setApplying(false);
    }
  };

  // Rows to render: suggestion-backed when loaded, otherwise the raw unmapped list.
  const view: MappingSuggestion[] =
    suggestions ??
    rows.map((r) => ({
      externalId: r.externalId,
      externalName: r.name ?? null,
      confident: false,
      suggestions: [],
    }));

  const visible = filter.trim()
    ? view.filter((v) =>
        `${v.externalId} ${v.externalName ?? ''}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      )
    : view;

  const selectedCount = Object.values(selection).filter(Boolean).length;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div>
            <p className="text-sm font-medium text-amber-900">
              {rows.length} unmapped external employee{rows.length === 1 ? '' : 's'}
            </p>
            <p className="text-xs text-amber-700">
              Their attendance is being skipped. Payroll reads a missing row as absence, so
              link them before running payroll for this branch.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={btnGhost} disabled={loading} onClick={loadSuggestions}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wand2 className="h-4 w-4" />
            )}
            Suggest matches
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={selectedCount === 0 || applying}
            onClick={applyAll}
          >
            {applying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="h-4 w-4" />
            )}
            Link {selectedCount || ''} selected
          </button>
        </div>
      </div>

      {rows.length > 8 && (
        <input
          className={`${inputCls} mb-3`}
          placeholder="Filter by external id or name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}

      <div className="max-h-96 space-y-2 overflow-y-auto">
        {visible.map((v) => {
          const best = v.suggestions[0];
          return (
            <div
              key={v.externalId}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-2"
            >
              <div className="min-w-0 flex-1">
                <span className="font-mono text-xs text-slate-700">{v.externalId}</span>
                {v.externalName && (
                  <span className="ms-2 text-xs text-slate-500">{v.externalName}</span>
                )}
                {best && (
                  <span
                    className={`ms-2 rounded px-1.5 py-0.5 text-[11px] ${
                      v.confident
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-slate-100 text-slate-500'
                    }`}
                    title={`Name match score ${best.score}`}
                  >
                    {v.confident ? 'confident' : 'weak'} · {Math.round(best.score * 100)}%
                  </span>
                )}
              </div>

              <select
                className={`${inputCls} max-w-xs`}
                value={selection[v.externalId] ?? ''}
                onChange={(e) =>
                  setSelection((s) => ({ ...s, [v.externalId]: e.target.value }))
                }
              >
                <option value="">Not linked</option>
                {/* Ranked proposals first, then the full roster. */}
                {v.suggestions.length > 0 && (
                  <optgroup label="Suggested">
                    {v.suggestions.map((s) => (
                      <option key={s.employeeId} value={s.employeeId}>
                        {s.fullName} ({s.employeeCode}) — {Math.round(s.score * 100)}%
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="All unlinked employees">
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.fullName} ({c.employeeCode})
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
          );
        })}
      </div>

      {suggestions && (
        <p className="mt-3 text-xs text-amber-700">
          Matches are scored on name similarity only. Confident ones are pre-selected;
          everything else is left blank on purpose. Review before linking — a wrong link
          attributes one person&apos;s attendance to another.
        </p>
      )}
    </div>
  );
}

function RunsPanel({ runs }: { runs: SyncRunRow[] }) {
  if (runs.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <History className="h-4 w-4 text-slate-400" />
        <p className="text-sm font-medium text-slate-700">Recent runs</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs uppercase text-slate-400">
              <th className="py-2 text-start font-medium">When</th>
              <th className="py-2 text-start font-medium">Trigger</th>
              <th className="py-2 text-start font-medium">Window</th>
              <th className="py-2 text-start font-medium">Status</th>
              <th className="py-2 text-start font-medium">Created</th>
              <th className="py-2 text-start font-medium">Updated</th>
              <th className="py-2 text-start font-medium">Skipped</th>
              <th className="py-2 text-start font-medium">Unmapped</th>
              <th className="py-2 text-start font-medium">Errors</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-slate-50">
                <td className="py-2 text-slate-600" title={r.startedAt}>
                  {relative(r.startedAt)}
                </td>
                <td className="py-2 text-slate-500">{r.trigger}</td>
                <td className="py-2 text-xs text-slate-500">
                  {r.windowStart?.slice(0, 10)} → {r.windowEnd?.slice(0, 10)}
                </td>
                <td className="py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      STATUS_STYLE[r.status] ?? 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="py-2 text-slate-600">{r.created}</td>
                <td className="py-2 text-slate-600">{r.updated}</td>
                <td className="py-2 text-slate-600">{r.skipped}</td>
                <td className="py-2 text-slate-600">{r.unmapped}</td>
                <td className="py-2 text-slate-600">{r.errorCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────── Form ───────────────────────────

/**
 * Add / edit drawer. Every provider-specific input is rendered from the
 * provider's configSchema — this component has no vendor knowledge.
 */
function IntegrationForm({
  catalogue,
  branches,
  existing,
  onClose,
  onSaved,
}: {
  catalogue: ProviderCatalogue;
  branches: { id: string; code: string; name: string }[];
  existing: AttendanceIntegration | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(existing);
  const [providerKey, setProviderKey] = useState(
    existing?.provider ?? catalogue.providers[0]?.key ?? '',
  );
  const provider = catalogue.providers.find((p) => p.key === providerKey);

  const [branchId, setBranchId] = useState(existing?.branchId ?? branches[0]?.id ?? '');
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [values, setValues] = useState<Record<string, any>>({});
  // Kept out of `values` so the real secret never round-trips through state
  // that gets populated from the server.
  const [newSecret, setNewSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);

  const [conflictPolicy, setConflictPolicy] = useState(
    existing?.conflictPolicy ?? 'PROVIDER_WINS_SAFE',
  );
  const [syncIntervalMinutes, setSyncIntervalMinutes] = useState(
    existing?.syncIntervalMinutes ?? 15,
  );
  const [lookbackDays, setLookbackDays] = useState(existing?.lookbackDays ?? 3);
  const [autoCreateAbsent, setAutoCreateAbsent] = useState(
    existing?.autoCreateAbsent ?? false,
  );
  const [saving, setSaving] = useState(false);

  // Seed the schema-driven fields: stored value first, then the schema default.
  useEffect(() => {
    if (!provider) return;
    const seeded: Record<string, any> = {};
    for (const f of provider.configSchema) {
      if (f.secret) continue;
      const stored =
        f.name === 'baseUrl'
          ? existing?.baseUrl
          : f.name === 'authHeaderName'
            ? existing?.authHeaderName
            : f.name === 'externalBranchId'
              ? existing?.externalBranchId
              : f.name === 'externalTenantId'
                ? existing?.externalTenantId
                : (existing?.options as any)?.[f.name];
      seeded[f.name] = stored ?? f.default ?? '';
    }
    setValues(seeded);
    if (!isEdit && provider && !displayName) {
      setDisplayName(provider.displayName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKey, existing]);

  const setValue = (name: string, v: any) =>
    setValues((s) => ({ ...s, [name]: v }));

  const handleSave = async () => {
    if (!provider) return;

    const missing = provider.configSchema
      .filter((f) => f.required)
      .filter((f) =>
        f.secret
          ? !existing?.authSecretConfigured && !newSecret.trim()
          : !String(values[f.name] ?? '').trim(),
      );
    if (missing.length) {
      toast.error(`Required: ${missing.map((f) => f.label).join(', ')}`);
      return;
    }
    if (!displayName.trim()) {
      toast.error('Give this connection a name');
      return;
    }
    if (!isEdit && !branchId) {
      toast.error('Select a branch');
      return;
    }

    // Split schema fields into columns vs the options blob.
    const options: Record<string, unknown> = {};
    const payload: UpsertIntegrationInput = {
      displayName: displayName.trim(),
      conflictPolicy,
      syncIntervalMinutes: Number(syncIntervalMinutes),
      lookbackDays: Number(lookbackDays),
      autoCreateAbsent,
    };

    for (const f of provider.configSchema) {
      if (f.secret) continue;
      const v = values[f.name];
      switch (f.name) {
        case 'baseUrl':
          payload.baseUrl = String(v ?? '');
          break;
        case 'authHeaderName':
          payload.authHeaderName = String(v ?? '');
          break;
        case 'externalBranchId':
          payload.externalBranchId = String(v ?? '');
          break;
        case 'externalTenantId':
          payload.externalTenantId = String(v ?? '');
          break;
        default:
          options[f.name] = f.type === 'number' ? Number(v) : v;
      }
    }
    payload.options = options;

    if (clearSecret) payload.clearAuthSecret = true;
    else if (newSecret.trim()) payload.authSecret = newSecret.trim();

    setSaving(true);
    try {
      if (isEdit && existing) {
        await attendanceIntegrationsService.update(existing.id, payload);
        toast.success('Connection updated');
      } else {
        await attendanceIntegrationsService.create({
          ...payload,
          branchId,
          provider: providerKey,
        });
        toast.success('Connection created — run a dry run before enabling it');
      }
      onSaved();
    } catch (e: any) {
      toast.error(errMsg(e, 'Could not save the connection'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <div className="mt-8 w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 p-5">
          <div>
            <h3 className="font-semibold text-slate-800">
              {isEdit ? 'Edit connection' : 'Connect an attendance system'}
            </h3>
            <p className="text-sm text-slate-500">
              {isEdit
                ? 'Branch and provider cannot be changed — create a new connection instead.'
                : 'One provider per branch.'}
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-50"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" required>
              <select
                className={inputCls}
                value={providerKey}
                disabled={isEdit}
                onChange={(e) => setProviderKey(e.target.value)}
              >
                {catalogue.providers.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Branch" required>
              <select
                className={inputCls}
                value={branchId}
                disabled={isEdit}
                onChange={(e) => setBranchId(e.target.value)}
              >
                {branches.length === 0 && <option value="">No branch available</option>}
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.code})
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {provider && <p className="text-xs text-slate-400">{provider.description}</p>}

          <Field label="Connection name" required>
            <input
              className={inputCls}
              value={displayName}
              placeholder="Taageer Finance HO — Fusion"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>

          {/* Schema-driven fields — this is what makes new vendors free */}
          {provider?.configSchema.map((f) =>
            f.secret ? (
              <SecretField
                key={f.name}
                field={f}
                configured={Boolean(existing?.authSecretConfigured)}
                masked={existing?.authSecretMasked ?? ''}
                value={newSecret}
                cleared={clearSecret}
                onChange={setNewSecret}
                onClear={setClearSecret}
              />
            ) : (
              <SchemaField
                key={f.name}
                field={f}
                value={values[f.name]}
                onChange={(v) => setValue(f.name, v)}
              />
            ),
          )}

          <div className="border-t border-slate-100 pt-4">
            <p className="mb-3 text-sm font-medium text-slate-700">Sync behaviour</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Conflict rule"
                hint="What happens when we already hold a row for that employee and day."
              >
                <select
                  className={inputCls}
                  value={conflictPolicy}
                  onChange={(e) => setConflictPolicy(e.target.value)}
                >
                  {catalogue.conflictPolicies.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Sync every (minutes)" hint="Minimum 5.">
                <input
                  type="number"
                  min={5}
                  max={1440}
                  className={inputCls}
                  value={syncIntervalMinutes}
                  onChange={(e) => setSyncIntervalMinutes(Number(e.target.value))}
                />
              </Field>

              <Field
                label="Look-back days"
                hint="How much history each scheduled run re-reads, so a late punch still corrects an earlier absence."
              >
                <input
                  type="number"
                  min={0}
                  max={31}
                  className={inputCls}
                  value={lookbackDays}
                  onChange={(e) => setLookbackDays(Number(e.target.value))}
                />
              </Field>

              <div className="flex items-center justify-between gap-3 pt-6">
                <div>
                  <p className="text-sm font-medium text-slate-700">Import absentees</p>
                  <p className="text-xs text-slate-400">
                    Also write ABSENT rows the provider reports. Leave off if our own
                    auto-absent job already covers this branch.
                  </p>
                </div>
                <Toggle checked={autoCreateAbsent} onChange={setAutoCreateAbsent} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 p-5">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={saving} onClick={handleSave}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
            {isEdit ? 'Save changes' : 'Create connection'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SchemaField({
  field,
  value,
  onChange,
}: {
  field: ProviderConfigField;
  value: any;
  onChange: (v: any) => void;
}) {
  if (field.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-700">{field.label}</p>
          {field.help && <p className="text-xs text-slate-400">{field.help}</p>}
        </div>
        <Toggle checked={Boolean(value)} onChange={onChange} />
      </div>
    );
  }

  return (
    <Field label={field.label} hint={field.help} required={field.required}>
      {field.type === 'select' ? (
        <select
          className={inputCls}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          className={inputCls}
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * Write-only credential input. The stored secret is never sent to the browser,
 * so the field shows a masked hint plus Replace / Clear — matching how the
 * Copilot LLM key is handled.
 */
function SecretField({
  field,
  configured,
  masked,
  value,
  cleared,
  onChange,
  onClear,
}: {
  field: ProviderConfigField;
  configured: boolean;
  masked: string;
  value: string;
  cleared: boolean;
  onChange: (v: string) => void;
  onClear: (v: boolean) => void;
}) {
  const [replacing, setReplacing] = useState(!configured);

  return (
    <Field label={field.label} hint={field.help} required={field.required}>
      {configured && !replacing && !cleared ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 font-mono text-sm text-slate-500">
            <KeyRound className="h-4 w-4" />
            {masked || '••••'}
          </span>
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              setReplacing(true);
              onClear(false);
            }}
          >
            Replace
          </button>
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-rose-200 px-3 text-sm text-rose-600 hover:bg-rose-50"
            onClick={() => onClear(true)}
          >
            <Trash2 className="h-4 w-4" />
            Clear
          </button>
        </div>
      ) : cleared ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-rose-600">
            The stored secret will be deleted when you save.
          </span>
          <button type="button" className={btnGhost} onClick={() => onClear(false)}>
            Undo
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            autoComplete="new-password"
            className={`${inputCls} flex-1`}
            value={value}
            placeholder={field.placeholder ?? 'Paste the key'}
            onChange={(e) => onChange(e.target.value)}
          />
          {configured && (
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                setReplacing(false);
                onChange('');
              }}
            >
              Keep existing
            </button>
          )}
        </div>
      )}
    </Field>
  );
}
