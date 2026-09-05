'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PanelHeader, PanelLink } from '@/components/module-landing/primitives';
import type { OrganizationHubSummary } from '@/types/organizationHub';

/**
 * The shape of the organization in three figures.
 *
 * Deliberately blocks rather than another chart. There is a whole
 * Organizational Chart page one click away; reproducing it in a third of a row
 * would be a worse drawing of something the reader can already see properly.
 *
 * Each block states its own gap underneath — branches with no manager,
 * departments with no head — because the count on its own is the same number
 * every week.
 */
export default function OrgStructureBlocks({
  summary,
  loading = false,
}: {
  summary?: OrganizationHubSummary;
  loading?: boolean;
}) {
  const t = useTranslations('organizationHub');

  const blocks = [
    {
      key: 'branches',
      value: summary?.branches.total,
      label: t('branches'),
      href: '/dashboard/branches',
      gap:
        summary && summary.branches.withoutManager > 0
          ? t('gapNoManager', { count: summary.branches.withoutManager })
          : null,
    },
    {
      key: 'departments',
      value: summary?.departments.total,
      label: t('departments'),
      href: '/dashboard/departments',
      gap:
        summary && summary.departments.withoutHead > 0
          ? t('gapNoHead', { count: summary.departments.withoutHead })
          : null,
    },
    {
      key: 'managers',
      value: summary?.managers.total,
      label: t('managers'),
      href: '/dashboard/supervisor-teams',
      gap:
        summary && summary.managers.widestSpan
          ? t('gapWidest', { count: summary.managers.widestSpan.reports })
          : null,
    },
  ];

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col h-full">
      <PanelHeader
        title={t('orgStructure')}
        hint={t('orgStructureHint')}
        action={
          <PanelLink href="/dashboard/departments/tree">{t('viewOrgChart')}</PanelLink>
        }
      />

      {/* No failure sentence here on purpose: the attention strip above already
          carries it, and printing the same warning three times on one screen
          reads as three separate faults. A failed read shows em dashes. */}
      {/* Centred in the remaining space rather than pinned to the bottom of it:
          `justify-between` on the panel pushed three short blocks to the floor
          and left a hand-sized hole under the heading, beside a donut that
          fills its panel. */}
      <div className="flex-1 grid grid-cols-3 gap-2 mt-3 content-center">
          {blocks.map((b) => (
            <Link
              key={b.key}
              href={b.href}
              className="surface-panel-interactive rounded-2xl px-2 py-4 text-center bg-surface-page/60 hover:bg-surface-page transition-colors"
            >
              <div className="text-[26px] font-extrabold text-text-heading leading-none tabular-nums">
                {loading ? (
                  <span className="inline-block h-6 w-8 rounded bg-surface-border animate-pulse align-middle" />
                ) : (
                  // An em dash, never 0: "no departments" is a claim, and a
                  // failed read has not earned the right to make it.
                  b.value ?? '—'
                )}
              </div>
              <div className="mt-1.5 text-[11px] font-semibold text-text-muted">{b.label}</div>
              {b.gap && (
                <div className="mt-1 text-[10px] font-medium text-status-warning leading-tight">
                  {b.gap}
                </div>
              )}
            </Link>
        ))}
      </div>
    </div>
  );
}
