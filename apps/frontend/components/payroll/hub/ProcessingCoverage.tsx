'use client';

import Link from 'next/link';
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
 * sitting in an open run is in flight, somebody in no run at all has been
 * missed. A single "not paid" figure merges a normal mid-cycle state with an
 * outage.
 *
 * The denominator is the ACTIVE workforce, not the sum of the three buckets. An
 * employee can be active and absent from all of them, which is exactly the gap
 * this panel exists to show.
 *
 * The people with no salary structure are named rather than only counted,
 * because "3 employees cannot be paid" is a number and "Aisha, Ahmed and Fatima
 * cannot be paid" is something somebody can act on before the cycle closes. The
 * names are a capped SAMPLE — `withoutStructure` is the true total, and the
 * panel never reads the array's length as the count.
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
  const active = employees?.active ?? 0;
  const notInAnyRun = employees
    ? Math.max(0, employees.active - employees.paid - employees.inOpenRun)
    : 0;

  const segments: BarSegment[] = employees
    ? [
        {
          key: 'paid',
          label: 'Paid',
          value: employees.paid,
          color: 'var(--color-status-success)',
          href: '/dashboard/payroll/runs?status=PAID',
        },
        {
          key: 'inOpenRun',
          label: 'In an open run',
          value: employees.inOpenRun,
          color: 'var(--color-status-warning)',
          href: '/dashboard/payroll/runs',
        },
        {
          key: 'notInAnyRun',
          label: 'In no run',
          value: notInAnyRun,
          color: 'var(--color-status-error)',
          // The gap this panel exists to show, so it links to the screen that
          // closes it rather than to the same run list as the other two.
          href: '/dashboard/payroll/runs/new',
        },
      ].filter((segment) => segment.value > 0)
    : [];

  const withShares = segments.map((segment) => ({
    ...segment,
    shareLabel: active > 0 ? `${Math.round((segment.value / active) * 100)}%` : undefined,
  }));

  const sampleShown = employees?.withoutStructureNames.length ?? 0;
  const remaining = (employees?.withoutStructure ?? 0) - sampleShown;

  return (
    <div className="surface-panel flex h-full flex-col justify-between rounded-[20px] p-6">
      <PanelHeader
        title="Processing coverage"
        hint={periodLabel ? `Against the active workforce, for ${periodLabel}.` : undefined}
        action={<PanelLink href="/dashboard/payroll/runs">See runs</PanelLink>}
      />

      {loading ? (
        <div className="mt-4 flex-1 space-y-3">
          <div className="h-3.5 w-full animate-pulse rounded bg-surface-page" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-surface-page" />
        </div>
      ) : failed || !employees ? (
        <p className="grid flex-1 place-items-center text-[13px] text-text-muted">
          Coverage could not be read.
        </p>
      ) : active === 0 ? (
        <p className="grid flex-1 place-items-center text-[13px] text-text-muted">
          Nobody is active, so there is nothing to process.
        </p>
      ) : (
        <div className="mt-3 flex flex-1 flex-col justify-between gap-4">
          <div>
            <p className="text-[28px] font-extrabold leading-none tabular-nums text-text-heading">
              {employees.paid}
              <span className="text-[15px] font-semibold text-text-muted"> / {active}</span>
            </p>
            <p className="mt-1 text-[12px] text-text-muted">paid, of the active workforce</p>
          </div>

          <SegmentedBar segments={withShares} height={14} legendColumns={1} />

          {employees.withoutStructure > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                {employees.withoutStructure} without a salary structure
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-text-muted">
                Nobody can be paid without one, so this is what blocks the next run.
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {employees.withoutStructureNames.map((name) => (
                  <span
                    key={name}
                    data-testid="coverage-missing-employee"
                    className="inline-flex items-center rounded-lg border border-surface-border bg-surface-page px-2 py-0.5 text-[12px] text-text-body"
                  >
                    {name}
                  </span>
                ))}
                {/* The names are a capped sample while the count is exact, so a
                    short list must never read as the whole set. */}
                {remaining > 0 && (
                  <Link
                    href="/dashboard/payroll/structures"
                    className="inline-flex items-center rounded-lg px-2 py-0.5 text-[12px] font-semibold text-brand-primary hover:underline"
                  >
                    and {remaining} more
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
