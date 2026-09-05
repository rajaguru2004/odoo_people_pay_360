'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Check, Loader2, Pencil, Printer, X } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePermission } from '@/hooks/usePermission';
import {
  finalSettlementService,
  type FinalSettlement,
  type SettlementLine,
  type SettlementWorkingEntry,
} from '@/services/payrollExtensionsService';
import { formatCurrency } from '@/utils/formatters';
import { apiErrorMessage } from '@/utils/apiError';
import { toast } from '@/lib/toast';
import { usePageHeader } from '@/hooks/usePageHeader';

/** What a line is actually worth, after any override. */
const effective = (l: SettlementLine): number =>
  l.adjustedAmount === null || l.adjustedAmount === undefined
    ? Number(l.computedAmount)
    : Number(l.adjustedAmount);

/**
 * The working is a JSON column, so an entry is not guaranteed to be a string —
 * the composer writes sentences, other producers write structured entries.
 * Rendering one straight into JSX crashed this page, so everything is reduced
 * to a line of text here rather than trusted to already be one.
 */
const workingText = (entry: SettlementWorkingEntry): string => {
  if (typeof entry === 'string') return entry;
  if (entry === null || typeof entry !== 'object') return String(entry ?? '');
  const { label, code, amount } = entry;
  const name = label ?? code ?? '';
  if (amount === undefined || amount === null) return name || JSON.stringify(entry);
  const value = Number(amount);
  const money = Number.isFinite(value) ? formatCurrency(Math.abs(value)) : String(amount);
  const sign = Number.isFinite(value) && value < 0 ? '\u2212' : '+';
  return name ? `${sign} ${name}: ${money}` : `${sign} ${money}`;
};

/**
 * One settlement, with every line adjustable and every adjustment explained.
 *
 * The reason field is not optional and is not a nicety: the server requires it
 * and a database CHECK enforces it, because a settlement is read years later by
 * people who were not in the room. This screen therefore refuses to submit an
 * adjustment without one rather than letting the server say no.
 */
function SettlementDetailContent() {
  const params = useParams();
  const router = useRouter();
  const { isAdmin } = usePermission();
  const id = String(params?.id ?? '');

  const [settlement, setSettlement] = useState<FinalSettlement | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<SettlementLine | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await finalSettlementService.getById(id);
      setSettlement(res.data);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load the settlement'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) void load();
  }, [id]);

  const saveAdjustment = async () => {
    if (!editing) return;
    if (!reason.trim()) {
      toast.error(
        'A reason is required. It is stored with the figure, because a ' +
          'settlement is read years later by people who were not in the room.',
      );
      return;
    }
    setBusy(true);
    try {
      await finalSettlementService.adjustLine(id, editing.id, {
        amount: Number(amount) || 0,
        reason: reason.trim(),
      });
      setEditing(null);
      setReason('');
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not save the change'));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, failure));
    } finally {
      setBusy(false);
    }
  };

  // The one heading for this route, rendered by TopHeader — and the record crumb
  // PageBreadcrumbs appends, so the trail reads `Payroll > Final Settlements >
  // <employee>` instead of stopping on the list and marking IT the current page.
  // Above the early-returns so the hook order never changes; the fallback matters
  // because TopHeader's `??` is nullish-only and '' would paint a blank header.
  usePageHeader(
    settlement?.employee?.fullName ?? settlement?.employeeId ?? 'Final settlement',
    settlement
      ? `${settlement.employee?.employeeCode ?? ''} · ${settlement.variant.replace('_', ' ')}`.trim()
      : undefined,
  );

  if (loading) {
    return <div className="p-8 text-center text-sm text-slate-500">Loading…</div>;
  }
  if (!settlement) {
    return <div className="p-8 text-center text-sm text-slate-500">Not found.</div>;
  }

  const earnings = settlement.lines.filter((l) => l.category === 'EARNING');
  const deductions = settlement.lines.filter((l) => l.category === 'DEDUCTION');
  const net = Number(settlement.netPayable);
  const isDraft = settlement.status === 'DRAFT';

  const Section = ({ title, lines, tone }: { title: string; lines: SettlementLine[]; tone: 'success' | 'error' }) => (
    <div className="mb-6">
      <h3 className={`mb-2 text-sm font-semibold ${tone === 'success' ? 'text-emerald-700' : 'text-red-700'}`}>
        {title}
      </h3>
      <div className="space-y-1">
        {lines.length === 0 && (
          <p className="py-2 text-sm text-slate-400">Nothing under this heading.</p>
        )}
        {lines.map((l) => {
          const changed = l.adjustedAmount !== null && l.adjustedAmount !== undefined;
          return (
            <div
              key={l.id}
              data-testid="settlement-line"
              data-code={l.code}
              className="flex items-start justify-between gap-3 border-b border-slate-100 py-2"
            >
              <div className="min-w-0">
                <span className="text-sm text-slate-700">{l.label}</span>
                {changed && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                    adjusted
                  </span>
                )}
                {changed && l.adjustmentReason && (
                  <p className="mt-0.5 text-xs text-slate-500">{l.adjustmentReason}</p>
                )}
                {changed && (
                  <p className="text-[11px] text-slate-400">
                    computed {formatCurrency(Number(l.computedAmount))}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`text-sm font-semibold ${tone === 'success' ? 'text-emerald-700' : 'text-red-700'}`}>
                  {tone === 'success' ? '+' : '-'}
                  {formatCurrency(effective(l))}
                </span>
                {isDraft && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(l);
                      setAmount(String(effective(l)));
                      setReason(l.adjustmentReason ?? '');
                    }}
                    data-testid="settlement-line-edit"
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    aria-label={`Change ${l.label}`}
                  >
                    <Pencil size={13} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => router.push('/dashboard/payroll/settlements')}
          className="inline-flex items-center gap-1 text-sm text-slate-600"
        >
          <ArrowLeft size={15} /> Settlements
        </button>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <Printer size={14} /> Print
          </button>
          {isDraft && isAdmin() && (
            <button
              type="button"
              disabled={busy}
              onClick={() => act(() => finalSettlementService.approve(id), 'Could not approve')}
              data-testid="settlement-approve"
              className="inline-flex items-center gap-1 rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              <Check size={14} /> Approve
            </button>
          )}
          {settlement.status === 'APPROVED' && isAdmin() && (
            <button
              type="button"
              disabled={busy}
              onClick={() => act(() => finalSettlementService.markPaid(id), 'Could not mark paid')}
              data-testid="settlement-pay"
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              Mark paid
            </button>
          )}
          {settlement.status !== 'PAID' && settlement.status !== 'CANCELLED' && isAdmin() && (
            <button
              type="button"
              onClick={() => setCancelling(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600"
            >
              <X size={14} /> Cancel
            </button>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            {/* Not an <h1>: the page's single heading slot is TopHeader's, which
                already carries this name. This is the record card's own label. */}
            <h2 className="text-base font-semibold text-slate-800">
              {settlement.employee?.fullName ?? settlement.employeeId}
            </h2>
            <p className="text-xs text-slate-500">
              {settlement.employee?.employeeCode} · {settlement.variant.replace('_', ' ')} ·
              last day {String(settlement.lastWorkingDate).slice(0, 10)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-slate-400">
              {net < 0 ? 'Receivable from employee' : 'Net payable'}
            </p>
            <p
              data-testid="settlement-net"
              className={`text-2xl font-bold ${net < 0 ? 'text-red-600' : 'text-slate-800'}`}
            >
              {formatCurrency(Math.abs(net))}
            </p>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
              {settlement.status}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <Section title="Owed to the employee" lines={earnings} tone="success" />
        <Section title="Recovered" lines={deductions} tone="error" />

        <div className="flex items-center justify-between border-t border-slate-200 pt-3">
          <span className="text-sm font-semibold text-slate-700">
            {net < 0 ? 'Balance owed BY the employee' : 'Net payable'}
          </span>
          <span className={`text-lg font-bold ${net < 0 ? 'text-red-600' : 'text-slate-800'}`}>
            {formatCurrency(Math.abs(net))}
          </span>
        </div>
        {net < 0 && (
          <p className="mt-2 text-xs text-slate-500">
            Deductions exceed what is owed. Unlike a payslip, a settlement is not
            floored at zero — a leaver can genuinely owe money, and the document
            has to be able to say so.
          </p>
        )}
      </div>

      {settlement.workingJson?.lines && settlement.workingJson.lines.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <summary className="cursor-pointer text-sm font-semibold text-slate-800">
            The working
          </summary>
          <p className="mt-1 text-xs text-slate-500">
            Stored as at preparation and never recomputed, because
            &ldquo;the system would calculate it differently now&rdquo; is not an
            answer to a settlement queried five years later.
          </p>
          <ul className="mt-3 space-y-1 font-mono text-xs text-slate-600">
            {[...(settlement.workingJson.gratuity ?? []), ...settlement.workingJson.lines].map(
              (line, i) => (
                <li key={i}>{workingText(line)}</li>
              ),
            )}
          </ul>
        </details>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-800">{editing.label}</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Computed as {formatCurrency(Number(editing.computedAmount))}.
            </p>
            <label className="mt-4 block text-xs font-medium text-slate-600">
              Amount
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="settlement-adjust-amount"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-600">
              Why
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                data-testid="settlement-adjust-reason"
                placeholder="Three unpaid days in the final week."
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                Required. Stored with the figure and shown on the statement.
              </span>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-lg px-4 py-2 text-sm text-slate-600"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveAdjustment}
                disabled={busy || !reason.trim()}
                data-testid="settlement-adjust-save"
                className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {cancelling && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-800">Cancel this settlement</h2>
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={3}
              placeholder="Employee withdrew their resignation."
              className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancelling(false)}
                className="rounded-lg px-4 py-2 text-sm text-slate-600"
              >
                Keep it
              </button>
              <button
                type="button"
                disabled={busy || !cancelReason.trim()}
                onClick={async () => {
                  await act(
                    () => finalSettlementService.cancel(id, cancelReason.trim()),
                    'Could not cancel',
                  );
                  setCancelling(false);
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Cancel it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettlementDetailPage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <SettlementDetailContent />
    </ProtectedRoute>
  );
}
