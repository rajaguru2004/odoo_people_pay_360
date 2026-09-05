'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { HandCoins, PieChart, Banknote } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import AttentionStrip, { type AttentionItem } from '@/components/module-landing/AttentionStrip';
import type { KpiStat } from '@/components/module-landing/StatCard';
import {
  DonutChart,
  DonutLegend,
  MeterList,
  PanelHeader,
  PanelLink,
  type DonutSlice,
  type MeterRow,
} from '@/components/module-landing/primitives';
import { useFinanceHub } from '@/hooks/useFinanceHub';
import { toDelta } from '@/hooks/useModuleHub';
import { formatAmountWithSymbol } from '@/utils/formatters';
import { ratePct } from '@/utils/hubAxis';

/**
 * Finance module hub — "what has the company committed, and what has it spent".
 *
 * Built on the Time & Attendance template: a KPI row, an attention strip, one
 * insight panel, then the tiles. No period filter — `showControls` is omitted,
 * which is what removes the Today/Week/Month/Year row.
 *
 * Budget variance is the whole headline. It is the only series here that is
 * both real money and bounded by a period somebody actually planned against;
 * the travel queue is a count of pending decisions, so it belongs in the
 * attention strip and on its tile rather than in a money card.
 */
function FinanceHubContent() {
  const t = useTranslations('financeHub');
  const tm = useTranslations('moduleLanding');
  const { summary, loading, hubFailed } = useFinanceHub();

  const travel = summary?.travel;
  const budgets = summary?.budgets;
  const prevLabel = summary?.window.previous.label ?? '';

  /** Money, or an em dash when the read failed. Never a zero standing in. */
  const money = (value: number | undefined | null) =>
    hubFailed || value === undefined || value === null ? null : formatAmountWithSymbol(value);

  const vsPrevious = t('vsPrevious', { period: prevLabel });

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
    {
      key: 'spent',
      label: t('sliceActual'),
      value: money(budgets?.actual),
      icon: Banknote,
      href: '/dashboard/budgets',
    },
    {
      key: 'remaining',
      label: t('sliceRemaining'),
      // A negative remaining is an over-run and stays negative on the card. The
      // donut cannot draw one, which is why the figure is here as well.
      value: money(budgets?.remaining),
      icon: HandCoins,
      tone: (budgets?.remaining ?? 0) < 0 ? 'danger' : 'default',
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

  /**
   * One meter per budget, so the total on the donut can be traced to the line
   * that is running hot. `utilization` is `null` when nothing was planned —
   * an unknown rate, drawn as an empty track and an em dash, never as 0%.
   */
  const budgetRows: MeterRow[] = useMemo(
    () =>
      (budgets?.rows ?? []).slice(0, 6).map((r) => ({
        key: r.budgetId,
        label: r.name,
        hint: String(r.fiscalYear),
        percent: r.utilization ?? 0,
        valueLabel: ratePct(r.utilization),
        color:
          (r.utilization ?? 0) > 100
            ? 'var(--color-status-error)'
            : (r.utilization ?? 0) >= 90
              ? 'var(--color-status-warning)'
              : 'color-mix(in srgb, var(--color-brand-primary) 85%, white)',
      })),
    [budgets],
  );

  return (
    <ModuleLandingPage
      moduleKey="finance"
      title={tm('finance.title')}
      subtitle={tm('finance.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      badges={{ travel: travel?.pending }}
      badgeTones={{ travel: 'warning' }}
      insights={
        <div className="space-y-6">
          <AttentionStrip
            title={t('needsAttention')}
            items={attentionItems}
            loading={loading}
            emptyLabel={t('needsAttentionEmpty')}
            seeAll={{ label: t('seeBudgets'), href: '/dashboard/budgets' }}
          />

          <div className="surface-panel p-6 rounded-[20px]">
            <PanelHeader
              title={t('budgetHealth')}
              hint={t('budgetHealthHint')}
              action={<PanelLink href="/dashboard/budgets">{t('viewDetails')}</PanelLink>}
            />
            {hubFailed || !budgets || budgets.planned === 0 ? (
              <p className="mt-4 text-[13px] text-text-muted py-10 text-center">
                {hubFailed ? t('budgetsUnknown') : t('noBudgets')}
              </p>
            ) : (
              <div className="mt-4 grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
                <div className="lg:col-span-5 flex flex-col items-center justify-center gap-4">
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
                </div>
                <div className="lg:col-span-7">
                  <MeterList rows={budgetRows} />
                </div>
              </div>
            )}
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
