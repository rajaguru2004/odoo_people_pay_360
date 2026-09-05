import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { LeaveRequestsService } from './leave-requests.service';
import { PrismaService } from '../prisma/prisma.service';
import { LeaveBalancesService } from '../leave-balances/leave-balances.service';
import { LeaveWorkingDaysService } from './leave-working-days.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import type { Principal } from '../auth/auth.service';

const prismaMock = () => ({
  employee: { findUnique: jest.fn(), findMany: jest.fn() },
  libraryItem: { findFirst: jest.fn() },
  leaveRequest: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  attendance: { createMany: jest.fn() },
  $transaction: jest.fn(),
});

type PrismaMock = ReturnType<typeof prismaMock>;

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

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    employeeId: 'employee-1',
    leaveType: 'Annual Leave',
    startDate: new Date('2026-03-02T00:00:00.000Z'),
    endDate: new Date('2026-03-04T00:00:00.000Z'),
    totalDays: 3,
    reason: 'Family visit',
    status: 'PENDING',
    approverId: null,
    approvedAt: null,
    rejectedReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    attachments: [],
    approver: null,
    employee: {
      id: 'employee-1',
      employeeCode: 'EMP-001',
      firstName: 'Rana',
      lastName: 'Said',
      avatarUrl: null,
      workEmail: 'rana@example.com',
      departmentId: 'department-1',
      branchId: 'branch-1',
      department: { id: 'department-1', name: 'Finance', managerId: null },
    },
    ...overrides,
  };
}

describe('LeaveRequestsService', () => {
  let prisma: PrismaMock;
  let balances: jest.Mocked<
    Pick<LeaveBalancesService, 'deductDays' | 'getBalance'>
  >;
  let workingDays: jest.Mocked<
    Pick<LeaveWorkingDaysService, 'workDaysBetween' | 'workingDatesBetween'>
  >;
  let approvals: jest.Mocked<
    Pick<
      ApprovalEngineService,
      'initiate' | 'decide' | 'abandon' | 'isChainParticipant'
    >
  >;
  let service: LeaveRequestsService;

  beforeEach(() => {
    prisma = prismaMock();
    balances = {
      deductDays: jest.fn(),
      getBalance: jest.fn(),
    };
    workingDays = {
      workDaysBetween: jest.fn(),
      workingDatesBetween: jest.fn().mockResolvedValue([]),
    };
    approvals = {
      initiate: jest
        .fn()
        .mockResolvedValue({ engaged: false, finalized: false }),
      decide: jest.fn().mockResolvedValue({ engaged: false, finalized: false }),
      abandon: jest.fn().mockResolvedValue(undefined),
      isChainParticipant: jest.fn().mockResolvedValue(false),
    };

    service = new LeaveRequestsService(
      prisma as unknown as PrismaService,
      balances as unknown as LeaveBalancesService,
      workingDays as unknown as LeaveWorkingDaysService,
      approvals as unknown as ApprovalEngineService,
    );
    prisma.attendance.createMany.mockResolvedValue({ count: 0 });
  });

  describe('create', () => {
    const dto = {
      leaveType: 'Annual Leave',
      startDate: '2026-03-02',
      endDate: '2026-03-04',
      reason: 'Family visit',
    };

    beforeEach(() => {
      prisma.employee.findUnique.mockResolvedValue({
        id: 'employee-1',
        gender: 'FEMALE',
        branchId: 'branch-1',
      });
      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      prisma.libraryItem.findFirst.mockResolvedValue({
        label: 'Annual Leave',
        defaultDays: 30,
        affectsBalance: true,
        genderRestriction: null,
        requiresNoticeDays: 0,
      });
      workingDays.workDaysBetween.mockResolvedValue(3);
      balances.getBalance.mockResolvedValue({
        remainingAnnual: 20,
        remainingSick: 30,
        leaveTypeBalances: [{ leaveTypeKey: 'Annual Leave', remaining: 20 }],
      } as unknown as Awaited<ReturnType<LeaveBalancesService['getBalance']>>);
      prisma.leaveRequest.create.mockResolvedValue(requestRow());
    });

    it('refuses an employee filing for somebody else', async () => {
      await expect(
        service.create({ ...dto, employeeId: 'employee-2' }, principal()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
    });

    it('lets HR file for somebody else', async () => {
      await service.create(
        { ...dto, employeeId: 'employee-2' },
        principal({ role: UserRole.HR_MANAGER, employeeId: 'employee-hr' }),
      );
      expect(prisma.leaveRequest.create).toHaveBeenCalled();
    });

    it('refuses a range that overlaps a live request', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue({
        startDate: new Date('2026-03-03T00:00:00.000Z'),
        endDate: new Date('2026-03-06T00:00:00.000Z'),
      });

      await expect(service.create(dto, principal())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a gender-restricted type the employee is not eligible for', async () => {
      prisma.libraryItem.findFirst.mockResolvedValue({
        label: 'Paternity Leave',
        defaultDays: 5,
        affectsBalance: true,
        genderRestriction: 'MALE',
        requiresNoticeDays: 0,
      });

      await expect(
        service.create({ ...dto, leaveType: 'Paternity Leave' }, principal()),
      ).rejects.toThrow('only available to male employees');
    });

    it('refuses when the balance is short of the days asked for', async () => {
      balances.getBalance.mockResolvedValue({
        remainingAnnual: 1,
        remainingSick: 30,
        leaveTypeBalances: [{ leaveTypeKey: 'Annual Leave', remaining: 1 }],
      } as unknown as Awaited<ReturnType<LeaveBalancesService['getBalance']>>);

      await expect(service.create(dto, principal())).rejects.toThrow(
        'Available: 1 days',
      );
      expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
    });

    it('charges only the working days in the range', async () => {
      workingDays.workDaysBetween.mockResolvedValue(2);

      await service.create(dto, principal());

      const created = (
        prisma.leaveRequest.create.mock.calls as {
          data: { totalDays: number; leaveType: string };
        }[][]
      )[0][0];
      expect(created.data.totalDays).toBe(2);
      // The library LABEL is stored, so a later rename cannot rewrite history.
      expect(created.data.leaveType).toBe('Annual Leave');
    });

    it('refuses a range with no working day in it at all', async () => {
      workingDays.workDaysBetween.mockResolvedValue(0);

      await expect(service.create(dto, principal())).rejects.toThrow(
        'no working days',
      );
    });
  });

  describe('approve', () => {
    it('deducts the balance BEFORE writing the status', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(requestRow());
      prisma.leaveRequest.update.mockResolvedValue(
        requestRow({ status: 'APPROVED' }),
      );

      const order: string[] = [];
      balances.deductDays.mockImplementation(() => {
        order.push('deduct');
        return Promise.resolve({} as never);
      });
      prisma.leaveRequest.update.mockImplementation(() => {
        order.push('status');
        return Promise.resolve(requestRow({ status: 'APPROVED' }));
      });

      await service.approve(
        'request-1',
        undefined,
        principal({ role: UserRole.HR_MANAGER }),
      );

      // Nothing is reserved when the request is raised, so two pending requests
      // can each pass the create-time check against the same days. Writing the
      // status first left the row APPROVED while the caller got a 400.
      expect(order).toEqual(['deduct', 'status']);
    });

    it('leaves the request untouched when the deduction fails', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(requestRow());
      balances.deductDays.mockRejectedValue(
        new BadRequestException(
          'Insufficient Annual Leave balance. Available: 1 days',
        ),
      );

      await expect(
        service.approve(
          'request-1',
          undefined,
          principal({ role: UserRole.HR_MANAGER }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
      expect(prisma.attendance.createMany).not.toHaveBeenCalled();
    });

    it('refuses a colleague with no elevated role when no chain governs it', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(
        requestRow({ employeeId: 'employee-2' }),
      );

      await expect(
        service.approve(
          'request-1',
          undefined,
          principal({ id: 'user-2', employeeId: 'employee-2' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('records the step and waits when the chain is not finished', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(requestRow());
      approvals.decide.mockResolvedValue({
        engaged: true,
        finalized: false,
        nextStepOrder: 2,
      });

      const result = await service.approve(
        'request-1',
        'Cover arranged',
        principal({ id: 'user-supervisor' }),
      );

      expect(result.message).toMatch(/next approval step/i);
      expect(balances.deductDays).not.toHaveBeenCalled();
      expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
    });

    it('finalises when the chain reports the last step approved', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(requestRow());
      prisma.leaveRequest.update.mockResolvedValue(
        requestRow({ status: 'APPROVED' }),
      );
      approvals.decide.mockResolvedValue({
        engaged: true,
        finalized: true,
        outcome: 'APPROVED',
      });

      await service.approve(
        'request-1',
        undefined,
        principal({ id: 'user-hr' }),
      );

      expect(balances.deductDays).toHaveBeenCalledWith(
        'employee-1',
        3,
        'Annual Leave',
        2026,
      );
    });

    it('writes an ON_LEAVE row for every working day, keeping any real punch', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(requestRow());
      prisma.leaveRequest.update.mockResolvedValue(
        requestRow({ status: 'APPROVED' }),
      );
      workingDays.workingDatesBetween.mockResolvedValue([
        new Date('2026-03-02T00:00:00.000Z'),
        new Date('2026-03-03T00:00:00.000Z'),
        new Date('2026-03-04T00:00:00.000Z'),
      ]);
      prisma.attendance.createMany.mockResolvedValue({ count: 2 });

      const result = await service.approve(
        'request-1',
        undefined,
        principal({ role: UserRole.HR_MANAGER }),
      );

      const call = (
        prisma.attendance.createMany.mock.calls as {
          data: { status: string; source: string; branchId: string | null }[];
          skipDuplicates: boolean;
        }[][]
      )[0][0];
      expect(call.skipDuplicates).toBe(true);
      expect(call.data).toHaveLength(3);
      expect(call.data[0]).toMatchObject({
        status: 'ON_LEAVE',
        source: 'SYSTEM',
        branchId: 'branch-1',
      });
      // The approver is told which days kept their own record rather than
      // finding out later that a day of approved leave has nothing behind it.
      expect(result.message).toMatch(
        /1 day\(s\) already had an attendance record/,
      );
    });
  });

  describe('cancel', () => {
    it('closes the live trail so no approver can finalise a withdrawn request', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue({
        id: 'request-1',
        employeeId: 'employee-1',
        status: 'PENDING',
      });
      prisma.leaveRequest.update.mockResolvedValue(
        requestRow({ status: 'CANCELLED' }),
      );

      await service.cancel('request-1', principal());

      expect(approvals.abandon).toHaveBeenCalledWith('LEAVE', 'request-1');
    });

    it('refuses to cancel a colleague request', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue({
        id: 'request-1',
        employeeId: 'employee-2',
        status: 'PENDING',
      });

      await expect(
        service.cancel('request-1', principal()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to cancel anything already decided', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue({
        id: 'request-1',
        employeeId: 'employee-1',
        status: 'APPROVED',
      });

      await expect(
        service.cancel('request-1', principal()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('findOne', () => {
    it('refuses a colleague reading somebody else request', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(
        requestRow({ employeeId: 'employee-2' }),
      );

      await expect(
        service.findOne(
          'request-1',
          principal({ departmentId: 'department-9' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admits a participant in the request own approval chain', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(
        requestRow({ employeeId: 'employee-2' }),
      );
      approvals.isChainParticipant.mockResolvedValue(true);

      // A supervisor holds role EMPLOYEE and owns none of the requester's
      // records; refusing them would strand the chain at step one.
      await expect(
        service.findOne(
          'request-1',
          principal({ departmentId: 'department-9' }),
        ),
      ).resolves.toBeDefined();
    });

    it('emits a joined fullName even though the record stores the parts', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(requestRow());

      const result = await service.findOne(
        'request-1',
        principal({ role: UserRole.HR_MANAGER }),
      );

      expect(result.employee).toMatchObject({ fullName: 'Rana Said' });
    });
  });
});
