'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { HandCoins, Receipt, Plane, PieChart, Banknote } from 'lucide-react';
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
import { useFinanceHub } from '@/hooks/useFinanceHub';
import { toDelta } from '@/hooks/useModuleHub';
import { formatAmountWithSymbol } from '@/utils/formatters';
import { compactNumber, niceAxis, ratePct, sharePct } from '@/utils/hubAxis';

/**
 * Finance module hub — "what is the company's exposure to employee money".
 *
 * Built on the Time & Attendance template: five KPIs, an attention strip, one
 * headline trend beside a breakdown, three insight panels, then the tiles. No
 * period filter — `showControls` is omitted, which is what removes the
 * Today/Week/Month/Year row.
 *
 * The headline is settled expense over twelve months rather than budget-vs-plan
 * because it is the only series here where every unit is real money that has
 * actually left the company on a real date. The loan book is a stock, not a
 * flow, and budget variance is fiscal-year-bound — the right shape for the
 * breakdown beside the chart, not for the chart itself.
 */
function FinanceHubContent() {
  const t = useTranslations('financeHub');
  const tm = useTranslations('moduleLanding');
  const { summary, loading, hubFailed } = useFinanceHub();

  const claims = summary?.reimbursements;
  const travel = summary?.travel;
  const loans = summary?.loans;
  const budgets = summary?.budgets;
  const windowLabel = summary?.window.label ?? '';
  const prevLabel = summary?.window.previous.label ?? '';

  /** Money, or an em dash when the read failed. Never a zero standing in. */
  const money = (value: number | undefined | null) =>
    hubFailed || value === undefined || value === null ? null : formatAmountWithSymbol(value);

  const vsPrevious = t('vsPrevious', { period: prevLabel });
  const moneyDelta = (d: Parameters<typeof toDelta>[0], good: 'up' | 'down') =>
    toDelta(d, good, vsPrevious, (abs) => formatAmountWithSymbol(abs));

  const worstBucket = useMemo(() => {
    const buckets = loans?.overdue.buckets;
    if (!buckets) return undefined;
    return ['90+', '61-90', '31-60', '1-30'].find((k) => (buckets[k]?.count ?? 0) > 0);
  }, [loans]);

  /** Budgets between 90% and 100% used — spent, but not yet a breach. */
  const nearingLimit = useMemo(
    () =>
      (budgets?.rows ?? []).filter(
        (r) => r.utilization !== null && r.utilization >= 90 && r.utilization <= 100,
      ).length,
    [budgets],
  );

  const kpis: KpiStat[] = [
    {
      key: 'claimsPending',
      label: t('kpiClaims'),
      value: money(claims?.pendingAmount),
      icon: Receipt,
      tone: (claims?.olderThan7Days ?? 0) > 0 ? 'warning' : 'default',
      // No delta: a pending queue cannot be reconstructed for a past date —
      // `Reimbursement` has no `rejectedAt`, so a claim rejected inside the
      // window would silently vanish from the baseline.
      footnote: claims
        ? claims.olderThan7Days > 0
          ? t('kpiClaimsStale', { count: claims.pendingCount, stale: claims.olderThan7Days })
          : t('kpiClaimsCount', { count: claims.pendingCount })
        : undefined,
      href: '/dashboard/reimbursements',
    },
    {
      key: 'reimbursed',
      label: t('kpiReimbursed'),
      value: money(claims?.paidAmount),
      icon: Banknote,
      delta: moneyDelta(claims?.paidDelta, 'down'),
      // `PAID` is written by payroll at LOCK, so this figure moves when a run
      // locks rather than when an approver clicks.
      footnote: claims ? t('kpiReimbursedHint', { count: claims.paidCount }) : undefined,
      href: '/dashboard/reimbursements',
    },
    {
      key: 'travel',
      label: t('kpiTravelSpend'),
      value: money(travel?.perDiemPaidAmount),
      icon: Plane,
      delta: moneyDelta(travel?.perDiemDelta, 'down'),
      // The card says "per diem" because that is all this schema can measure:
      // there is no travel-actuals column and no trip settlement step, so
      // flights and hotels only appear if somebody raises a claim by hand.
      footnote: t('kpiTravelSpendHint'),
      href: '/dashboard/travel',
    },
    {
      key: 'outstanding',
      label: t('kpiOutstanding'),
      value: money(loans?.outstanding),
      icon: HandCoins,
      tone: (loans?.overdue.count ?? 0) > 0 ? 'warning' : 'default',
      delta: moneyDelta(loans?.outstandingDelta, 'down'),
      footnote: loans ? t('kpiOutstandingHint', { count: loans.accounts }) : undefined,
      href: '/dashboard/advance-loans/reports',
    },
    {
      key: 'budgetUse',
      label: t('kpiBudgetUse'),
      value: hubFailed || !budgets || budgets.utilization === null ? null : ratePct(budgets.utilization),
      icon: PieChart,
      tone:
        (budgets?.utilization ?? 0) > 100
          ? 'danger'
          : (budgets?.utilization ?? 0) >= 90
            ? 'warning'
            : 'default',
      delta: toDelta(budgets?.utilizationDelta, 'down', vsPrevious, (abs) => `${abs.toFixed(1)} pts`),
      footnote: budgets
        ? budgets.planned === 0
          ? t('kpiBudgetUseNoPlan')
          : t('kpiBudgetUseHint', { over: budgets.overBudget, count: budgets.budgets })
        : undefined,
      href: '/dashboard/budgets',
    },
  ];

  const attentionItems: AttentionItem[] = useMemo(() => {
    // A failed read must never render as an all-clear. The strip says so
    // instead of showing its empty state, which reads as "nothing to do".
    if (hubFailed) {
      return [{ key: 'failed', label: t('readFailed'), severity: 'critical' as const }];
    }
    if (!summary) return [];

    const items: AttentionItem[] = [];

    if (summary.reimbursements.olderThan7Days > 0) {
      items.push({
        key: 'staleClaims',
        label: t('attnStaleClaims', { count: summary.reimbursements.olderThan7Days }),
        detail: t('attnStaleClaimsDetail'),
        severity: 'warning',
        href: '/dashboard/reimbursements',
      });
    }

    if (summary.loans.overdue.count > 0) {
      items.push({
        key: 'overdueLoans',
        label: t('attnOverdueLoans', { count: summary.loans.overdue.count }),
        detail: formatAmountWithSymbol(summary.loans.overdue.amount),
        // A 90+ bucket is a different conversation from a missed EMI last week.
        severity: (summary.loans.overdue.buckets['90+']?.count ?? 0) > 0 ? 'critical' : 'warning',
        href: '/dashboard/advance-loans/reports',
      });
    }

    if (summary.budgets.overBudget > 0) {
      items.push({
        key: 'overBudget',
        label: t('attnOverBudget', { count: summary.budgets.overBudget }),
        severity: 'critical',
        href: '/dashboard/budgets',
      });
    }

    if (nearingLimit > 0) {
      items.push({
        key: 'nearLimit',
        label: t('attnNearLimit', { count: nearingLimit }),
        severity: 'warning',
        href: '/dashboard/budgets',
      });
    }

    if (summary.travel.pending > 0) {
      items.push({
        key: 'travelPending',
        label: t('attnTravelPending', { count: summary.travel.pending }),
        severity: 'info',
        href: '/dashboard/travel',
      });
    }

    return items;
  }, [summary, hubFailed, nearingLimit, t]);

  /** Twelve months of settled expense, stacked by category. */
  const { barItems, axis } = useMemo(() => {
    const buckets = summary?.trend ?? [];
    const lanes: Record<string, { label: string; color: string }> = {
      travel: { label: t('laneTravel'), color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)' },
      training: { label: t('laneTraining'), color: 'var(--color-status-info, #3B82F6)' },
      other: { label: t('laneOther'), color: 'color-mix(in srgb, var(--color-brand-primary) 35%, white)' },
    };

    // Open the tooltip on the most recent month that has anything in it —
    // pinning it to the current month puts a card of zeros on screen on the
    // first of every month, which reads as a broken dashboard rather than as a
    // month that has not happened yet.
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
          value: formatAmountWithSymbol(s.value),
          color: lanes[s.key]?.color,
        })),
        { label: t('laneTotal'), value: formatAmountWithSymbol(b.value), emphasis: true },
      ],
    }));

    return {
      barItems: items,
      axis: niceAxis(Math.max(1, ...buckets.map((b) => b.value))),
    };
  }, [summary, t]);

  /** Where the settled money went this window. */
  const categoryRows: MeterRow[] = useMemo(() => {
    const rows = claims?.byCategory ?? [];
    const total = rows.reduce((a, r) => a + r.amount, 0);
    return rows.slice(0, 6).map((r, i) => ({
      key: r.key,
      label: r.label,
      percent: sharePct(r.amount, total),
      valueLabel: formatAmountWithSymbol(r.amount),
      color: `color-mix(in srgb, var(--color-brand-primary) ${Math.max(30, 92 - i * 12)}%, white)`,
    }));
  }, [claims]);

  /** Claim states. Counts, not money — the queue is what this panel is about. */
  const claimSegments: BarSegment[] = useMemo(() => {
    const byStatus = claims?.byStatus;
    if (!byStatus) return [];
    const order: Array<[string, string, string]> = [
      ['PENDING', t('segPending'), 'var(--color-status-warning)'],
      ['APPROVED', t('segApproved'), 'color-mix(in srgb, var(--color-brand-primary) 60%, white)'],
      ['PAID', t('segPaid'), 'var(--color-status-success)'],
      ['REJECTED', t('segRejected'), 'var(--color-status-error)'],
      ['CANCELLED', t('segCancelled'), 'var(--color-border)'],
    ];
    const total = Math.max(1, order.reduce((a, [k]) => a + (byStatus[k]?.count ?? 0), 0));
    return order
      .filter(([k]) => (byStatus[k]?.count ?? 0) > 0)
      .map(([k, label, color]) => ({
        key: k,
        label,
        value: byStatus[k].count,
        color,
        shareLabel: `${Math.round((byStatus[k].count / total) * 100)}%`,
      }));
  }, [claims, t]);

  /** How late the arrears are — the server's own buckets, not a re-derivation. */
  const agingRows: MeterRow[] = useMemo(() => {
    const buckets = loans?.overdue.buckets;
    if (!buckets) return [];
    const total = Math.max(1, loans!.overdue.amount);
    const shades = ['#F5B94B', '#F09A3E', '#E5714A', '#D64545'];
    return ['1-30', '31-60', '61-90', '90+'].map((key, i) => ({
      key,
      label: t('daysOverdue', { range: key.replace('-', '–') }),
      percent: sharePct(buckets[key]?.amount ?? 0, total),
      valueLabel: formatAmountWithSymbol(buckets[key]?.amount ?? 0),
      color: shades[i],
    }));
  }, [loans, t]);

  /** Plan against commitment and spend. */
  const budgetSlices: DonutSlice[] = useMemo(() => {
    if (!budgets) return [];
    return [
      {
        key: 'actual',
        label: t('sliceActual'),
        value: Math.max(0, budgets.actual),
        color: 'color-mix(in srgb, var(--color-brand-primary) 90%, white)',
      },
      {
        key: 'committed',
        label: t('sliceCommitted'),
        value: Math.max(0, budgets.committed),
        color: 'var(--color-status-warning)',
      },
      {
        key: 'remaining',
        label: t('sliceRemaining'),
        // A negative remaining is an over-run, and a donut cannot draw one.
        // The utilisation caption above it carries that signal instead.
        value: Math.max(0, budgets.remaining),
        color: 'color-mix(in srgb, var(--color-brand-primary) 25%, white)',
      },
    ];
  }, [budgets, t]);

  const chartEmpty = barItems.length === 0 || barItems.every((b) => b.value === 0);

  return (
    <ModuleLandingPage
      moduleKey="finance"
      title={tm('finance.title')}
      subtitle={tm('finance.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      badges={{ reimbursements: claims?.pendingCount }}
      badgeTones={{
        reimbursements: (claims?.olderThan7Days ?? 0) > 0 ? 'danger' : 'warning',
      }}
      insights={
        <div className="space-y-6">
          <AttentionStrip
            title={t('needsAttention')}
            items={attentionItems}
            loading={loading}
            emptyLabel={t('needsAttentionEmpty')}
            seeAll={{ label: t('seeLoanReports'), href: '/dashboard/advance-loans/reports' }}
          />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 xl:col-span-8 surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <PanelHeader
                title={t('expenseTrend')}
                hint={t('expenseTrendHint')}
                action={<PanelLink href="/dashboard/reimbursements">{t('viewDetails')}</PanelLink>}
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
                      yAxisTicks={axis.ticks.map(compactNumber)}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-5 xl:col-span-4 flex flex-col">
              <div className="surface-panel p-6 rounded-[20px] h-full flex flex-col">
                <PanelHeader
                  title={t('expenseMix')}
                  hint={t('expenseMixHint', { period: windowLabel })}
                  action={<PanelLink href="/dashboard/budgets">{t('seeBudgets')}</PanelLink>}
                />
                <div className="mt-4 flex-1">
                  {categoryRows.length === 0 ? (
                    <p className="text-[13px] text-text-muted py-10 text-center">
                      {hubFailed ? t('mixUnknown') : t('noExpenseMix')}
                    </p>
                  ) : (
                    <MeterList rows={categoryRows} />
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* 1 — the claim queue */}
            <div className="surface-panel p-6 rounded-[20px] h-full flex flex-col">
              <PanelHeader title={t('claimHealth')} hint={t('claimHealthHint')} />
              <p className="mt-3 text-[22px] font-semibold text-text-primary">
                {money(claims?.pendingAmount) ?? '—'}
              </p>
              <p className="text-[12px] text-text-muted">{t('claimHealthHero')}</p>
              <div className="mt-4 flex-1">
                {claimSegments.length === 0 ? (
                  <p className="text-[13px] text-text-muted py-6">
                    {hubFailed ? t('claimsUnknown') : t('noClaims')}
                  </p>
                ) : (
                  <SegmentedBar segments={claimSegments} legendColumns={2} />
                )}
              </div>
              {/* `PAID` is written by payroll at LOCK, not by an approver, so
                  this panel does not move when a claim is approved. Said in the
                  body rather than the header hint: a hint long enough to say it
                  gets crushed to one word per line in a 3-across column. */}
              <p className="mt-3 text-[11px] text-text-muted">{t('claimPaidNote')}</p>
            </div>

            {/* 2 — the loan book, and what has slipped */}
            <div className="surface-panel p-6 rounded-[20px] h-full flex flex-col">
              <PanelHeader
                title={t('loanHealth')}
                hint={t('loanHealthHint')}
              />
              <p className="mt-3 text-[22px] font-semibold text-text-primary">
                {money(loans?.outstanding) ?? '—'}
              </p>
              <p className="text-[12px] text-text-muted">
                {worstBucket ? t('kpiOverdueWorst', { bucket: worstBucket }) : t('kpiOverdueClear')}
              </p>
              <div className="mt-4 flex-1">
                {hubFailed ? (
                  <p className="text-[13px] text-text-muted py-6">{t('chaseUnknown')}</p>
                ) : (loans?.overdue.count ?? 0) === 0 ? (
                  <p className="text-[13px] text-text-muted py-6">{t('nothingOverdue')}</p>
                ) : (
                  <MeterList rows={agingRows} />
                )}
              </div>
            </div>

            {/* 3 — plan against spend */}
            <div className="surface-panel p-6 rounded-[20px] h-full flex flex-col">
              <PanelHeader
                title={t('budgetHealth')}
                hint={t('budgetHealthHint')}
              />
              <div className="mt-4 flex-1 flex flex-col items-center justify-center gap-4">
                {hubFailed || !budgets || budgets.planned === 0 ? (
                  <p className="text-[13px] text-text-muted py-6 text-center">
                    {hubFailed ? t('budgetsUnknown') : t('noBudgets')}
                  </p>
                ) : (
                  <>
                    <DonutChart
                      slices={budgetSlices}
                      size={150}
                      thickness={20}
                      caption={ratePct(budgets.utilization)}
                      subCaption={t('budgetDonutCaption')}
                    />
                    <DonutLegend
                      slices={budgetSlices}
                      total={budgetSlices.reduce((a, s) => a + s.value, 0)}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      }
    />
  );
}

export default function FinanceHubPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <FinanceHubContent />
    </ProtectedRoute>
  );
}
