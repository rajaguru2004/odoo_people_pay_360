'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Award, ClipboardCheck, GraduationCap, MessageSquareWarning, Gavel } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import AttentionStrip, { type AttentionItem } from '@/components/module-landing/AttentionStrip';
import type { KpiStat } from '@/components/module-landing/StatCard';
import {
  BarOverviewChart,
  DonutChart,
  DonutLegend,
  MeterList,
  PanelHeader,
  PanelLink,
  SegmentedBar,
  type BarOverviewItem,
  type BarSegment,
  type DonutSlice,
  type MeterRow,
} from '@/components/module-landing/primitives';
import { useTalentHub } from '@/hooks/useTalentHub';
import { ageInDays, toDelta } from '@/hooks/useModuleHub';
import { niceAxis, ratePct, sharePct } from '@/utils/hubAxis';

/**
 * Talent module hub — "how effectively are people developed, recognised and
 * heard".
 *
 * The version this replaces counted rewards and disciplinary actions in the
 * browser over one page of each list, and carried a panel saying so. Both
 * figures now come from the server, so that panel is gone and the space it took
 * is the recognition-balance panel it was apologising for.
 *
 * Three things this page will not claim, because the schema cannot support
 * them: an open disciplinary CASE (`Discipline` has no lifecycle — the KPI
 * counts actions recorded in the window and says so), an overdue appraisal (no
 * due date exists anywhere in the domain), and a workforce-wide appraisal
 * completion (`AppraisalRun` is a batch job, so completion is per-run).
 */
function TalentHubContent() {
  const t = useTranslations('talentHub');
  const tm = useTranslations('moduleLanding');
  const { summary, loading, hubFailed } = useTalentHub();

  const grievances = summary?.grievances;
  const training = summary?.training;
  const appraisal = summary?.appraisal;
  const conduct = summary?.conduct;
  const windowLabel = summary?.window.label ?? '';
  const prevLabel = summary?.window.previous.label ?? '';

  const num = (value: number | undefined | null) =>
    hubFailed || value === undefined || value === null ? null : value;

  const vsPrevious = t('vsPrevious', { period: prevLabel });
  const countDelta = (d: Parameters<typeof toDelta>[0], good: 'up' | 'down') =>
    toDelta(d, good, vsPrevious, (abs) => String(Math.round(abs)));

  const oldestOpenDays = ageInDays(grievances?.oldestOpenAt);

  const kpis: KpiStat[] = [
    {
      key: 'appraisal',
      label: t('kpiAppraisal'),
      // `null`, never 0% — a run that has not resolved its scope has not
      // measured anybody, and no run at all has not been asked to.
      value:
        hubFailed || !appraisal || appraisal.completionRate === null
          ? null
          : ratePct(appraisal.completionRate),
      icon: ClipboardCheck,
      tone: (appraisal?.completionRate ?? 0) >= 90 ? 'success' : 'default',
      delta: toDelta(appraisal?.completionDelta, 'up', vsPrevious, (abs) => `${abs.toFixed(1)} pts`),
      footnote: !appraisal
        ? undefined
        : !appraisal.referenceRun
          ? t('kpiAppraisalNoRun')
          : appraisal.referenceRun.totalEmployees === 0
            ? t('kpiAppraisalNoScope')
            : t('kpiAppraisalHint', {
                done: appraisal.referenceRun.completedEmployees,
                total: appraisal.referenceRun.totalEmployees,
                run: appraisal.referenceRun.periodLabel ?? appraisal.referenceRun.status,
              }),
      href: '/dashboard/appraisal',
    },
    {
      key: 'training',
      label: t('kpiTraining'),
      value:
        hubFailed || !training || training.completionRate === null
          ? null
          : ratePct(training.completionRate),
      icon: GraduationCap,
      tone: (training?.completionRate ?? 0) >= 80 ? 'success' : 'default',
      delta: countDelta(training?.attendedDelta, 'up'),
      footnote: training
        ? training.obligations === 0
          ? t('kpiTrainingNone')
          : t('kpiTrainingHint', { done: training.attended, total: training.obligations })
        : undefined,
      href: '/dashboard/training',
    },
    {
      key: 'grievances',
      label: t('kpiGrievances'),
      value: num(grievances?.open),
      icon: MessageSquareWarning,
      tone: (grievances?.olderThanAgingDays ?? 0) > 0 ? 'danger' : 'default',
      delta: countDelta(grievances?.openDelta, 'down'),
      footnote: grievances
        ? grievances.olderThanAgingDays > 0
          ? t('kpiGrievancesStale', {
              count: grievances.olderThanAgingDays,
              days: grievances.agingDays,
            })
          : t('kpiGrievancesFresh')
        : undefined,
      href: '/dashboard/grievances',
    },
    {
      key: 'rewards',
      label: t('kpiRewards'),
      value: num(conduct?.rewardsCount),
      icon: Award,
      tone: 'success',
      delta: countDelta(conduct?.rewardsDelta, 'up'),
      footnote: conduct ? t('kpiRewardsHint', { period: windowLabel }) : undefined,
      href: '/dashboard/rewards',
    },
    {
      key: 'disciplines',
      label: t('kpiDisciplines'),
      value: num(conduct?.disciplinesCount),
      icon: Gavel,
      tone: (conduct?.disciplinesCount ?? 0) > 0 ? 'warning' : 'default',
      delta: countDelta(conduct?.disciplinesDelta, 'down'),
      // Actions, not open cases. `Discipline` has no status, openedAt or
      // closedAt — there is no case to be open.
      footnote: t('kpiDisciplinesHint'),
      href: '/dashboard/disciplines',
    },
  ];

  const attentionItems: AttentionItem[] = useMemo(() => {
    if (hubFailed) {
      return [{ key: 'failed', label: t('readFailed'), severity: 'critical' as const }];
    }
    if (!summary) return [];

    const items: AttentionItem[] = [];

    if (summary.grievances.olderThanAgingDays > 0) {
      items.push({
        key: 'staleGrievances',
        label: t('attnStaleGrievances', {
          count: summary.grievances.olderThanAgingDays,
          days: summary.grievances.agingDays,
        }),
        detail: oldestOpenDays > 0 ? t('attnOldestOpen', { days: oldestOpenDays }) : undefined,
        severity: 'critical',
        href: '/dashboard/grievances',
      });
    }

    if (summary.grievances.unassignedOpen > 0) {
      items.push({
        key: 'unassigned',
        label: t('attnUnassigned', { count: summary.grievances.unassignedOpen }),
        severity: 'warning',
        href: '/dashboard/grievances',
      });
    }

    if (summary.training.sessionsEndedUnrecorded > 0) {
      items.push({
        key: 'unrecorded',
        // A session that has finished with its nominations still APPROVED means
        // nobody wrote down who turned up. The nearest thing to an overdue item
        // this module has, and it is a fact about a record rather than a guess.
        label: t('attnUnrecorded', { count: summary.training.sessionsEndedUnrecorded }),
        severity: 'warning',
        href: '/dashboard/training',
      });
    }

    if (summary.appraisal.failedOrDegraded > 0) {
      items.push({
        key: 'appraisalFailed',
        label: t('attnAppraisalFailed', { count: summary.appraisal.failedOrDegraded }),
        severity: 'warning',
        href: '/dashboard/appraisal',
      });
    }

    if (summary.training.certificatesExpiring60 > 0) {
      items.push({
        key: 'certs',
        label: t('attnCerts', { count: summary.training.certificatesExpiring60 }),
        severity: 'info',
        href: '/dashboard/training',
      });
    }

    return items;
  }, [summary, hubFailed, oldestOpenDays, t]);

  /** Twelve months of recognition against correction. */
  const { barItems, axis } = useMemo(() => {
    const buckets = summary?.trend ?? [];
    const lanes: Record<string, { label: string; color: string }> = {
      rewards: {
        label: t('laneRewards'),
        color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
      },
      disciplines: { label: t('laneDisciplines'), color: 'var(--color-status-warning)' },
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
        ...b.segments.map((s) => ({
          label: lanes[s.key]?.label ?? s.key,
          value: s.value,
          color: lanes[s.key]?.color,
        })),
        { label: t('laneTotal'), value: b.value, emphasis: true },
      ],
    }));

    return { barItems: items, axis: niceAxis(Math.max(1, ...buckets.map((b) => b.value))) };
  }, [summary, t]);

  /**
   * The grievance queue by status — the module's only real queue, and the one
   * status vocabulary here that a reader can act on.
   */
  const grievanceRows: MeterRow[] = useMemo(() => {
    const byStatus = grievances?.byStatus;
    if (!byStatus) return [];
    const order = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'CLOSED', 'WITHDRAWN'];
    const total = order.reduce((a, k) => a + (byStatus[k] ?? 0), 0);
    const openSet = new Set(grievances?.openStatuses ?? []);
    return order
      .filter((k) => (byStatus[k] ?? 0) > 0)
      .map((k) => ({
        key: k,
        label: t(`grievanceStatus.${k}` as any),
        percent: sharePct(byStatus[k], total),
        valueLabel: String(byStatus[k]),
        color: openSet.has(k)
          ? 'color-mix(in srgb, var(--color-status-warning) 85%, white)'
          : 'color-mix(in srgb, var(--color-brand-primary) 45%, white)',
      }));
  }, [grievances, t]);

  /** How the appraisal run in flight is going, per employee. */
  const appraisalSlices: DonutSlice[] = useMemo(() => {
    const results = appraisal?.resultsByStatus;
    if (!results) return [];
    const palette: Record<string, string> = {
      COMPLETED: 'color-mix(in srgb, var(--color-status-success) 85%, white)',
      PENDING: 'color-mix(in srgb, var(--color-brand-primary) 35%, white)',
      DEGRADED: 'var(--color-status-warning)',
      FAILED: 'var(--color-status-error)',
    };
    return ['COMPLETED', 'PENDING', 'DEGRADED', 'FAILED']
      .filter((k) => (results[k] ?? 0) > 0)
      .map((k) => ({
        key: k,
        label: t(`appraisalStatus.${k}` as any),
        value: results[k],
        color: palette[k],
      }));
  }, [appraisal, t]);

  /** Where nominations sit. */
  const trainingSegments: BarSegment[] = useMemo(() => {
    const n = training?.nominationsByStatus;
    if (!n) return [];
    const order: Array<[string, string]> = [
      ['ATTENDED', 'var(--color-status-success)'],
      ['APPROVED', 'color-mix(in srgb, var(--color-brand-primary) 70%, white)'],
      ['PENDING', 'var(--color-status-warning)'],
      ['NO_SHOW', 'var(--color-status-error)'],
      ['REJECTED', 'color-mix(in srgb, var(--color-border) 90%, white)'],
      ['CANCELLED', 'var(--color-border)'],
    ];
    const total = Math.max(1, order.reduce((a, [k]) => a + (n[k] ?? 0), 0));
    return order
      .filter(([k]) => (n[k] ?? 0) > 0)
      .map(([k, color]) => ({
        key: k,
        label: t(`nominationStatus.${k}` as any),
        value: n[k],
        color,
        shareLabel: `${Math.round((n[k] / total) * 100)}%`,
      }));
  }, [training, t]);

  /** Recognition against correction for the window — the balance, not a total. */
  const conductSegments: BarSegment[] = useMemo(() => {
    if (!conduct) return [];
    const total = Math.max(1, conduct.rewardsCount + conduct.disciplinesCount);
    return [
      {
        key: 'rewards',
        label: t('laneRewards'),
        value: conduct.rewardsCount,
        color: 'color-mix(in srgb, var(--color-status-success) 80%, white)',
        shareLabel: `${Math.round((conduct.rewardsCount / total) * 100)}%`,
      },
      {
        key: 'disciplines',
        label: t('laneDisciplines'),
        value: conduct.disciplinesCount,
        color: 'var(--color-status-warning)',
        shareLabel: `${Math.round((conduct.disciplinesCount / total) * 100)}%`,
      },
    ].filter((s) => s.value > 0);
  }, [conduct, t]);

  const chartEmpty = barItems.length === 0 || barItems.every((b) => b.value === 0);

  return (
    <ModuleLandingPage
      moduleKey="talent"
      title={tm('talent.title')}
      subtitle={tm('talent.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      badges={{ grievances: grievances?.open }}
      badgeTones={{
        grievances: (grievances?.olderThanAgingDays ?? 0) > 0 ? 'danger' : 'warning',
      }}
      insights={
        <div className="space-y-6">
          <AttentionStrip
            title={t('needsAttention')}
            items={attentionItems}
            loading={loading}
            emptyLabel={t('needsAttentionEmpty')}
            seeAll={{ label: t('seeGrievances'), href: '/dashboard/grievances' }}
          />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 xl:col-span-8 surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <PanelHeader
                title={t('conductTrend')}
                hint={t('conductTrendHint')}
                action={
                  <PanelLink href="/dashboard/rewards-disciplines">{t('viewDetails')}</PanelLink>
                }
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
                  title={t('grievanceMix')}
                  hint={t('grievanceMixHint')}
                  action={<PanelLink href="/dashboard/grievances">{t('seeGrievances')}</PanelLink>}
                />
                <div className="mt-4 flex-1">
                  {grievanceRows.length === 0 ? (
                    <p className="text-[13px] text-text-muted py-10 text-center">
                      {hubFailed ? t('grievancesUnknown') : t('noGrievances')}
                    </p>
                  ) : (
                    <MeterList rows={grievanceRows} />
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* 1 — the appraisal run in flight */}
            <div className="surface-panel p-6 rounded-[20px] h-full flex flex-col">
              <PanelHeader
                title={t('performanceHealth')}
                hint={t('performanceHealthHint')}
              />
              <div className="mt-4 flex-1 flex flex-col items-center justify-center gap-4">
                {hubFailed ? (
                  <p className="text-[13px] text-text-muted py-6 text-center">
                    {t('appraisalUnknown')}
                  </p>
                ) : appraisalSlices.length === 0 ? (
                  <p className="text-[13px] text-text-muted py-6 text-center">
                    {t('kpiAppraisalNoRun')}
                  </p>
                ) : (
                  <>
                    <DonutChart
                      slices={appraisalSlices}
                      size={150}
                      thickness={20}
                      caption={ratePct(appraisal?.completionRate ?? null)}
                      subCaption={t('appraisalDone')}
                    />
                    <DonutLegend
                      slices={appraisalSlices}
                      total={appraisalSlices.reduce((a, s) => a + s.value, 0)}
                    />
                  </>
                )}
              </div>
            </div>

            {/* 2 — the learning pipeline */}
            <div className="surface-panel p-6 rounded-[20px] h-full flex flex-col">
              <PanelHeader
                title={t('learningHealth')}
                hint={t('learningHealthHint')}
              />
              <p className="mt-3 text-[22px] font-semibold text-text-primary">
                {hubFailed || !training || training.completionRate === null
                  ? '—'
                  : ratePct(training.completionRate)}
              </p>
              <p className="text-[12px] text-text-muted">
                {training
                  ? t('learningHero', {
                      courses: training.activeCourses,
                      upcoming: training.upcomingSessions30Days,
                    })
                  : ''}
              </p>
              <div className="mt-4 flex-1">
                {trainingSegments.length === 0 ? (
                  <p className="text-[13px] text-text-muted py-6">
                    {hubFailed ? t('trainingUnknown') : t('noTraining')}
                  </p>
                ) : (
                  <SegmentedBar segments={trainingSegments} legendColumns={2} />
                )}
              </div>
            </div>

            {/* 3 — recognition against correction */}
            <div className="surface-panel p-6 rounded-[20px] h-full flex flex-col">
              <PanelHeader
                title={t('concernsHealth')}
                hint={t('concernsHealthHint', { period: windowLabel })}
              />
              <div className="mt-4 flex-1">
                {conductSegments.length === 0 ? (
                  <p className="text-[13px] text-text-muted py-6">
                    {hubFailed ? t('conductUnknown') : t('noConduct', { period: windowLabel })}
                  </p>
                ) : (
                  <SegmentedBar segments={conductSegments} legendColumns={2} />
                )}
              </div>
            </div>
          </div>
        </div>
      }
    />
  );
}

export default function TalentHubPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <TalentHubContent />
    </ProtectedRoute>
  );
}
