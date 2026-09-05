'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronRight, Plus, Receipt } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import RunStatusBadge, { RUN_STATUSES, runStatusLabel } from '@/components/payroll/RunStatusBadge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { usePayrollRuns } from '@/hooks/usePayrollRuns';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { PayrollRunListQuery, PayrollRunStatus } from '@/types/payroll';

const PAGE_SIZE = 20;

function isRunStatus(value: string | null): value is PayrollRunStatus {
  return value !== null && (RUN_STATUSES as string[]).includes(value);
}

function PayrollRunsList() {
  const role = useAuthStore((state) => state.user?.role);
  const searchParams = useSearchParams();

  // The hub's queue lines link in here already narrowed, so the initial filter
  // comes off the URL rather than from a fresh default the reader then has to
  // reapply.
  const initialStatus = searchParams.get('status');

  const [status, setStatus] = useState<PayrollRunStatus | ''>(
    isRunStatus(initialStatus) ? initialStatus : '',
  );
  const [year, setYear] = useState('');
  const [page, setPage] = useState(1);

  // Narrowing resets the page in the same handler. Left to an effect, the
  // reader sees page 4 of a shorter result — an empty table that reads as "no
  // runs" — before it corrects itself.
  const narrow = (next: () => void) => {
    next();
    setPage(1);
  };

  const query = useMemo<PayrollRunListQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      ...(status ? { status } : {}),
      ...(year ? { year: Number(year) } : {}),
    }),
    [page, status, year],
  );

  const { data, isLoading, isError } = usePayrollRuns(query);
  const runs = data?.data ?? [];
  const total = data?.meta?.total;

  usePageHeader(
    'Payroll runs',
    total === undefined ? undefined : `${total} run${total === 1 ? '' : 's'}`,
  );

  // The surrounding years, so a late run and next January's are both reachable
  // without the list becoming a scroll of its own.
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 7 }, (_, index) => thisYear - 5 + index).reverse();

  const filtered = Boolean(status) || Boolean(year);

  return (
    <div className="space-y-5">
      {hasPermission(role, 'MANAGE_PAYROLL') && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link href="/dashboard/payroll/runs/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              New run
            </Button>
          </Link>
        </div>
      )}

      <Card className="flex flex-wrap items-end gap-4 p-4">
        <div className="w-full sm:w-48">
          <Select
            label="Status"
            placeholder="Any status"
            value={status}
            onChange={(event) =>
              narrow(() => setStatus(event.target.value as PayrollRunStatus | ''))
            }
          >
            {RUN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {runStatusLabel(value)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-40">
          <Select
            label="Year"
            placeholder="Any year"
            value={year}
            onChange={(event) => narrow(() => setYear(event.target.value))}
          >
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>
        <p className="ms-auto pb-2 text-xs text-text-muted">
          Showing {runs.length}
          {total === undefined ? '' : ` of ${total}`}
        </p>
      </Card>

      {isLoading && <Card className="p-6 text-sm text-text-muted">Loading runs…</Card>}

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          Could not load payroll runs. Is the API running?
        </Card>
      )}

      {!isLoading && !isError && runs.length === 0 && (
        <Card>
          <EmptyState
            icon={<Receipt className="h-6 w-6" aria-hidden />}
            title={filtered ? 'No matches' : 'No runs yet'}
            description={
              filtered
                ? 'Nothing matches that filter. Try another status or year.'
                : 'Open a run for a period and see what the pre-flight refuses.'
            }
          />
        </Card>
      )}

      {runs.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-surface-border bg-surface-page">
                <tr>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-text-heading">
                    Period
                  </th>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-text-heading">
                    Status
                  </th>
                  <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                    Employees
                  </th>
                  <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                    Gross
                  </th>
                  <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                    Net
                  </th>
                  <th className="w-10 px-4 py-3" aria-hidden />
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    data-testid="payroll-run-list-row"
                    data-status={run.status}
                    className="transition-colors hover:bg-surface-page"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/payroll/runs/${run.id}`}
                        className="text-sm font-semibold text-text-heading transition-colors hover:text-brand-primary"
                      >
                        {/* Date-only values. An instant parse would move the
                            1st into the previous month west of Greenwich and
                            rename the whole run. */}
                        {formatDateOnly(run.periodStart)} – {formatDateOnly(run.periodEnd)}
                      </Link>
                      {run.rejectionReason && (
                        <p className="mt-0.5 text-xs text-status-error">
                          Sent back: {run.rejectionReason}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="px-4 py-3 text-end text-sm tabular-nums text-text-body">
                      {run.employeeCount}
                    </td>
                    <td className="px-4 py-3 text-end text-sm tabular-nums text-text-body">
                      {formatCurrency(run.totalGross, run.currency)}
                    </td>
                    <td className="px-4 py-3 text-end text-sm font-semibold tabular-nums text-text-heading">
                      {formatCurrency(run.totalNet, run.currency)}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Link
                        href={`/dashboard/payroll/runs/${run.id}`}
                        aria-label={`Open the run starting ${formatDateOnly(run.periodStart)}`}
                        className="inline-flex text-text-muted transition-colors hover:text-brand-primary"
                      >
                        <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination meta={data?.meta} onPageChange={setPage} />
        </Card>
      )}
    </div>
  );
}

export default function PayrollRunsPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      {/* `useSearchParams` suspends during the prerender pass, and without a
          boundary that failure is the whole route rather than one filter. */}
      <Suspense fallback={<Card className="p-6 text-sm text-text-muted">Loading runs…</Card>}>
        <PayrollRunsList />
      </Suspense>
    </ProtectedRoute>
  );
}
