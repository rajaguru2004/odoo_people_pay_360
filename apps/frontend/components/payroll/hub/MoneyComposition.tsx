'use client';

import { AlertTriangle } from 'lucide-react';
import {
  MeterList,
  PanelHeader,
  PanelLink,
  type MeterRow,
} from '@/components/module-landing/primitives';
import { formatCurrency } from '@/utils/formatters';
import type { PayrollHubSummary } from '@/types/payrollHub';

/**
 * What the period's pay actually consisted of.
 *
 * APPROVED and PAID runs only, like every other money figure on this hub, so it
 * reconciles with the net card above it. Bars are scaled against the LARGEST
 * line rather than against gross: at company scale earnings dwarf everything,
 * and scaled against the total every other row becomes an invisible sliver.
 *
 * Employer contributions are drawn beside the other three and never inside
 * them. They are recorded and never paid — a bar that added them to gross would
 * claim the company had handed people its own cost.
 *
 * `residual` is printed rather than absorbed. Gross minus deductions is net,
 * always; a panel that quietly rounded a mismatch away would be the reason
 * nobody ever found out.
 */
export default function MoneyComposition({
  money,
  periodLabel,
  loading = false,
  failed = false,
}: {
  money?: PayrollHubSummary['money'];
  periodLabel?: string;
  loading?: boolean;
  failed?: boolean;
}) {
  const currency = money?.currency ?? 'OMR';

  const parts = money
    ? [
        {
          key: 'gross',
          label: 'Earnings',
          amount: money.gross,
          color: 'var(--color-brand-primary)',
          hint: 'Everything paid before deductions.',
        },
        {
          key: 'deductions',
          label: 'Deductions',
          amount: money.deductions,
          color: 'var(--color-status-warning)',
          hint: 'Withheld from pay, loss of pay included.',
        },
        {
          key: 'net',
          label: 'Net paid',
          amount: money.net,
          color: 'var(--color-status-success)',
          hint: 'What actually left the account.',
        },
        {
          key: 'employerCost',
          label: 'Employer contributions',
          amount: money.employerCost,
          color: 'var(--color-status-info)',
          hint: 'Recorded, never paid — outside all three above.',
        },
      ]
    : [];

  const largest = Math.max(1, ...parts.map((part) => part.amount));
  const rows: MeterRow[] = parts
    .filter((part) => part.amount > 0)
    .map((part) => ({
      key: part.key,
      label: part.label,
      percent: (part.amount / largest) * 100,
      valueLabel: formatCurrency(part.amount, currency),
      color: part.color,
      hint: part.hint,
    }));

  const residual = money ? money.gross - money.deductions - money.net : 0;

  return (
    <div className="surface-panel flex h-full flex-col justify-between rounded-[20px] p-6">
      <PanelHeader
        title="What the pay was made of"
        hint={
          periodLabel
            ? `Approved and paid runs for ${periodLabel}. A draft total is an intention, not a payroll.`
            : undefined
        }
        action={<PanelLink href="/dashboard/payroll/reports">See reports</PanelLink>}
      />

      {loading ? (
        <div className="mt-4 flex-1 space-y-3">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="h-4 w-full animate-pulse rounded bg-surface-page" />
          ))}
        </div>
      ) : failed || !money ? (
        <p className="grid flex-1 place-items-center text-[13px] text-text-muted">
          The composition could not be read.
        </p>
      ) : rows.length === 0 ? (
        // Not "the payroll was zero" — there is no approved run to describe.
        <p className="grid flex-1 place-items-center text-[13px] text-text-muted">
          Nothing has been approved for this period yet.
        </p>
      ) : (
        <div className="mt-3 flex flex-1 flex-col gap-4">
          <MeterList rows={rows} trackHeight={12} />

          {/* The totals the bars are shares of. Without them the panel shows the
              shape of the payroll and never its size, and the reader has to add
              four bars up to check it against the cards. */}
          <div className="grid grid-cols-3 gap-2 border-t border-surface-border pt-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Gross
              </p>
              <p className="text-[13px] font-bold tabular-nums text-text-heading">
                {formatCurrency(money.gross, currency)}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Deductions
              </p>
              <p className="text-[13px] font-bold tabular-nums text-status-warning">
                {formatCurrency(money.deductions, currency)}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Net
              </p>
              <p className="text-[13px] font-bold tabular-nums text-status-success">
                {formatCurrency(money.net, currency)}
              </p>
            </div>
          </div>

          {Math.abs(residual) >= 0.001 && (
            <p className="inline-flex items-start gap-1 text-[11px] leading-relaxed text-status-warning">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                Earnings less deductions is {formatCurrency(Math.abs(residual), currency)} away
                from the net. Check the register before reporting on it.
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
