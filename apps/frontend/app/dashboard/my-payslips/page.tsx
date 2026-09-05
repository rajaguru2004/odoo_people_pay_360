'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ReceiptText } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import RunStatusBadge from '@/components/payroll/RunStatusBadge';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { Card } from '@/components/ui/Card';
import { useMyPayslips } from '@/hooks/usePayslips';
import { usePageHeader } from '@/hooks/usePageHeader';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency } from '@/utils/formatters';
import type { PayrollRunStatus } from '@/types/payroll';
import type { Payslip } from '@/types/payslip';

const PAGE_SIZE = 12;

/**
 * The run the payslip endpoints decorate onto every row they answer with.
 *
 * `periodLabel` arrives ALREADY WORDED from the server (`payslips.service.ts`
 * formats it), and `periodStart` / `periodEnd` arrive as day keys. Neither is
 * re-derived here: a browser that recomputed "Aug 2026" from an instant would
 * rename the whole run for anyone west of Greenwich.
 */
/** The flat object the axios interceptor rejects with carries the status. */
function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | null)?.statusCode;
}

function MyPayslipsList() {
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error } = useMyPayslips({ page, limit: PAGE_SIZE });

  // Already newest first: the server orders by `payrollRun.periodStart` desc,
  // which is also the only ordering that survives pagination. Re-sorting the
  // page here would sort twelve rows out of a longer set.
  const payslips = (data?.data ?? []) as Payslip[];
  const total = data?.meta?.total;

  usePageHeader(
    'My payslips',
    total === undefined ? undefined : `${total} payslip${total === 1 ? '' : 's'}`,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading your payslips…</Card>;
  }

  if (isError) {
    // An account with no employee record behind it is answered with a 403 and a
    // sentence saying so. That sentence is the whole explanation, so it is shown
    // instead of a generic failure — `err.message` via `apiErrorMessage`, never
    // `err.response.data.message`, which is not on this rejection.
    const notLinked = statusOf(error) === 403;
    return (
      <Card>
        <EmptyState
          icon={<ReceiptText className="h-6 w-6" aria-hidden />}
          title={notLinked ? 'No payslips for this account' : 'Could not load your payslips'}
          description={apiErrorMessage(
            error,
            'Your payslips could not be loaded. Is the API running?',
          )}
        />
      </Card>
    );
  }

  if (payslips.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<ReceiptText className="h-6 w-6" aria-hidden />}
          title="No payslips yet"
          // Nothing has gone wrong. `/payslips/my` answers only APPROVED and
          // PAID runs, so a month still being calculated legitimately shows
          // nothing here — saying "no records found" would read as a fault.
          description="A payslip appears here once the payroll run covering it has been approved. Runs still being calculated are not shown."
        />
      </Card>
    );
  }

  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th scope="col" className="px-5 py-3 text-start font-medium">Period</th>
              <th scope="col" className="px-5 py-3 text-start font-medium">Payslip</th>
              <th scope="col" className="px-5 py-3 text-start font-medium">Days paid</th>
              <th scope="col" className="px-5 py-3 text-start font-medium">Net pay</th>
              <th scope="col" className="px-5 py-3 text-start font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border-light">
            {payslips.map((payslip) => {
              const run = payslip.payrollRun;

              return (
                <tr key={payslip.id} className="hover:bg-surface-border-light/60">
                  <td className="px-5 py-3">
                    <Link
                      href={`/dashboard/my-payslips/${payslip.id}`}
                      className="font-medium text-brand-primary hover:underline"
                    >
                      {run?.periodLabel ?? '—'}
                    </Link>
                    {run && (
                      <span className="mt-0.5 block text-xs text-text-muted">
                        {formatDateOnly(run.periodStart)} – {formatDateOnly(run.periodEnd)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-text-body">
                    {payslip.payslipNumber}
                  </td>
                  <td className="px-5 py-3 tabular-nums text-text-body">
                    {payslip.paidDays}
                    <span className="text-text-muted">/{payslip.workDays}</span>
                  </td>
                  {/* The decimal STRING the API sent, formatted with the RUN's
                      currency. Two decimals on an OMR figure would round 125.500
                      to 125.50 — a payslip that rounds does not reconcile. */}
                  <td className="px-5 py-3 font-semibold tabular-nums text-text-heading">
                    {formatCurrency(payslip.netPay, run?.currency)}
                  </td>
                  <td className="px-5 py-3">
                    {run ? <RunStatusBadge status={run.status} /> : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination meta={data?.meta} onPageChange={setPage} />
    </Card>
  );
}

export default function MyPayslipsPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_OWN_PAYSLIP">
      <MyPayslipsList />
    </ProtectedRoute>
  );
}
