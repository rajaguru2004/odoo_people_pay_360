'use client';

import { useEffect, useState } from 'react';
import { PiggyBank } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePayrollFeatures } from '@/hooks/usePayrollFeatures';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  gratuityService,
  type GratuityEntitlement,
} from '@/services/payrollExtensionsService';
import { formatCurrency } from '@/utils/formatters';

/**
 * "What would I get if I left today?"
 *
 * HR is asked this constantly, the answer is read-only, and nothing about
 * showing somebody their own entitlement carries risk. It is the cheapest useful
 * thing end-of-service benefits make possible.
 */
function MyGratuityContent() {
  const features = usePayrollFeatures();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'My end-of-service benefit',
    'What you would receive if your employment ended today.',
  );

  const [data, setData] = useState<GratuityEntitlement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!features.eosb) {
      setLoading(false);
      return;
    }
    gratuityService
      .myEntitlement()
      .then((r) => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [features.eosb]);

  if (!features.eosb) {
    return (
      <div className="rounded-xl border border-surface-border bg-surface-card p-8 text-center" data-testid="ess-gratuity">
        <PiggyBank size={28} className="mx-auto mb-3 text-text-muted" />
        <h2 className="text-base font-semibold text-text-heading">
          End-of-service benefits are not switched on
        </h2>
      </div>
    );
  }

  if (loading) {
    return <div className="p-8 text-center text-sm text-text-muted" data-testid="ess-gratuity">Loading…</div>;
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-surface-border bg-surface-card p-8 text-center text-sm text-text-muted" data-testid="ess-gratuity">
        No entitlement could be calculated for you.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="ess-gratuity">
      <div className="rounded-xl border border-surface-border bg-surface-card p-5">
        {data.refusal ? (
          <div className="rounded-lg bg-status-warning-bg/40 p-4 text-sm text-status-warning">
            {data.refusal}
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-surface-page p-4">
                <p className="text-xs uppercase tracking-wide text-text-muted">Service</p>
                <p className="text-xl font-semibold text-text-heading">
                  {data.serviceYears.toFixed(2)} years
                </p>
              </div>
              <div className="rounded-lg bg-status-success-bg/40 p-4">
                <p className="text-xs uppercase tracking-wide text-status-success">
                  If you left today
                </p>
                <p
                  data-testid="my-gratuity-amount"
                  className="text-xl font-semibold text-status-success"
                >
                  {formatCurrency(data.amount)}
                </p>
              </div>
              <div className="rounded-lg bg-surface-page p-4">
                <p className="text-xs uppercase tracking-wide text-text-muted">Set aside</p>
                <p className="text-xl font-semibold text-text-heading">
                  {formatCurrency(data.provisioned)}
                </p>
                <p className="mt-1 text-[11px] text-text-muted">
                  What your employer has provisioned so far.
                </p>
              </div>
            </div>

            {data.workingLines.length > 0 && (
              <details className="mt-5">
                <summary className="cursor-pointer text-sm font-medium text-text-body">
                  How this is worked out
                </summary>
                <ul className="mt-2 space-y-1 font-mono text-xs text-text-muted">
                  {data.workingLines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function MyGratuityPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_DASHBOARD">
      <MyGratuityContent />
    </ProtectedRoute>
  );
}
