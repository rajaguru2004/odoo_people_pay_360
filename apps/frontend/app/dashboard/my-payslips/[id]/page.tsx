'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CalendarDays, Info, Printer, ReceiptText, TrendingDown, TrendingUp } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PayslipLines, { linesOfType } from '@/components/payroll/PayslipLines';
import RunStatusBadge from '@/components/payroll/RunStatusBadge';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { useMyPayslip } from '@/hooks/usePayslips';
import { usePageHeader } from '@/hooks/usePageHeader';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, fullName } from '@/utils/formatters';
import type { PayrollRunStatus } from '@/types/payroll';
import type { Payslip } from '@/types/payslip';

/**
 * The run the payslip endpoints decorate onto the row they answer with.
 *
 * `periodLabel` arrives ALREADY WORDED from the server, and the two dates are
 * day keys — so this page does no calendar maths at all, and renders the dates
 * through `formatDateOnly`, which does not zone-convert.
 */
/**
 * Paper.
 *
 * The dashboard shell is `h-dvh overflow-hidden` with only `<main>` scrolling,
 * so a browser asked to print it lays out exactly one screenful and drops the
 * rest of the payslip. Releasing the height and lifting the sheet out to the
 * page is what puts the whole thing on paper — and it is a plain `@media print`
 * block rather than a PDF library, because the browser already knows how to
 * paginate a document and a second renderer would only disagree with it.
 *
 * `inset-inline-start`, not `left`: a printed Arabic payslip has to flow from
 * the other edge without a second stylesheet.
 */
const PRINT_CSS = `
@media print {
  html, body {
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }
  body * { visibility: hidden !important; }
  .payslip-sheet, .payslip-sheet * { visibility: visible !important; }
  .payslip-sheet {
    position: absolute;
    top: 0;
    inset-inline-start: 0;
    width: 100%;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  /* Screen furniture: the way back, and the button that started the print. */
  .payslip-no-print { display: none !important; }
  @page { margin: 14mm; }
}
`;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-body">{children || '—'}</dd>
    </div>
  );
}

/** The flat object the axios interceptor rejects with carries the status. */
function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | null)?.statusCode;
}

function MyPayslipDetail({ id }: { id: string }) {
  const { data, isLoading, isError, error } = useMyPayslip(id);
  const payslip = data?.data as Payslip | undefined;
  const run = payslip?.payrollRun;

  usePageHeader(
    run?.periodLabel ?? 'Payslip',
    payslip ? payslip.payslipNumber : undefined,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading your payslip…</Card>;
  }

  if (isError || !payslip) {
    // Somebody else's id is answered 404, never 403 — a 403 would confirm the
    // id exists. So a 404 here is an ordinary "no such payslip", not a fault,
    // and is drawn as one rather than as a failure. A 403 is the separate case
    // of an account with no employee record behind it, and the server's
    // sentence explains it better than anything this page could word.
    const status = statusOf(error);
    const missing = status === 404;

    return (
      <Card>
        <EmptyState
          icon={<ReceiptText className="h-6 w-6" aria-hidden />}
          title={missing ? 'Payslip not found' : 'Could not load this payslip'}
          description={
            missing
              ? 'No payslip of yours has that reference. It may belong to somebody else, or its payroll run may not be approved yet.'
              : apiErrorMessage(error, 'This payslip could not be loaded.')
          }
          action={
            <Link href="/dashboard/my-payslips">
              <Button variant="outline">Back to my payslips</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  const currency = run?.currency;
  const earnings = linesOfType(payslip.lines, 'EARNING');
  const deductions = linesOfType(payslip.lines, 'DEDUCTION');
  const employerContributions = linesOfType(payslip.lines, 'EMPLOYER_CONTRIBUTION');

  return (
    <div className="space-y-5">
      {/* Scoped to this route: no other screen prints a payslip. */}
      <style>{PRINT_CSS}</style>

      <div className="payslip-no-print flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/dashboard/my-payslips"
          className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-text-body"
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
          My payslips
        </Link>

        {/* The browser's own print dialogue, which is also how it is saved as a
            PDF. No PDF dependency: a second renderer would paginate this
            differently from the page the reader is looking at. */}
        <Button variant="outline" onClick={() => window.print()}>
          <Printer className="h-4 w-4" aria-hidden />
          Print
        </Button>
      </div>

      <div className="payslip-sheet space-y-5" data-testid="my-payslip">
        {/* Net pay, first and largest: it is the figure the reader opened the
            page for. The stored column, not a sum of the lines below — the
            payslip's own totals are the authoritative money. */}
        <Card className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-text-muted">Net pay</p>
              <p
                data-testid="payslip-net"
                className="mt-1 text-4xl font-bold tabular-nums text-status-success"
              >
                {formatCurrency(payslip.netPay, currency)}
              </p>
              <p className="mt-2 text-sm text-text-body">
                {run?.periodLabel ?? '—'}
                {run && (
                  <span className="text-text-muted">
                    {' · '}
                    {formatDateOnly(run.periodStart)} – {formatDateOnly(run.periodEnd)}
                  </span>
                )}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              {run && <RunStatusBadge status={run.status} />}
              <span className="font-mono text-xs text-text-muted">{payslip.payslipNumber}</span>
            </div>
          </div>
        </Card>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="p-5">
            <div className="mb-2 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-button)] bg-status-success-bg text-status-success">
                <TrendingUp className="h-5 w-5" aria-hidden />
              </span>
              <p className="text-sm text-text-muted">Gross pay</p>
            </div>
            <p className="text-2xl font-bold tabular-nums text-status-success">
              {formatCurrency(payslip.grossPay, currency)}
            </p>
          </Card>

          <Card className="p-5">
            <div className="mb-2 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-button)] bg-status-error-bg text-status-error">
                <TrendingDown className="h-5 w-5" aria-hidden />
              </span>
              <p className="text-sm text-text-muted">Total deductions</p>
            </div>
            <p className="text-2xl font-bold tabular-nums text-status-error">
              {formatCurrency(payslip.totalDeductions, currency)}
            </p>
          </Card>

          <Card className="p-5">
            <div className="mb-2 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary/10 text-brand-primary">
                <CalendarDays className="h-5 w-5" aria-hidden />
              </span>
              <p className="text-sm text-text-muted">Days paid</p>
            </div>
            <p className="text-2xl font-bold tabular-nums text-brand-primary">
              {payslip.paidDays}
              <span className="text-text-muted">/{payslip.workDays}</span>
            </p>
          </Card>
        </div>

        <Card>
          <CardHeader title="Salary details" subtitle="What was earned, and what came off it." />
          <CardBody className="space-y-6">
            <section>
              <h4 className="mb-3 flex items-center gap-2 font-semibold text-status-success">
                <span className="h-5 w-1 rounded bg-status-success" aria-hidden />
                Earnings
              </h4>
              <PayslipLines
                lines={earnings}
                tone="success"
                currency={currency ?? 'OMR'}
                sign="plus"
                emptyLabel="No earning lines on this payslip."
              />
              <div className="mt-2 flex justify-between rounded-[var(--radius-button)] bg-status-success-bg/40 px-4 py-3 font-bold text-text-heading">
                <span>Gross pay</span>
                <span className="tabular-nums text-status-success">
                  {formatCurrency(payslip.grossPay, currency)}
                </span>
              </div>
            </section>

            <section>
              <h4 className="mb-3 flex items-center gap-2 font-semibold text-status-error">
                <span className="h-5 w-1 rounded bg-status-error" aria-hidden />
                Deductions
              </h4>
              <PayslipLines
                lines={deductions}
                tone="error"
                currency={currency ?? 'OMR'}
                sign="minus"
                emptyLabel="Nothing was deducted this period."
              />
              <div className="mt-2 flex justify-between rounded-[var(--radius-button)] bg-status-error-bg/40 px-4 py-3 font-bold text-text-heading">
                <span>Total deductions</span>
                <span className="tabular-nums text-status-error">
                  − {formatCurrency(payslip.totalDeductions, currency)}
                </span>
              </div>
            </section>

            <section>
              <div className="flex justify-between rounded-[var(--radius-button)] border border-brand-primary/30 bg-brand-primary/5 px-4 py-3 text-lg font-bold text-text-heading">
                <span>Net pay</span>
                <span className="tabular-nums text-brand-primary">
                  {formatCurrency(payslip.netPay, currency)}
                </span>
              </div>
            </section>
          </CardBody>
        </Card>

        {/* A SEPARATE card, not a third section of the one above.
            Employer contributions are recorded and never paid to the employee:
            outside gross, outside deductions and outside net. Printed among the
            earnings they read as money somebody was owed and did not receive,
            which is why the sentence below is not optional decoration. */}
        {employerContributions.length > 0 && (
          <Card data-testid="employer-contributions">
            <CardHeader
              title="Employer contributions"
              subtitle="Paid by the company on top of your pay."
            />
            <CardBody>
              <p className="mb-3 rounded-[var(--radius-button)] bg-status-info-bg/50 px-4 py-3 text-sm text-text-body">
                These are the employer&rsquo;s cost, not yours. They are{' '}
                <strong className="font-semibold">not</strong> part of your gross pay, not part of
                your deductions, and they do not change the net pay above.
              </p>
              <PayslipLines
                lines={employerContributions}
                tone="brand"
                currency={currency ?? 'OMR'}
                sign="none"
              />
              <div className="mt-2 flex justify-between rounded-[var(--radius-button)] bg-surface-border-light px-4 py-3 font-semibold text-text-heading">
                <span>Total employer cost</span>
                <span className="tabular-nums">
                  {formatCurrency(payslip.totalEmployerCost, currency)}
                </span>
              </div>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="This payslip" subtitle="Who it is for, and what it covers." />
          <CardBody>
            <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="Employee">{payslip.employee ? fullName(payslip.employee) : null}</Fact>
              <Fact label="Employee code">{payslip.employee?.employeeCode}</Fact>
              <Fact label="Department">{payslip.employee?.department?.name}</Fact>
              <Fact label="Branch">{payslip.employee?.branch?.name}</Fact>
              <Fact label="Payslip number">{payslip.payslipNumber}</Fact>
              <Fact label="Period">{run?.periodLabel}</Fact>
              <Fact label="Working days">{payslip.workDays}</Fact>
              <Fact label="Paid days">{payslip.paidDays}</Fact>
              <Fact label="Loss of pay days">{payslip.lopDays}</Fact>
            </dl>
          </CardBody>
        </Card>

        <div className="flex gap-3 rounded-[var(--radius-card)] border-s-4 border-brand-primary bg-brand-primary/5 p-4">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-brand-primary" aria-hidden />
          <div className="text-sm text-text-body">
            <p className="mb-2 font-semibold text-text-heading">Reading this payslip</p>
            <ul className="list-inside list-disc space-y-1">
              <li>Net pay = gross pay − total deductions.</li>
              <li>
                Paid days {payslip.paidDays} of {payslip.workDays} working days
                {payslip.lopDays > 0 ? `, with ${payslip.lopDays} priced as loss of pay.` : '.'}
              </li>
              <li>
                Only approved and paid runs appear here, so every figure above is settled.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MyPayslipPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    <ProtectedRoute requiredPermission="VIEW_OWN_PAYSLIP">
      <MyPayslipDetail id={id} />
    </ProtectedRoute>
  );
}
