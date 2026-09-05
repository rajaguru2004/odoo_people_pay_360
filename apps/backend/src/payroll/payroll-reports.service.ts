import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PayrollRunStatus,
  SalaryComponentType,
  type Prisma,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { dayKeyToDate, rate } from '../attendances/attendance-calendar.util';
import { roundDays, roundMoney } from './payroll-calc.util';
import { periodFor, periodLabel } from './payroll-period.util';
import {
  companyToday,
  LOCKED_RUN_STATUSES,
  money,
} from './payroll-hub.service';
import type { CostGroupBy } from './dto/report-query.dto';

/**
 * The payroll reports: register, cost, statutory and year-to-date.
 *
 * **Every one of them reads locked runs only.** `APPROVED` and `PAID`, the same
 * set the hub's money comes from. A DRAFT is a working figure that is still
 * being corrected, and a register printed off one would be a document stating
 * numbers the company has not agreed to pay — filed, sent to an auditor, and
 * wrong. Naming an unlocked run is therefore refused with a sentence rather
 * than silently answered with figures nobody has approved.
 *
 * Reports read the payslip and its LINES, never the salary structure behind
 * them. `SalaryStructure.employeeId` is `@unique`, so a pay rise overwrites the
 * structure; the record of what was actually paid lives on the payslip.
 */

/** The bucket a payslip lands in when its employee has no unit assigned. */
const UNASSIGNED = 'Unassigned';

const STATUTORY_TYPES: SalaryComponentType[] = [
  SalaryComponentType.DEDUCTION,
  SalaryComponentType.EMPLOYER_CONTRIBUTION,
];

export interface ReportRunHeader {
  id: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  currency: string;
  employeeCount: number;
  approvedAt: Date | null;
  paidAt: Date | null;
}

export interface RegisterLine {
  code: string;
  label: string;
  type: SalaryComponentType;
  amount: number;
  sequence: number;
}

export interface RegisterRow {
  payslipId: string;
  payslipNumber: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  position: string | null;
  department: string | null;
  branch: string | null;
  workDays: number;
  paidDays: number;
  lopDays: number;
  gross: number;
  deductions: number;
  net: number;
  employerCost: number;
  lines: RegisterLine[];
}

export interface MoneyTotals {
  gross: number;
  deductions: number;
  net: number;
  employerCost: number;
}

export interface CostRow extends MoneyTotals {
  id: string | null;
  name: string;
  employees: number;
  totalCost: number;
  /** This group's slice of the total employer cost; `null` when there is none. */
  share: number | null;
}

export interface StatutoryRow {
  code: string;
  label: string;
  type: SalaryComponentType;
  amount: number;
  employees: number;
}

export interface YtdPeriodRow extends MoneyTotals {
  label: string;
  periodStart: string;
  payslipId: string;
  payslipNumber: string;
}

/** A `Decimal(5, 2)` day count as a number. */
function days(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value.toString());
  return roundDays(Number.isFinite(parsed) ? parsed : 0);
}

/** `YYYY-MM-DD` for a date-only column, without ever applying a zone. */
function dayKey(date: Date): string {
  return DateTime.fromJSDate(date, { zone: 'utc' }).toFormat('yyyy-MM-dd');
}

const emptyTotals = (): MoneyTotals => ({
  gross: 0,
  deductions: 0,
  net: 0,
  employerCost: 0,
});

function addTotals(into: MoneyTotals, row: MoneyTotals): void {
  into.gross = roundMoney(into.gross + row.gross);
  into.deductions = roundMoney(into.deductions + row.deductions);
  into.net = roundMoney(into.net + row.net);
  into.employerCost = roundMoney(into.employerCost + row.employerCost);
}

/** The payslip columns every report reads, spelled once. */
const PAYSLIP_MONEY = {
  grossPay: true,
  totalDeductions: true,
  netPay: true,
  totalEmployerCost: true,
} as const;

@Injectable()
export class PayrollReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every payslip in a run, with its lines.
   *
   * The whole run in one answer rather than a page: a payroll register is a
   * document, and half of one is not a smaller document — it is a wrong one.
   * A run is bounded by headcount, so the size is bounded too.
   */
  async register(runId: string) {
    const run = await this.lockedRun(runId);

    const payslips = await this.prisma.payslip.findMany({
      where: { payrollRunId: run.id },
      select: {
        id: true,
        payslipNumber: true,
        workDays: true,
        paidDays: true,
        lopDays: true,
        ...PAYSLIP_MONEY,
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            position: true,
            department: { select: { name: true } },
            branch: { select: { name: true } },
          },
        },
        lines: {
          select: {
            code: true,
            label: true,
            type: true,
            amount: true,
            sequence: true,
          },
          orderBy: [{ sequence: 'asc' }, { code: 'asc' }],
        },
      },
      orderBy: { payslipNumber: 'asc' },
    });

    const totals = emptyTotals();
    const rows: RegisterRow[] = payslips.map((slip) => {
      const row: RegisterRow = {
        payslipId: slip.id,
        payslipNumber: slip.payslipNumber,
        employeeId: slip.employee.id,
        employeeCode: slip.employee.employeeCode,
        name: `${slip.employee.firstName} ${slip.employee.lastName}`.trim(),
        position: slip.employee.position,
        department: slip.employee.department?.name ?? null,
        branch: slip.employee.branch?.name ?? null,
        workDays: slip.workDays,
        paidDays: days(slip.paidDays),
        lopDays: days(slip.lopDays),
        gross: money(slip.grossPay),
        deductions: money(slip.totalDeductions),
        net: money(slip.netPay),
        employerCost: money(slip.totalEmployerCost),
        lines: slip.lines.map((line) => ({
          code: line.code,
          label: line.label,
          type: line.type,
          amount: money(line.amount),
          sequence: line.sequence,
        })),
      };
      addTotals(totals, row);
      return row;
    });

    return { run, rows, totals, count: rows.length };
  }

  /**
   * What the run cost, per department or per branch.
   *
   * Grouped in memory rather than by the database because the axis lives on the
   * EMPLOYEE, not the payslip — a payslip has no department column, and a join
   * plus a group-by would still have to walk the same rows. One run's payslips
   * is a bounded set.
   *
   * The unit is denormalised nowhere, so a person who has since moved
   * department is reported under the department they are in now. That is the
   * honest answer to "what does this department cost", which is the question
   * the page asks.
   */
  async cost(runId: string, groupBy: CostGroupBy) {
    const run = await this.lockedRun(runId);

    const payslips = await this.prisma.payslip.findMany({
      where: { payrollRunId: run.id },
      select: {
        ...PAYSLIP_MONEY,
        employee: {
          select: {
            department: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true } },
          },
        },
      },
    });

    const groups = new Map<string, CostRow>();
    const totals = emptyTotals();

    for (const slip of payslips) {
      const unit =
        groupBy === 'branch' ? slip.employee.branch : slip.employee.department;
      const key = unit?.id ?? UNASSIGNED;
      const row: CostRow = groups.get(key) ?? {
        id: unit?.id ?? null,
        name: unit?.name ?? UNASSIGNED,
        employees: 0,
        ...emptyTotals(),
        totalCost: 0,
        share: null,
      };

      const slipTotals: MoneyTotals = {
        gross: money(slip.grossPay),
        deductions: money(slip.totalDeductions),
        net: money(slip.netPay),
        employerCost: money(slip.totalEmployerCost),
      };
      addTotals(row, slipTotals);
      addTotals(totals, slipTotals);
      row.employees += 1;
      row.totalCost = roundMoney(row.gross + row.employerCost);
      groups.set(key, row);
    }

    const grandTotal = roundMoney(totals.gross + totals.employerCost);
    const rows = [...groups.values()]
      .map((row) => ({
        ...row,
        // Null, never 0, when there is nothing to divide by: a run that cost
        // nothing is not a group that holds none of the cost.
        share: rate(row.totalCost, grandTotal),
      }))
      .sort(
        (a, b) => b.totalCost - a.totalCost || a.name.localeCompare(b.name),
      );

    return { run, groupBy, rows, totals: { ...totals, totalCost: grandTotal } };
  }

  /**
   * Deductions and employer contributions, by component.
   *
   * Grouped on the payslip line's own `code` and `label` rather than through
   * `componentId`: the id is nullable, and the snapshot is the point — a
   * component renamed or retired since the run must still report under the name
   * it was paid as.
   */
  async statutory(runId: string) {
    const run = await this.lockedRun(runId);

    const groups = await this.prisma.payslipLine.groupBy({
      by: ['code', 'label', 'type'],
      where: {
        payslip: { payrollRunId: run.id },
        type: { in: STATUTORY_TYPES },
      },
      _sum: { amount: true },
      // Counted in the database, so the figure is the true number of payslips
      // carrying the line rather than the length of anything fetched.
      _count: { _all: true },
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
    });

    const rows: StatutoryRow[] = groups.map((group) => ({
      code: group.code,
      label: group.label,
      type: group.type,
      amount: money(group._sum.amount),
      employees: group._count._all,
    }));

    const of = (type: SalaryComponentType) =>
      rows.filter((row) => row.type === type);
    const sum = (subset: StatutoryRow[]) =>
      roundMoney(subset.reduce((total, row) => total + row.amount, 0));

    const deductions = of(SalaryComponentType.DEDUCTION);
    const contributions = of(SalaryComponentType.EMPLOYER_CONTRIBUTION);

    return {
      run,
      deductions,
      employerContributions: contributions,
      totals: {
        deductions: sum(deductions),
        employerContributions: sum(contributions),
        combined: roundMoney(sum(deductions) + sum(contributions)),
      },
    };
  }

  /**
   * One employee's calendar year, across locked runs only.
   *
   * A year-to-date figure is the one an employee takes to a bank or a tax
   * office. A draft run inside it would make the number move after it had been
   * quoted, so an unapproved month is simply not in the total — and the
   * per-period breakdown shows exactly which months are.
   */
  async ytd(employeeId: string, year?: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        position: true,
        department: { select: { name: true } },
        branch: { select: { name: true } },
      },
    });
    if (!employee) {
      throw new NotFoundException(`Employee ${employeeId} was not found`);
    }

    const resolvedYear =
      year ?? Number((await companyToday(this.prisma)).slice(0, 4));
    const from = dayKeyToDate(periodFor(1, resolvedYear).periodStart);
    const to = dayKeyToDate(periodFor(12, resolvedYear).periodStart);

    const payslips = await this.prisma.payslip.findMany({
      where: {
        employeeId,
        payrollRun: {
          status: { in: LOCKED_RUN_STATUSES },
          periodStart: { gte: from, lte: to },
        },
      },
      select: {
        id: true,
        payslipNumber: true,
        workDays: true,
        paidDays: true,
        lopDays: true,
        ...PAYSLIP_MONEY,
        payrollRun: { select: { periodStart: true, currency: true } },
        lines: {
          select: { code: true, label: true, type: true, amount: true },
        },
      },
      orderBy: { payrollRun: { periodStart: 'asc' } },
    });

    const totals = emptyTotals();
    const byComponent = new Map<string, StatutoryRow>();
    let workDays = 0;
    let paidDays = 0;
    let lopDays = 0;

    const periods: YtdPeriodRow[] = payslips.map((slip) => {
      const row: YtdPeriodRow = {
        // The server owns every bucket label — `Aug 2026` arrives formatted and
        // the browser does no calendar maths.
        label: periodLabel(slip.payrollRun.periodStart),
        periodStart: dayKey(slip.payrollRun.periodStart),
        payslipId: slip.id,
        payslipNumber: slip.payslipNumber,
        gross: money(slip.grossPay),
        deductions: money(slip.totalDeductions),
        net: money(slip.netPay),
        employerCost: money(slip.totalEmployerCost),
      };
      addTotals(totals, row);
      workDays += slip.workDays;
      paidDays = roundDays(paidDays + days(slip.paidDays));
      lopDays = roundDays(lopDays + days(slip.lopDays));

      for (const line of slip.lines) {
        const key = `${line.type}|${line.code}`;
        const entry = byComponent.get(key) ?? {
          code: line.code,
          label: line.label,
          type: line.type,
          amount: 0,
          employees: 0,
        };
        entry.amount = roundMoney(entry.amount + money(line.amount));
        entry.employees += 1;
        byComponent.set(key, entry);
      }

      return row;
    });

    return {
      year: resolvedYear,
      employee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        name: `${employee.firstName} ${employee.lastName}`.trim(),
        position: employee.position,
        department: employee.department?.name ?? null,
        branch: employee.branch?.name ?? null,
      },
      currency: payslips[0]?.payrollRun.currency ?? null,
      totals: { ...totals, workDays, paidDays, lopDays },
      /** How many locked periods the totals are built from. */
      periodsPaid: periods.length,
      periods,
      byComponent: [...byComponent.values()].sort(
        (a, b) => a.type.localeCompare(b.type) || a.code.localeCompare(b.code),
      ),
    };
  }

  /**
   * The run a report may read, or a sentence saying why it may not.
   *
   * The refusal names the status it found, because "not allowed" without it
   * sends the reader looking for a permission problem they do not have.
   */
  private async lockedRun(runId: string): Promise<ReportRunHeader> {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        status: true,
        currency: true,
        employeeCount: true,
        approvedAt: true,
        paidAt: true,
      },
    });
    if (!run) {
      throw new NotFoundException(`Payroll run ${runId} was not found`);
    }

    const label = periodLabel(run.periodStart);
    if (!LOCKED_RUN_STATUSES.includes(run.status)) {
      throw new BadRequestException(
        `The ${label} run is ${run.status}. Payroll reports read locked runs ` +
          'only — a run must be APPROVED or PAID before it can be reported ' +
          'on, because a draft is a working figure that is still being ' +
          'corrected.',
      );
    }

    return {
      id: run.id,
      label,
      periodStart: dayKey(run.periodStart),
      periodEnd: dayKey(run.periodEnd),
      status: run.status,
      currency: run.currency,
      employeeCount: run.employeeCount,
      approvedAt: run.approvedAt,
      paidAt: run.paidAt,
    };
  }
}
