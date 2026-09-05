'use client';

import {
  MeterList,
  PanelHeader,
  PanelLink,
  type MeterRow,
} from '@/components/module-landing/primitives';
import type { PeopleHubSummary } from '@/types/peopleHub';
import { DEFAULT_EXPIRY_WINDOW_DAYS, daysUntilDate } from '@/utils/contractExpiry';

/**
 * What is about to happen to somebody, soonest first.
 *
 * The bar length is TIME REMAINING, not a quantity — every row here is exactly
 * one person, so a bar drawn from a count would be the same length on all of
 * them. A start date four days out is a different job from one four weeks out,
 * and that is the only difference worth drawing.
 *
 * Joiners, contract expiries and probation endings share one list because the
 * reader chasing paperwork does not care which table a date came out of; they
 * care which one is closest.
 */
type Kind = 'joining' | 'contract' | 'probation';

const KIND_LABEL: Record<Kind, string> = {
  joining: 'Starts',
  contract: 'Contract ends',
  probation: 'Probation ends',
};

const KIND_COLOR: Record<Kind, string> = {
  joining: 'var(--color-brand-primary)',
  contract: 'var(--color-status-warning)',
  probation: 'var(--color-status-error)',
};

export default function LifecyclePanel({
  summary,
  loading = false,
  failed = false,
  limit = 7,
}: {
  summary?: PeopleHubSummary;
  loading?: boolean;
  failed?: boolean;
  limit?: number;
}) {
  type Event = { key: string; name: string; days: number; kind: Kind };
  const events: Event[] = [];

  for (const e of summary?.lifecycle.startingSoon ?? []) {
    const days = daysUntilDate(e.startDate);
    if (days === null) continue;
    events.push({
      key: `join-${e.id}`,
      name: e.department ? `${e.fullName} · ${e.department}` : e.fullName,
      days,
      kind: 'joining',
    });
  }
  for (const c of summary?.contracts.expiring ?? []) {
    events.push({
      key: `contract-${c.id}`,
      name: c.fullName ?? 'Unnamed employee',
      days: c.daysUntilExpiry,
      kind: 'contract',
    });
  }
  for (const p of summary?.lifecycle.probationEndingSoon ?? []) {
    const days = daysUntilDate(p.endDate);
    if (days === null) continue;
    events.push({
      key: `probation-${p.contractId}`,
      name: p.fullName ?? 'Unnamed employee',
      days,
      kind: 'probation',
    });
  }

  events.sort((a, b) => a.days - b.days);

  const rows: MeterRow[] = events.slice(0, limit).map((e) => ({
    key: e.key,
    label: `${KIND_LABEL[e.kind]} · ${e.name}`,
    // Full track = due now, empty = the far edge of the window. Clamped at both
    // ends so a date beyond the window still draws something rather than a
    // negative bar.
    percent: Math.max(
      4,
      Math.min(100, ((DEFAULT_EXPIRY_WINDOW_DAYS - e.days) / DEFAULT_EXPIRY_WINDOW_DAYS) * 100),
    ),
    valueLabel:
      e.days < 0
        ? `${Math.abs(e.days)}d overdue`
        : e.days === 0
          ? 'Today'
          : `in ${e.days}d`,
    color: e.days <= 7 ? 'var(--color-status-error)' : KIND_COLOR[e.kind],
  }));

  return (
    <div className="surface-panel flex h-full flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Due next"
        hint={
          summary && summary.terminations.awaitingApproval > 0
            ? `Starts, contract ends and probation decisions — plus ${summary.terminations.awaitingApproval} termination${
                summary.terminations.awaitingApproval === 1 ? '' : 's'
              } waiting on a decision.`
            : 'Starts, contract ends and probation decisions in the next 30 days.'
        }
        action={<PanelLink href="/dashboard/contracts">Contracts</PanelLink>}
      />

      {loading ? (
        <div className="flex-1 space-y-3 pt-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-lg bg-surface-page" />
          ))}
        </div>
      ) : failed ? (
        <p className="py-8 text-[13px] text-text-muted">Not available right now.</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-[13px] text-text-muted">Nothing falls due in the next 30 days.</p>
      ) : (
        <div className="flex flex-1 flex-col justify-center">
          <MeterList rows={rows} trackHeight={12} />
          {events.length > rows.length && (
            <p className="mt-3 text-[11px] text-text-muted">
              And {events.length - rows.length} more further out.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
