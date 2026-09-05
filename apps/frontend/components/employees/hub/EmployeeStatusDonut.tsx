'use client';

import {
  DonutChart,
  DonutLegend,
  PanelHeader,
  PanelLink,
  type DonutSlice,
} from '@/components/module-landing/primitives';
import type { PeopleHubSummary } from '@/types/peopleHub';

/**
 * The workforce split by where each person stands today.
 *
 * Most of these buckets are DERIVED rather than stored: an employee row carries
 * only its own status, so probation is an active contract of that type and
 * notice is an open termination request. The server applies them in a fixed
 * order, which is why somebody on probation who has also resigned appears once,
 * as leaving — the fact that changes what HR does next.
 *
 * The labels arrive with the payload for the same reason: the split is the
 * server's to define, and a lookup table here would fall behind the first time
 * a bucket is added.
 */
const SLICE_COLORS: Record<string, string> = {
  active: 'var(--color-status-success)',
  probation: 'var(--color-brand-primary)',
  notice: 'var(--color-status-warning)',
  inactive: 'var(--color-text-muted)',
};

export default function EmployeeStatusDonut({
  split,
  total,
  loading = false,
  failed = false,
}: {
  split?: PeopleHubSummary['statusSplit'];
  total?: number;
  loading?: boolean;
  failed?: boolean;
}) {
  const slices: DonutSlice[] = (split ?? [])
    .filter((s) => s.count > 0)
    .map((s) => ({
      key: s.key,
      label: s.label,
      value: s.count,
      color: SLICE_COLORS[s.key] ?? 'var(--color-text-muted)',
    }));

  const sum = slices.reduce((a, s) => a + s.value, 0);

  return (
    <div className="surface-panel flex h-full flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Where everybody stands"
        hint="Probation and notice are read from contracts, not from the employee record."
        action={<PanelLink href="/dashboard/employees">Directory</PanelLink>}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center py-6">
          <div className="h-[160px] w-[160px] animate-pulse rounded-full bg-surface-page" />
        </div>
      ) : failed ? (
        // Neutral wording: the attention strip above has already said the read
        // failed, and saying it twice in two registers reads as two faults.
        <p className="py-8 text-[13px] text-text-muted">Not available right now.</p>
      ) : sum === 0 ? (
        <p className="py-8 text-[13px] text-text-muted">No employee records yet.</p>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <DonutChart
            slices={slices}
            size={160}
            thickness={21}
            caption={String(total ?? sum)}
            subCaption="on the books"
          />
          <div className="w-full">
            <DonutLegend slices={slices} total={sum} />
          </div>
        </div>
      )}
    </div>
  );
}
