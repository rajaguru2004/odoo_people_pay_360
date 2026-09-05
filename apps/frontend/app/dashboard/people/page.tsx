'use client';

import { useTranslations } from 'next-intl';
import { ClipboardList, FileWarning, UserMinus, UserPlus, Users } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import AttentionStrip, { type AttentionItem } from '@/components/module-landing/AttentionStrip';
import type { KpiStat } from '@/components/module-landing/StatCard';
import {
  PanelHeader,
  SegmentedTimeFilter,
  SplineTrendChart,
  type SplineSeries,
} from '@/components/module-landing/primitives';
import EmployeeStatusDonut from '@/components/employees/hub/EmployeeStatusDonut';
import HeadcountMovement from '@/components/employees/hub/HeadcountMovement';
import LifecyclePanel from '@/components/employees/hub/LifecyclePanel';
import VisaRunwayBar from '@/components/employees/hub/VisaRunwayBar';
import { usePeopleHub, type TrendMonths } from '@/hooks/usePeopleHub';
import { daysUntilDate } from '@/utils/contractExpiry';
import { fullName } from '@/utils/formatters';

/**
 * The People hub — what is about to happen to the workforce.
 *
 * Every figure on it is a deadline or a movement. There is no headcount-by-
 * department panel here: Organisation owns the shape of the company and already
 * draws it, and two hubs repeating one distribution is what makes a product feel
 * like one long page.
 *
 * The 6M/12M switch sits in the trend panel's own header rather than in the page
 * header. Only that one chart is windowed, and a period control at the top would
 * promise it moves the deadline cards above it too.
 */
const MONTH_TABS: Array<{ label: string; value: TrendMonths }> = [
  { label: '6M', value: 6 },
  { label: '12M', value: 12 },
];

function PeopleHubContent() {
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

  /** A figure the aggregate did not answer for is null, never a zero. */
  const known = <T,>(value: T | undefined): T | null => (failed || !summary ? null : (value as T));

  const lifecycle = summary?.lifecycle;
  const probation = lifecycle?.probationEndingSoon ?? [];
  const joiners = lifecycle?.joinersThisMonth ?? 0;
  const leavers = lifecycle?.leaversThisMonth ?? 0;
  const previous = lifecycle?.previousMonth;
  const awaitingApproval = summary?.terminations.awaitingApproval ?? 0;

  /**
   * Permits are a separate module with its own answer, and the hub reads two
   * different silences from it.
   *
   * `visaUnavailable` means the whole module refused this caller: permits are
   * not part of their world, so they are left out of the tally and the panel
   * removes itself. `visaExpiringFailed` on its own means the request simply did
   * not come back — the permits ARE in scope and their number is unknown, which
   * is the one case where a total would be a quiet undercount.
   */
  const permitsInScope = !visaUnavailable;
  const permitsKnown = !visaExpiringFailed;
  const pendingPermits = permitsInScope && permitsKnown ? visaExpiring.length : 0;
  const pendingActions = pendingPermits + probation.length + awaitingApproval;
  const pendingUnknowable = failed || (permitsInScope && !permitsKnown);

  const kpis: KpiStat[] = [
    {
      key: 'active',
      label: 'Active employees',
      value: known(summary?.headcount.active),
      icon: Users,
      footnote: summary
        ? summary.headcount.inactive > 0
          ? `${summary.headcount.inactive} more on leave, suspended or terminated`
          : 'Everybody on the books is working'
        : undefined,
      href: '/dashboard/employees',
    },
    {
      key: 'joiners',
      label: 'Joined this month',
      value: known(joiners),
      icon: UserPlus,
      trend: summary?.trend.buckets.map((b) => b.joiners),
      // The delta names the window it is measured against, so the reader can go
      // and check it rather than trusting a bare "+4".
      delta:
        previous && previous.joiners !== joiners
          ? {
              value: joiners - previous.joiners,
              direction: joiners >= previous.joiners ? 'up' : 'down',
              goodDirection: 'up',
              display: `${joiners - previous.joiners > 0 ? '+' : ''}${joiners - previous.joiners}`,
              label: 'vs last month',
            }
          : undefined,
      footnote:
        lifecycle && lifecycle.startingSoon.length > 0
          ? `${lifecycle.startingSoon.length} more start in the next 30 days`
          : summary
            ? 'Nobody else is due to start'
            : undefined,
      href: '/dashboard/employees',
    },
    {
      key: 'terminations',
      label: 'Left this month',
      value: known(leavers),
      icon: UserMinus,
      trend: summary?.trend.buckets.map((b) => b.leavers),
      delta:
        previous && previous.leavers !== leavers
          ? {
              value: leavers - previous.leavers,
              direction: leavers >= previous.leavers ? 'up' : 'down',
              // Fewer people leaving is the good news here, so the arrow has to
              // be told which way is which before it picks a colour.
              goodDirection: 'down',
              display: `${leavers - previous.leavers > 0 ? '+' : ''}${leavers - previous.leavers}`,
              label: 'vs last month',
            }
          : undefined,
      tone: leavers > joiners ? 'warning' : 'default',
      footnote: summary
        ? awaitingApproval > 0
          ? `${awaitingApproval} termination${awaitingApproval === 1 ? '' : 's'} awaiting approval`
          : 'No terminations awaiting approval'
        : undefined,
      href: '/dashboard/contracts/terminations',
    },
    {
      key: 'contracts',
      label: 'Contracts expiring',
      value: known(summary?.contracts.expiringSoon),
      icon: FileWarning,
      tone: (summary?.contracts.expiringSoon ?? 0) > 0 ? 'warning' : 'success',
      footnote: 'Within the next 30 days',
      href: '/dashboard/contracts',
    },
    {
      key: 'pending',
      label: 'Needs HR now',
      value: pendingUnknowable ? null : pendingActions,
      icon: ClipboardList,
      tone: pendingActions > 0 ? 'warning' : 'success',
      footnote: summary
        ? `${permitsInScope ? `${permitsKnown ? pendingPermits : '—'} permits · ` : ''}${
            probation.length
          } probations · ${awaitingApproval} terminations`
        : undefined,
      // No drill-down on purpose: this card is a sum of three queues that live on
      // three screens, and picking one of them would send two thirds of the
      // readers to the wrong place. The strip below is the way in.
    },
  ];

  // ── Needs attention: every kind of deadline, soonest first ────────────────
  const attention: AttentionItem[] = [];

  // A failed aggregate has to be SAID. The permit queries answer separately, so
  // the strip is usually full of their items and the empty-state sentence never
  // renders — silence here would read as "the lifecycle is fine", which is the
  // one thing this page does not know.
  if (failed) {
    attention.push({
      key: 'lifecycle-failed',
      label: 'Lifecycle figures could not be read',
      severity: 'critical',
      href: '/dashboard/employees',
    });
  }

  if (permitsInScope && visaExpiringFailed) {
    attention.push({
      key: 'permits-failed',
      label: 'Permit expiries could not be read',
      detail: 'not an all-clear',
      severity: 'critical',
      href: '/dashboard/visa-reports',
    });
  }

  for (const permit of visaExpiring
    .slice()
    .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry)
    .slice(0, 6)) {
    attention.push({
      key: `visa-${permit.id}`,
      label: fullName(permit.employee) !== '—' ? fullName(permit.employee) : permit.documentNumber,
      detail:
        permit.daysUntilExpiry < 0
          ? `permit expired ${Math.abs(permit.daysUntilExpiry)}d ago`
          : `permit in ${permit.daysUntilExpiry}d`,
      severity: permit.daysUntilExpiry <= 7 ? 'critical' : 'warning',
      href: '/dashboard/visa-reports',
    });
  }

  for (const contract of (summary?.contracts.expiring ?? []).slice(0, 4)) {
    attention.push({
      key: `contract-${contract.id}`,
      label: contract.fullName ?? 'Unnamed employee',
      detail: `contract in ${contract.daysUntilExpiry}d`,
      severity: contract.daysUntilExpiry <= 7 ? 'critical' : 'warning',
      href: '/dashboard/contracts',
    });
  }

  for (const item of probation.slice(0, 3)) {
    // A confirmation date that slips means the person is confirmed by default —
    // a decision nobody actually took.
    const days = daysUntilDate(item.endDate);
    attention.push({
      key: `probation-${item.contractId}`,
      label: item.fullName ?? 'Unnamed employee',
      detail: `probation in ${days ?? 0}d`,
      severity: 'warning',
      href: '/dashboard/contracts',
    });
  }

  if (awaitingApproval > 0) {
    attention.push({
      key: 'terminations-pending',
      label: `${awaitingApproval} termination${awaitingApproval === 1 ? '' : 's'} awaiting approval`,
      detail: 'review',
      severity: 'info',
      href: '/dashboard/contracts/terminations',
    });
  }

  // ── The workforce as a flow ───────────────────────────────────────────────
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
        // Undefined rather than zero when the list failed: a tile with no badge
        // says nothing, and a tile badged "0" says the queue is empty.
        visaReports: permitsInScope && permitsKnown ? visaExpiring.length : undefined,
      }}
      badgeTones={{ allContracts: 'warning', visaReports: 'danger' }}
      insights={
        <div className="space-y-6">
          <AttentionStrip
            title="Needs attention"
            items={attention}
            loading={loading || visaLoading}
            emptyLabel={
              failed
                ? 'Lifecycle figures could not be read.'
                : 'Nothing falls due in the next 30 days.'
            }
            seeAll={{ label: 'See contracts', href: '/dashboard/contracts' }}
          />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6 lg:col-span-7 xl:col-span-8">
              <PanelHeader
                title="Workforce trend"
                // States the identity the chart draws, so nobody has to work out
                // whether the line is a stock or a flow.
                hint="Arrivals and departures per month — not the running headcount."
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
              />

              <div className="mb-3 mt-1 flex flex-wrap items-baseline gap-4">
                <div>
                  <span className="text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-text-heading">
                    {known(summary?.headcount.active) ?? '—'}
                  </span>
                  <span className="ms-2 text-xs font-semibold text-text-muted">on staff today</span>
                </div>
                <div className="flex items-center gap-3 text-[11px] font-medium text-text-muted">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-xs"
                      style={{
                        background: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
                      }}
                    />
                    Joined
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-xs"
                      style={{
                        background: 'color-mix(in srgb, var(--color-brand-accent) 75%, white)',
                      }}
                    />
                    Left
                  </span>
                </div>
              </div>

              {/* Dimmed while a period switch is in flight, so the old series is
                  visibly stale rather than silently passing for the new one. */}
              <div className={`min-h-[200px] flex-1 ${fetching ? 'opacity-60 transition-opacity' : ''}`}>
                <SplineTrendChart
                  height={200}
                  series={loading ? undefined : trendSeries}
                  timeTicks={trendTicks}
                  emptyLabel={failed ? 'Not available right now' : 'No movement in this window'}
                />
              </div>
            </div>

            <div className="flex flex-col lg:col-span-5 xl:col-span-4">
              <EmployeeStatusDonut
                split={summary?.statusSplit}
                total={summary ? summary.headcount.active + summary.headcount.inactive : undefined}
                loading={loading}
                failed={failed}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            <LifecyclePanel summary={summary} loading={loading} failed={failed} />

            {/* One module's 403 must not blank the row. When permits are out of
                reach the runway panel is dropped and the movement panel takes
                the space, rather than leaving a hole where a card used to be. */}
            {visaUnavailable ? (
              <HeadcountMovement summary={summary} loading={loading} failed={failed} />
            ) : (
              <>
                <VisaRunwayBar
                  summary={visaSummary}
                  expiring={visaExpiring}
                  loading={visaLoading}
                  unavailable={visaUnavailable}
                  expiringFailed={visaExpiringFailed}
                />
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
