'use client';

import { useTranslations } from 'next-intl';
import { Banknote, Landmark, ShieldCheck, Users, Wallet } from 'lucide-react';
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
import RunPipelineDonut from '@/components/payroll/hub/RunPipelineDonut';
import { OmanCompliancePanel } from '@/components/payroll/hub/OmanCompliancePanel';
import ProcessingCoverage from '@/components/payroll/hub/ProcessingCoverage';
import PaymentReadinessPanel from '@/components/payroll/hub/PaymentReadinessPanel';
import MoneyComposition from '@/components/payroll/hub/MoneyComposition';
import { usePayrollHub } from '@/hooks/usePayrollHub';
import { usePayrollLabels } from '@/hooks/usePayrollLabels';
import { axisFor, compactTick } from '@/utils/chartAxis';
import { formatAmountWithSymbol, getCurrencyCode } from '@/utils/formatters';
import type { PayrollTrendMonths } from '@/types/payrollHub';

/**
 * Payroll module hub — the processing position, and whether payroll can be paid.
 *
 * Laid out on the finalised Time & Attendance template: five KPIs, an attention
 * strip, one big chart beside a breakdown, three insight panels, then the tiles.
 * Only the business meaning changes between modules.
 *
 * The question this hub owns is **"what is the current payroll processing
 * position, what has been processed, what is waiting for action, and is payroll
 * ready for payment?"** It carries no headcount card (People's), no loan book
 * (Finance's) and no attendance rate (Time & Attendance's). Loan recovery
 * appears only as a payslip column inside the composition panel.
 *
 * Two rules run through every figure:
 *
 *  - **Money means LOCKED.** A DRAFT total is money that has not moved, so
 *    unfinalised work shows up as counts — runs in progress, people in an open
 *    run — and never as an amount.
 *  - **`null` prints an em dash, and a failed read never prints an all-clear.**
 *
 * There is no period filter in the header, per the same rule Organization and
 * People follow: the server resolves the reporting month to the newest one that
 * actually holds a run and labels what it picked, and the only thing the reader
 * moves is the trend panel's own 6M/12M window.
 */

const MONTH_TABS: Array<{ label: string; value: PayrollTrendMonths }> = [
  { label: '6M', value: 6 },
  { label: '12M', value: 12 },
];

/** Days a run may sit unapproved before the queue stops being routine. */
const STALE_APPROVAL_DAYS = 3;

function daysSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

function PayrollHubContent() {
  const t = useTranslations('payrollHub');
  const tm = useTranslations('moduleLanding');
  const { summary, months, setMonths, loading, fetching, failed } = usePayrollHub();
  // SPF in Oman, EPF in India: the statutory card is named by the regulator the
  // figure is reconciled against, not by a hardcoded "Insurance".
  const labels = usePayrollLabels();

  /** Unknown stays unknown: a failed read is an em dash, never a zero. */
  const known = <T,>(value: T | undefined): T | null =>
    failed || !summary ? null : (value as T);

  const runs = summary?.runs;
  const period = summary?.anchor.label;
  const oldestPendingDays = daysSince(runs?.oldestPendingAt ?? null);
  const readiness = summary?.readiness;
  /** The trend window — read by the KPI sparklines and by the chart below. */
  const trendSource = summary?.trend ?? [];

  // ── KPI row ───────────────────────────────────────────────────────────────
  // Always five cards. The old hub pushed Settlements and Gratuity in
  // conditionally, so the row was four to six wide depending on a feature flag
  // and the grid changed shape underneath the reader.
  //
  // The five are the payroll ledger read top to bottom — what it cost (gross),
  // what reached people (net), what the regulator takes (statutory), who it
  // covered, and whether it can actually be paid. The run queue used to hold two
  // of these slots; it now lives on the Run pipeline panel, which is the panel
  // about runs, and nothing was lost: the same counts drive the nav-tile badges
  // and the attention strip.
  const money = summary?.money;

  /** One locked-run amount by payslip column, for the supporting figures. */
  const comp = new Map<string, number>(
    summary
      ? [...summary.composition.earnings, ...summary.composition.deductions].map(
          (r) => [r.key as string, r.amount],
        )
      : [],
  );

  /** Money is an em dash unless the anchor actually locked something. */
  const amount = (value: number | null | undefined): string | null =>
    failed || !summary || value === null || value === undefined
      ? null
      : formatAmountWithSymbol(value);

  /**
   * A money delta, in money rather than percent — "up OMR 1,904" is the sentence
   * the payroll officer is about to go and explain. Drawn only when BOTH months
   * locked something: a delta against an unfinalised month is fiction.
   */
  const moneyDelta = (
    current: number | null | undefined,
    previous: number | null | undefined,
    goodDirection: 'up' | 'down',
  ): KpiStat['delta'] => {
    if (!summary || failed) return undefined;
    if (current === null || current === undefined) return undefined;
    if (previous === null || previous === undefined || previous === 0) return undefined;
    const diff = current - previous;
    return {
      value: diff,
      direction: diff >= 0 ? 'up' : 'down',
      goodDirection,
      display: formatAmountWithSymbol(Math.abs(diff)),
      label: t('vsPeriod', { period: summary.anchor.previous.label }),
    };
  };

  /** A sparkline series, zero-filled: the card owns the "all zeros draws nothing" rule. */
  const series = (pick: (b: (typeof trendSource)[number]) => number | null): number[] =>
    failed ? [] : trendSource.map((b) => pick(b) ?? 0);

  const kpis: KpiStat[] = [
    {
      key: 'gross',
      label: t('kpiGross', { currency: getCurrencyCode() }),
      value: amount(money?.gross),
      icon: Wallet,
      trend: series((b) => b.gross),
      delta: moneyDelta(money?.gross, money?.previousGross, 'down'),
      subStats: [
        {
          key: 'basic',
          label: t('money.baseSalary'),
          value: amount(comp.get('baseSalary')),
        },
        {
          key: 'allowances',
          label: t('money.allowances'),
          value: amount(comp.get('allowances')),
        },
      ],
      footnote: summary
        ? money?.gross === null
          ? t('kpiNetNotFinalised', { period: summary.anchor.label })
          : t('kpiGrossHint', { period: summary.anchor.label })
        : undefined,
      href: '/dashboard/payroll/manage',
    },
    {
      key: 'net',
      label: t('kpiNet', { currency: getCurrencyCode() }),
      value: amount(money?.net),
      icon: Banknote,
      trend: series((b) => b.net),
      // Neither direction is inherently good news for a payroll total; rising
      // cost is flagged so it gets a second look.
      delta: moneyDelta(money?.net, money?.previousNet, 'down'),
      subStats: [
        {
          key: 'deductions',
          label: t('kpiSubDeductions'),
          value: amount(money?.deductions),
        },
        {
          key: 'perEmployee',
          label: t('kpiSubPerEmployee'),
          value:
            failed || !summary || money?.net === null || !summary.employees.paid
              ? null
              : formatAmountWithSymbol(money!.net! / summary.employees.paid),
        },
      ],
      footnote: summary
        ? money?.net === null
          ? t('kpiNetNotFinalised', { period: summary.anchor.label })
          : t('kpiNetHint', { period: summary.anchor.label })
        : undefined,
      href: '/dashboard/payroll/manage',
    },
    {
      key: 'statutory',
      // Named by the country's own regulator — SPF in Oman, EPF in India — so
      // the card matches the payslip column and the portal it is reconciled to.
      label: t('kpiStatutory', { name: labels.pf }),
      value: amount(money?.statutory),
      icon: Landmark,
      trend: series((b) => b.statutory),
      // More statutory deduction is not "good", but it moving is worth seeing.
      delta: moneyDelta(money?.statutory, money?.previousStatutory, 'down'),
      subStats: [
        { key: 'tax', label: labels.tax, value: amount(comp.get('tax')) },
        {
          key: 'loans',
          label: t('money.advanceLoanDeduction'),
          value: amount(comp.get('advanceLoanDeduction')),
        },
      ],
      footnote: summary
        ? money?.statutory === null
          ? t('kpiNetNotFinalised', { period: summary.anchor.label })
          : t('kpiStatutoryHint', { period: summary.anchor.label })
        : undefined,
      href: '/dashboard/payroll/reports',
    },
    {
      key: 'employees',
      label: t('kpiTotalEmployees'),
      value: known(summary?.employees.active),
      icon: Users,
      tone: (summary?.employees.notInAnyRun ?? 0) > 0 ? 'warning' : 'default',
      subStats: [
        { key: 'paid', label: t('covPaid'), value: known(summary?.employees.paid) },
        {
          key: 'open',
          label: t('covInOpenRun'),
          value: known(summary?.employees.inOpenRun),
        },
      ],
      footnote: summary
        ? summary.employees.notInAnyRun > 0
          ? t('kpiEmployeesPaidGap', {
              active: summary.employees.active,
              missing: summary.employees.notInAnyRun,
            })
          : t('kpiEmployeesPaidAll', { active: summary.employees.active })
        : undefined,
      href: '/dashboard/payroll/manage',
    },
    {
      key: 'readiness',
      label: t('kpiReadiness'),
      value:
        failed || !summary || !readiness || readiness.readyRate === null
          ? null
          : `${readiness.readyRate.toFixed(0)}%`,
      icon: ShieldCheck,
      tone:
        !readiness || readiness.readyRate === null
          ? 'default'
          : readiness.readyRate >= 100
          ? 'success'
          : readiness.readyRate >= 90
          ? 'warning'
          : 'danger',
      subStats: [
        {
          key: 'blocked',
          label: t('kpiSubBlocked'),
          value:
            failed || !summary || !readiness
              ? null
              : readiness.noBankRecord + readiness.incompleteFields,
        },
        {
          key: 'pendingChange',
          label: t('rdyPendingChange'),
          value: failed || !summary || !readiness ? null : readiness.pendingChange,
        },
      ],
      footnote: !summary
        ? undefined
        : !readiness
        ? t('kpiReadinessNobody')
        : readiness.readyRate === null
        ? t('kpiReadinessUnknown')
        : t('kpiReadinessHint', {
            ready: readiness.ready,
            total: readiness.total - readiness.unknown,
          }),
      href: '/dashboard/banks',
    },
  ];

  // ── Needs attention ───────────────────────────────────────────────────────
  // Every item count-gated: nothing renders at zero, so an empty strip is a
  // genuine all-clear — and only when the aggregate actually loaded.
  const attention: AttentionItem[] = [];
  if (summary && !failed) {
    for (const run of runs?.pending ?? []) {
      const age = daysSince(run.submittedAt);
      attention.push({
        key: `pending-${run.id}`,
        label: t('attnPending', { period: run.label }),
        detail:
          age === null ? t('review') : t('attnWaitingDays', { days: age }),
        severity: (age ?? 0) >= STALE_APPROVAL_DAYS ? 'critical' : 'warning',
        href: '/dashboard/payroll/approvals',
      });
    }
    for (const run of runs?.rejectedRuns ?? []) {
      attention.push({
        key: `rejected-${run.id}`,
        label: t('attnRejected', { period: run.label }),
        detail: t('attnNeedsCorrection'),
        severity: 'critical',
        href: '/dashboard/payroll/manage',
      });
    }
    if ((runs?.draftForClosedPeriod ?? 0) > 0) {
      attention.push({
        key: 'draft-closed',
        label: t('attnDraftClosed', { count: runs!.draftForClosedPeriod }),
        detail: t('attnPeriodEnded'),
        severity: 'warning',
        href: '/dashboard/payroll/manage',
      });
    }
    if (summary.employees.notInAnyRun > 0) {
      attention.push({
        key: 'not-in-run',
        label: t('attnNotInRun', { count: summary.employees.notInAnyRun }),
        detail: t('attnForPeriod', { period: summary.anchor.label }),
        severity: 'warning',
        href: '/dashboard/payroll/manage',
      });
    }
    if (readiness) {
      const blocked = readiness.noBankRecord + readiness.incompleteFields;
      if (blocked > 0) {
        attention.push({
          key: 'bank-blocked',
          label: t('attnBankBlocked', { count: blocked }),
          detail: t('attnCannotBePaid'),
          severity: 'critical',
          href: '/dashboard/banks',
        });
      }
      if (readiness.pendingChange > 0) {
        attention.push({
          key: 'bank-pending',
          label: t('attnBankPending', { count: readiness.pendingChange }),
          // The point of flagging this: the money is about to go to an account
          // somebody has already asked to leave. The decision that stops it is
          // on the approvals queue, not on the bank list.
          detail: t('attnOldAccount'),
          severity: 'warning',
          href: '/dashboard/approvals',
        });
      }
    }
    if (summary.carryForward.outstanding > 0) {
      attention.push({
        key: 'carry-forward',
        label: t('attnCarryForward', { count: summary.carryForward.outstanding }),
        detail: t('attnUnrecovered'),
        severity: 'info',
        href: '/dashboard/payroll/recoveries',
      });
    }
    if ((summary.settlements?.awaitingPayment ?? 0) > 0) {
      attention.push({
        key: 'settlements',
        label: t('attnSettlements', { count: summary.settlements!.awaitingPayment }),
        detail: formatAmountWithSymbol(summary.settlements!.openPayout),
        severity: 'warning',
        href: '/dashboard/payroll/settlements',
      });
    }
    if ((summary.wps?.rejected ?? 0) > 0) {
      attention.push({
        key: 'wps-rejected',
        label: t('attnWpsRejected', { count: summary.wps!.rejected }),
        detail: t('attnBankRefused'),
        severity: 'critical',
        href: '/dashboard/payroll/manage',
      });
    }
    if (summary.unscopedLegacyRuns > 0) {
      attention.push({
        key: 'legacy-runs',
        // Named rather than silently scoped away: these runs carry no branch,
        // so every other figure on this page excludes them.
        label: t('attnLegacyRuns', { count: summary.unscopedLegacyRuns }),
        detail: t('attnNoBranch'),
        severity: 'info',
        href: '/dashboard/payroll/manage',
      });
    }
  }

  // ── Main chart: net paid, month by month ──────────────────────────────────
  // Net paid is the figure that actually moves. Runs per month is 1–2 on a
  // normal install and draws a flat line; employees processed barely changes.
  const trend = trendSource;
  const barItems: BarOverviewItem[] = trend.map((b) => ({
    key: b.key,
    label: b.label.split(' ')[0],
    value: b.net ?? 0,
    highlight: b.month === summary?.anchor.month && b.year === summary?.anchor.year,
    tooltipTitle: b.label,
    tooltipRows: b.locked
      ? [
          { label: t('tipNet'), value: formatAmountWithSymbol(b.net ?? 0), emphasis: true },
          { label: t('tipEmployees'), value: b.employees },
          { label: t('tipRuns'), value: b.lockedRuns },
        ]
      : [
          // A month with no locked run says so, rather than being described
          // with a zero that reads as "we paid nobody".
          { label: t('tipNet'), value: '—', emphasis: true },
          { label: t('tipRunsOpen'), value: b.runs },
        ],
  }));
  const axis = axisFor(Math.max(1, ...barItems.map((b) => b.value)));
  // Money on the side of a chart, not a column of six-digit integers.
  const yTicks = axis.ticks.map((t) => compactTick(Number(t)));
  const anyLocked = trend.some((b) => b.locked);
  // A month that HELD a run but locked none of it draws at zero, which reads as
  // "we paid almost nothing" rather than "this is not finalised". The bar
  // cannot say that on its own, so the panel hint counts them.
  const unfinalised = trend.filter((b) => !b.locked && b.runs > 0).length;
  const activeMonthLabel = MONTH_TABS.find((m) => m.value === months)?.label ?? '6M';

  return (
    <ModuleLandingPage
      moduleKey="payroll"
      title={tm('payroll.title')}
      subtitle={tm('payroll.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      badges={{
        payrollApprovals: runs?.pendingApproval,
        runPayroll: runs?.inProgress,
      }}
      badgeTones={{
        payrollApprovals:
          (oldestPendingDays ?? 0) >= STALE_APPROVAL_DAYS ? 'danger' : 'warning',
        runPayroll: 'warning',
      }}
      insights={
        <div className="space-y-6">
          <AttentionStrip
            title={t('needsAttention')}
            items={attention}
            loading={loading}
            // A failed read must never read as "nothing needs doing".
            emptyLabel={failed ? t('payrollUnknown') : t('payrollHealthy')}
            seeAll={{ label: t('seeRuns'), href: '/dashboard/payroll/manage' }}
          />

          {/* Middle row: the money over time, and where every run is stuck */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 xl:col-span-8 surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <PanelHeader
                    title={t('payrollTrend')}
                    hint={
                      summary
                        ? !anyLocked
                          ? t('payrollTrendHintEmpty')
                          : unfinalised > 0
                          ? t('payrollTrendHintPartial', {
                              period: summary.anchor.label,
                              count: unfinalised,
                            })
                          : t('payrollTrendHint', { period: summary.anchor.label })
                        : undefined
                    }
                    showMenu={false}
                    action={
                      <PanelLink href="/dashboard/payroll/manage">{t('seeRuns')}</PanelLink>
                    }
                  />
                </div>
                {/* The window lives on the panel it actually moves, rather than
                    in the page header where it would imply it moves the cards. */}
                <SegmentedTimeFilter
                  options={MONTH_TABS.map((m) => m.label)}
                  value={activeMonthLabel}
                  onChange={(label) => {
                    const found = MONTH_TABS.find((m) => m.label === label);
                    if (found) setMonths(found.value);
                  }}
                />
              </div>

              <div className={`mt-2 pt-2 flex-1 min-h-[260px] flex ${fetching ? 'opacity-60' : ''}`}>
                {failed ? (
                  <p className="text-[13px] text-text-muted py-16 text-center w-full">
                    {t('payrollTrendUnavailable')}
                  </p>
                ) : !anyLocked ? (
                  <p className="text-[13px] text-text-muted py-16 text-center w-full">
                    {t('noLockedRuns')}
                  </p>
                ) : (
                  <div className="flex-1 min-w-0">
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

            <div className="lg:col-span-5 xl:col-span-4 flex flex-col">
              <RunPipelineDonut
                runs={runs}
                periodLabel={summary ? t('lastNMonths', { count: months }) : undefined}
                staleApprovalDays={STALE_APPROVAL_DAYS}
                oldestPendingDays={oldestPendingDays}
                loading={loading}
                failed={failed}
              />
            </div>
          </div>

          {/* Bottom row: what was processed, whether it can be paid, what it was */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <ProcessingCoverage
              employees={summary?.employees}
              periodLabel={period}
              loading={loading}
              failed={failed}
            />
            <PaymentReadinessPanel
              readiness={readiness}
              wps={summary?.wps}
              loading={loading}
              failed={failed}
            />
            <MoneyComposition
              composition={summary?.composition}
              periodLabel={period}
              statutoryLabel={labels.pf}
              taxLabel={labels.tax}
              loading={loading}
              failed={failed}
            />
          </div>

          {/* Oman Payroll Compliance — auto-shown when country/currency/template
              is Oman, and scored off the same aggregate as everything above it. */}
          <OmanCompliancePanel summary={summary} loading={loading} failed={failed} />
        </div>
      }
    />
  );
}

export default function PayrollHubPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <PayrollHubContent />
    </ProtectedRoute>
  );
}
