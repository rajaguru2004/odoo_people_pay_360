import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LibraryType, Prisma, UserRole } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import {
  assertCanAccessRequestOf,
  managerDepartmentIds,
} from '../common/utils/manager-scope.util';
import type { Principal } from '../auth/auth.service';

/** What an employee-year is worth once the three columns are added up. */
export interface TypeBalanceView {
  id: string;
  employeeId: string;
  year: number;
  leaveTypeKey: string;
  allocated: number;
  used: number;
  carriedOver: number;
  /** Derived, never stored — a fourth number could disagree with the other three. */
  remaining: number;
}

const ANNUAL = 'Annual Leave';
const SICK = 'Sick Leave';

/** One day a month, which is the accrual every contract in the region assumes. */
const MONTHLY_ACCRUAL_DAYS = 1;

/**
 * Entitlements: what somebody is owed, what they have spent, and what is left.
 *
 * Two tables, on purpose. `LeaveBalance` carries the headline annual and sick
 * figures every payslip and settlement asks for by name; `LeaveTypeBalance`
 * carries one row per KIND of leave and is what the balances screen and the
 * approval check actually read. Writes keep the two in step, and the direction
 * is always per-type first: the per-type row is the authority, the headline row
 * is the summary.
 */
@Injectable()
export class LeaveBalancesService {
  private readonly logger = new Logger(LeaveBalancesService.name);

  /** The last company-month the accrual actually ran for, per process. */
  private lastAccrualKey: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  // ── The monthly accrual ────────────────────────────────────────────────────

  /**
   * Credit one day of annual leave, on the 1st of the month in the COMPANY's
   * timezone.
   *
   * The tick is hourly and the gate decides, rather than a cron expression
   * firing at midnight server time: a company in Muscat on a UTC server would
   * otherwise be credited four hours into the previous month, and the accrual
   * would land in the wrong year every January.
   *
   * Idempotence is in the database, not in this flag: `LeaveAccrualHistory`
   * (employee, year, month, 'AUTO') is checked before anything is added, so a
   * restart on the 1st cannot credit the month twice however many times this
   * fires. The in-memory key only saves the query.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'monthly-leave-accrual' })
  async monthlyAccrualTick(): Promise<void> {
    const { year, month, day } = await this.companyNow();
    if (day !== 1) return;

    const key = `${year}-${month}`;
    if (this.lastAccrualKey === key) return;
    this.lastAccrualKey = key;

    try {
      const result = await this.accrueLeaveForAllEmployees();
      this.logger.log(
        `Monthly leave accrual for ${month}/${year}: ${result.data.credited} credited, ${result.data.skipped} already done.`,
      );
    } catch (e) {
      // Cleared so the next tick retries rather than the company silently
      // missing a month because one run failed.
      this.lastAccrualKey = null;
      this.logger.error(
        `Monthly leave accrual failed: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  /** Today, as the company's own clock sees it. */
  private async companyNow(): Promise<{
    year: number;
    month: number;
    day: number;
  }> {
    const company = await this.prisma.company.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { timezone: true },
    });
    const zone =
      company?.timezone?.trim() ||
      (await this.settings.get('default_timezone')) ||
      'UTC';
    const now = DateTime.now().setZone(zone);
    const valid = now.isValid ? now : DateTime.utc();
    return { year: valid.year, month: valid.month, day: valid.day };
  }

  /** The current year in the company's clock — what an unqualified "year" means. */
  private async companyYear(): Promise<number> {
    return (await this.companyNow()).year;
  }

  // ── Materialising a year ───────────────────────────────────────────────────

  /**
   * Create the balance rows for one employee-year.
   *
   * Gender-restricted types are filtered out at creation rather than allocated
   * and hidden: a male employee with a maternity row has 98 days of something in
   * the company totals that nobody can ever take.
   */
  async initBalance(employeeId: string, year: number) {
    if (!Number.isInteger(year)) {
      throw new BadRequestException('A valid year is required');
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, gender: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const types = await this.balanceAffectingTypes();
    const eligible = types.filter((t) =>
      eligibleForGender(t.genderRestriction, employee.gender),
    );

    const annual = types.find((t) => t.label === ANNUAL);
    const sick = types.find((t) => t.label === SICK);

    await this.prisma.$transaction(async (tx) => {
      await tx.leaveBalance.upsert({
        where: { employeeId_year: { employeeId, year } },
        update: {},
        create: {
          employeeId,
          year,
          annualLeave: annual?.defaultDays ?? 30,
          sickLeave: sick?.defaultDays ?? 30,
        },
      });
      if (eligible.length) {
        await tx.leaveTypeBalance.createMany({
          data: eligible.map((t) => ({
            employeeId,
            year,
            leaveTypeKey: t.label,
            allocated: t.defaultDays ?? 0,
          })),
          skipDuplicates: true,
        });
      }
    });

    return this.readBalance(employeeId, year);
  }

  /**
   * One employee's balance for a year, creating it if it does not exist.
   *
   * This door LOOKS like a read and is not: it materialises a `LeaveBalance` plus
   * one `LeaveTypeBalance` per active type. Unguarded, any authenticated caller
   * could both read a colleague's entitlement and create rows for the whole
   * company by walking employee ids — which is why the access check is here and
   * not only on the routes that obviously write.
   */
  async getBalance(
    employeeId: string,
    year: number | undefined,
    user: Principal,
  ) {
    const targetYear = year ?? (await this.companyYear());

    const subject = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true, supervisorId: true },
    });
    if (!subject) throw new NotFoundException('Employee not found');

    if (user.role !== UserRole.ADMIN && user.role !== UserRole.HR_MANAGER) {
      const scope = await managerDepartmentIds(this.prisma, user);
      assertCanAccessRequestOf(user, subject, scope, 'view the balance for');
    }

    const existing = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year: targetYear } },
      select: { id: true },
    });
    if (!existing) return this.initBalance(employeeId, targetYear);

    // A type added to the library mid-year has no row yet. Backfilling it here
    // is what stops "Study Leave" existing in the picker and nowhere in the
    // balance the picker is checked against.
    await this.backfillMissingTypes(employeeId, targetYear);
    return this.readBalance(employeeId, targetYear);
  }

  /** Every employee's balance for a year — the HR balances screen. */
  async getAllBalances(year: number | undefined) {
    const targetYear = year ?? (await this.companyYear());

    const employees = await this.prisma.employee.findMany({
      where: { status: { not: 'TERMINATED' } },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        gender: true,
        department: { select: { id: true, name: true } },
        leaveBalances: { where: { year: targetYear } },
        leaveTypeBalances: { where: { year: targetYear } },
      },
      orderBy: { employeeCode: 'asc' },
    });

    const data = employees.map((emp) => {
      const headline = emp.leaveBalances[0] ?? null;
      const types = emp.leaveTypeBalances.map(toTypeView);
      return {
        employee: {
          id: emp.id,
          employeeCode: emp.employeeCode,
          firstName: emp.firstName,
          lastName: emp.lastName,
          avatarUrl: emp.avatarUrl,
          department: emp.department,
        },
        year: targetYear,
        // Null rather than zeroes when the year was never initialised. "Not set
        // up yet" and "entitled to nothing" are different facts, and a screen
        // printing 0 for both has told the reader something false about one.
        headline: headline
          ? {
              annualLeave: headline.annualLeave,
              usedAnnual: headline.usedAnnual,
              sickLeave: headline.sickLeave,
              usedSick: headline.usedSick,
              carriedOver: headline.carriedOver,
              remainingAnnual:
                headline.annualLeave +
                headline.carriedOver -
                headline.usedAnnual,
              remainingSick: headline.sickLeave - headline.usedSick,
            }
          : null,
        leaveTypeBalances: types,
        totals: {
          allocated: types.reduce((a, t) => a + t.allocated, 0),
          used: types.reduce((a, t) => a + t.used, 0),
          carriedOver: types.reduce((a, t) => a + t.carriedOver, 0),
          remaining: types.reduce((a, t) => a + t.remaining, 0),
        },
      };
    });

    return {
      success: true as const,
      data,
      meta: { year: targetYear, total: data.length },
    };
  }

  // ── Spending and refunding ─────────────────────────────────────────────────

  /**
   * Spend days against a type.
   *
   * Throws when the balance is short — and the caller relies on that: leave
   * approval deducts BEFORE it writes APPROVED, precisely so a short balance
   * fails the whole approval instead of leaving an approved absence nobody paid
   * for. See the note in `LeaveRequestsService.approve`.
   *
   * A type that does not affect balances is a no-op rather than an error: unpaid
   * leave is still approved, still writes attendance, and costs no entitlement.
   */
  async deductDays(
    employeeId: string,
    days: number,
    leaveTypeKey: string,
    year: number,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const type = await tx.libraryItem.findFirst({
      where: { libraryType: LibraryType.LEAVE_TYPE, label: leaveTypeKey },
    });
    if (type && !type.affectsBalance) return;

    const typeBalance = await tx.leaveTypeBalance.upsert({
      where: {
        employeeId_year_leaveTypeKey: { employeeId, year, leaveTypeKey },
      },
      update: {},
      create: {
        employeeId,
        year,
        leaveTypeKey,
        allocated: type?.defaultDays ?? 0,
      },
    });

    const remaining =
      typeBalance.allocated + typeBalance.carriedOver - typeBalance.used;
    if (remaining < days) {
      throw new BadRequestException(
        `Insufficient ${leaveTypeKey} balance. Available: ${remaining} day(s), requested: ${days}.`,
      );
    }

    await tx.leaveTypeBalance.update({
      where: { id: typeBalance.id },
      data: { used: typeBalance.used + days },
    });
    await this.syncHeadline(tx, employeeId, year, leaveTypeKey, days);
  }

  /**
   * Give days back — a cancelled or reversed leave.
   *
   * `used` is floored at zero rather than allowed to go negative: a negative
   * `used` silently inflates the remaining balance, and the inflation survives
   * into next year's carry-forward.
   */
  async addDays(
    employeeId: string,
    days: number,
    leaveTypeKey: string,
    year: number,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const typeBalance = await tx.leaveTypeBalance.findUnique({
      where: {
        employeeId_year_leaveTypeKey: { employeeId, year, leaveTypeKey },
      },
    });
    if (!typeBalance) return;

    await tx.leaveTypeBalance.update({
      where: { id: typeBalance.id },
      data: { used: Math.max(0, typeBalance.used - days) },
    });
    await this.syncHeadline(tx, employeeId, year, leaveTypeKey, -days);
  }

  // ── Administration ─────────────────────────────────────────────────────────

  async updateBalance(
    employeeId: string,
    year: number,
    annualLeave?: number,
    sickLeave?: number,
  ) {
    if (annualLeave === undefined && sickLeave === undefined) {
      throw new BadRequestException(
        'Provide at least one of annualLeave or sickLeave',
      );
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.leaveBalance.upsert({
        where: { employeeId_year: { employeeId, year } },
        update: {
          ...(annualLeave !== undefined ? { annualLeave } : {}),
          ...(sickLeave !== undefined ? { sickLeave } : {}),
        },
        create: {
          employeeId,
          year,
          annualLeave: annualLeave ?? 30,
          sickLeave: sickLeave ?? 30,
        },
      });
      if (annualLeave !== undefined) {
        await upsertAllocation(tx, employeeId, year, ANNUAL, annualLeave);
      }
      if (sickLeave !== undefined) {
        await upsertAllocation(tx, employeeId, year, SICK, sickLeave);
      }
    });

    return this.readBalance(employeeId, year);
  }

  async updateTypeBalance(
    employeeId: string,
    year: number,
    leaveTypeKey: string,
    allocated: number,
    carriedOver?: number,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.leaveTypeBalance.upsert({
        where: {
          employeeId_year_leaveTypeKey: { employeeId, year, leaveTypeKey },
        },
        update: {
          allocated,
          ...(carriedOver !== undefined ? { carriedOver } : {}),
        },
        create: {
          employeeId,
          year,
          leaveTypeKey,
          allocated,
          carriedOver: carriedOver ?? 0,
        },
      });

      // The headline row mirrors the two named types, so the payslip figure and
      // the balances screen cannot disagree about the same entitlement.
      if (leaveTypeKey === ANNUAL) {
        await tx.leaveBalance.upsert({
          where: { employeeId_year: { employeeId, year } },
          update: {
            annualLeave: allocated,
            ...(carriedOver !== undefined ? { carriedOver } : {}),
          },
          create: {
            employeeId,
            year,
            annualLeave: allocated,
            sickLeave: 30,
            carriedOver: carriedOver ?? 0,
          },
        });
      } else if (leaveTypeKey === SICK) {
        await tx.leaveBalance.upsert({
          where: { employeeId_year: { employeeId, year } },
          update: { sickLeave: allocated },
          create: {
            employeeId,
            year,
            annualLeave: 30,
            sickLeave: allocated,
          },
        });
      }
    });

    return this.readBalance(employeeId, year);
  }

  /**
   * Reset every employee's allocations to the library defaults for a year.
   *
   * `used` is deliberately untouched: this changes what people are entitled to,
   * not what they have already taken. Zeroing it would hand back leave that has
   * already been spent and already appears as attendance.
   */
  async setBulkDefaultBalances(year: number) {
    if (!Number.isInteger(year)) {
      throw new BadRequestException('A valid year is required');
    }
    const [employees, types] = await Promise.all([
      this.prisma.employee.findMany({
        where: { status: { not: 'TERMINATED' } },
        select: { id: true, gender: true },
      }),
      this.balanceAffectingTypes(),
    ]);

    let touched = 0;
    for (const employee of employees) {
      const eligible = types.filter((t) =>
        eligibleForGender(t.genderRestriction, employee.gender),
      );
      const annual = eligible.find((t) => t.label === ANNUAL);
      const sick = eligible.find((t) => t.label === SICK);

      await this.prisma.$transaction(async (tx) => {
        await tx.leaveBalance.upsert({
          where: { employeeId_year: { employeeId: employee.id, year } },
          update: {
            annualLeave: annual?.defaultDays ?? 30,
            sickLeave: sick?.defaultDays ?? 30,
          },
          create: {
            employeeId: employee.id,
            year,
            annualLeave: annual?.defaultDays ?? 30,
            sickLeave: sick?.defaultDays ?? 30,
          },
        });
        for (const type of eligible) {
          await upsertAllocation(
            tx,
            employee.id,
            year,
            type.label,
            type.defaultDays ?? 0,
          );
        }
      });
      touched += 1;
    }

    return {
      success: true as const,
      message: `Allocations reset to the library defaults for ${touched} employee(s) in ${year}`,
    };
  }

  /**
   * Credit one day of annual leave to every active employee.
   *
   * The month is the company's, not the server's, and the `LeaveAccrualHistory`
   * row is what makes a re-run a no-op rather than a second credit.
   */
  async accrueLeaveForAllEmployees(triggeredBy?: string) {
    const { year, month } = await this.companyNow();

    const employees = await this.prisma.employee.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, employeeCode: true },
    });

    const already = await this.prisma.leaveAccrualHistory.findMany({
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        year,
        month,
        accrualType: 'AUTO',
      },
      select: { employeeId: true },
    });
    const done = new Set(already.map((a) => a.employeeId));

    let credited = 0;
    let skipped = 0;

    for (const employee of employees) {
      if (done.has(employee.id)) {
        skipped += 1;
        continue;
      }
      await this.creditOne(
        employee.id,
        MONTHLY_ACCRUAL_DAYS,
        year,
        month,
        'AUTO',
        triggeredBy,
        `Automatic accrual for ${month}/${year}`,
      );
      credited += 1;
    }

    return {
      success: true as const,
      message: `Leave accrual completed for ${month}/${year}`,
      data: { year, month, credited, skipped, total: employees.length },
    };
  }

  /** Credit days to one employee by hand — a long-service award, a correction. */
  async accrueLeaveForEmployee(
    employeeId: string,
    daysToAdd: number,
    triggeredBy: string,
    notes?: string,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, employeeCode: true, firstName: true, lastName: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const { year, month } = await this.companyNow();
    const record = await this.creditOne(
      employeeId,
      daysToAdd,
      year,
      month,
      'MANUAL',
      triggeredBy,
      notes || 'Manual accrual by HR',
    );

    return {
      success: true as const,
      message: `${daysToAdd} day(s) credited`,
      data: { employee, ...record },
    };
  }

  async getAccrualHistory(employeeId?: string, year?: number, month?: number) {
    const data = await this.prisma.leaveAccrualHistory.findMany({
      where: {
        ...(employeeId ? { employeeId } : {}),
        ...(year ? { year } : {}),
        ...(month ? { month } : {}),
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });

    return {
      success: true as const,
      data,
      meta: { total: data.length, filters: { employeeId, year, month } },
    };
  }

  /** Company-wide entitlement, one row per leave type. */
  async getCompanyLeaveOverview(year: number | undefined) {
    const targetYear = year ?? (await this.companyYear());

    const [grouped, headcount] = await Promise.all([
      this.prisma.leaveTypeBalance.groupBy({
        by: ['leaveTypeKey'],
        where: { year: targetYear },
        _sum: { allocated: true, used: true, carriedOver: true },
        _count: { employeeId: true },
      }),
      this.prisma.employee.count({ where: { status: 'ACTIVE' } }),
    ]);

    const leaveTypes = grouped
      .map((g) => {
        const allocated = g._sum.allocated ?? 0;
        const used = g._sum.used ?? 0;
        const carriedOver = g._sum.carriedOver ?? 0;
        return {
          leaveTypeKey: g.leaveTypeKey,
          totalAllocated: allocated,
          totalUsed: used,
          totalCarriedOver: carriedOver,
          totalRemaining: allocated + carriedOver - used,
          // Null, never 0%, when there was nothing to divide by: an empty type
          // and a wholly unused one are different claims.
          utilisation:
            allocated + carriedOver > 0
              ? Math.round((used / (allocated + carriedOver)) * 1000) / 10
              : null,
          employeeCount: g._count.employeeId,
        };
      })
      .sort((a, b) => b.totalAllocated - a.totalAllocated);

    return {
      success: true as const,
      data: { year: targetYear, activeHeadcount: headcount, leaveTypes },
    };
  }

  /** The leave types an employee may pick from, with their rules attached. */
  async getLeaveTypes() {
    const data = await this.prisma.libraryItem.findMany({
      where: { libraryType: LibraryType.LEAVE_TYPE, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
    return { success: true as const, data };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async balanceAffectingTypes() {
    return this.prisma.libraryItem.findMany({
      where: {
        libraryType: LibraryType.LEAVE_TYPE,
        isActive: true,
        affectsBalance: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  private async backfillMissingTypes(employeeId: string, year: number) {
    const [employee, types, existing] = await Promise.all([
      this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { gender: true },
      }),
      this.balanceAffectingTypes(),
      this.prisma.leaveTypeBalance.findMany({
        where: { employeeId, year },
        select: { leaveTypeKey: true },
      }),
    ]);

    const have = new Set(existing.map((row) => row.leaveTypeKey));
    const missing = types.filter(
      (t) =>
        !have.has(t.label) &&
        eligibleForGender(t.genderRestriction, employee?.gender ?? null),
    );
    if (!missing.length) return;

    await this.prisma.leaveTypeBalance.createMany({
      data: missing.map((t) => ({
        employeeId,
        year,
        leaveTypeKey: t.label,
        allocated: t.defaultDays ?? 0,
      })),
      skipDuplicates: true,
    });
  }

  private async readBalance(employeeId: string, year: number) {
    const [headline, types] = await Promise.all([
      this.prisma.leaveBalance.findUnique({
        where: { employeeId_year: { employeeId, year } },
      }),
      this.prisma.leaveTypeBalance.findMany({
        where: { employeeId, year },
        orderBy: { leaveTypeKey: 'asc' },
      }),
    ]);
    if (!headline) throw new NotFoundException('Leave balance not found');

    const leaveTypeBalances = types.map(toTypeView);

    return {
      success: true as const,
      data: {
        id: headline.id,
        employeeId,
        year,
        annualLeave: headline.annualLeave,
        sickLeave: headline.sickLeave,
        usedAnnual: headline.usedAnnual,
        usedSick: headline.usedSick,
        carriedOver: headline.carriedOver,
        remainingAnnual:
          headline.annualLeave + headline.carriedOver - headline.usedAnnual,
        remainingSick: headline.sickLeave - headline.usedSick,
        leaveTypeBalances,
        totals: {
          allocated: leaveTypeBalances.reduce((a, t) => a + t.allocated, 0),
          used: leaveTypeBalances.reduce((a, t) => a + t.used, 0),
          carriedOver: leaveTypeBalances.reduce((a, t) => a + t.carriedOver, 0),
          remaining: leaveTypeBalances.reduce((a, t) => a + t.remaining, 0),
        },
        createdAt: headline.createdAt,
        updatedAt: headline.updatedAt,
      },
    };
  }

  /** Keep the two named headline columns in step with their per-type rows. */
  private async syncHeadline(
    tx: Prisma.TransactionClient,
    employeeId: string,
    year: number,
    leaveTypeKey: string,
    delta: number,
  ) {
    if (leaveTypeKey !== ANNUAL && leaveTypeKey !== SICK) return;
    const headline = await tx.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year } },
    });
    if (!headline) return;

    // Written as two explicit branches rather than a computed key: Prisma's
    // update payload is a typed union, and a dynamic key widens it to `any`,
    // which is how a typo in a column name reaches the database.
    if (leaveTypeKey === ANNUAL) {
      await tx.leaveBalance.update({
        where: { id: headline.id },
        data: { usedAnnual: Math.max(0, headline.usedAnnual + delta) },
      });
    } else {
      await tx.leaveBalance.update({
        where: { id: headline.id },
        data: { usedSick: Math.max(0, headline.usedSick + delta) },
      });
    }
  }

  /**
   * One credit, plus the history row that makes it idempotent.
   *
   * Both in one transaction: a credit with no history row would be applied again
   * on the next tick, and a history row with no credit would block the month for
   * ever.
   */
  private async creditOne(
    employeeId: string,
    days: number,
    year: number,
    month: number,
    accrualType: 'AUTO' | 'MANUAL',
    triggeredBy: string | undefined,
    notes: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.leaveBalance.findUnique({
        where: { employeeId_year: { employeeId, year } },
      });

      const balanceBefore = existing?.annualLeave ?? 0;
      const balanceAfter = balanceBefore + days;

      await tx.leaveBalance.upsert({
        where: { employeeId_year: { employeeId, year } },
        update: { annualLeave: balanceAfter },
        create: {
          employeeId,
          year,
          annualLeave: balanceAfter,
          sickLeave: 30,
        },
      });
      await upsertAllocation(tx, employeeId, year, ANNUAL, balanceAfter);

      await tx.leaveAccrualHistory.create({
        data: {
          employeeId,
          year,
          month,
          daysAdded: days,
          balanceBefore,
          balanceAfter,
          accrualType,
          triggeredBy: triggeredBy ?? null,
          notes,
        },
      });

      return { year, month, daysAdded: days, balanceBefore, balanceAfter };
    });
  }
}

function toTypeView(row: {
  id: string;
  employeeId: string;
  year: number;
  leaveTypeKey: string;
  allocated: number;
  used: number;
  carriedOver: number;
}): TypeBalanceView {
  return {
    id: row.id,
    employeeId: row.employeeId,
    year: row.year,
    leaveTypeKey: row.leaveTypeKey,
    allocated: row.allocated,
    used: row.used,
    carriedOver: row.carriedOver,
    remaining: row.allocated + row.carriedOver - row.used,
  };
}

/**
 * Set an allocation without touching what has been spent.
 *
 * `used` is absent from the update on purpose — changing an entitlement is not
 * the same act as handing back leave already taken.
 */
async function upsertAllocation(
  tx: Prisma.TransactionClient,
  employeeId: string,
  year: number,
  leaveTypeKey: string,
  allocated: number,
) {
  await tx.leaveTypeBalance.upsert({
    where: {
      employeeId_year_leaveTypeKey: { employeeId, year, leaveTypeKey },
    },
    update: { allocated },
    create: { employeeId, year, leaveTypeKey, allocated },
  });
}

/**
 * Does a gender-restricted type apply to this employee?
 *
 * An employee who has not stated a gender keeps every UNRESTRICTED type and gets
 * none of the restricted ones — the alternative is guessing, and the guess would
 * show up as an entitlement they cannot take or one they are owed and were never
 * given.
 */
function eligibleForGender(
  restriction: string | null,
  gender: string | null | undefined,
): boolean {
  if (!restriction) return true;
  return (gender ?? '').trim().toUpperCase() === restriction.toUpperCase();
}
