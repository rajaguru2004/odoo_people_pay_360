'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronRight, Users, Wallet, Landmark, Receipt, Banknote } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import type { runTotals } from './PayrollRunTable';

/**
 * The five figures a payroll officer checks before submitting a run.
 *
 * The old four were `General staff / Total income / Total deduction / Net
 * Salary`, and two of them were wrong rather than merely thin: "total income"
 * summed five of the six earning columns, so site allowance was silently
 * missing — and the three cards could not be reconciled against the fourth,
 * which came from the run's own stored total.
 *
 * Every figure here is summed from the same row arithmetic the table below
 * prints, so the cards and the table can never disagree, and the residual is
 * shown rather than absorbed.
 */
export default function RunSummaryCards({
  totals,
  labels,
  payrollId,
  storedTotal,
}: {
  totals: ReturnType<typeof runTotals>;
  labels: { pf: string; tax: string; netSalary: string };
  payrollId: string;
  /** `payroll.totalAmount` — what the run itself claims it paid. */
  storedTotal: number;
}) {
  const t = useTranslations('payrollDetailPage');

  /**
   * The run's stored total against the sum of its own payslips.
   *
   * These are two different numbers from two different places, and nothing in
   * the product ever compared them. When they disagree the wage file and the
   * dashboard will report different amounts for the same run.
   */
  const drift = totals.net - storedTotal;

  const cards = [
    {
      key: 'employees',
      label: t('cardEmployees'),
      value: String(totals.employees),
      icon: Users,
      tint: 'bg-brand-primary/10 text-brand-primary',
      sub:
        totals.withExceptions > 0
          ? t('cardEmployeesExceptions', { count: totals.withExceptions })
          : t('cardEmployeesClean'),
      subTone: totals.withExceptions > 0 ? 'text-status-warning' : 'text-text-muted',
      href: '/dashboard/payroll/manage',
    },
    {
      key: 'gross',
      label: t('cardGross'),
      value: formatCurrency(totals.gross),
      icon: Wallet,
      tint: 'bg-status-success-bg text-status-success',
      sub: t('cardGrossHint'),
      subTone: 'text-text-muted',
      href: '/dashboard/payroll/salary-structure',
    },
    {
      key: 'deductions',
      label: t('cardDeductions'),
      value: formatCurrency(totals.deductions),
      icon: Receipt,
      tint: 'bg-status-error-bg text-status-error',
      sub: t('cardDeductionsHint', {
        tax: labels.tax,
        amount: formatCurrency(totals.tax),
      }),
      subTone: 'text-text-muted',
      href: '/dashboard/attendance',
    },
    {
      key: 'statutory',
      // Named by the regulator this tenant files with — SPF here, EPF in India.
      label: t('cardStatutory', { name: labels.pf }),
      value: formatCurrency(totals.statutory),
      icon: Landmark,
      tint: 'bg-status-info-bg text-status-info',
      sub:
        totals.statutory > 0
          ? t('cardStatutoryHint')
          : t('cardStatutoryNone', { name: labels.pf }),
      subTone: totals.statutory > 0 ? 'text-text-muted' : 'text-status-warning',
      href: '/dashboard/payroll/salary-structure',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <Link
            key={c.key}
            href={c.href}
            data-testid={`payroll-run-card-${c.key}`}
            className="group bg-surface-card rounded-[--radius-card] p-5 border border-surface-border hover:border-brand-primary/50 transition-colors flex flex-col"
          >
            <div className="flex items-center gap-2.5">
              <span className={`grid place-items-center w-9 h-9 rounded-xl shrink-0 ${c.tint}`}>
                <Icon size={17} strokeWidth={2.2} />
              </span>
              <span className="text-[13px] font-medium text-text-body leading-snug">
                {c.label}
              </span>
            </div>
            <p className="mt-3 text-[22px] font-extrabold text-text-heading tabular-nums leading-tight">
              {c.value}
            </p>
            <p className={`mt-auto pt-2 text-[11px] leading-snug ${c.subTone}`}>{c.sub}</p>
          </Link>
        );
      })}

      {/* Net stays visually last and loudest: it is the number that leaves the
          bank account, and 4.1 asks for the total first and the net after it. */}
      <div
        data-testid="payroll-run-card-net"
        className="bg-gradient-to-br from-brand-primary to-brand-primary-dark rounded-[--radius-card] p-5 text-text-on-brand flex flex-col"
      >
        <div className="flex items-center gap-2.5">
          <span className="grid place-items-center w-9 h-9 rounded-xl bg-white/15 shrink-0">
            <Banknote size={17} strokeWidth={2.2} />
          </span>
          <span className="text-[13px] font-medium text-text-on-brand/85 leading-snug">
            {labels.netSalary}
          </span>
        </div>
        <p className="mt-3 text-[22px] font-extrabold tabular-nums leading-tight">
          {formatCurrency(totals.net)}
        </p>
        <div className="mt-auto pt-2 space-y-1">
          {Math.abs(drift) >= 0.01 && (
            <Link
              href={`/dashboard/payroll/${payrollId}`}
              data-testid="payroll-run-drift"
              className="flex items-start gap-1 text-[11px] font-semibold text-white underline decoration-white/60"
            >
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              {t('storedTotalDrift', {
                amount: formatCurrency(Math.abs(drift)),
                stored: formatCurrency(storedTotal),
              })}
              <ChevronRight size={11} className="mt-0.5 shrink-0 rtl:rotate-180" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
