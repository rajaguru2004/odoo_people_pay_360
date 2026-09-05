'use client';

import { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { usePageHeader } from '@/hooks/usePageHeader';
import ModuleNavTiles, { type ModuleNavTilesProps } from './ModuleNavTiles';
import { KpiRow, type KpiStat } from './StatCard';
import { SegmentedTimeFilter, HeaderActionButtons } from './primitives';

export interface ModuleLandingPageProps {
  /** The nav group's labelKey — what the tiles and breadcrumbs resolve from. */
  moduleKey: string;
  /** Already translated. Feeds the single heading slot in TopHeader. */
  title: string;
  subtitle?: string;
  kpis?: KpiStat[];
  kpisLoading?: boolean;
  /** Custom header controls (time tabs, export, add new buttons). */
  headerControls?: ReactNode;
  /**
   * The period tabs + stepper + action row. Defaults to **false**.
   *
   * It used to default to true, which drew a `SegmentedTimeFilter` on all ten
   * hubs while only Time & Attendance passed `timeFilter`/`onTimeFilterChange`.
   * The other nine rendered tabs wired to nothing: they moved, and the page
   * did not. A control that does not control anything is worse than no control,
   * because the reader concludes the data did not change.
   */
  showControls?: boolean;
  /** Labels for the period tabs. Defaults to Week / Month / Years. */
  timeFilterOptions?: string[];
  /** Pass to control the tabs from the page — the hub does, so ‹ › agree. */
  timeFilter?: string;
  onTimeFilterChange?: (period: string) => void;
  /** Sits beside the tabs: the period being viewed, and the ‹ › that move it. */
  periodNav?: ReactNode;
  onExport?: () => void;
  exportBusy?: boolean;
  onAddNew?: () => void;
  /** Rendered between the KPI row and the tiles: strips, charts, feeds. */
  insights?: ReactNode;
  /** Live counts on the tiles. */
  badges?: ModuleNavTilesProps['badges'];
  badgeTones?: ModuleNavTilesProps['badgeTones'];
  /** Anything below the tiles — the long tail of module-specific widgets. */
  children?: ReactNode;
}

/**
 * The shape every module hub shares: what needs your attention, then where you
 * can go.
 *
 * Upgraded to match the Sellora reference design with clean time tabs,
 * action buttons, high-polish KPI stat cards, insights grid, and navigable tiles.
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

  const showKpis = kpisLoading || Boolean(kpis?.length);

  return (
    <div className="space-y-6">
      {/* Top Header Filter & Actions Row (Sellora Style) */}
      {showControls && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          {headerControls ? (
            headerControls
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <SegmentedTimeFilter
                  options={timeFilterOptions ?? ['Week', 'Month', 'Years']}
                  selected="Month"
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

      {/* KPI Stats Row */}
      {showKpis && <KpiRow stats={kpis ?? []} loading={kpisLoading} />}

      {/* Insights (Attention Strip, Bar Overview, Donut Charts, Progress Meters) */}
      {insights}

      {/* Explore Navigation Tiles */}
      <section className="pt-2">
        <h2 className="text-[15px] font-bold text-text-heading mb-3.5 tracking-tight">{t('exploreModule')}</h2>
        <ModuleNavTiles moduleKey={moduleKey} badges={badges} badgeTones={badgeTones} />
      </section>

      {children}
    </div>
  );
}
