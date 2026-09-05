'use client';

import AttentionStrip, { type AttentionItem } from '@/components/module-landing/AttentionStrip';
import { describeSample } from '../attendanceFormat';
import type { AttendanceHubSummary, HubNamedCount } from '@/types/attendanceHub';

/**
 * The hub's action queue, built from `summary.attention`.
 *
 * Each bucket arrives as a COUNT plus a handful of names. The count is the
 * truth and the names are a sample, so every row prints the count as its label
 * and the sample as its detail — `describeSample` appends "and N more" when the
 * two disagree. A row that showed only the names would quietly shrink a
 * nineteen-person problem into a three-person one.
 *
 * Buckets with nothing in them are dropped rather than shown as zero: the strip
 * exists to say what needs doing, and "0 people have not checked in" is not a
 * task.
 */
export function buildAttentionItems(
  attention: AttendanceHubSummary['attention'] | undefined,
  options: { oldestCorrectionDays?: number } = {},
): AttentionItem[] {
  if (!attention) return [];

  const items: AttentionItem[] = [];

  const push = (
    bucket: HubNamedCount,
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

  push(
    attention.notCheckedIn,
    'not-checked-in',
    (n) => `${n} not checked in`,
    'critical',
    '/dashboard/attendance',
  );
  push(
    attention.absent,
    'absent',
    (n) => `${n} absent`,
    'critical',
    '/dashboard/attendance',
  );
  push(
    attention.late,
    'late',
    (n) => `${n} arrived late`,
    'warning',
    '/dashboard/attendance/history',
  );
  push(
    attention.notCheckedOut,
    'not-checked-out',
    (n) => `${n} still clocked in`,
    'warning',
    '/dashboard/attendance/management',
  );
  push(
    attention.overScheduledHours,
    'over-hours',
    (n) => `${n} over their scheduled hours`,
    'info',
    '/dashboard/attendance/reports',
  );

  if (attention.pendingCorrections > 0) {
    const oldest = options.oldestCorrectionDays ?? 0;
    items.push({
      key: 'corrections',
      label: `${attention.pendingCorrections} correction${
        attention.pendingCorrections === 1 ? '' : 's'
      } waiting`,
      detail: oldest > 0 ? `oldest ${oldest} days old` : 'awaiting review',
      severity: oldest >= 3 ? 'critical' : 'warning',
      href: '/dashboard/attendance/corrections',
    });
  }

  return items;
}

/**
 * `AttentionStrip` wired to the hub payload.
 *
 * The mapping lives beside the strip rather than inside the page so the "count
 * is the truth, names are a sample" rule has exactly one implementation.
 */
export default function AttentionStripSource({
  attention,
  oldestCorrectionDays,
  loading = false,
}: {
  attention?: AttendanceHubSummary['attention'];
  oldestCorrectionDays?: number;
  loading?: boolean;
}) {
  const items = buildAttentionItems(attention, { oldestCorrectionDays });

  return (
    <AttentionStrip
      title="Needs chasing"
      items={items}
      loading={loading}
      emptyLabel="Nothing is waiting on anybody right now."
      seeAll={{ label: "See today's board", href: '/dashboard/attendance' }}
    />
  );
}
