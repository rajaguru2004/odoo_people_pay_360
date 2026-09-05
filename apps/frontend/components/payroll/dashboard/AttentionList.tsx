'use client';

import AttentionStrip, {
  type AttentionItem,
  type AttentionSeverity,
} from '@/components/module-landing/AttentionStrip';
import type { DashboardAttentionItem } from '@/types/payrollDashboard';

/**
 * What will go wrong if nobody looks.
 *
 * Rendered through the strip the module hubs already use, so severity arrives
 * as a colour, a left accent, an icon AND the words — never colour alone.
 *
 * The findings are the pre-flight's own, which is what stops this list and the
 * run screen disagreeing: the same rules produce both, so the dashboard can
 * never say "ready" about a run that generation then refuses.
 */

/** The server's severities, mapped onto the strip's. */
const SEVERITY: Record<string, AttentionSeverity> = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};

/**
 * Where an objection is resolved.
 *
 * Matched on the server's own code so a finding lands on the screen that owns
 * the problem — a missing structure is fixed on the structures screen, not on
 * the run list.
 */
function hrefFor(code: string): string {
  switch (code) {
    case 'NO_STRUCTURE':
      return '/dashboard/payroll/structures';
    case 'NO_ACTIVE_CONTRACT':
      return '/dashboard/contracts';
    case 'RUN_AWAITING_APPROVAL':
    case 'DRAFT_FOR_CLOSED_PERIOD':
      return '/dashboard/payroll/runs';
    default:
      return '/dashboard/payroll/runs';
  }
}

/**
 * The count is the truth; the names are a capped sample.
 *
 * A detail printing only the names would quietly shrink a nineteen-person
 * problem into a five-person one, so anything past the sample is counted.
 */
function sampleDetail(count: number, names: string[], show = 3): string {
  const shown = names.slice(0, show);
  if (shown.length === 0) return `${count}`;
  const remaining = count - shown.length;
  return remaining > 0
    ? `${shown.join(', ')} and ${remaining} more`
    : shown.join(', ');
}

export default function AttentionList({
  items,
  loading = false,
}: {
  items?: DashboardAttentionItem[];
  loading?: boolean;
}) {
  const rows: AttentionItem[] = (items ?? []).map((item) => ({
    key: item.code,
    label: item.message,
    detail: sampleDetail(item.count, item.names),
    severity: SEVERITY[item.severity] ?? 'info',
    href: hrefFor(item.code),
  }));

  return (
    <AttentionStrip
      title="Needs attention"
      items={rows}
      loading={loading}
      emptyLabel="Nothing is blocking payroll for this period."
    />
  );
}
