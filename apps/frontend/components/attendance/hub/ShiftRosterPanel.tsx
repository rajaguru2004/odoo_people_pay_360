'use client';

import { PanelHeader, SegmentedBar, type BarSegment } from '@/components/module-landing/primitives';
import type { AttendanceHubSummary } from '@/types/attendanceHub';

/**
 * Roster adherence: who was scheduled, and what became of them.
 *
 * The hint says where the schedule came from. `roster` means real WorkSchedule
 * rows cover the window; `calendar` means it fell back to the branch office
 * hours, and a reader comparing two departments needs to know when one of them
 * is being measured against an assumption.
 */
export default function ShiftRosterPanel({
  summary,
  periodLabel,
}: {
  summary?: AttendanceHubSummary;
  periodLabel: string;
}) {
  const shifts = summary?.shifts;
  // Shares divide by what was SCHEDULED, which is what the bar is a breakdown
  // of. A floor of one keeps an empty roster from dividing by zero rather than
  // inventing a denominator.
  const base = Math.max(shifts?.scheduled ?? 0, 1);
  const share = (n: number) => `${Math.round((n / base) * 100)}%`;

  const segments: BarSegment[] = [
    {
      key: 'onShift',
      label: 'On shift',
      value: shifts?.onShift ?? 0,
      color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
      shareLabel: share(shifts?.onShift ?? 0),
    },
    {
      key: 'late',
      label: 'Arrived late',
      value: shifts?.late ?? 0,
      color: 'var(--color-status-warning)',
      shareLabel: share(shifts?.late ?? 0),
    },
    {
      key: 'yetToCheckIn',
      label: 'Yet to check in',
      value: shifts?.yetToCheckIn ?? 0,
      color: 'color-mix(in srgb, var(--color-brand-primary) 40%, white)',
      shareLabel: share(shifts?.yetToCheckIn ?? 0),
    },
    {
      key: 'onLeave',
      label: 'On leave',
      value: shifts?.onLeave ?? 0,
      color: 'var(--color-status-info)',
      shareLabel: share(shifts?.onLeave ?? 0),
    },
  ];

  return (
    <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6">
      <div>
        <PanelHeader
          title="Shifts and roster"
          hint={
            !shifts
              ? undefined
              : shifts.source === 'roster'
                ? `${shifts.shiftCount} scheduled shift${shifts.shiftCount === 1 ? '' : 's'} across ${periodLabel}.`
                : `No roster for ${periodLabel} — measured against the branch office hours.`
          }
        />

        <div className="my-2 flex items-baseline gap-2.5">
          <span className="text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-text-heading">
            {shifts?.checkedIn ?? 0}
            <span className="text-[15px] font-bold text-text-muted">/{shifts?.scheduled ?? 0}</span>
          </span>
          <span className="text-xs font-semibold text-text-muted">checked in of scheduled</span>
        </div>

        {shifts && shifts.shifts.length > 0 && (
          <p className="text-[11px] leading-snug text-text-muted">
            {shifts.shifts
              .map((s) => `${s.count} × ${s.type.toLowerCase().replace(/_/g, ' ')}`)
              .join(' · ')}
          </p>
        )}
      </div>

      <div className="mt-4">
        <SegmentedBar segments={segments} height={14} />
      </div>
    </div>
  );
}
