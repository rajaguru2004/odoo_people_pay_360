import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AttendanceStatus,
  ContractStatus,
  EmployeeStatus,
  LibraryType,
  PayrollRunStatus,
  RequestStatus,
  SalaryComponentType,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { dayKeyToDate, rate } from '../attendances/attendance-calendar.util';
import { roundMoney } from './payroll-calc.util';
import {
  isValidPeriod,
  MAX_PAYROLL_YEAR,
  MIN_PAYROLL_YEAR,
  periodLabel,
} from './payroll-period.util';
import {
  buildAttention,
  companyToday,
  describePeriod,
  LOCKED_RUN_STATUSES,
  money,
  NAME_CAP,
  OPEN_RUN_STATUSES,
  trendWindow,
  type AttentionItem,
  type HubPeriodRef,
} from './payroll-hub.service';
import {
  addSegment,
  attendanceHealth,
  ATTENDANCE_EVENT_STATUSES,
  buildBridge,
  buildComponentMix,
  buildCumulativeTrend,
  buildFunnel,
  emptySegments,
  payrollCompletion,
  UNASSIGNED_LABEL,
  type AttendanceSegments,
  type Bridge,
  type ComponentBucket,
  type FunnelStage,
  type TrendBucket,
} from './payroll-dashboard.util';
import { UNASSIGNED } from './dto/dashboard-query.dto';

/**
 * The payroll analytics aggregate, in one request.
 *
 * Separate from `PayrollHubService` because the two answer different questions.
 * The hub is a landing page: no slicers, a fixed shape, one figure per card.
 * This is analytic — three filters, one focus period, a dozen series — and
 * widening the hub payload into both would change a shipped contract and make
 * every hub request pay for aggregates the hub never draws.
 *
 * They must not be able to disagree, so everything they share is imported from
 * the hub rather than rewritten here: `LOCKED_RUN_STATUSES`, `money`,
 * `companyToday`, `describePeriod`, `trendWindow` and `buildAttention`. The
 * arithmetic that is this page's alone lives in `payroll-dashboard.util.ts`,
 * with no Prisma in it.
 *
 * The rules every figure obeys, all four inherited from the hubs that shipped
 * before it:
 *
 * - **Money means APPROVED or PAID.** A draft is a working figure still being
 *   corrected, and a chart that added it would disagree with the register.
 * - **A rate is `null`, never `0`,** when there was nothing to divide by.
 * - **A count is counted in the database**, never measured off a page.
 * - **The server owns every label.** `Aug 2026` arrives formatted, and the
 *   running total is walked here, so the browser does no arithmetic it could
 *   get wrong on a filtered array.
 */

/** The employment-type filter's own "no value at all" bucket. */
const UNASSIGNED_TYPE = UNASSIGNED;

export interface DashboardFilterOption {
  value: string;
  label: string;
}

export interface DashboardFilters {
  /** Echoed back RESOLVED, so the filter row renders what was applied. */
  applied: {
    months: number;
    period: string;
    departmentId: string | null;
    employmentType: string | null;
  };
  departments: DashboardFilterOption[];
  employmentTypes: DashboardFilterOption[];
}

export interface DashboardMoney {
  currency: string;
  /**
   * Currencies present in the trend window that are NOT `currency`.
   *
   * Their months are excluded from every total rather than added in: OMR plus
   * KWD produces a number that is not money. Disclosed so the page can say so
   * instead of quietly drawing a shorter line.
   *
   * The focus period itself can never be mixed — `PayrollRun` is unique on
   * `[periodStart, periodEnd]`, so a period has at most one run and therefore
   * exactly one currency.
   */
  otherCurrencies: string[];
  gross: number;
  net: number;
  deductions: number;
  employerCost: number;
  previousNet: number;
  changePct: number | null;
  /** `null` when nobody was paid: an average of nothing is not zero. */
  averageNet: number | null;
}

export interface DashboardDepartmentRow {
  id: string | null;
  name: string;
  headcount: number;
  gross: number;
  deductions: number;
  net: number;
  employerCost: number;
  totalCost: number;
  /** This department's share of total cost; `null` when the total is zero. */
  share: number | null;
  avgNet: number | null;
}

export interface DashboardAttendanceRow extends AttendanceSegments {
  departmentId: string | null;
  name: string;
  total: number;
  healthPct: number | null;
}

export interface DashboardCoverage {
  present: number;
  late: number;
  absent: number;
  halfDay: number;
  onLeave: number;
  /** Event days only — `HOLIDAY` and `WEEKEND` are not attendance. */
  expected: number;
  attendanceRate: number | null;
  payrollCompletion: number | null;
  activeEmployees: number;
}

export interface PayrollDashboardSummary {
  filters: DashboardFilters;
  period: HubPeriodRef;
  previousPeriod: HubPeriodRef;
  money: DashboardMoney;
  payslips: { total: number; employeesPaid: number };
  timeOff: { approvedDays: number; approvedRequests: number };
  overtime: { approvedHours: number };
  coverage: DashboardCoverage;
  runs: {
    byStatus: Record<PayrollRunStatus, number>;
    inWindow: number;
    /** Cumulative reach, so the pipeline is monotonic. See `buildFunnel`. */
    funnel: FunnelStage[];
  };
  trend: TrendBucket[];
  departments: DashboardDepartmentRow[];
  components: ComponentBucket[];
  bridge: Bridge;
  attendance: DashboardAttendanceRow[];
  attention: AttentionItem[];
}

/** The money columns every payslip read on this page selects. */
const PAYSLIP_MONEY = {
  grossPay: true,
  totalDeductions: true,
  netPay: true,
  totalEmployerCost: true,
} as const;

const FALLBACK_CURRENCY = 'OMR';

@Injectable()
export class PayrollDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(query: {
    months?: number;
    period?: string;
    departmentId?: string;
    employmentType?: string;
  }): Promise<PayrollDashboardSummary> {
    const months = query.months ?? 12;
    // Read once. Every "is this period closed" decision below has to be made
    // against the same day, or a run can be stale on one card and open on the
    // next within a single response.
    const todayKey = await companyToday(this.prisma);
    const focus = await this.resolveFocusPeriod(query.period, todayKey);
    const previous = describePeriod(
      focus.month === 1 ? 12 : focus.month - 1,
      focus.month === 1 ? focus.year - 1 : focus.year,
    );

    const employeeWhere = await this.resolveEmployeeFilter(
      query.departmentId,
      query.employmentType,
    );

    const window = trendWindow(focus.month, focus.year, months);
    const windowStart = dayKeyToDate(window[0].periodStart);
    const focusStart = dayKeyToDate(focus.period.periodStart);
    const focusEnd = dayKeyToDate(focus.period.periodEnd);
    const previousStart = dayKeyToDate(previous.periodStart);

    /** Locked payslips in the focus period, narrowed by the slicers. */
    const focusPayslips: Prisma.PayslipWhereInput = {
      payrollRun: {
        periodStart: focusStart,
        status: { in: LOCKED_RUN_STATUSES },
      },
      ...(employeeWhere ? { employee: employeeWhere } : {}),
    };

    const activeEmployee: Prisma.EmployeeWhereInput = {
      status: EmployeeStatus.ACTIVE,
      ...(employeeWhere ?? {}),
    };
    const withoutStructure: Prisma.EmployeeWhereInput = {
      ...activeEmployee,
      salaryStructure: { is: null },
    };
    const withoutContract: Prisma.EmployeeWhereInput = {
      ...activeEmployee,
      contracts: { none: { status: ContractStatus.ACTIVE } },
    };

    const [
      runsInWindow,
      current,
      priorNet,
      departmentRows,
      componentGroups,
      attendanceGroups,
      filteredEmployees,
      leave,
      overtime,
      activeCount,
      noStructureCount,
      noStructureSample,
      noContractCount,
      noContractSample,
      awaitingApprovalRuns,
      staleOpenRuns,
    ] = await Promise.all([
      // One read of the window's runs. The trend, the status tally and the
      // currency all come off these same rows, so no two can disagree.
      this.prisma.payrollRun.findMany({
        where: { periodStart: { gte: windowStart, lte: focusStart } },
        select: {
          id: true,
          periodStart: true,
          status: true,
          currency: true,
          totalGross: true,
          totalNet: true,
          employeeCount: true,
          calculatedAt: true,
          approvedAt: true,
          paidAt: true,
        },
        orderBy: { periodStart: 'asc' },
      }),
      this.prisma.payslip.aggregate({
        where: focusPayslips,
        _sum: PAYSLIP_MONEY,
        _count: { _all: true },
      }),
      this.prisma.payslip.aggregate({
        where: {
          payrollRun: {
            periodStart: previousStart,
            status: { in: LOCKED_RUN_STATUSES },
          },
          ...(employeeWhere ? { employee: employeeWhere } : {}),
        },
        _sum: { netPay: true },
      }),
      // Prisma cannot group by a relation's column, so the department rollup
      // selects the money columns and the owning department and folds them
      // here — the same shape `payroll-reports.service.ts` uses for its cost
      // report, so the two produce the same rows for the same run.
      this.prisma.payslip.findMany({
        where: focusPayslips,
        select: {
          ...PAYSLIP_MONEY,
          employee: {
            select: { department: { select: { id: true, name: true } } },
          },
        },
      }),
      // Grouped on the payslip's own snapshot — `code` and `type` — never
      // through `componentId`, which is nullable and whose component may have
      // been renamed since.
      this.prisma.payslipLine.groupBy({
        by: ['code', 'type'],
        where: {
          payslip: focusPayslips,
          type: {
            in: [SalaryComponentType.EARNING, SalaryComponentType.DEDUCTION],
          },
        },
        _sum: { amount: true },
      }),
      // Counted in the database, one row per employee per status — at most
      // five per person — rather than reading a month of attendance rows.
      this.prisma.attendance.groupBy({
        by: ['employeeId', 'status'],
        where: {
          date: { gte: focusStart, lte: focusEnd },
          status: { in: ATTENDANCE_EVENT_STATUSES },
          ...(employeeWhere ? { employee: employeeWhere } : {}),
        },
        _count: { _all: true },
      }),
      // The employee → department map the two groupBys above are folded onto.
      this.prisma.employee.findMany({
        where: employeeWhere ?? {},
        select: {
          id: true,
          department: { select: { id: true, name: true } },
        },
      }),
      // Leave is counted in DAYS, not requests: `totalDays` is already working
      // days with the branch calendar and its holidays removed, and it is
      // stored rather than recomputed so an approved request keeps the number
      // its approver agreed to.
      this.prisma.leaveRequest.aggregate({
        where: {
          status: RequestStatus.APPROVED,
          startDate: { gte: focusStart, lte: focusEnd },
          ...(employeeWhere ? { employee: employeeWhere } : {}),
        },
        _sum: { totalDays: true },
        _count: { _all: true },
      }),
      this.prisma.overtimeRequest.aggregate({
        where: {
          status: RequestStatus.APPROVED,
          date: { gte: focusStart, lte: focusEnd },
          ...(employeeWhere ? { employee: employeeWhere } : {}),
        },
        _sum: { hours: true },
      }),
      this.prisma.employee.count({ where: activeEmployee }),
      this.prisma.employee.count({ where: withoutStructure }),
      this.namesOf(withoutStructure),
      this.prisma.employee.count({ where: withoutContract }),
      this.namesOf(withoutContract),
      // The two run-level findings are deliberately NOT narrowed by the
      // slicers. A run waiting for approval is a fact about the run, and
      // hiding it because the reader filtered to one department would let an
      // objection go unseen by the only person looking at the page.
      this.prisma.payrollRun.findMany({
        where: { status: PayrollRunStatus.CALCULATED },
        select: { periodStart: true },
        orderBy: { periodStart: 'asc' },
      }),
      this.prisma.payrollRun.findMany({
        where: {
          status: { in: OPEN_RUN_STATUSES },
          periodEnd: { lt: dayKeyToDate(todayKey) },
        },
        select: { periodStart: true },
        orderBy: { periodStart: 'asc' },
      }),
    ]);

    const currency = this.currencyOf(runsInWindow, focus.period.periodStart);
    const otherCurrencies = [
      ...new Set(
        runsInWindow
          .filter((run) => run.currency !== currency)
          .map((run) => run.currency),
      ),
    ].sort();

    const net = money(current._sum.netPay);
    const previousNet = money(priorNet._sum.netPay);
    const paidCount = current._count._all;

    const departments = this.rollUpDepartments(departmentRows);
    const attendance = this.rollUpAttendance(
      attendanceGroups,
      filteredEmployees,
    );
    const coverage = totalSegments(attendance);

    return {
      filters: {
        applied: {
          months,
          period: focus.key,
          departmentId: query.departmentId ?? null,
          employmentType: query.employmentType ?? null,
        },
        ...(await this.filterOptions()),
      },
      period: focus.period,
      previousPeriod: previous,
      money: {
        currency,
        otherCurrencies,
        gross: money(current._sum.grossPay),
        net,
        deductions: money(current._sum.totalDeductions),
        employerCost: money(current._sum.totalEmployerCost),
        previousNet,
        // Null, not zero, when the previous period paid nothing: "unchanged" is
        // a claim about a comparison that cannot be made.
        changePct: rate(net - previousNet, previousNet),
        averageNet: paidCount > 0 ? roundMoney(net / paidCount) : null,
      },
      payslips: { total: paidCount, employeesPaid: paidCount },
      timeOff: {
        approvedDays: leave._sum.totalDays ?? 0,
        approvedRequests: leave._count._all,
      },
      overtime: { approvedHours: Number(overtime._sum.hours ?? 0) },
      coverage: {
        ...coverage,
        expected: coverage.expected,
        attendanceRate: attendanceHealth(coverage),
        payrollCompletion: payrollCompletion(paidCount, activeCount),
        activeEmployees: activeCount,
      },
      runs: {
        byStatus: tallyRuns(runsInWindow),
        inWindow: runsInWindow.length,
        funnel: buildFunnel(runsInWindow),
      },
      trend: buildCumulativeTrend(
        window.map((period) => {
          const run = runsInWindow.find(
            (row) =>
              toKey(row.periodStart) === period.periodStart &&
              LOCKED_RUN_STATUSES.includes(row.status) &&
              // A month paid in another currency is left empty rather than
              // added in. Its total is real; it is just not this line's unit.
              row.currency === currency,
          );
          const gross = money(run?.totalGross);
          const runNet = money(run?.totalNet);
          return {
            key: period.periodStart,
            label: period.label,
            gross,
            net: runNet,
            deductions: roundMoney(gross - runNet),
            employeeCount: run?.employeeCount ?? 0,
          };
        }),
      ),
      departments,
      components: buildComponentMix(
        componentGroups.map((group) => ({
          code: group.code,
          type: group.type,
          amount: money(group._sum.amount),
        })),
      ),
      bridge: buildBridge({
        gross: money(current._sum.grossPay),
        deductions: money(current._sum.totalDeductions),
        net,
      }),
      attendance,
      attention: buildAttention({
        noStructure: { count: noStructureCount, names: noStructureSample },
        noContract: { count: noContractCount, names: noContractSample },
        awaitingApproval: {
          count: awaitingApprovalRuns.length,
          names: awaitingApprovalRuns
            .slice(0, NAME_CAP)
            .map((run) => periodLabel(run.periodStart)),
        },
        staleOpen: {
          count: staleOpenRuns.length,
          names: staleOpenRuns
            .slice(0, NAME_CAP)
            .map((run) => periodLabel(run.periodStart)),
        },
      }),
    };
  }

  /**
   * Which period the page opens on.
   *
   * A requested period is honoured and range-checked. Without one the answer is
   * the latest LOCKED run, not the current month: a dashboard that opened on an
   * unrun month would show a page of em dashes to a reader who has done nothing
   * wrong. With no locked run at all it falls back to the company's today,
   * which is the only honest "no data yet" the page can show.
   */
  private async resolveFocusPeriod(
    period: string | undefined,
    todayKey: string,
  ): Promise<{
    key: string;
    month: number;
    year: number;
    period: HubPeriodRef;
  }> {
    if (period) {
      const [year, month] = period.split('-').map(Number);
      if (!isValidPeriod(month, year)) {
        throw new BadRequestException(
          `period must be a month between ${MIN_PAYROLL_YEAR} and ${MAX_PAYROLL_YEAR}`,
        );
      }
      return { key: period, month, year, period: describePeriod(month, year) };
    }

    const latest = await this.prisma.payrollRun.findFirst({
      where: { status: { in: LOCKED_RUN_STATUSES } },
      select: { periodStart: true },
      orderBy: { periodStart: 'desc' },
    });

    const anchor = latest ? toKey(latest.periodStart) : todayKey;
    const [year, month] = anchor.split('-').map(Number);
    return {
      key: `${anchor.slice(0, 7)}`,
      month,
      year,
      period: describePeriod(month, year),
    };
  }

  /**
   * The employee narrowing both slicers share.
   *
   * `undefined` when nothing is filtered, so the callers can spread it away
   * rather than sending an empty object into every `where`.
   *
   * A department id that matches no department is a 400, not an empty page. A
   * dashboard showing the unfiltered company under a chip reading "Finance" has
   * lied about what the reader is looking at, and one showing nothing at all
   * cannot be told apart from a quiet month.
   */
  private async resolveEmployeeFilter(
    departmentId?: string,
    employmentType?: string,
  ): Promise<Prisma.EmployeeWhereInput | undefined> {
    const where: Prisma.EmployeeWhereInput = {};

    if (departmentId === UNASSIGNED) {
      where.departmentId = null;
    } else if (departmentId) {
      const exists = await this.prisma.department.count({
        where: { id: departmentId },
      });
      if (exists === 0) {
        throw new BadRequestException('departmentId names no department');
      }
      where.departmentId = departmentId;
    }

    if (employmentType === UNASSIGNED_TYPE) {
      where.employmentType = null;
    } else if (employmentType) {
      const exists = await this.prisma.libraryItem.count({
        where: {
          libraryType: LibraryType.EMPLOYMENT_TYPE,
          label: employmentType,
        },
      });
      if (exists === 0) {
        throw new BadRequestException(
          'employmentType names no employment type',
        );
      }
      where.employmentType = employmentType;
    }

    return Object.keys(where).length > 0 ? where : undefined;
  }

  /** What the filter row is allowed to offer, so it cannot ask for a 400. */
  private async filterOptions(): Promise<{
    departments: DashboardFilterOption[];
    employmentTypes: DashboardFilterOption[];
  }> {
    const [departments, types] = await Promise.all([
      this.prisma.department.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.libraryItem.findMany({
        where: { libraryType: LibraryType.EMPLOYMENT_TYPE, isActive: true },
        select: { label: true },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      }),
    ]);

    return {
      departments: [
        ...departments.map((d) => ({ value: d.id, label: d.name })),
        { value: UNASSIGNED, label: UNASSIGNED_LABEL },
      ],
      employmentTypes: [
        ...types.map((t) => ({ value: t.label, label: t.label })),
        { value: UNASSIGNED_TYPE, label: UNASSIGNED_LABEL },
      ],
    };
  }

  /** A capped sample of the people a `where` describes, in a stable order. */
  private async namesOf(where: Prisma.EmployeeWhereInput): Promise<string[]> {
    const people = await this.prisma.employee.findMany({
      where,
      select: { firstName: true, lastName: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: NAME_CAP,
    });
    return people.map((p) => `${p.firstName} ${p.lastName}`.trim());
  }

  /**
   * Payslips folded onto their department.
   *
   * An employee with no department goes into an explicit `Unassigned` row
   * rather than being dropped: those are usually the records somebody needs to
   * go and fix, and a chart that omits them makes the total on the page
   * disagree with the total on the run.
   */
  private rollUpDepartments(
    rows: Array<{
      grossPay: Prisma.Decimal;
      totalDeductions: Prisma.Decimal;
      netPay: Prisma.Decimal;
      totalEmployerCost: Prisma.Decimal;
      employee: { department: { id: string; name: string } | null };
    }>,
  ): DashboardDepartmentRow[] {
    const groups = new Map<string, DashboardDepartmentRow>();
    let grandTotal = 0;

    for (const row of rows) {
      const unit = row.employee.department;
      const key = unit?.id ?? UNASSIGNED;
      const group: DashboardDepartmentRow = groups.get(key) ?? {
        id: unit?.id ?? null,
        name: unit?.name ?? UNASSIGNED_LABEL,
        headcount: 0,
        gross: 0,
        deductions: 0,
        net: 0,
        employerCost: 0,
        totalCost: 0,
        share: null,
        avgNet: null,
      };

      group.headcount += 1;
      group.gross = roundMoney(group.gross + money(row.grossPay));
      group.deductions = roundMoney(
        group.deductions + money(row.totalDeductions),
      );
      group.net = roundMoney(group.net + money(row.netPay));
      group.employerCost = roundMoney(
        group.employerCost + money(row.totalEmployerCost),
      );
      group.totalCost = roundMoney(group.gross + group.employerCost);
      groups.set(key, group);
    }

    for (const group of groups.values()) grandTotal += group.totalCost;
    grandTotal = roundMoney(grandTotal);

    return [...groups.values()]
      .map((group) => ({
        ...group,
        share: rate(group.totalCost, grandTotal),
        avgNet:
          group.headcount > 0 ? roundMoney(group.net / group.headcount) : null,
      }))
      .sort(
        (a, b) => b.totalCost - a.totalCost || a.name.localeCompare(b.name),
      );
  }

  /** Attendance counts folded onto the department of the person who earned them. */
  private rollUpAttendance(
    groups: Array<{
      employeeId: string;
      status: AttendanceStatus;
      _count: { _all: number };
    }>,
    employees: Array<{
      id: string;
      department: { id: string; name: string } | null;
    }>,
  ): DashboardAttendanceRow[] {
    const departmentOf = new Map(
      employees.map((e) => [e.id, e.department] as const),
    );
    const rows = new Map<string, DashboardAttendanceRow>();

    for (const group of groups) {
      const unit = departmentOf.get(group.employeeId) ?? null;
      const key = unit?.id ?? UNASSIGNED;
      const row: DashboardAttendanceRow = rows.get(key) ?? {
        departmentId: unit?.id ?? null,
        name: unit?.name ?? UNASSIGNED_LABEL,
        ...emptySegments(),
        total: 0,
        healthPct: null,
      };
      addSegment(row, group.status, group._count._all);
      rows.set(key, row);
    }

    return [...rows.values()]
      .map((row) => {
        const total =
          row.present + row.late + row.absent + row.halfDay + row.onLeave;
        return { ...row, total, healthPct: attendanceHealth(row) };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }

  /**
   * The currency the page prints its money in.
   *
   * The focus period's run when there is one, the most recent otherwise. A
   * period has at most one run — `PayrollRun` is unique on its dates — so this
   * is never a choice between two runs of the same month.
   */
  private currencyOf(
    runs: Array<{ periodStart: Date; currency: string }>,
    focusStart: string,
  ): string {
    const focusRun = runs.find((run) => toKey(run.periodStart) === focusStart);
    if (focusRun) return focusRun.currency;
    return runs[runs.length - 1]?.currency ?? FALLBACK_CURRENCY;
  }
}

/** `YYYY-MM-DD` for a `@db.Date`, read with UTC getters and never zoned. */
function toKey(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** Every status named, so a chart never reads `undefined` as zero. */
function tallyRuns(
  runs: Array<{ status: PayrollRunStatus }>,
): Record<PayrollRunStatus, number> {
  const byStatus: Record<PayrollRunStatus, number> = {
    DRAFT: 0,
    CALCULATED: 0,
    APPROVED: 0,
    PAID: 0,
    CANCELLED: 0,
  };
  for (const run of runs) byStatus[run.status] += 1;
  return byStatus;
}

/** The whole workforce's composition, from the per-department rows. */
function totalSegments(
  rows: DashboardAttendanceRow[],
): AttendanceSegments & { expected: number } {
  const total = emptySegments();
  for (const row of rows) {
    total.present += row.present;
    total.late += row.late;
    total.absent += row.absent;
    total.halfDay += row.halfDay;
    total.onLeave += row.onLeave;
  }
  return {
    ...total,
    expected:
      total.present + total.late + total.absent + total.halfDay + total.onLeave,
  };
}
