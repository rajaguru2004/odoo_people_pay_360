'use client';

// The base block moved to `components/common/Skeleton.tsx` — it was never
// copilot-specific, and the ESS mobile pass needs it app-wide. Re-exported here
// so this module's two composites, and their importers, are unchanged.
import { Skeleton } from '@/components/common/Skeleton';

export { Skeleton };

/** Sidebar conversation-list loading state. */
export function ConversationListSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div className="space-y-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-3 py-2">
          <Skeleton className="h-4" style={{ width: `${55 + ((i * 13) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Chat transcript loading state — alternating assistant/user bubbles. */
export function ChatSkeleton() {
  const rows = [
    { me: false, w: '62%', lines: 2 },
    { me: true, w: '38%', lines: 1 },
    { me: false, w: '72%', lines: 3 },
    { me: true, w: '44%', lines: 1 },
  ];
  return (
    <div className="space-y-4 p-4">
      {rows.map((r, i) => (
        <div key={i} className={`flex gap-3 ${r.me ? 'flex-row-reverse' : ''}`}>
          <Skeleton className="mt-0.5 h-8 w-8 shrink-0 rounded-full" />
          <div
            className={`space-y-2 rounded-2xl px-4 py-3 ${r.me ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}
            style={{ width: r.w }}
          >
            {Array.from({ length: r.lines }).map((_, j) => (
              <Skeleton key={j} className={`h-3 ${j === r.lines - 1 ? 'w-3/5' : 'w-full'}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
