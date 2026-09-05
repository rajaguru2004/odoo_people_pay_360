'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Landmark, Printer } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PayslipLines, { linesOfType } from '@/components/payroll/PayslipLines';
import RunStatusBadge from '@/components/payroll/RunStatusBadge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePayrollRun } from '@/hooks/usePayrollRuns';
import { usePayslip } from '@/hooks/usePayslips';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBrandingStore } from '@/store/brandingStore';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, fullName } from '@/utils/formatters';
import { payslipTotals, toAmount } from '@/utils/payrollTotals';

/**
 * The printed sheet.
 *
 * Scoped to this route rather than added to the global stylesheet: the dashboard
 * shell is `h-dvh overflow-hidden` with only `<main>` scrolling, which prints as
 * one clipped viewport. Everything is hidden and the payslip alone is made
 * visible and laid out from the top of the page, so no rule here depends on a
 * class inside the shell — a chrome component renamed tomorrow cannot silently
 * put the sidebar back on the paper.
 *
 * No PDF dependency. The browser's own print dialogue already writes one.
 */
const PRINT_CSS = `
@media print {
  html, body {
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }
  body * { visibility: hidden !important; }
  #payslip-sheet, #payslip-sheet * { visibility: visible !important; }
  #payslip-sheet {
    position: absolute !important;
    top: 0 !important;
    inset-inline-start: 0 !important;
    width: 100% !important;
    padding: 0 !important;
    box-shadow: none !important;
  }
  [data-print-hide] { display: none !important; }
  #payslip-sheet .surface-panel,
  #payslip-sheet [data-print-card] {
    border-color: #cbd5e1 !important;
    break-inside: avoid;
  }
}
`;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-body">{value}</dd>
    </div>
  );
}

function PayslipDetail({ id }: { id: string }) {
  const { data, isLoading, isError } = usePayslip(id);
  const slip = data?.data;

  // The run carries the CURRENCY and the period. A payslip has amounts and no
  // currency of its own, and an OMR figure printed at two decimals rounds every
  // line to the nearest 10 baisa.
  const run = usePayrollRun(slip?.payrollRunId);
  const fallbackCurrency = useBrandingStore((state) => state.branding.default_currency);
  const currency = run.data?.data.currency ?? fallbackCurrency ?? 'OMR';

  usePageHeader(
    slip ? `Payslip ${slip.payslipNumber}` : 'Payslip',
    slip ? fullName(slip.employee) : undefined,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading the payslip…</Card>;
  }

  if (isError || !slip) {
    return (
      <Card className="p-6 text-sm text-status-error">
        This payslip could not be loaded. It may belong to a run you cannot read.
      </Card>
    );
  }

  const earnings = linesOfType(slip.lines, 'EARNING');
  const deductions = linesOfType(slip.lines, 'DEDUCTION');
  const employerLines = linesOfType(slip.lines, 'EMPLOYER_CONTRIBUTION');

  const gross = toAmount(slip.grossPay);
  const deducted = toAmount(slip.totalDeductions);
  const net = toAmount(slip.netPay);
  const employerCost = toAmount(slip.totalEmployerCost);

  // The lines against the stored totals — the one place the two claims meet.
  const fromLines = payslipTotals(slip.lines);
  const drifts = slip.lines !== undefined && Math.abs(fromLines.net - net) >= 0.001;

  return (
    <>
      <style>{PRINT_CSS}</style>

      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3" data-print-hide>
          {run.data?.data && (
            <>
              <RunStatusBadge status={run.data.data.status} />
              <Link
                href={`/dashboard/payroll/runs/${slip.payrollRunId}`}
                className="text-sm font-semibold text-brand-primary hover:underline"
              >
                Open the run
              </Link>
            </>
          )}
          <div className="ms-auto">
            <Button variant="outline" onClick={() => window.print()} data-testid="payslip-print">
              <Printer className="h-4 w-4" aria-hidden />
              Print
            </Button>
          </div>
        </div>

        <div id="payslip-sheet" className="space-y-5">
          <Card data-print-card>
            <CardHeader
              title={`Payslip ${slip.payslipNumber}`}
              subtitle={
                run.data?.data
                  ? `${formatDateOnly(run.data.data.periodStart)} – ${formatDateOnly(
                      run.data.data.periodEnd,
                    )}`
                  : undefined
              }
            />
            <CardBody>
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Fact label="Employee" value={fullName(slip.employee)} />
                <Fact label="Employee code" value={slip.employee?.employeeCode ?? '—'} />
                <Fact label="Department" value={slip.employee?.department?.name ?? '—'} />
                <Fact label="Branch" value={slip.employee?.branch?.name ?? '—'} />
                <Fact label="Working days" value={String(slip.workDays)} />
                <Fact label="Paid days" value={String(slip.paidDays)} />
                <Fact
                  label="Unpaid days"
                  value={
                    slip.lopDays > 0
                      ? `${slip.lopDays} (priced as one LOP line)`
                      : 'None'
                  }
                />
                <Fact label="Currency" value={currency} />
              </dl>
            </CardBody>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card data-print-card>
              <CardHeader title="Earnings" subtitle="What the period paid, before anything came off." />
              <CardBody className="py-1">
                <PayslipLines
                  lines={earnings}
                  tone="success"
                  sign="plus"
                  currency={currency}
                  emptyLabel="No earning lines on this payslip."
                />
                <div className="flex items-center justify-between border-t border-surface-border pt-3 mt-2">
                  <span className="text-sm font-semibold text-text-heading">Gross pay</span>
                  <span className="text-sm font-bold tabular-nums text-status-success">
                    {formatCurrency(gross, currency)}
                  </span>
                </div>
              </CardBody>
            </Card>

            <Card data-print-card>
              <CardHeader title="Deductions" subtitle="Withheld from pay, loss of pay included." />
              <CardBody className="py-1">
                <PayslipLines
                  lines={deductions}
                  tone="error"
                  sign="minus"
                  currency={currency}
                  emptyLabel="Nothing was deducted."
                />
                <div className="mt-2 flex items-center justify-between border-t border-surface-border pt-3">
                  <span className="text-sm font-semibold text-text-heading">Total deductions</span>
                  <span className="text-sm font-bold tabular-nums text-status-error">
                    − {formatCurrency(deducted, currency)}
                  </span>
                </div>
              </CardBody>
            </Card>
          </div>

          <Card data-print-card className="bg-gradient-to-br from-brand-primary to-brand-primary-dark text-text-on-brand">
            <div className="flex flex-wrap items-center justify-between gap-4 p-5">
              <div>
                <p className="text-[13px] font-medium text-text-on-brand/85">Net pay</p>
                <p className="mt-1 text-[28px] font-extrabold leading-none tabular-nums">
                  {formatCurrency(net, currency)}
                </p>
              </div>
              <p className="max-w-sm text-[12px] leading-snug text-text-on-brand/85">
                {formatCurrency(gross, currency)} earned less{' '}
                {formatCurrency(deducted, currency)} deducted. Net floors at zero — deductions
                exceeding earnings is a data problem, never a negative wage.
              </p>
            </div>
          </Card>

          {/* Shown, and visibly apart from everything above it. This money is
              recorded and never paid to the employee: it is in none of the
              three totals on this sheet. */}
          <Card
            data-print-card
            data-testid="employer-contributions"
            className="border-dashed bg-surface-page"
          >
            <CardHeader
              title="Employer contributions"
              subtitle="Recorded, never paid to the employee — NOT part of gross, deductions or net pay."
            />
            <CardBody className="py-1">
              <PayslipLines
                lines={employerLines}
                tone="brand"
                sign="none"
                currency={currency}
                emptyLabel="None recorded for this period."
              />
              <div className="mt-2 flex items-center justify-between border-t border-surface-border pt-3">
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-text-heading">
                  <Landmark className="h-4 w-4 text-text-muted" aria-hidden />
                  Total company cost on top of pay
                </span>
                <span className="text-sm font-bold tabular-nums text-text-heading">
                  {formatCurrency(employerCost, currency)}
                </span>
              </div>
            </CardBody>
          </Card>

          {drifts && (
            <p className="text-sm text-status-error">
              The lines on this payslip add to {formatCurrency(fromLines.net, currency)}, which is
              not the net it records. Recalculate the run before issuing it.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

export default function PayslipDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      <PayslipDetail id={id} />
    </ProtectedRoute>
  );
}
