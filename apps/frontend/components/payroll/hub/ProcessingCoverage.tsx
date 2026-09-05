'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import {
  PanelHeader,
  PanelLink,
  SegmentedBar,
  type BarSegment,
} from '@/components/module-landing/primitives';
import type { PayrollHubSummary } from '@/types/payrollHub';

/**
 * How much of the expected payroll has actually been processed.
 *
 * Three states, and the distinction between the last two is the point: somebody
 * sitting in a DRAFT run is in flight, somebody in no run at all has been
 * missed. A single "not paid" figure merges a normal mid-cycle state with an
 * outage.
 *
 * The panel names who was missed rather than only counting them, because "3
 * employees are in no run" is a number and "Aisha, Ahmed and Fatima are in no
 * run" is something a payroll officer can act on before the cycle closes.
 */
export default function ProcessingCoverage({
  employees,
  periodLabel,
  loading = false,
  failed = false,
}: {
  employees?: PayrollHubSummary['employees'];
  periodLabel?: string;
  loading?: boolean;
  failed?: boolean;
}) {
  const t = useTranslations('payrollHub');

  const segments: BarSegment[] = employees
    ? [
        {
          key: 'paid',
          label: t('covPaid'),
          value: employees.paid,
          color: 'var(--color-status-success)',
          href: '/dashboard/payroll/manage',
        },
        {
          key: 'inOpenRun',
          label: t('covInOpenRun'),
          value: employees.inOpenRun,
          color: 'var(--color-status-warning)',
          href: '/dashboard/payroll/manage',
        },
        {
          key: 'notInAnyRun',
          label: t('covNotInAnyRun'),
          value: employees.notInAnyRun,
          color: 'var(--color-status-error)',
          // The gap this panel exists to show, so it links to the screen that
          // closes it rather than to the same run list as the other two.
          href: '/dashboard/payroll/validate',
        },
      ].filter((s) => s.value > 0)
    : [];

  // The denominator is the active workforce, not the sum of the three buckets:
  // an employee can be active and absent from all of them, which is exactly the
  // gap this panel exists to show.
  const active = employees?.active ?? 0;
  const withShares = segments.map((s) => ({
    ...s,
    shareLabel: active > 0 ? `${Math.round((s.value / active) * 100)}%` : undefined,
  }));

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between h-full">
      <PanelHeader
        title={t('coverage')}
        hint={periodLabel ? t('coverageHint', { period: periodLabel }) : undefined}
        action={<PanelLink href="/dashboard/payroll/manage">{t('seeRuns')}</PanelLink>}
      />

      {loading ? (
        <div className="flex-1 mt-4 space-y-3">
          <div className="h-3.5 w-full rounded bg-surface-page animate-pulse" />
          <div className="h-3 w-2/3 rounded bg-surface-page animate-pulse" />
        </div>
      ) : failed || !employees ? (
        <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
          {t('coverageUnknown')}
        </p>
      ) : active === 0 ? (
        <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
          {t('coverageNobody')}
        </p>
      ) : (
        <div className="mt-3 flex-1 flex flex-col justify-between gap-4">
          <div>
            <p className="text-[28px] font-extrabold text-text-heading tabular-nums leading-none">
              {employees.paid}
              <span className="text-[15px] font-semibold text-text-muted"> / {active}</span>
            </p>
            <p className="mt-1 text-[12px] text-text-muted">{t('coveragePaidOfActive')}</p>
          </div>

          <SegmentedBar segments={withShares} height={14} legendColumns={1} />

          {employees.notInAnyRun > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                {t('covMissing', { count: employees.notInAnyRun })}
              </p>
              {/* Each name is the way in. "Aisha is in no run" is only
                  actionable if the next click is Aisha's record, and a comma-
                  joined string of twelve names made the reader go and search
                  for every one of them by hand. */}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {employees.names.map((n) => (
                  <Link
                    key={n.id}
                    href={`/dashboard/employees/${n.id}`}
                    title={n.employeeCode}
                    data-testid="coverage-missing-employee"
                    className="inline-flex items-center gap-1 rounded-lg border border-surface-border bg-surface-page px-2 py-0.5 text-[12px] text-text-body hover:border-brand-primary hover:text-brand-primary transition-colors"
                  >
                    {n.fullName}
                    <ChevronRight size={11} className="opacity-60 rtl:rotate-180" />
                  </Link>
                ))}
                {/* The names are a sample: the server caps them at twelve while
                    the count is exact, so a long list must not read as the set. */}
                {employees.notInAnyRun > employees.names.length && (
                  <Link
                    href="/dashboard/payroll/validate"
                    className="inline-flex items-center rounded-lg px-2 py-0.5 text-[12px] font-semibold text-brand-primary hover:underline"
                  >
                    {t('andMore', { count: employees.notInAnyRun - employees.names.length })}
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
