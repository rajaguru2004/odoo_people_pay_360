'use client';

import { useTranslations } from 'next-intl';
import { UserPlus, FileWarning, UserMinus, Users, ClipboardList } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import AttentionStrip, { type AttentionItem } from '@/components/module-landing/AttentionStrip';
import type { KpiStat } from '@/components/module-landing/StatCard';
import VisaRunwayBar from '@/components/employees/hub/VisaRunwayBar';
import EmployeeStatusDonut from '@/components/employees/hub/EmployeeStatusDonut';
import LifecyclePanel from '@/components/employees/hub/LifecyclePanel';
import HeadcountMovement from '@/components/employees/hub/HeadcountMovement';
import {
  PanelHeader,
  PanelLink,
  SegmentedTimeFilter,
  SplineTrendChart,
  type SplineSeries,
} from '@/components/module-landing/primitives';
import { daysUntil, usePeopleHub, type TrendMonths } from '@/hooks/usePeopleHub';

/**
 * People module hub — what is about to happen to the workforce.
 *
 * Laid out on the finalised Time & Attendance template: five KPIs, an attention
 * strip, one big chart beside a breakdown, three insight panels, then the tiles.
 *
 * Every figure is a deadline or a movement. The headcount-by-department panel
 * lives on Organization and only there — three hubs drawing the same
 * distribution is what made them feel like one page. There is no "on leave
 * today" card either: Time & Attendance owns today, and already prints it.
 *
 * The page header carries no period filter. Only the workforce trend is
 * windowed, so the 6M/12M switch sits in that panel's own header rather than
 * implying it moves the four deadline cards above it.
 */
const MONTH_TABS: Array<{ label: string; value: TrendMonths }> = [
  { label: '6M', value: 6 },
  { label: '12M', value: 12 },
];

function PeopleHubContent() {
  const t = useTranslations('peopleHub');
  const tm = useTranslations('moduleLanding');
  const {
    summary,
    months,
    setMonths,
    loading,
    fetching,
    failed,
    visaSummary,
    visaExpiring,
    visaLoading,
    visaUnavailable,
    visaExpiringFailed,
  } = usePeopleHub(30);

  const known = <T,>(value: T | undefined): T | null => (failed || !summary ? null : (value as T));

  const lifecycle = summary?.lifecycle;
  const probation = lifecycle?.probationEndingSoon ?? [];
  const joiners = lifecycle?.joinersThisMonth ?? 0;
  const leavers = lifecycle?.leaversThisMonth ?? 0;
  const prev = lifecycle?.previousMonth;

  // "Needs HR now", summed rather than listed on the card — the footnote splits
  // it so the number is never a mystery.
  const pendingPermits = visaExpiringFailed ? 0 : visaExpiring.length;
  const pendingActions =
    pendingPermits + probation.length + (summary?.terminations.awaitingApproval ?? 0);

  // ── KPI row ───────────────────────────────────────────────────────────────
  const kpis: KpiStat[] = [
    {
      key: 'active',
      label: t('kpiActive'),
      value: known(summary?.headcount.active),
      icon: Users,
      footnote: summary
        ? summary.headcount.inactive > 0
          ? t('kpiActiveHint', { count: summary.headcount.inactive })
          : t('kpiActiveAllOn')
        : undefined,
      href: '/dashboard/employees',
    },
    {
      key: 'joiners',
      label: t('kpiJoiners'),
      value: known(joiners),
      icon: UserPlus,
      trend: summary?.trend.buckets.map((b) => b.joiners),
      // Labelled against a window the reader can actually navigate to and
      // check, rather than a bare "+4".
      delta:
        prev && prev.joiners !== joiners
          ? {
              value: joiners - prev.joiners,
              direction: joiners >= prev.joiners ? 'up' : 'down',
              goodDirection: 'up',
              display: `${joiners - prev.joiners > 0 ? '+' : ''}${joiners - prev.joiners}`,
              label: t('vsLastMonth'),
            }
          : undefined,
      footnote:
        lifecycle && lifecycle.startingSoon.length > 0
          ? t('kpiJoinersStartingSoon', { count: lifecycle.startingSoon.length })
          : summary
          ? t('kpiJoinersNoneAhead')
          : undefined,
      href: '/dashboard/employees',
    },
    {
      key: 'terminations',
      label: t('kpiTerminations'),
      value: known(leavers),
      icon: UserMinus,
      trend: summary?.trend.buckets.map((b) => b.leavers),
      delta:
        prev && prev.leavers !== leavers
          ? {
              value: leavers - prev.leavers,
              direction: leavers >= prev.leavers ? 'up' : 'down',
              // Fewer people leaving is the good direction, so the arrow's
              // colour has to be told which way is which.
              goodDirection: 'down',
              display: `${leavers - prev.leavers > 0 ? '+' : ''}${leavers - prev.leavers}`,
              label: t('vsLastMonth'),
            }
          : undefined,
      tone: leavers > joiners ? 'warning' : 'default',
      footnote: summary
        ? summary.terminations.awaitingApproval > 0
          ? t('kpiTerminationsPending', { count: summary.terminations.awaitingApproval })
          : t('kpiTerminationsNonePending')
        : undefined,
      href: '/dashboard/contracts/terminations',
    },
    {
      key: 'contracts',
      label: t('kpiContractsExpiring'),
      value: known(summary?.contracts.expiringSoon),
      icon: FileWarning,
      tone: (summary?.contracts.expiringSoon ?? 0) > 0 ? 'warning' : 'success',
      footnote: t('kpiContractsHint'),
      href: '/dashboard/contracts',
    },
    {
      key: 'pending',
      label: t('kpiPendingActions'),
      // Not `0` when the permit lookup failed — an unknown count reported as
      // zero is an all-clear nobody checked.
      value: failed ? null : pendingActions,
      icon: ClipboardList,
      tone: pendingActions > 0 ? 'warning' : 'success',
      // The approvals queue, not the directory: three KPI cards pointing at one
      // list is three ways of saying "go and look at everybody".
      footnote: summary
        ? t('kpiPendingSplit', {
            permits: visaExpiringFailed ? '—' : String(pendingPermits),
            probations: probation.length,
            terminations: summary.terminations.awaitingApproval,
          })
        : undefined,
      href: '/dashboard/approvals',
    },
  ];

  // ── Needs attention: both kinds of expiry, soonest first ──────────────────
  const attention: AttentionItem[] = [];
  // A failed aggregate has to be SAID, not just implied by an empty state: the
  // permit queries answer separately, so the strip is usually full of their
  // items and the empty-state sentence never renders. Silence there would read
  // as "the lifecycle is fine", which is the one thing the page does not know.
  if (failed) {
    attention.push({
      key: 'lifecycle-failed',
      label: t('lifecycleUnknown'),
      severity: 'critical',
      href: '/dashboard/employees',
    });
  }
  for (const v of visaExpiring.slice().sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry).slice(0, 6)) {
    attention.push({
      key: `visa-${v.id}`,
      label: v.employee?.fullName ?? v.documentNumber,
      detail:
        v.daysUntilExpiry < 0
          ? t('expiredAgo', { days: Math.abs(v.daysUntilExpiry) })
          : t('permitInDays', { days: v.daysUntilExpiry }),
      severity: v.daysUntilExpiry <= 7 ? 'critical' : 'warning',
      href: '/dashboard/visa-reports',
    });
  }
  for (const c of (summary?.contracts.expiring ?? []).slice(0, 4)) {
    attention.push({
      key: `contract-${c.id}`,
      label: c.fullName ?? t('unnamedEmployee'),
      detail: t('contractInDays', { days: c.daysUntilExpiry }),
      severity: c.daysUntilExpiry <= 7 ? 'critical' : 'warning',
      href: '/dashboard/contracts',
    });
  }
  for (const p of probation.slice(0, 3)) {
    const days = daysUntil(p.endDate);
    attention.push({
      key: `probation-${p.contractId}`,
      label: p.fullName ?? t('unnamedEmployee'),
      // A confirmation date that slips means the person is confirmed by
      // default — a decision nobody actually took.
      detail: t('probationInDays', { days: days ?? 0 }),
      severity: 'warning',
      href: '/dashboard/contracts',
    });
  }
  if (summary && summary.terminations.awaitingApproval > 0) {
    attention.push({
      key: 'terminations-pending',
      label: t('attnTerminations', { count: summary.terminations.awaitingApproval }),
      detail: t('review'),
      severity: 'info',
      href: '/dashboard/contracts/terminations',
    });
  }

  // ── Main chart: the workforce as a flow ───────────────────────────────────
  const buckets = summary?.trend.buckets ?? [];
  const trendSeries: SplineSeries[] = buckets.length
    ? [
        {
          key: 'joiners',
          values: buckets.map((b) => b.joiners),
          color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
        },
        {
          key: 'leavers',
          values: buckets.map((b) => b.leavers),
          color: 'color-mix(in srgb, var(--color-brand-accent) 75%, white)',
        },
      ]
    : [];
  const trendTicks = buckets.map((b) => b.label.split(' ')[0]);
  const activeMonthLabel = MONTH_TABS.find((m) => m.value === months)?.label ?? '6M';

  return (
    <ModuleLandingPage
      moduleKey="people"
      title={tm('people.title')}
      subtitle={tm('people.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      badges={{
        allContracts: summary?.contracts.expiringSoon,
        visaReports: visaExpiringFailed ? undefined : visaExpiring.length,
      }}
      badgeTones={{ allContracts: 'warning', visaReports: 'danger' }}
      insights={
        <div className="space-y-6">
          <AttentionStrip
            title={t('needsAttention')}
            items={attention}
            loading={loading || visaLoading}
            emptyLabel={
              visaExpiringFailed
                ? t('expiringSoonUnknown')
                : failed
                ? t('lifecycleUnknown')
                : t('nothingDue')
            }
            seeAll={{ label: t('seeContracts'), href: '/dashboard/contracts' }}
          />

          {/* Middle row: the flow over time, and where everybody stands today */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 xl:col-span-8 surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <PanelHeader
                title={t('workforceTrend')}
                // States the identity the chart draws, so nobody has to guess
                // whether the line is a stock or a flow.
                hint={t('workforceTrendHint')}
                action={
                  <SegmentedTimeFilter
                    options={MONTH_TABS.map((m) => m.label)}
                    value={activeMonthLabel}
                    onChange={(label) => {
                      const found = MONTH_TABS.find((m) => m.label === label);
                      if (found) setMonths(found.value);
                    }}
                  />
                }
                showMenu={false}
              />

              <div className="flex items-baseline gap-4 mt-1 mb-3">
                <div>
                  <span className="text-[28px] font-extrabold text-text-heading tracking-tight leading-none tabular-nums">
                    {known(summary?.headcount.active) ?? '—'}
                  </span>
                  <span className="ml-2 text-xs font-semibold text-text-muted">
                    {t('onStaff')}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[11px] font-medium text-text-muted">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-xs"
                      style={{ background: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)' }}
                    />
                    {t('joiners')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-xs"
                      style={{ background: 'color-mix(in srgb, var(--color-brand-accent) 75%, white)' }}
                    />
                    {t('leavers')}
                  </span>
                </div>
              </div>

              <div className={`flex-1 min-h-[200px] ${fetching ? 'opacity-60 transition-opacity' : ''}`}>
                <SplineTrendChart
                  height={200}
                  series={loading ? undefined : trendSeries}
                  timeTicks={trendTicks}
                  emptyLabel={failed ? t('chartUnavailable') : t('noMovement')}
                />
              </div>
            </div>

            <div className="lg:col-span-5 xl:col-span-4 flex flex-col">
              <EmployeeStatusDonut
                split={summary?.statusSplit}
                total={summary ? summary.headcount.active + summary.headcount.inactive : undefined}
                loading={loading}
                failed={failed}
              />
            </div>
          </div>

          {/* Bottom row: what is due, permit runway, and the direction of travel */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <LifecyclePanel summary={summary} loading={loading} failed={failed} />

            {visaUnavailable ? (
              // The permit module is unreachable — the card has nothing to say
              // and is dropped rather than shown empty. HeadcountMovement takes
              // the space so the row does not end in a hole.
              <HeadcountMovement summary={summary} loading={loading} failed={failed} />
            ) : (
              <>
                <div className="h-full">
                  <VisaRunwayBar
                    summary={visaSummary}
                    expiring={visaExpiring}
                    loading={visaLoading}
                    unavailable={visaUnavailable}
                  />
                  {visaExpiringFailed && (
                    <p className="mt-2 text-[11px] text-status-warning leading-snug">
                      {t('permitListFailed')}
                    </p>
                  )}
                </div>
                <HeadcountMovement summary={summary} loading={loading} failed={failed} />
              </>
            )}
          </div>
        </div>
      }
    />
  );
}

export default function PeopleHubPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <PeopleHubContent />
    </ProtectedRoute>
  );
}
