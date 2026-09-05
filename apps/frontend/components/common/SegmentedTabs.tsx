'use client';

import type { ComponentType } from 'react';
import { cn } from '@/utils/cn';

/**
 * The in-page tab strip — one row of mutually exclusive filters over the same
 * list.
 *
 * Not a routing tab set and not an accordion: this is the "All / Pending /
 * Approved" row that five ESS screens each rebuild, at four different heights,
 * none of which clears 44px. `components/attendance/TimePeriodTabs.tsx` is
 * `px-4 py-2` (~36px) and paints `bg-slate-100` / `bg-white` / `text-slate-600`
 * — raw palette classes that survive a theme-preset change.
 *
 * Two phone-specific behaviours it owns:
 *
 * - **It scrolls rather than compresses.** Four labels in a `flex` row at 390px
 *   squeeze to ellipses. `shrink-0 whitespace-nowrap` inside a snap rail keeps
 *   each tab its natural width and lets the row be swiped.
 * - **44px, always.** A control that switches the whole list under it is not a
 *   place to save eight pixels.
 *
 * `count` is rendered as a pill because "Pending 3" tells the reader whether
 * the tab is worth a tap before they spend one.
 */

export interface SegmentedTab<K extends string> {
  key: K;
  label: string;
  count?: number;
  icon?: ComponentType<{ size?: number; className?: string }>;
}

export interface SegmentedTabsProps<K extends string> {
  tabs: ReadonlyArray<SegmentedTab<K>>;
  value: K;
  onChange: (key: K) => void;
  /** Each tab gets `data-testid={`${testIdPrefix}-${key}`}`. */
  testIdPrefix: string;
  /** Names the group for a screen reader — "Leave status", not "Tabs". */
  ariaLabel: string;
  className?: string;
}

export default function SegmentedTabs<K extends string>({
  tabs,
  value,
  onChange,
  testIdPrefix,
  ariaLabel,
  className,
}: SegmentedTabsProps<K>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'no-scrollbar flex snap-x snap-mandatory gap-1 overflow-x-auto rounded-xl bg-surface-page p-1',
        className,
      )}
    >
      {tabs.map(({ key, label, count, icon: Icon }) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`${testIdPrefix}-${key}`}
            onClick={() => onChange(key)}
            className={cn(
              'inline-flex h-11 shrink-0 snap-start touch-manipulation items-center justify-center gap-1.5',
              'whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors',
              active
                ? 'bg-surface-card text-text-heading shadow-sm'
                : 'text-text-muted hover:text-text-body',
            )}
          >
            {Icon && <Icon size={15} />}
            {label}
            {count != null && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums',
                  active ? 'bg-brand-primary/10 text-brand-primary' : 'bg-surface-border/60 text-text-muted',
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
