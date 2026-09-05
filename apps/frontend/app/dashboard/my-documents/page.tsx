'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileText,
  Loader2,
  Search,
  Download,
  AlertTriangle,
  ShieldCheck,
  Plane,
  ScrollText,
  Receipt,
  GraduationCap,
  FileSignature,
} from 'lucide-react';
import { toast } from 'sonner';
import DataCard from '@/components/common/DataCard';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import vaultService from '@/services/vaultService';
import { resolveFileUrl } from '@/utils/fileUrl';
import { VaultItem, VaultKind, VaultResponse } from '@/types/vault';

const KIND_META: Record<VaultKind, { label: string; icon: any; style: string }> = {
  PERSONAL: { label: 'Uploaded', icon: FileText, style: 'bg-surface-page text-text-muted' },
  LETTER: { label: 'Letter', icon: FileSignature, style: 'bg-brand-primary/10 text-brand-primary' },
  LEGAL: { label: 'Visa / legal', icon: Plane, style: 'bg-brand-primary-light/20 text-brand-primary' },
  CONTRACT: { label: 'Contract', icon: ScrollText, style: 'bg-violet-50 text-violet-700' },
  PAYSLIP: { label: 'Payslip', icon: Receipt, style: 'bg-status-success-bg/40 text-status-success' },
  CERTIFICATE: { label: 'Certificate', icon: GraduationCap, style: 'bg-status-info-bg/40 text-status-info' },
};

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
 * One screen for everything the employee holds — uploads, generated letters,
 * visa records, contracts, payslips and training certificates.
 *
 * Private files (letters, anything with a `secureKind`) are never linked
 * directly; they go through the authenticated download route.
 */
function MyDocumentsScreen() {
  const [data, setData] = useState<VaultResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<VaultKind | ''>('');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('My Documents', 'Everything the company holds for you, in one place');

  const load = useCallback(async () => {
    try {
      const res = await vaultService.getMine();
      setData(res.data);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to load your documents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const items = data?.items ?? [];
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (kind && i.kind !== kind) return false;
      if (!q) return true;
      return (
        i.title.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)
      );
    });
  }, [data, search, kind]);

  const expiring = (data?.items ?? []).filter(
    (i) => i.daysUntilExpiry !== null && i.daysUntilExpiry >= 0 && i.daysUntilExpiry <= 90,
  );

  const [downloading, setDownloading] = useState<string | null>(null);

  const open = async (item: VaultItem) => {
    if (item.secureKind && item.secureId) {
      // Fetched through axios so the bearer token is attached — a plain
      // window.open sends no Authorization header and 401s.
      setDownloading(item.id);
      try {
        await vaultService.download(item.secureKind, item.secureId, item.title);
      } catch {
        toast.error('Could not download that document.');
      } finally {
        setDownloading(null);
      }
      return;
    }
    if (item.fileUrl) {
      window.open(resolveFileUrl(item.fileUrl) ?? item.fileUrl, '_blank');
      return;
    }
    toast.info('This record has no downloadable file attached.');
  };

  return (
    <div className="p-4 md:p-6 space-y-6" data-testid="ess-my-documents">
      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-surface-border bg-surface-card p-8 text-text-muted shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : !data ? null : (
        <>
          {expiring.length > 0 && (
            <div className="flex items-start gap-3 rounded-2xl border border-status-warning/30 bg-status-warning-bg/40 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-status-warning" />
              <div className="text-sm text-status-warning">
                <p className="font-semibold">
                  {expiring.length} document{expiring.length === 1 ? '' : 's'} expiring
                  within 90 days
                </p>
                <ul className="mt-1 space-y-0.5 text-status-warning">
                  {expiring.map((i) => (
                    <li key={`${i.kind}-${i.id}`}>
                      {i.title} — {fmtDate(i.expiryDate)} ({i.daysUntilExpiry} days)
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full md:min-w-[220px] md:flex-1">
              <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                data-testid="document-search"
                className="h-12 md:h-10 w-full rounded-lg border border-surface-border ps-10 pe-3 text-base md:text-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                placeholder="Search documents…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              data-testid="document-kind-filter"
              className="h-10 rounded-lg border border-surface-border px-3 text-base md:text-sm focus:border-brand-primary focus:outline-none"
              value={kind}
              onChange={(e) => setKind(e.target.value as VaultKind | '')}
            >
              <option value="">All types</option>
              {(Object.keys(KIND_META) as VaultKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_META[k].label} ({data.summary.byKind[k] ?? 0})
                </option>
              ))}
            </select>
          </div>

          {filtered.length === 0 ? (
            <div
              data-testid="document-empty"
              className="rounded-2xl border border-surface-border bg-surface-card p-10 text-center text-text-muted shadow-sm"
            >
              No documents found.
            </div>
          ) : (
            <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto rounded-2xl border border-surface-border bg-surface-card shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-surface-page text-left text-xs uppercase text-text-muted">
                  <tr>
                    <th className="px-4 py-3">Document</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Issued</th>
                    <th className="px-4 py-3">Expires</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border-light">
                  {filtered.map((item) => {
                    const meta = KIND_META[item.kind];
                    const Icon = meta.icon;
                    const expiringSoon =
                      item.daysUntilExpiry !== null &&
                      item.daysUntilExpiry >= 0 &&
                      item.daysUntilExpiry <= 90;
                    const expired =
                      item.daysUntilExpiry !== null && item.daysUntilExpiry < 0;
                    const downloadable = Boolean(item.fileUrl || item.secureKind);
                    return (
                      <tr
                        key={`${item.kind}-${item.id}`}
                        data-testid={`document-row-${item.id}`}
                        data-kind={item.kind}
                        className="hover:bg-surface-page/60"
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium text-text-heading">{item.title}</p>
                          <p className="text-xs text-text-muted">{item.source}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.style}`}
                          >
                            <Icon size={11} /> {meta.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-text-muted">
                          {fmtDate(item.issueDate)}
                        </td>
                        <td
                          className={`px-4 py-3 ${
                            expired
                              ? 'font-medium text-status-error'
                              : expiringSoon
                                ? 'font-medium text-status-warning'
                                : 'text-text-muted'
                          }`}
                        >
                          {item.expiryDate ? (
                            <>
                              {fmtDate(item.expiryDate)}
                              {expired
                                ? ' (expired)'
                                : expiringSoon
                                  ? ` (${item.daysUntilExpiry}d)`
                                  : ''}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {item.secureKind && (
                              <span
                                title="Stored privately — served through an authenticated, audited download"
                                className="text-status-success"
                              >
                                <ShieldCheck size={14} />
                              </span>
                            )}
                            <button
                              data-testid={`document-download-${item.id}`}
                              onClick={() => open(item)}
                              disabled={!downloadable || downloading === item.id}
                              title={
                                downloadable
                                  ? 'Download'
                                  : 'No file attached to this record'
                              }
                              className="inline-flex h-11 md:h-8 items-center gap-1.5 rounded-lg border border-surface-border px-2.5 text-xs font-medium text-text-body hover:bg-surface-page disabled:opacity-40"
                            >
                              <Download size={13} /> Open
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards. A five-column table with a download action in the
                last cell is unusable at 390px — the action is the reason the
                screen is opened, and it was the column furthest off the edge. */}
            <div className="md:hidden space-y-3">
              {filtered.map((item) => {
                const meta = KIND_META[item.kind];
                const Icon = meta.icon;
                const expiringSoon =
                  item.daysUntilExpiry !== null &&
                  item.daysUntilExpiry >= 0 &&
                  item.daysUntilExpiry <= 90;
                const expired = item.daysUntilExpiry !== null && item.daysUntilExpiry < 0;
                const downloadable = Boolean(item.fileUrl || item.secureKind);
                return (
                  <DataCard
                    key={`m-${item.kind}-${item.id}`}
                    // NOT `document-row-*`: the desktop table renders the same
                    // records and Playwright counts hidden nodes too.
                    testId={`document-card-${item.id}`}
                    title={
                      <span className="flex flex-col">
                        <span>{item.title}</span>
                        <span className="text-xs font-normal text-text-muted">{item.source}</span>
                      </span>
                    }
                    headerRight={
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.style}`}>
                        <Icon size={11} /> {meta.label}
                      </span>
                    }
                    items={[
                      { label: 'Issued', value: fmtDate(item.issueDate) },
                      {
                        label: 'Expires',
                        value: item.expiryDate ? (
                          <span
                            className={
                              expired
                                ? 'font-medium text-status-error'
                                : expiringSoon
                                  ? 'font-medium text-status-warning'
                                  : undefined
                            }
                          >
                            {fmtDate(item.expiryDate)}
                            {expired ? ' (expired)' : expiringSoon ? ` (${item.daysUntilExpiry}d)` : ''}
                          </span>
                        ) : (
                          '—'
                        ),
                      },
                    ]}
                    footer={
                      <button
                        data-testid={`document-card-download-${item.id}`}
                        onClick={() => open(item)}
                        disabled={!downloadable || downloading === item.id}
                        className="inline-flex h-11 w-full touch-manipulation items-center justify-center gap-1.5 rounded-lg border border-surface-border px-4 text-sm font-medium text-text-body hover:bg-surface-page disabled:opacity-40 active:scale-[0.99]"
                      >
                        <Download size={15} />
                        {downloadable ? 'Open' : 'No file attached'}
                      </button>
                    }
                  />
                );
              })}
            </div>
            </>
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
export default function MyDocumentsPage() {
  return (
    <ProtectedRoute>
      <MyDocumentsScreen />
    </ProtectedRoute>
  );
}
