'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Banknote,
  CalendarRange,
  Download,
  Receipt,
  TrendingDown,
  Wallet,
  X,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import { useMyPayslip, useMyPayslips, useYtdSummary } from '@/hooks/usePayslips';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import {
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  amountOf,
  deductionShare,
  groupLines,
  payslipYears,
  periodLabel,
  shortMonth,
} from '@/components/payroll/payslipFormat';
import { formatCurrency } from '@/utils/formatters';
import { formatDateOnly } from '@/utils/formatDate';
import { apiErrorMessage } from '@/utils/apiError';
import { datedStem, exportWorkbook } from '@/utils/exportSheet';
import type { Payslip, PayslipLine, PayslipSummary } from '@/types/payroll';

/** One block of the breakdown — earnings, deductions or employer cost. */
function LineGroup({
  title,
  lines,
  currency,
  note,
}: {
  title: string;
  lines: PayslipLine[];
  currency: string;
  note?: string;
}) {
  if (lines.length === 0) return null;

  const total = lines.reduce((sum, line) => sum + amountOf(line.amount), 0);

  return (
    <div className="rounded-[var(--radius-card)] border border-surface-border-light">
      <div className="border-b border-surface-border-light px-4 py-2.5">
        <h4 className="text-sm font-semibold text-text-heading">{title}</h4>
        {note && <p className="mt-0.5 text-xs text-text-muted">{note}</p>}
      </div>
      <dl className="divide-y divide-surface-border-light">
        {lines.map((line) => (
          <div key={line.id} className="flex justify-between gap-4 px-4 py-2.5">
            <dt className="text-sm text-text-body">{line.label}</dt>
            <dd className="text-sm font-medium tabular-nums text-text-heading">
              {formatCurrency(line.amount, currency)}
            </dd>
          </div>
        ))}
        <div className="flex justify-between gap-4 bg-surface-page px-4 py-2.5">
          <dt className="text-sm font-semibold text-text-heading">Total</dt>
          <dd className="text-sm font-semibold tabular-nums text-text-heading">
            {formatCurrency(total, currency)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** The full payslip, opened from a row in the list. */
function PayslipDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, isError, error } = useMyPayslip(id);
  const payslip = data?.data;

  const download = async (slip: Payslip) => {
    try {
      const { earnings, deductions, employerContributions } = groupLines(slip.lines);
      await exportWorkbook(
        datedStem(`payslip-${slip.year}-${String(slip.month).padStart(2, '0')}`),
        [
          {
            name: 'Payslip',
            rows: [
              ...earnings.map((line) => ({
                Section: 'Earning',
                Item: line.label,
                Amount: amountOf(line.amount),
                Currency: slip.currency,
              })),
              ...deductions.map((line) => ({
                Section: 'Deduction',
                Item: line.label,
                Amount: amountOf(line.amount),
                Currency: slip.currency,
              })),
              ...employerContributions.map((line) => ({
                Section: 'Employer contribution',
                Item: line.label,
                Amount: amountOf(line.amount),
                Currency: slip.currency,
              })),
              {
                Section: 'Summary',
                Item: 'Net pay',
                Amount: amountOf(slip.netPay),
                Currency: slip.currency,
              },
            ],
          },
        ],
      );
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The download failed'));
    }
  };

  const grouped = payslip ? groupLines(payslip.lines) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Payslip"
    >
      <Card className="my-8 w-full max-w-2xl">
        <CardHeader
          title={payslip ? periodLabel(payslip.month, payslip.year) : 'Payslip'}
          subtitle={
            payslip
              ? `${formatDateOnly(payslip.periodStart)} – ${formatDateOnly(payslip.periodEnd)}`
              : undefined
          }
          action={
            <button
              type="button"
              onClick={onClose}
              aria-label="Close payslip"
              className="rounded-[var(--radius-button)] p-1 text-text-muted hover:bg-surface-border-light"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          }
        />
        <CardBody className="space-y-4">
          {isLoading && <p className="text-sm text-text-muted">Loading the payslip…</p>}
          {isError && (
            <p className="text-sm text-status-error">
              {apiErrorMessage(error, 'Could not open this payslip.')}
            </p>
          )}

          {payslip && grouped && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-text-muted">{payslip.employee?.fullName}</p>
                  <p className="text-xs text-text-muted">
                    {payslip.employee?.employeeCode}
                    {payslip.employee?.department
                      ? ` · ${payslip.employee.department.name}`
                      : ''}
                  </p>
                </div>
                <Badge tone={RUN_STATUS_TONE[payslip.status]}>
                  {RUN_STATUS_LABEL[payslip.status]}
                </Badge>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-[var(--radius-card)] bg-surface-page p-3">
                  <p className="text-xs text-text-muted">Gross</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-text-heading">
                    {formatCurrency(payslip.grossPay, payslip.currency)}
                  </p>
                </div>
                <div className="rounded-[var(--radius-card)] bg-surface-page p-3">
                  <p className="text-xs text-text-muted">Deductions</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-status-warning">
                    {formatCurrency(payslip.totalDeductions, payslip.currency)}
                  </p>
                </div>
                <div className="rounded-[var(--radius-card)] bg-brand-primary/10 p-3">
                  <p className="text-xs text-text-muted">Net pay</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-brand-primary">
                    {formatCurrency(payslip.netPay, payslip.currency)}
                  </p>
                </div>
              </div>

              <LineGroup
                title="Earnings"
                lines={grouped.earnings}
                currency={payslip.currency}
              />
              <LineGroup
                title="Deductions"
                lines={grouped.deductions}
                currency={payslip.currency}
              />
              <LineGroup
                title="Paid on your behalf"
                lines={grouped.employerContributions}
                currency={payslip.currency}
                // Said plainly, because the figure looks like income and is not.
                note="Your employer's contributions. Not part of your gross or net pay."
              />

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={onClose}>
                  Close
                </Button>
                <Button variant="outline" onClick={() => void download(payslip)}>
                  <Download className="h-4 w-4" aria-hidden />
                  Download
                </Button>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * The year's net pay, month by month.
 *
 * Fixed-width columns rather than flexible ones. A person with a single paid
 * run would otherwise get one bar stretched across the whole panel, which reads
 * as a full year of earnings rather than as the one month it is.
 */
function YearBars({
  months,
  currency,
}: {
  months: Array<{ month: number; net: number }>;
  currency: string;
}) {
  const peak = Math.max(...months.map((m) => m.net), 1);

  return (
    <div className="flex items-end gap-3 overflow-x-auto pb-1">
      {months.map((entry) => (
        <div key={entry.month} className="flex w-20 shrink-0 flex-col items-center gap-1">
          <span className="text-[10px] tabular-nums text-text-muted">
            {formatCurrency(entry.net, currency)}
          </span>
          <div
            className="w-10 rounded-t-[var(--radius-badge)] bg-brand-primary"
            style={{ height: `${Math.max(4, (entry.net / peak) * 96)}px` }}
            aria-hidden
          />
          <span className="text-[11px] text-text-muted">{shortMonth(entry.month)}</span>
        </div>
      ))}
    </div>
  );
}

function MyPayslips() {
  const user = useAuthStore((s) => s.user);
  const hasEmployeeRecord = Boolean(user?.employeeId ?? user?.employee?.id);

  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useMyPayslips(year);
  const ytd = useYtdSummary(year);

  const rows: PayslipSummary[] = useMemo(() => list.data?.data ?? [], [list.data]);
  const summary = ytd.data?.data;
  const currency = rows[0]?.currency ?? summary?.currency ?? 'OMR';
  const latest = rows[0];

  const years = useMemo(() => payslipYears(rows, thisYear), [rows, thisYear]);

  usePageHeader(
    'My payslips',
    rows.length
      ? `${rows.length} payslip${rows.length === 1 ? '' : 's'} in ${year}`
      : `Nothing recorded for ${year}`,
  );

  if (!hasEmployeeRecord) {
    return (
      <Card>
        <EmptyState
          icon={<Wallet className="h-6 w-6" aria-hidden />}
          title="This account is not attached to an employee record"
          description="Payslips belong to a person on the payroll. An operator account has none, which is why this screen is empty rather than broken."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-40">
          <Select
            label="Year"
            value={String(year)}
            onChange={(event) => setYear(Number(event.target.value))}
          >
            {years.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Paid so far"
          value={formatCurrency(summary?.totalNet ?? 0, currency)}
          hint={`Net, across ${summary?.monthsCount ?? 0} paid run${
            summary?.monthsCount === 1 ? '' : 's'
          }`}
          icon={<Banknote className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Gross so far"
          value={formatCurrency(summary?.totalGross ?? 0, currency)}
          hint={`${year} to date`}
          icon={<TrendingDown className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Deducted so far"
          value={formatCurrency(summary?.totalDeductions ?? 0, currency)}
          hint={
            deductionShare(summary?.totalGross, summary?.totalDeductions) === null
              ? 'Nothing has been paid yet'
              : `${deductionShare(summary?.totalGross, summary?.totalDeductions)}% of gross`
          }
          icon={<Receipt className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Latest payslip"
          value={latest ? formatCurrency(latest.netPay, latest.currency) : '—'}
          hint={latest ? periodLabel(latest.month, latest.year) : 'None yet'}
          icon={<CalendarRange className="h-5 w-5" aria-hidden />}
        />
      </div>

      {summary && summary.monthlyBreakdown.length > 0 && (
        <Card>
          <CardHeader
            title="Net pay by month"
            subtitle="Paid runs only — a run that has been approved but not yet paid is not money that has moved."
          />
          <CardBody>
            <YearBars months={summary.monthlyBreakdown} currency={currency} />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Payslips"
          subtitle="A run still being prepared is not listed. Those figures move until payroll closes them."
        />

        {list.isLoading && (
          <p className="p-6 text-sm text-text-muted">Loading your payslips…</p>
        )}

        {list.isError && (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(list.error, 'Could not load your payslips.')}
          </p>
        )}

        {!list.isLoading && !list.isError && rows.length === 0 && (
          <EmptyState
            icon={<Wallet className="h-6 w-6" aria-hidden />}
            title={`No payslips in ${year}`}
            description="They appear here as soon as a payroll run for the period is approved."
          />
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Period</th>
                  <th className="px-5 py-3 text-end font-medium">Gross</th>
                  <th className="px-5 py-3 text-end font-medium">Deductions</th>
                  <th className="px-5 py-3 text-end font-medium">Net pay</th>
                  <th className="px-5 py-3 text-start font-medium">Status</th>
                  <th className="px-5 py-3 text-end font-medium">Payslip</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-border-light/60">
                    <td className="px-5 py-3">
                      <p className="font-medium text-text-heading">
                        {periodLabel(row.month, row.year)}
                      </p>
                      <p className="text-xs text-text-muted">
                        {formatDateOnly(row.periodStart)} – {formatDateOnly(row.periodEnd)}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-end tabular-nums text-text-body">
                      {formatCurrency(row.grossPay, row.currency)}
                    </td>
                    <td className="px-5 py-3 text-end tabular-nums text-status-warning">
                      {formatCurrency(row.totalDeductions, row.currency)}
                    </td>
                    <td className="px-5 py-3 text-end font-semibold tabular-nums text-text-heading">
                      {formatCurrency(row.netPay, row.currency)}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={RUN_STATUS_TONE[row.status]}>
                        {RUN_STATUS_LABEL[row.status]}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-end">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setOpenId(row.id)}
                        aria-label={`Open the payslip for ${periodLabel(row.month, row.year)}`}
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openId && <PayslipDialog id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

export default function PayrollPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_OWN_PAYSLIP">
      <MyPayslips />
    </ProtectedRoute>
  );
}
