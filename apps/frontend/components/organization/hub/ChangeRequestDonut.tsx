'use client';

import { useTranslations } from 'next-intl';
import {
  DonutChart,
  DonutLegend,
  PanelHeader,
  PanelLink,
  type DonutSlice,
} from '@/components/module-landing/primitives';
import type { OrganizationHubSummary } from '@/types/organizationHub';

/**
 * The change-request queue, led by the number somebody has to act on.
 *
 * Pending sits in the middle of the ring rather than in the legend with the
 * others, because approved and rejected are history and pending is work. The
 * counts come from a `groupBy` on the server — the page used to read the length
 * of one page of the list endpoint, which sends no pagination meta, so any
 * queue longer than a page read short on the one card whose whole job is to say
 * how much is waiting.
 */
export default function ChangeRequestDonut({
  counts,
  loading = false,
  failed = false,
}: {
  counts?: OrganizationHubSummary['changeRequests'];
  loading?: boolean;
  failed?: boolean;
}) {
  const t = useTranslations('organizationHub');

  const slices: DonutSlice[] = counts
    ? [
        {
          key: 'pending',
          label: t('crPending'),
          value: counts.pending,
          color: 'var(--color-status-warning)',
        },
        {
          key: 'approved',
          label: t('crApproved'),
          value: counts.approved,
          color: 'var(--color-status-success)',
        },
        {
          key: 'rejected',
          label: t('crRejected'),
          value: counts.rejected,
          color: 'var(--color-status-error)',
        },
        {
          key: 'cancelled',
          label: t('crCancelled'),
          value: counts.cancelled,
          color: 'var(--color-text-muted)',
        },
      ].filter((s) => s.value > 0)
    : [];

  const total = slices.reduce((a, s) => a + s.value, 0);

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col h-full">
      <PanelHeader
        title={t('changeRequests')}
        hint={t('changeRequestsHint')}
        action={
          <PanelLink href="/dashboard/departments/change-requests">{t('review')}</PanelLink>
        }
      />

      {loading ? (
        <div className="flex-1 flex items-center justify-center py-6">
          <div className="h-[150px] w-[150px] rounded-full bg-surface-page animate-pulse" />
        </div>
      ) : failed ? (
        <p className="text-[13px] text-text-muted py-8">{t('queueUnknown')}</p>
      ) : total === 0 ? (
        // A genuinely empty queue is good news and says so, rather than drawing
        // an empty ring the reader has to interpret.
        <p className="text-[13px] text-text-muted py-8">{t('queueEmpty')}</p>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <DonutChart
            slices={slices}
            size={150}
            thickness={20}
            caption={String(counts?.pending ?? 0)}
            subCaption={t('crPending')}
          />
          <div className="w-full">
            <DonutLegend slices={slices} total={total} />
          </div>
        </div>
      )}
    </div>
  );
}
