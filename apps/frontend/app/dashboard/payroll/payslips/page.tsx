'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronRight, FileText, Search } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import RunStatusBadge from '@/components/payroll/RunStatusBadge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { usePayrollRun } from '@/hooks/usePayrollRuns';
import { usePayslips } from '@/hooks/usePayslips';
import { useDebounce } from '@/hooks/useDebounce';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBrandingStore } from '@/store/brandingStore';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, fullName } from '@/utils/formatters';
import type { PayslipListQuery } from '@/types/payslip';

const PAGE_SIZE = 20;

/**
 * Every payslip produced, searchable by person or narrowed to one run.
 *
 * `runId` arrives on the URL from the run's summary cards, so a figure and the
 * rows behind it are one click apart. When it is set the run itself is read for
 * its CURRENCY — a payslip carries amounts and no currency of its own, and
 * printing an OMR figure at two decimals silently rounds every one of them.
 */
function PayslipsList() {
  const searchParams = useSearchParams();
  const runId = searchParams.get('runId') ?? undefined;

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search, 300);

  const query = useMemo<PayslipListQuery>(
    () => ({ page, limit: PAGE_SIZE, ...(runId ? { runId } : {}) }),
    [page, runId],
  );

  const { data, isLoading, isError } = usePayslips(query);
  const run = usePayrollRun(runId);
  const fallbackCurrency = useBrandingStore((state) => state.branding.default_currency);
  const currency = run.data?.data.currency ?? fallbackCurrency ?? 'OMR';

  // The endpoint takes no free-text search, so this narrows the PAGE that came
  // back. Hence the count below reads "shown" rather than claiming to be the
  // whole set.
  const rows = useMemo(() => {
    const all = data?.data ?? [];
    const needle = debouncedSearch.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (slip) =>
        fullName(slip.employee).toLowerCase().includes(needle) ||
        (slip.employee?.employeeCode ?? '').toLowerCase().includes(needle) ||
        slip.payslipNumber.toLowerCase().includes(needle),
    );
  }, [data, debouncedSearch]);

  const total = data?.meta?.total;

  usePageHeader(
    'Payslips',
    total === undefined ? undefined : `${total} payslip${total === 1 ? '' : 's'}`,
  );

  return (
    <div className="space-y-5">
      {runId && (
        <Card className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <span className="text-text-muted">Narrowed to one run:</span>
          {run.data?.data ? (
            <>
              <span className="font-semibold text-text-heading">
                {formatDateOnly(run.data.data.periodStart)} –{' '}
                {formatDateOnly(run.data.data.periodEnd)}
              </span>
              <RunStatusBadge status={run.data.data.status} />
              <Link
                href={`/dashboard/payroll/runs/${runId}`}
                className="text-xs font-semibold text-brand-primary hover:underline"
              >
                Open the run
              </Link>
            </>
          ) : (
            <span className="text-text-muted">loading the run…</span>
          )}
          <Link
            href="/dashboard/payroll/payslips"
            className="ms-auto text-xs font-semibold text-brand-primary hover:underline"
          >
            Clear
          </Link>
        </Card>
      )}

      <Card className="flex flex-wrap items-center gap-4 p-4">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search
            size={15}
            aria-hidden
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, code or payslip number"
            aria-label="Search payslips"
            className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card py-2 pe-3 ps-9 text-sm text-text-body"
          />
        </div>
        <p className="ms-auto text-xs text-text-muted">
          Showing {rows.length}
          {total === undefined ? '' : ` of ${total}`}
        </p>
      </Card>

      {isLoading && <Card className="p-6 text-sm text-text-muted">Loading payslips…</Card>}

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          Could not load payslips. Is the API running?
        </Card>
      )}

      {!isLoading && !isError && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<FileText className="h-6 w-6" aria-hidden />}
            title={debouncedSearch ? 'No matches' : 'No payslips yet'}
            description={
              debouncedSearch
                ? 'Nothing on this page matches that search.'
                : 'A payslip appears once a run has been calculated.'
            }
          />
        </Card>
      )}

      {rows.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-surface-border bg-surface-page">
                <tr>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-text-heading">
                    Employee
                  </th>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-text-heading">
                    Payslip
                  </th>
                  <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                    Days paid
                  </th>
                  <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                    Gross
                  </th>
                  <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                    Deductions
                  </th>
                  <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                    Net
                  </th>
                  <th className="w-10 px-4 py-3" aria-hidden />
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {rows.map((slip) => (
                  <tr
                    key={slip.id}
                    data-testid="payslip-list-row"
                    className="transition-colors hover:bg-surface-page"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/payroll/payslips/${slip.id}`}
                        className="text-sm font-semibold text-text-heading transition-colors hover:text-brand-primary"
                      >
                        {fullName(slip.employee)}
                      </Link>
                      <p className="text-xs text-text-muted">
                        {slip.employee?.employeeCode ?? '—'}
                        {slip.employee?.department?.name
                          ? ` · ${slip.employee.department.name}`
                          : ''}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-sm text-text-body">{slip.payslipNumber}</td>
                    <td className="px-4 py-3 text-end text-sm tabular-nums text-text-body">
                      {slip.paidDays}/{slip.workDays}
                    </td>
                    <td className="px-4 py-3 text-end text-sm tabular-nums text-status-success">
                      {formatCurrency(slip.grossPay, currency)}
                    </td>
                    <td className="px-4 py-3 text-end text-sm tabular-nums text-status-error">
                      {formatCurrency(slip.totalDeductions, currency)}
                    </td>
                    <td className="px-4 py-3 text-end text-sm font-semibold tabular-nums text-text-heading">
                      {formatCurrency(slip.netPay, currency)}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Link
                        href={`/dashboard/payroll/payslips/${slip.id}`}
                        aria-label={`Open payslip ${slip.payslipNumber}`}
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

export default function PayslipsPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      {/* `useSearchParams` suspends during the prerender pass, and without a
          boundary that failure is the whole route rather than one filter. */}
      <Suspense fallback={<Card className="p-6 text-sm text-text-muted">Loading payslips…</Card>}>
        <PayslipsList />
      </Suspense>
    </ProtectedRoute>
  );
}
