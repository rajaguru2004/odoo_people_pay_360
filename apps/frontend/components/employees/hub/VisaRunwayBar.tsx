'use client';

import {
  PanelHeader,
  PanelLink,
  SegmentedBar,
  type BarSegment,
} from '@/components/module-landing/primitives';
import type { LegalDocument, LegalDocumentSummary } from '@/types/legalDocument';

interface VisaRunwayBarProps {
  summary?: LegalDocumentSummary;
  /** Documents inside the alert window — the only source for the sub-week band. */
  expiring?: LegalDocument[];
  loading?: boolean;
  /** The whole permit module answered 403. The panel removes itself. */
  unavailable?: boolean;
  /** The expiry LIST alone failed while the summary answered. */
  expiringFailed?: boolean;
}

/**
 * The whole permit position as one bar.
 *
 * Compliance is a runway rather than a count: what matters is how much time is
 * left on each document, and a table of dates leaves the reader to do that
 * subtraction themselves. The bands run worst-first so the eye lands on the red
 * end before it reads a word.
 *
 * The window is named from `alertDays` instead of being written into the label.
 * The server decides what "soon" means, and a band that says "expiring soon"
 * without saying by when is not a fact anybody can act on.
 */
export default function VisaRunwayBar({
  summary,
  expiring,
  loading = false,
  unavailable = false,
  expiringFailed = false,
}: VisaRunwayBarProps) {
  // Nothing to say and no way to find out. Drawing an empty bar here would read
  // as "no permits on file", which is a claim about the data rather than about
  // the request that failed.
  if (unavailable) return null;

  if (loading) {
    return (
      <div className="surface-panel flex h-full animate-pulse flex-col rounded-[20px] p-6">
        <div className="h-4 w-40 rounded bg-surface-border" />
        <div className="mt-8 h-3 w-full rounded-full bg-surface-border/70" />
        <div className="mt-6 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-2.5 w-2/3 rounded bg-surface-border/70" />
          ))}
        </div>
      </div>
    );
  }

  if (!summary) return null;

  // The summary counts everything inside the window as one bucket; the expiring
  // list is what carries the days, so the urgent end can only be split off when
  // that request answered.
  const critical = expiringFailed
    ? null
    : (expiring ?? []).filter((v) => v.daysUntilExpiry <= 7).length;
  const soon = critical === null ? summary.expiringSoon : Math.max(0, summary.expiringSoon - critical);

  const segments: BarSegment[] = [
    {
      key: 'expired',
      label: 'Already expired',
      value: summary.expired,
      color: 'var(--color-status-error)',
    },
    ...(critical === null
      ? []
      : [
          {
            key: 'critical',
            label: 'Within 7 days',
            value: critical,
            color: 'color-mix(in srgb, var(--color-status-error) 55%, white)',
          },
        ]),
    {
      key: 'soon',
      label: `Within ${summary.alertDays} days`,
      value: soon,
      color: 'var(--color-status-warning)',
    },
    { key: 'valid', label: 'In date', value: summary.active, color: 'var(--color-status-success)' },
  ];

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const withShares = segments.map((s) => ({
    ...s,
    shareLabel: total > 0 ? `${Math.round((s.value / total) * 100)}%` : '—',
  }));

  return (
    <div className="surface-panel flex h-full flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Work permit runway"
        hint={`Every current permit, banded by how long it has left. Alerts start at ${summary.alertDays} days.`}
        action={<PanelLink href="/dashboard/visa-reports">Visa reports</PanelLink>}
      />

      {total === 0 ? (
        <p className="py-8 text-[13px] text-text-muted">No permits on file.</p>
      ) : (
        <>
          <div className="flex flex-1 flex-col justify-center">
            <SegmentedBar segments={withShares} height={12} legendColumns={2} />
          </div>

          {expiringFailed && (
            // Said out loud rather than left as a missing band. The sub-week
            // count is the one the reader acts on first, and its absence must
            // not be mistaken for a zero.
            <p className="mt-4 text-[11px] leading-snug text-status-warning">
              The sub-week breakdown could not be read, so the amber band still
              holds every permit inside the alert window.
            </p>
          )}

          {summary.renewedThisYear > 0 && (
            <p className="mt-5 border-t border-surface-border pt-4 text-[12px] text-text-muted">
              {summary.renewedThisYear} renewed so far this year.
            </p>
          )}
        </>
      )}
    </div>
  );
}
