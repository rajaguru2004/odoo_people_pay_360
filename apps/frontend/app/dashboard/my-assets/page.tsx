'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, History, Laptop, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAcknowledgeAsset, useMyAssets } from '@/hooks/useAssets';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';

/**
 * What the company has given the employee, and where they sign for it.
 *
 * Open items come first and are never collapsed away: this is also the screen a
 * leaver opens to find out what is blocking their exit.
 */
function MyAssetsScreen() {
  const { data, isLoading, isError, error } = useMyAssets(false);
  const acknowledge = useAcknowledgeAsset();
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const rows = data?.data ?? [];
  const open = rows.filter((row) => !row.returnedAt);
  const past = rows.filter((row) => row.returnedAt);
  const unacknowledged = open.filter((row) => !row.acknowledgedAt).length;

  usePageHeader(
    'My assets',
    open.length === 1
      ? '1 item of company property in your care'
      : `${open.length} items of company property in your care`,
  );

  const confirm = async (assignmentId: string) => {
    try {
      await acknowledge.mutateAsync({
        assignmentId,
        note: note.trim() || undefined,
      });
      toast.success('Receipt acknowledged');
      setNoteFor(null);
      setNote('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not acknowledge that asset.'));
    }
  };

  return (
    <div className="space-y-5" data-testid="ess-my-assets">
      {isError && (
        <Card className="p-6">
          <p className="text-sm text-status-error">
            {apiErrorMessage(error, 'Could not load your assets.')}
          </p>
        </Card>
      )}

      {unacknowledged > 0 && (
        <Card
          data-testid="my-assets-unacknowledged"
          className="border-status-warning/30 bg-status-warning-bg/40 p-4"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-status-warning"
              aria-hidden
            />
            <div className="text-sm text-status-warning">
              <p className="font-semibold">
                {unacknowledged} item{unacknowledged === 1 ? '' : 's'} awaiting
                your confirmation
              </p>
              <p>
                Confirm you received {unacknowledged === 1 ? 'it' : 'them'} — the
                acknowledgement is the receipt.
              </p>
            </div>
          </div>
        </Card>
      )}

      <section className="space-y-3" data-testid="my-assets-open">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-body">
          <Laptop className="h-4 w-4" aria-hidden />
          Currently held ({open.length})
        </h2>

        {isLoading && (
          <Card className="p-6">
            <p className="text-sm text-text-muted">Loading your assets…</p>
          </Card>
        )}

        {!isLoading && open.length === 0 && (
          <Card>
            <EmptyState
              icon={<Laptop className="h-6 w-6" aria-hidden />}
              title="Nothing in your care"
              description="You are not holding any company property. Anything issued to you appears here for you to sign for."
            />
          </Card>
        )}

        {open.map((row) => (
          <Card
            key={row.id}
            data-testid={`my-asset-row-${row.id}`}
            className="p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-text-heading">
                    {row.asset?.name}
                  </p>
                  <span className="rounded-[var(--radius-badge)] bg-surface-border-light px-2 py-0.5 font-mono text-xs text-text-muted">
                    {row.asset?.assetTag}
                  </span>
                  <Badge tone="info">{row.asset?.category}</Badge>
                  {row.acknowledgedAt ? (
                    <Badge tone="success">
                      <ShieldCheck className="me-1 h-3 w-3" aria-hidden />
                      Acknowledged
                    </Badge>
                  ) : (
                    <Badge tone="warning">Not acknowledged</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  Held since {formatDateOnly(row.assignedAt)}
                  {row.conditionOut
                    ? ` · condition at hand-over: ${row.conditionOut}`
                    : ''}
                  {row.asset?.serialNumber ? ` · S/N ${row.asset.serialNumber}` : ''}
                </p>
                {row.acknowledgedNote && (
                  <p className="mt-1 text-xs italic text-text-muted">
                    “{row.acknowledgedNote}”
                  </p>
                )}
              </div>

              {!row.acknowledgedAt && (
                <Button
                  size="sm"
                  onClick={() => setNoteFor(noteFor === row.id ? null : row.id)}
                  aria-label={`Acknowledge receipt of ${row.asset?.name}`}
                  data-testid={`asset-acknowledge-${row.id}`}
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  Acknowledge receipt
                </Button>
              )}
            </div>

            {noteFor === row.id && (
              <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-surface-border-light pt-3">
                <div className="min-w-[16rem] flex-1">
                  <Input
                    aria-label="Note on receipt"
                    placeholder="Optional note — the condition it arrived in"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </div>
                <Button
                  onClick={() => void confirm(row.id)}
                  isLoading={acknowledge.isPending}
                  data-testid={`asset-acknowledge-confirm-${row.id}`}
                >
                  Confirm
                </Button>
              </div>
            )}
          </Card>
        ))}
      </section>

      {past.length > 0 && (
        <section className="space-y-3" data-testid="my-assets-past">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-body">
            <History className="h-4 w-4" aria-hidden />
            Previously held ({past.length})
          </h2>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th scope="col" className="px-5 py-3 text-start font-medium">Asset</th>
                    <th scope="col" className="px-5 py-3 text-start font-medium">Tag</th>
                    <th scope="col" className="px-5 py-3 text-start font-medium">Held from</th>
                    <th scope="col" className="px-5 py-3 text-start font-medium">Returned</th>
                    <th scope="col" className="px-5 py-3 text-start font-medium">Condition</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border-light">
                  {past.map((row) => (
                    <tr key={row.id} data-testid={`my-asset-row-${row.id}`}>
                      <td className="px-5 py-3 text-text-heading">{row.asset?.name}</td>
                      <td className="px-5 py-3 font-mono text-xs text-text-muted">
                        {row.asset?.assetTag}
                      </td>
                      <td className="px-5 py-3 text-text-muted">
                        {formatDateOnly(row.assignedAt)}
                      </td>
                      <td className="px-5 py-3 text-text-muted">
                        {formatDateOnly(row.returnedAt)}
                      </td>
                      <td className="px-5 py-3 text-text-muted">
                        {row.conditionIn || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}

export default function MyAssetsPage() {
  return (
    <ProtectedRoute>
      <MyAssetsScreen />
    </ProtectedRoute>
  );
}
