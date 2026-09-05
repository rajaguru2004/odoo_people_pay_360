import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';
import { TimezoneService } from '../common/timezone/timezone.service';
import {
  CompanyCronGate,
  COMPANY_CRON_TICK,
} from '../common/timezone/company-cron.gate';

@Injectable()
export class LeaveBalancesService {
  private readonly DEFAULT_ANNUAL_LEAVE = 12;
  private readonly DEFAULT_SICK_LEAVE = 30;
  /** 00:00 on the 1st of the month, in the company timezone. */
  private readonly accrualGate: CompanyCronGate;

  constructor(
    private prisma: PrismaService,
    private tzSvc: TimezoneService,
  ) {
    this.accrualGate = new CompanyCronGate(this.tzSvc, '00:00', {
      dayOfMonth: 1,
    });
  }

  /** Current { year, month } in the company timezone (accrual credits the
   *  right calendar month regardless of server TZ / month-boundary hours). */
  private async companyYearMonth(): Promise<{ year: number; month: number }> {
    const companyTZ = await this.tzSvc.getCompanyTZ();
    const key = this.tzSvc.toDateKey(new Date(), companyTZ);
    return { year: key.getUTCFullYear(), month: key.getUTCMonth() + 1 };
  }

  /**
   * Cron job: fires at 00:00 on the 1st of every month IN THE COMPANY TIMEZONE
   * (the tick runs every 5 min; the gate decides). Accrues 1 leave day for all
   * ACTIVE employees.
   */
  @Cron(COMPANY_CRON_TICK, { name: 'monthly-leave-accrual' })
  async monthlyLeaveAccrualTick() {
    if (!(await this.accrualGate.due())) return;
    return this.handleMonthlyLeaveAccrual();
  }

  async handleMonthlyLeaveAccrual() {
    console.log('🔔 Cron job triggered: Monthly leave accrual');
    try {
      await this.accrueLeaveForAllEmployees();
      console.log('✅ Monthly leave accrual completed successfully');
    } catch (error) {
      console.error('❌ Monthly leave accrual failed:', error);
    }
  }

  /**
   * Whether `user` can act on a live approval step of a request belonging to
   * `employeeId`.
   *
   * Deliberately implemented against Prisma rather than by injecting
   * `ApprovalEngineService`: `ApprovalsModule` already reaches this module
   * through `LeaveRequestsModule`, and importing it back would close the cycle.
   */
  private async hasLiveApprovalStepFor(
    user: any,
    employeeId: string,
  ): Promise<boolean> {
    if (!user) return false;
    const active = await this.prisma.requestApproval.findMany({
      where: { requestType: 'LEAVE', status: 'ACTIVE' },
      select: { requestId: true, resolvedApproverId: true, approverType: true },
    });
    if (active.length === 0) return false;

    const mine = active.filter(
      (row) =>
        (row.resolvedApproverId && row.resolvedApproverId === user.id) ||
        (!row.resolvedApproverId && row.approverType === user.role),
    );
    if (mine.length === 0) return false;

    const owned = await this.prisma.leaveRequest.count({
      where: { id: { in: mine.map((r) => r.requestId) }, employeeId },
    });
    return owned > 0;
  }

  async initBalance(employeeId: string, year: number) {
    if (!Number.isInteger(year)) {
      throw new BadRequestException('A valid year is required');
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Check if balance exists
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
        annualLeave: this.DEFAULT_ANNUAL_LEAVE,
        sickLeave: this.DEFAULT_SICK_LEAVE,
        usedAnnual: 0,
        usedSick: 0,
        carriedOver: 0,
      },
    });

    // Create leave type balances for active types that affect balance
    const activeLeaveTypes = await this.prisma.libraryItem.findMany({
      where: {
        libraryType: 'LEAVE_TYPE',
        isActive: true,
        affectsBalance: true,
      },
    });

    const employeeGender = (employee.gender || '').toUpperCase();
    const eligibleLeaveTypes = activeLeaveTypes.filter((lt) => {
      if (!lt.genderRestriction) return true;
      return lt.genderRestriction.toUpperCase() === employeeGender;
    });

    const leaveTypeBalancesData = eligibleLeaveTypes.map((lt) => ({
      employeeId,
      year,
      leaveTypeKey: lt.label,
      allocated: lt.defaultDays || 0,
      used: 0,
      carriedOver: 0,
    }));

    if (leaveTypeBalancesData.length > 0) {
      await this.prisma.leaveTypeBalance.createMany({
        data: leaveTypeBalancesData,
        skipDuplicates: true,
      });
    }

    // Get the created type balances
    const leaveTypeBalances = await this.prisma.leaveTypeBalance.findMany({
      where: { employeeId, year },
    });

    return {
      success: true,
      message: 'Leave balance initialized',
      data: {
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
        remainingAnnual: balance.annualLeave + balance.carriedOver - balance.usedAnnual,
        remainingSick: balance.sickLeave - balance.usedSick,
        leaveTypeBalances: leaveTypeBalances.map((ltb) => ({
          ...ltb,
          remaining: ltb.allocated + ltb.carriedOver - ltb.used,
        })),
      },
    };
  }

  async getBalance(employeeId: string, year?: number, user?: any) {
    const targetYear = year || new Date().getFullYear();

    // This door LOOKS like a read but materialises a LeaveBalance plus one
    // LeaveTypeBalance per active type. Unguarded, any authenticated user could
    // both read a colleague's entitlement and create balance rows for the whole
    // company by walking ids.
    if (user) {
      const subject = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, departmentId: true, branchId: true },
      });
      if (!subject) {
        throw new NotFoundException('Employee not found');
      }
      // The shared guard already asserts the branch envelope for anyone but the
      // subject themselves — asserting it again HERE would 404 a user reading
      // their OWN balance while the picker points at a different branch.
      try {
        assertCanAccessEmployeeRecord(user, subject);
      } catch (err) {
        // …but an approver with a LIVE step on one of this employee's requests
        // may read the balance, because that is the context the leave detail
        // screen shows them to decide with ("requested days exceed available
        // balance"). Without it a SUPERVISOR — who owns none of the requester's
        // records — is asked to approve leave with the balance panel blanked.
        if (!(await this.hasLiveApprovalStepFor(user, employeeId))) throw err;
      }
    }

    let balance = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year: targetYear } },
      include: {
        employee: {
          include: {
            leaveTypeBalances: {
              where: { year: targetYear },
            },
          },
        },
      },
    });

    // Auto-init if not exists
    if (!balance) {
      await this.initBalance(employeeId, targetYear);
      balance = await this.prisma.leaveBalance.findUnique({
        where: { employeeId_year: { employeeId, year: targetYear } },
        include: {
          employee: {
            include: {
              leaveTypeBalances: {
                where: { year: targetYear },
              },
            },
          },
        },
      });
    }

    if (!balance) {
      throw new NotFoundException('Leave balance not found');
    }

    // Auto-init missing leave type balances if active leave types are not present
    const activeLeaveTypes = await this.prisma.libraryItem.findMany({
      where: {
        libraryType: 'LEAVE_TYPE',
        isActive: true,
        affectsBalance: true,
      },
    });

    const balanceEmployeeGender = ((balance.employee as any)?.gender || '').toUpperCase();
    const genderRestrictionMap = new Map(activeLeaveTypes.map((lt) => [lt.label, lt.genderRestriction]));

    const existingKeys = (balance.employee?.leaveTypeBalances || []).map(b => b.leaveTypeKey);
    const missingTypes = activeLeaveTypes.filter(lt => {
      if (existingKeys.includes(lt.label)) return false;
      if (!lt.genderRestriction) return true;
      return lt.genderRestriction.toUpperCase() === balanceEmployeeGender;
    });

    if (missingTypes.length > 0) {
      const leaveTypeBalancesData = missingTypes.map((lt) => ({
        employeeId,
        year: targetYear,
        leaveTypeKey: lt.label,
        allocated: lt.defaultDays || 0,
        used: 0,
        carriedOver: 0,
      }));

      await this.prisma.leaveTypeBalance.createMany({
        data: leaveTypeBalancesData,
        skipDuplicates: true,
      });

      // Refetch balance to get the new ones
      balance = await this.prisma.leaveBalance.findUnique({
        where: { employeeId_year: { employeeId, year: targetYear } },
        include: {
          employee: {
            include: {
              leaveTypeBalances: {
                where: { year: targetYear },
              },
            },
          },
        },
      });

      if (!balance) {
        throw new NotFoundException('Leave balance not found');
      }
    }

    const allLeaveTypeBalances = balance.employee?.leaveTypeBalances || [];
    // Filter out gender-restricted types that don't match employee gender
    const leaveTypeBalances = allLeaveTypeBalances.filter((ltb) => {
      const restriction = genderRestrictionMap.get(ltb.leaveTypeKey);
      if (!restriction) return true;
      return restriction.toUpperCase() === balanceEmployeeGender;
    });

    return {
      success: true,
      data: {
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
        remainingAnnual: balance.annualLeave + balance.carriedOver - balance.usedAnnual,
        remainingSick: balance.sickLeave - balance.usedSick,
        leaveTypeBalances: leaveTypeBalances.map((ltb) => ({
          id: ltb.id,
          employeeId: ltb.employeeId,
          year: ltb.year,
          leaveTypeKey: ltb.leaveTypeKey,
          allocated: ltb.allocated,
          used: ltb.used,
          carriedOver: ltb.carriedOver,
          createdAt: ltb.createdAt,
          updatedAt: ltb.updatedAt,
          remaining: ltb.allocated + ltb.carriedOver - ltb.used,
        })),
      },
    };
  }

  async getAllBalances(year?: number) {
    const targetYear = year || new Date().getFullYear();

    const balances = await this.prisma.leaveBalance.findMany({
      where: {
        year: targetYear,
        employee: { NOT: { user: { role: 'ADMIN' } } },
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            gender: true,
            department: { select: { name: true } },
            leaveTypeBalances: {
              where: { year: targetYear },
            },
          },
        },
      },
      orderBy: { employee: { employeeCode: 'asc' } },
    });

    const data = balances.map((b) => {
      const leaveTypeBalances = b.employee?.leaveTypeBalances || [];
      return {
        id: b.id,
        employeeId: b.employeeId,
        year: b.year,
        annualLeave: b.annualLeave,
        sickLeave: b.sickLeave,
        usedAnnual: b.usedAnnual,
        usedSick: b.usedSick,
        carriedOver: b.carriedOver,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        remainingAnnual: b.annualLeave + b.carriedOver - b.usedAnnual,
        remainingSick: b.sickLeave - b.usedSick,
        employee: {
          id: b.employee?.id,
          employeeCode: b.employee?.employeeCode,
          fullName: b.employee?.fullName,
          gender: (b.employee as any)?.gender ?? null,
          department: b.employee?.department,
        },
        leaveTypeBalances: leaveTypeBalances.map((ltb) => ({
          id: ltb.id,
          employeeId: ltb.employeeId,
          year: ltb.year,
          leaveTypeKey: ltb.leaveTypeKey,
          allocated: ltb.allocated,
          used: ltb.used,
          carriedOver: ltb.carriedOver,
          createdAt: ltb.createdAt,
          updatedAt: ltb.updatedAt,
          remaining: ltb.allocated + ltb.carriedOver - ltb.used,
        })),
      };
    });

    return {
      success: true,
      data,
      meta: { year: targetYear, total: balances.length },
    };
  }

  async deductDays(
    employeeId: string,
    days: number,
    leaveType: string,
    year?: number,
  ) {
    const targetYear = year || new Date().getFullYear();

    // Look up the leave type library item
    const libraryItem = await this.prisma.libraryItem.findFirst({
      where: {
        libraryType: 'LEAVE_TYPE',
        isActive: true,
        OR: [
          { label: leaveType },
          { label: { equals: leaveType, mode: 'insensitive' } },
          ...(leaveType === 'ANNUAL' ? [{ label: 'Annual Leave' }] : []),
          ...(leaveType === 'SICK' ? [{ label: 'Sick Leave' }] : []),
          ...(leaveType === 'UNPAID' ? [{ label: 'Unpaid Leave' }] : []),
          ...(leaveType === 'MATERNITY' ? [{ label: 'Maternity Leave' }] : []),
          ...(leaveType === 'PATERNITY' ? [{ label: 'Paternity Leave' }] : []),
          ...(leaveType === 'BEREAVEMENT' ? [{ label: 'Bereavement Leave' }] : []),
        ],
      },
    });

    const leaveTypeKey = libraryItem ? libraryItem.label : leaveType;

    // Get or init legacy balance
    let balance = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year: targetYear } },
    });
    if (!balance) {
      const result = await this.initBalance(employeeId, targetYear);
      balance = {
        id: result.data.id,
        employeeId: result.data.employeeId,
        year: result.data.year,
        annualLeave: result.data.annualLeave,
        sickLeave: result.data.sickLeave,
        usedAnnual: result.data.usedAnnual,
        usedSick: result.data.usedSick,
        carriedOver: result.data.carriedOver,
        createdAt: result.data.createdAt,
        updatedAt: result.data.updatedAt,
      };
    }

    if (libraryItem) {
      if (!libraryItem.affectsBalance) {
        // Doesn't affect balance, so do nothing
        return balance;
      }

      // Check and deduct from LeaveTypeBalance
      let typeBalance = await this.prisma.leaveTypeBalance.findUnique({
        where: {
          employeeId_year_leaveTypeKey: {
            employeeId,
            year: targetYear,
            leaveTypeKey,
          },
        },
      });

      if (!typeBalance) {
        typeBalance = await this.prisma.leaveTypeBalance.create({
          data: {
            employeeId,
            year: targetYear,
            leaveTypeKey,
            allocated: libraryItem.defaultDays || 0,
            used: 0,
            carriedOver: 0,
          },
        });
      }

      const remaining = typeBalance.allocated + typeBalance.carriedOver - typeBalance.used;
      if (remaining < days) {
        throw new BadRequestException(
          `Insufficient ${leaveTypeKey} balance. Available: ${remaining} days`,
        );
      }

      // Update LeaveTypeBalance
      await this.prisma.leaveTypeBalance.update({
        where: { id: typeBalance.id },
        data: { used: typeBalance.used + days },
      });

      // Synchronize to legacy columns if it matches Annual or Sick Leave
      if (leaveTypeKey === 'Annual Leave') {
        balance = await this.prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { usedAnnual: balance.usedAnnual + days },
        });
      } else if (leaveTypeKey === 'Sick Leave') {
        balance = await this.prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { usedSick: balance.usedSick + days },
        });
      }

      return balance;
    }

    // Fallback legacy behavior if libraryItem is not found
    const remainingAnnual = balance.annualLeave + balance.carriedOver - balance.usedAnnual;
    const remainingSick = balance.sickLeave - balance.usedSick;

    if (leaveType === 'ANNUAL' || leaveType === 'PERSONAL') {
      if (remainingAnnual < days) {
        throw new BadRequestException(
          `Insufficient annual leave balance. Available: ${remainingAnnual} days`,
        );
      }
      return this.prisma.leaveBalance.update({
        where: { id: balance.id },
        data: { usedAnnual: balance.usedAnnual + days },
      });
    } else if (leaveType === 'SICK') {
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
        `Insufficient leave balance. Available: ${remainingAnnual} days`,
      );
    }
    return this.prisma.leaveBalance.update({
      where: { id: balance.id },
      data: { usedAnnual: balance.usedAnnual + days },
    });
  }

  async addDays(
    employeeId: string,
    days: number,
    leaveType: string,
    year?: number,
  ) {
    const targetYear = year || new Date().getFullYear();

    const libraryItem = await this.prisma.libraryItem.findFirst({
      where: {
        libraryType: 'LEAVE_TYPE',
        isActive: true,
        OR: [
          { label: leaveType },
          { label: { equals: leaveType, mode: 'insensitive' } },
          ...(leaveType === 'ANNUAL' ? [{ label: 'Annual Leave' }] : []),
          ...(leaveType === 'SICK' ? [{ label: 'Sick Leave' }] : []),
          ...(leaveType === 'UNPAID' ? [{ label: 'Unpaid Leave' }] : []),
          ...(leaveType === 'MATERNITY' ? [{ label: 'Maternity Leave' }] : []),
          ...(leaveType === 'PATERNITY' ? [{ label: 'Paternity Leave' }] : []),
          ...(leaveType === 'BEREAVEMENT' ? [{ label: 'Bereavement Leave' }] : []),
        ],
      },
    });

    const leaveTypeKey = libraryItem ? libraryItem.label : leaveType;

    let balance = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year: targetYear } },
    });

    if (!balance) {
      const result = await this.initBalance(employeeId, targetYear);
      balance = {
        id: result.data.id,
        employeeId: result.data.employeeId,
        year: result.data.year,
        annualLeave: result.data.annualLeave,
        sickLeave: result.data.sickLeave,
        usedAnnual: result.data.usedAnnual,
        usedSick: result.data.usedSick,
        carriedOver: result.data.carriedOver,
        createdAt: result.data.createdAt,
        updatedAt: result.data.updatedAt,
      };
    }

    if (libraryItem) {
      if (!libraryItem.affectsBalance) {
        return balance;
      }

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

      if (leaveTypeKey === 'Annual Leave') {
        balance = await this.prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { usedAnnual: Math.max(0, balance.usedAnnual - days) },
        });
      } else if (leaveTypeKey === 'Sick Leave') {
        balance = await this.prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { usedSick: Math.max(0, balance.usedSick - days) },
        });
      }

      return balance;
    }

    if (leaveType === 'SICK') {
      return this.prisma.leaveBalance.update({
        where: { id: balance.id },
        data: { usedSick: Math.max(0, balance.usedSick - days) },
      });
    } else {
      return this.prisma.leaveBalance.update({
        where: { id: balance.id },
        data: { usedAnnual: Math.max(0, balance.usedAnnual - days) },
      });
    }
  }

  async updateBalance(
    employeeId: string,
    year: number,
    annualLeave: number,
    sickLeave?: number,
  ) {
    // The route has no DTO, so an empty body arrived as `undefined` for every
    // field, Prisma ignored them, and the caller got a 200 that changed
    // nothing — indistinguishable from a successful update.
    if (annualLeave === undefined && sickLeave === undefined) {
      throw new BadRequestException(
        'Provide at least one of annualLeave or sickLeave',
      );
    }
    const subject = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { branchId: true },
    });
    if (!subject) {
      throw new NotFoundException('Employee not found');
    }
    assertInBranch(subject.branchId);
    let balance = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year } },
    });

    if (!balance) {
      const result = await this.initBalance(employeeId, year);
      balance = {
        id: result.data.id,
        employeeId: result.data.employeeId,
        year: result.data.year,
        annualLeave: result.data.annualLeave,
        sickLeave: result.data.sickLeave,
        usedAnnual: result.data.usedAnnual,
        usedSick: result.data.usedSick,
        carriedOver: result.data.carriedOver,
        createdAt: result.data.createdAt,
        updatedAt: result.data.updatedAt,
      };
    }

    const updated = await this.prisma.leaveBalance.update({
      where: { id: balance.id },
      data: {
        annualLeave,
        ...(sickLeave !== undefined && { sickLeave }),
      },
    });

    // Sync to LeaveTypeBalance if exists
    await this.prisma.leaveTypeBalance.upsert({
      where: {
        employeeId_year_leaveTypeKey: {
          employeeId,
          year,
          leaveTypeKey: 'Annual Leave',
        },
      },
      update: { allocated: annualLeave },
      create: {
        employeeId,
        year,
        leaveTypeKey: 'Annual Leave',
        allocated: annualLeave,
        used: 0,
        carriedOver: 0,
      },
    });

    if (sickLeave !== undefined) {
      await this.prisma.leaveTypeBalance.upsert({
        where: {
          employeeId_year_leaveTypeKey: {
            employeeId,
            year,
            leaveTypeKey: 'Sick Leave',
          },
        },
        update: { allocated: sickLeave },
        create: {
          employeeId,
          year,
          leaveTypeKey: 'Sick Leave',
          allocated: sickLeave,
          used: 0,
          carriedOver: 0,
        },
      });
    }

    return {
      success: true,
      message: 'Leave balance updated',
      data: {
        ...updated,
        remainingAnnual:
          updated.annualLeave + updated.carriedOver - updated.usedAnnual,
        remainingSick: updated.sickLeave - updated.usedSick,
      },
    };
  }

  async updateTypeBalance(
    employeeId: string,
    year: number,
    leaveTypeKey: string,
    allocated: number,
    carriedOver?: number,
  ) {
    // Same omission as accrueLeaveForEmployee: this writes straight through raw
    // ids, so the branch envelope has to be asserted explicitly.
    const subject = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { branchId: true },
    });
    if (!subject) {
      throw new NotFoundException('Employee not found');
    }
    assertInBranch(subject.branchId);

    let typeBalance = await this.prisma.leaveTypeBalance.findUnique({
      where: {
        employeeId_year_leaveTypeKey: {
          employeeId,
          year,
          leaveTypeKey,
        },
      },
    });

    if (!typeBalance) {
      typeBalance = await this.prisma.leaveTypeBalance.create({
        data: {
          employeeId,
          year,
          leaveTypeKey,
          allocated,
          used: 0,
          carriedOver: carriedOver || 0,
        },
      });
    } else {
      typeBalance = await this.prisma.leaveTypeBalance.update({
        where: { id: typeBalance.id },
        data: {
          allocated,
          ...(carriedOver !== undefined && { carriedOver }),
        },
      });
    }

    // Sync legacy columns
    if (leaveTypeKey === 'Annual Leave') {
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
          sickLeave: 30,
          carriedOver: carriedOver || 0,
        },
      });
    } else if (leaveTypeKey === 'Sick Leave') {
      await this.prisma.leaveBalance.upsert({
        where: { employeeId_year: { employeeId, year } },
        update: {
          sickLeave: allocated,
        },
        create: {
          employeeId,
          year,
          annualLeave: 12,
          sickLeave: allocated,
        },
      });
    }

    return {
      success: true,
      data: {
        ...typeBalance,
        remaining: typeBalance.allocated + typeBalance.carriedOver - typeBalance.used,
      },
    };
  }

  async setBulkDefaultBalances(year: number) {
    if (!Number.isInteger(year)) {
      throw new BadRequestException('A valid year is required');
    }
    const employees = await this.prisma.employee.findMany({
      select: { id: true },
    });

    const activeLeaveTypes = await this.prisma.libraryItem.findMany({
      where: {
        libraryType: 'LEAVE_TYPE',
        isActive: true,
        affectsBalance: true,
      },
    });

    for (const employee of employees) {
      const legacyBalance = await this.prisma.leaveBalance.findUnique({
        where: { employeeId_year: { employeeId: employee.id, year } },
      });

      if (!legacyBalance) {
        await this.prisma.leaveBalance.create({
          data: {
            employeeId: employee.id,
            year,
            annualLeave: 12,
            sickLeave: 30,
          },
        });
      }

      for (const lt of activeLeaveTypes) {
        await this.prisma.leaveTypeBalance.upsert({
          where: {
            employeeId_year_leaveTypeKey: {
              employeeId: employee.id,
              year,
              leaveTypeKey: lt.label,
            },
          },
          update: {
            allocated: lt.defaultDays || 0,
          },
          create: {
            employeeId: employee.id,
            year,
            leaveTypeKey: lt.label,
            allocated: lt.defaultDays || 0,
            used: 0,
            carriedOver: 0,
          },
        });

        if (lt.label === 'Annual Leave') {
          await this.prisma.leaveBalance.update({
            where: { employeeId_year: { employeeId: employee.id, year } },
            data: { annualLeave: lt.defaultDays || 12 },
          });
        } else if (lt.label === 'Sick Leave') {
          await this.prisma.leaveBalance.update({
            where: { employeeId_year: { employeeId: employee.id, year } },
            data: { sickLeave: lt.defaultDays || 30 },
          });
        }
      }
    }

    return {
      success: true,
      message: `Balances reset to defaults for year ${year}`,
    };
  }

  // ==================== LEAVE ACCRUAL METHODS ====================

  /**
   * Automatic leave accrual for all ACTIVE employees
   * Every month: +1 annual leave day
   */
  async accrueLeaveForAllEmployees(triggeredBy?: string) {
    const { year, month } = await this.companyYearMonth();

    console.log(`🔄 Starting leave accrual for ${month}/${year}...`);

    // Get all active employees with their balances in one query
    const employees = await this.prisma.employee.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        leaveBalances: {
          where: { year },
          select: { id: true, annualLeave: true },
        },
      },
    });

    console.log(`📋 Found ${employees.length} active employees`);

    // Check existing accruals in batch
    const existingAccruals = await this.prisma.leaveAccrualHistory.findMany({
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        year,
        month,
        accrualType: 'AUTO',
      },
      select: { employeeId: true },
    });

    const accrualedEmployeeIds = new Set(
      existingAccruals.map((a) => a.employeeId),
    );

    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
      details: [] as any[],
    };

    // Prepare batch operations
    const balanceUpdates: any[] = [];
    const historyCreates: any[] = [];
    const balanceCreates: any[] = [];
    const daysToAdd = 1;

    for (const employee of employees) {
      try {
        // Skip if already accrued
        if (accrualedEmployeeIds.has(employee.id)) {
          console.log(`⏭️  Skipped ${employee.employeeCode} - Already accrued`);
          results.skipped++;
          continue;
        }

        const balance = employee.leaveBalances[0];

        // If no balance exists, prepare to create it
        if (!balance) {
          balanceCreates.push({
            employeeId: employee.id,
            year,
            annualLeave: 12 + daysToAdd, // Default 12 + 1 for this month
            sickLeave: 30,
            carriedOver: 0,
            usedAnnual: 0,
            usedSick: 0,
          });

          historyCreates.push({
            employeeId: employee.id,
            year,
            month,
            daysAdded: daysToAdd,
            balanceBefore: 12,
            balanceAfter: 12 + daysToAdd,
            accrualType: 'AUTO',
            triggeredBy,
            notes: `Automatic accrual for month ${month}/${year}`,
          });

          results.success++;
          results.details.push({
            employeeCode: employee.employeeCode,
            fullName: employee.fullName,
            balanceBefore: 12,
            balanceAfter: 12 + daysToAdd,
            daysAdded: daysToAdd,
          });
        } else {
          // Prepare balance update
          const balanceBefore = balance.annualLeave;
          const balanceAfter = balanceBefore + daysToAdd;

          balanceUpdates.push({
            where: { id: balance.id },
            data: { annualLeave: balanceAfter },
          });

          historyCreates.push({
            employeeId: employee.id,
            year,
            month,
            daysAdded: daysToAdd,
            balanceBefore,
            balanceAfter,
            accrualType: 'AUTO',
            triggeredBy,
            notes: `Automatic accrual for month ${month}/${year}`,
          });

          results.success++;
          results.details.push({
            employeeCode: employee.employeeCode,
            fullName: employee.fullName,
            balanceBefore,
            balanceAfter,
            daysAdded: daysToAdd,
          });
        }
      } catch (error) {
        console.error(`❌ Failed for ${employee.employeeCode}:`, error.message);
        results.failed++;
      }
    }

    // Execute all operations in a single transaction
    try {
      await this.prisma.$transaction(async (tx) => {
        // Create new balances
        if (balanceCreates.length > 0) {
          await tx.leaveBalance.createMany({
            data: balanceCreates,
            skipDuplicates: true,
          });

          const typeBalanceCreates = balanceCreates.map((bc) => ({
            employeeId: bc.employeeId,
            year: bc.year,
            leaveTypeKey: 'Annual Leave',
            allocated: bc.annualLeave,
            used: 0,
            carriedOver: 0,
          }));

          await tx.leaveTypeBalance.createMany({
            data: typeBalanceCreates,
            skipDuplicates: true,
          });
        }

        // Update existing balances in batch and sync type balance
        for (const update of balanceUpdates) {
          const lb = await tx.leaveBalance.update(update);
          await tx.leaveTypeBalance.upsert({
            where: {
              employeeId_year_leaveTypeKey: {
                employeeId: lb.employeeId,
                year: lb.year,
                leaveTypeKey: 'Annual Leave',
              },
            },
            update: {
              allocated: lb.annualLeave,
            },
            create: {
              employeeId: lb.employeeId,
              year: lb.year,
              leaveTypeKey: 'Annual Leave',
              allocated: lb.annualLeave,
              used: lb.usedAnnual,
              carriedOver: lb.carriedOver,
            },
          });
        }

        // Create all history records in batch
        if (historyCreates.length > 0) {
          await tx.leaveAccrualHistory.createMany({
            data: historyCreates,
          });
        }
      });

      console.log(`✅ Batch operations completed successfully`);
    } catch (error) {
      console.error(`❌ Transaction failed:`, error.message);
      throw error;
    }

    console.log(
      `\n✅ Accrual completed: ${results.success} success, ${results.failed} failed, ${results.skipped} skipped`,
    );

    return {
      success: true,
      message: `Leave accrual completed for ${month}/${year}`,
      data: results,
    };
  }

  /**
   * Manual leave accrual for 1 employee
   */
  async accrueLeaveForEmployee(
    employeeId: string,
    daysToAdd: number,
    triggeredBy: string,
    notes?: string,
  ) {
    const { year, month } = await this.companyYearMonth();

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        status: true,
        branchId: true,
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // `findUnique` bypasses the Prisma branch middleware, so without this a
    // branch-scoped HR could credit leave to an employee they cannot even read.
    assertInBranch(employee.branchId);

    // Get or create balance
    let balance = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_year: { employeeId, year } },
    });

    if (!balance) {
      const result = await this.initBalance(employeeId, year);
      balance = result.data;
    }

    const balanceBefore = balance.annualLeave;
    const balanceAfter = balanceBefore + daysToAdd;

    // Update balance
    await this.prisma.leaveBalance.update({
      where: { id: balance.id },
      data: { annualLeave: balanceAfter },
    });

    // Also update LeaveTypeBalance if exists
    await this.prisma.leaveTypeBalance.upsert({
      where: {
        employeeId_year_leaveTypeKey: {
          employeeId,
          year,
          leaveTypeKey: 'Annual Leave',
        },
      },
      update: {
        allocated: balanceAfter,
      },
      create: {
        employeeId,
        year,
        leaveTypeKey: 'Annual Leave',
        allocated: balanceAfter,
        used: balance.usedAnnual,
        carriedOver: balance.carriedOver,
      },
    });

    // Create history record
    await this.prisma.leaveAccrualHistory.create({
      data: {
        employeeId,
        year,
        month,
        daysAdded: daysToAdd,
        balanceBefore,
        balanceAfter,
        accrualType: 'MANUAL',
        triggeredBy,
        notes: notes || `Manual accrual by HR`,
      },
    });

    return {
      success: true,
      message: 'Leave accrued successfully',
      data: {
        employee: {
          id: employee.id,
          employeeCode: employee.employeeCode,
          fullName: employee.fullName,
        },
        balanceBefore,
        balanceAfter,
        daysToAdd,
      },
    };
  }

  /**
   * Get leave accrual history
   */
  async getAccrualHistory(employeeId?: string, year?: number, month?: number) {
    const where: any = {};

    if (employeeId) {
      where.employeeId = employeeId;
    }

    if (year) {
      where.year = year;
    }

    if (month) {
      where.month = month;
    }

    const history = await this.prisma.leaveAccrualHistory.findMany({
      where,
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'desc' }],
    });

    return {
      success: true,
      data: history,
      meta: {
        total: history.length,
        filters: { employeeId, year, month },
      },
    };
  }

  async getCompanyLeaveOverview(year?: number) {
    const targetYear = year || new Date().getFullYear();

    const grouped = await this.prisma.leaveTypeBalance.groupBy({
      by: ['leaveTypeKey'],
      where: { year: targetYear },
      _sum: { allocated: true, used: true, carriedOver: true },
      _count: { employeeId: true },
    });

    const startOfYear = new Date(Date.UTC(targetYear, 0, 1));
    const endOfYear = new Date(Date.UTC(targetYear, 11, 31));

    const [pending, approved, rejected, total, totalEmployees] = await Promise.all([
      this.prisma.leaveRequest.count({ where: { status: 'PENDING', startDate: { gte: startOfYear, lte: endOfYear } } }),
      this.prisma.leaveRequest.count({ where: { status: 'APPROVED', startDate: { gte: startOfYear, lte: endOfYear } } }),
      this.prisma.leaveRequest.count({ where: { status: 'REJECTED', startDate: { gte: startOfYear, lte: endOfYear } } }),
      this.prisma.leaveRequest.count({ where: { startDate: { gte: startOfYear, lte: endOfYear } } }),
      this.prisma.employee.count({ where: { status: 'ACTIVE', NOT: { user: { role: 'ADMIN' } } } }),
    ]);

    return {
      success: true,
      data: {
        year: targetYear,
        totalEmployees,
        leaveTypes: grouped.map((g) => ({
          leaveTypeKey: g.leaveTypeKey,
          totalAllocated: g._sum.allocated || 0,
          totalUsed: g._sum.used || 0,
          totalCarriedOver: g._sum.carriedOver || 0,
          totalRemaining: (g._sum.allocated || 0) + (g._sum.carriedOver || 0) - (g._sum.used || 0),
          employeeCount: g._count.employeeId,
        })),
        requestStats: { pending, approved, rejected, total },
      },
    };
  }

  async getLeaveTypes() {
    const leaveTypes = await this.prisma.libraryItem.findMany({
      where: {
        libraryType: 'LEAVE_TYPE',
        isActive: true,
      },
      orderBy: [
        { sortOrder: 'asc' },
        { label: 'asc' },
      ],
    });

    return {
      success: true,
      data: leaveTypes,
    };
  }
}
