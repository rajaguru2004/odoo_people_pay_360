'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileSignature,
  FileText,
  GraduationCap,
  Plane,
  Receipt,
  ScrollText,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useMyVault } from '@/hooks/useVault';
import vaultService from '@/services/vaultService';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import type { VaultItem, VaultKind } from '@/types/vault';

const KIND_META: Record<
  VaultKind,
  { label: string; icon: typeof FileText; tone: 'neutral' | 'info' | 'success' }
> = {
  PERSONAL: { label: 'Uploaded', icon: FileText, tone: 'neutral' },
  LETTER: { label: 'Letter', icon: FileSignature, tone: 'info' },
  LEGAL: { label: 'Visa / legal', icon: Plane, tone: 'info' },
  CONTRACT: { label: 'Contract', icon: ScrollText, tone: 'neutral' },
  PAYSLIP: { label: 'Payslip', icon: Receipt, tone: 'success' },
  CERTIFICATE: { label: 'Certificate', icon: GraduationCap, tone: 'success' },
};

const KINDS = Object.keys(KIND_META) as VaultKind[];

/** Inside this many days, an expiry is worth surfacing before HR chases it. */
const EXPIRY_HORIZON_DAYS = 90;

function MyDocumentsScreen() {
  const { data, isLoading, isError, error } = useMyVault();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<VaultKind | ''>('');
  const [downloading, setDownloading] = useState<string | null>(null);

  const vault = data?.data;
  const items = useMemo(() => vault?.items ?? [], [vault]);

  usePageHeader(
    'My documents',
    'Everything the company holds for you, in one place',
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((item) => {
      if (kind && item.kind !== kind) return false;
      if (!needle) return true;
      return (
        item.title.toLowerCase().includes(needle) ||
        item.category.toLowerCase().includes(needle)
      );
    });
  }, [items, search, kind]);

  const expiring = items.filter(
    (item) =>
      item.daysUntilExpiry !== null &&
      item.daysUntilExpiry >= 0 &&
      item.daysUntilExpiry <= EXPIRY_HORIZON_DAYS,
  );

  const open = async (item: VaultItem) => {
    if (item.secureKind && item.secureId) {
      // Fetched through axios so the bearer token travels with it — a plain
      // tab navigation sends no Authorization header and is refused.
      setDownloading(item.id);
      try {
        await vaultService.download(item.secureKind, item.secureId, item.title);
      } catch (err) {
        toast.error(apiErrorMessage(err, 'Could not download that document.'));
      } finally {
        setDownloading(null);
      }
      return;
    }
    if (item.fileUrl) {
      window.open(item.fileUrl, '_blank', 'noopener');
      return;
    }
    toast.info('This record has no file attached to it.');
  };

  return (
    <div className="space-y-5" data-testid="ess-my-documents">
      {expiring.length > 0 && (
        <Card className="border-status-warning/30 bg-status-warning-bg/40 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-status-warning"
              aria-hidden
            />
            <div className="text-sm text-status-warning">
              <p className="font-semibold">
                {expiring.length} document{expiring.length === 1 ? '' : 's'}{' '}
                expiring within {EXPIRY_HORIZON_DAYS} days
              </p>
              <ul className="mt-1 space-y-0.5">
                {expiring.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    {item.title} — {formatDateOnly(item.expiryDate)} (
                    {item.daysUntilExpiry} days)
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <Input
            aria-label="Search documents"
            placeholder="Search documents…"
            icon={<Search className="h-4 w-4" aria-hidden />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="w-56">
          <Select
            aria-label="Filter by document type"
            placeholder="All types"
            value={kind}
            onChange={(event) => setKind(event.target.value as VaultKind | '')}
          >
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {KIND_META[value].label} ({vault?.summary.byKind[value] ?? 0})
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Card>
        {isLoading && (
          <p className="p-6 text-sm text-text-muted">Loading your documents…</p>
        )}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(error, 'Could not load your documents.')}
          </p>
        )}

        {!isLoading && !isError && filtered.length === 0 && (
          <EmptyState
            icon={<FileText className="h-6 w-6" aria-hidden />}
            title="Nothing to show"
            description={
              items.length === 0
                ? 'Anything the company files for you — letters, payslips, certificates — will appear here.'
                : 'No document matches that search.'
            }
          />
        )}

        {filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Document</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Type</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Issued</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Expires</th>
                  <th scope="col" className="px-5 py-3 text-end font-medium">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {filtered.map((item) => {
                  const meta = KIND_META[item.kind];
                  const Icon = meta.icon;
                  const expired =
                    item.daysUntilExpiry !== null && item.daysUntilExpiry < 0;
                  const soon =
                    item.daysUntilExpiry !== null &&
                    item.daysUntilExpiry >= 0 &&
                    item.daysUntilExpiry <= EXPIRY_HORIZON_DAYS;
                  const downloadable = Boolean(item.fileUrl || item.secureKind);

                  return (
                    <tr
                      key={`${item.kind}-${item.id}`}
                      data-testid={`document-row-${item.id}`}
                      className="hover:bg-surface-border-light/60"
                    >
                      <td className="px-5 py-3">
                        <p className="font-medium text-text-heading">{item.title}</p>
                        <p className="text-xs text-text-muted">{item.source}</p>
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={meta.tone}>
                          <Icon className="me-1 h-3 w-3" aria-hidden />
                          {meta.label}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 text-text-muted">
                        {formatDateOnly(item.issueDate)}
                      </td>
                      <td className="px-5 py-3">
                        {item.expiryDate ? (
                          <span
                            className={
                              expired
                                ? 'font-medium text-status-error'
                                : soon
                                  ? 'font-medium text-status-warning'
                                  : 'text-text-muted'
                            }
                          >
                            {formatDateOnly(item.expiryDate)}
                            {expired
                              ? ' (expired)'
                              : soon
                                ? ` (${item.daysUntilExpiry}d)`
                                : ''}
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {item.secureKind && (
                            <ShieldCheck
                              className="h-4 w-4 text-status-success"
                              aria-label="Stored privately — downloaded through an authenticated route"
                            />
                          )}
                          <button
                            type="button"
                            onClick={() => void open(item)}
                            disabled={!downloadable || downloading === item.id}
                            aria-label={`Open ${item.title}`}
                            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] border border-surface-border px-2.5 text-xs font-medium text-text-body transition-colors hover:bg-surface-border-light disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden />
                            {downloadable ? 'Open' : 'No file'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Bare guard on purpose — no permission, no role list.
 *
 * Self-service screens belong to every signed-in role and each caller sees only
 * their own records, so narrowing by role would take the page away from the
 * people it exists for. What the guard settles is "is anybody signed in", which
 * is what stops a mid-restore visitor firing requests that are then refused.
 */
export default function MyDocumentsPage() {
  return (
    <ProtectedRoute>
      <MyDocumentsScreen />
    </ProtectedRoute>
  );
}
