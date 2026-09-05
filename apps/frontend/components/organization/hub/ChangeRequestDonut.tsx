'use client';

import {
  DonutChart,
  DonutLegend,
  PanelHeader,
  PanelLink,
  type DonutSlice,
} from '@/components/module-landing/primitives';
import type { OrganizationHubSummary } from '@/types/organizationHub';

/**
 * The change-request queue, led by the number somebody has to act on.
 *
 * Pending sits in the hole of the ring rather than in the legend beside the
 * rest: approved and rejected are history, pending is work, and the reader came
 * to this panel to find out how much of it there is.
 */
export default function ChangeRequestDonut({
  counts,
  loading = false,
  failed = false,
}: {
  counts?: OrganizationHubSummary['changeRequests'];
  loading?: boolean;
  failed?: boolean;
}) {
  const slices: DonutSlice[] = counts
    ? (
        [
          {
            key: 'pending',
            label: 'Pending',
            value: counts.pending,
            color: 'var(--color-status-warning)',
          },
          {
            key: 'approved',
            label: 'Approved',
            value: counts.approved,
            color: 'var(--color-status-success)',
          },
          {
            key: 'rejected',
            label: 'Rejected',
            value: counts.rejected,
            color: 'var(--color-status-error)',
          },
          {
            key: 'cancelled',
            label: 'Cancelled',
            value: counts.cancelled,
            color: 'var(--color-text-muted)',
          },
        ] satisfies DonutSlice[]
      ).filter((slice) => slice.value > 0)
    : [];

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <div className="surface-panel flex h-full flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Change requests"
        hint="Moves and reparenting waiting on a decision."
        action={<PanelLink href="/dashboard/departments/change-requests">Review</PanelLink>}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center py-6">
          <div className="h-[150px] w-[150px] animate-pulse rounded-full bg-surface-page" />
        </div>
      ) : failed ? (
        <p className="py-8 text-[13px] text-text-muted">The queue could not be read.</p>
      ) : total === 0 ? (
        // A genuinely empty queue is good news and says so, rather than drawing
        // an empty ring the reader has to interpret.
        <p className="py-8 text-[13px] text-text-muted">Nothing is waiting on a decision.</p>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <DonutChart
            slices={slices}
            size={150}
            thickness={20}
            caption={String(counts?.pending ?? 0)}
            subCaption="Pending"
          />
          <div className="w-full">
            <DonutLegend slices={slices} total={total} />
          </div>
        </div>
      )}
    </div>
  );
}
