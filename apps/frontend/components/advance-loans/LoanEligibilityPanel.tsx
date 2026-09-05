'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import advanceLoanService from '@/services/advanceLoanService';
import { EligibilityResult } from '@/types/advanceLoan';
import { formatCurrency } from '@/utils/formatters';
import { apiErrorMessage } from '@/utils/apiError';

interface Props {
  amount: number;
  installments: number;
  type: string;
  employeeId?: string;
}

const ICON = {
  PASS: <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-status-success" />,
  WARN: <AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-warning" />,
  FAIL: <XCircle size={14} className="mt-0.5 shrink-0 text-status-error" />,
} as const;

const TEXT = {
  PASS: 'text-text-muted',
  WARN: 'text-status-warning',
  FAIL: 'text-status-error',
} as const;

/**
 * Live eligibility for the request form.
 *
 * Without it, every rule in the module — active-loan cap, service period,
 * affordability, ceilings — only surfaces as an opaque 400 AFTER submit. Here
 * each rule is a visible row before the user commits.
 *
 * RENDERING RULE: once a result exists it stays on screen while the next one
 * loads (stale-while-revalidate). Unmounting the checklist per keystroke
 * collapsed the panel and resized the whole modal — which read as the form
 * flickering while you typed. The refresh is a background call: the old answer
 * dims slightly, nothing moves.
 */
export default function LoanEligibilityPanel({
  amount,
  installments,
  type,
  employeeId,
}: Props) {
  const [result, setResult] = useState<EligibilityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Aborts the in-flight request when the inputs change again, so a slow
  // earlier answer can never overwrite a newer one — and the browser stops
  // holding open a connection nobody is waiting for.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!amount || amount <= 0) {
      abortRef.current?.abort();
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }

    // Longer than a keystroke gap, so a typed "20000" is ONE request, not five.
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      try {
        const res = await advanceLoanService.checkEligibility(
          { employeeId, amount, installments, type },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResult((res as any)?.data ?? (res as any));
        setError(null);
      } catch (e: any) {
        // An abort is the expected outcome of typing, not a failure.
        if (controller.signal.aborted || e?.code === 'ERR_CANCELED') return;
        setError(
          apiErrorMessage(e, 'Could not check eligibility right now'),
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [amount, installments, type, employeeId]);

  // Abort whatever is in flight when the form closes.
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!amount || amount <= 0) return null;

  return (
    <div
      data-testid="loan-eligibility-panel"
      data-loading={loading}
      data-eligible={result ? result.eligible : undefined}
      data-checks={result ? result.checks.length : 0}
      className="rounded-lg border border-surface-border bg-surface-page p-3"
      aria-busy={loading}
      aria-live="polite"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-text-body">Eligibility</span>
        {loading && (
          <Loader2 size={14} className="animate-spin text-text-muted" />
        )}
      </div>

      {error && <p className="text-sm text-status-error">{error}</p>}

      {/* First load only: a short placeholder, so the panel does not appear
          from nothing and shove the rest of the form down. */}
      {!result && !error && (
        <p className="text-xs text-text-muted">Checking eligibility…</p>
      )}

      {result && (
        // Dimmed while refreshing — the content stays put, so nothing jumps.
        <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span
              data-testid="loan-eligibility-verdict"
              data-eligible={result.eligible}
              className={
                result.eligible ? 'text-status-success' : 'text-status-error'
              }
            >
              {result.eligible ? 'Eligible' : 'Not eligible'}
            </span>
            <span className="text-text-muted">
              Monthly pay {formatCurrency(result.monthlyNet)}
            </span>
            {result.existingEmis > 0 && (
              <span className="text-text-muted">
                Existing instalments {formatCurrency(result.existingEmis)}
              </span>
            )}
          </div>

          <ul className="space-y-1">
            {result.checks.map((c) => (
              <li
                key={c.code}
                data-testid={`loan-eligibility-check-${c.code}`}
                data-code={c.code}
                data-status={c.status}
                className="flex items-start gap-2 text-xs"
              >
                {ICON[c.status]}
                <span className={TEXT[c.status]}>
                  {c.label}
                  {c.detail ? ` — ${c.detail}` : ''}
                  {!c.detail && c.limit != null && c.actual != null
                    ? ` (limit ${c.limit}, actual ${c.actual})`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
