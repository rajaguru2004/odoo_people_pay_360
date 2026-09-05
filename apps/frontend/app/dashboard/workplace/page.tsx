'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Laptop, AlertTriangle, FileText } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import AttentionStrip, { type AttentionItem } from '@/components/module-landing/AttentionStrip';
import type { KpiStat } from '@/components/module-landing/StatCard';
import {
  BarOverviewChart,
  MeterList,
  PanelHeader,
  PanelLink,
  SegmentedBar,
  type BarOverviewItem,
  type BarSegment,
  type MeterRow,
} from '@/components/module-landing/primitives';
import { useWorkplaceHub } from '@/hooks/useWorkplaceHub';
import { ageInDays, toDelta } from '@/hooks/useModuleHub';
import { formatAmountWithSymbol } from '@/utils/formatters';
import { niceAxis, sharePct } from '@/utils/hubAxis';

/**
 * Workplace module hub — "are resources and requests being managed".
 *
 * The headline is the letter desk rather than assets because it is the only
 * workplace entity with two real timestamps (`createdAt` and `issuedAt`) and
 * genuine recurring monthly volume. Assets move a dozen times a year, which
 * makes for twelve mostly-empty bars.
 *
 * What this page will not claim: an asset overdue for return. `AssetAssignment`
 * has no `returnDueDate`, so the exceptions it CAN see — in repair, lost,
 * warranty gone, custody unacknowledged, held by somebody who has left — are
 * what it shows instead.
 */
function WorkplaceHubContent() {
  const t = useTranslations('workplaceHub');
  const tm = useTranslations('moduleLanding');
  const { summary, loading, hubFailed } = useWorkplaceHub();

  const assets = summary?.assets;
  const letters = summary?.letters;
  const clearances = summary?.clearances;
  const windowLabel = summary?.window.label ?? '';
  const prevLabel = summary?.window.previous.label ?? '';

  const num = (value: number | undefined | null) =>
    hubFailed || value === undefined || value === null ? null : value;

  const vsPrevious = t('vsPrevious', { period: prevLabel });
  const countDelta = (d: Parameters<typeof toDelta>[0], good: 'up' | 'down') =>
    toDelta(d, good, vsPrevious, (abs) => String(Math.round(abs)));

  const oldestPendingDays = ageInDays(letters?.oldestPendingAt);

  const kpis: KpiStat[] = [
    {
      key: 'held',
      label: t('kpiHeld'),
      value: num(assets?.held),
      icon: Laptop,
      // Exact: `AssetAssignment` is append-only, so custody at a past date is a
      // query rather than a reconstruction.
      delta: countDelta(assets?.heldDelta, 'up'),
      footnote: assets ? t('kpiHeldHint', { total: assets.total }) : undefined,
      href: '/dashboard/assets',
    },
    {
      key: 'attention',
      label: t('kpiAssetAttention'),
      value: num(assets?.needingAttention),
      icon: AlertTriangle,
      tone: (assets?.needingAttention ?? 0) > 0 ? 'warning' : 'success',
      // No delta: `AssetItem.status` has no history table, so there is no
      // honest baseline. The footnote itemises the composite instead, which is
      // the only thing that makes a composite card readable.
      footnote: assets
        ? t('kpiAssetAttentionHint', {
            repair: assets.byStatus.IN_REPAIR,
            lost: assets.byStatus.LOST,
            warranty: assets.warrantyExpired,
          })
        : undefined,
      href: '/dashboard/assets',
    },
    {
      key: 'letters',
      label: t('kpiLetters'),
      value: num(letters?.pending),
      icon: FileText,
      tone: oldestPendingDays >= 7 ? 'warning' : 'default',
      // No delta: a pending queue cannot be reconstructed for a past date —
      // `LetterRequest` has no `rejectedAt`.
      footnote: !letters
        ? undefined
        : letters.pending === 0
          ? t('kpiLettersClear')
          : t('kpiLettersHint', { days: oldestPendingDays }),
      href: '/dashboard/letters',
    },
  ];

  const attentionItems: AttentionItem[] = useMemo(() => {
    if (hubFailed) {
      return [{ key: 'failed', label: t('readFailed'), severity: 'critical' as const }];
    }
    if (!summary) return [];

    const items: AttentionItem[] = [];

    if (summary.clearances.outstandingCount > 0) {
      items.push({
        key: 'clearances',
        // An asset still held by somebody who has left. The closest real signal
        // this schema has to an overdue return, and each one blocks a final
        // settlement.
        label: t('attnClearances', { count: summary.clearances.outstandingCount }),
        detail: summary.clearances.top[0]?.employeeName ?? undefined,
        severity: 'critical',
        href: '/dashboard/assets',
      });
    }

    if (summary.assets.byStatus.LOST > 0) {
      items.push({
        key: 'lost',
        label: t('attnLost', { count: summary.assets.byStatus.LOST }),
        detail: formatAmountWithSymbol(summary.assets.valueAtRisk),
        severity: 'critical',
        href: '/dashboard/assets',
      });
    }

    if (summary.assets.unacknowledged > 0) {
      items.push({
        key: 'unacknowledged',
        label: t('attnUnacknowledged', { count: summary.assets.unacknowledged }),
        severity: 'warning',
        href: '/dashboard/assets',
      });
    }

    if (summary.assets.warrantyExpiring60 > 0) {
      items.push({
        key: 'warranty',
        label: t('attnWarranty', { count: summary.assets.warrantyExpiring60 }),
        severity: 'warning',
        href: '/dashboard/assets',
      });
    }

    if (oldestPendingDays >= 7) {
      items.push({
        key: 'staleLetters',
        label: t('attnStaleLetters', { days: oldestPendingDays }),
        severity: 'warning',
        href: '/dashboard/letters',
      });
    }

    return items;
  }, [summary, hubFailed, oldestPendingDays, t]);

  /** Twelve months of the letter desk: raised, and how much went out. */
  const { barItems, axis } = useMemo(() => {
    const buckets = summary?.trend ?? [];
    const lanes: Record<string, { label: string; color: string }> = {
      issued: {
        label: t('laneIssued'),
        color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
      },
      outstanding: {
        label: t('laneOutstanding'),
        color: 'color-mix(in srgb, var(--color-status-warning) 70%, white)',
      },
    };

    let defaultKey: string | undefined;
    for (const b of buckets) if (b.value > 0) defaultKey = b.key;

    const items: BarOverviewItem[] = buckets.map((b) => ({
      key: b.key,
      label: b.label,
      value: b.value,
      highlight: b.key === defaultKey,
      tooltipTitle: b.label,
      segments: b.segments.map((s) => ({
        key: s.key,
        label: lanes[s.key]?.label ?? s.key,
        value: s.value,
        color: lanes[s.key]?.color ?? 'var(--color-border)',
      })),
      tooltipRows: [
        { label: t('laneRequested'), value: b.value },
        ...b.segments.map((s) => ({
          label: lanes[s.key]?.label ?? s.key,
          value: s.value,
          color: lanes[s.key]?.color,
        })),
      ],
    }));

    return { barItems: items, axis: niceAxis(Math.max(1, ...buckets.map((b) => b.value))) };
  }, [summary, t]);

  /** The register at a glance — five real statuses, none of them invented. */
  const assetRows: MeterRow[] = useMemo(() => {
    if (!assets) return [];
    const order: Array<[keyof typeof assets.byStatus, string]> = [
      ['ASSIGNED', 'color-mix(in srgb, var(--color-brand-primary) 90%, white)'],
      ['AVAILABLE', 'color-mix(in srgb, var(--color-brand-primary) 45%, white)'],
      ['IN_REPAIR', 'var(--color-status-warning)'],
      ['LOST', 'var(--color-status-error)'],
      // Not `--color-border`: `MeterList` marks a zero row with a 4px stub at
      // 20% opacity, and at that opacity the border colour is invisible on the
      // track — so an empty RETIRED row looked like a missing row while the
      // empty IN_REPAIR and LOST rows beside it were still visible.
      ['RETIRED', 'var(--color-text-muted, #6B7280)'],
    ];
    return order.map(([key, color]) => ({
      key,
      label: t(`assetStatus.${key}` as any),
      percent: sharePct(assets.byStatus[key], assets.total),
      valueLabel: String(assets.byStatus[key]),
      color,
    }));
  }, [assets, t]);

  /** The exceptions, which are a different question from the status split. */
  const exceptionSegments: BarSegment[] = useMemo(() => {
    if (!assets) return [];
    return [
      {
        key: 'unacknowledged',
        label: t('excUnacknowledged'),
        value: assets.unacknowledged,
        color: 'color-mix(in srgb, var(--color-brand-primary) 60%, white)',
      },
      {
        key: 'repair',
        label: t('excRepair'),
        value: assets.byStatus.IN_REPAIR,
        color: 'var(--color-status-warning)',
      },
      {
        key: 'lost',
        label: t('excLost'),
        value: assets.byStatus.LOST,
        color: 'var(--color-status-error)',
      },
      {
        key: 'warranty',
        label: t('excWarranty'),
        value: assets.warrantyExpired,
        color: 'color-mix(in srgb, var(--color-status-error) 45%, white)',
      },
    ].filter((s) => s.value > 0);
  }, [assets, t]);

  const letterSegments: BarSegment[] = useMemo(() => {
    const byStatus = letters?.byStatus;
    if (!byStatus) return [];
    const order: Array<[string, string]> = [
      ['PENDING', 'var(--color-status-warning)'],
      ['ISSUED', 'var(--color-status-success)'],
      ['REJECTED', 'var(--color-status-error)'],
    ];
    const total = Math.max(1, order.reduce((a, [k]) => a + (byStatus[k] ?? 0), 0));
    return order
      .filter(([k]) => (byStatus[k] ?? 0) > 0)
      .map(([k, color]) => ({
        key: k,
        label: t(`letterStatus.${k}` as any),
        value: byStatus[k],
        color,
        shareLabel: `${Math.round((byStatus[k] / total) * 100)}%`,
      }));
  }, [letters, t]);

  const chartEmpty = barItems.length === 0 || barItems.every((b) => b.value === 0);

  return (
    <ModuleLandingPage
      moduleKey="workplace"
      title={tm('workplace.title')}
      subtitle={tm('workplace.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      badges={{ letters: letters?.pending }}
      badgeTones={{ letters: oldestPendingDays >= 7 ? 'danger' : 'warning' }}
      insights={
        <div className="space-y-6">
          <AttentionStrip
            title={t('needsAttention')}
            items={attentionItems}
            loading={loading}
            emptyLabel={t('needsAttentionEmpty')}
            seeAll={{ label: t('seeAssets'), href: '/dashboard/assets' }}
          />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 xl:col-span-8 surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <PanelHeader
                title={t('letterTrend')}
                hint={t('letterTrendHint')}
                action={<PanelLink href="/dashboard/letters">{t('viewDetails')}</PanelLink>}
              />
              <div className="mt-2 pt-2 flex-1 min-h-[260px] flex">
                {chartEmpty ? (
                  <p className="text-[13px] text-text-muted py-16 text-center w-full">
                    {hubFailed ? t('trendUnknown') : t('noTrendData')}
                  </p>
                ) : (
                  <div className="flex-1">
                    <BarOverviewChart
                      items={barItems}
                      height="100%"
                      maxVal={axis.max}
                      yAxisTicks={axis.ticks.map(String)}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-5 xl:col-span-4 flex flex-col">
              <div className="surface-panel p-6 rounded-[20px] h-full flex flex-col">
                <PanelHeader
                  title={t('assetMix')}
                  hint={t('assetMixHint', { total: assets?.total ?? 0 })}
                  action={<PanelLink href="/dashboard/assets">{t('viewDetails')}</PanelLink>}
                />
                <div className="mt-4 flex-1">
                  {hubFailed ? (
                    <p className="text-[13px] text-text-muted py-10 text-center">
                      {t('assetsUnknown')}
                    </p>
                  ) : assetRows.length === 0 ? (
                    <p className="text-[13px] text-text-muted py-10 text-center">
                      {t('noAssets')}
                    </p>
                  ) : (
                    <MeterList rows={assetRows} />
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* 1 — the exceptions, and what they are worth */}
            <div className="surface-panel p-6 rounded-[20px] h-full flex flex-col">
              <PanelHeader title={t('assetHealth')} hint={t('assetHealthHint')} />
              <p className="mt-3 text-[22px] font-semibold text-text-primary">
                {hubFailed || !assets ? '—' : formatAmountWithSymbol(assets.valueAtRisk)}
              </p>
              <p className="text-[12px] text-text-muted">{t('assetHealthHero')}</p>
              <div className="mt-4 flex-1">
                {hubFailed ? (
                  <p className="text-[13px] text-text-muted py-6">{t('assetsUnknown')}</p>
                ) : exceptionSegments.length === 0 ? (
                  <p className="text-[13px] text-text-muted py-6">{t('noAssetExceptions')}</p>
                ) : (
                  <SegmentedBar segments={exceptionSegments} legendColumns={2} />
                )}
              </div>
            </div>

            {/* 2 — the letter desk */}
            <div className="surface-panel p-6 rounded-[20px] h-full flex flex-col">
              <PanelHeader
                title={t('letterHealth')}
                hint={t('letterHealthHint')}
              />
              <p className="mt-3 text-[22px] font-semibold text-text-primary">
                {hubFailed || !letters || letters.avgIssueTurnaroundDays === null
                  ? '—'
                  : t('turnaroundDays', { days: letters.avgIssueTurnaroundDays })}
              </p>
              <p className="text-[12px] text-text-muted">
                {letters
                  ? t('letterHero', {
                      issued: letters.issuedInWindow,
                      period: windowLabel,
                    })
                  : ''}
              </p>
              <div className="mt-4 flex-1">
                {letterSegments.length === 0 ? (
                  <p className="text-[13px] text-text-muted py-6">
                    {hubFailed ? t('lettersUnknown') : t('noLetters')}
                  </p>
                ) : (
                  <SegmentedBar segments={letterSegments} legendColumns={2} />
                )}
              </div>
              {/* `LetterRequest` has `rejectedReason` but no `rejectedAt`, so a
                  rejection's turnaround is not recoverable. Said out loud
                  rather than quietly excluded from an average labelled "all". */}
              {letters && !letters.rejectTurnaroundMeasurable && (
                <p className="mt-3 text-[11px] text-text-muted">{t('rejectNotMeasured')}</p>
              )}
            </div>
          </div>
        </div>
      }
    />
  );
}

export default function WorkplaceHubPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <WorkplaceHubContent />
    </ProtectedRoute>
  );
}
