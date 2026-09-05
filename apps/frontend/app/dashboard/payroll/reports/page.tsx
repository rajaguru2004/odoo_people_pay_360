'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { BarChart3, Download } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ComponentTypeBadge from '@/components/payroll/ComponentTypeBadge';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { useEmployees } from '@/hooks/useEmployees';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useEmployeeYtd,
  useExportPayrollRun,
  usePayrollCost,
  usePayrollRegister,
  usePayrollRuns,
  usePayrollStatutory,
} from '@/hooks/usePayrollRuns';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, formatPercent, fullName } from '@/utils/formatters';
import type {
  Money,
  PayrollCostGroupBy,
  PayrollCostReport,
  PayrollCostRow,
  PayrollRegisterReport,
  PayrollRegisterRow,
  PayrollReportRun,
  PayrollRunStatus,
  SalaryComponentType,
  StatutoryComponentRow,
  StatutoryReport,
  YtdPeriodRow,
  YtdReport,
} from '@/types/payroll';

/**
 * The payroll reports.
 *
 * Every route under `/payroll/reports` reads APPROVED and PAID runs ONLY. A
 * draft is a working figure that is still being corrected, and a register
 * printed off one would be a document stating numbers the company has not
 * agreed to pay. The run picker therefore offers nothing else — and when the
 * server refuses a run anyway, its sentence is shown rather than swallowed into
 * a generic "no data", because "this run is not approved yet" and "this run
 * paid nobody" are different facts.
 */

// ── The wire ─────────────────────────────────────────────────────────────────
//
// These are aliases, not a second set of shapes: `types/payroll.ts` was
// transcribed from `payroll-reports.service.ts` and checked against live
// responses, so the declared type IS the wire. The aliases are kept because the
// accessors below read through them, and one name per report reads better here
// than four imports repeated at every call site.
//
// The rows are flat — `name`, `department`, `branch` as strings rather than
// nested refs — because a report is a table. Currency lives on `run`, not at
// the top level: it is the run's currency, and a second copy is a second thing
// that can disagree.

type RunHeaderWire = PayrollReportRun;
type RegisterRowWire = PayrollRegisterRow;
type RegisterWire = PayrollRegisterReport;
type CostRowWire = PayrollCostRow;
type CostWire = PayrollCostReport;
type StatutoryRowWire = StatutoryComponentRow;
type StatutoryWire = StatutoryReport;
type YtdPeriodWire = YtdPeriodRow;
type YtdWire = YtdReport;

/** Read a report body as the shape the controller actually sends. */
function wire<T>(value: unknown): T | undefined {
  return (value ?? undefined) as T | undefined;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = 'register' | 'cost' | 'statutory' | 'ytd';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'register', label: 'Register' },
  { id: 'cost', label: 'Cost' },
  { id: 'statutory', label: 'Statutory' },
  { id: 'ytd', label: 'Employee YTD' },
];

/**
 * Per-tab empty states.
 *
 * An empty Statutory means nothing was withheld; an empty Register means the
 * run generated no payslips at all. One shared "no data" makes two different
 * facts indistinguishable.
 */
const EMPTY: Record<Tab, string> = {
  register: 'This run has no payslips, so nobody was paid from it.',
  cost: 'This run has no payslips, so there is no cost to attribute.',
  statutory: 'Nothing was withheld and nothing was contributed on this run.',
  ytd: 'No approved or paid run falls in this year for this employee.',
};

const LOCKED: PayrollRunStatus[] = ['APPROVED', 'PAID'];

/** The label the server already formatted, with a date range as the fallback. */
function runLabel(run: {
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
}): string {
  return `${formatDateOnly(run.periodStart)} – ${formatDateOnly(run.periodEnd)} · ${run.status}`;
}

function PayrollReports() {
  const [tab, setTab] = useState<Tab>('register');
  const [runId, setRunId] = useState('');
  const [groupBy, setGroupBy] = useState<PayrollCostGroupBy>('department');
  const [employeeId, setEmployeeId] = useState('');
  const [year, setYear] = useState(new Date().getUTCFullYear());

  usePageHeader(
    'Payroll reports',
    'Approved and paid runs only — a draft has not paid anybody.',
  );

  // Two requests rather than one unfiltered page: the list endpoint takes a
  // single status, and offering a DRAFT here would be offering a run every
  // report route answers 400 to.
  const approved = usePayrollRuns({ status: 'APPROVED', limit: 100 });
  const paid = usePayrollRuns({ status: 'PAID', limit: 100 });

  const runs = useMemo(() => {
    const rows = [...(approved.data?.data ?? []), ...(paid.data?.data ?? [])];
    return rows
      .filter((run) => LOCKED.includes(run.status))
      .sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  }, [approved.data, paid.data]);

  const selectedRun = runs.find((run) => run.id === runId);
  const people = useEmployees({ limit: 200, sortBy: 'firstName', sortOrder: 'asc' });

  // Each hook is gated on its own tab, so switching tabs asks for one report
  // rather than keeping four in flight against the same run.
  const register = usePayrollRegister(tab === 'register' ? runId || undefined : undefined);
  const cost = usePayrollCost(tab === 'cost' ? runId || undefined : undefined, groupBy);
  const statutory = usePayrollStatutory(tab === 'statutory' ? runId || undefined : undefined);
  const ytd = useEmployeeYtd(tab === 'ytd' ? employeeId || undefined : undefined, year);

  const exportRun = useExportPayrollRun();

  const handleExport = async () => {
    if (!runId) return;
    try {
      // `responseType: 'blob'` is the ONE case the response interceptor hands
      // back untouched, so there is no `{ success, data }` envelope here: the
      // file is `response.data` and the server's filename is in the headers.
      const response = await exportRun.mutateAsync(runId);
      const disposition = String(response.headers?.['content-disposition'] ?? '');
      const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
      const filename = match ? decodeURIComponent(match[1]) : `payroll-run-${runId}.xlsx`;

      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The spreadsheet could not be written'));
    }
  };

  const yearOptions = useMemo(() => {
    const current = new Date().getUTCFullYear();
    return [current, current - 1, current - 2, current - 3, current - 4];
  }, []);

  const needsRun = tab !== 'ytd';
  const runsLoading = approved.isLoading || paid.isLoading;

  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <Select
              label="Payroll run"
              placeholder={runsLoading ? 'Loading runs…' : 'Choose an approved or paid run'}
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
            >
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {runLabel(run)}
                </option>
              ))}
            </Select>
          </div>

          {tab === 'cost' && (
            <Select
              label="Group by"
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as PayrollCostGroupBy)}
            >
              <option value="department">Department</option>
              <option value="branch">Branch</option>
            </Select>
          )}

          {tab === 'ytd' && (
            <>
              <Select
                label="Employee"
                placeholder="Choose an employee"
                value={employeeId}
                onChange={(event) => setEmployeeId(event.target.value)}
              >
                {(people.data?.data ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {fullName(person)} — {person.employeeCode}
                  </option>
                ))}
              </Select>
              <Select
                label="Year"
                value={String(year)}
                onChange={(event) => setYear(Number(event.target.value))}
              >
                {yearOptions.map((option) => (
                  <option key={option} value={String(option)}>
                    {option}
                  </option>
                ))}
              </Select>
            </>
          )}

          <div className="flex items-end">
            <Button
              variant="outline"
              className="w-full"
              disabled={!runId}
              isLoading={exportRun.isPending}
              onClick={() => void handleExport()}
            >
              <Download className="h-4 w-4" aria-hidden />
              Excel
            </Button>
          </div>
        </div>

        {!runsLoading && runs.length === 0 && (
          <p className="border-t border-surface-border-light pt-3 text-sm text-text-muted">
            No run has been approved yet. Reports read approved and paid runs only,
            because a draft is a working figure that is still being corrected.
          </p>
        )}

        {selectedRun && (
          <p className="flex flex-wrap items-center gap-2 border-t border-surface-border-light pt-3 text-sm text-text-muted">
            <Badge tone={selectedRun.status === 'PAID' ? 'success' : 'info'}>
              {selectedRun.status}
            </Badge>
            {/* Date-only columns — `formatDateOnly`, never an instant parse. */}
            <span>
              {formatDateOnly(selectedRun.periodStart)} –{' '}
              {formatDateOnly(selectedRun.periodEnd)}
            </span>
            <span>
              ·{' '}
              <span className="tabular-nums text-text-body">
                {selectedRun.employeeCount}
              </span>{' '}
              on the run
            </span>
          </p>
        )}
      </Card>

      <Card className="flex flex-wrap gap-1 p-1">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-testid={`report-tab-${entry.id}`}
            onClick={() => setTab(entry.id)}
            className={
              tab === entry.id
                ? 'rounded-[var(--radius-button)] bg-brand-primary px-3 py-2 text-sm font-medium text-text-on-brand'
                : 'rounded-[var(--radius-button)] px-3 py-2 text-sm font-medium text-text-muted hover:bg-surface-border-light'
            }
          >
            {entry.label}
          </button>
        ))}
      </Card>

      {needsRun && !runId && (
        <Card>
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
            <BarChart3 className="h-6 w-6 text-text-muted" aria-hidden />
            <p className="text-sm text-text-muted">
              Choose a payroll run above to read this report.
            </p>
          </div>
        </Card>
      )}

      {tab === 'ytd' && !employeeId && (
        <Card>
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
            <BarChart3 className="h-6 w-6 text-text-muted" aria-hidden />
            <p className="text-sm text-text-muted">
              Choose an employee above to read their year to date.
            </p>
          </div>
        </Card>
      )}

      {tab === 'register' && runId && (
        <ReportShell
          isLoading={register.isLoading}
          error={register.error}
          tab="register"
          isEmpty={(wire<RegisterWire>(register.data)?.rows.length ?? 0) === 0}
        >
          <RegisterTable report={wire<RegisterWire>(register.data)!} />
        </ReportShell>
      )}

      {tab === 'cost' && runId && (
        <ReportShell
          isLoading={cost.isLoading}
          error={cost.error}
          tab="cost"
          isEmpty={(wire<CostWire>(cost.data)?.rows.length ?? 0) === 0}
        >
          <CostTable report={wire<CostWire>(cost.data)!} />
        </ReportShell>
      )}

      {tab === 'statutory' && runId && (
        <ReportShell
          isLoading={statutory.isLoading}
          error={statutory.error}
          tab="statutory"
          isEmpty={
            (wire<StatutoryWire>(statutory.data)?.deductions.length ?? 0) === 0 &&
            (wire<StatutoryWire>(statutory.data)?.employerContributions.length ?? 0) === 0
          }
        >
          <StatutoryTables report={wire<StatutoryWire>(statutory.data)!} />
        </ReportShell>
      )}

      {tab === 'ytd' && employeeId && (
        <ReportShell
          isLoading={ytd.isLoading}
          error={ytd.error}
          tab="ytd"
          isEmpty={ytdPeriods(wire<YtdWire>(ytd.data)).length === 0}
        >
          <YtdTables report={wire<YtdWire>(ytd.data)!} />
        </ReportShell>
      )}
    </div>
  );
}

/** Loading, the server's refusal, the empty state, or the report. */
function ReportShell({
  isLoading,
  error,
  tab,
  isEmpty,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  tab: Tab;
  isEmpty: boolean;
  children: ReactNode;
}) {
  if (isLoading) {
    return <Card className="p-8 text-center text-sm text-text-muted">Loading the report…</Card>;
  }

  if (error) {
    return (
      // A 400 naming an unapproved run is not an empty result and must not be
      // shown as one. The interceptor rejects with a FLAT object, so the whole
      // sentence is on `message`.
      <Card className="p-8 text-center text-sm text-status-error" data-testid="report-failed">
        {apiErrorMessage(error, 'Could not load this report')}
      </Card>
    );
  }

  if (isEmpty) {
    return (
      <Card className="p-8 text-center text-sm text-text-muted" data-testid="report-empty">
        {EMPTY[tab]}
      </Card>
    );
  }

  return <Card className="overflow-x-auto">{children}</Card>;
}

// ── Register ─────────────────────────────────────────────────────────────────

function rowName(row: RegisterRowWire): string {
  return row.name;
}

function rowCode(row: RegisterRowWire): string {
  return row.employeeCode || '—';
}

function RegisterTable({ report }: { report: RegisterWire }) {
  // The currency is the RUN's. There is no second copy to disagree with it.
  const currency = report.run.currency;

  return (
    <table className="w-full min-w-[1000px] text-sm" data-testid="report-register">
      <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
        <tr>
          <th scope="col" className="px-5 py-3 text-start font-medium">Employee</th>
          <th scope="col" className="px-5 py-3 text-start font-medium">Department</th>
          <th scope="col" className="px-5 py-3 text-end font-medium">Worked / paid</th>
          <th scope="col" className="px-5 py-3 text-end font-medium">Gross</th>
          <th scope="col" className="px-5 py-3 text-end font-medium">Deductions</th>
          <th scope="col" className="px-5 py-3 text-end font-medium">Net</th>
          <th scope="col" className="px-5 py-3 text-end font-medium">Employer cost</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-surface-border-light">
        {report.rows.map((row) => (
          <tr key={row.payslipId} className="hover:bg-surface-border-light/60">
            <td className="px-5 py-3">
              <p className="text-text-body">{rowName(row)}</p>
              <p className="text-xs text-text-muted">
                {rowCode(row)} · {row.payslipNumber}
              </p>
            </td>
            <td className="px-5 py-3 text-text-body">
              {row.department ?? '—'}
            </td>
            <td className="px-5 py-3 text-end tabular-nums text-text-body">
              {row.paidDays} / {row.workDays}
              {row.lopDays > 0 && (
                <span className="ms-2 text-xs text-status-warning">
                  {row.lopDays} LOP
                </span>
              )}
            </td>
            <td className="px-5 py-3 text-end tabular-nums text-text-body">
              {formatCurrency(row.gross, currency)}
            </td>
            <td className="px-5 py-3 text-end tabular-nums text-status-error">
              {formatCurrency(row.deductions, currency)}
            </td>
            <td className="px-5 py-3 text-end font-semibold tabular-nums text-text-body">
              {formatCurrency(row.net, currency)}
            </td>
            {/* Recorded and never paid: outside gross, outside deductions and
                outside net. Reported beside them, never inside them. */}
            <td className="px-5 py-3 text-end tabular-nums text-text-muted">
              {formatCurrency(row.employerCost, currency)}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot className="border-t border-surface-border-light bg-surface-border-light/40 font-semibold">
        <tr>
          <td className="px-5 py-3 text-text-body" colSpan={3}>
            {report.count ?? report.rows.length} payslip
            {(report.count ?? report.rows.length) === 1 ? '' : 's'}
          </td>
          <td className="px-5 py-3 text-end tabular-nums">
            {formatCurrency(report.totals.gross, currency)}
          </td>
          <td className="px-5 py-3 text-end tabular-nums">
            {formatCurrency(report.totals.deductions, currency)}
          </td>
          <td className="px-5 py-3 text-end tabular-nums">
            {formatCurrency(report.totals.net, currency)}
          </td>
          <td className="px-5 py-3 text-end tabular-nums">
            {formatCurrency(report.totals.employerCost, currency)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

// ── Cost ─────────────────────────────────────────────────────────────────────

function CostTable({ report }: { report: CostWire }) {
  const currency = report.run.currency;

  return (
    <table className="w-full min-w-[900px] text-sm" data-testid="report-cost">
      <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
        <tr>
          <th scope="col" className="px-5 py-3 text-start font-medium">
            {report.groupBy === 'branch' ? 'Branch' : 'Department'}
          </th>
          <th scope="col" className="px-5 py-3 text-end font-medium">People</th>
          <th scope="col" className="px-5 py-3 text-end font-medium">Gross</th>
          <th scope="col" className="px-5 py-3 text-end font-medium">Net</th>
          <th scope="col" className="px-5 py-3 text-end font-medium">Employer cost</th>
          <th scope="col" className="px-5 py-3 text-end font-medium">Total cost</th>
          <th scope="col" className="px-5 py-3 text-end font-medium">Share</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-surface-border-light">
        {report.rows.map((row, index) => (
          // The group id is the key; the index is only a fallback for the
          // "unassigned" bucket, whose id is legitimately null.
          <tr key={row.id ?? `unassigned-${index}`} className="hover:bg-surface-border-light/60">
            <td className="px-5 py-3 text-text-body">{row.name}</td>
            <td className="px-5 py-3 text-end tabular-nums text-text-body">
              {row.employees}
            </td>
            <td className="px-5 py-3 text-end tabular-nums text-text-body">
              {formatCurrency(row.gross, currency)}
            </td>
            <td className="px-5 py-3 text-end tabular-nums text-text-body">
              {formatCurrency(row.net, currency)}
            </td>
            <td className="px-5 py-3 text-end tabular-nums text-text-muted">
              {formatCurrency(row.employerCost, currency)}
            </td>
            <td className="px-5 py-3 text-end font-semibold tabular-nums text-text-body">
              {formatCurrency(row.totalCost, currency)}
            </td>
            {/* A share is null, never 0, when there was nothing to divide by —
                an em dash, because 0.0% would be a different claim. */}
            <td className="px-5 py-3 text-end tabular-nums text-text-body">
              {formatPercent(row.share)}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot className="border-t border-surface-border-light bg-surface-border-light/40 font-semibold">
        <tr>
          <td className="px-5 py-3 text-text-body" colSpan={2}>
            Whole run
          </td>
          <td className="px-5 py-3 text-end tabular-nums">
            {formatCurrency(report.totals.gross, currency)}
          </td>
          <td className="px-5 py-3 text-end tabular-nums">
            {formatCurrency(report.totals.net, currency)}
          </td>
          <td className="px-5 py-3 text-end tabular-nums">
            {formatCurrency(report.totals.employerCost, currency)}
          </td>
          <td className="px-5 py-3 text-end tabular-nums">
            {report.totals.totalCost === undefined
              ? '—'
              : formatCurrency(report.totals.totalCost, currency)}
          </td>
          <td className="px-5 py-3" />
        </tr>
      </tfoot>
    </table>
  );
}

// ── Statutory ────────────────────────────────────────────────────────────────

function StatutoryTables({ report }: { report: StatutoryWire }) {
  const currency = report.run.currency;

  return (
    <div className="divide-y divide-surface-border-light" data-testid="report-statutory">
      <StatutorySection
        title="Withheld from pay"
        note="Money that left the employee's pay."
        rows={report.deductions}
        total={report.totals.deductions}
        currency={currency}
      />
      <StatutorySection
        title="Employer contributions"
        note="Recorded and never paid to the employee — it never entered their pay."
        rows={report.employerContributions}
        total={report.totals.employerContributions}
        currency={currency}
      />
    </div>
  );
}

function StatutorySection({
  title,
  note,
  rows,
  total,
  currency,
}: {
  title: string;
  note: string;
  rows: StatutoryRowWire[];
  total: Money;
  currency: string;
}) {
  return (
    <section className="p-5">
      <h3 className="text-sm font-semibold text-text-heading">{title}</h3>
      <p className="mt-0.5 text-sm text-text-muted">{note}</p>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-text-muted">Nothing on this run.</p>
      ) : (
        <table className="mt-4 w-full min-w-[560px] text-sm">
          <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th scope="col" className="py-2 pe-4 text-start font-medium">Code</th>
              <th scope="col" className="py-2 pe-4 text-start font-medium">Line</th>
              <th scope="col" className="py-2 pe-4 text-start font-medium">Type</th>
              <th scope="col" className="py-2 pe-4 text-end font-medium">Payslips</th>
              <th scope="col" className="py-2 text-end font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border-light">
            {rows.map((row) => (
              <tr key={`${row.type}-${row.code}`}>
                <td className="py-2 pe-4 font-mono text-text-body">{row.code}</td>
                {/* The label the payslip PRINTED, not the catalogue's current
                    name: a component renamed since must still report as it was
                    paid. */}
                <td className="py-2 pe-4 text-text-body">{row.label}</td>
                <td className="py-2 pe-4">
                  <ComponentTypeBadge type={row.type} short />
                </td>
                <td className="py-2 pe-4 text-end tabular-nums text-text-body">
                  {row.employees}
                </td>
                <td className="py-2 text-end tabular-nums text-text-body">
                  {formatCurrency(row.amount, currency)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-surface-border-light font-semibold">
            <tr>
              <td className="py-2 pe-4 text-text-body" colSpan={4}>
                Total
              </td>
              <td className="py-2 text-end tabular-nums text-text-body">
                {formatCurrency(total, currency)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </section>
  );
}

// ── Employee year to date ────────────────────────────────────────────────────

function ytdPeriods(report: YtdWire | undefined): YtdPeriodWire[] {
  return report?.periods ?? [];
}

function YtdTables({ report }: { report: YtdWire }) {
  const currency = report.currency;
  const periods = ytdPeriods(report);
  const components = report.byComponent;
  const name = report.employee.name;

  return (
    <div className="divide-y divide-surface-border-light" data-testid="report-ytd">
      <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Employee" text={name} />
        <Figure label="Gross" text={formatCurrency(report.totals.gross, currency)} />
        <Figure label="Net" text={formatCurrency(report.totals.net, currency)} />
        <Figure
          label="Periods paid"
          text={String(report.periodsPaid ?? periods.length)}
        />
      </div>

      <section className="p-5">
        <h3 className="text-sm font-semibold text-text-heading">Month by month</h3>
        <table className="mt-4 w-full min-w-[640px] text-sm">
          <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th scope="col" className="py-2 pe-4 text-start font-medium">Period</th>
              <th scope="col" className="py-2 pe-4 text-end font-medium">Gross</th>
              <th scope="col" className="py-2 pe-4 text-end font-medium">Deductions</th>
              <th scope="col" className="py-2 pe-4 text-end font-medium">Net</th>
              <th scope="col" className="py-2 text-end font-medium">Employer cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border-light">
            {periods.map((period) => (
              <tr key={period.periodStart}>
                {/* `Aug 2026` arrives formatted — the server owns every bucket
                    label, so the browser does no calendar maths. */}
                <td className="py-2 pe-4 text-text-body">
                  {period.label ?? formatDateOnly(period.periodStart)}
                </td>
                <td className="py-2 pe-4 text-end tabular-nums text-text-body">
                  {formatCurrency(period.gross, currency)}
                </td>
                <td className="py-2 pe-4 text-end tabular-nums text-status-error">
                  {formatCurrency(period.deductions, currency)}
                </td>
                <td className="py-2 pe-4 text-end font-semibold tabular-nums text-text-body">
                  {formatCurrency(period.net, currency)}
                </td>
                <td className="py-2 text-end tabular-nums text-text-muted">
                  {formatCurrency(period.employerCost, currency)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-surface-border-light font-semibold">
            <tr>
              <td className="py-2 pe-4 text-text-body">{report.year}</td>
              <td className="py-2 pe-4 text-end tabular-nums">
                {formatCurrency(report.totals.gross, currency)}
              </td>
              <td className="py-2 pe-4 text-end tabular-nums">
                {formatCurrency(report.totals.deductions, currency)}
              </td>
              <td className="py-2 pe-4 text-end tabular-nums">
                {formatCurrency(report.totals.net, currency)}
              </td>
              <td className="py-2 text-end tabular-nums">
                {formatCurrency(report.totals.employerCost, currency)}
              </td>
            </tr>
          </tfoot>
        </table>
      </section>

      {components.length > 0 && (
        <section className="p-5">
          <h3 className="text-sm font-semibold text-text-heading">By component</h3>
          <table className="mt-4 w-full min-w-[520px] text-sm">
            <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th scope="col" className="py-2 pe-4 text-start font-medium">Code</th>
                <th scope="col" className="py-2 pe-4 text-start font-medium">Line</th>
                <th scope="col" className="py-2 pe-4 text-start font-medium">Type</th>
                <th scope="col" className="py-2 text-end font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border-light">
              {components.map((row) => (
                <tr key={`${row.type}-${row.code}`}>
                  <td className="py-2 pe-4 font-mono text-text-body">{row.code}</td>
                  <td className="py-2 pe-4 text-text-body">{row.label}</td>
                  <td className="py-2 pe-4">
                    <ComponentTypeBadge type={row.type} short />
                  </td>
                  <td className="py-2 text-end tabular-nums text-text-body">
                    {formatCurrency(row.amount, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Figure({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-1 break-words text-lg font-semibold text-text-heading">{text}</p>
    </div>
  );
}

export default function PayrollReportsPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      <PayrollReports />
    </ProtectedRoute>
  );
}
