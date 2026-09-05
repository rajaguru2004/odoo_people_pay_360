import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { assertBranchAssignable } from '../common/branch/branch-scope.util';
import {
  defaultWindow,
  generateYear,
  windowFor,
  type PayrollWindow,
} from './calendar-window';

@Injectable()
export class PayrollCalendarService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private features: PayrollFeaturesService,
  ) {}

  /**
   * The window a run should be described by.
   *
   * Returns the calendar-month fallback whenever the feature is off or no
   * calendar exists, so every caller can use it unconditionally and none of them
   * has to know whether the feature is on.
   */
  async windowForPeriod(
    branchId: string | null,
    month: number,
    year: number,
  ): Promise<PayrollWindow> {
    const f = await this.features.resolve();
    if (!f.calendarEnabled || !branchId) return defaultWindow(month, year);

    const period = await this.prisma.payrollCalendarPeriod.findFirst({
      where: { month, calendar: { branchId, year, isActive: true } },
    });
    return windowFor(month, year, period);
  }

  async findForBranch(branchId: string, year: number) {
    const data = await this.prisma.payrollCalendar.findUnique({
      where: { branchId_year: { branchId, year } },
      include: { periods: { orderBy: { month: 'asc' } } },
    });
    return { success: true, data };
  }

  async list(branchId?: string) {
    const data = await this.prisma.payrollCalendar.findMany({
      where: branchId ? { branchId } : {},
      include: { periods: { orderBy: { month: 'asc' } } },
      orderBy: [{ year: 'desc' }],
    });
    return { success: true, data };
  }

  /**
   * Create or replace a branch's calendar for one year.
   *
   * Whole-year at a time rather than period-by-period: a calendar with three of
   * twelve months configured is worse than none, because a run in an
   * unconfigured month silently behaves differently from its neighbours.
   */
  async upsertYear(
    dto: {
      branchId: string;
      year: number;
      cutOffDay?: number;
      paymentDay?: number;
      periodStartDay?: number;
      enforceCutOff?: boolean;
      periods?: Array<Record<string, unknown>>;
      name?: string;
    },
    user: any,
  ) {
    const { branchId, year } = dto;
    if (!branchId) throw new BadRequestException('branchId is required');
    assertBranchAssignable(branchId);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year must be between 2000 and 2100');
    }

    const periods =
      dto.periods && dto.periods.length > 0
        ? dto.periods.map((p) => ({
            month: Number(p.month),
            periodStart: new Date(String(p.periodStart)),
            periodEnd: new Date(String(p.periodEnd)),
            cutOffDate: new Date(String(p.cutOffDate)),
            paymentDate: new Date(String(p.paymentDate)),
            enforceCutOff: Boolean(p.enforceCutOff ?? dto.enforceCutOff ?? false),
          }))
        : generateYear(year, {
            periodStartDay: dto.periodStartDay,
            cutOffDay: dto.cutOffDay ?? 25,
            paymentDay: dto.paymentDay ?? 28,
            enforceCutOff: dto.enforceCutOff,
          });

    const calendar = await this.prisma.$transaction(async (tx) => {
      const cal = await tx.payrollCalendar.upsert({
        where: { branchId_year: { branchId, year } },
        create: { branchId, year, name: dto.name ?? null },
        update: { name: dto.name ?? null, isActive: true },
      });
      // Replace wholesale rather than merge: a partially-updated calendar is the
      // failure this method exists to prevent.
      await tx.payrollCalendarPeriod.deleteMany({ where: { calendarId: cal.id } });
      await tx.payrollCalendarPeriod.createMany({
        data: periods.map((p) => ({ ...p, calendarId: cal.id })),
      });
      return tx.payrollCalendar.findUnique({
        where: { id: cal.id },
        include: { periods: { orderBy: { month: 'asc' } } },
      });
    });

    await this.audit.log({
      userId: user?.id,
      action: 'PAYROLL_CALENDAR_SAVED',
      resourceType: 'PayrollCalendar',
      resourceId: calendar!.id,
      branchId,
      newData: { year, periods: periods.length },
    });
    return { success: true, data: calendar };
  }

  async setEnforcement(
    calendarId: string,
    month: number,
    enforceCutOff: boolean,
    user: any,
  ) {
    const period = await this.prisma.payrollCalendarPeriod.findFirst({
      where: { calendarId, month },
      include: { calendar: true },
    });
    if (!period) throw new NotFoundException('Calendar period not found');
    assertBranchAssignable(period.calendar.branchId);

    const data = await this.prisma.payrollCalendarPeriod.update({
      where: { id: period.id },
      data: { enforceCutOff },
    });
    await this.audit.log({
      userId: user?.id,
      action: 'PAYROLL_CUTOFF_ENFORCEMENT_CHANGED',
      resourceType: 'PayrollCalendar',
      resourceId: calendarId,
      branchId: period.calendar.branchId,
      oldData: { month, enforceCutOff: period.enforceCutOff },
      newData: { month, enforceCutOff },
    });
    return { success: true, data };
  }

  async remove(id: string, user: any) {
    const calendar = await this.prisma.payrollCalendar.findUnique({ where: { id } });
    if (!calendar) throw new NotFoundException('Calendar not found');
    assertBranchAssignable(calendar.branchId);
    await this.prisma.payrollCalendar.delete({ where: { id } });
    await this.audit.log({
      userId: user?.id,
      action: 'PAYROLL_CALENDAR_DELETED',
      resourceType: 'PayrollCalendar',
      resourceId: id,
      branchId: calendar.branchId,
      oldData: { year: calendar.year },
    });
    return { success: true };
  }
}
