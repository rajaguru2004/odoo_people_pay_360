'use client';

import { useTranslations } from 'next-intl';
import { GitPullRequestArrow, Users, Building2, Network, UserCog } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ModuleLandingPage from '@/components/module-landing/ModuleLandingPage';
import AttentionStrip, { type AttentionItem } from '@/components/module-landing/AttentionStrip';
import type { KpiStat } from '@/components/module-landing/StatCard';
import {
  BarOverviewChart,
  PanelHeader,
  PanelLink,
  type BarOverviewItem,
} from '@/components/module-landing/primitives';
import BranchWorkforceMeters from '@/components/organization/hub/BranchWorkforceMeters';
import OrgStructureBlocks from '@/components/organization/hub/OrgStructureBlocks';
import ChangeRequestDonut from '@/components/organization/hub/ChangeRequestDonut';
import WorkforceGrowthPanel from '@/components/organization/hub/WorkforceGrowthPanel';
import { useOrganizationHub } from '@/hooks/useOrganizationHub';

/**
 * Organization module hub — where the workforce sits, and what has no owner.
 *
 * Laid out on the finalised Time & Attendance template: five KPIs, an attention
 * strip, one big chart beside a ranking, three insight panels, then the tiles.
 * Only the business meaning changes between modules.
 *
 * It deliberately carries NO attendance figure and NO contract clock — those
 * are Time & Attendance's and People's, and repeating them here is what made
 * three hubs look like three views of one page. The header carries no period
 * filter either: every figure but the growth curve is a fact about the
 * structure right now, and the curve has its own 6M/12M switch.
 */

/**
 * Five round ticks that clear the tallest bar without towering over it.
 *
 * Same helper the Time hub uses: the naive `ceil(max/25)*25` puts a six-person
 * department on a 0–25 axis, so every bar sits in the bottom fifth and the
 * shape of the company is invisible.
 */
function axisFor(max: number): { max: number; ticks: string[] } {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const step = steps.find((s) => s * 5 >= max) ?? Math.ceil(max / 5);
  const top = step * 5;
  return { max: top, ticks: Array.from({ length: 6 }, (_, i) => String(i * step)) };
}

function OrganizationHubContent() {
  const t = useTranslations('organizationHub');
  const tm = useTranslations('moduleLanding');
  const { summary, months, setMonths, loading, fetching, failed } = useOrganizationHub();

  const known = <T,>(value: T | undefined): T | null => (failed || !summary ? null : (value as T));

  // `structureStats` falls back to the literal string "Unknown" when the
  // supervisor record is outside the caller's reach. "Widest span: Unknown"
  // tells the reader nothing and looks like a bug; treat it as no span. A span
  // of one is not a span worth flagging either.
  const rawWidest = summary?.managers.widestSpan ?? null;
  const widest =
    rawWidest && rawWidest.name && rawWidest.name !== 'Unknown' && rawWidest.reports > 1
      ? rawWidest
      : null;
  const headless = summary?.departments.headless ?? [];
  const deptRows = summary?.departments.rows ?? [];

  // ── KPI row ───────────────────────────────────────────────────────────────
  // Every card carries a governance footnote. A bare "Departments: 7" is the
  // same number every week and nobody acts on it — so the count is the LINK and
  // the footnote is the reason to follow it.
  const kpis: KpiStat[] = [
    {
      key: 'employees',
      label: t('kpiEmployees'),
      value: known(summary?.headcount.active),
      icon: Users,
      footnote: summary
        ? summary.unassigned.noBranch > 0
          ? t('kpiEmployeesNoBranch', { count: summary.unassigned.noBranch })
          : t('kpiEmployeesAllPlaced')
        : undefined,
      tone: (summary?.unassigned.noBranch ?? 0) > 0 ? 'warning' : 'default',
      href: '/dashboard/employees',
    },
    {
      key: 'branches',
      label: t('kpiBranches'),
      value: known(summary?.branches.total),
      icon: Building2,
      footnote: summary
        ? summary.branches.withoutManager > 0
          ? t('kpiBranchesNoManager', { count: summary.branches.withoutManager })
          : t('kpiBranchesAllManaged')
        : undefined,
      tone: (summary?.branches.withoutManager ?? 0) > 0 ? 'warning' : 'default',
      href: '/dashboard/branches',
    },
    {
      key: 'departments',
      label: t('kpiDepartments'),
      value: known(summary?.departments.total),
      icon: Network,
      // The consequence, not the count: those people have no approver for
      // anything routed by department.
      footnote: summary
        ? summary.departments.withoutHead > 0
          ? t('kpiDepartmentsNoHead', {
              count: summary.departments.withoutHead,
              people: summary.departments.unmanagedHeadcount,
            })
          : t('kpiDepartmentsAllHeaded')
        : undefined,
      tone: (summary?.departments.withoutHead ?? 0) > 0 ? 'danger' : 'default',
      href: '/dashboard/departments',
    },
    {
      key: 'managers',
      label: t('kpiManagers'),
      value: known(summary?.managers.total),
      icon: UserCog,
      // Past a dozen direct reports one-to-ones stop happening and the approval
      // queue behind that person becomes the bottleneck.
      tone: (widest?.reports ?? 0) >= 12 ? 'warning' : 'default',
      footnote: widest
        ? t('kpiManagersWidest', { name: widest.name, count: widest.reports })
        : summary
        ? t('kpiManagersNoSpan')
        : undefined,
      href: '/dashboard/supervisor-teams',
    },
    {
      key: 'changeRequests',
      label: t('kpiChangeRequests'),
      value: known(summary?.changeRequests.pending),
      icon: GitPullRequestArrow,
      tone: (summary?.changeRequests.pending ?? 0) > 0 ? 'warning' : 'success',
      footnote: summary
        ? t('kpiChangeRequestsSplit', {
            approved: summary.changeRequests.approved,
            rejected: summary.changeRequests.rejected,
          })
        : undefined,
      href: '/dashboard/departments/change-requests',
    },
  ];

  // ── Needs attention ───────────────────────────────────────────────────────
  const attention: AttentionItem[] = [];
  if (summary) {
    if (summary.changeRequests.pending > 0) {
      attention.push({
        key: 'change-requests',
        label: t('attnChangeRequests', { count: summary.changeRequests.pending }),
        detail: t('review'),
        severity: 'warning',
        href: '/dashboard/departments/change-requests',
      });
    }
    for (const d of headless.slice(0, 6)) {
      attention.push({
        key: `headless-${d.id}`,
        label: t('attnHeadless', { name: d.name }),
        detail: t('peopleWithNoHead', { count: d.employees }),
        // A headless department with nobody in it is untidy; one with staff in
        // it means those people have no approver, which is an outage.
        severity: d.employees > 0 ? 'critical' : 'info',
        href: '/dashboard/departments',
      });
    }
    if (summary.unassigned.noBranch > 0) {
      attention.push({
        key: 'no-branch',
        label: t('attnNoBranch', { count: summary.unassigned.noBranch }),
        detail: t('assign'),
        severity: 'warning',
        href: '/dashboard/employees',
      });
    }
    if (summary.branches.withoutManager > 0) {
      attention.push({
        key: 'branch-no-manager',
        label: t('attnBranchNoManager', { count: summary.branches.withoutManager }),
        detail: t('assign'),
        severity: 'warning',
        href: '/dashboard/branches',
      });
    }
    if (widest && widest.reports >= 12) {
      attention.push({
        key: 'widest-span',
        label: t('attnWidestSpan', { name: widest.name, count: widest.reports }),
        detail: t('review'),
        severity: 'info',
        href: '/dashboard/supervisor-teams',
      });
    }
  }

  // ── Main chart: department workforce ──────────────────────────────────────
  // The biggest department is highlighted so the chart has a subject, but its
  // tooltip stays closed until somebody hovers: opened on mount it is drawn
  // straight over the panel's own heading.
  const barItems: BarOverviewItem[] = deptRows.slice(0, 12).map((d, i) => ({
    key: d.id,
    label: d.name,
    value: d.employees,
    highlight: i === 0,
    tooltipTitle: d.name,
    tooltipRows: [
      { label: t('people'), value: d.employees, emphasis: true },
      { label: t('shareOfWorkforce'), value: d.share === null ? '—' : `${d.share.toFixed(1)}%` },
    ],
  }));
  const axis = axisFor(Math.max(1, ...barItems.map((b) => b.value)));

  // The concentration line, salvaged from the old HeadcountSplit panel: no
  // headcount total ever surfaces that one team holds half the company.
  const biggest = deptRows[0];
  const chartHint =
    biggest && biggest.share !== null
      ? t('deptWorkforceHintConcentrated', {
          name: biggest.name,
          share: biggest.share.toFixed(0),
        })
      : t('deptWorkforceHint');

  return (
    <ModuleLandingPage
      moduleKey="organization"
      title={tm('organization.title')}
      subtitle={tm('organization.subtitle')}
      kpis={kpis}
      kpisLoading={loading}
      badges={{ changeRequests: summary?.changeRequests.pending }}
      badgeTones={{ changeRequests: 'warning' }}
      insights={
        <div className="space-y-6">
          <AttentionStrip
            title={t('needsAttention')}
            items={attention}
            loading={loading}
            emptyLabel={failed ? t('structureUnknown') : t('structureHealthy')}
            seeAll={{ label: t('seeDepartments'), href: '/dashboard/departments' }}
          />

          {/* Middle row: where the workforce sits, by department and by branch */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 xl:col-span-8 surface-panel p-6 rounded-[20px] flex flex-col justify-between">
              <PanelHeader
                title={t('deptWorkforce')}
                hint={summary ? chartHint : undefined}
                action={<PanelLink href="/dashboard/departments">{t('seeDepartments')}</PanelLink>}
              />
              {/* min-h keeps the chart readable when this is the short panel;
                  flex-1 lets it fill when the branch list is taller. */}
              <div className="mt-2 pt-2 flex-1 min-h-[260px] flex">
                {barItems.length === 0 || barItems.every((b) => b.value === 0) ? (
                  <p className="text-[13px] text-text-muted py-16 text-center w-full">
                    {failed ? t('deptWorkforceUnavailable') : t('noDepartmentStaff')}
                  </p>
                ) : (
                  <div className="flex-1 min-w-0">
                    <BarOverviewChart
                      items={barItems}
                      height="100%"
                      maxVal={axis.max}
                      yAxisTicks={axis.ticks}
                      openHighlightTooltip={false}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-5 xl:col-span-4 flex flex-col">
              <BranchWorkforceMeters
                rows={summary?.branches.rows}
                withoutManager={summary?.branches.withoutManager ?? 0}
                loading={loading}
                failed={failed}
              />
            </div>
          </div>

          {/* Bottom row: the structure, the queue, and the direction of travel */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <OrgStructureBlocks summary={summary} loading={loading} />
            <ChangeRequestDonut
              counts={summary?.changeRequests}
              loading={loading}
              failed={failed}
            />
            <WorkforceGrowthPanel
              growth={summary?.growth}
              months={months}
              onMonthsChange={setMonths}
              loading={loading}
              busy={fetching}
              failed={failed}
            />
          </div>
        </div>
      }
    />
  );
}

export default function OrganizationHubPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <OrganizationHubContent />
    </ProtectedRoute>
  );
}
