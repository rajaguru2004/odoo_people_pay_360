import {
  Banknote,
  ClipboardCheck,
  Gauge,
  ShieldAlert,
  Users,
} from 'lucide-react';
import type { KpiStat } from '@/components/module-landing/StatCard';
import { formatCurrency, formatNumber, formatPercent } from '@/utils/formatters';
import type {
  DashboardOverview,
  DashboardSection,
} from '@/types/dashboardOverview';

/**
 * The dashboard's KPI row, built from `overview.sections`.
 *
 * Pure and separate from any component, because the rule it enforces is the one
 * this page exists to get right and it has to be testable without a DOM.
 *
 * **A section that did not arrive produces NO CARD.** Not a card with a zero,
 * not a card with an em dash. `/dashboard` is the one route every role opens,
 * and the server omits a block the caller may not see rather than zeroing it —
 * so absence here means "you are not entitled to this figure", while an em dash
 * means "this figure exists and we could not compute it". Drawing an em dash for
 * an absent section tells an employee the company has a net-pay total that the
 * page merely failed to fetch, and drawing a 0 tells them it paid nothing. Both
 * are false, and the reader cannot tell either from the real thing.
 *
 * **`undefined` overview is the loading pass, not an absence.** Nothing has
 * arrived yet, so every card is built with a `null` value and `KpiRow` draws
 * skeletons over the full set. Once the response lands, the row narrows to the
 * sections the caller actually has — the only shape change on the page, and it
 * happens once.
 *
 * Every card links to the screen that ANSWERS it, and each href is a route the
 * roles receiving that section can reach (`utils/permissions.ts`): the
 * directory rather than the People hub for headcount, since the hub is ADMIN/HR
 * only while `VIEW_EMPLOYEES` reaches down to a manager.
 */
export function buildDashboardKpis(
  overview: DashboardOverview | undefined,
): KpiStat[] {
  // Before the response lands nothing has been refused yet, so every card is
  // offered; afterwards `sections` is the only authority on what may be drawn.
  const has = (section: DashboardSection) =>
    overview === undefined || overview.sections.includes(section);

  const currency = overview?.currency ?? 'OMR';
  const stats: KpiStat[] = [];

  if (has('workforce')) {
    const workforce = overview?.workforce;
    stats.push({
      key: 'headcount',
      label: 'Headcount',
      value: workforce ? formatNumber(workforce.headcount) : null,
      icon: Users,
      tone: 'default',
      subStats: [
        {
          key: 'joiners',
          label: 'Joined this month',
          value: workforce ? formatNumber(workforce.joinersThisMonth) : null,
        },
        {
          key: 'leavers',
          label: 'Left this month',
          value: workforce ? formatNumber(workforce.leaversThisMonth) : null,
        },
      ],
      // `headcountEnd` is `null` for a month the backwards walk cannot
      // reconstruct. Those are DROPPED rather than coerced to 0:
      // `generateSparkPath` needs numbers, and a zero would draw a cliff into
      // the line that says the company emptied out that month. Fewer than two
      // survivors draws nothing at all, which is the honest outcome.
      trend: workforce?.trend
        .map((bucket) => bucket.headcountEnd)
        .filter((value): value is number => value !== null),
      href: '/dashboard/employees',
      footnote: 'Active employees today.',
    });
  }

  if (has('attendance')) {
    const attendance = overview?.attendance;
    stats.push({
      key: 'attendanceToday',
      label: 'Attendance today',
      // `formatPercent` already prints an em dash for `null` — the rate is
      // `null` when nobody was expected, and 0.0% would report a closed branch
      // as a failed one.
      value: attendance ? formatPercent(attendance.attendanceRate) : null,
      icon: Gauge,
      tone: 'success',
      subStats: [
        {
          key: 'present',
          label: 'Present',
          value: attendance ? formatNumber(attendance.present) : null,
        },
        {
          key: 'onLeave',
          label: 'On leave',
          value: attendance ? formatNumber(attendance.onLeave) : null,
        },
      ],
      href: '/dashboard/attendance',
      // Whether the day is SETTLED changes what the figure means, so it is said
      // on the card rather than left to the reader. Before the office end,
      // "absent" is a prediction: somebody who has not arrived at 09:30 may
      // still arrive, and a figure quoted at lunchtime will be wrong by five.
      footnote: attendance
        ? attendance.settled
          ? 'The working day has closed; these are final.'
          : 'The day is still open — absences are not final yet.'
        : 'Against the working calendar, minus approved leave.',
    });
  }

  if (has('payroll')) {
    const payroll = overview?.payroll;
    const net = payroll?.netThisPeriod ?? null;
    const previousNet = payroll?.previousNet ?? 0;
    const changePct = payroll?.changePct ?? null;

    stats.push({
      key: 'netPaid',
      label: 'Net paid',
      // `null` stays `null`. No locked run for the period is not a payroll of
      // zero — one says the money has not been released yet, the other says the
      // company paid nobody.
      value: net === null ? null : formatCurrency(net, currency),
      icon: Banknote,
      tone: 'default',
      delta:
        changePct === null || net === null
          ? undefined
          : {
              value: Math.abs(changePct),
              direction: net >= previousNet ? 'up' : 'down',
              // Neither direction is good news on its own — payroll rising can
              // be hiring or can be overtime — so the arrow is left neutral by
              // pointing `goodDirection` at whichever way it went.
              goodDirection: net >= previousNet ? 'up' : 'down',
              // The absolute change, matching the payroll analytics page: for
              // money the reader was going to work out the difference anyway,
              // and a percentage off a small base reads as drama that is not
              // there.
              display: formatCurrency(Math.abs(net - previousNet), currency),
              label: 'vs previous period',
            },
      subStats: [
        {
          key: 'employeesPaid',
          label: 'Employees paid',
          value: payroll ? formatNumber(payroll.employeesPaid) : null,
        },
        {
          key: 'lastRun',
          label: 'Last run',
          value: payroll?.lastRun?.label ?? null,
        },
      ],
      href: '/dashboard/payroll/runs',
      footnote:
        payroll && payroll.netThisPeriod === null
          ? 'No run is locked for this period yet.'
          : `Locked runs for ${overview?.periodLabel ?? 'this period'}.`,
    });
  }

  if (has('approvals')) {
    const approvals = overview?.approvals;
    stats.push({
      key: 'approvals',
      label: 'Pending approvals',
      value: approvals ? formatNumber(approvals.total) : null,
      icon: ClipboardCheck,
      // A queue with work in it is the one card on this row that asks the
      // reader to DO something today.
      tone: approvals && approvals.total > 0 ? 'warning' : 'default',
      // The server built each queue's href for this caller, so the top-ranked
      // one is guaranteed reachable by whoever received the section. The
      // fallback only fires for an empty queue, where the card is a dead end
      // anyway.
      href: approvals?.items[0]?.href ?? '/dashboard/leaves/pending',
      footnote: 'Requests waiting on a decision.',
    });
  }

  if (has('compliance')) {
    const compliance = overview?.compliance;
    const total = compliance
      ? compliance.documents.count +
        compliance.contracts.count +
        compliance.probation.count
      : null;
    // `items` is a capped sample, but the server orders it soonest-first, so
    // anything already past shows up in it. This reads the sample deliberately:
    // the counts alone cannot say whether a deadline has been MISSED, and a
    // missed one is a different colour of problem from an approaching one.
    const expired = compliance
      ? [compliance.documents, compliance.contracts, compliance.probation].some(
          (group) => group.items.some((item) => item.daysLeft < 0),
        )
      : false;

    stats.push({
      key: 'expiring',
      label: 'Expiring soon',
      value: total === null ? null : formatNumber(total),
      icon: ShieldAlert,
      tone: expired ? 'danger' : total ? 'warning' : 'default',
      subStats: [
        {
          key: 'documents',
          label: 'Documents',
          value: compliance ? formatNumber(compliance.documents.count) : null,
        },
        {
          key: 'contracts',
          label: 'Contracts',
          value: compliance ? formatNumber(compliance.contracts.count) : null,
        },
        {
          key: 'probation',
          label: 'Probation',
          value: compliance ? formatNumber(compliance.probation.count) : null,
        },
      ],
      href: '/dashboard/contracts',
      footnote: compliance
        ? `Documents, contracts and probation within ${compliance.horizonDays} days.`
        : 'Documents, contracts and probation falling due.',
    });
  }

  return stats;
}
