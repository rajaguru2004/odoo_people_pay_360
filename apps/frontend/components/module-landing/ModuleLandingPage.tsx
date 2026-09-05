'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { usePageHeader } from '@/hooks/usePageHeader';
import ModuleNavTiles, { type ModuleNavTilesProps } from './ModuleNavTiles';
import { KpiRow, type KpiStat } from './StatCard';
import { HeaderActionButtons, SegmentedTimeFilter } from './primitives';

export interface ModuleLandingPageProps {
  /** The nav group's labelKey — what the tiles and the trail resolve from. */
  moduleKey: string;
  /** Already translated. Feeds the single heading slot in Topbar. */
  title: string;
  subtitle?: string;
  kpis?: KpiStat[];
  kpisLoading?: boolean;
  /** Replaces the whole control row when a hub needs something else there. */
  headerControls?: ReactNode;
  /**
   * The period tabs, stepper and action row. Defaults to **false**.
   *
   * A hub that does not read a period must not draw one: the reader clicks
   * Week, sees the same numbers, and concludes the data did not change. Opt in
   * only alongside `timeFilter`/`onTimeFilterChange`.
   */
  showControls?: boolean;
  timeFilterOptions?: string[];
  /** Pass to control the tabs from the page, so the stepper and the charts agree. */
  timeFilter?: string;
  onTimeFilterChange?: (period: string) => void;
  /** Sits beside the tabs: the period being viewed, and the ‹ › that move it. */
  periodNav?: ReactNode;
  onExport?: () => void;
  exportBusy?: boolean;
  onAddNew?: () => void;
  /** Between the KPI row and the tiles: attention strips, charts, feeds. */
  insights?: ReactNode;
  /** Live counts on the tiles. */
  badges?: ModuleNavTilesProps['badges'];
  badgeTones?: ModuleNavTilesProps['badgeTones'];
  /** Anything below the tiles — the long tail of module-specific panels. */
  children?: ReactNode;
}

/**
 * The shell every module hub shares: what needs attention, then where you can
 * go.
 *
 * It declares the page heading through `usePageHeader` rather than painting one,
 * so a hub and a record page inside it look the same from the reader's side —
 * one title, in the bar, wherever they are.
 */
export default function ModuleLandingPage({
  moduleKey,
  title,
  subtitle,
  kpis,
  kpisLoading = false,
  headerControls,
  showControls = false,
  timeFilterOptions,
  timeFilter,
  onTimeFilterChange,
  periodNav,
  onExport,
  exportBusy = false,
  onAddNew,
  insights,
  badges,
  badgeTones,
  children,
}: ModuleLandingPageProps) {
  const t = useTranslations('moduleLanding');
  usePageHeader(title, subtitle);

  // The row draws while the figures are still loading, because the skeletons ARE
  // the row: leaving it out until the data lands makes the page jump.
  const showKpis = kpisLoading || Boolean(kpis?.length);

  return (
    <div className="space-y-6">
      {showControls && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          {headerControls ?? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <SegmentedTimeFilter
                  options={timeFilterOptions}
                  value={timeFilter}
                  onChange={onTimeFilterChange}
                />
                {periodNav}
              </div>
              <HeaderActionButtons
                onExport={onExport}
                exportBusy={exportBusy}
                onAddNew={onAddNew}
              />
            </>
          )}
        </div>
      )}

      {showKpis && <KpiRow stats={kpis ?? []} loading={kpisLoading} />}

      {insights}

      <section className="pt-2">
        <h2 className="mb-3.5 text-[15px] font-bold tracking-tight text-text-heading">
          {t('exploreModule')}
        </h2>
        <ModuleNavTiles moduleKey={moduleKey} badges={badges} badgeTones={badgeTones} />
      </section>

      {children}
    </div>
  );
}
