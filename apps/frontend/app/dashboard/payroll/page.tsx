'use client';

import { useTranslations } from 'next-intl';
import { Banknote, ClipboardCheck, Landmark, Users, Wallet } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import AttentionStrip, { type AttentionItem } from '@/components/module-landing/AttentionStrip';
import type { KpiStat } from '@/components/module-landing/StatCard';
import {
  BarOverviewChart,
  PanelHeader,
  PanelLink,
  SegmentedTimeFilter,
  type BarOverviewItem,
} from '@/components/module-landing/primitives';
import MoneyComposition from '@/components/payroll/hub/MoneyComposition';
import ProcessingCoverage from '@/components/payroll/hub/ProcessingCoverage';
import RunPipelineDonut, {
  STALE_APPROVAL_DAYS,
  daysSince,
} from '@/components/payroll/hub/RunPipelineDonut';
import { usePayrollHub, type TrendMonths } from '@/hooks/usePayrollHub';
import { axisFor } from '@/utils/chartAxis';
import { formatCurrency } from '@/utils/formatters';

/**
 * Payroll module hub — what the period cost, who is waiting on a decision and
 * who cannot be paid yet.
 *
 * Laid out on the same template as Time & attendance and Organisation: five
 * KPIs, an attention strip, one big chart beside a breakdown, three insight
 * panels, then the tiles. Only the business meaning changes between modules.
 *
 * Three rules run through every figure on the page:
 *
 *  - **Money means APPROVED or PAID.** A draft total is an intention, so
 *    unfinished work shows up as counts — runs open, people in an open run —
 *    and never as an amount.
 *  - **`null` prints an em dash, and a failed read never prints an all-clear.**
 *    An empty payroll and an unreachable endpoint are different claims.
 *  - **The browser does no calendar maths.** Every bucket arrives labelled, and
 *    the only period control on the page is the trend panel's own window.
 */

const MONTH_TABS: Array<{ label: string; value: TrendMonths }> = [
  { label: '6M', value: 6 },
  { label: '12M', value: 12 },
];

/** Money on the side of a chart, rather than a column of six-digit integers. */
function compactTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

/**
 * The count is the truth; the names are a capped sample.
 *
 * A detail that printed only the names would quietly shrink a nineteen-person
 * problem into a three-person one.
 */
function sampleDetail(count: number, names: string[], show = 3): string {
  const shown = names.slice(0, show);
  if (shown.length === 0) return `${count}`;
  const remaining = count - shown.length;
  return remaining > 0 ? `${shown.join(', ')} and ${remaining} more` : shown.join(', ');
}

/**
 * Where an objection is resolved.
 *
 * Matched on the server's own code so a finding lands on the screen that owns
 * the problem — a missing structure is fixed on the structures screen, not on
 * the run list. Anything unrecognised falls back to the pre-flight, which is
 * the one screen that enumerates every objection there is.
 */
function attentionHref(code: string): string {
  const key = code.toLowerCase();
  if (key.includes('structure')) return '/dashboard/payroll/structures';
  if (key.includes('contract')) return '/dashboard/contracts';
  if (key.includes('attendance')) return '/dashboard/attendance';
  if (key.includes('approv')) return '/dashboard/payroll/runs?status=CALCULATED';
  return '/dashboard/payroll/runs/new';
}

const SEVERITY: Record<string, AttentionItem['severity']> = {
  BLOCKER: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};

function PayrollHubContent() {
  const tm = useTranslations('moduleLanding');
  const { summary, months, setMonths, loading, fetching, failed } = usePayrollHub();

  /** Unknown stays unknown: a failed read is an em dash, never a zero. */
  const known = <T,>(value: T | undefined): T | null =>
    failed || !summary ? null : (value as T);

  const runs = summary?.runs;
  const money = summary?.money;
  const employees = summary?.employees;
  const currency = money?.currency ?? 'OMR';
  const periodLabel = summary?.period.label;
  const oldest = runs?.oldestAwaitingApproval ?? null;
  const oldestDays = daysSince(oldest?.calculatedAt);

  /** An amount, or an em dash when the aggregate never answered. */
  const amount = (value: number | null | undefined): string | null =>
    failed || !summary || value === null || value === undefined
      ? null
      : formatCurrency(value, currency);

  const trend = summary?.trend ?? [];
  const series = (pick: (bucket: (typeof trend)[number]) => number): number[] =>
    failed ? [] : trend.map(pick);

  // ── KPI row ───────────────────────────────────────────────────────────────
  const awaiting = runs?.byStatus.CALCULATED ?? 0;
  const withoutStructure = employees?.withoutStructure ?? 0;

  const kpis: KpiStat[] = [
    {
      key: 'awaiting',
      label: 'Runs awaiting approval',
      value: known(awaiting),
      icon: ClipboardCheck,
      tone: awaiting > 0 ? 'warning' : 'success',
      subStats: [
        { key: 'draft', label: 'Draft', value: known(runs?.byStatus.DRAFT) },
        { key: 'approved', label: 'Approved', value: known(runs?.byStatus.APPROVED) },
      ],
      footnote: !summary
        ? undefined
        : oldest === null
          ? 'Nothing is waiting on a decision.'
          : oldestDays === null
            ? `Oldest: ${oldest.label}.`
            : `${oldest.label} has waited ${oldestDays} day${oldestDays === 1 ? '' : 's'}.`,
      href: '/dashboard/payroll/runs?status=CALCULATED',
    },
    {
      key: 'gross',
      label: `Gross pay (${currency})`,
      value: amount(money?.gross),
      icon: Wallet,
      trend: series((bucket) => bucket.gross),
      subStats: [
        { key: 'deductions', label: 'Deductions', value: amount(money?.deductions) },
        { key: 'employerCost', label: 'Employer cost', value: amount(money?.employerCost) },
      ],
      footnote: periodLabel
        ? `Approved and paid runs for ${periodLabel}. Employer contributions sit outside it.`
        : undefined,
      href: '/dashboard/payroll/reports',
    },
    {
      key: 'net',
      label: `Net paid (${currency})`,
      value: amount(money?.net),
      icon: Banknote,
      trend: series((bucket) => bucket.net),
      // `changePct` is null when there is no previous period to compare
      // against. No comparison, no badge — 0% would claim pay held steady.
      delta:
        failed || !summary || money?.changePct === null || money?.changePct === undefined
          ? undefined
          : {
              value: money.changePct,
              direction: money.changePct >= 0 ? 'up' : 'down',
              goodDirection: 'down',
              display: `${Math.abs(money.changePct).toFixed(1)}%`,
              label: `vs ${summary.previousPeriod.label}`,
            },
      subStats: [
        { key: 'previous', label: 'Previous', value: amount(money?.previousNet) },
        {
          key: 'perEmployee',
          label: 'Per employee',
          value:
            failed || !summary || !employees?.paid
              ? null
              : formatCurrency((money?.net ?? 0) / employees.paid, currency),
        },
      ],
      footnote: periodLabel ? `What actually left the account in ${periodLabel}.` : undefined,
      href: '/dashboard/payroll/runs',
    },
    {
      key: 'employees',
      label: 'Employees paid',
      value: known(employees?.paid),
      icon: Users,
      tone: withoutStructure > 0 ? 'warning' : 'default',
      subStats: [
        { key: 'active', label: 'Active', value: known(employees?.active) },
        { key: 'open', label: 'In an open run', value: known(employees?.inOpenRun) },
      ],
      footnote: employees
        ? `${employees.paid} of ${employees.active} active employees.`
        : undefined,
      href: '/dashboard/payroll/payslips',
    },
    {
      key: 'blocked',
      label: 'Cannot be paid yet',
      value: known(withoutStructure),
      icon: Landmark,
      tone: withoutStructure > 0 ? 'danger' : 'success',
      footnote: !employees
        ? undefined
        : withoutStructure === 0
          ? 'Everybody active has a salary structure.'
          : // The names are a sample of the count, never the count itself.
            sampleDetail(withoutStructure, employees.withoutStructureNames),
      href: '/dashboard/payroll/structures',
    },
  ];

  // ── Needs attention ───────────────────────────────────────────────────────
  // Straight from `summary.attention`: the server decides what is worth
  // chasing, and the strip never invents a row the aggregate did not send.
  const attention: AttentionItem[] =
    failed || !summary
      ? []
      : summary.attention
          .filter((item) => item.count > 0)
          .map((item) => ({
            key: item.code,
            label: item.message,
            detail: sampleDetail(item.count, item.names),
            severity: SEVERITY[item.severity] ?? 'warning',
            href: attentionHref(item.code),
          }));

  // ── Main chart: net paid, month by month ──────────────────────────────────
  const barItems: BarOverviewItem[] = trend.map((bucket) => ({
    key: bucket.periodStart,
    // The server formatted `Aug 2026`; the month alone is what fits under a
    // bar. Neither half is worked out here.
    label: bucket.label.split(' ')[0],
    value: bucket.net,
    highlight: bucket.periodStart === summary?.period.periodStart,
    tooltipTitle: bucket.label,
    tooltipRows:
      bucket.net > 0 || bucket.gross > 0
        ? [
            { label: 'Net', value: formatCurrency(bucket.net, currency), emphasis: true },
            { label: 'Gross', value: formatCurrency(bucket.gross, currency) },
            { label: 'Employees', value: bucket.employeeCount },
          ]
        : [
            // A month with no approved run says so, rather than being described
            // by a zero that reads as "we paid nobody".
            { label: 'Net', value: '—', emphasis: true },
            { label: 'Employees', value: bucket.employeeCount },
          ],
  }));

  const axis = axisFor(Math.max(1, ...barItems.map((item) => item.value)));
  const yTicks = axis.ticks.map((tick) => compactTick(Number(tick)));
  const anyPaid = trend.some((bucket) => bucket.net > 0);
  const activeMonthTab = MONTH_TABS.find((tab) => tab.value === months)?.label ?? '6M';

  return (
    <ModuleLandingPage
      moduleKey="payroll"
      title={tm('payroll.title')}
      subtitle={tm('payroll.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      badges={{ payrollRuns: awaiting, salaryStructures: withoutStructure }}
      badgeTones={{ payrollRuns: 'warning', salaryStructures: 'danger' }}
      insights={
        <div className="space-y-6">
          <AttentionStrip
            title="Needs attention"
            items={attention}
            loading={loading}
            // A failed read must never read as "nothing needs doing".
            emptyLabel={
              failed
                ? 'The payroll position could not be read.'
                : 'Nothing is blocking the next run.'
            }
            seeAll={{ label: 'See runs', href: '/dashboard/payroll/runs' }}
          />

          {/* Middle row: the money over time, and where every run is stuck */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6 lg:col-span-7 xl:col-span-8">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <PanelHeader
                    title="Net paid, month by month"
                    hint={
                      periodLabel
                        ? `Approved and paid runs, ending ${periodLabel}.`
                        : undefined
                    }
                    action={<PanelLink href="/dashboard/payroll/runs">See runs</PanelLink>}
                  />
                </div>
                {/* The window lives on the panel it actually moves, rather than
                    in the page header where it would imply it moves the cards. */}
                <SegmentedTimeFilter
                  options={MONTH_TABS.map((tab) => tab.label)}
                  value={activeMonthTab}
                  onChange={(label) => {
                    const found = MONTH_TABS.find((tab) => tab.label === label);
                    if (found) setMonths(found.value);
                  }}
                />
              </div>

              <div
                className={`mt-2 flex min-h-[260px] flex-1 pt-2 ${fetching ? 'opacity-60' : ''}`}
              >
                {failed ? (
                  <p className="w-full py-16 text-center text-[13px] text-text-muted">
                    The trend could not be read.
                  </p>
                ) : !anyPaid ? (
                  <p className="w-full py-16 text-center text-[13px] text-text-muted">
                    No run in this window has been approved yet.
                  </p>
                ) : (
                  <div className="min-w-0 flex-1">
                    <BarOverviewChart
                      items={barItems}
                      height="100%"
                      maxVal={axis.max}
                      yAxisTicks={yTicks}
                      // Opened on mount it lands over the panel's own heading.
                      openHighlightTooltip={false}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col lg:col-span-5 xl:col-span-4">
              <RunPipelineDonut
                runs={runs}
                periodLabel={`the last ${months} months`}
                staleApprovalDays={STALE_APPROVAL_DAYS}
                loading={loading}
                failed={failed}
              />
            </div>
          </div>

          {/* Bottom row: who was processed, and what the money was made of */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <ProcessingCoverage
              employees={employees}
              periodLabel={periodLabel}
              loading={loading}
              failed={failed}
            />
            <MoneyComposition
              money={money}
              periodLabel={periodLabel}
              loading={loading}
              failed={failed}
            />
          </div>
        </div>
      }
    />
  );
}

/**
 * ADMIN, HR_MANAGER and PAYROLL_OFFICER, mirroring the `@Roles` on
 * `GET /payroll/hub-summary`. The rail must never offer a route the server
 * refuses.
 */
export default function PayrollHubPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER']}>
      <PayrollHubContent />
    </ProtectedRoute>
  );
}
