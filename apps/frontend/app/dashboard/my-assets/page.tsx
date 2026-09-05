'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Laptop,
  Loader2,
  CheckCircle2,
  ShieldCheck,
  History,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import assetService from '@/services/assetService';
import { AssetAssignment } from '@/types/asset';

function fmtDate(d?: string | null) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(d);
  }
}

/**
 * "My Assets" — the employee's view of what the company has given them, and
 * where they digitally acknowledge receipt.
 *
 * Also the place a leaver finds out why their exit is blocked, so open items
 * are listed first and never collapsed away.
 */
function MyAssetsScreen() {
  const [rows, setRows] = useState<AssetAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState('');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('My Assets', 'Company property assigned to you');

  const load = useCallback(async () => {
    try {
      const res = await assetService.getMyAssets(false);
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to load your assets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const acknowledge = async (assignmentId: string) => {
    setBusyId(assignmentId);
    try {
      await assetService.acknowledge(assignmentId, note.trim() || undefined);
      toast.success('Receipt acknowledged');
      setNoteFor(null);
      setNote('');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to acknowledge');
    } finally {
      setBusyId(null);
    }
  };

  const open = rows.filter((r) => !r.returnedAt);
  const past = rows.filter((r) => r.returnedAt);
  const unacknowledged = open.filter((r) => !r.acknowledgedAt).length;

  return (
    <div className="p-4 md:p-6 space-y-6" data-testid="ess-my-assets">
      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-surface-border bg-surface-card p-8 text-text-muted shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {unacknowledged > 0 && (
            <div
              data-testid="my-assets-unacknowledged"
              data-count={unacknowledged}
              className="flex items-start gap-3 rounded-2xl border border-status-warning/30 bg-status-warning-bg/40 p-4"
            >
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-status-warning" />
              <div className="text-sm text-status-warning">
                <p className="font-semibold">
                  {unacknowledged} item{unacknowledged === 1 ? '' : 's'} awaiting
                  your confirmation
                </p>
                <p className="text-status-warning">
                  Please confirm you received {unacknowledged === 1 ? 'it' : 'them'}.
                </p>
              </div>
            </div>
          )}

          <section data-testid="my-assets-open" className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-body">
              <Laptop className="h-4 w-4" /> Currently held ({open.length})
            </h2>

            {open.length === 0 ? (
              <div
                data-testid="my-assets-empty"
                className="rounded-2xl border border-surface-border bg-surface-card p-8 text-center text-sm text-text-muted shadow-sm"
              >
                You are not holding any company assets.
              </div>
            ) : (
              open.map((row) => (
                <div
                  key={row.id}
                  data-testid={`my-asset-row-${row.id}`}
                  className="rounded-2xl border border-surface-border bg-surface-card p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-text-heading">
                          {row.asset?.name}
                        </p>
                        <span className="rounded-full bg-surface-page px-2 py-0.5 font-mono text-[11px] text-text-muted">
                          {row.asset?.assetTag}
                        </span>
                        <span className="rounded-full bg-status-info-bg/40 px-2 py-0.5 text-[11px] text-status-info">
                          {row.asset?.category}
                        </span>
                        {row.acknowledgedAt ? (
                          <span
                            data-testid={`my-asset-ack-state-${row.id}`}
                            data-acknowledged="true"
                            className="inline-flex items-center gap-1 rounded-full bg-status-success-bg/40 px-2 py-0.5 text-[11px] text-status-success"
                          >
                            <ShieldCheck size={11} /> Acknowledged
                          </span>
                        ) : (
                          <span
                            data-testid={`my-asset-ack-state-${row.id}`}
                            data-acknowledged="false"
                            className="rounded-full bg-status-warning-bg/40 px-2 py-0.5 text-[11px] text-status-warning"
                          >
                            Not acknowledged
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        Held since {fmtDate(row.assignedAt)}
                        {row.conditionOut ? ` · condition at hand-over: ${row.conditionOut}` : ''}
                        {row.asset?.serialNumber ? ` · S/N ${row.asset.serialNumber}` : ''}
                      </p>
                      {row.acknowledgedNote && (
                        <p className="mt-1 text-xs italic text-text-muted">
                          “{row.acknowledgedNote}”
                        </p>
                      )}
                    </div>

                    {!row.acknowledgedAt && (
                      <button
                        data-testid={`asset-acknowledge-${row.id}`}
                        onClick={() =>
                          setNoteFor(noteFor === row.id ? null : row.id)
                        }
                        disabled={busyId === row.id}
                        className="inline-flex h-11 md:h-9 items-center gap-1.5 rounded-lg bg-status-success px-3 text-sm font-medium text-white hover:bg-status-success disabled:opacity-50"
                      >
                        <CheckCircle2 size={14} /> Acknowledge receipt
                      </button>
                    )}
                  </div>

                  {noteFor === row.id && (
                    <div className="mt-3 flex items-center gap-2 border-t border-surface-border-light pt-3">
                      <input
                        data-testid={`asset-acknowledge-note-${row.id}`}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Optional note (e.g. condition on receipt)…"
                        className="h-11 md:h-9 flex-1 rounded-lg border border-surface-border px-3 text-base md:text-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                      />
                      <button
                        data-testid={`asset-acknowledge-confirm-${row.id}`}
                        onClick={() => acknowledge(row.id)}
                        disabled={busyId === row.id}
                        className="inline-flex h-11 md:h-9 items-center gap-1.5 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white disabled:opacity-50"
                      >
                        {busyId === row.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        Confirm
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </section>

          {past.length > 0 && (
            <section data-testid="my-assets-past" className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-text-body">
                <History className="h-4 w-4" /> Previously held ({past.length})
              </h2>
              <div className="overflow-x-auto rounded-2xl border border-surface-border bg-surface-card shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-surface-page text-left text-xs uppercase text-text-muted">
                    <tr>
                      <th className="px-4 py-3">Asset</th>
                      <th className="px-4 py-3">Tag</th>
                      <th className="px-4 py-3">Held</th>
                      <th className="px-4 py-3">Returned</th>
                      <th className="px-4 py-3">Condition</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border-light">
                    {past.map((row) => (
                      <tr key={row.id} data-testid={`my-asset-row-${row.id}`}>
                        <td className="px-4 py-3 text-text-heading">{row.asset?.name}</td>
                        <td className="px-4 py-3 font-mono text-xs text-text-muted">
                          {row.asset?.assetTag}
                        </td>
                        <td className="px-4 py-3 text-text-muted">
                          {fmtDate(row.assignedAt)}
                        </td>
                        <td className="px-4 py-3 text-text-muted">
                          {fmtDate(row.returnedAt)}
                        </td>
                        <td className="px-4 py-3 text-text-muted">
                          {row.conditionIn || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/**
 * R17 — the guard the three ESS screens were missing.
 *
 * `/dashboard/my-assets`, `/dashboard/my-letters` and `/dashboard/my-documents`
 * were the only dashboard screens that exported their component directly, with
 * no `<ProtectedRoute>` anywhere: the shell rendered for whoever the browser
 * happened to be and the payload was safe only because the server scopes it to
 * the caller. Every other screen decides client-side first.
 *
 * The guard here is deliberately BARE — no `requiredPermission`, no
 * `requiredRoles`. These are self-service screens: every authenticated role may
 * open them and each one sees only their own records, so narrowing by role
 * would take the page away from the people it exists for. What was missing was
 * not authorisation but a settled answer to "is anybody signed in?", which is
 * exactly what `ProtectedRoute` computes: it renders nothing until the auth
 * store has hydrated AND the session has resolved, so a signed-out or
 * mid-restore visitor never sees an ESS shell fire its requests and then blank.
 */
export default function MyAssetsPage() {
  return (
    <ProtectedRoute>
      <MyAssetsScreen />
    </ProtectedRoute>
  );
}
