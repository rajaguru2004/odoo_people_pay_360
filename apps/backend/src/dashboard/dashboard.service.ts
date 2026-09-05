import { Injectable } from '@nestjs/common';
import {
  AttendanceStatus,
  ContractStatus,
  EmployeeStatus,
  LegalDocumentStatus,
  PayrollRunStatus,
  RequestStatus,
  UserRole,
  type Prisma,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/auth.service';
import {
  AttendanceCalendarService,
  type ResolvedBranchConfig,
} from '../attendances/attendance-calendar.service';
import { reconcileExpected } from '../attendances/attendance-hub.service';
import { dayKeyToDate, rate } from '../attendances/attendance-calendar.util';
import { managerDepartmentIds } from '../common/utils/manager-scope.util';
import { addDays, startOfUtcDay } from '../common/utils/expiry.util';
import {
  buildWorkforceTrend,
  trendWindowEnd,
  trendWindowStart,
} from '../common/utils/workforce-trend.util';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { roundMoney } from '../payroll/payroll-calc.util';
import { periodLabel, previousPeriod } from '../payroll/payroll-period.util';
import {
  companyToday,
  describePeriod,
  LOCKED_RUN_STATUSES,
  money,
  NAME_CAP,
  trendWindow,
  type HubPeriodRef,
} from '../payroll/payroll-hub.service';
import {
  buildCumulativeTrend,
  type TrendBucket,
} from '../payroll/payroll-dashboard.util';
import {
  ageInDays,
  APPROVAL_QUEUES,
  attendanceSnapshot,
  buildApprovals,
  buildExpiryGroup,
  dayKeyOf,
  humaniseEnum,
  remainingLeaveDays,
  rollUpDepartments,
  sectionsFor,
  type ApprovalQueueCount,
  type DashboardApprovals,
  type DashboardAttendance,
  type DashboardDepartmentRow,
  type DashboardExpiryGroup,
  type DashboardSection,
} from './dashboard.util';
import { DEFAULT_DASHBOARD_MONTHS } from './dto/dashboard-query.dto';

/**
 * The main dashboard, in one request.
 *
 * `/dashboard` is the ONE route every role can open — admin, HR, payroll
 * officer, manager and employee all hold `VIEW_DASHBOARD` — which makes this
 * aggregate different in kind from the module hubs. Those are refused outright
 * to the roles that may not read them; this one is answered for everybody and
 * shaped by WHO asked.
 *
 * So the controller's `@Roles` lists all five and the narrowing happens HERE,
 * against `@CurrentUser`. That is the `attendances` idiom: whether an answer is
 * allowed depends on whose record it is, and a decorator cannot see that.
 *
 * **A section the caller may not see is ABSENT from the payload, not zeroed.**
 * A payroll block of zeroes sent to an employee would tell them the company
 * paid nothing; omitting it tells the page not to draw the panel at all.
 * `sections` says which arrived, and it is also the gate on the QUERIES — an
 * employee's request never reads a payslip that is not theirs, so the rule is
 * enforced where it costs something to break rather than only on the way out.
 *
 * Everything shared with the pages this one summarises is imported rather than
 * rewritten — `LOCKED_RUN_STATUSES`, `money`, `companyToday`, `describePeriod`,
 * `trendWindow`, `buildCumulativeTrend`, `buildWorkforceTrend`,
 * `reconcileExpected`, the branch calendar — because a dashboard that quietly
 * disagreed with the hub it links to is worse than either page alone. The
 * arithmetic that is this page's own lives in `dashboard.util.ts`, with no
 * Prisma and no Nest in it.
 *
 * The rules every figure obeys, inherited from the hubs that shipped before it:
 *
 * - **A rate is `null`, never `0`,** when there was nothing to divide by.
 * - **Attendance rates divide by `expected`** — the working calendar minus
 *   approved leave — never by headcount.
 * - **A count is counted in the database**, never measured off a page.
 * - **The server owns every label.** `Aug 2026` arrives formatted.
 * - **A named sample is not a count.** `items` is capped; `count` is the total.
 * - **Money means APPROVED or PAID.** A draft is a working figure still being
 *   corrected, and an employee must never read one off their own dashboard.
 */

export interface DashboardWorkforceBucket {
  key: string;
  label: string;
  joiners: number;
  leavers: number;
  /** `null` where the backwards walk cannot reconstruct it. Drawn as a gap. */
  headcountEnd: number | null;
}

export interface DashboardWorkforce {
  headcount: number;
  joinersThisMonth: number;
  leaversThisMonth: number;
  onProbation: number;
  /** Ordered by headcount, descending. `id` is `null` for Unassigned. */
  byDepartment: Array<{ id: string | null; name: string; headcount: number }>;
  trend: DashboardWorkforceBucket[];
  /** `null` when the window opened with nobody to measure against. */
  growthPct: number | null;
}

export interface DashboardPayroll {
  lastRun: {
    id: string;
    label: string;
    status: PayrollRunStatus;
    net: number;
    periodStart: string;
  } | null;
  /** `null` when no run is locked for the period. Never a zero. */
  netThisPeriod: number | null;
  previousNet: number | null;
  changePct: number | null;
  employeesPaid: number;
  /**
   * Deliberately the SAME shape as the analytics page's trend, so
   * `NetSalaryTrendChart` mounts here with no adapter. Two shapes for one
   * series is how the same month starts reading differently on two screens.
   */
  trend: TrendBucket[];
  /** Same reason: `DepartmentCostChart` takes these rows unchanged. */
  byDepartment: DashboardDepartmentRow[];
}

export interface DashboardCompliance {
  documents: DashboardExpiryGroup;
  contracts: DashboardExpiryGroup;
  probation: DashboardExpiryGroup;
  /** The window these were gathered over, so the panel can name it. */
  horizonDays: number;
}

/**
 * The self block, present for EVERY role.
 *
 * An employee's whole dashboard is this. It answers about the caller and nobody
 * else, which is why it is the one section with no entitlement check on it — and
 * why every field is nullable: a bare admin account has no employee record
 * behind it, and asking this of one must return nulls rather than throw.
 */
export interface DashboardMe {
  employeeId: string | null;
  todayStatus: string | null;
  leaveBalanceDays: number | null;
  pendingOwnRequests: number;
  latestPayslip: {
    id: string;
    label: string;
    net: number;
    currency: string;
  } | null;
}

export interface DashboardOverview {
  /** Which blocks arrived. A section not listed here is absent, not empty. */
  sections: DashboardSection[];
  viewer: { role: UserRole; employeeId: string | null };
  /** Today in the COMPANY clock, as a day key. */
  today: string;
  /** The period the payroll block answers for — `August 2026`. */
  periodLabel: string;
  currency: string;

  workforce?: DashboardWorkforce;
  attendance?: DashboardAttendance;
  payroll?: DashboardPayroll;
  approvals?: DashboardApprovals;
  compliance?: DashboardCompliance;
  me: DashboardMe;
}

/** The currency a deployment with no run at all reports in. */
const FALLBACK_CURRENCY = 'OMR';

/** The setting the visa report already counts down by. */
const ALERT_DAYS_KEY = 'visa_expiry_alert_days';

/**
 * The horizon used only if the platform default for that setting is ever
 * removed. Wider than the visa report's own, because this panel also counts
 * down contracts and probation, which are arranged months rather than weeks
 * ahead.
 */
const FALLBACK_HORIZON_DAYS = 60;

/** Statuses that mean somebody was at work in some measure. */
const WORKED: AttendanceStatus[] = [
  AttendanceStatus.PRESENT,
  AttendanceStatus.LATE,
  AttendanceStatus.HALF_DAY,
];

/** The employee columns every "who is expected today" walk reads. */
const ROSTER_SELECT = {
  id: true,
  status: true,
  branchId: true,
} satisfies Prisma.EmployeeSelect;

/** The person columns every expiry sample prints a name from. */
const EXPIRY_EMPLOYEE = {
  select: { id: true, firstName: true, lastName: true },
} as const;

const fullName = (person: { firstName: string; lastName: string }): string =>
  `${person.firstName} ${person.lastName}`.trim();

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: AttendanceCalendarService,
    private readonly settings: SystemSettingsService,
  ) {}

  /**
   * Everything the caller is entitled to, in one round of parallel reads.
   *
   * The entitlement table is applied ONCE, at the top, and then gates both the
   * query and the field. Six branches rather than one flat `Promise.all`
   * because five of them must not run at all for some callers — an employee's
   * dashboard request should not touch the payslip table, and "we read it and
   * then dropped it" is not the same guarantee.
   *
   * Every branch is derived from ONE `today`, read from the company clock
   * before anything else. Two cards computed a second apart either side of
   * midnight would otherwise disagree about what month it is inside a single
   * response.
   */
  async overview(
    user: Principal,
    query: { months?: number },
  ): Promise<DashboardOverview> {
    const months = query.months ?? DEFAULT_DASHBOARD_MONTHS;
    const sections = sectionsFor(user.role);
    const wants = (section: DashboardSection) => sections.includes(section);

    const todayKey = await companyToday(this.prisma);
    const anchor = monthOf(todayKey);
    const period = describePeriod(anchor.month, anchor.year);
    const prev = previousPeriod(anchor.month, anchor.year);
    const previous = describePeriod(prev.month, prev.year);
    // Read for every role, including the ones with no payroll block: it labels
    // the caller's own payslip too, and it is a unit rather than an amount.
    const currency = await this.currencyOf(period.periodStart);
    const now = new Date();

    const [workforce, attendance, payroll, approvals, compliance, me] =
      await Promise.all([
        wants('workforce') ? this.workforce(months, todayKey) : null,
        wants('attendance') ? this.attendanceToday(todayKey) : null,
        wants('payroll')
          ? this.payroll(months, anchor, period, previous, currency)
          : null,
        wants('approvals') ? this.approvals(user, now) : null,
        wants('compliance') ? this.compliance(now) : null,
        this.me(user, todayKey),
      ]);

    return {
      sections,
      viewer: { role: user.role, employeeId: user.employeeId },
      today: todayKey,
      periodLabel: fullMonthLabel(period.periodStart),
      currency,
      // Spread away rather than emitted as null. `workforce: null` and no
      // `workforce` key look the same to a truthy check and different to
      // `'workforce' in payload`; only one of them matches `sections`.
      ...(workforce ? { workforce } : {}),
      ...(attendance ? { attendance } : {}),
      ...(payroll ? { payroll } : {}),
      ...(approvals ? { approvals } : {}),
      ...(compliance ? { compliance } : {}),
      me,
    };
  }

  // ── Workforce ──────────────────────────────────────────────────────────────

  /**
   * Headcount, movement and the shape of the organisation.
   *
   * `joinersThisMonth` and `leaversThisMonth` are read off the LAST bucket of
   * the same trend rather than counted again. Two queries answering a question
   * the trend has already answered is two chances for the headline figure and
   * the final bar to disagree about the same month.
   */
  private async workforce(
    months: number,
    todayKey: string,
  ): Promise<DashboardWorkforce> {
    const today = dayKeyToDate(todayKey);
    const windowStart = trendWindowStart(months, today);
    const windowEnd = trendWindowEnd(today);
    const active: Prisma.EmployeeWhereInput = {
      status: EmployeeStatus.ACTIVE,
    };

    const [headcount, byDepartment, departments, onProbation, hires, exits] =
      await Promise.all([
        this.prisma.employee.count({ where: active }),
        this.prisma.employee.groupBy({
          by: ['departmentId'],
          where: active,
          _count: { _all: true },
        }),
        this.prisma.department.findMany({ select: { id: true, name: true } }),
        // Live contracts only. A probation date on a contract that has been
        // renewed or terminated is a review nobody has to do.
        this.prisma.contract.count({
          where: {
            status: ContractStatus.ACTIVE,
            probationEndDate: { gte: today },
          },
        }),
        this.prisma.employee.findMany({
          where: { hireDate: { gte: windowStart, lt: windowEnd } },
          select: { hireDate: true },
        }),
        this.prisma.employee.findMany({
          where: { exitDate: { gte: windowStart, lt: windowEnd } },
          select: { exitDate: true },
        }),
      ]);

    const trend = buildWorkforceTrend({
      months,
      hireDates: hires
        .map((row) => row.hireDate)
        .filter((date): date is Date => date !== null),
      exitDates: exits
        .map((row) => row.exitDate)
        .filter((date): date is Date => date !== null),
      currentHeadcount: headcount,
      // The company's today, not the server's. A trend anchored to a different
      // day than the rest of the payload would put a joiner in the wrong month
      // for a few hours either side of midnight.
      now: today,
    });
    const thisMonth = trend.buckets[trend.buckets.length - 1];

    const nameOf = new Map(departments.map((row) => [row.id, row.name]));

    return {
      headcount,
      joinersThisMonth: thisMonth?.joiners ?? 0,
      leaversThisMonth: thisMonth?.leavers ?? 0,
      onProbation,
      byDepartment: byDepartment
        .map((group) => ({
          id: group.departmentId,
          // An employee in no department is an explicit row, not a dropped
          // one: those are usually the records somebody needs to go and fix,
          // and omitting them makes the split disagree with the headcount.
          name: group.departmentId
            ? (nameOf.get(group.departmentId) ?? 'Unassigned')
            : 'Unassigned',
          headcount: group._count._all,
        }))
        .sort(
          (a, b) => b.headcount - a.headcount || a.name.localeCompare(b.name),
        ),
      trend: trend.buckets.map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        joiners: bucket.joiners,
        leavers: bucket.leavers,
        headcountEnd: bucket.headcountEnd,
      })),
      growthPct: trend.growthPct,
    };
  }

  // ── Attendance ─────────────────────────────────────────────────────────────

  /**
   * Who is in today, measured against who was expected today.
   *
   * The denominator is the branch calendar — weekly rest days and holidays
   * removed, per-employee roster overrides applied — minus approved leave, and
   * never the headcount. Somebody whose branch is shut was never going to
   * punch, and counting them invents an absence every weekend.
   *
   * The counts themselves are one `groupBy` and one `count` in the database.
   * The calendar walk reads the roster because a `WorkSchedule` row overrides
   * ONE person's day and set arithmetic cannot express that.
   */
  private async attendanceToday(
    todayKey: string,
  ): Promise<DashboardAttendance> {
    const date = dayKeyToDate(todayKey);

    const [configs, holidays, roster, overrides, statusGroups, lateCount] =
      await Promise.all([
        this.calendar.branchConfigs(),
        this.calendar.holidayIndex(todayKey, todayKey),
        this.prisma.employee.findMany({
          where: {
            status: { in: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] },
          },
          select: ROSTER_SELECT,
        }),
        this.prisma.workSchedule.findMany({
          where: { date },
          select: { employeeId: true, isWorkDay: true },
        }),
        this.prisma.attendance.groupBy({
          by: ['status'],
          where: { date },
          _count: { _all: true },
        }),
        this.prisma.attendance.count({ where: { date, isLate: true } }),
      ]);

    const overrideOf = new Map(
      overrides.map((row) => [row.employeeId, row.isWorkDay]),
    );
    let calendarExpected = 0;
    let calendarOnLeave = 0;
    for (const employee of roster) {
      const config = this.calendar.configFor(configs, employee.branchId);
      const working =
        overrideOf.get(employee.id) ??
        this.calendar.isBranchWorkingDay(config, todayKey, holidays);
      if (!working) continue;
      calendarExpected += 1;
      // Somebody whose RECORD says they are on leave is on leave every working
      // day, whether or not a row was written for each of them.
      if (employee.status === EmployeeStatus.ON_LEAVE) calendarOnLeave += 1;
    }

    const counted = new Map(
      statusGroups.map((group) => [group.status, group._count._all]),
    );
    const countOf = (status: AttendanceStatus) => counted.get(status) ?? 0;
    const present = WORKED.reduce((sum, status) => sum + countOf(status), 0);
    const recordedAbsent = countOf(AttendanceStatus.ABSENT);
    const onLeave = Math.max(
      countOf(AttendanceStatus.ON_LEAVE),
      calendarOnLeave,
    );

    return attendanceSnapshot({
      // Reconciled against what actually happened, so a call-out on a closed
      // day can never push the rate above a hundred per cent.
      expected: reconcileExpected(
        calendarExpected,
        onLeave,
        present,
        recordedAbsent,
      ),
      present,
      late: lateCount,
      onLeave,
      recordedAbsent,
      settled: this.isSettled(todayKey, configs),
    });
  }

  /**
   * Is every branch's office day over?
   *
   * Until it is, "absent" is a PREDICTION — somebody who has not arrived at
   * 09:30 may still arrive — and the panel says so rather than printing a
   * number that will be wrong by the afternoon. One late branch holds the whole
   * company unsettled, because a single figure cannot be half a fact.
   */
  private isSettled(
    dayKey: string,
    configs: Map<string, ResolvedBranchConfig>,
  ): boolean {
    const now = DateTime.now();
    for (const config of configs.values()) {
      if (this.calendar.officeEndInstant(dayKey, config) > now) return false;
    }
    return true;
  }

  // ── Payroll ────────────────────────────────────────────────────────────────

  /**
   * The month's payroll, from LOCKED runs only.
   *
   * Money means `APPROVED` or `PAID`, here as everywhere. A draft is a working
   * figure that is still being corrected, and a dashboard that added it to
   * "paid this month" would disagree with the register the moment somebody
   * printed one.
   *
   * `netThisPeriod` and `previousNet` are `null` — not `0` — when no run is
   * locked for the period. No run and a run that paid nothing are different
   * claims, and a card printing zero for both has told the reader something
   * false about one of them.
   */
  private async payroll(
    months: number,
    anchor: { month: number; year: number },
    period: HubPeriodRef,
    previous: HubPeriodRef,
    currency: string,
  ): Promise<DashboardPayroll> {
    const window = trendWindow(anchor.month, anchor.year, months);
    const windowStart = dayKeyToDate(window[0].periodStart);
    const periodStart = dayKeyToDate(period.periodStart);
    const lockedInPeriod: Prisma.PayslipWhereInput = {
      payrollRun: {
        periodStart,
        status: { in: LOCKED_RUN_STATUSES },
      },
    };

    const [runs, lastRun, employeesPaid, departmentRows] = await Promise.all([
      // One read of the window's runs. The trend, this period's net and the
      // previous period's all come off these same rows, so no two of them can
      // disagree — and they are the run's OWN stamped totals, which is what the
      // run header states.
      this.prisma.payrollRun.findMany({
        where: {
          periodStart: { gte: windowStart, lte: periodStart },
          status: { in: LOCKED_RUN_STATUSES },
        },
        select: {
          periodStart: true,
          currency: true,
          totalGross: true,
          totalNet: true,
          employeeCount: true,
        },
      }),
      // The most recent locked run ANYWHERE, which may predate the window: a
      // deployment that has not run payroll for a quarter still has a last run,
      // and "nothing yet" is a different message from "nothing this quarter".
      this.prisma.payrollRun.findFirst({
        where: { status: { in: LOCKED_RUN_STATUSES } },
        select: {
          id: true,
          periodStart: true,
          status: true,
          totalNet: true,
        },
        orderBy: { periodStart: 'desc' },
      }),
      this.prisma.payslip.count({ where: lockedInPeriod }),
      this.prisma.payslip.findMany({
        where: lockedInPeriod,
        select: {
          grossPay: true,
          totalDeductions: true,
          netPay: true,
          totalEmployerCost: true,
          employee: {
            select: { department: { select: { id: true, name: true } } },
          },
        },
      }),
    ]);

    const runOf = new Map(
      runs.map((run) => [dayKeyOf(run.periodStart), run] as const),
    );
    const anchorRun = runOf.get(period.periodStart);
    const previousRun = runOf.get(previous.periodStart);
    const netThisPeriod = anchorRun ? money(anchorRun.totalNet) : null;
    const previousNet = previousRun ? money(previousRun.totalNet) : null;

    return {
      lastRun: lastRun
        ? {
            id: lastRun.id,
            label: periodLabel(lastRun.periodStart),
            status: lastRun.status,
            net: money(lastRun.totalNet),
            periodStart: dayKeyOf(lastRun.periodStart),
          }
        : null,
      netThisPeriod,
      previousNet,
      // Null when either side is missing as well as when the previous period
      // paid nothing: "unchanged" is a claim about a comparison that cannot be
      // made.
      changePct:
        netThisPeriod === null || previousNet === null
          ? null
          : rate(netThisPeriod - previousNet, previousNet),
      employeesPaid,
      trend: buildCumulativeTrend(
        window.map((bucket) => {
          const run = runOf.get(bucket.periodStart);
          // A month paid in another currency is left EMPTY rather than added
          // in. Its total is real; it is just not this line's unit, and OMR
          // plus KWD is not money.
          const inUnit = run?.currency === currency ? run : undefined;
          const gross = money(inUnit?.totalGross);
          const net = money(inUnit?.totalNet);
          return {
            key: bucket.periodStart,
            label: bucket.label,
            gross,
            net,
            deductions: roundMoney(gross - net),
            employeeCount: inUnit?.employeeCount ?? 0,
          };
        }),
      ),
      byDepartment: rollUpDepartments(
        departmentRows.map((row) => ({
          gross: money(row.grossPay),
          deductions: money(row.totalDeductions),
          net: money(row.netPay),
          employerCost: money(row.totalEmployerCost),
          department: row.employee.department,
        })),
      ),
    };
  }

  /**
   * The currency the page prints its money in.
   *
   * The anchor period's run when there is one, the most recent earlier run
   * otherwise — one query, because a period has at most one run (`PayrollRun`
   * is unique on its dates) so the newest run at or before the anchor IS the
   * anchor's when it exists. A deployment with no runs at all has no money to
   * label, so the fallback is only ever attached to nulls.
   */
  private async currencyOf(anchorStart: string): Promise<string> {
    const run = await this.prisma.payrollRun.findFirst({
      where: { periodStart: { lte: dayKeyToDate(anchorStart) } },
      select: { currency: true },
      orderBy: { periodStart: 'desc' },
    });
    return run?.currency ?? FALLBACK_CURRENCY;
  }

  // ── Approvals ──────────────────────────────────────────────────────────────

  /**
   * What this caller has to decide, and how long it has been waiting.
   *
   * Only the queues the role may ACT on are read — see `APPROVAL_QUEUES` — so
   * a payroll officer's request never counts leave requests and a manager's
   * never counts terminations. Each queue is one `aggregate`: the size comes
   * from the database and the age from `_min`, rather than from a page of rows
   * that would under-report both.
   *
   * A MANAGER's leave and overtime queues are narrowed to the departments they
   * run plus the people they supervise, through the same `managerDepartmentIds`
   * the `/leave-requests` list uses. Parity with the screen the `href` opens is
   * the point: a card promising eleven decisions that lands on a list of three
   * is worse than no card.
   */
  private async approvals(
    user: Principal,
    now: Date,
  ): Promise<DashboardApprovals> {
    const wants = (key: string) =>
      APPROVAL_QUEUES.some(
        (queue) => queue.key === key && queue.roles.includes(user.role),
      );

    const scope = await managerDepartmentIds(this.prisma, user);
    const subject = subjectFilter(user, scope);
    // A manager who runs no department and supervises nobody has an empty
    // queue, not the company's. Answered without a query rather than with a
    // `where` that matches everything by accident.
    if (subject === null) return buildApprovals(user.role, []);

    const own = subject ? { employee: subject } : {};
    const pending = { status: RequestStatus.PENDING } as const;
    // `as const` rather than a plain object literal: without it the selection
    // widens to `{ _all: boolean }`, which Prisma's `Subset` refuses and which
    // loses the `_count: { _all: number }` shape `queueCount` reads off the
    // result. One shared selection is still right — six copies of it is how one
    // queue quietly stops reporting its age.
    const aggregate = {
      _count: { _all: true },
      _min: { createdAt: true },
    } as const;

    const [leave, overtime, corrections, terminations, changes, runs] =
      await Promise.all([
        wants('LEAVE_REQUESTS')
          ? this.prisma.leaveRequest.aggregate({
              where: { ...pending, ...own },
              ...aggregate,
            })
          : null,
        wants('OVERTIME_REQUESTS')
          ? this.prisma.overtimeRequest.aggregate({
              where: { ...pending, ...own },
              ...aggregate,
            })
          : null,
        wants('ATTENDANCE_CORRECTIONS')
          ? this.prisma.attendanceCorrection.aggregate({
              where: pending,
              ...aggregate,
            })
          : null,
        wants('TERMINATION_REQUESTS')
          ? this.prisma.terminationRequest.aggregate({
              where: pending,
              ...aggregate,
            })
          : null,
        wants('DEPARTMENT_CHANGE_REQUESTS')
          ? this.prisma.departmentChangeRequest.aggregate({
              where: pending,
              ...aggregate,
            })
          : null,
        // A run enters this queue when it is CALCULATED, so its age is measured
        // from `calculatedAt` and not from when the run was created — a run
        // opened in July and computed yesterday has been waiting one day.
        wants('PAYROLL_RUN_APPROVAL')
          ? this.prisma.payrollRun.aggregate({
              where: { status: PayrollRunStatus.CALCULATED },
              _count: { _all: true },
              _min: { calculatedAt: true, createdAt: true },
            })
          : null,
      ]);

    return buildApprovals(user.role, [
      queueCount('LEAVE_REQUESTS', leave, now),
      queueCount('OVERTIME_REQUESTS', overtime, now),
      queueCount('ATTENDANCE_CORRECTIONS', corrections, now),
      queueCount('TERMINATION_REQUESTS', terminations, now),
      queueCount('DEPARTMENT_CHANGE_REQUESTS', changes, now),
      queueCount(
        'PAYROLL_RUN_APPROVAL',
        runs && {
          _count: runs._count,
          _min: { createdAt: runs._min.calculatedAt ?? runs._min.createdAt },
        },
        now,
      ),
    ]);
  }

  // ── Compliance ─────────────────────────────────────────────────────────────

  /**
   * What lapses soon, and what has already lapsed.
   *
   * ADMIN and HR only, because it answers BY NAME about visas, contracts and
   * probation — the same reason the workforce-wide attendance views are refused
   * to everybody else.
   *
   * There is no lower bound on the dates. A row still marked ACTIVE whose
   * expiry is already past is exactly what this panel exists to surface: the
   * nightly job is what flips those, and between an expiry at midnight and the
   * job running, a `gte: today` filter would hide the lapsed permit that the
   * company is currently employing somebody on. `daysLeft` goes negative and
   * the row sorts to the top.
   *
   * `count` is the database's total and `items` a capped sample of it. A card
   * reporting the sample size would under-report the one number it is for.
   */
  private async compliance(now: Date): Promise<DashboardCompliance> {
    const horizonDays = await this.horizonDays();
    const today = startOfUtcDay(now);
    const horizon = addDays(today, horizonDays);

    const documentWhere: Prisma.EmployeeLegalDocumentWhereInput = {
      isCurrent: true,
      status: LegalDocumentStatus.ACTIVE,
      expiryDate: { lte: horizon },
    };
    const contractWhere: Prisma.ContractWhereInput = {
      status: ContractStatus.ACTIVE,
      endDate: { lte: horizon },
    };
    const probationWhere: Prisma.ContractWhereInput = {
      status: ContractStatus.ACTIVE,
      probationEndDate: { lte: horizon },
    };

    const [
      documentCount,
      documents,
      contractCount,
      contracts,
      probationCount,
      probation,
    ] = await Promise.all([
      this.prisma.employeeLegalDocument.count({ where: documentWhere }),
      this.prisma.employeeLegalDocument.findMany({
        where: documentWhere,
        select: {
          id: true,
          category: true,
          expiryDate: true,
          employee: EXPIRY_EMPLOYEE,
        },
        orderBy: { expiryDate: 'asc' },
        take: NAME_CAP,
      }),
      this.prisma.contract.count({ where: contractWhere }),
      this.prisma.contract.findMany({
        where: contractWhere,
        select: {
          id: true,
          contractType: true,
          endDate: true,
          employee: EXPIRY_EMPLOYEE,
        },
        orderBy: { endDate: 'asc' },
        take: NAME_CAP,
      }),
      this.prisma.contract.count({ where: probationWhere }),
      this.prisma.contract.findMany({
        where: probationWhere,
        select: {
          id: true,
          probationEndDate: true,
          employee: EXPIRY_EMPLOYEE,
        },
        orderBy: { probationEndDate: 'asc' },
        take: NAME_CAP,
      }),
    ]);

    return {
      // A document has no screen of its own, so the row opens the employee it
      // belongs to — the same destination the visa report's own rows use.
      documents: buildExpiryGroup(
        documentCount,
        documents.map((row) => ({
          id: row.id,
          employeeName: fullName(row.employee),
          kind: humaniseEnum(row.category),
          expiryDate: row.expiryDate,
          href: `/dashboard/employees/${row.employee.id}`,
        })),
        today,
        NAME_CAP,
      ),
      contracts: buildExpiryGroup(
        contractCount,
        contracts.flatMap((row) =>
          row.endDate
            ? [
                {
                  id: row.id,
                  employeeName: fullName(row.employee),
                  kind: `${humaniseEnum(row.contractType)} contract`,
                  expiryDate: row.endDate,
                  href: `/dashboard/contracts/${row.id}`,
                },
              ]
            : [],
        ),
        today,
        NAME_CAP,
      ),
      probation: buildExpiryGroup(
        probationCount,
        probation.flatMap((row) =>
          row.probationEndDate
            ? [
                {
                  id: row.id,
                  employeeName: fullName(row.employee),
                  kind: 'Probation',
                  expiryDate: row.probationEndDate,
                  href: `/dashboard/contracts/${row.id}`,
                },
              ]
            : [],
        ),
        today,
        NAME_CAP,
      ),
      // The window these were gathered over, so the panel can name it rather
      // than calling everything in the payload "expiring soon" with no period
      // attached. It is a configured setting, not a constant, so the reader
      // cannot infer it and the number has to travel with the data.
      horizonDays,
    };
  }

  /**
   * How far ahead the compliance panel looks.
   *
   * The SAME setting the visa report counts down by, so the dashboard cannot
   * call a permit "expiring soon" that the report it links to calls fine. A
   * configured zero or a negative is treated as unset: a horizon of nothing
   * would empty the panel silently.
   */
  private async horizonDays(): Promise<number> {
    const configured = await this.settings.getNumber(
      ALERT_DAYS_KEY,
      FALLBACK_HORIZON_DAYS,
    );
    return configured > 0 ? Math.trunc(configured) : FALLBACK_HORIZON_DAYS;
  }

  // ── Me ─────────────────────────────────────────────────────────────────────

  /**
   * The caller's own corner of the page, present for every role.
   *
   * A bare admin account has no employee record behind it — `User.employeeId`
   * is nullable — and that must produce nulls rather than an exception. It is
   * the one path on this endpoint that every single caller takes, so throwing
   * here would take the whole dashboard down for the account most likely to be
   * setting the system up.
   *
   * `latestPayslip` comes from a LOCKED run only. An employee reading a draft
   * net off their own dashboard would be reading a figure payroll is still
   * correcting, and they would quite reasonably treat it as a promise.
   */
  private async me(user: Principal, todayKey: string): Promise<DashboardMe> {
    const employeeId = user.employeeId;
    if (!employeeId) {
      return {
        employeeId: null,
        todayStatus: null,
        leaveBalanceDays: null,
        pendingOwnRequests: 0,
        latestPayslip: null,
      };
    }

    const year = Number(todayKey.slice(0, 4));
    const pending = { employeeId, status: RequestStatus.PENDING } as const;

    const [
      today,
      typeBalances,
      headline,
      leavePending,
      overtimePending,
      correctionsPending,
      payslip,
    ] = await Promise.all([
      this.prisma.attendance.findUnique({
        where: {
          employeeId_date: { employeeId, date: dayKeyToDate(todayKey) },
        },
        select: { status: true },
      }),
      this.prisma.leaveTypeBalance.findMany({
        where: { employeeId, year },
        select: { allocated: true, used: true, carriedOver: true },
      }),
      this.prisma.leaveBalance.findUnique({
        where: { employeeId_year: { employeeId, year } },
        select: {
          annualLeave: true,
          usedAnnual: true,
          sickLeave: true,
          usedSick: true,
          carriedOver: true,
        },
      }),
      this.prisma.leaveRequest.count({ where: pending }),
      this.prisma.overtimeRequest.count({ where: pending }),
      this.prisma.attendanceCorrection.count({ where: pending }),
      this.prisma.payslip.findFirst({
        where: {
          employeeId,
          payrollRun: { status: { in: LOCKED_RUN_STATUSES } },
        },
        select: {
          id: true,
          netPay: true,
          payrollRun: { select: { periodStart: true, currency: true } },
        },
        orderBy: { payrollRun: { periodStart: 'desc' } },
      }),
    ]);

    return {
      employeeId,
      // Null, not "ABSENT". Before the office day is over a missing row means
      // the person has not punched YET, which is not the same claim.
      todayStatus: today?.status ?? null,
      leaveBalanceDays: remainingLeaveDays(typeBalances, headline),
      pendingOwnRequests: leavePending + overtimePending + correctionsPending,
      latestPayslip: payslip
        ? {
            id: payslip.id,
            label: periodLabel(payslip.payrollRun.periodStart),
            net: money(payslip.netPay),
            currency: payslip.payrollRun.currency,
          }
        : null,
    };
  }
}

/** The month a day key falls in, read as three numbers and never zoned. */
function monthOf(key: string): { month: number; year: number } {
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
}

/**
 * `2026-08-01` → `August 2026`.
 *
 * The page title says the month in full while the chart buckets keep the short
 * `Aug 2026` that every other trend on the platform uses. Both are the server's
 * to own; the browser does no calendar maths either way.
 */
function fullMonthLabel(periodStart: string): string {
  const parsed = DateTime.fromFormat(periodStart, 'yyyy-MM-dd', {
    zone: 'utc',
  });
  return parsed.isValid ? parsed.toFormat('LLLL yyyy') : periodStart;
}

/**
 * The employees whose requests this caller may decide.
 *
 * `undefined` for a company-wide role, so the callers can spread it away rather
 * than sending an empty object into every `where`. `null` is a real answer
 * meaning "this manager decides nobody's requests" — distinct from `undefined`,
 * because an empty `OR` would otherwise be a filter that matches the whole
 * workforce and hand a manager the company's queue.
 */
function subjectFilter(
  user: Principal,
  scope: string[] | null,
): Prisma.EmployeeWhereInput | undefined | null {
  if (scope === null) return undefined;

  const clauses: Prisma.EmployeeWhereInput[] = [];
  if (scope.length > 0) clauses.push({ departmentId: { in: scope } });
  // The supervisor link is the single-approver model: a supervisor holds no
  // elevated role, so without this the person the system asks to decide would
  // not be told there is anything to decide.
  if (user.employeeId) clauses.push({ supervisorId: user.employeeId });

  return clauses.length > 0 ? { OR: clauses } : null;
}

/** What one queue's `aggregate` came back as. */
interface QueueAggregate {
  _count: { _all: number };
  _min: { createdAt: Date | null };
}

/**
 * One queue's size and age, from the aggregate that measured it.
 *
 * A queue that was never read — because the role may not act on it — is zero
 * here and is dropped by `buildApprovals`, so an unentitled queue and an empty
 * one reach the panel as the same absence.
 */
function queueCount(
  key: string,
  aggregate: QueueAggregate | null,
  now: Date,
): ApprovalQueueCount {
  const oldest = aggregate?._min.createdAt ?? null;
  return {
    key,
    count: aggregate?._count._all ?? 0,
    oldestDays: oldest ? ageInDays(oldest, now) : null,
  };
}
