'use client';

import Link from 'next/link';
import { AlertTriangle, Banknote, Landmark, Receipt, Users, Wallet } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { toAmount, type RunTotals } from '@/utils/payrollTotals';
import type { Money } from '@/types/payroll';

/**
 * The five figures somebody checks before a run is approved.
 *
 * Every one of them comes from `runTotals(payslips)` — the SAME call the table
 * below the cards reads — so a card can never disagree with the rows it is a
 * total of. A card summing the response while a row totals its own lines is how
 * a page ends up printing two different nets for one run, with nothing on screen
 * to say which of them is the payroll.
 *
 * Employer contributions get a card of their own rather than a place in any of
 * the other four. They are recorded and never paid: outside gross, outside
 * deductions, outside net. Folding them into gross would inflate what people
 * were paid by the company's own cost.
 */
export default function RunSummaryCards({
  totals,
  currency,
  storedGross,
  storedNet,
  runId,
}: {
  totals: RunTotals;
  /** The RUN's currency. `formatCurrency` takes its decimals from it. */
  currency: string;
  /** What the run itself claims — `totalGross` / `totalNet` on the record. */
  storedGross?: Money | null;
  storedNet?: Money | null;
  /** Makes the cards drill into the payslips they are a total of. */
  runId?: string;
}) {
  /**
   * The run's stored totals against the sum of its own payslips.
   *
   * Two numbers from two places: one stamped at calculation, one added up here.
   * When they disagree the export and this screen report different amounts for
   * the same run, and nothing else in the product compares them.
   */
  const netDrift = storedNet === null || storedNet === undefined
    ? 0
    : totals.net - toAmount(storedNet);
  const grossDrift = storedGross === null || storedGross === undefined
    ? 0
    : totals.gross - toAmount(storedGross);
  /**
   * Which total actually disagrees, not just by how much.
   *
   * The banner has to name the figure the difference is ABOUT. Reporting a
   * gross drift while quoting the stored net printed a number identical to the
   * one already on the card, with a difference that appeared to come from
   * nowhere — and printed `0.000` outright when the run carried a gross but no
   * net.
   */
  const drift =
    Math.abs(netDrift) >= 0.001
      ? { amount: netDrift, label: 'net', stored: toAmount(storedNet) }
      : { amount: grossDrift, label: 'gross', stored: toAmount(storedGross) };

  const payslipsHref = runId
    ? `/dashboard/payroll/payslips?runId=${runId}`
    : '/dashboard/payroll/payslips';

  const cards = [
    {
      key: 'employees',
      label: 'Payslips in this run',
      value: String(totals.employeeCount),
      icon: Users,
      tint: 'bg-brand-primary/10 text-brand-primary',
      sub:
        totals.employeeCount === 0
          ? 'Nothing has been calculated yet.'
          : 'One payslip per employee the run covered.',
      subTone: totals.employeeCount === 0 ? 'text-status-warning' : 'text-text-muted',
      href: payslipsHref,
    },
    {
      key: 'gross',
      label: 'Total earnings',
      value: formatCurrency(totals.gross, currency),
      icon: Wallet,
      tint: 'bg-status-success-bg text-status-success',
      sub: 'Every EARNING line, before anything comes off.',
      subTone: 'text-text-muted',
      href: payslipsHref,
    },
    {
      key: 'deductions',
      label: 'Total deductions',
      value: formatCurrency(totals.deductions, currency),
      icon: Receipt,
      tint: 'bg-status-error-bg text-status-error',
      sub: 'Withheld from pay, loss of pay included.',
      subTone: 'text-text-muted',
      href: payslipsHref,
    },
    {
      key: 'employerCost',
      label: 'Employer contributions',
      value: formatCurrency(totals.employerCost, currency),
      icon: Landmark,
      tint: 'bg-status-info-bg text-status-info',
      // Said on the card, not only in a tooltip: this is the one figure on the
      // row that is in none of the other three.
      sub: 'Recorded, never paid — outside gross, deductions and net.',
      subTone: 'text-text-muted',
      href: payslipsHref,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Link
            key={card.key}
            href={card.href}
            data-testid={`payroll-run-card-${card.key}`}
            className="group flex flex-col rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-5 transition-colors hover:border-brand-primary/50"
          >
            <div className="flex items-center gap-2.5">
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${card.tint}`}>
                <Icon size={17} strokeWidth={2.2} aria-hidden />
              </span>
              <span className="text-[13px] font-medium leading-snug text-text-body">
                {card.label}
              </span>
            </div>
            <p className="mt-3 text-[22px] font-extrabold leading-tight tabular-nums text-text-heading">
              {card.value}
            </p>
            <p className={`mt-auto pt-2 text-[11px] leading-snug ${card.subTone}`}>{card.sub}</p>
          </Link>
        );
      })}

      {/* Net stays last and loudest: it is the number that leaves the bank
          account, and the four cards before it are what it was worked out from. */}
      <div
        data-testid="payroll-run-card-net"
        className="flex flex-col rounded-[var(--radius-card)] bg-gradient-to-br from-brand-primary to-brand-primary-dark p-5 text-text-on-brand"
      >
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/15">
            <Banknote size={17} strokeWidth={2.2} aria-hidden />
          </span>
          <span className="text-[13px] font-medium leading-snug text-text-on-brand/85">
            Net pay
          </span>
        </div>
        <p className="mt-3 text-[22px] font-extrabold leading-tight tabular-nums">
          {formatCurrency(totals.net, currency)}
        </p>
        <div className="mt-auto space-y-1 pt-2">
          <p className="text-[11px] leading-snug text-text-on-brand/85">
            Each payslip floors its own net at zero, so this is summed, never
            subtracted.
          </p>
          {Math.abs(drift.amount) >= 0.001 && (
            <p
              data-testid="payroll-run-drift"
              className="flex items-start gap-1 text-[11px] font-semibold text-white"
            >
              <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                The run itself records {formatCurrency(drift.stored, currency)}{' '}
                {drift.label} — a difference of{' '}
                {formatCurrency(Math.abs(drift.amount), currency)}. Recalculate before
                approving.
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
