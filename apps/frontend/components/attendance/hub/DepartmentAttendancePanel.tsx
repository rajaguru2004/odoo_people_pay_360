'use client';

import { MeterList, PanelHeader, type MeterRow } from '@/components/module-landing/primitives';
import { formatRate } from '../attendanceFormat';
import type { HubDepartment } from '@/types/attendanceHub';

/**
 * Where the problem is, worst department first.
 *
 * Sorted ascending by rate rather than alphabetically: a ranking exists so the
 * reader does not have to scan it, and the department that needs a conversation
 * belongs at the top.
 *
 * A department that filed no attendance at all is kept and marked, not dropped.
 * Dropping it makes a missing feed look like a healthy one — the row is absent
 * either way, and only one of those is fine.
 */
export default function DepartmentAttendancePanel({
  rows,
  periodLabel,
  loading = false,
}: {
  rows?: HubDepartment[];
  periodLabel: string;
  loading?: boolean;
}) {
  const ranked = [...(rows ?? [])].sort((a, b) => {
    if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
    return (a.rate ?? 0) - (b.rate ?? 0);
  });

  const meters: MeterRow[] = ranked.slice(0, 8).map((d) => ({
    key: d.id,
    label: d.name,
    percent: d.rate ?? 0,
    valueLabel: formatRate(d.rate, 0),
    // Red below eighty, amber below ninety-five: the colour is the triage, and
    // the number beside it is the detail.
    color: !d.hasData
      ? 'var(--color-surface-border)'
      : (d.rate ?? 0) >= 95
        ? 'var(--color-status-success)'
        : (d.rate ?? 0) >= 80
          ? 'var(--color-status-warning)'
          : 'var(--color-status-error)',
    hint: d.hasData
      ? `${d.present} of ${d.expected} expected days · ${d.headcount} people`
      : 'No attendance filed in this window',
    href: '/dashboard/attendance/history',
  }));

  return (
    <div className="surface-panel flex h-full flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Departments"
        hint={`Lowest turnout first — ${periodLabel}.`}
      />

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-border/60" />
          ))}
        </div>
      ) : meters.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-text-muted">
          No departments have any attendance in this window.
        </p>
      ) : (
        <MeterList rows={meters} />
      )}
    </div>
  );
}
