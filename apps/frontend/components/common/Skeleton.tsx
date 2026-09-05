'use client';

import { CSSProperties } from 'react';

/**
 * The app's loading placeholder, and the shapes the ESS screens load into.
 *
 * Promoted here from `components/copilot/Skeleton.tsx` rather than written
 * fresh: that one was already right — a `.shimmer` block (`app/globals.css`)
 * with a solid base so it is visible before the sweep arrives — it was just
 * filed under a feature. Copilot keeps its two composites and imports the base
 * from here, so no call site moved.
 *
 * **Use these instead of `animate-pulse` for loading.** The two are different
 * things wearing similar clothes: `.shimmer` is a sweep that reads as "content
 * is coming", `animate-pulse` is an opacity throb that this codebase also uses
 * for live-state dots (`my-attendance` uses it on an on-duty indicator). 32
 * files currently hand-roll a pulse for loading, which is why a phone shows a
 * different loading language on every screen.
 *
 * **Shape the skeleton like the thing it replaces.** A bare spinner says
 * nothing about what is arriving and reflows the page when it does; a skeleton
 * the size of the card holds the layout still. `SkeletonCard` is deliberately
 * `DataCard`'s silhouette (`components/common/DataCard.tsx`) — title line, a
 * two-column definition list — so a list settles into place without a jump.
 */

/** Shimmering placeholder block. */
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <div className={`shimmer rounded-md ${className}`} style={style} />;
}

/**
 * One `DataCard`-shaped placeholder.
 *
 * The class string tracks `DataCard`'s root (`rounded-xl border p-4`) on
 * purpose — if that changes, this must change with it, or the loading state
 * stops holding the space the loaded card takes.
 */
export function SkeletonCard({ rows = 2, testId }: { rows?: number; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="rounded-xl border border-surface-border bg-surface-card p-4"
      aria-hidden="true"
    >
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3">
        {Array.from({ length: rows * 2 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-2.5 w-1/2" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The mobile list's loading state.
 *
 * `testId` lands on the wrapper, not on each card: a spec asserting "the list
 * is loading" wants one node, and per `DataCard`'s rule it must not collide
 * with the loaded cards' id.
 */
export function SkeletonList({
  count = 4,
  rows = 2,
  testId,
}: {
  count?: number;
  rows?: number;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} rows={rows} />
      ))}
    </div>
  );
}

/**
 * The desktop table's loading state — real `<tr>`s, because a `<div>` inside a
 * `<tbody>` is invalid and the browser hoists it out of the table.
 */
export function SkeletonTableRows({
  rows = 5,
  cols,
  testId,
}: {
  rows?: number;
  cols: number;
  testId?: string;
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} data-testid={r === 0 ? testId : undefined} aria-hidden="true">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-4 py-3">
              <Skeleton className="h-4" style={{ width: `${60 + ((r * 7 + c * 11) % 35)}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
