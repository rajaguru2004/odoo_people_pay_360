'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import assetService from '@/services/assetService';
import { formatCurrency } from '@/utils/formatters';
import { ClearanceStatus } from '@/types/asset';

/**
 * Shows whether an employee can actually be offboarded.
 *
 * The block itself is enforced server-side on all three deactivation paths;
 * this exists so an approver sees *why* an approval is going to fail before
 * they click it, and knows exactly which items to chase.
 *
 * "Why" is TWO things, not one: `ClearanceService` blocks on an asset whose
 * `returnedAt` is null AND on an unrecovered advance/loan balance. Both halves
 * are rendered, each with its own rows and its own remedy — advising "record
 * the return in the Asset Register" to someone held up by a loan sends them to
 * a screen that will show them nothing (R20).
 */
export default function ClearanceBanner({
  employeeId,
  onStatus,
}: {
  employeeId: string;
  /** Lets the parent disable its Approve button while `cleared` is false. */
  onStatus?: (status: ClearanceStatus) => void;
}) {
  const [status, setStatus] = useState<ClearanceStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await assetService.getClearance(employeeId);
        if (cancelled) return;
        setStatus(res.data);
        onStatus?.(res.data);
      } catch {
        // Non-fatal: the server still blocks the action. Staying silent is
        // better than a scary banner caused by a transient read failure.
        if (!cancelled) setStatus(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // onStatus is intentionally excluded — parents commonly pass an inline
    // arrow, which would re-fire this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  if (loading) {
    return (
      <div
        data-testid="clearance-banner"
        data-clearance-state="loading"
        className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking asset clearance…
      </div>
    );
  }

  if (!status) return null;

  if (status.cleared) {
    return (
      <div
        data-testid="clearance-banner"
        data-clearance-state="cleared"
        className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span data-testid="clearance-status" data-cleared="true">
          Clearance passed — no company property and no loan balance outstanding.
        </span>
      </div>
    );
  }

  // Defensive reads: an older backend (or a hand-rolled fixture) may not carry
  // the loan half at all, and a banner that throws is worse than one that
  // under-reports.
  const openAssets = status.openAssets ?? [];
  const outstandingLoans = status.outstandingLoans ?? [];
  const assetCount = openAssets.length;
  const loanCount = outstandingLoans.length;

  // The headline names EVERY obligation that is blocking, in the server's own
  // terms. Quoting "0 company assets not returned" at someone held up by an
  // advance is what R20 was: the one screen whose job is to name the blocker
  // naming the wrong one, and then advising a remedy that cannot apply.
  const reasons: string[] = [];
  if (assetCount > 0) {
    reasons.push(`${assetCount} company asset${assetCount === 1 ? '' : 's'} not returned`);
  }
  if (loanCount > 0) {
    reasons.push(
      `${loanCount} outstanding loan balance${loanCount === 1 ? '' : 's'}`,
    );
  }
  // `cleared: false` with nothing itemised should not happen, but if the server
  // ever blocks for a reason it does not list, say that rather than "0 assets".
  const headline = reasons.length
    ? `Blocked: ${reasons.join(' and ')}`
    : 'Blocked: clearance obligations are outstanding';

  return (
    <div
      data-testid="clearance-banner"
      data-clearance-state="blocked"
      className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <p
          data-testid="clearance-status"
          data-cleared="false"
          data-open-assets={assetCount}
          data-outstanding-loans={loanCount}
          className="font-semibold"
        >
          {headline}
        </p>
        {assetCount > 0 && (
          <ul className="mt-1 space-y-0.5">
            {openAssets.map((a) => (
              <li
                key={a.assignmentId}
                data-testid={`clearance-open-asset-${a.assignmentId}`}
              >
                <span className="font-mono">{a.assetTag}</span> — {a.name} ({a.category})
              </li>
            ))}
          </ul>
        )}
        {loanCount > 0 && (
          <ul className="mt-1 space-y-0.5">
            {outstandingLoans.map((l) => (
              <li key={l.loanId} data-testid={`clearance-outstanding-loan-${l.loanId}`}>
                <span className="font-mono">{l.referenceNo ?? l.loanId.slice(0, 8)}</span> —{' '}
                {l.type.replace(/_/g, ' ')} · {formatCurrency(l.outstanding)} outstanding
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-amber-800">
          {assetCount > 0 && 'Record the return in the Asset Register. '}
          {loanCount > 0 && 'Settle or write off the balance in Advances & Loans. '}
          An ADMIN/HR Manager can override with a reason (audited).
        </p>
      </div>
    </div>
  );
}
