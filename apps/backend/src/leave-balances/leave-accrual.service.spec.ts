import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LeaveBalancesService } from './leave-balances.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A transaction mock that runs the callback against the same delegates the
 * service would otherwise use, so an assertion about what was written inside
 * the transaction is an assertion about the real call.
 */
const prismaMock = () => {
  const tx = {
    leaveAccrualHistory: {
      create: jest.fn(),
      update: jest.fn(),
      aggregate: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    leaveTypeBalance: { upsert: jest.fn() },
    leaveBalance: { update: jest.fn(), findUnique: jest.fn() },
  };
  return {
    ...tx,
    company: { findFirst: jest.fn() },
    libraryItem: { findFirst: jest.fn(), findMany: jest.fn() },
    employee: { findMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (t: unknown) => Promise<unknown>)(tx)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
};

type PrismaMock = ReturnType<typeof prismaMock>;

/** The rejection Postgres raises through Prisma when a unique index refuses a row. */
function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
  });
}

function argOf<T>(mock: jest.Mock, call = 0): T {
  return (mock.mock.calls as T[][])[call][0];
}

const MARCH = new Date('2026-03-01T00:00:00.000Z');

describe('Leave accrual', () => {
  let prisma: PrismaMock;
  let service: LeaveBalancesService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new LeaveBalancesService(prisma as unknown as PrismaService);
    prisma.company.findFirst.mockResolvedValue({ timezone: 'Asia/Muscat' });
    prisma.leaveAccrualHistory.create.mockResolvedValue({ id: 'history-1' });
    prisma.leaveTypeBalance.upsert.mockResolvedValue({});
    prisma.leaveBalance.update.mockResolvedValue({});
  });

  describe('accrueForPeriod', () => {
    it('writes the history row and the credit in one transaction', async () => {
      prisma.leaveAccrualHistory.aggregate.mockResolvedValue({
        _sum: { days: new Prisma.Decimal(2.5) },
      });

      const result = await service.accrueForPeriod({
        employeeId: 'employee-1',
        periodStart: MARCH,
        leaveTypeKey: 'Annual Leave',
        days: 2.5,
        year: 2026,
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ credited: true, daysAllocated: 2 });

      const history = argOf<{ data: Record<string, unknown> }>(
        prisma.leaveAccrualHistory.create,
      );
      expect(history.data).toMatchObject({
        employeeId: 'employee-1',
        periodStart: MARCH,
        leaveTypeKey: 'Annual Leave',
        year: 2026,
      });
    });

    it('credits nothing when the period has already been credited', async () => {
      // The unique index is the guard, not a check-then-act: the insert is what
      // fails, and the whole transaction rolls back with it.
      prisma.leaveAccrualHistory.create.mockRejectedValue(uniqueViolation());

      const result = await service.accrueForPeriod({
        employeeId: 'employee-1',
        periodStart: MARCH,
        leaveTypeKey: 'Annual Leave',
        days: 2.5,
        year: 2026,
      });

      expect(result).toEqual({ credited: false, daysAllocated: 0 });
      expect(prisma.leaveTypeBalance.upsert).not.toHaveBeenCalled();
      expect(prisma.leaveBalance.update).not.toHaveBeenCalled();
    });

    it('lets any other database failure through rather than reporting success', async () => {
      prisma.leaveAccrualHistory.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key failed', {
          code: 'P2003',
          clientVersion: '5.22.0',
        }),
      );

      await expect(
        service.accrueForPeriod({
          employeeId: 'employee-1',
          periodStart: MARCH,
          leaveTypeKey: 'Annual Leave',
          days: 2.5,
          year: 2026,
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('carries a fractional remainder into the next period instead of losing it', async () => {
      // First 2.5 credits 2 and banks a half...
      prisma.leaveAccrualHistory.aggregate.mockResolvedValue({
        _sum: { days: new Prisma.Decimal(2.5) },
      });
      const first = await service.accrueForPeriod({
        employeeId: 'employee-1',
        periodStart: MARCH,
        leaveTypeKey: 'Annual Leave',
        days: 2.5,
        year: 2026,
      });
      expect(first.daysAllocated).toBe(2);

      // ...and the second 2.5 credits 3, so two months are worth five days.
      prisma.leaveAccrualHistory.aggregate.mockResolvedValue({
        _sum: { days: new Prisma.Decimal(5) },
      });
      const second = await service.accrueForPeriod({
        employeeId: 'employee-1',
        periodStart: new Date('2026-04-01T00:00:00.000Z'),
        leaveTypeKey: 'Annual Leave',
        days: 2.5,
        year: 2026,
      });
      expect(second.daysAllocated).toBe(3);
    });

    it('writes no allocation at all in a period that rounds to nothing', async () => {
      prisma.leaveAccrualHistory.aggregate.mockResolvedValue({
        _sum: { days: new Prisma.Decimal(0.5) },
      });

      const result = await service.accrueForPeriod({
        employeeId: 'employee-1',
        periodStart: MARCH,
        leaveTypeKey: 'Annual Leave',
        days: 0.5,
        year: 2026,
      });

      expect(result).toEqual({ credited: true, daysAllocated: 0 });
      expect(prisma.leaveTypeBalance.upsert).not.toHaveBeenCalled();
    });

    it('mirrors the credit onto the statutory column for Annual Leave', async () => {
      prisma.leaveAccrualHistory.aggregate.mockResolvedValue({
        _sum: { days: new Prisma.Decimal(3) },
      });

      await service.accrueForPeriod({
        employeeId: 'employee-1',
        periodStart: MARCH,
        leaveTypeKey: 'Annual Leave',
        days: 3,
        year: 2026,
      });

      expect(
        argOf<{ data: { annualLeave: { increment: number } } }>(
          prisma.leaveBalance.update,
        ).data.annualLeave,
      ).toEqual({ increment: 3 });
    });

    it('leaves the statutory columns alone for a type that has none', async () => {
      prisma.leaveAccrualHistory.aggregate.mockResolvedValue({
        _sum: { days: new Prisma.Decimal(1) },
      });

      await service.accrueForPeriod({
        employeeId: 'employee-1',
        periodStart: MARCH,
        leaveTypeKey: 'Study Leave',
        days: 1,
        year: 2026,
      });

      expect(prisma.leaveTypeBalance.upsert).toHaveBeenCalled();
      expect(prisma.leaveBalance.update).not.toHaveBeenCalled();
    });

    it('refuses a period worth nothing', async () => {
      await expect(
        service.accrueForPeriod({
          employeeId: 'employee-1',
          periodStart: MARCH,
          leaveTypeKey: 'Annual Leave',
          days: 0,
          year: 2026,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('runMonthlyAccrual', () => {
    beforeEach(() => {
      prisma.libraryItem.findFirst.mockResolvedValue({ defaultDays: 30 });
      prisma.employee.findMany.mockResolvedValue([
        { id: 'employee-1' },
        { id: 'employee-2' },
      ]);
      // ensureBalance: the year is already open.
      prisma.leaveBalance.findUnique.mockResolvedValue({
        id: 'balance-1',
        annualLeave: 30,
      });
      prisma.leaveAccrualHistory.aggregate.mockResolvedValue({
        _sum: { days: new Prisma.Decimal(2.5) },
      });
    });

    it('spreads the annual entitlement over twelve periods', async () => {
      const result = await service.runMonthlyAccrual();

      // Thirty days a year is two and a half a month; nothing else has to be
      // configured for the rate to follow the entitlement.
      expect(result.daysPerPeriod).toBe(2.5);
      expect(result.credited).toBe(2);
      expect(result.alreadyCredited).toBe(0);
      expect(result.leaveTypeKey).toBe('Annual Leave');
      expect(result.periodStart).toMatch(/^\d{4}-\d{2}-01$/);
    });

    it('credits nothing on a second run in the same period', async () => {
      // The whole point of the guard: two containers starting together on the
      // first of the month must not each credit the month.
      prisma.leaveAccrualHistory.create.mockRejectedValue(uniqueViolation());

      const result = await service.runMonthlyAccrual();

      expect(result.credited).toBe(0);
      expect(result.alreadyCredited).toBe(2);
      expect(prisma.leaveTypeBalance.upsert).not.toHaveBeenCalled();
      expect(prisma.leaveBalance.update).not.toHaveBeenCalled();
    });

    it('falls back to the built-in entitlement when the library has no default', async () => {
      prisma.libraryItem.findFirst.mockResolvedValue(null);

      const result = await service.runMonthlyAccrual();

      expect(result.daysPerPeriod).toBe(1);
    });

    it('reads the period from the company clock, not the server clock', async () => {
      prisma.company.findFirst.mockResolvedValue({
        timezone: 'Pacific/Kiritimati',
      });

      const result = await service.runMonthlyAccrual();

      expect(prisma.company.findFirst).toHaveBeenCalled();
      expect(result.periodStart.endsWith('-01')).toBe(true);
    });
  });

  describe('the tick', () => {
    it('does nothing on a day that is not the first of the month', async () => {
      jest
        .spyOn(
          service as unknown as {
            isFirstOfMonthInCompanyZone: () => Promise<boolean>;
          },
          'isFirstOfMonthInCompanyZone',
        )
        .mockResolvedValue(false);

      await service.monthlyAccrualTick();

      expect(prisma.employee.findMany).not.toHaveBeenCalled();
    });

    it('swallows a failure rather than taking the scheduler down', async () => {
      jest
        .spyOn(
          service as unknown as {
            isFirstOfMonthInCompanyZone: () => Promise<boolean>;
          },
          'isFirstOfMonthInCompanyZone',
        )
        .mockResolvedValue(true);
      jest
        .spyOn(service, 'runMonthlyAccrual')
        .mockRejectedValue(new Error('database unreachable'));

      await expect(service.monthlyAccrualTick()).resolves.toBeUndefined();
    });
  });

  describe('getAccrualHistory', () => {
    beforeEach(() => {
      prisma.leaveAccrualHistory.findMany.mockResolvedValue([
        {
          id: 'history-1',
          employeeId: 'employee-1',
          periodStart: MARCH,
          leaveTypeKey: 'Annual Leave',
          days: new Prisma.Decimal(2.5),
          year: 2026,
          note: 'Monthly accrual for 2026-03',
          createdAt: new Date(),
          employee: {
            id: 'employee-1',
            employeeCode: 'EMP-0001',
            firstName: 'Rana',
            lastName: 'Said',
            department: { name: 'Finance' },
          },
        },
      ]);
    });

    it('narrows a month to the period it names', async () => {
      await service.getAccrualHistory({ year: 2026, month: 3 });

      expect(
        argOf<{ where: { periodStart: Date } }>(
          prisma.leaveAccrualHistory.findMany,
        ).where.periodStart,
      ).toEqual(MARCH);
    });

    it('refuses a month with no year beside it', async () => {
      await expect(
        service.getAccrualHistory({ month: 3 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('emits the fractional days as a number and joins the name', async () => {
      const res = await service.getAccrualHistory({});

      expect(res.data[0].days).toBe(2.5);
      expect(res.data[0].employee.fullName).toBe('Rana Said');
    });
  });
});
