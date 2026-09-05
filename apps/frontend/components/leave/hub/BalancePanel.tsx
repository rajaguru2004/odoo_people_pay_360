'use client';

import {
  DonutChart,
  PanelHeader,
  PanelLink,
  type DonutSlice,
} from '@/components/module-landing/primitives';
import { formatDays, formatRate } from '../leaveFormat';
import type { LeaveHubSummary } from '@/types/leaveHub';

/**
 * The year's entitlement: what has been spent, and what is still owed.
 *
 * A YEAR fact, deliberately, even though the rest of the page moves with the
 * period selector — a week does not have an entitlement. The caption says which
 * year, because a reader paging back through months would otherwise have no way
 * to tell that this one panel did not move with them.
 */
export default function BalancePanel({
  summary,
  loading = false,
}: {
  summary?: LeaveHubSummary;
  loading?: boolean;
}) {
  const balance = summary?.balance;
  const year = summary?.range.end.slice(0, 4);

  const slices: DonutSlice[] = [
    {
      key: 'used',
      label: 'Taken',
      value: balance?.used ?? 0,
      color: 'var(--color-brand-primary)',
    },
    {
      key: 'remaining',
      label: 'Still owed',
      value: Math.max(0, balance?.remaining ?? 0),
      color: 'var(--color-surface-border)',
    },
  ];

  const nothingAllocated = !balance || balance.allocated + balance.carriedOver === 0;

  return (
    <div className="surface-panel flex flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Entitlement"
        hint={year ? `The ${year} year, whatever period is selected above.` : undefined}
        action={<PanelLink href="/dashboard/leaves/balances">Manage</PanelLink>}
      />

      {loading ? (
        <div className="mt-6 h-[180px] animate-pulse rounded-xl bg-surface-border/60" />
      ) : nothingAllocated ? (
        <p className="py-16 text-center text-[13px] text-text-muted">
          No entitlement has been allocated for this year yet.
        </p>
      ) : (
        <>
          <div className="mt-4 flex justify-center">
            <DonutChart
              slices={slices}
              caption={formatRate(balance.utilisation)}
              subCaption="taken"
            />
          </div>

          <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-surface-border-light pt-4 text-center">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Allocated
              </dt>
              <dd className="mt-1 text-sm font-semibold tabular-nums text-text-heading">
                {formatDays(balance.allocated)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Carried over
              </dt>
              <dd className="mt-1 text-sm font-semibold tabular-nums text-text-heading">
                {formatDays(balance.carriedOver)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Remaining
              </dt>
              <dd className="mt-1 text-sm font-semibold tabular-nums text-text-heading">
                {formatDays(balance.remaining)}
              </dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}
