'use client';

import {
  MeterList,
  PanelHeader,
  PanelLink,
  type MeterRow,
} from '@/components/module-landing/primitives';
import type { OrgUnitRow } from '@/types/organizationHub';

/**
 * Where the workforce sits, by location.
 *
 * The bar is the branch's SHARE of the company rather than its headcount
 * against the largest branch. Normalising to the largest would draw both bars
 * at full width in a two-branch company and say nothing about how concentrated
 * the business is, which is the only question this panel answers.
 */
export default function BranchWorkforceMeters({
  rows,
  withoutManager = 0,
  limit = 6,
  loading = false,
  failed = false,
}: {
  rows?: OrgUnitRow[];
  withoutManager?: number;
  limit?: number;
  loading?: boolean;
  failed?: boolean;
}) {
  const shown = (rows ?? []).slice(0, limit);

  const meters: MeterRow[] = shown.map((branch) => ({
    key: branch.id,
    label: branch.name,
    // A branch nobody is posted to draws an empty track rather than a full one.
    percent: branch.share ?? 0,
    valueLabel:
      branch.share === null
        ? `${branch.employees}`
        : `${branch.employees} · ${branch.share.toFixed(0)}%`,
    href: '/dashboard/branches',
  }));

  return (
    <div className="surface-panel flex h-full flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Workforce by branch"
        hint={
          failed
            ? undefined
            : withoutManager > 0
              ? `${withoutManager} ${withoutManager === 1 ? 'branch has' : 'branches have'} no manager.`
              : 'Share of the active workforce posted to each location.'
        }
        action={<PanelLink href="/dashboard/branches">See branches</PanelLink>}
      />

      {loading ? (
        <div className="flex-1 space-y-3 pt-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg bg-surface-page" />
          ))}
        </div>
      ) : failed ? (
        // Not "no branches" — the distinction matters, because an all-clear
        // nobody managed to read is worse than a gap somebody can see.
        <p className="py-8 text-[13px] text-text-muted">
          The branch figures could not be read.
        </p>
      ) : meters.length === 0 ? (
        <p className="py-8 text-[13px] text-text-muted">No branches recorded yet.</p>
      ) : (
        // Centred only once there are enough rows to fill the panel. One branch
        // floating in the middle of a tall box reads as a half-loaded page
        // rather than as a company with a single location.
        <div
          className={`flex flex-1 flex-col ${
            meters.length >= 4 ? 'justify-center' : 'justify-start pt-1'
          }`}
        >
          <MeterList rows={meters} />
          {meters.length === 1 && (
            <p className="mt-4 text-[11px] leading-snug text-text-muted">
              One location, so this is the whole workforce rather than a comparison.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
