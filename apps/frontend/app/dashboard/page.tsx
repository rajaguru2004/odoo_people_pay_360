'use client';

import EmployeeDashboard from '@/components/dashboard/EmployeeDashboard';
import MyCornerPanel from '@/components/dashboard/MyCornerPanel';
import ApprovalsQueue from '@/components/dashboard/ApprovalsQueue';
import ExpiringSoonPanel from '@/components/dashboard/ExpiringSoonPanel';
import HeadcountByDepartmentChart from '@/components/dashboard/HeadcountByDepartmentChart';
import TodayAttendanceDonut from '@/components/dashboard/TodayAttendanceDonut';
import WorkforceTrendChart from '@/components/dashboard/WorkforceTrendChart';
import { buildDashboardKpis } from '@/components/dashboard/dashboardKpis';
import DepartmentCostChart from '@/components/payroll/dashboard/DepartmentCostChart';
import NetSalaryTrendChart from '@/components/payroll/dashboard/NetSalaryTrendChart';
import { KpiRow } from '@/components/module-landing/StatCard';
import { SegmentedTimeFilter } from '@/components/module-landing/primitives';
import { useDashboardOverview } from '@/hooks/useDashboardOverview';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import { fullName } from '@/utils/formatters';
import type { DashboardSection } from '@/types/dashboardOverview';

/** The two windows the aggregate offers, as the segmented control spells them. */
const WINDOW_LABEL = { 6: '6M', 12: '12M' } as const;

/**
 * The company's standing today, from the one `/dashboard/overview` aggregate.
 *
 * Composition only. Every figure on this screen is built by a panel that owns
 * its own rules about nulls, capped samples and provisional counts; this file's
 * whole job is to decide WHICH panels are entitled to be on the page, and to
 * hand each one its slice of a single response.
 */
function ManagementDashboard() {
  const { overview, months, setMonths, loading, refetching, failed } =
    useDashboardOverview();

  /**
   * The one rule everything below turns on.
   *
   * Nothing reads `overview` directly for a figure. The moment the read fails
   * the payload is dropped entirely, so every panel falls to its own em dash
   * rather than to a zero — an empty company and an unreachable endpoint are
   * different claims, and a card printing 0 for both has told the reader
   * something false about one of them.
   *
   * The `failed` check does real work even while a payload is present:
   * `placeholderData` deliberately keeps the last good response on screen so a
   * 6 → 12 switch does not blank the page, which means `overview` existing is
   * not evidence that any of it is current.
   */
  const data = failed ? undefined : overview;

  /**
   * Entitlement, never truthiness.
   *
   * `sections` is the server's statement of which blocks this caller may see,
   * and a block they may not see is ABSENT rather than zeroed. So an absent
   * section means "not entitled", and the panel is not drawn at all — never
   * drawn zeroed, and never drawn as an em-dash apology, because both of those
   * tell an employee that a company-wide figure exists and this page merely
   * failed to fetch it.
   *
   * `show` is the loading-pass exception: before the first response nothing has
   * been refused yet, so the shell is drawn and the panel skeletons through its
   * own `loading` prop. The page narrows to the entitled set exactly once, when
   * the response lands.
   */
  const has = (section: DashboardSection) =>
    data?.sections.includes(section) ?? false;
  const show = (section: DashboardSection) => loading || has(section);

  const showWorkforce = show('workforce');
  const showAttendance = show('attendance');
  const showApprovals = show('approvals');
  const showPayroll = show('payroll');
  const showCompliance = show('compliance');

  // Currency is frame rather than a figure: it names the units the payroll
  // panels print in. The fallback is only ever in force during the skeleton
  // pass, where no money is rendered yet.
  const currency = data?.currency ?? 'OMR';

  // `DepartmentCostChart` drills into the payslip list with `?period=`, which
  // is a machine value — `YYYY-MM` — not the human `periodLabel` the panels
  // print. Taking it off the last run's `periodStart` keeps that link pointing
  // at the period the block actually answered for, and with no locked run there
  // is no period to filter by, so the drill correctly goes unfiltered.
  const payrollPeriod = data?.payroll?.lastRun?.periodStart.slice(0, 7);

  // The colour scale keys on department id, so it needs the full list to seed
  // from or a hue moves the moment a row is dropped. Nothing filters these rows
  // on this page, so the rows ARE the full list — this seeds the palette, it
  // does not reshape the data.
  const departmentOptions = data?.payroll?.byDepartment.map((row) => ({
    value: row.id ?? '',
    label: row.name,
  }));

  // Handed to every chart together: `refetching` is what holds the previous
  // render up while a window change is in flight, so switching 6 → 12 does not
  // blank half the page under the pointer that just clicked it.
  const chart = { loading, refetching };

  // The window control is offered only where something on the page answers for
  // a window. A manager who receives attendance and approvals but neither trend
  // would otherwise get a switcher that re-queries and changes nothing visible.
  const showWindow = showWorkforce || showPayroll;

  return (
    <div className="space-y-6">
      {failed && (
        // Said out loud, in the tokens the analytics page already uses for it.
        // A dashboard that quietly renders nothing is indistinguishable from a
        // company with nothing in it.
        <p
          role="status"
          className="rounded-xl border border-status-error/30 bg-status-error-bg px-4 py-3 text-[13px] text-status-error"
        >
          The dashboard could not be read. Nothing below is showing a number it
          could not verify.
        </p>
      )}

      {showWindow && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {/* One window drives the WHOLE payload — it is a single query, so the
              trend charts can never end up answering for different periods.
              Saying so here stops the control reading as a filter belonging to
              whichever chart it happens to sit nearest. */}
          <span className="text-[12px] text-text-muted">
            Every trend below covers the last
          </span>
          <SegmentedTimeFilter
            options={[WINDOW_LABEL[6], WINDOW_LABEL[12]]}
            value={WINDOW_LABEL[months]}
            onChange={(value) => setMonths(value === WINDOW_LABEL[12] ? 12 : 6)}
          />
        </div>
      )}

      {/* Present for every role and entitlement-free: it answers about the
          caller and nobody else, which is why it sits above the company-wide
          row rather than inside it. */}
      <MyCornerPanel
        me={data?.me}
        currency={currency}
        loading={loading}
        failed={failed}
      />

      {/* `buildDashboardKpis(undefined)` already produces the full skeleton set
          and already drops a card for every section that did not arrive, so the
          row's gating lives there rather than being written a second time
          here. */}
      <KpiRow stats={buildDashboardKpis(data)} loading={loading} />

      {(showWorkforce || showAttendance) && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {showWorkforce && (
            // Spans the row when the donut beside it was not offered: a panel
            // holding two thirds of a grid with a hole where the rest should be
            // reads as something that failed to load rather than as something
            // this reader was never entitled to.
            <div
              className={showAttendance ? 'lg:col-span-8' : 'lg:col-span-12'}
            >
              <WorkforceTrendChart
                trend={data?.workforce?.trend}
                growthPct={data?.workforce?.growthPct}
                {...chart}
              />
            </div>
          )}
          {showAttendance && (
            <div className={showWorkforce ? 'lg:col-span-4' : 'lg:col-span-12'}>
              <TodayAttendanceDonut attendance={data?.attendance} {...chart} />
            </div>
          )}
        </div>
      )}

      {(showWorkforce || showApprovals) && (
        // Same collapse, expressed in the column count: a survivor on its own
        // takes the full width instead of leaving half a row empty.
        <div
          className={`grid grid-cols-1 gap-6 ${
            showWorkforce && showApprovals ? 'lg:grid-cols-2' : ''
          }`}
        >
          {showWorkforce && (
            <HeadcountByDepartmentChart
              byDepartment={data?.workforce?.byDepartment}
              {...chart}
            />
          )}
          {showApprovals && (
            <ApprovalsQueue approvals={data?.approvals} loading={loading} />
          )}
        </div>
      )}

      {showPayroll && (
        // Both panels belong to the one section, so they arrive and leave
        // together — there is no half-payroll row to collapse.
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* `payroll.trend` and `payroll.byDepartment` are deliberately the
              analytics page's shapes, so both charts mount here unchanged. Two
              shapes for one series is how the same month starts reading
              differently on two screens. */}
          <NetSalaryTrendChart
            trend={data?.payroll?.trend}
            currency={currency}
            periodLabel={data?.periodLabel}
            {...chart}
          />
          <DepartmentCostChart
            departments={data?.payroll?.byDepartment}
            departmentOptions={departmentOptions}
            currency={currency}
            period={payrollPeriod}
            {...chart}
          />
        </div>
      )}

      {/* Last, and full width: it is the only block on the page that is a list
          of named people with dates against them, and it is the one the reader
          leaves the screen to go and act on. */}
      {showCompliance && (
        <ExpiringSoonPanel compliance={data?.compliance} loading={loading} />
      )}
    </div>
  );
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isEmployee = user?.role === 'EMPLOYEE';

  // The heading lives in Topbar; a second one here would give the screen two.
  usePageHeader(
    `Welcome${user?.employee ? `, ${fullName(user.employee)}` : ''}`,
    isEmployee
      ? 'Your day, your leave, and anything still waiting on a decision.'
      : 'Here is where your organisation stands today.',
  );

  /**
   * Two dashboards, not one with the awkward parts hidden.
   *
   * The management cards read company-wide endpoints an EMPLOYEE is refused, so
   * projecting them for that role produces a screen of em dashes explaining
   * what it cannot show — an admin dashboard apologising rather than the
   * person's own. What somebody in that seat opens this page to find is their
   * own day, which is a different set of questions and a different tree.
   */
  return isEmployee ? <EmployeeDashboard /> : <ManagementDashboard />;
}
