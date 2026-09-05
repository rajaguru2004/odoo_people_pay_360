'use client';

import Link from 'next/link';
import { FileText, ScrollText, UserCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PanelHeader, PanelLink } from '@/components/module-landing/primitives';
import { formatNumber } from '@/utils/formatters';
import { formatDateOnly } from '@/utils/formatDate';
import type {
  DashboardCompliance,
  DashboardExpiryGroup,
} from '@/types/dashboardOverview';

/**
 * Documents, contracts and probation periods running out.
 *
 * Two rules carry this panel, and both are about not overstating what the
 * payload says:
 *
 * **`count` is the total; `items` is a capped sample.** A group of nineteen
 * arrives with five names. Reading the panel's length as the answer would
 * quietly shrink a nineteen-person problem to a five-person one, so anything
 * past the sample is counted out loud — "and 14 more" — rather than left for
 * the reader to discover on the list screen.
 *
 * **Dates go through `formatDateOnly`.** `expiryDate` is a calendar day with no
 * time on it. Put through an instant parse it becomes midnight UTC, which is the
 * PREVIOUS DAY anywhere west of Greenwich — a permit shown as lapsing on the
 * 14th when the ministry says the 15th.
 *
 * An already-expired row (`daysLeft < 0`) is the worst thing on the page and
 * says so in words as well as in colour.
 */

type GroupKey = 'documents' | 'contracts' | 'probation';

const GROUP_LABEL: Record<GroupKey, string> = {
  documents: 'Documents',
  contracts: 'Contracts',
  probation: 'Probation',
};

const GROUP_ICON: Record<GroupKey, LucideIcon> = {
  documents: FileText,
  contracts: ScrollText,
  probation: UserCheck,
};

/**
 * How urgent, in words first.
 *
 * The tint repeats what the sentence already says; it never carries the meaning
 * on its own.
 */
function urgency(daysLeft: number): { label: string; className: string } {
  if (daysLeft < 0) {
    const days = Math.abs(daysLeft);
    return {
      label: `Expired ${days} day${days === 1 ? '' : 's'} ago`,
      className: 'bg-status-error-bg text-status-error',
    };
  }
  if (daysLeft === 0) {
    return { label: 'Expires today', className: 'bg-status-error-bg text-status-error' };
  }
  return {
    label: `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    className:
      daysLeft <= 7
        ? 'bg-status-warning-bg text-status-warning'
        : 'bg-status-info-bg text-status-info',
  };
}

function ExpiryGroup({
  groupKey,
  group,
}: {
  groupKey: GroupKey;
  group: DashboardExpiryGroup;
}) {
  const Icon = GROUP_ICON[groupKey];
  const remaining = group.count - group.items.length;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <Icon size={14} className="shrink-0 text-text-muted" aria-hidden />
        <h4 className="text-[12px] font-bold uppercase tracking-wide text-text-muted">
          {GROUP_LABEL[groupKey]}
        </h4>
        <span className="rounded-full bg-surface-border px-2 py-0.5 text-[11px] font-bold tabular-nums text-text-muted">
          {formatNumber(group.count)}
        </span>
      </div>

      <ul className="flex flex-col gap-1">
        {group.items.map((item) => {
          const state = urgency(item.daysLeft);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-page"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-text-heading">
                    {item.employeeName}
                  </span>
                  <span className="block truncate text-[11px] text-text-muted">
                    {item.kind} · {formatDateOnly(item.expiryDate)}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${state.className}`}
                >
                  {state.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {/* The sample is not the set, and the panel says so rather than letting
          its own length answer the question. */}
      {remaining > 0 && (
        <p className="mt-1 ps-2 text-[11px] text-text-muted">
          And {formatNumber(remaining)} more not listed here.
        </p>
      )}
    </div>
  );
}

export default function ExpiringSoonPanel({
  compliance,
  loading = false,
}: {
  compliance?: DashboardCompliance;
  loading?: boolean;
}) {
  const all: Array<{ key: GroupKey; group: DashboardExpiryGroup }> = compliance
    ? [
        { key: 'documents', group: compliance.documents },
        { key: 'contracts', group: compliance.contracts },
        { key: 'probation', group: compliance.probation },
      ]
    : [];
  // An empty group is dropped rather than drawn as a heading with a zero under
  // it: "Contracts 0" is a heading looking for a list the reader then scans for.
  const groups = all.filter((entry) => entry.group.count > 0);

  const horizon = compliance?.horizonDays;

  return (
    <div className="surface-panel flex h-full flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Expiring soon"
        hint={
          horizon === undefined
            ? 'Documents, contracts and probation periods falling due.'
            : `Documents, contracts and probation periods falling due within ${horizon} days.`
        }
        action={<PanelLink href="/dashboard/contracts">Contracts</PanelLink>}
      />

      {loading ? (
        <div className="flex-1 space-y-2 pt-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-page" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        // A sentence, not an empty column: "nothing lapses in this window" is an
        // answer, and a blank panel is indistinguishable from a failed one.
        <p className="py-8 text-[13px] text-text-muted">
          {horizon === undefined
            ? 'Nothing is expiring.'
            : `Nothing expires in the next ${horizon} days.`}
        </p>
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          {groups.map(({ key, group }) => (
            <ExpiryGroup key={key} groupKey={key} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
