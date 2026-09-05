import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmployeeStatus, PayrollRunStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceCalendarService } from '../attendances/attendance-calendar.service';
import {
  dayKeyToDate,
  toDayKey,
} from '../attendances/attendance-calendar.util';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import {
  calculatePayslip,
  isPayable,
  roundMoney,
  type StructureLineInput,
} from './payroll-calc.util';
import {
  eachDayKey,
  periodFor,
  periodLabel,
  type PayrollPeriod,
} from './payroll-period.util';
import { resolvePaidDays } from './payroll-attendance.util';
import {
  hasBlocker,
  resolveAttendanceCoverage,
  resolveContracts,
  resolvePopulation,
  resolveStructures,
  type PreflightFinding,
} from './payroll-preflight.rules';
import type { CreatePayrollRunDto } from './dto/create-payroll-run.dto';
import type { PreflightPayrollRunDto } from './dto/preflight-payroll-run.dto';
import type { ListPayrollRunsDto } from './dto/list-payroll-runs.dto';

/**
 * The status a run may still be recalculated in. After approval the figures are
 * a decision somebody signed, not a draft.
 */
const RECALCULABLE: PayrollRunStatus[] = [
  PayrollRunStatus.DRAFT,
  PayrollRunStatus.CALCULATED,
];

/** How many names a finding carries. The count beside them is the true total. */
const NAME_SAMPLE_CAP = 10;

const EMPLOYEE_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  branchId: true,
  departmentId: true,
} satisfies Prisma.EmployeeSelect;

interface PopulationEmployee {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  branchId: string | null;
  departmentId: string | null;
}

const fullName = (e: { firstName: string; lastName: string }) =>
  `${e.firstName} ${e.lastName}`.trim();

@Injectable()
export class PayrollRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: AttendanceCalendarService,
  ) {}

  // ---------------------------------------------------------------- listing

  async findAll(query: ListPayrollRunsDto) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.PayrollRunWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.year) {
      where.periodStart = {
        gte: dayKeyToDate(`${query.year}-01-01`),
        lte: dayKeyToDate(`${query.year}-12-31`),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.payrollRun.findMany({
        where,
        orderBy: { periodStart: 'desc' },
        skip,
        take,
      }),
      // Counted in the database. A queue longer than one page would otherwise
      // be under-reported on the card whose job is to say how much is waiting.
      this.prisma.payrollRun.count({ where }),
    ]);

    return paginated(
      rows.map((run) => this.decorate(run)),
      total,
      page,
      limit,
    );
  }

  async findOne(id: string) {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id },
      include: {
        payslips: {
          orderBy: { payslipNumber: 'asc' },
          include: {
            employee: { select: EMPLOYEE_SELECT },
          },
        },
      },
    });
    if (!run) throw new NotFoundException('Payroll run not found');

    return {
      success: true as const,
      data: {
        ...this.decorate(run),
        payslips: run.payslips,
      },
    };
  }

  /** The period label is formatted here so the browser does no calendar maths. */
  private decorate<T extends { periodStart: Date; periodEnd: Date }>(run: T) {
    return {
      ...run,
      periodLabel: periodLabel(run.periodStart),
      periodStart: toDayKey(run.periodStart),
      periodEnd: toDayKey(run.periodEnd),
    };
  }

  // -------------------------------------------------------------- pre-flight

  /**
   * Everything the run would refuse, without writing anything.
   *
   * Backed by the same `payroll-preflight.rules` functions that `calculate()`
   * guards on, so the pre-flight cannot say "ready" about a run that generation
   * then refuses.
   */
  async preflight(dto: PreflightPayrollRunDto) {
    const period = periodFor(dto.month, dto.year);
    const facts = await this.gatherFacts(period, dto.employeeIds ?? null);
    return {
      success: true as const,
      data: {
        period: {
          label: periodLabel(period.periodStart),
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
        },
        employeeCount: facts.employees.length,
        canGenerate: facts.employees.length > 0 && !hasBlocker(facts.findings),
        findings: facts.findings,
      },
    };
  }

  /**
   * The one place the run's facts are assembled.
   *
   * `calculate()` and `preflight()` both call it, which is what keeps the two
   * answers identical. Everything it returns is data; nothing here throws over
   * a business rule.
   */
  private async gatherFacts(
    period: PayrollPeriod,
    requestedIds: string[] | null,
  ) {
    const from = dayKeyToDate(period.periodStart);
    const to = dayKeyToDate(period.periodEnd);

    const where: Prisma.EmployeeWhereInput = {
      status: { not: EmployeeStatus.TERMINATED },
      // Somebody hired after the period closed was not employed in it.
      OR: [{ hireDate: null }, { hireDate: { lte: to } }],
    };
    if (requestedIds?.length) where.id = { in: requestedIds };

    const employees: PopulationEmployee[] = await this.prisma.employee.findMany(
      {
        where,
        select: EMPLOYEE_SELECT,
        orderBy: { employeeCode: 'asc' },
      },
    );

    const population = resolvePopulation({
      found: employees,
      requestedIds,
    });
    const employeeIds = population.foundIds;
    const nameOf = new Map(employees.map((e) => [e.id, fullName(e)]));

    const [structures, attendanceRows, contractRows] = await Promise.all([
      this.prisma.salaryStructure.findMany({
        where: { employeeId: { in: employeeIds } },
        include: {
          lines: {
            include: {
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
          },
        },
      }),
      this.prisma.attendance.findMany({
        where: {
          employeeId: { in: employeeIds },
          date: { gte: from, lte: to },
        },
        select: { employeeId: true, date: true, status: true },
      }),
      this.prisma.contract.findMany({
        where: { employeeId: { in: employeeIds } },
        select: { employeeId: true, status: true },
      }),
    ]);

    const contractsByEmployee = new Map<string, Array<{ status: string }>>();
    for (const row of contractRows) {
      const bucket = contractsByEmployee.get(row.employeeId) ?? [];
      bucket.push({ status: row.status });
      contractsByEmployee.set(row.employeeId, bucket);
    }

    const coverage = resolveAttendanceCoverage({
      counts: attendanceRows.map((r) => ({ employeeId: r.employeeId })),
      employeeIds,
    });
    const structureFacts = resolveStructures(
      employeeIds,
      structures.map((s) => ({
        employeeId: s.employeeId,
        lines: s.lines.map((l) => ({
          type: l.component.type,
          amount: Number(l.amount),
        })),
      })),
    );
    const contractFacts = resolveContracts(
      employees.map((e) => ({
        id: e.id,
        contracts: contractsByEmployee.get(e.id) ?? [],
      })),
    );

    const findings = this.buildFindings({
      period,
      population,
      coverage,
      structureFacts,
      contractFacts,
      nameOf,
    });

    return {
      period,
      employees,
      employeeIds,
      structures,
      attendanceRows,
      population,
      coverage,
      structureFacts,
      contractFacts,
      findings,
      nameOf,
    };
  }

  private buildFindings(input: {
    period: PayrollPeriod;
    population: ReturnType<typeof resolvePopulation>;
    coverage: ReturnType<typeof resolveAttendanceCoverage>;
    structureFacts: ReturnType<typeof resolveStructures>;
    contractFacts: ReturnType<typeof resolveContracts>;
    nameOf: Map<string, string>;
  }): PreflightFinding[] {
    const { population, coverage, structureFacts, contractFacts, nameOf } =
      input;
    const findings: PreflightFinding[] = [];
    const label = periodLabel(input.period.periodStart);

    const per = (
      ids: string[],
      code: string,
      severity: PreflightFinding['severity'],
      message: (name: string) => string,
    ) => {
      for (const id of ids.slice(0, NAME_SAMPLE_CAP)) {
        const name = nameOf.get(id) ?? id;
        findings.push({
          code,
          severity,
          employeeId: id,
          employeeName: name,
          message: message(name),
        });
      }
      if (ids.length > NAME_SAMPLE_CAP) {
        findings.push({
          code: `${code}_MORE`,
          severity,
          message: `…and ${ids.length - NAME_SAMPLE_CAP} more.`,
        });
      }
    };

    if (population.emptyReason === 'NO_EMPLOYEES') {
      findings.push({
        code: 'NO_EMPLOYEES',
        severity: 'BLOCKER',
        message: `No employee was on the books during ${label}, so this run would produce nothing.`,
      });
    }
    if (population.emptyReason === 'ALL_UNMATCHED') {
      findings.push({
        code: 'ALL_UNMATCHED',
        severity: 'BLOCKER',
        message:
          'None of the employees you named could be found, so this run would produce nothing.',
      });
    }
    if (population.unmatchedIds.length && !population.isEmpty) {
      findings.push({
        code: 'UNMATCHED_EMPLOYEES',
        severity: 'WARNING',
        message: `${population.unmatchedIds.length} of the employees you named could not be found and will not be paid.`,
      });
    }

    // The expensive mistake: with no attendance anywhere, loss of pay is zero
    // for everybody and the run quietly pays a full month against a period that
    // was never processed.
    if (!population.isEmpty && coverage.runHasNone) {
      findings.push({
        code: 'NO_ATTENDANCE_AT_ALL',
        severity: 'BLOCKER',
        message: `No attendance was captured for anybody in ${label}. Every payslip would pay a full month against a period that was never processed.`,
      });
    } else {
      per(
        coverage.employeesWithout,
        'NO_ATTENDANCE',
        'WARNING',
        (name) =>
          `${name} has no attendance in ${label} and will be paid a full month.`,
      );
    }

    per(
      structureFacts.withoutStructure,
      'NO_STRUCTURE',
      'BLOCKER',
      (name) => `${name} has no salary structure, so there is nothing to pay.`,
    );
    per(
      structureFacts.withoutEarning,
      'NO_EARNING_LINE',
      'BLOCKER',
      (name) =>
        `${name} has a salary structure with no earning line, so there is nothing to pay.`,
    );
    per(
      contractFacts.withoutActiveContract,
      'NO_ACTIVE_CONTRACT',
      'WARNING',
      (name) => `${name} has no active contract.`,
    );

    return findings;
  }

  // ------------------------------------------------------------------ create

  async create(dto: CreatePayrollRunDto) {
    const period = periodFor(dto.month, dto.year);

    const existing = await this.prisma.payrollRun.findFirst({
      where: {
        periodStart: dayKeyToDate(period.periodStart),
        periodEnd: dayKeyToDate(period.periodEnd),
      },
    });
    // The @@unique([periodStart, periodEnd]) already prevents this; answered as
    // a sentence because the person reading it wants the existing run, not a
    // constraint name.
    if (existing) {
      throw new ConflictException(
        `A payroll run for ${periodLabel(period.periodStart)} already exists.`,
      );
    }

    const currency = await this.resolveCurrency();

    const run = await this.prisma.payrollRun.create({
      data: {
        periodStart: dayKeyToDate(period.periodStart),
        periodEnd: dayKeyToDate(period.periodEnd),
        status: PayrollRunStatus.DRAFT,
        currency,
        notes: dto.notes,
      },
    });

    return {
      success: true as const,
      data: this.decorate(run),
      message: `Payroll run created for ${periodLabel(period.periodStart)}`,
    };
  }

  /** The currency the workforce is actually contracted in. */
  private async resolveCurrency(): Promise<string> {
    const row = await this.prisma.contract.findFirst({
      where: { status: 'ACTIVE' },
      select: { currency: true },
      orderBy: { createdAt: 'desc' },
    });
    return row?.currency ?? 'OMR';
  }

  // --------------------------------------------------------------- calculate

  /**
   * Generate this run's payslips.
   *
   * Guarded by the same facts the pre-flight renders, and refused in the same
   * words. Everything happens inside ONE `$transaction`: the previous payslips
   * are deleted, the new ones are written with their lines, and the run's
   * totals are stamped. Half a recalculation is worse than none — a run showing
   * yesterday's total over today's payslips is a figure nobody can reconcile.
   */
  async calculate(id: string, employeeIds?: string[]) {
    const run = await this.prisma.payrollRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Payroll run not found');
    if (!RECALCULABLE.includes(run.status)) {
      throw new BadRequestException(
        `A ${run.status.toLowerCase()} payroll run can no longer be recalculated.`,
      );
    }

    const period: PayrollPeriod = {
      periodStart: toDayKey(run.periodStart),
      periodEnd: toDayKey(run.periodEnd),
    };
    const facts = await this.gatherFacts(period, employeeIds ?? null);

    // The pre-flight's blockers, raised in its own words.
    const blocker = facts.findings.find((f) => f.severity === 'BLOCKER');
    if (blocker) throw new BadRequestException(blocker.message);

    const payslips = await this.buildPayslips(period, facts);
    if (payslips.length === 0) {
      throw new BadRequestException(
        'This run would produce no payslip at all. Nobody in the period has a salary structure that pays anything.',
      );
    }

    const totalGross = roundMoney(payslips.reduce((a, p) => a + p.grossPay, 0));
    const totalNet = roundMoney(payslips.reduce((a, p) => a + p.netPay, 0));
    const sequenceBase = `PS-${period.periodStart.slice(0, 7)}`;

    await this.prisma.$transaction(async (tx) => {
      await tx.payslip.deleteMany({ where: { payrollRunId: id } });

      for (const [index, slip] of payslips.entries()) {
        await tx.payslip.create({
          data: {
            payrollRunId: id,
            employeeId: slip.employeeId,
            payslipNumber: `${sequenceBase}-${String(index + 1).padStart(4, '0')}`,
            workDays: slip.workDays,
            paidDays: slip.paidDays,
            lopDays: slip.lopDays,
            grossPay: slip.grossPay,
            totalDeductions: slip.totalDeductions,
            netPay: slip.netPay,
            totalEmployerCost: slip.totalEmployerCost,
            lines: {
              create: slip.lines.map((line) => ({
                componentId: line.componentId,
                code: line.code,
                label: line.label,
                type: line.type,
                amount: line.amount,
                sequence: line.sequence,
              })),
            },
          },
        });
      }

      await tx.payrollRun.update({
        where: { id },
        data: {
          status: PayrollRunStatus.CALCULATED,
          totalGross,
          totalNet,
          employeeCount: payslips.length,
          calculatedAt: new Date(),
          // A reason left over from a previous rejection, sitting next to fresh
          // figures, reads as a live objection to them.
          rejectionReason: null,
        },
      });
    });

    return this.findOne(id);
  }

  /**
   * One payslip per payable employee, computed against their branch calendar.
   *
   * The branch calendar is read through `AttendanceCalendarService` — the same
   * service attendance itself uses — because two definitions of "working day"
   * is how a payslip and an attendance report start disagreeing about the same
   * month.
   */
  private async buildPayslips(
    period: PayrollPeriod,
    facts: Awaited<ReturnType<PayrollRunsService['gatherFacts']>>,
  ) {
    const [configs, holidays] = await Promise.all([
      this.calendar.branchConfigs(),
      this.calendar.holidayIndex(period.periodStart, period.periodEnd),
    ]);
    const allDays = eachDayKey(period.periodStart, period.periodEnd);

    // One working-day set per BRANCH, not per employee: every employee of a
    // branch shares its calendar, and recomputing it per person is a month of
    // predicate calls multiplied by the headcount.
    const workingDaysByBranch = new Map<string, string[]>();
    const workingDaysFor = (branchId: string | null): string[] => {
      const key = branchId ?? '__none__';
      const cached = workingDaysByBranch.get(key);
      if (cached) return cached;
      const config = this.calendar.configFor(configs, branchId);
      const days = allDays.filter((dayKey) =>
        this.calendar.isBranchWorkingDay(config, dayKey, holidays),
      );
      workingDaysByBranch.set(key, days);
      return days;
    };

    const attendanceByEmployee = new Map<
      string,
      Array<{
        dayKey: string;
        status: (typeof facts.attendanceRows)[number]['status'];
      }>
    >();
    for (const row of facts.attendanceRows) {
      const bucket = attendanceByEmployee.get(row.employeeId) ?? [];
      bucket.push({ dayKey: toDayKey(row.date), status: row.status });
      attendanceByEmployee.set(row.employeeId, bucket);
    }

    const structureByEmployee = new Map(
      facts.structures.map((s) => [s.employeeId, s]),
    );

    const results: Array<
      ReturnType<typeof calculatePayslip> & { employeeId: string }
    > = [];

    for (const employee of facts.employees) {
      const structure = structureByEmployee.get(employee.id);
      if (!structure) continue;

      const lines: StructureLineInput[] = structure.lines.map((line) => ({
        code: line.component.code,
        label: line.component.name,
        type: line.component.type,
        amount: Number(line.amount),
        sequence: line.component.sequence,
        componentId: line.component.id,
      }));
      // Never a zero payslip: "paid nothing" and "nobody said what to pay them"
      // are different claims, and only the second one is a data problem.
      if (!isPayable(lines)) continue;

      const workingDays = workingDaysFor(employee.branchId);
      const { workDays, paidDays } = resolvePaidDays(
        workingDays,
        attendanceByEmployee.get(employee.id) ?? [],
      );

      results.push({
        employeeId: employee.id,
        ...calculatePayslip({ lines, workDays, paidDays }),
      });
    }

    return results;
  }

  // -------------------------------------------------------------- transitions

  /**
   * Approve a run.
   *
   * A conditional `updateMany` with the expected status in the `where`, not a
   * read-then-write: two approvals racing would otherwise both read CALCULATED
   * and both win, and the second would overwrite the first approver's name.
   */
  async approve(id: string, approvedById: string) {
    await this.mustExist(id);
    const changed = await this.prisma.payrollRun.updateMany({
      where: { id, status: PayrollRunStatus.CALCULATED },
      data: {
        status: PayrollRunStatus.APPROVED,
        approvedAt: new Date(),
        approvedById,
        rejectionReason: null,
      },
    });
    if (changed.count === 0) {
      throw new BadRequestException(
        'Only a calculated payroll run can be approved.',
      );
    }
    return this.answer(id, 'Payroll run approved');
  }

  async reject(id: string, reason: string) {
    await this.mustExist(id);
    const changed = await this.prisma.payrollRun.updateMany({
      where: { id, status: PayrollRunStatus.CALCULATED },
      data: {
        status: PayrollRunStatus.DRAFT,
        rejectionReason: reason,
        approvedAt: null,
        approvedById: null,
      },
    });
    if (changed.count === 0) {
      throw new BadRequestException(
        'Only a calculated payroll run can be rejected.',
      );
    }
    return this.answer(id, 'Payroll run sent back to draft');
  }

  async markPaid(id: string) {
    await this.mustExist(id);
    const changed = await this.prisma.payrollRun.updateMany({
      where: { id, status: PayrollRunStatus.APPROVED },
      data: { status: PayrollRunStatus.PAID, paidAt: new Date() },
    });
    if (changed.count === 0) {
      throw new BadRequestException(
        'Only an approved payroll run can be marked paid.',
      );
    }
    return this.answer(id, 'Payroll run marked paid');
  }

  async cancel(id: string) {
    await this.mustExist(id);
    const changed = await this.prisma.payrollRun.updateMany({
      // Anything but PAID. Money that has left the company cannot be cancelled
      // by editing a status.
      where: {
        id,
        status: { notIn: [PayrollRunStatus.PAID, PayrollRunStatus.CANCELLED] },
      },
      data: { status: PayrollRunStatus.CANCELLED },
    });
    if (changed.count === 0) {
      throw new BadRequestException(
        'A paid or already cancelled payroll run cannot be cancelled.',
      );
    }
    return this.answer(id, 'Payroll run cancelled');
  }

  async remove(id: string) {
    const run = await this.mustExist(id);
    if (run.status !== PayrollRunStatus.DRAFT) {
      throw new BadRequestException(
        'Only a draft payroll run can be deleted. Cancel it instead.',
      );
    }
    await this.prisma.payrollRun.delete({ where: { id } });
    return { success: true as const, message: 'Payroll run deleted' };
  }

  private async mustExist(id: string) {
    const run = await this.prisma.payrollRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Payroll run not found');
    return run;
  }

  private async answer(id: string, message: string) {
    const run = await this.prisma.payrollRun.findUniqueOrThrow({
      where: { id },
    });
    return { success: true as const, data: this.decorate(run), message };
  }
}
