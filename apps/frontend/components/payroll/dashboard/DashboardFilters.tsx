'use client';

import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import type {
  DashboardMonths,
  DashboardFilters as Filters,
  PayrollDashboardQuery,
} from '@/types/payrollDashboard';

/**
 * The slicer row — ONE row, above everything it scopes.
 *
 * Never a filter inside a chart card. A control that sits on one panel looks
 * like it narrows that panel, and the reader has no way to tell whether the
 * eleven other visuals moved with it. Everything here re-queries the single
 * endpoint, so every chart on the page changes together or not at all.
 *
 * The options come from the server's own `filters` block, so the row can only
 * offer values the endpoint will accept — an unoffered one is a 400, and a
 * control that can produce one is a control that can break the page.
 */

/** `2026-08` → `2026-07`, without going near a Date. */
function shiftPeriod(period: string, by: number): string {
  const [year, month] = period.split('-').map(Number);
  const index = year * 12 + (month - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

const MONTH_OPTIONS: DashboardMonths[] = [6, 12];

export default function DashboardFilters({
  filters,
  applied,
  periodLabel,
  onChange,
  onReset,
  disabled = false,
}: {
  /** The option lists. Undefined until the first response lands. */
  filters?: Filters;
  applied?: Filters['applied'];
  /** The server's own label for the focus period — `August 2026`. */
  periodLabel?: string;
  onChange: (
    key: keyof PayrollDashboardQuery,
    value: string | undefined,
  ) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  // The RESOLVED period, not the requested one. The page opens on the latest
  // locked run rather than on today, so the stepper has to move from the month
  // actually on screen or its first click jumps somewhere unexpected.
  const period = applied?.period;
  const anyApplied =
    Boolean(applied?.departmentId) ||
    Boolean(applied?.employmentType) ||
    Boolean(period);

  return (
    <div className="surface-panel flex flex-wrap items-end gap-3 rounded-[20px] p-4">
      <div className="flex items-end gap-1">
        <div className="min-w-0">
          <span className="mb-1.5 block text-sm font-medium text-text-body">
            Period
          </span>
          <div className="flex items-center gap-1 rounded-xl border border-surface-border bg-surface-card px-1 py-1">
            <button
              type="button"
              disabled={disabled || !period}
              onClick={() => period && onChange('period', shiftPeriod(period, -1))}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-page hover:text-text-heading disabled:pointer-events-none disabled:opacity-40"
              aria-label="Previous period"
            >
              {/* Directional, so it flips with the document. */}
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
            </button>
            <span className="min-w-[110px] px-1 text-center text-[13px] font-semibold text-text-heading">
              {periodLabel ?? '—'}
            </span>
            <button
              type="button"
              disabled={disabled || !period}
              onClick={() => period && onChange('period', shiftPeriod(period, 1))}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-page hover:text-text-heading disabled:pointer-events-none disabled:opacity-40"
              aria-label="Next period"
            >
              <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      <div className="w-[200px]">
        <Select
          label="Department"
          value={applied?.departmentId ?? ''}
          disabled={disabled}
          onChange={(event) =>
            onChange('departmentId', event.target.value || undefined)
          }
        >
          <option value="">All departments</option>
          {filters?.departments.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="w-[200px]">
        <Select
          label="Employment type"
          value={applied?.employmentType ?? ''}
          disabled={disabled}
          onChange={(event) =>
            onChange('employmentType', event.target.value || undefined)
          }
        >
          <option value="">All types</option>
          {filters?.employmentTypes.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="w-[140px]">
        <Select
          label="Trend window"
          value={String(applied?.months ?? 12)}
          disabled={disabled}
          onChange={(event) => onChange('months', event.target.value)}
        >
          {MONTH_OPTIONS.map((months) => (
            <option key={months} value={months}>
              {months} months
            </option>
          ))}
        </Select>
      </div>

      <button
        type="button"
        onClick={onReset}
        disabled={disabled || !anyApplied}
        className="ms-auto flex items-center gap-2 rounded-xl border border-surface-border px-3 py-2.5 text-[13px] font-semibold text-text-body transition-colors hover:bg-surface-page disabled:pointer-events-none disabled:opacity-40"
      >
        <RotateCcw className="h-4 w-4" aria-hidden />
        Reset
      </button>
    </div>
  );
}
