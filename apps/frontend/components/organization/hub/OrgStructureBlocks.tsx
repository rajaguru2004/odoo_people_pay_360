'use client';

import Link from 'next/link';
import { PanelHeader, PanelLink } from '@/components/module-landing/primitives';
import type { OrganizationHubSummary } from '@/types/organizationHub';

/**
 * The shape of the company in three figures.
 *
 * Blocks rather than a fourth chart: the organisational chart is one click away
 * and draws the hierarchy properly, so redrawing it in a third of a row would
 * be a worse picture of something the reader can already see.
 *
 * Each block states its own gap underneath, because the count on its own is the
 * same number every week and nobody acts on it.
 */
export default function OrgStructureBlocks({
  summary,
  loading = false,
}: {
  summary?: OrganizationHubSummary;
  loading?: boolean;
}) {
  const blocks = [
    {
      key: 'branches',
      value: summary?.branches.total,
      label: 'Branches',
      href: '/dashboard/branches',
      gap:
        summary && summary.branches.withoutManager > 0
          ? `${summary.branches.withoutManager} with no manager`
          : null,
    },
    {
      key: 'departments',
      value: summary?.departments.total,
      label: 'Departments',
      href: '/dashboard/departments',
      gap:
        summary && summary.departments.withoutHead > 0
          ? `${summary.departments.withoutHead} with no head`
          : null,
    },
    {
      key: 'managers',
      value: summary?.managers.total,
      label: 'Managers',
      href: '/dashboard/teams',
      gap:
        summary?.managers.widestSpan && summary.managers.widestSpan.reports > 1
          ? `widest span ${summary.managers.widestSpan.reports}`
          : null,
    },
  ];

  return (
    <div className="surface-panel flex h-full flex-col rounded-[20px] p-6">
      <PanelHeader
        title="Org structure"
        hint="Locations, units and the people who sign for them."
        action={<PanelLink href="/dashboard/departments/tree">View chart</PanelLink>}
      />

      {/* No failure sentence here: the attention strip above already carries it,
          and the same warning printed three times on one screen reads as three
          separate faults. A failed read shows em dashes and nothing else.

          Centred in the remaining space rather than pushed to the floor of the
          panel, which left a hand-sized hole under the heading beside a donut
          that fills its own. */}
      <div className="mt-3 grid flex-1 grid-cols-3 content-center gap-2">
        {blocks.map((block) => (
          <Link
            key={block.key}
            href={block.href}
            className="surface-panel-interactive rounded-2xl bg-surface-page/60 px-2 py-4 text-center transition-colors hover:bg-surface-page"
          >
            <div className="text-[26px] font-extrabold leading-none tabular-nums text-text-heading">
              {loading ? (
                <span className="inline-block h-6 w-8 animate-pulse rounded bg-surface-border align-middle" />
              ) : (
                // An em dash, never 0: "no departments" is a claim, and a read
                // that failed has not earned the right to make it.
                (block.value ?? '—')
              )}
            </div>
            <div className="mt-1.5 text-[11px] font-semibold text-text-muted">{block.label}</div>
            {block.gap && (
              <div className="mt-1 text-[10px] font-medium leading-tight text-status-warning">
                {block.gap}
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
