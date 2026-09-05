'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronDown, ChevronRight, Info, Search } from 'lucide-react';
import { formatCurrency, fullName } from '@/utils/formatters';
import { payslipTotals, runTotals, toAmount } from '@/utils/payrollTotals';
import PayslipLines, { linesOfType } from './PayslipLines';
import type { Payslip } from '@/types/payslip';

/**
 * One payroll run's payslips.
 *
 * The shape is the one a payroll officer actually asks for, in the order they
 * ask it: **who, how many days, what it totalled, what came off, what they
 * get** — with every component line one click away in the row's own detail
 * panel rather than crushed into a 90px column. The four columns that survive
 * are the ones reconciled against the bank; everything else is breakdown, and
 * breakdown belongs under a disclosure.
 *
 * Two things this table must do:
 *
 *  - **A row that does not reconcile says so.** Earnings − deductions is net,
 *    always. A row where the stored net disagrees with its own two totals is a
 *    real defect and is flagged rather than rounded away.
 *  - **The footer and the cards above share one helper.** Both call
 *    `runTotals`, so the totals row cannot drift from the summary cards.
 */

export interface RowException {
  key: 'zeroNet' | 'residual' | 'lop' | 'noLines';
  label: string;
  severity: 'critical' | 'warning';
}

export interface RunRow {
  slip: Payslip;
  gross: number;
  deductions: number;
  net: number;
  employerCost: number;
  /** `gross − deductions − net`. Non-zero is a defect, not a rounding artefact. */
  residual: number;
  exceptions: RowException[];
}

/**
 * Per-row facts, from the STORED totals the server calculated.
 *
 * Not re-derived from the lines: those figures are what the payslip itself
 * prints and what the export carries, and a screen that recomputed them would
 * be quietly auditing the payroll rather than reporting it. The residual below
 * is the one place the two are compared, which is exactly what makes it worth
 * printing.
 */
export function buildRunRows(payslips: readonly Payslip[]): RunRow[] {
  return payslips.map((slip) => {
    const gross = toAmount(slip.grossPay);
    const deductions = toAmount(slip.totalDeductions);
    const net = toAmount(slip.netPay);
    const employerCost = toAmount(slip.totalEmployerCost);
    const residual = gross - deductions - net;

    const exceptions: RowException[] = [];
    if (net <= 0) {
      exceptions.push({ key: 'zeroNet', label: 'Nothing to pay', severity: 'critical' });
    }
    if (Math.abs(residual) >= 0.001) {
      exceptions.push({ key: 'residual', label: 'Does not reconcile', severity: 'critical' });
    }
    if (slip.lines && slip.lines.length === 0) {
      exceptions.push({ key: 'noLines', label: 'No lines', severity: 'critical' });
    }
    if (slip.lopDays > 0) {
      exceptions.push({
        key: 'lop',
        label: `${slip.lopDays} day${slip.lopDays === 1 ? '' : 's'} unpaid`,
        severity: 'warning',
      });
    }
    return { slip, gross, deductions, net, employerCost, residual, exceptions };
  });
}

function ExceptionChips({ exceptions }: { exceptions: RowException[] }) {
  if (exceptions.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {exceptions.map((exception) => (
        <span
          key={exception.key}
          data-testid="payroll-row-exception"
          data-exception={exception.key}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            exception.severity === 'critical'
              ? 'bg-status-error-bg text-status-error'
              : 'bg-status-warning-bg text-status-warning'
          }`}
        >
          <AlertTriangle size={10} aria-hidden />
          {exception.label}
        </span>
      ))}
    </span>
  );
}

export default function PayrollRunTable({
  payslips,
  currency,
}: {
  payslips: Payslip[];
  /** The run's currency, so every figure is formatted to ITS decimals. */
  currency: string;
}) {
  const [query, setQuery] = useState('');
  const [onlyExceptions, setOnlyExceptions] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rows = useMemo(() => buildRunRows(payslips), [payslips]);
  const withExceptions = rows.filter((row) => row.exceptions.length > 0).length;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (onlyExceptions && row.exceptions.length === 0) return false;
      if (!needle) return true;
      const employee = row.slip.employee;
      return (
        fullName(employee).toLowerCase().includes(needle) ||
        (employee?.employeeCode ?? '').toLowerCase().includes(needle) ||
        row.slip.payslipNumber.toLowerCase().includes(needle)
      );
    });
  }, [rows, query, onlyExceptions]);

  // The same helper the summary cards call, over the rows actually on screen.
  const shownTotals = useMemo(
    () => runTotals(visible.map((row) => row.slip)),
    [visible],
  );

  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-surface-border bg-surface-card">
      {/* Toolbar — a run at a real headcount is unusable without one */}
      <div className="flex flex-wrap items-center gap-3 border-b border-surface-border bg-surface-page px-4 py-3">
        <div className="relative min-w-[180px] max-w-xs flex-1">
          <Search
            size={15}
            aria-hidden
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            data-testid="payroll-run-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, code or payslip number"
            aria-label="Search payslips"
            className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card py-2 pe-3 ps-9 text-sm text-text-body"
          />
        </div>

        <button
          type="button"
          data-testid="payroll-run-only-exceptions"
          aria-pressed={onlyExceptions}
          onClick={() => setOnlyExceptions((value) => !value)}
          disabled={withExceptions === 0}
          className={`inline-flex items-center gap-1.5 rounded-[var(--radius-button)] border px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            onlyExceptions
              ? 'border-status-error/40 bg-status-error-bg text-status-error'
              : 'border-surface-border bg-surface-card text-text-body hover:bg-surface-page'
          }`}
        >
          <AlertTriangle size={13} aria-hidden />
          Only exceptions ({withExceptions})
        </button>

        <span className="ms-auto text-xs text-text-muted">
          Showing {visible.length} of {rows.length}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-surface-border bg-surface-page">
            <tr>
              <th className="w-8 px-2 py-3" aria-hidden />
              <th className="px-4 py-3 text-start text-xs font-semibold text-text-heading">
                Employee
              </th>
              <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                <span className="inline-flex items-center gap-1">
                  Days paid
                  <span className="group/th relative">
                    <Info size={12} className="cursor-help text-text-muted" aria-hidden />
                    <span className="pointer-events-none absolute end-0 top-full z-30 mt-1 w-56 whitespace-normal rounded-lg bg-gray-900 p-2 text-xs font-normal leading-relaxed text-white opacity-0 shadow-xl transition-opacity group-hover/th:opacity-100">
                      Paid days against the working days in the period. The
                      difference is priced as one LOP deduction line.
                    </span>
                  </span>
                </span>
              </th>
              <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                Total earnings
              </th>
              <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                Total deductions
              </th>
              <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                Net pay
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-surface-border">
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-text-muted">
                  {rows.length === 0
                    ? 'This run has no payslips yet. Calculate it to build them.'
                    : 'Nothing matches that search.'}
                </td>
              </tr>
            )}

            {visible.map((row) => {
              const slip = row.slip;
              const isOpen = expanded.has(slip.id);
              const lineTotals = payslipTotals(slip.lines);

              return (
                // A keyed Fragment: the row and its detail row are siblings in
                // <tbody>, and React needs the key on the outermost node.
                <Fragment key={slip.id}>
                  <tr
                    data-testid="payroll-run-row"
                    data-payslip-id={slip.id}
                    data-exceptions={row.exceptions.length}
                    onClick={() => toggle(slip.id)}
                    className="cursor-pointer transition-colors hover:bg-surface-page"
                  >
                    <td className="px-2 py-3 text-center align-top">
                      <span className="inline-flex text-text-muted">
                        {isOpen ? (
                          <ChevronDown size={16} aria-hidden />
                        ) : (
                          <ChevronRight size={16} aria-hidden className="rtl:rotate-180" />
                        )}
                      </span>
                    </td>

                    <td className="px-4 py-3 align-top">
                      <Link
                        href={`/dashboard/payroll/payslips/${slip.id}`}
                        onClick={(event) => event.stopPropagation()}
                        className="text-sm font-semibold text-text-heading transition-colors hover:text-brand-primary"
                      >
                        {fullName(slip.employee)}
                      </Link>
                      <p className="text-xs text-text-muted">
                        {slip.employee?.employeeCode ?? '—'} · {slip.payslipNumber}
                      </p>
                      <div className="mt-1">
                        <ExceptionChips exceptions={row.exceptions} />
                      </div>
                    </td>

                    <td className="px-4 py-3 text-end align-top text-sm tabular-nums text-text-body">
                      {slip.paidDays}/{slip.workDays}
                    </td>

                    <td className="px-4 py-3 text-end align-top text-sm font-semibold tabular-nums text-status-success">
                      {formatCurrency(row.gross, currency)}
                    </td>

                    <td className="px-4 py-3 text-end align-top text-sm font-semibold tabular-nums text-status-error">
                      {row.deductions > 0 ? '− ' : ''}
                      {formatCurrency(row.deductions, currency)}
                    </td>

                    <td className="px-4 py-3 text-end align-top">
                      <span className="font-bold tabular-nums text-text-heading">
                        {formatCurrency(row.net, currency)}
                      </span>
                    </td>
                  </tr>

                  {isOpen && (
                    <tr className="bg-surface-page/60">
                      <td colSpan={6} className="px-4 pb-5 pt-1">
                        {!slip.lines ? (
                          <p className="py-3 text-sm text-text-muted">
                            The lines are not on this response.{' '}
                            <Link
                              href={`/dashboard/payroll/payslips/${slip.id}`}
                              className="font-semibold text-brand-primary hover:underline"
                            >
                              Open the payslip
                            </Link>{' '}
                            to read them.
                          </p>
                        ) : (
                          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                            <div>
                              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                                Earnings
                              </p>
                              <div className="rounded-[var(--radius-card)] border border-surface-border bg-surface-card/60 px-3 py-1">
                                <PayslipLines
                                  lines={linesOfType(slip.lines, 'EARNING')}
                                  tone="success"
                                  sign="plus"
                                  currency={currency}
                                  emptyLabel="No earning lines."
                                />
                              </div>
                            </div>

                            <div>
                              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                                Deductions
                              </p>
                              <div className="rounded-[var(--radius-card)] border border-surface-border bg-surface-card/60 px-3 py-1">
                                <PayslipLines
                                  lines={linesOfType(slip.lines, 'DEDUCTION')}
                                  tone="error"
                                  sign="minus"
                                  currency={currency}
                                  emptyLabel="Nothing was deducted."
                                />
                              </div>
                            </div>

                            <div className="space-y-3">
                              <div>
                                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                                  Reconciliation
                                </p>
                                <div className="space-y-1 rounded-[var(--radius-card)] border border-surface-border bg-surface-card/60 px-3 py-2 text-[12px]">
                                  <div className="flex justify-between">
                                    <span className="text-text-body">Earnings</span>
                                    <span className="font-semibold tabular-nums text-status-success">
                                      {formatCurrency(row.gross, currency)}
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-text-body">Deductions</span>
                                    <span className="font-semibold tabular-nums text-status-error">
                                      − {formatCurrency(row.deductions, currency)}
                                    </span>
                                  </div>
                                  <div className="flex justify-between border-t border-surface-border pt-1">
                                    <span className="font-semibold text-text-heading">Net pay</span>
                                    <span className="font-bold tabular-nums text-text-heading">
                                      {formatCurrency(row.net, currency)}
                                    </span>
                                  </div>
                                  {Math.abs(row.residual) >= 0.001 && (
                                    <p className="flex items-start gap-1 pt-1 text-[11px] text-status-error">
                                      <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden />
                                      Earnings less deductions is{' '}
                                      {formatCurrency(Math.abs(row.residual), currency)} away from
                                      the stored net.
                                    </p>
                                  )}
                                  {/* The lines against the stored totals. They
                                      are two different claims and this is the
                                      only screen that puts them side by side. */}
                                  {Math.abs(lineTotals.net - row.net) >= 0.001 && (
                                    <p className="flex items-start gap-1 pt-1 text-[11px] text-status-error">
                                      <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden />
                                      The lines add to{' '}
                                      {formatCurrency(lineTotals.net, currency)}, not to the stored
                                      net.
                                    </p>
                                  )}
                                </div>
                              </div>

                              <div>
                                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                                  Employer contributions
                                </p>
                                {/* Kept apart from both columns above, and said
                                    so: this money is recorded and never paid. */}
                                <div className="rounded-[var(--radius-card)] border border-surface-border bg-surface-card/60 px-3 py-1">
                                  <PayslipLines
                                    lines={linesOfType(slip.lines, 'EMPLOYER_CONTRIBUTION')}
                                    tone="brand"
                                    sign="none"
                                    currency={currency}
                                    emptyLabel="None recorded."
                                  />
                                </div>
                                <p className="mt-1 text-[11px] leading-snug text-text-muted">
                                  Outside gross, deductions and net —{' '}
                                  {formatCurrency(row.employerCost, currency)} in company cost.
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>

          {visible.length > 0 && (
            <tfoot className="border-t-2 border-surface-border bg-surface-page">
              <tr>
                <td />
                <td className="px-4 py-3 text-sm font-bold text-text-heading">
                  {visible.length} payslip{visible.length === 1 ? '' : 's'}
                </td>
                <td />
                <td className="px-4 py-3 text-end text-sm font-bold tabular-nums text-status-success">
                  {formatCurrency(shownTotals.gross, currency)}
                </td>
                <td className="px-4 py-3 text-end text-sm font-bold tabular-nums text-status-error">
                  − {formatCurrency(shownTotals.deductions, currency)}
                </td>
                <td className="px-4 py-3 text-end text-sm font-extrabold tabular-nums text-text-heading">
                  {formatCurrency(shownTotals.net, currency)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
