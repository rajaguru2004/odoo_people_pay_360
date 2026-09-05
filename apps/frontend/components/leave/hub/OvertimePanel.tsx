'use client';

import {
  MeterList,
  PanelHeader,
  PanelLink,
  type MeterRow,
} from '@/components/module-landing/primitives';
import { formatHours } from '@/utils/overtimeCalc';
import type { LeaveHubSummary } from '@/types/leaveHub';

/**
 * Who is carrying the overtime.
 *
 * A welfare signal rather than a productivity one: the same three names every
 * month is a staffing problem wearing an overtime costume, and that is the thing
 * this panel exists to make visible.
 *
 * Renders nothing at all when the company does not track overtime. A panel of
 * zeros reads as "nobody worked late", which is a different claim from "we do
 * not record this" — and only one of them would be true.
 */
export default function OvertimePanel({
  summary,
  loading = false,
}: {
  summary?: LeaveHubSummary;
  loading?: boolean;
}) {
  const overtime = summary?.overtime;
  if (summary && !overtime?.enabled) return null;

  const people = overtime?.topEmployees ?? [];
  const peak = people[0]?.hours ?? 0;

  const meters: MeterRow[] = people.map((person) => ({
    key: person.id,
    label: person.name,
    percent: peak > 0 ? (person.hours / peak) * 100 : 0,
    valueLabel: formatHours(person.hours),
    href: `/dashboard/overtime?employeeId=${person.id}`,
    // Colour carries the warning, so the row that needs a conversation is
    // findable before the numbers are read.
    color:
      person.hours >= 30
        ? 'var(--color-status-error)'
        : 'var(--color-brand-accent)',
  }));

  const topDepartment = overtime?.topDepartment;

  return (
    <div className="surface-panel flex flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Overtime carried"
        hint={
          summary
            ? `${formatHours(summary.periodStats.overtimeHours)} approved across ${summary.periodStats.overtimeEmployees} ${
                summary.periodStats.overtimeEmployees === 1 ? 'person' : 'people'
              }.`
            : undefined
        }
        action={<PanelLink href="/dashboard/overtime">All overtime</PanelLink>}
      />

      <div className="mt-5 flex-1">
        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-lg bg-surface-border/60" />
            ))}
          </div>
        ) : meters.length === 0 ? (
          <p className="py-14 text-center text-[13px] text-text-muted">
            No overtime was approved in this window.
          </p>
        ) : (
          <MeterList rows={meters} />
        )}
      </div>

      {topDepartment && (
        <p className="mt-4 border-t border-surface-border-light pt-3 text-xs text-text-muted">
          Most of it is in{' '}
          <span className="font-semibold text-text-body">{topDepartment.name}</span> —{' '}
          {formatHours(topDepartment.hours)}.
        </p>
      )}
    </div>
  );
}
