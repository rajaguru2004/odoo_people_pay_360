import { Badge } from '@/components/ui/Badge';
import type { PayrollRunStatus } from '@/types/payroll';

type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

/**
 * The run lifecycle, worded and toned in ONE place.
 *
 * Every screen that shows a run shows its status, and a list that called
 * `CALCULATED` "Calculated" beside a detail page calling the same state "Ready
 * for approval" leaves the reader with two names for one thing. The tone is
 * part of the same decision: `PAID` is the only green, because it is the only
 * state in which money has actually moved.
 */
const STATUS: Record<PayrollRunStatus, { label: string; tone: Tone; colour: string }> = {
  DRAFT: { label: 'Draft', tone: 'neutral', colour: 'var(--color-text-muted)' },
  CALCULATED: { label: 'Calculated', tone: 'warning', colour: 'var(--color-status-warning)' },
  APPROVED: { label: 'Approved', tone: 'info', colour: 'var(--color-status-info)' },
  PAID: { label: 'Paid', tone: 'success', colour: 'var(--color-status-success)' },
  CANCELLED: { label: 'Cancelled', tone: 'error', colour: 'var(--color-status-error)' },
};

/** The order the pipeline is read in — draft first, cancelled last. */
export const RUN_STATUSES: PayrollRunStatus[] = [
  'DRAFT',
  'CALCULATED',
  'APPROVED',
  'PAID',
  'CANCELLED',
];

export function runStatusLabel(status: PayrollRunStatus): string {
  return STATUS[status]?.label ?? status;
}

/** The swatch a chart uses, so a donut slice and a badge agree on a colour. */
export function runStatusColour(status: PayrollRunStatus): string {
  return STATUS[status]?.colour ?? 'var(--color-text-muted)';
}

export default function RunStatusBadge({ status }: { status: PayrollRunStatus }) {
  const entry = STATUS[status];
  return (
    <span data-testid="run-status" data-status={status}>
      <Badge tone={entry?.tone ?? 'neutral'}>{entry?.label ?? status}</Badge>
    </span>
  );
}
