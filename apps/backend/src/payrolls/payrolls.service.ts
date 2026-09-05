import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PayrollRunStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/auth.service';

/**
 * Roles entitled to read somebody else's pay.
 *
 * Deliberately narrower than the management set the attendance module uses: a
 * MANAGER may see when their team arrived, which is an operational fact, and
 * may not see what they are paid, which is not.
 */
const PAYROLL_READER_ROLES: UserRole[] = [
  UserRole.ADMIN,
  UserRole.HR_MANAGER,
  UserRole.PAYROLL_OFFICER,
];

/**
 * The run statuses a payslip is allowed to be read at.
 *
 * A DRAFT or CALCULATED run is a figure the payroll office is still working on
 * and it moves again when the run is recalculated. Showing one as a payslip
 * would tell somebody they had been paid an amount that later changes.
 * CANCELLED is excluded for the opposite reason: it is a statement that was
 * withdrawn.
 */
const PUBLISHED_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.PAID,
];

/**
 * What a year-to-date total counts.
 *
 * Only money that has actually moved. An APPROVED run is money that is going to
 * move and is therefore a payslip, but adding it to "earned this year" would
 * make the figure disagree with what the bank has sent until the run is paid.
 */
const PAID_STATUSES: PayrollRunStatus[] = [PayrollRunStatus.PAID];

/** How many payslips the self-service list serves when no year is asked for. */
const RECENT_PAYSLIP_LIMIT = 12;

const PAYSLIP_LIST_SELECT = {
  id: true,
  payrollRunId: true,
  employeeId: true,
  grossPay: true,
  totalDeductions: true,
  netPay: true,
  createdAt: true,
  payrollRun: {
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      status: true,
      currency: true,
      approvedAt: true,
    },
  },
} satisfies Prisma.PayslipSelect;

const PAYSLIP_DETAIL_SELECT = {
  ...PAYSLIP_LIST_SELECT,
  updatedAt: true,
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      position: true,
      avatarUrl: true,
      department: { select: { id: true, name: true } },
      branch: { select: { id: true, code: true, name: true } },
    },
  },
  lines: {
    select: {
      id: true,
      componentId: true,
      label: true,
      type: true,
      amount: true,
      sequence: true,
    },
    orderBy: [{ sequence: 'asc' }, { label: 'asc' }],
  },
} satisfies Prisma.PayslipSelect;

type PayslipListRow = Prisma.PayslipGetPayload<{
  select: typeof PAYSLIP_LIST_SELECT;
}>;

/** Money here is thousandths — see the Decimal(18, 3) columns on Payslip. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The month a period belongs to, read off its FIRST day.
 *
 * `periodStart` is a DATE column, so it arrives as midnight UTC and has to be
 * read back in UTC. Putting it through the server's local zone would file a
 * period beginning on the 1st under the previous month for anybody west of
 * Greenwich.
 */
function periodMonth(periodStart: Date): { month: number; year: number } {
  return {
    month: periodStart.getUTCMonth() + 1,
    year: periodStart.getUTCFullYear(),
  };
}

/** The UTC range covering one calendar month, as the DATE columns store it. */
function monthRange(month: number, year: number) {
  return {
    gte: new Date(Date.UTC(year, month - 1, 1)),
    lt: new Date(Date.UTC(year, month, 1)),
  };
}

/** The UTC range covering one calendar year. */
function yearRange(year: number) {
  return {
    gte: new Date(Date.UTC(year, 0, 1)),
    lt: new Date(Date.UTC(year + 1, 0, 1)),
  };
}

@Injectable()
export class PayrollsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Somebody's own payslip, or a payroll role.
   *
   * Enforced here rather than with `@Roles` on the route because the answer
   * depends on WHOSE payslip it is, which a decorator cannot see. This mirrors
   * the check in `attendances.service.ts` on purpose: two self-or-privileged
   * rules that are written differently eventually disagree, and the one that is
   * wrong is the one nobody re-reads.
   */
  private assertMayRead(employeeId: string, user: Principal) {
    if (PAYROLL_READER_ROLES.includes(user.role)) return;
    if (user.employeeId && user.employeeId === employeeId) return;
    throw new ForbiddenException('You can only view your own payslips');
  }

  /** Whether this caller may see a run before it has been approved. */
  private seesUnpublished(user: Principal): boolean {
    return PAYROLL_READER_ROLES.includes(user.role);
  }

  /**
   * Flatten a row for the list.
   *
   * `month`, `year` and `status` are lifted out of the run and repeated at the
   * top level. The payslip list is sorted and filtered by period, and a screen
   * reaching two levels down for the value it groups by is a screen that breaks
   * the first time the include changes.
   */
  private toListItem(row: PayslipListRow) {
    const { month, year } = periodMonth(row.payrollRun.periodStart);
    return {
      ...row,
      month,
      year,
      status: row.payrollRun.status,
      currency: row.payrollRun.currency,
      periodStart: row.payrollRun.periodStart,
      periodEnd: row.payrollRun.periodEnd,
    };
  }

  /**
   * The caller's own payslips.
   *
   * A user with no employee record — the shape a system administrator has, on
   * purpose, so they are not counted in the headcount — has no payslips rather
   * than a broken query.
   */
  async findMine(user: Principal, year?: number) {
    if (!user.employeeId) return [];

    const rows = await this.prisma.payslip.findMany({
      where: {
        employeeId: user.employeeId,
        payrollRun: {
          status: { in: PUBLISHED_STATUSES },
          ...(year ? { periodStart: yearRange(year) } : {}),
        },
      },
      select: PAYSLIP_LIST_SELECT,
      orderBy: { payrollRun: { periodStart: 'desc' } },
      ...(year ? {} : { take: RECENT_PAYSLIP_LIMIT }),
    });

    return rows.map((row) => this.toListItem(row));
  }

  /** One of the caller's own payslips, with its breakdown. */
  async findMineById(user: Principal, payslipId: string) {
    if (!user.employeeId) throw new NotFoundException('Payslip not found');

    const row = await this.prisma.payslip.findFirst({
      where: {
        id: payslipId,
        employeeId: user.employeeId,
        payrollRun: { status: { in: PUBLISHED_STATUSES } },
      },
      select: PAYSLIP_DETAIL_SELECT,
    });
    if (!row) throw new NotFoundException('Payslip not found');

    return this.toDetail(row);
  }

  /**
   * One employee's payslip for a period, addressed by path.
   *
   * The employee comes from the URL here rather than from the token, so the
   * self-or-privileged check has to run explicitly — and the published-only
   * narrowing has to be applied for everybody who is not in the payroll office,
   * including an employee asking about themselves. Without it a direct URL
   * would serve a draft figure as a statement of pay.
   */
  async findForPeriod(
    user: Principal,
    employeeId: string,
    month: number,
    year: number,
  ) {
    this.assertMayRead(employeeId, user);

    const row = await this.prisma.payslip.findFirst({
      where: {
        employeeId,
        payrollRun: {
          periodStart: monthRange(month, year),
          ...(this.seesUnpublished(user)
            ? {}
            : { status: { in: PUBLISHED_STATUSES } }),
        },
      },
      // A month can hold more than one run — a correction run alongside the
      // original. The most recent one is the one that stands.
      orderBy: { payrollRun: { createdAt: 'desc' } },
      select: PAYSLIP_DETAIL_SELECT,
    });
    if (!row) throw new NotFoundException('Payslip not found');

    return this.toDetail(row);
  }

  /**
   * Year-to-date earnings for the caller.
   *
   * Earnings and deductions are summed from the LINES rather than from the
   * payslip totals, so the breakdown a payslip shows and the year's totals are
   * the same arithmetic. Employer contributions are excluded from both: they
   * are a cost to the company, not income to the employee, and adding them
   * would inflate the figure somebody checks against their bank statements.
   */
  async ytdSummary(user: Principal, year: number) {
    const empty = {
      year,
      employeeId: user.employeeId,
      currency: null as string | null,
      totalGross: 0,
      totalDeductions: 0,
      totalNet: 0,
      monthsCount: 0,
      monthlyBreakdown: [] as Array<{
        month: number;
        gross: number;
        deductions: number;
        net: number;
      }>,
    };
    if (!user.employeeId) return empty;

    const rows = await this.prisma.payslip.findMany({
      where: {
        employeeId: user.employeeId,
        payrollRun: {
          status: { in: PAID_STATUSES },
          periodStart: yearRange(year),
        },
      },
      select: PAYSLIP_LIST_SELECT,
      orderBy: { payrollRun: { periodStart: 'asc' } },
    });

    const summary = { ...empty, monthsCount: rows.length };

    for (const row of rows) {
      const gross = Number(row.grossPay);
      const deductions = Number(row.totalDeductions);
      const net = Number(row.netPay);

      summary.totalGross += gross;
      summary.totalDeductions += deductions;
      summary.totalNet += net;
      summary.currency ??= row.payrollRun.currency;

      summary.monthlyBreakdown.push({
        month: periodMonth(row.payrollRun.periodStart).month,
        gross: round3(gross),
        deductions: round3(deductions),
        net: round3(net),
      });
    }

    summary.totalGross = round3(summary.totalGross);
    summary.totalDeductions = round3(summary.totalDeductions);
    summary.totalNet = round3(summary.totalNet);
    return summary;
  }

  /**
   * The standing salary structure behind the payslips.
   *
   * Read-only here. What an employee is paid is set in the payroll office; this
   * endpoint exists so the payslip screen can say what the monthly figure is
   * meant to be, which is the question somebody asks when a payslip surprises
   * them.
   */
  async salaryStructure(user: Principal, employeeId: string) {
    this.assertMayRead(employeeId, user);

    const structure = await this.prisma.salaryStructure.findUnique({
      where: { employeeId },
      select: {
        id: true,
        employeeId: true,
        currency: true,
        effectiveFrom: true,
        updatedAt: true,
        lines: {
          select: {
            id: true,
            amount: true,
            component: {
              select: {
                id: true,
                code: true,
                name: true,
                type: true,
                sequence: true,
              },
            },
          },
          orderBy: { component: { sequence: 'asc' } },
        },
      },
    });
    if (!structure) {
      throw new NotFoundException(
        'No salary structure has been set for this employee',
      );
    }

    const lines = structure.lines.map((line) => ({
      id: line.id,
      componentId: line.component.id,
      code: line.component.code,
      label: line.component.name,
      type: line.component.type,
      sequence: line.component.sequence,
      amount: line.amount,
    }));

    return {
      ...structure,
      lines,
      totals: this.totalsOf(lines),
    };
  }

  private toDetail(
    row: Prisma.PayslipGetPayload<{ select: typeof PAYSLIP_DETAIL_SELECT }>,
  ) {
    const { month, year } = periodMonth(row.payrollRun.periodStart);
    const { employee, ...rest } = row;

    return {
      ...rest,
      month,
      year,
      status: row.payrollRun.status,
      currency: row.payrollRun.currency,
      periodStart: row.payrollRun.periodStart,
      periodEnd: row.payrollRun.periodEnd,
      employee: employee
        ? {
            ...employee,
            // The screens read one name field. Joined here rather than in every
            // caller, so a record with only one half of a name still renders.
            fullName: [employee.firstName, employee.lastName]
              .filter(Boolean)
              .join(' '),
          }
        : employee,
      totals: this.totalsOf(row.lines),
    };
  }

  /**
   * Earnings, deductions and employer cost, from the lines.
   *
   * A payslip carries its own gross and net columns, which is what payroll
   * wrote; these are what the printed breakdown adds up to. They are reported
   * separately rather than replacing the stored figures so a discrepancy is
   * visible instead of hidden by recomputing on read.
   */
  private totalsOf(
    lines: Array<{ type: string; amount: Prisma.Decimal | number }>,
  ) {
    let earnings = 0;
    let deductions = 0;
    let employerContributions = 0;

    for (const line of lines) {
      const amount = Number(line.amount);
      if (line.type === 'EARNING') earnings += amount;
      else if (line.type === 'DEDUCTION') deductions += amount;
      else employerContributions += amount;
    }

    return {
      earnings: round3(earnings),
      deductions: round3(deductions),
      employerContributions: round3(employerContributions),
      net: round3(earnings - deductions),
    };
  }
}
