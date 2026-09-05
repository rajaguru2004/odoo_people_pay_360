'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import {
  MeterList,
  PanelHeader,
  PanelLink,
  type MeterRow,
} from '@/components/module-landing/primitives';
import { formatAmountWithSymbol } from '@/utils/formatters';
import type { PayrollHubSummary } from '@/types/payrollHub';

/**
 * What the period's pay actually consisted of.
 *
 * Locked runs only, like every other money figure on this hub, so it reconciles
 * with the net card above it. Bars are scaled against the largest line rather
 * than against gross: at company scale basic pay dwarfs everything, and scaled
 * against the total every other row becomes an invisible sliver.
 *
 * This panel absorbed the old Statutory and Total Deductions KPI cards. Neither
 * was an action — nobody opens payroll to be told what tax came to — but both
 * are worth having as composition, which is a question about the shape of the
 * payroll rather than about what to do next.
 *
 * `residual` is printed rather than hidden. Four earning columns
 * (`siteAllowance`, `reimbursement`, `leaveEncashment`, `gratuityPayout`) are in
 * no gross formula anywhere in the codebase, so earnings minus deductions can
 * legitimately fail to equal net — and a panel that quietly rounded that away
 * would be the reason nobody ever found out.
 */
/**
 * Where each payslip column is decided, so a figure that looks wrong is one
 * click from the screen that produced it.
 *
 * Deliberately the screen that OWNS the number rather than a filtered payslip
 * list: overtime is wrong because an overtime claim is wrong, and the overtime
 * screen is where that gets fixed.
 */
const COLUMN_LINKS: Partial<Record<string, string>> = {
  baseSalary: '/dashboard/payroll/salary-structure',
  allowances: '/dashboard/payroll/salary-structure',
  bonus: '/dashboard/payroll/salary-structure',
  overtimePay: '/dashboard/overtime',
  foodAllowance: '/dashboard/overtime',
  siteAllowance: '/dashboard/payroll/salary-structure',
  reimbursement: '/dashboard/reimbursements',
  leaveEncashment: '/dashboard/payroll/encashment',
  deduction: '/dashboard/attendance',
  insurance: '/dashboard/payroll/reports',
  tax: '/dashboard/payroll/reports',
  advanceLoanDeduction: '/dashboard/advance-loans',
  garnishment: '/dashboard/garnishments',
  otherRecovery: '/dashboard/payroll/recoveries',
};

export default function MoneyComposition({
  composition,
  periodLabel,
  /** What this country calls the statutory line — SPF, EPF, CPF. */
  statutoryLabel,
  taxLabel,
  loading = false,
  failed = false,
}: {
  composition?: PayrollHubSummary['composition'];
  periodLabel?: string;
  statutoryLabel?: string;
  taxLabel?: string;
  loading?: boolean;
  failed?: boolean;
}) {
  const t = useTranslations('payrollHub');

  const all = composition ? [...composition.earnings, ...composition.deductions] : [];
  const largest = Math.max(1, ...all.map((r) => r.amount));

  /**
   * The admin-configured statutory names win over the generic message catalogue
   * — an Oman install calls this SPF everywhere else on the screen, and a panel
   * that alone says "Insurance" reads as a different deduction.
   */
  const labelFor = (key: string): string => {
    if (key === 'insurance' && statutoryLabel) return statutoryLabel;
    if (key === 'tax' && taxLabel) return taxLabel;
    return t(`money.${key}` as never);
  };

  const toRows = (
    src: PayrollHubSummary['composition']['earnings'],
    color: string,
  ): MeterRow[] =>
    src
      .filter((r) => r.amount > 0)
      .map((r) => ({
        key: r.key,
        label: labelFor(r.key),
        percent: (r.amount / largest) * 100,
        valueLabel: formatAmountWithSymbol(r.amount),
        color,
        href: COLUMN_LINKS[r.key],
      }));

  const earnings = composition ? toRows(composition.earnings, 'var(--color-brand-primary)') : [];
  const deductions = composition
    ? toRows(composition.deductions, 'var(--color-status-warning)')
    : [];

  const empty = earnings.length === 0 && deductions.length === 0;

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between h-full">
      <PanelHeader
        title={t('composition')}
        hint={periodLabel ? t('compositionHint', { period: periodLabel }) : undefined}
        action={<PanelLink href="/dashboard/payroll/recoveries">{t('seeRecoveries')}</PanelLink>}
      />

      {loading ? (
        <div className="flex-1 mt-4 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-4 w-full rounded bg-surface-page animate-pulse" />
          ))}
        </div>
      ) : failed ? (
        <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
          {t('compositionUnknown')}
        </p>
      ) : empty ? (
        // Not "the payroll was zero" — there is no locked run to describe.
        <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
          {t('noLockedRuns')}
        </p>
      ) : (
        <div className="mt-3 flex-1 flex flex-col gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              {t('compEarnings')}
            </p>
            <div className="mt-2">
              <MeterList rows={earnings} trackHeight={12} />
            </div>
          </div>

          {deductions.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                {t('compDeductions')}
              </p>
              <div className="mt-2">
                <MeterList rows={deductions} trackHeight={12} />
              </div>
            </div>
          )}

          {/* The totals the bars are shares of. Without them the panel shows the
              shape of the payroll and never its size, and the reader has to add
              seven bars up to check it against the cards. */}
          {composition && (
            <div className="pt-3 border-t border-surface-border grid grid-cols-3 gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">
                  {t('compGross')}
                </p>
                <p className="text-[13px] font-bold text-text-heading tabular-nums">
                  {formatAmountWithSymbol(composition.grossReported)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">
                  {t('compDeductions')}
                </p>
                <p className="text-[13px] font-bold text-status-warning tabular-nums">
                  {formatAmountWithSymbol(composition.deductionsTotal)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">
                  {t('compNet')}
                </p>
                <p className="text-[13px] font-bold text-status-success tabular-nums">
                  {composition.net === null ? '—' : formatAmountWithSymbol(composition.net)}
                </p>
              </div>
            </div>
          )}

          {composition && Math.abs(composition.residual) >= 0.01 && (
            // Not decoration: four earning columns are in no gross formula in
            // the codebase, so this is the only place that mismatch surfaces —
            // and the reconciliation report is where it gets chased down.
            <Link
              href="/dashboard/payroll/reports"
              className="text-[11px] text-status-warning leading-relaxed hover:underline inline-flex items-start gap-1"
            >
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>
                {t('compResidual', {
                  amount: formatAmountWithSymbol(Math.abs(composition.residual)),
                })}
              </span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
