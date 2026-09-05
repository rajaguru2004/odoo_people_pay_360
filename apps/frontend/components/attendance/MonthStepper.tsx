'use client';

import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { monthLabel, type MonthCursor } from './monthGrid';

/**
 * ‹ September 2026 ›
 *
 * A stepper rather than a pair of date inputs. The grid draws one column per
 * day of ONE month, so a free range is a promise the table cannot keep: two
 * days would give it two columns, and a quarter would give it ninety.
 *
 * The chevrons carry `rtl:rotate-180` because they point at "earlier" and
 * "later", which change sides with the writing direction.
 */
export function MonthStepper({
  cursor,
  onChange,
  canGoNext,
  busy = false,
}: {
  cursor: MonthCursor;
  onChange: (delta: number) => void;
  /** False in the current month — the stepper must not walk into a month that
   *  has not happened, where every cell would be blank. */
  canGoNext: boolean;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 rounded-[var(--radius-input)] border border-surface-border bg-surface-page p-1">
      <button
        type="button"
        onClick={() => onChange(-1)}
        aria-label="Previous month"
        className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] text-text-body transition-colors hover:bg-surface-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
      >
        <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
      </button>

      <p
        data-testid="attendance-month"
        aria-live="polite"
        className="flex min-w-[10.5rem] items-center justify-center gap-2 px-2 text-sm font-semibold text-text-heading"
      >
        <CalendarDays className="h-4 w-4 text-brand-primary" aria-hidden />
        <span className={busy ? 'opacity-60' : undefined}>{monthLabel(cursor)}</span>
      </p>

      <button
        type="button"
        onClick={() => onChange(1)}
        disabled={!canGoNext}
        aria-label="Next month"
        className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] text-text-body transition-colors hover:bg-surface-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
      </button>
    </div>
  );
}
