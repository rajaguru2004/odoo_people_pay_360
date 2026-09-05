import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { LeaveBalancesService } from './leave-balances.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/auth.service';

const prismaMock = () => ({
  employee: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  libraryItem: { findFirst: jest.fn(), findMany: jest.fn() },
  leaveBalance: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
  },
  leaveTypeBalance: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
    groupBy: jest.fn(),
  },
  requestApproval: { findMany: jest.fn() },
  leaveRequest: { count: jest.fn() },
});

type PrismaMock = ReturnType<typeof prismaMock>;

function balanceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'balance-1',
    employeeId: 'employee-1',
    year: 2026,
    annualLeave: 30,
    sickLeave: 30,
    usedAnnual: 0,
    usedSick: 0,
    carriedOver: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function typeBalanceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'type-1',
    employeeId: 'employee-1',
    year: 2026,
    leaveTypeKey: 'Annual Leave',
    allocated: 30,
    used: 0,
    carriedOver: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function libraryItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'library-1',
    label: 'Annual Leave',
    defaultDays: 30,
    affectsBalance: true,
    genderRestriction: null,
    requiresNoticeDays: 0,
    ...overrides,
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'user-1',
    email: 'someone@example.com',
    role: UserRole.EMPLOYEE,
    employeeId: 'employee-1',
    departmentId: 'department-1',
    branchId: 'branch-1',
    ...overrides,
  };
}

function argOf<T>(mock: jest.Mock, call = 0): T {
  return (mock.mock.calls as T[][])[call][0];
}

describe('LeaveBalancesService', () => {
  let prisma: PrismaMock;
  let service: LeaveBalancesService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new LeaveBalancesService(prisma as unknown as PrismaService);
  });

  describe('deductDays', () => {
    it('takes the days out of the type bucket and mirrors the statutory column', async () => {
      prisma.libraryItem.findFirst.mockResolvedValue(libraryItem());
      prisma.leaveBalance.findUnique.mockResolvedValue(
        balanceRow({ usedAnnual: 4 }),
      );
      prisma.leaveTypeBalance.findUnique.mockResolvedValue(
        typeBalanceRow({ allocated: 30, used: 4, carriedOver: 2 }),
      );
      prisma.leaveTypeBalance.update.mockResolvedValue({});
      prisma.leaveBalance.update.mockResolvedValue(
        balanceRow({ usedAnnual: 7 }),
      );

      await service.deductDays('employee-1', 3, 'Annual Leave', 2026);

      expect(
        argOf<{ data: { used: number } }>(prisma.leaveTypeBalance.update).data
          .used,
      ).toBe(7);
      // The two have to agree: a payslip reads the statutory column and the
      // screen reads the bucket, and they are the same leave.
      expect(
        argOf<{ data: { usedAnnual: number } }>(prisma.leaveBalance.update).data
          .usedAnnual,
      ).toBe(7);
    });

    it('counts carry-over as available', async () => {
      prisma.libraryItem.findFirst.mockResolvedValue(libraryItem());
      prisma.leaveBalance.findUnique.mockResolvedValue(balanceRow());
      // 10 allocated + 5 carried − 12 used leaves 3, which covers the ask.
      prisma.leaveTypeBalance.findUnique.mockResolvedValue(
        typeBalanceRow({ allocated: 10, used: 12, carriedOver: 5 }),
      );
      prisma.leaveTypeBalance.update.mockResolvedValue({});
      prisma.leaveBalance.update.mockResolvedValue(balanceRow());

      await expect(
        service.deductDays('employee-1', 3, 'Annual Leave', 2026),
      ).resolves.toBeDefined();
    });

    it('refuses when the bucket is short, naming what is left', async () => {
      prisma.libraryItem.findFirst.mockResolvedValue(libraryItem());
      prisma.leaveBalance.findUnique.mockResolvedValue(balanceRow());
      prisma.leaveTypeBalance.findUnique.mockResolvedValue(
        typeBalanceRow({ allocated: 10, used: 8, carriedOver: 0 }),
      );

      await expect(
        service.deductDays('employee-1', 3, 'Annual Leave', 2026),
      ).rejects.toThrow('Available: 2 days');
      expect(prisma.leaveTypeBalance.update).not.toHaveBeenCalled();
    });

    it('leaves the balance alone for a type that does not affect it', async () => {
      prisma.libraryItem.findFirst.mockResolvedValue(
        libraryItem({ label: 'Unpaid Leave', affectsBalance: false }),
      );
      prisma.leaveBalance.findUnique.mockResolvedValue(balanceRow());

      await service.deductDays('employee-1', 5, 'Unpaid Leave', 2026);

      expect(prisma.leaveTypeBalance.update).not.toHaveBeenCalled();
      expect(prisma.leaveBalance.update).not.toHaveBeenCalled();
    });

    it('resolves a short code onto the library label it means', async () => {
      prisma.libraryItem.findFirst.mockResolvedValue(
        libraryItem({ label: 'Sick Leave' }),
      );
      prisma.leaveBalance.findUnique.mockResolvedValue(
        balanceRow({ usedSick: 1 }),
      );
      prisma.leaveTypeBalance.findUnique.mockResolvedValue(
        typeBalanceRow({ leaveTypeKey: 'Sick Leave', allocated: 30, used: 1 }),
      );
      prisma.leaveTypeBalance.update.mockResolvedValue({});
      prisma.leaveBalance.update.mockResolvedValue(balanceRow());

      await service.deductDays('employee-1', 2, 'SICK', 2026);

      const where = argOf<{ where: { OR: { label?: unknown }[] } }>(
        prisma.libraryItem.findFirst,
      ).where;
      expect(where.OR).toContainEqual({ label: 'Sick Leave' });
      // …and it lands on the sick column, not the annual one.
      expect(
        argOf<{ data: Record<string, unknown> }>(prisma.leaveBalance.update)
          .data,
      ).toEqual({ usedSick: 3 });
    });

    it('falls back to the statutory columns when the library knows nothing', async () => {
      prisma.libraryItem.findFirst.mockResolvedValue(null);
      prisma.leaveBalance.findUnique.mockResolvedValue(
        balanceRow({ annualLeave: 10, carriedOver: 0, usedAnnual: 9 }),
      );

      await expect(
        service.deductDays('employee-1', 3, 'ANNUAL', 2026),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('addDays', () => {
    it('never drives a used count below zero', async () => {
      prisma.libraryItem.findFirst.mockResolvedValue(libraryItem());
      prisma.leaveBalance.findUnique.mockResolvedValue(
        balanceRow({ usedAnnual: 1 }),
      );
      prisma.leaveTypeBalance.findUnique.mockResolvedValue(
        typeBalanceRow({ used: 1 }),
      );
      prisma.leaveTypeBalance.update.mockResolvedValue({});
      prisma.leaveBalance.update.mockResolvedValue(balanceRow());

      await service.addDays('employee-1', 5, 'Annual Leave', 2026);

      expect(
        argOf<{ data: { used: number } }>(prisma.leaveTypeBalance.update).data
          .used,
      ).toBe(0);
      expect(
        argOf<{ data: { usedAnnual: number } }>(prisma.leaveBalance.update).data
          .usedAnnual,
      ).toBe(0);
    });
  });

  describe('updateBalance', () => {
    it('refuses a body that would change nothing', async () => {
      await expect(
        service.updateBalance('employee-1', 2026, undefined, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getBalance', () => {
    it('refuses a colleague reading somebody else', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'employee-2' });
      prisma.requestApproval.findMany.mockResolvedValue([]);

      await expect(
        service.getBalance('employee-2', 2026, principal()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admits an approver holding a live step on that employee', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'employee-2' });
      prisma.requestApproval.findMany.mockResolvedValue([
        {
          requestId: 'request-1',
          resolvedApproverId: 'user-1',
          approverType: 'SUPERVISOR',
        },
      ]);
      prisma.leaveRequest.count.mockResolvedValue(1);
      prisma.leaveBalance.findUnique.mockResolvedValue({
        ...balanceRow({ employeeId: 'employee-2' }),
        employee: { gender: 'FEMALE' },
      });
      prisma.leaveTypeBalance.findMany.mockResolvedValue([]);
      prisma.libraryItem.findMany.mockResolvedValue([]);

      // The balance panel is the context the decision is made in; a supervisor
      // asked to approve leave with it blanked has the decision without the facts.
      await expect(
        service.getBalance('employee-2', 2026, principal()),
      ).resolves.toMatchObject({ employeeId: 'employee-2' });
    });

    it('hides a gender-restricted bucket from an employee it does not apply to', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'employee-1' });
      prisma.leaveBalance.findUnique.mockResolvedValue({
        ...balanceRow(),
        employee: { gender: 'MALE' },
      });
      prisma.leaveTypeBalance.findMany
        // existing keys, for the seed check
        .mockResolvedValueOnce([
          { leaveTypeKey: 'Annual Leave' },
          { leaveTypeKey: 'Maternity Leave' },
        ])
        // the rows themselves
        .mockResolvedValueOnce([
          typeBalanceRow(),
          typeBalanceRow({
            id: 'type-2',
            leaveTypeKey: 'Maternity Leave',
            allocated: 60,
          }),
        ]);
      prisma.libraryItem.findMany
        // seedTypeBalances
        .mockResolvedValueOnce([])
        // the restriction map
        .mockResolvedValueOnce([
          { label: 'Annual Leave', genderRestriction: null },
          { label: 'Maternity Leave', genderRestriction: 'FEMALE' },
        ]);

      const result = await service.getBalance('employee-1', 2026, principal());

      expect(result.leaveTypeBalances.map((row) => row.leaveTypeKey)).toEqual([
        'Annual Leave',
      ]);
    });

    it('reports remaining as allocation plus carry-over less used', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'employee-1' });
      prisma.leaveBalance.findUnique.mockResolvedValue({
        ...balanceRow({
          annualLeave: 30,
          carriedOver: 5,
          usedAnnual: 8,
          sickLeave: 30,
          usedSick: 2,
        }),
        employee: { gender: null },
      });
      prisma.leaveTypeBalance.findMany
        .mockResolvedValueOnce([{ leaveTypeKey: 'Annual Leave' }])
        .mockResolvedValueOnce([
          typeBalanceRow({ allocated: 30, carriedOver: 5, used: 8 }),
        ]);
      prisma.libraryItem.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.getBalance('employee-1', 2026, principal());

      expect(result.remainingAnnual).toBe(27);
      // Sick leave does not carry over, so its remaining ignores the column.
      expect(result.remainingSick).toBe(28);
      expect(result.leaveTypeBalances[0].remaining).toBe(27);
    });
  });
});
