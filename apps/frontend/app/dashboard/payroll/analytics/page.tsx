'use client';

import { Suspense } from 'react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { KpiRow } from '@/components/module-landing/StatCard';
import { usePageHeader } from '@/hooks/usePageHeader';
import { usePayrollDashboard } from '@/hooks/usePayrollDashboard';
import DashboardFilters from '@/components/payroll/dashboard/DashboardFilters';
import AttentionList from '@/components/payroll/dashboard/AttentionList';
import { buildDashboardKpis } from '@/components/payroll/dashboard/dashboardKpis';
import NetSalaryTrendChart from '@/components/payroll/dashboard/NetSalaryTrendChart';
import CumulativeCostChart from '@/components/payroll/dashboard/CumulativeCostChart';
import PipelineFunnel from '@/components/payroll/dashboard/PipelineFunnel';
import StatusDonut from '@/components/payroll/dashboard/StatusDonut';
import DepartmentCostChart from '@/components/payroll/dashboard/DepartmentCostChart';
import ComponentMixChart from '@/components/payroll/dashboard/ComponentMixChart';
import NetBridgeChart from '@/components/payroll/dashboard/NetBridgeChart';
import DepartmentTreemap from '@/components/payroll/dashboard/DepartmentTreemap';
import AttendanceMixChart from '@/components/payroll/dashboard/AttendanceMixChart';
import CoverageGauges from '@/components/payroll/dashboard/CoverageGauges';
import DepartmentMatrix from '@/components/payroll/dashboard/DepartmentMatrix';
import type { PayrollDashboardSummary } from '@/types/payrollDashboard';

/**
 * The payroll analytics page.
 *
 * Distinct from the hub at `/dashboard/payroll`, which is the module landing
 * page and stays as it is. This one answers a different question — not "what is
 * the state of payroll" but "what did it cost, where did it go, and what is the
 * shape of it" — and it is the only page in the module with slicers.
 *
 * Everything on it reads ONE response from `GET /payroll/dashboard`. That is
 * what makes the filter row honest: a change re-queries once and every visual
 * moves together, where a page fetching per panel would show the reader six
 * charts part-way through agreeing with each other.
 *
 * Nothing below reads `summary` directly for a figure. Every value resolves to
 * `null` — printed as an em dash — the moment the read fails, because an empty
 * payroll and an unreachable endpoint are different claims and a page that
 * printed zero for both has told the reader something false about one of them.
 */
function PayrollAnalyticsContent() {
  const { summary, setFilter, reset, loading, refetching, failed } =
    usePayrollDashboard();

  // A failed read is not an empty period. Dropping the payload entirely is what
  // makes every card below fall to its own em dash rather than to zero.
  const data = failed ? undefined : summary;

  usePageHeader(
    'Payroll analytics',
    data ? `${data.period.label} · approved and paid runs` : 'Payroll analytics',
  );

  return (
    <div className="space-y-6">
      <DashboardFilters
        filters={data?.filters}
        applied={data?.filters.applied}
        periodLabel={data?.period.label}
        onChange={setFilter}
        onReset={reset}
        disabled={loading}
      />

      {failed && (
        <p
          role="status"
          className="rounded-xl border border-status-error/30 bg-status-error-bg px-4 py-3 text-[13px] text-status-error"
        >
          The payroll figures could not be loaded. Nothing below is showing a
          number it could not verify.
        </p>
      )}

      {/* Disclosed rather than silently folded in: adding OMR to KWD produces a
          figure that is not money, so those months are excluded from the totals
          and the reader is told which. */}
      {data && data.money.otherCurrencies.length > 0 && (
        <p className="rounded-xl border border-status-warning/30 bg-status-warning-bg px-4 py-3 text-[13px] text-status-warning">
          Runs in {data.money.otherCurrencies.join(', ')} are not included.
          Totals are {data.money.currency} only.
        </p>
      )}

      <KpiRow stats={buildDashboardKpis(data)} loading={loading} />

      <AttentionList items={data?.attention} loading={loading} />

      <PayrollVisualGrid
        data={data}
        loading={loading}
        refetching={refetching}
      />
    </div>
  );
}

/**
 * The visual grid.
 *
 * Two to a row on a wide screen, one on a narrow one. Ordered the way the
 * question is actually asked: what did it cost over time, where is it in the
 * pipeline, where did the money go, then how it breaks down.
 *
 * Every panel receives `refetching` and holds its previous render while the
 * next answer is in flight, so moving a slicer does not blank twelve boxes at
 * once.
 */
function PayrollVisualGrid({
  data,
  loading,
  refetching,
}: {
  data?: PayrollDashboardSummary;
  loading: boolean;
  refetching: boolean;
}) {
  const currency = data?.money.currency ?? 'OMR';
  const period = data?.filters.applied.period;
  const departmentOptions = data?.filters.departments;
  const shared = { loading, refetching };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-2">
        <NetSalaryTrendChart
          trend={data?.trend}
          currency={currency}
          periodLabel={data?.period.label}
          {...shared}
        />
        <CumulativeCostChart
          trend={data?.trend}
          currency={currency}
          {...shared}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <PipelineFunnel
          funnel={data?.runs.funnel}
          cancelled={data?.runs.byStatus.CANCELLED}
          {...shared}
        />
        <StatusDonut byStatus={data?.runs.byStatus} {...shared} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <DepartmentCostChart
          departments={data?.departments}
          departmentOptions={departmentOptions}
          currency={currency}
          period={period}
          {...shared}
        />
        <ComponentMixChart
          components={data?.components}
          currency={currency}
          {...shared}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <NetBridgeChart bridge={data?.bridge} currency={currency} {...shared} />
        <DepartmentTreemap
          departments={data?.departments}
          currency={currency}
          period={period}
          {...shared}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <AttendanceMixChart attendance={data?.attendance} {...shared} />
        <CoverageGauges
          coverage={data?.coverage}
          payslipCount={data?.payslips.total}
          {...shared}
        />
      </div>

      <DepartmentMatrix
        departments={data?.departments}
        departmentOptions={departmentOptions}
        currency={currency}
        period={period}
        loading={loading}
      />
    </div>
  );
}

export default function PayrollAnalyticsPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      {/* `useSearchParams` suspends during prerender; without a boundary the
          whole route opts out of static generation with a build-time warning. */}
      <Suspense fallback={null}>
        <PayrollAnalyticsContent />
      </Suspense>
    </ProtectedRoute>
  );
}
