'use client';

import Link from 'next/link';
import { AlertTriangle, ChevronRight, Clock, Info, ShieldAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PanelHeader, PanelLink } from '@/components/module-landing/primitives';
import { formatNumber } from '@/utils/formatters';
import type {
  DashboardApprovalItem,
  DashboardApprovalSeverity,
  DashboardApprovals,
} from '@/types/dashboardOverview';

/**
 * What is waiting on somebody's decision, worst first.
 *
 * Severity arrives as a chip colour, an icon AND the word — never colour alone.
 * A reader with a red/green deficiency, a printed copy or a projector that eats
 * saturation still has to be able to tell a blocked termination from an
 * informational nudge, and roughly one man in twelve cannot take that from the
 * hue.
 *
 * Every row is a real anchor to the queue it counts, because a number the reader
 * cannot act on is a number they have to go and look for by hand.
 */

const SEVERITY_RANK: Record<DashboardApprovalSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

const SEVERITY_WORD: Record<DashboardApprovalSeverity, string> = {
  CRITICAL: 'Critical',
  WARNING: 'Needs action',
  INFO: 'For information',
};

const SEVERITY_ICON: Record<DashboardApprovalSeverity, LucideIcon> = {
  CRITICAL: ShieldAlert,
  WARNING: AlertTriangle,
  INFO: Info,
};

/** Chip tint and the left accent, both from tokens — no literal colour here. */
const SEVERITY_CHIP: Record<DashboardApprovalSeverity, string> = {
  CRITICAL: 'bg-status-error-bg text-status-error',
  WARNING: 'bg-status-warning-bg text-status-warning',
  INFO: 'bg-status-info-bg text-status-info',
};

const SEVERITY_ACCENT: Record<DashboardApprovalSeverity, string> = {
  CRITICAL: 'bg-status-error',
  WARNING: 'bg-status-warning',
  INFO: 'bg-status-info',
};

/**
 * The age of the oldest item, or nothing at all.
 *
 * `oldestDays` is `null` for a queue with nothing in it. Printing "0 days old"
 * there would invent an item that has been waiting since this morning; the row
 * simply says nothing about age instead.
 */
function ageLabel(oldestDays: number | null): string | null {
  if (oldestDays === null) return null;
  if (oldestDays <= 0) return 'Oldest arrived today';
  return `Oldest ${oldestDays} day${oldestDays === 1 ? '' : 's'} old`;
}

export default function ApprovalsQueue({
  approvals,
  loading = false,
}: {
  approvals?: DashboardApprovals;
  loading?: boolean;
}) {
  // Ranked here rather than trusted from the payload, so the top row is always
  // the thing that hurts most: severity first, then size. A queue of one
  // blocked termination outranks eleven informational nudges.
  const rows: DashboardApprovalItem[] = [...(approvals?.items ?? [])]
    // A settled queue is not something to act on, and a row reading "0" pushes
    // the queue that does need a decision further down the panel.
    .filter((item) => item.count > 0)
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.count - a.count,
    );

  return (
    <div className="surface-panel flex h-full flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Waiting on a decision"
        hint={
          approvals && approvals.total > 0
            ? `${formatNumber(approvals.total)} request${approvals.total === 1 ? '' : 's'} across ${rows.length} queue${rows.length === 1 ? '' : 's'}.`
            : 'Approvals across leave, overtime, corrections and terminations.'
        }
        action={
          rows.length > 0 ? (
            <PanelLink href={rows[0].href}>Open the top queue</PanelLink>
          ) : undefined
        }
      />

      {loading ? (
        <div className="flex-1 space-y-2 pt-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-page" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        // A written sentence, never a blank box: an empty panel reads as a
        // panel that failed to load, and the reader goes looking for work that
        // is not there.
        <p className="py-8 text-[13px] text-text-muted">
          Nothing is waiting on a decision.
        </p>
      ) : (
        <ul className="flex flex-1 flex-col gap-2">
          {rows.map((item) => {
            const Icon = SEVERITY_ICON[item.severity];
            const age = ageLabel(item.oldestDays);

            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="flex items-center gap-3 rounded-xl border border-surface-border bg-surface-card py-2.5 ps-2 pe-3 transition-colors hover:bg-surface-page"
                >
                  <span
                    className={`w-1 shrink-0 self-stretch rounded-full ${SEVERITY_ACCENT[item.severity]}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold text-text-heading">
                      {item.label}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SEVERITY_CHIP[item.severity]}`}
                      >
                        <Icon size={11} strokeWidth={2.5} aria-hidden />
                        {SEVERITY_WORD[item.severity]}
                      </span>
                      {/* Absent, not zeroed, when the queue has no age to
                          report — see `ageLabel`. */}
                      {age && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-text-muted">
                          <Clock size={11} aria-hidden />
                          {age}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-[18px] font-extrabold tabular-nums text-text-heading">
                    {formatNumber(item.count)}
                  </span>
                  <ChevronRight
                    size={15}
                    aria-hidden
                    className="shrink-0 text-text-muted rtl:rotate-180"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
