import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LibraryType, Prisma, UserRole } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/auth.service';

/**
 * The two statutory buckets every employee starts with.
 *
 * They sit on `LeaveBalance` rather than in the library because a person always
 * has them: an organisation can rename or retire any other leave type, and the
 * annual/sick columns still have to resolve for a payslip written years ago.
 */
const DEFAULT_ANNUAL_LEAVE = 12;
const DEFAULT_SICK_LEAVE = 30;

/** Prisma's code for a unique-index violation. */
const UNIQUE_VIOLATION = 'P2002';

/** The library labels the statutory columns mirror. */
const ANNUAL_LABEL = 'Annual Leave';
const SICK_LABEL = 'Sick Leave';

/**
 * Short codes a caller may send instead of a library label, and what they
 * mean.
 *
 * A request stores the LABEL, not a code, so history survives a rename. But a
 * caller sending `ANNUAL` has to land on the same row as one sending
 * `Annual Leave`, otherwise the same leave is deducted from two buckets.
 */
const LEAVE_TYPE_ALIASES: Record<string, string> = {
  ANNUAL: ANNUAL_LABEL,
  SICK: SICK_LABEL,
  UNPAID: 'Unpaid Leave',
  MATERNITY: 'Maternity Leave',
  PATERNITY: 'Paternity Leave',
  BEREAVEMENT: 'Bereavement Leave',
};

const TYPE_BALANCE_SELECT = {
  id: true,
  employeeId: true,
  year: true,
  leaveTypeKey: true,
  allocated: true,
  used: true,
  carriedOver: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LeaveTypeBalanceSelect;

type TypeBalanceRow = Prisma.LeaveTypeBalanceGetPayload<{
  select: typeof TYPE_BALANCE_SELECT;
}>;

/** Allocation plus carry-over, less what has been taken. */
function remainingOf(row: {
  allocated: number;
  carriedOver: number;
  used: number;
}): number {
  return row.allocated + row.carriedOver - row.used;
}

function withRemaining(row: TypeBalanceRow) {
  return { ...row, remaining: remainingOf(row) };
}

@Injectable()
export class LeaveBalancesService {
  private readonly logger = new Logger(LeaveBalancesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The library entry a caller's leave type names, matched on the label and on
   * the short code that stands for it.
   */
  private leaveTypeItem(leaveType: string) {
    const alias = LEAVE_TYPE_ALIASES[leaveType.toUpperCase()];
    return this.prisma.libraryItem.findFirst({
      where: {
        libraryType: LibraryType.LEAVE_TYPE,
        isActive: true,
        OR: [
          { label: leaveType },
          { label: { equals: leaveType, mode: Prisma.QueryMode.insensitive } },
          ...(alias ? [{ label: alias }] : []),
        ],
      },
    });
  }

  /**
   * Whether `user` holds a live approval step on one of this employee's leave
   * requests.
   *
   * Written against Prisma rather than by injecting the approval engine:
   * `LeaveRequestsModule` already reaches this service, and importing the
   * engine's module back would close the cycle.
   */
  private async hasLiveApprovalStepFor(
    user: Principal,
    employeeId: string,
  ): Promise<boolean> {
    const active = await this.prisma.requestApproval.findMany({
      where: { requestType: 'LEAVE', status: 'ACTIVE' },
      select: { requestId: true, resolvedApproverId: true, approverType: true },
    });
    if (active.length === 0) return false;

    const mine = active.filter(
      (row) =>
        (row.resolvedApproverId && row.resolvedApproverId === user.id) ||
        (!row.resolvedApproverId &&
          (row.approverType as string) === (user.role as string)),
    );
    if (mine.length === 0) return false;

    const owned = await this.prisma.leaveRequest.count({
      where: { id: { in: mine.map((row) => row.requestId) }, employeeId },
    });
    return owned > 0;
  }

  /**
   * Who may read one employee's entitlement.
   *
   * The door LOOKS like a read but materialises a `LeaveBalance` plus one
   * `LeaveTypeBalance` per active type, so leaving it open would let any signed-in
   * caller both read a colleague's entitlement and create balance rows for the
   * whole company by walking ids.
   *
   * An approver with a live step is admitted even though they own none of the
   * requester's records: the balance panel is the context the leave decision is
   * made in, and a supervisor asked to approve leave with it blanked has been
   * given the decision without the facts.
   */
  private async assertCanReadBalance(user: Principal, employeeId: string) {
    if (user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER) {
      return;
    }
    if (user.employeeId === employeeId) return;

    if (user.role === UserRole.MANAGER) {
      const subject = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { departmentId: true },
      });
      if (subject?.departmentId && subject.departmentId === user.departmentId) {
        return;
      }
    }

    if (await this.hasLiveApprovalStepFor(user, employeeId)) return;

    throw new ForbiddenException(
      'This leave balance belongs to another employee',
    );
  }

  /**
   * Open a year for an employee: the statutory row plus one bucket per active
   * leave type they are eligible for.
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

    const existing = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year } },
    });
    if (existing) {
      throw new BadRequestException(`Leave balance for ${year} already exists`);
    }

    const balance = await this.prisma.leaveBalance.create({
      data: {
        employeeId,
        year,
        annualLeave: DEFAULT_ANNUAL_LEAVE,
        sickLeave: DEFAULT_SICK_LEAVE,
      },
    });

    await this.seedTypeBalances(employeeId, year, employee.gender, []);
    const leaveTypeBalances = await this.prisma.leaveTypeBalance.findMany({
      where: { employeeId, year },
      select: TYPE_BALANCE_SELECT,
    });

    return {
      ...balance,
      remainingAnnual:
        balance.annualLeave + balance.carriedOver - balance.usedAnnual,
      remainingSick: balance.sickLeave - balance.usedSick,
      leaveTypeBalances: leaveTypeBalances.map(withRemaining),
    };
  }

  /**
   * Create the type buckets an employee is missing for a year.
   *
   * A gender-restricted type is only opened for the gender it belongs to —
   * allocating maternity leave to everybody makes the company overview report a
   * liability that does not exist.
   */
  private async seedTypeBalances(
    employeeId: string,
    year: number,
    gender: string | null,
    existingKeys: string[],
  ) {
    const activeTypes = await this.prisma.libraryItem.findMany({
      where: {
        libraryType: LibraryType.LEAVE_TYPE,
        isActive: true,
        affectsBalance: true,
      },
    });
    const employeeGender = (gender || '').toUpperCase();
    const missing = activeTypes.filter((type) => {
      if (existingKeys.includes(type.label)) return false;
      if (!type.genderRestriction) return true;
      return type.genderRestriction.toUpperCase() === employeeGender;
    });
    if (missing.length === 0) return false;

    await this.prisma.leaveTypeBalance.createMany({
      data: missing.map((type) => ({
        employeeId,
        year,
        leaveTypeKey: type.label,
        allocated: type.defaultDays ?? 0,
      })),
      skipDuplicates: true,
    });
    return true;
  }

  /** One employee's balance for a year, materialising the year if it is new. */
  async getBalance(employeeId: string, year?: number, user?: Principal) {
    const targetYear = year || new Date().getUTCFullYear();

    if (user) {
      const subject = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true },
      });
      if (!subject) throw new NotFoundException('Employee not found');
      await this.assertCanReadBalance(user, employeeId);
    }

    let balance = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year: targetYear } },
      include: { employee: { select: { gender: true } } },
    });
    if (!balance) {
      await this.initBalance(employeeId, targetYear);
      balance = await this.prisma.leaveBalance.findUnique({
        where: { employeeId_year: { employeeId, year: targetYear } },
        include: { employee: { select: { gender: true } } },
      });
    }
    if (!balance) throw new NotFoundException('Leave balance not found');

    // A leave type added to the library after this year was opened has no
    // bucket yet. Filling the gap on read is what stops a newly created type
    // reading as zero entitlement for everybody already on the books.
    const existing = await this.prisma.leaveTypeBalance.findMany({
      where: { employeeId, year: targetYear },
      select: { leaveTypeKey: true },
    });
    await this.seedTypeBalances(
      employeeId,
      targetYear,
      balance.employee.gender,
      existing.map((row) => row.leaveTypeKey),
    );

    const activeTypes = await this.prisma.libraryItem.findMany({
      where: { libraryType: LibraryType.LEAVE_TYPE, isActive: true },
      select: { label: true, genderRestriction: true },
    });
    const restrictions = new Map(
      activeTypes.map((type) => [type.label, type.genderRestriction]),
    );
    const employeeGender = (balance.employee.gender || '').toUpperCase();

    const typeBalances = await this.prisma.leaveTypeBalance.findMany({
      where: { employeeId, year: targetYear },
      select: TYPE_BALANCE_SELECT,
      orderBy: { leaveTypeKey: 'asc' },
    });

    return {
      id: balance.id,
      employeeId: balance.employeeId,
      year: balance.year,
      annualLeave: balance.annualLeave,
      sickLeave: balance.sickLeave,
      usedAnnual: balance.usedAnnual,
      usedSick: balance.usedSick,
      carriedOver: balance.carriedOver,
      createdAt: balance.createdAt,
      updatedAt: balance.updatedAt,
      // Emitted so a request form can decide which types this employee is
      // eligible for by ASKING, rather than by inferring it from which buckets
      // happen to exist — an inference that stops being true the moment
      // somebody adds a bucket.
      gender: balance.employee.gender,
      remainingAnnual:
        balance.annualLeave + balance.carriedOver - balance.usedAnnual,
      remainingSick: balance.sickLeave - balance.usedSick,
      leaveTypeBalances: typeBalances
        .filter((row) => {
          const restriction = restrictions.get(row.leaveTypeKey);
          if (!restriction) return true;
          return restriction.toUpperCase() === employeeGender;
        })
        .map(withRemaining),
    };
  }

  /** Every employee's balance for a year, for the HR grid. */
  async getAllBalances(year?: number) {
    const targetYear = year || new Date().getUTCFullYear();

    const balances = await this.prisma.leaveBalance.findMany({
      where: { year: targetYear },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            gender: true,
            department: { select: { name: true } },
            leaveTypeBalances: {
              where: { year: targetYear },
              select: TYPE_BALANCE_SELECT,
              orderBy: { leaveTypeKey: 'asc' },
            },
          },
        },
      },
      orderBy: { employee: { employeeCode: 'asc' } },
    });

    const data = balances.map((balance) => ({
      id: balance.id,
      employeeId: balance.employeeId,
      year: balance.year,
      annualLeave: balance.annualLeave,
      sickLeave: balance.sickLeave,
      usedAnnual: balance.usedAnnual,
      usedSick: balance.usedSick,
      carriedOver: balance.carriedOver,
      createdAt: balance.createdAt,
      updatedAt: balance.updatedAt,
      remainingAnnual:
        balance.annualLeave + balance.carriedOver - balance.usedAnnual,
      remainingSick: balance.sickLeave - balance.usedSick,
      employee: {
        id: balance.employee.id,
        employeeCode: balance.employee.employeeCode,
        fullName: [balance.employee.firstName, balance.employee.lastName]
          .filter(Boolean)
          .join(' '),
        gender: balance.employee.gender,
        department: balance.employee.department,
      },
      leaveTypeBalances: balance.employee.leaveTypeBalances.map(withRemaining),
    }));

    return {
      success: true as const,
      data,
      meta: { year: targetYear, total: data.length },
    };
  }

  /** The statutory row for a year, opening it if the year is new. */
  private async ensureBalance(employeeId: string, year: number) {
    const existing = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year } },
    });
    if (existing) return existing;
    await this.initBalance(employeeId, year);
    const created = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year } },
    });
    if (!created) throw new NotFoundException('Leave balance not found');
    return created;
  }

  /**
   * Take days out of an employee's entitlement.
   *
   * Throws when the balance is short, which is what the caller relies on: the
   * days are not reserved when a request is raised, so two pending requests can
   * both pass the create-time check against the same allocation and only this
   * call can tell them apart.
   */
  async deductDays(
    employeeId: string,
    days: number,
    leaveType: string,
    year?: number,
  ) {
    const targetYear = year || new Date().getUTCFullYear();
    const libraryItem = await this.leaveTypeItem(leaveType);
    const leaveTypeKey = libraryItem?.label ?? leaveType;
    let balance = await this.ensureBalance(employeeId, targetYear);

    if (libraryItem) {
      // An unpaid or otherwise non-deducting type still produces a request and
      // an attendance row; it simply owes nothing to a bucket.
      if (!libraryItem.affectsBalance) return balance;

      const typeBalance =
        (await this.prisma.leaveTypeBalance.findUnique({
          where: {
            employeeId_year_leaveTypeKey: {
              employeeId,
              year: targetYear,
              leaveTypeKey,
            },
          },
        })) ??
        (await this.prisma.leaveTypeBalance.create({
          data: {
            employeeId,
            year: targetYear,
            leaveTypeKey,
            allocated: libraryItem.defaultDays ?? 0,
          },
        }));

      const remaining = remainingOf(typeBalance);
      if (remaining < days) {
        throw new BadRequestException(
          `Insufficient ${leaveTypeKey} balance. Available: ${remaining} days`,
        );
      }

      await this.prisma.leaveTypeBalance.update({
        where: { id: typeBalance.id },
        data: { used: typeBalance.used + days },
      });

      // The statutory columns mirror the two buckets that have them, so a
      // payslip reading `usedAnnual` and a screen reading the type bucket
      // cannot disagree about the same leave.
      if (leaveTypeKey === ANNUAL_LABEL) {
        balance = await this.prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { usedAnnual: balance.usedAnnual + days },
        });
      } else if (leaveTypeKey === SICK_LABEL) {
        balance = await this.prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { usedSick: balance.usedSick + days },
        });
      }
      return balance;
    }

    // No library entry: fall back to the statutory columns alone.
    const remainingAnnual =
      balance.annualLeave + balance.carriedOver - balance.usedAnnual;
    const remainingSick = balance.sickLeave - balance.usedSick;
    const code = leaveType.toUpperCase();

    if (code === 'SICK') {
      if (remainingSick < days) {
        throw new BadRequestException(
          `Insufficient sick leave balance. Available: ${remainingSick} days`,
        );
      }
      return this.prisma.leaveBalance.update({
        where: { id: balance.id },
        data: { usedSick: balance.usedSick + days },
      });
    }

    if (remainingAnnual < days) {
      throw new BadRequestException(
        `Insufficient annual leave balance. Available: ${remainingAnnual} days`,
      );
    }
    return this.prisma.leaveBalance.update({
      where: { id: balance.id },
      data: { usedAnnual: balance.usedAnnual + days },
    });
  }

  /** Put days back — a cancelled or reversed approval. Never below zero. */
  async addDays(
    employeeId: string,
    days: number,
    leaveType: string,
    year?: number,
  ) {
    const targetYear = year || new Date().getUTCFullYear();
    const libraryItem = await this.leaveTypeItem(leaveType);
    const leaveTypeKey = libraryItem?.label ?? leaveType;
    let balance = await this.ensureBalance(employeeId, targetYear);

    if (libraryItem) {
      if (!libraryItem.affectsBalance) return balance;

      const typeBalance = await this.prisma.leaveTypeBalance.findUnique({
        where: {
          employeeId_year_leaveTypeKey: {
            employeeId,
            year: targetYear,
            leaveTypeKey,
          },
        },
      });
      if (typeBalance) {
        await this.prisma.leaveTypeBalance.update({
          where: { id: typeBalance.id },
          data: { used: Math.max(0, typeBalance.used - days) },
        });
      }

      if (leaveTypeKey === ANNUAL_LABEL) {
        balance = await this.prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { usedAnnual: Math.max(0, balance.usedAnnual - days) },
        });
      } else if (leaveTypeKey === SICK_LABEL) {
        balance = await this.prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { usedSick: Math.max(0, balance.usedSick - days) },
        });
      }
      return balance;
    }

    if (leaveType.toUpperCase() === 'SICK') {
      return this.prisma.leaveBalance.update({
        where: { id: balance.id },
        data: { usedSick: Math.max(0, balance.usedSick - days) },
      });
    }
    return this.prisma.leaveBalance.update({
      where: { id: balance.id },
      data: { usedAnnual: Math.max(0, balance.usedAnnual - days) },
    });
  }

  /** Set the statutory allocations for a year, mirroring them into the buckets. */
  async updateBalance(
    employeeId: string,
    year: number,
    annualLeave?: number,
    sickLeave?: number,
  ) {
    // Without this an empty body left every field undefined, Prisma ignored
    // them all and the caller got a 200 that changed nothing — indistinguishable
    // from a successful update.
    if (annualLeave === undefined && sickLeave === undefined) {
      throw new BadRequestException(
        'Provide at least one of annualLeave or sickLeave',
      );
    }
    const subject = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!subject) throw new NotFoundException('Employee not found');

    const balance = await this.ensureBalance(employeeId, year);
    const updated = await this.prisma.leaveBalance.update({
      where: { id: balance.id },
      data: {
        ...(annualLeave !== undefined && { annualLeave }),
        ...(sickLeave !== undefined && { sickLeave }),
      },
    });

    if (annualLeave !== undefined) {
      await this.prisma.leaveTypeBalance.upsert({
        where: {
          employeeId_year_leaveTypeKey: {
            employeeId,
            year,
            leaveTypeKey: ANNUAL_LABEL,
          },
        },
        update: { allocated: annualLeave },
        create: {
          employeeId,
          year,
          leaveTypeKey: ANNUAL_LABEL,
          allocated: annualLeave,
        },
      });
    }
    if (sickLeave !== undefined) {
      await this.prisma.leaveTypeBalance.upsert({
        where: {
          employeeId_year_leaveTypeKey: {
            employeeId,
            year,
            leaveTypeKey: SICK_LABEL,
          },
        },
        update: { allocated: sickLeave },
        create: {
          employeeId,
          year,
          leaveTypeKey: SICK_LABEL,
          allocated: sickLeave,
        },
      });
    }

    return {
      ...updated,
      remainingAnnual:
        updated.annualLeave + updated.carriedOver - updated.usedAnnual,
      remainingSick: updated.sickLeave - updated.usedSick,
    };
  }

  /** Set one type's allocation, mirroring the statutory column when it has one. */
  async updateTypeBalance(
    employeeId: string,
    year: number,
    leaveTypeKey: string,
    allocated: number,
    carriedOver?: number,
  ) {
    const subject = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!subject) throw new NotFoundException('Employee not found');

    const typeBalance = await this.prisma.leaveTypeBalance.upsert({
      where: {
        employeeId_year_leaveTypeKey: { employeeId, year, leaveTypeKey },
      },
      update: {
        allocated,
        ...(carriedOver !== undefined && { carriedOver }),
      },
      create: {
        employeeId,
        year,
        leaveTypeKey,
        allocated,
        carriedOver: carriedOver ?? 0,
      },
      select: TYPE_BALANCE_SELECT,
    });

    if (leaveTypeKey === ANNUAL_LABEL) {
      await this.prisma.leaveBalance.upsert({
        where: { employeeId_year: { employeeId, year } },
        update: {
          annualLeave: allocated,
          ...(carriedOver !== undefined && { carriedOver }),
        },
        create: {
          employeeId,
          year,
          annualLeave: allocated,
          sickLeave: DEFAULT_SICK_LEAVE,
          carriedOver: carriedOver ?? 0,
        },
      });
    } else if (leaveTypeKey === SICK_LABEL) {
      await this.prisma.leaveBalance.upsert({
        where: { employeeId_year: { employeeId, year } },
        update: { sickLeave: allocated },
        create: {
          employeeId,
          year,
          annualLeave: DEFAULT_ANNUAL_LEAVE,
          sickLeave: allocated,
        },
      });
    }

    return withRemaining(typeBalance);
  }

  /** Reset every employee's allocations for a year to the library defaults. */
  async setBulkDefaultBalances(year: number) {
    if (!Number.isInteger(year)) {
      throw new BadRequestException('A valid year is required');
    }
    const employees = await this.prisma.employee.findMany({
      select: { id: true },
    });
    const activeTypes = await this.prisma.libraryItem.findMany({
      where: {
        libraryType: LibraryType.LEAVE_TYPE,
        isActive: true,
        affectsBalance: true,
      },
    });

    for (const employee of employees) {
      await this.prisma.leaveBalance.upsert({
        where: { employeeId_year: { employeeId: employee.id, year } },
        update: {},
        create: {
          employeeId: employee.id,
          year,
          annualLeave: DEFAULT_ANNUAL_LEAVE,
          sickLeave: DEFAULT_SICK_LEAVE,
        },
      });

      for (const type of activeTypes) {
        const allocated = type.defaultDays ?? 0;
        await this.prisma.leaveTypeBalance.upsert({
          where: {
            employeeId_year_leaveTypeKey: {
              employeeId: employee.id,
              year,
              leaveTypeKey: type.label,
            },
          },
          update: { allocated },
          create: {
            employeeId: employee.id,
            year,
            leaveTypeKey: type.label,
            allocated,
          },
        });

        if (type.label === ANNUAL_LABEL) {
          await this.prisma.leaveBalance.update({
            where: { employeeId_year: { employeeId: employee.id, year } },
            data: { annualLeave: type.defaultDays ?? DEFAULT_ANNUAL_LEAVE },
          });
        } else if (type.label === SICK_LABEL) {
          await this.prisma.leaveBalance.update({
            where: { employeeId_year: { employeeId: employee.id, year } },
            data: { sickLeave: type.defaultDays ?? DEFAULT_SICK_LEAVE },
          });
        }
      }
    }

    return {
      success: true as const,
      data: { year, employees: employees.length },
      message: `Balances reset to defaults for ${year}`,
    };
  }

  /** Credit days to one employee's annual allocation. */
  /**
   * Credit one period's accrual to one employee.
   *
   * The history row and the balance credit are written in the SAME transaction,
   * and the `(employeeId, periodStart, leaveTypeKey)` unique index IS the
   * idempotency guard: a period already credited raises P2002 and the whole
   * transaction rolls back, crediting nothing. Checking first and then writing
   * would still double-credit two containers that start at the same moment on
   * the first of the month — the check would pass in both before either wrote.
   *
   * Returns whether this call was the one that credited the period, so a caller
   * running over the whole workforce can report what it actually did rather
   * than how many rows it looked at.
   */
  async accrueForPeriod(input: {
    employeeId: string;
    periodStart: Date;
    leaveTypeKey: string;
    days: number;
    year: number;
    note?: string;
  }): Promise<{ credited: boolean; daysAllocated: number }> {
    if (!Number.isFinite(input.days) || input.days <= 0) {
      throw new BadRequestException('days must be a positive number');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.leaveAccrualHistory.create({
          data: {
            employeeId: input.employeeId,
            periodStart: input.periodStart,
            leaveTypeKey: input.leaveTypeKey,
            days: new Prisma.Decimal(input.days),
            year: input.year,
            note: input.note ?? null,
          },
        });

        // Allocations are whole days but an accrual rate rarely is — a 30-day
        // entitlement earns 2.5 a month. Deriving the credit from the CUMULATIVE
        // history rather than rounding each month is what stops those halves
        // being thrown away: two 2.5-day periods credit 2 then 3, and the year
        // still adds up to 30.
        const total = await tx.leaveAccrualHistory.aggregate({
          where: {
            employeeId: input.employeeId,
            year: input.year,
            leaveTypeKey: input.leaveTypeKey,
          },
          _sum: { days: true },
        });
        const accruedNow = Number(total._sum.days ?? 0);
        const daysAllocated =
          Math.floor(accruedNow) - Math.floor(accruedNow - input.days);

        if (daysAllocated > 0) {
          await tx.leaveTypeBalance.upsert({
            where: {
              employeeId_year_leaveTypeKey: {
                employeeId: input.employeeId,
                year: input.year,
                leaveTypeKey: input.leaveTypeKey,
              },
            },
            update: { allocated: { increment: daysAllocated } },
            create: {
              employeeId: input.employeeId,
              year: input.year,
              leaveTypeKey: input.leaveTypeKey,
              allocated: daysAllocated,
            },
          });

          // The statutory columns mirror the two buckets that have them, so a
          // payslip and the balances screen cannot disagree about the same days.
          if (input.leaveTypeKey === ANNUAL_LABEL) {
            await tx.leaveBalance.update({
              where: {
                employeeId_year: {
                  employeeId: input.employeeId,
                  year: input.year,
                },
              },
              data: { annualLeave: { increment: daysAllocated } },
            });
          } else if (input.leaveTypeKey === SICK_LABEL) {
            await tx.leaveBalance.update({
              where: {
                employeeId_year: {
                  employeeId: input.employeeId,
                  year: input.year,
                },
              },
              data: { sickLeave: { increment: daysAllocated } },
            });
          }
        }

        return { credited: true, daysAllocated };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        return { credited: false, daysAllocated: 0 };
      }
      throw error;
    }
  }

  /**
   * Credit the current month to every active employee.
   *
   * The monthly rate is the annual entitlement spread over twelve, so an
   * organisation that changes the library default changes the accrual with it
   * rather than having to remember a second number somewhere else.
   *
   * Only Annual Leave accrues. Sick leave and the rest are GRANTED — an
   * entitlement you have from the first day, not one you earn by the month —
   * and accruing them would report a new joiner as having no right to be ill.
   */
  async runMonthlyAccrual(): Promise<{
    periodStart: string;
    leaveTypeKey: string;
    daysPerPeriod: number;
    credited: number;
    alreadyCredited: number;
  }> {
    const periodStart = await this.currentPeriodStart();
    const year = periodStart.getUTCFullYear();

    const annual = await this.prisma.libraryItem.findFirst({
      where: {
        libraryType: LibraryType.LEAVE_TYPE,
        label: ANNUAL_LABEL,
        isActive: true,
      },
      select: { defaultDays: true },
    });
    const daysPerPeriod =
      Math.round(
        ((annual?.defaultDays ?? DEFAULT_ANNUAL_LEAVE) / 12 + Number.EPSILON) *
          100,
      ) / 100;

    const employees = await this.prisma.employee.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    let credited = 0;
    let alreadyCredited = 0;
    for (const employee of employees) {
      // The balance year has to exist before it can be credited: the accrual
      // runs unattended, and a January tick would otherwise fail for everybody
      // whose year nobody had opened yet.
      await this.ensureBalance(employee.id, year);

      const result = await this.accrueForPeriod({
        employeeId: employee.id,
        periodStart,
        leaveTypeKey: ANNUAL_LABEL,
        days: daysPerPeriod,
        year,
        note: `Monthly accrual for ${periodStart.toISOString().slice(0, 7)}`,
      });
      if (result.credited) credited += 1;
      else alreadyCredited += 1;
    }

    return {
      periodStart: periodStart.toISOString().slice(0, 10),
      leaveTypeKey: ANNUAL_LABEL,
      daysPerPeriod,
      credited,
      alreadyCredited,
    };
  }

  /**
   * The accrual tick.
   *
   * Hourly rather than once a month, and unguarded by any "have we run yet"
   * flag: the unique index already refuses a second credit for the period, so a
   * redundant tick costs one rejected insert and nothing else. A single monthly
   * fire has no such safety net — a deployment during that hour simply misses
   * the month, and nobody notices until somebody's balance is a day short.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'monthly-leave-accrual' })
  async monthlyAccrualTick() {
    if (!(await this.isFirstOfMonthInCompanyZone())) return;
    try {
      const result = await this.runMonthlyAccrual();
      if (result.credited > 0) {
        this.logger.log(
          `Accrued ${result.daysPerPeriod} ${result.leaveTypeKey} day(s) to ${result.credited} employee(s) for ${result.periodStart}`,
        );
      }
    } catch (error) {
      // An accrual that throws must not take the scheduler down with it: the
      // next tick is an hour away and will credit whatever this one missed.
      this.logger.error(
        `Monthly leave accrual failed: ${(error as Error).message}`,
      );
    }
  }

  /** The company clock, which is what decides whose first of the month it is. */
  private async companyTimezone(): Promise<string> {
    const company = await this.prisma.company.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { timezone: true },
    });
    return company?.timezone?.trim() || 'UTC';
  }

  private async isFirstOfMonthInCompanyZone(): Promise<boolean> {
    const zone = await this.companyTimezone();
    return DateTime.now().setZone(zone).day === 1;
  }

  /**
   * The first day of the current month, read in the company's clock and stored
   * at UTC midnight the way a date-only column wants it.
   *
   * Reading the month from the server's own clock would credit the wrong period
   * for several hours either side of every month boundary.
   */
  private async currentPeriodStart(): Promise<Date> {
    const zone = await this.companyTimezone();
    const now = DateTime.now().setZone(zone);
    return new Date(`${now.toFormat('yyyy-MM')}-01T00:00:00.000Z`);
  }

  /** What has been credited, newest period first. */
  async getAccrualHistory(query: {
    employeeId?: string;
    year?: number;
    month?: number;
    leaveTypeKey?: string;
  }) {
    // A month on its own cannot name a period — it needs the year beside it, so
    // asking for "March" without one is a mistake worth saying out loud rather
    // than quietly answering with three different Marches.
    if (query.month !== undefined && query.year === undefined) {
      throw new BadRequestException('A month filter also needs a year');
    }

    const rows = await this.prisma.leaveAccrualHistory.findMany({
      where: {
        ...(query.employeeId ? { employeeId: query.employeeId } : {}),
        ...(query.year ? { year: query.year } : {}),
        ...(query.leaveTypeKey ? { leaveTypeKey: query.leaveTypeKey } : {}),
        ...(query.month && query.year
          ? {
              periodStart: new Date(
                `${query.year}-${String(query.month).padStart(2, '0')}-01T00:00:00.000Z`,
              ),
            }
          : {}),
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });

    const data = rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      periodStart: row.periodStart,
      leaveTypeKey: row.leaveTypeKey,
      days: Number(row.days),
      year: row.year,
      note: row.note,
      createdAt: row.createdAt,
      employee: {
        id: row.employee.id,
        employeeCode: row.employee.employeeCode,
        fullName: [row.employee.firstName, row.employee.lastName]
          .filter(Boolean)
          .join(' '),
        department: row.employee.department,
      },
    }));

    return { success: true as const, data, meta: { total: data.length } };
  }

  /**
   * An out-of-band credit for one employee — a correction, or a grant somebody
   * negotiated.
   *
   * It merges into the current period's history row rather than opening a new
   * one, because the unique index models one credit per period per type. That
   * keeps the history a complete account of how an allocation got to where it
   * is, instead of a record of only the automatic half of it.
   */
  async accrueDays(employeeId: string, daysToAdd: number, year?: number) {
    if (!Number.isFinite(daysToAdd) || daysToAdd <= 0) {
      throw new BadRequestException('daysToAdd must be a positive number');
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, employeeCode: true, firstName: true, lastName: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const periodStart = await this.currentPeriodStart();
    const targetYear = year || periodStart.getUTCFullYear();
    const before = await this.ensureBalance(employeeId, targetYear);

    const existing = await this.prisma.leaveAccrualHistory.findUnique({
      where: {
        employeeId_periodStart_leaveTypeKey: {
          employeeId,
          periodStart,
          leaveTypeKey: ANNUAL_LABEL,
        },
      },
    });

    if (existing) {
      await this.prisma.$transaction([
        this.prisma.leaveAccrualHistory.update({
          where: { id: existing.id },
          data: { days: { increment: new Prisma.Decimal(daysToAdd) } },
        }),
        this.prisma.leaveTypeBalance.upsert({
          where: {
            employeeId_year_leaveTypeKey: {
              employeeId,
              year: targetYear,
              leaveTypeKey: ANNUAL_LABEL,
            },
          },
          update: { allocated: { increment: daysToAdd } },
          create: {
            employeeId,
            year: targetYear,
            leaveTypeKey: ANNUAL_LABEL,
            allocated: daysToAdd,
          },
        }),
        this.prisma.leaveBalance.update({
          where: { employeeId_year: { employeeId, year: targetYear } },
          data: { annualLeave: { increment: daysToAdd } },
        }),
      ]);
    } else {
      await this.accrueForPeriod({
        employeeId,
        periodStart,
        leaveTypeKey: ANNUAL_LABEL,
        days: daysToAdd,
        year: targetYear,
        note: 'Manual credit',
      });
    }

    const after = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year: targetYear } },
      select: { annualLeave: true },
    });

    return {
      employee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        fullName: [employee.firstName, employee.lastName]
          .filter(Boolean)
          .join(' '),
      },
      year: targetYear,
      balanceBefore: before.annualLeave,
      balanceAfter: after?.annualLeave ?? before.annualLeave,
      daysAdded: daysToAdd,
    };
  }

  /** Company-wide entitlement and request counts for a year. */
  async getCompanyLeaveOverview(year?: number) {
    const targetYear = year || new Date().getUTCFullYear();

    const grouped = await this.prisma.leaveTypeBalance.groupBy({
      by: ['leaveTypeKey'],
      where: { year: targetYear },
      _sum: { allocated: true, used: true, carriedOver: true },
      _count: { employeeId: true },
    });

    const startOfYear = new Date(Date.UTC(targetYear, 0, 1));
    const endOfYear = new Date(Date.UTC(targetYear, 11, 31));
    const inYear = { startDate: { gte: startOfYear, lte: endOfYear } };

    const [pending, approved, rejected, total, totalEmployees] =
      await Promise.all([
        this.prisma.leaveRequest.count({
          where: { status: 'PENDING', ...inYear },
        }),
        this.prisma.leaveRequest.count({
          where: { status: 'APPROVED', ...inYear },
        }),
        this.prisma.leaveRequest.count({
          where: { status: 'REJECTED', ...inYear },
        }),
        this.prisma.leaveRequest.count({ where: inYear }),
        this.prisma.employee.count({ where: { status: 'ACTIVE' } }),
      ]);

    return {
      year: targetYear,
      totalEmployees,
      leaveTypes: grouped.map((row) => ({
        leaveTypeKey: row.leaveTypeKey,
        totalAllocated: row._sum.allocated ?? 0,
        totalUsed: row._sum.used ?? 0,
        totalCarriedOver: row._sum.carriedOver ?? 0,
        totalRemaining:
          (row._sum.allocated ?? 0) +
          (row._sum.carriedOver ?? 0) -
          (row._sum.used ?? 0),
        employeeCount: row._count.employeeId,
      })),
      requestStats: { pending, approved, rejected, total },
    };
  }

  /** The leave types a request form may offer. */
  async getLeaveTypes() {
    return this.prisma.libraryItem.findMany({
      where: { libraryType: LibraryType.LEAVE_TYPE, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }
}
