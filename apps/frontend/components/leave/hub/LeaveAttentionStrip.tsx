'use client';

import AttentionStrip, {
  type AttentionItem,
} from '@/components/module-landing/AttentionStrip';
import { describeSample } from '@/components/attendance/attendanceFormat';
import type { LeaveHubAttentionItem, LeaveHubSummary } from '@/types/leaveHub';

/**
 * The hub's action queue, built from `summary.attention`.
 *
 * Each bucket arrives as a COUNT plus a handful of names. The count is the truth
 * and the names are a sample, so every row prints the count as its label and the
 * sample as its detail — `describeSample` appends "and N more" when the two
 * disagree. A row showing only the names would quietly shrink a nineteen-person
 * problem into a three-person one.
 *
 * Empty buckets are dropped rather than shown as zero: the strip says what needs
 * doing, and "0 requests waiting" is not a task.
 */
export function buildLeaveAttentionItems(
  attention: LeaveHubSummary['attention'] | undefined,
): AttentionItem[] {
  if (!attention) return [];

  const items: AttentionItem[] = [];

  const push = (
    bucket: LeaveHubAttentionItem,
    key: string,
    label: (count: number) => string,
    severity: AttentionItem['severity'],
    href: string,
  ) => {
    if (bucket.count <= 0) return;
    items.push({
      key,
      label: label(bucket.count),
      detail: describeSample(bucket.count, bucket.names),
      severity,
      href,
    });
  };

  // Stale first. A request waiting two days has stopped being "not yet" and
  // started being "forgotten", and that is the row somebody has to act on today.
  push(
    attention.stale,
    'stale',
    (n) => `${n} waiting over two days`,
    'critical',
    '/dashboard/leaves/pending',
  );
  push(
    attention.pending,
    'pending',
    (n) => `${n} awaiting a decision`,
    'warning',
    '/dashboard/leaves/pending',
  );
  push(
    attention.highOvertime,
    'high-overtime',
    (n) => `${n} over 30 hours of overtime`,
    'warning',
    '/dashboard/overtime',
  );
  push(
    attention.onLeaveToday,
    'on-leave',
    (n) => `${n} away today`,
    'info',
    '/dashboard/leaves',
  );

  return items;
}

export default function LeaveAttentionStrip({
  attention,
  loading = false,
}: {
  attention?: LeaveHubSummary['attention'];
  loading?: boolean;
}) {
  return (
    <AttentionStrip
      title="Needs a decision"
      items={buildLeaveAttentionItems(attention)}
      loading={loading}
      emptyLabel="Nothing is waiting on anybody right now."
      seeAll={{ label: 'Open the queue', href: '/dashboard/leaves/pending' }}
    />
  );
}
