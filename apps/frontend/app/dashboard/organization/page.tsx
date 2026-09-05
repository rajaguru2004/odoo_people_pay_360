'use client';

import { useTranslations } from 'next-intl';
import { Building2, GitPullRequestArrow, Network, UserCog, Users } from 'lucide-react';
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
import ChangeRequestDonut from '@/components/organization/hub/ChangeRequestDonut';
import OrgStructureBlocks from '@/components/organization/hub/OrgStructureBlocks';
import WorkforceGrowthPanel from '@/components/organization/hub/WorkforceGrowthPanel';
import { useOrganizationHub } from '@/hooks/useOrganizationHub';

/**
 * The Organisation hub — where the workforce sits, and what has no owner.
 *
 * Five KPIs, an attention strip, one wide chart beside a ranking, then three
 * insight panels and the tiles. It carries no attendance figure and no contract
 * clock: those belong to Time & attendance and to People, and repeating them
 * here would make three hubs look like three views of one page.
 *
 * The header carries no period control either. Every figure but the growth
 * curve is a fact about the structure right now, and the curve owns its own
 * 6M/12M switch.
 */

/**
 * Five round ticks that clear the tallest bar without towering over it.
 *
 * The naive `ceil(max / 25) * 25` puts a six-person department on a 0–25 axis,
 * so every bar sits in the bottom fifth and the shape of the company is
 * invisible.
 */
function axisFor(max: number): { max: number; ticks: string[] } {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const step = steps.find((candidate) => candidate * 5 >= max) ?? Math.ceil(max / 5);
  const top = step * 5;
  return { max: top, ticks: Array.from({ length: 6 }, (_, i) => String(i * step)) };
}

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

function OrganizationHubContent() {
  const tm = useTranslations('moduleLanding');
  const { summary, months, setMonths, loading, fetching, failed } = useOrganizationHub();

  /**
   * The one rule this page turns on.
   *
   * Every figure below reads `null` — printed as an em dash — the moment the
   * aggregate failed. An empty organisation and an unreachable endpoint are
   * different claims, and a card showing 0 for both has told the reader
   * something false about one of them.
   */
  const known = <T,>(value: T | undefined): T | null =>
    failed || !summary ? null : (value as T);

  // A span of one is not a span worth flagging, and a supervisor the caller
  // cannot resolve arrives unnamed — "widest span: —" reads as a bug rather
  // than as an absence.
  const rawWidest = summary?.managers.widestSpan ?? null;
  const widest = rawWidest && rawWidest.name && rawWidest.reports > 1 ? rawWidest : null;
  const headless = summary?.departments.headless ?? [];
  const deptRows = summary?.departments.rows ?? [];

  // ── KPI row ───────────────────────────────────────────────────────────────
  // Every card carries a governance footnote. A bare "Departments: 7" is the
  // same number every week and nobody acts on it, so the count is the link and
  // the footnote is the reason to follow it.
  const kpis: KpiStat[] = [
    {
      key: 'employees',
      label: 'Active employees',
      value: known(summary?.headcount.active),
      icon: Users,
      tone: (summary?.unassigned.noBranch ?? 0) > 0 ? 'warning' : 'default',
      footnote: summary
        ? summary.unassigned.noBranch > 0
          ? `${summary.unassigned.noBranch} posted to no branch`
          : 'Everyone is posted to a branch'
        : undefined,
      href: '/dashboard/employees',
    },
    {
      key: 'branches',
      label: 'Branches',
      value: known(summary?.branches.total),
      icon: Building2,
      tone: (summary?.branches.withoutManager ?? 0) > 0 ? 'warning' : 'default',
      footnote: summary
        ? summary.branches.withoutManager > 0
          ? `${summary.branches.withoutManager} with no manager`
          : 'Every branch has a manager'
        : undefined,
      href: '/dashboard/branches',
    },
    {
      key: 'departments',
      label: 'Departments',
      value: known(summary?.departments.total),
      icon: Network,
      // The consequence, not the count: those people have no approver for
      // anything routed by department.
      tone: (summary?.departments.withoutHead ?? 0) > 0 ? 'danger' : 'default',
      footnote: summary
        ? summary.departments.withoutHead > 0
          ? `${summary.departments.withoutHead} headless, ${summary.departments.unmanagedHeadcount} ${plural(summary.departments.unmanagedHeadcount, 'person', 'people')} with no approver`
          : 'Every department has a head'
        : undefined,
      href: '/dashboard/departments',
    },
    {
      key: 'managers',
      label: 'Managers',
      value: known(summary?.managers.total),
      icon: UserCog,
      // Past a dozen direct reports one-to-ones stop happening and the approval
      // queue behind that person becomes the bottleneck.
      tone: (widest?.reports ?? 0) >= 12 ? 'warning' : 'default',
      footnote: widest
        ? `Widest span: ${widest.name}, ${widest.reports} reports`
        : summary
          ? 'Nobody carries an outsized span'
          : undefined,
      href: '/dashboard/teams',
    },
    {
      // Keyed with a hyphen because the key is also the card's test id.
      key: 'change-requests',
      label: 'Pending change requests',
      value: known(summary?.changeRequests.pending),
      icon: GitPullRequestArrow,
      tone: (summary?.changeRequests.pending ?? 0) > 0 ? 'warning' : 'success',
      footnote: summary
        ? `${summary.changeRequests.approved} approved, ${summary.changeRequests.rejected} rejected`
        : undefined,
      href: '/dashboard/departments/change-requests',
    },
  ];

  // ── Needs attention ───────────────────────────────────────────────────────
  const attention: AttentionItem[] = [];
  if (summary && !failed) {
    if (summary.changeRequests.pending > 0) {
      attention.push({
        key: 'change-requests',
        label: `${summary.changeRequests.pending} change ${plural(summary.changeRequests.pending, 'request', 'requests')} waiting`,
        detail: 'Review',
        severity: 'warning',
        href: '/dashboard/departments/change-requests',
      });
    }
    for (const department of headless.slice(0, 6)) {
      attention.push({
        key: `headless-${department.id}`,
        label: `${department.name} has no head`,
        detail: `${department.employees} ${plural(department.employees, 'person', 'people')}`,
        // A headless department with nobody in it is untidy; one with staff in
        // it means those people have no approver, which is an outage.
        severity: department.employees > 0 ? 'critical' : 'info',
        href: '/dashboard/departments',
      });
    }
    if (summary.unassigned.noBranch > 0) {
      attention.push({
        key: 'no-branch',
        label: `${summary.unassigned.noBranch} ${plural(summary.unassigned.noBranch, 'employee is', 'employees are')} posted to no branch`,
        detail: 'Assign',
        severity: 'warning',
        href: '/dashboard/employees',
      });
    }
    if (summary.branches.withoutManager > 0) {
      attention.push({
        key: 'branch-no-manager',
        label: `${summary.branches.withoutManager} ${plural(summary.branches.withoutManager, 'branch has', 'branches have')} no manager`,
        detail: 'Assign',
        severity: 'warning',
        href: '/dashboard/branches',
      });
    }
    if (widest && widest.reports >= 12) {
      attention.push({
        key: 'widest-span',
        label: `${widest.name} carries ${widest.reports} direct reports`,
        detail: 'Review',
        severity: 'info',
        href: '/dashboard/teams',
      });
    }
  }

  // ── Headcount by department ───────────────────────────────────────────────
  // The largest department is tinted so the chart has a subject, but its
  // tooltip stays shut until somebody hovers: opened on mount it draws straight
  // over the panel's own heading.
  const barItems: BarOverviewItem[] = deptRows.slice(0, 12).map((department, i) => ({
    key: department.id,
    label: department.name,
    value: department.employees,
    highlight: i === 0,
    tooltipTitle: department.name,
    tooltipRows: [
      { label: 'People', value: department.employees, emphasis: true },
      {
        label: 'Share of workforce',
        value: department.share === null ? '—' : `${department.share.toFixed(1)}%`,
      },
    ],
  }));
  const axis = axisFor(Math.max(1, ...barItems.map((item) => item.value)));

  // The concentration line: no headcount total ever surfaces that one team
  // holds half the company.
  const biggest = deptRows[0];
  const chartHint =
    biggest && biggest.share !== null
      ? `${biggest.name} holds ${biggest.share.toFixed(0)}% of the workforce.`
      : 'People per department, largest first.';

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
            title="Needs attention"
            items={attention}
            loading={loading}
            emptyLabel={
              failed
                ? 'The structure could not be read, so nothing here is an all-clear.'
                : 'Every branch and department has somebody accountable for it.'
            }
            seeAll={{ label: 'See departments', href: '/dashboard/departments' }}
          />

          {/* Where the workforce sits — by department, then by location. */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="surface-panel flex flex-col justify-between rounded-[20px] p-6 lg:col-span-7 xl:col-span-8">
              <PanelHeader
                title="Headcount by department"
                hint={summary && !failed ? chartHint : undefined}
                action={<PanelLink href="/dashboard/departments">See departments</PanelLink>}
              />
              {/* min-h keeps the chart readable when this is the shorter panel;
                  flex-1 lets it fill when the branch list runs taller. */}
              <div className="mt-2 flex min-h-[260px] flex-1 pt-2">
                {barItems.length === 0 || barItems.every((item) => item.value === 0) ? (
                  <p className="w-full py-16 text-center text-[13px] text-text-muted">
                    {failed
                      ? 'The department figures could not be read.'
                      : 'No department has anybody posted to it.'}
                  </p>
                ) : (
                  <div className="min-w-0 flex-1">
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

            <div className="flex flex-col lg:col-span-5 xl:col-span-4">
              <BranchWorkforceMeters
                rows={summary?.branches.rows}
                withoutManager={summary?.branches.withoutManager ?? 0}
                loading={loading}
                failed={failed}
              />
            </div>
          </div>

          {/* The structure, the queue, and the direction of travel. */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            <OrgStructureBlocks summary={failed ? undefined : summary} loading={loading} />
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
