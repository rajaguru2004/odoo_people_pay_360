import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApprovalMode, ApproverType, UserRole } from '@prisma/client';
import { ApprovalEngineService } from './approval-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/auth.service';

const prismaMock = () => ({
  systemSetting: { findUnique: jest.fn() },
  approvalWorkflow: { findFirst: jest.fn(), findMany: jest.fn() },
  requestApproval: {
    createMany: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  employee: { findUnique: jest.fn(), count: jest.fn() },
  user: { findMany: jest.fn() },
  department: { findMany: jest.fn(), count: jest.fn() },
  auditLog: { create: jest.fn() },
  leaveRequest: { findUnique: jest.fn(), findMany: jest.fn() },
  overtimeRequest: { findUnique: jest.fn(), findMany: jest.fn() },
  trainingNomination: { findUnique: jest.fn(), findMany: jest.fn() },
});

type PrismaMock = ReturnType<typeof prismaMock>;

/** A trail row as `findMany` returns it, with only the fields the engine reads. */
function step(overrides: {
  id: string;
  stepOrder: number;
  approverType: ApproverType;
  status?: string;
  resolvedApproverId?: string | null;
  decidedById?: string | null;
}) {
  return {
    status: 'PENDING',
    resolvedApproverId: null,
    decidedById: null,
    requestType: 'LEAVE' as const,
    requestId: 'request-1',
    comment: null,
    decidedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'user-hr',
    email: 'hr@example.com',
    role: UserRole.HR_MANAGER,
    employeeId: 'employee-hr',
    departmentId: null,
    branchId: null,
    ...overrides,
  };
}

/** The first argument a mocked Prisma call received, typed for the assertion. */
function argOf<T>(mock: jest.Mock, call = 0): T {
  return (mock.mock.calls as T[][])[call][0];
}

describe('ApprovalEngineService', () => {
  let prisma: PrismaMock;
  let engine: ApprovalEngineService;

  beforeEach(() => {
    prisma = prismaMock();
    engine = new ApprovalEngineService(prisma as unknown as PrismaService);
    prisma.systemSetting.findUnique.mockResolvedValue({ value: 'true' });
    prisma.auditLog.create.mockResolvedValue({});
    prisma.requestApproval.update.mockResolvedValue({});
    prisma.requestApproval.updateMany.mockResolvedValue({ count: 0 });
    prisma.requestApproval.createMany.mockResolvedValue({ count: 0 });
  });

  describe('initiate', () => {
    it('stays out of the way when no workflow governs the type', async () => {
      prisma.approvalWorkflow.findFirst.mockResolvedValue(null);

      const result = await engine.initiate('LEAVE', 'request-1', 'employee-1');

      expect(result).toEqual({ engaged: false, finalized: false });
      expect(prisma.requestApproval.createMany).not.toHaveBeenCalled();
    });

    it('stays out of the way while the master switch is off', async () => {
      prisma.systemSetting.findUnique.mockResolvedValue({ value: 'false' });

      const result = await engine.initiate('LEAVE', 'request-1', 'employee-1');

      expect(result.engaged).toBe(false);
      expect(prisma.approvalWorkflow.findFirst).not.toHaveBeenCalled();
    });

    it('opens the first step and snapshots the supervisor who owes it', async () => {
      prisma.approvalWorkflow.findFirst.mockResolvedValue({
        id: 'workflow-1',
        mode: ApprovalMode.SEQUENTIAL,
        steps: [
          { stepOrder: 1, approverType: ApproverType.SUPERVISOR },
          { stepOrder: 2, approverType: ApproverType.HR_MANAGER },
        ],
      });
      prisma.requestApproval.findMany.mockResolvedValue([
        step({
          id: 'row-1',
          stepOrder: 1,
          approverType: ApproverType.SUPERVISOR,
        }),
        step({
          id: 'row-2',
          stepOrder: 2,
          approverType: ApproverType.HR_MANAGER,
        }),
      ]);
      prisma.employee.findUnique
        // requesterContext
        .mockResolvedValueOnce({
          id: 'employee-1',
          firstName: 'Rana',
          lastName: 'Said',
          departmentId: 'department-1',
          supervisorId: 'employee-sup',
          user: { id: 'user-requester' },
        })
        // resolveApprovers(SUPERVISOR)
        .mockResolvedValueOnce({
          supervisor: { user: { id: 'user-supervisor' } },
        });

      const result = await engine.initiate(
        'LEAVE',
        'request-1',
        'employee-1',
        'user-requester',
      );

      expect(result).toEqual({
        engaged: true,
        finalized: false,
        nextStepOrder: 1,
      });

      // The snapshot is the point: the person who owed the decision when the
      // step opened still owes it after a reporting line moves.
      const update = argOf<{
        where: { id: string };
        data: Record<string, unknown>;
      }>(prisma.requestApproval.update);
      expect(update.where.id).toBe('row-1');
      expect(update.data).toEqual({
        status: 'ACTIVE',
        resolvedApproverId: 'user-supervisor',
      });

      // SEQUENTIAL stops at the first actionable step; step 2 stays PENDING.
      expect(prisma.requestApproval.update).toHaveBeenCalledTimes(1);
    });

    it('leaves a role step unresolved, because its pool is whoever holds the role', async () => {
      prisma.approvalWorkflow.findFirst.mockResolvedValue({
        id: 'workflow-1',
        mode: ApprovalMode.SEQUENTIAL,
        steps: [{ stepOrder: 1, approverType: ApproverType.HR_MANAGER }],
      });
      prisma.requestApproval.findMany.mockResolvedValue([
        step({
          id: 'row-1',
          stepOrder: 1,
          approverType: ApproverType.HR_MANAGER,
        }),
      ]);
      prisma.employee.findUnique.mockResolvedValueOnce({
        id: 'employee-1',
        firstName: 'Rana',
        lastName: 'Said',
        departmentId: null,
        supervisorId: null,
        user: { id: 'user-requester' },
      });
      prisma.user.findMany.mockResolvedValue([{ id: 'user-hr' }]);

      await engine.initiate('LEAVE', 'request-1', 'employee-1');

      expect(
        argOf<{ data: { resolvedApproverId: string | null } }>(
          prisma.requestApproval.update,
        ).data.resolvedApproverId,
      ).toBeNull();
    });

    it('skips a step that resolves to nobody but the requester', async () => {
      prisma.approvalWorkflow.findFirst.mockResolvedValue({
        id: 'workflow-1',
        mode: ApprovalMode.SEQUENTIAL,
        steps: [{ stepOrder: 1, approverType: ApproverType.SUPERVISOR }],
      });
      prisma.requestApproval.findMany.mockResolvedValue([
        step({
          id: 'row-1',
          stepOrder: 1,
          approverType: ApproverType.SUPERVISOR,
        }),
      ]);
      prisma.employee.findUnique
        .mockResolvedValueOnce({
          id: 'employee-1',
          firstName: 'Rana',
          lastName: 'Said',
          departmentId: null,
          supervisorId: 'employee-1',
          user: { id: 'user-requester' },
        })
        // The supervisor IS the requester — nobody else can act.
        .mockResolvedValueOnce({
          supervisor: { user: { id: 'user-requester' } },
        });

      const result = await engine.initiate('LEAVE', 'request-1', 'employee-1');

      expect(result).toEqual({
        engaged: true,
        finalized: true,
        outcome: 'APPROVED',
      });
      expect(
        argOf<{ data: { status: string } }>(prisma.requestApproval.update).data
          .status,
      ).toBe('SKIPPED');
    });
  });

  describe('decide', () => {
    const activeSupervisorStep = () =>
      step({
        id: 'row-1',
        stepOrder: 1,
        approverType: ApproverType.SUPERVISOR,
        status: 'ACTIVE',
        resolvedApproverId: 'user-supervisor',
      });

    it('refuses somebody the step does not name', async () => {
      prisma.requestApproval.findMany.mockResolvedValue([
        activeSupervisorStep(),
      ]);

      await expect(
        engine.decide(
          'LEAVE',
          'request-1',
          'employee-1',
          principal({ id: 'user-other', role: UserRole.EMPLOYEE }),
          'APPROVE',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.requestApproval.update).not.toHaveBeenCalled();
    });

    it('refuses a chain that has already settled', async () => {
      prisma.requestApproval.findMany.mockResolvedValue([
        step({
          id: 'row-1',
          stepOrder: 1,
          approverType: ApproverType.SUPERVISOR,
          status: 'APPROVED',
        }),
      ]);

      await expect(
        engine.decide(
          'LEAVE',
          'request-1',
          'employee-1',
          principal(),
          'APPROVE',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not finalise on an intermediate approval — it opens the next step', async () => {
      prisma.requestApproval.findMany
        // the whole trail
        .mockResolvedValueOnce([
          activeSupervisorStep(),
          step({
            id: 'row-2',
            stepOrder: 2,
            approverType: ApproverType.HR_MANAGER,
          }),
        ])
        // activateFrom: what is still PENDING from step 2 on
        .mockResolvedValueOnce([
          step({
            id: 'row-2',
            stepOrder: 2,
            approverType: ApproverType.HR_MANAGER,
          }),
        ]);
      prisma.approvalWorkflow.findFirst.mockResolvedValue({
        id: 'workflow-1',
        mode: ApprovalMode.SEQUENTIAL,
        steps: [],
      });
      prisma.employee.findUnique.mockResolvedValue({
        id: 'employee-1',
        firstName: 'Rana',
        lastName: 'Said',
        departmentId: null,
        supervisorId: null,
        user: { id: 'user-requester' },
      });
      prisma.user.findMany.mockResolvedValue([{ id: 'user-hr' }]);

      const result = await engine.decide(
        'LEAVE',
        'request-1',
        'employee-1',
        principal({ id: 'user-supervisor', role: UserRole.EMPLOYEE }),
        'APPROVE',
        'Cover arranged',
      );

      expect(result).toEqual({
        engaged: true,
        finalized: false,
        nextStepOrder: 2,
      });

      const decided = argOf<{ data: Record<string, unknown> }>(
        prisma.requestApproval.update,
      );
      expect(decided.data).toMatchObject({
        status: 'APPROVED',
        decidedById: 'user-supervisor',
        comment: 'Cover arranged',
      });
    });

    it('finalises once the last outstanding step approves', async () => {
      prisma.requestApproval.findMany
        .mockResolvedValueOnce([
          step({
            id: 'row-2',
            stepOrder: 2,
            approverType: ApproverType.HR_MANAGER,
            status: 'ACTIVE',
          }),
        ])
        // nothing left PENDING
        .mockResolvedValueOnce([]);
      prisma.approvalWorkflow.findFirst.mockResolvedValue({
        id: 'workflow-1',
        mode: ApprovalMode.SEQUENTIAL,
        steps: [],
      });
      prisma.employee.findUnique.mockResolvedValue({
        id: 'employee-1',
        firstName: 'Rana',
        lastName: 'Said',
        departmentId: null,
        supervisorId: null,
        user: { id: 'user-requester' },
      });
      prisma.user.findMany.mockResolvedValue([{ id: 'user-hr' }]);

      const result = await engine.decide(
        'LEAVE',
        'request-1',
        'employee-1',
        principal({ id: 'user-hr' }),
        'APPROVE',
      );

      expect(result).toEqual({
        engaged: true,
        finalized: true,
        outcome: 'APPROVED',
      });
    });

    it('short-circuits the whole chain on a rejection', async () => {
      prisma.requestApproval.findMany.mockResolvedValue([
        activeSupervisorStep(),
        step({
          id: 'row-2',
          stepOrder: 2,
          approverType: ApproverType.HR_MANAGER,
        }),
      ]);

      const result = await engine.decide(
        'LEAVE',
        'request-1',
        'employee-1',
        principal({ id: 'user-supervisor', role: UserRole.EMPLOYEE }),
        'REJECT',
        'Peak season',
      );

      expect(result).toEqual({
        engaged: true,
        finalized: true,
        outcome: 'REJECTED',
      });

      // Every step still outstanding is closed, so no later approver can
      // finalise a request that was already turned down.
      const closed = argOf<{
        where: Record<string, unknown>;
        data: { status: string };
      }>(prisma.requestApproval.updateMany);
      expect(closed.where).toMatchObject({
        requestType: 'LEAVE',
        requestId: 'request-1',
        status: { in: ['PENDING', 'ACTIVE'] },
      });
      expect(closed.data.status).toBe('SKIPPED');
    });

    it('waits for the siblings of a parallel chain', async () => {
      prisma.requestApproval.findMany.mockResolvedValue([
        activeSupervisorStep(),
        step({
          id: 'row-2',
          stepOrder: 2,
          approverType: ApproverType.HR_MANAGER,
          status: 'ACTIVE',
        }),
      ]);

      const result = await engine.decide(
        'LEAVE',
        'request-1',
        'employee-1',
        principal({ id: 'user-supervisor', role: UserRole.EMPLOYEE }),
        'APPROVE',
      );

      expect(result).toEqual({
        engaged: true,
        finalized: false,
        nextStepOrder: 2,
      });
      // No handover ran: the sibling is already live.
      expect(prisma.approvalWorkflow.findFirst).not.toHaveBeenCalled();
    });

    it('lets an administrator act on any step', async () => {
      prisma.requestApproval.findMany
        .mockResolvedValueOnce([activeSupervisorStep()])
        .mockResolvedValueOnce([]);
      prisma.approvalWorkflow.findFirst.mockResolvedValue(null);
      prisma.employee.findUnique.mockResolvedValue({
        id: 'employee-1',
        firstName: 'Rana',
        lastName: 'Said',
        departmentId: null,
        supervisorId: null,
        user: { id: 'user-requester' },
      });

      const result = await engine.decide(
        'LEAVE',
        'request-1',
        'employee-1',
        principal({ id: 'user-admin', role: UserRole.ADMIN }),
        'APPROVE',
      );

      expect(result.finalized).toBe(true);
    });

    it('reports no engagement when the request has no trail at all', async () => {
      prisma.requestApproval.findMany.mockResolvedValue([]);

      const result = await engine.decide(
        'LEAVE',
        'request-1',
        'employee-1',
        principal(),
        'APPROVE',
      );

      expect(result).toEqual({ engaged: false, finalized: false });
    });
  });

  describe('abandon', () => {
    it('closes every outstanding step so a withdrawn request cannot be decided', async () => {
      await engine.abandon('LEAVE', 'request-1');

      const closed = argOf<{
        where: Record<string, unknown>;
        data: { status: string; comment: string };
      }>(prisma.requestApproval.updateMany);
      expect(closed.where).toMatchObject({
        status: { in: ['PENDING', 'ACTIVE'] },
      });
      expect(closed.data.status).toBe('SKIPPED');
    });
  });

  describe('pendingForUser', () => {
    it('narrows a manager step to the departments they actually head', async () => {
      prisma.requestApproval.findMany.mockResolvedValue([
        step({
          id: 'row-1',
          stepOrder: 1,
          approverType: ApproverType.MANAGER,
          status: 'ACTIVE',
        }),
        {
          ...step({
            id: 'row-2',
            stepOrder: 1,
            approverType: ApproverType.MANAGER,
            status: 'ACTIVE',
          }),
          requestId: 'request-2',
        },
      ]);
      prisma.department.findMany.mockResolvedValue([{ id: 'department-1' }]);
      prisma.leaveRequest.findUnique
        .mockResolvedValueOnce({ employeeId: 'employee-1' })
        .mockResolvedValueOnce({ employeeId: 'employee-2' });
      prisma.employee.findUnique
        .mockResolvedValueOnce({ departmentId: 'department-1' })
        .mockResolvedValueOnce({ departmentId: 'department-2' });

      const queue = await engine.pendingForUser(
        principal({
          id: 'user-manager',
          role: UserRole.MANAGER,
          employeeId: 'employee-manager',
        }),
      );

      // Matching on role alone would have put the other department's request in
      // this manager's queue.
      expect(queue.map((row) => row.requestId)).toEqual(['request-1']);
    });

    it('gives an administrator every live step', async () => {
      const rows = [
        step({
          id: 'row-1',
          stepOrder: 1,
          approverType: ApproverType.SUPERVISOR,
          status: 'ACTIVE',
          resolvedApproverId: 'user-supervisor',
        }),
      ];
      prisma.requestApproval.findMany.mockResolvedValue(rows);

      const queue = await engine.pendingForUser(
        principal({ id: 'user-admin', role: UserRole.ADMIN }),
      );

      expect(queue).toEqual(rows);
    });
  });

  describe('canApprove', () => {
    it('excludes an administrator, who acts from the domain screens instead', async () => {
      const result = await engine.canApprove(
        principal({ id: 'user-admin', role: UserRole.ADMIN }),
      );

      expect(result).toEqual({ isApprover: false, pending: 0 });
      expect(prisma.requestApproval.findMany).not.toHaveBeenCalled();
    });

    it('stays true for a supervisor with an empty inbox', async () => {
      prisma.requestApproval.findMany.mockResolvedValue([]);
      prisma.approvalWorkflow.findMany.mockResolvedValue([
        { steps: [{ approverType: ApproverType.SUPERVISOR }] },
      ]);
      prisma.employee.count.mockResolvedValue(3);

      const result = await engine.canApprove(
        principal({
          id: 'user-supervisor',
          role: UserRole.EMPLOYEE,
          employeeId: 'employee-sup',
        }),
      );

      // Navigation visibility must not flicker with the queue depth.
      expect(result).toEqual({ isApprover: true, pending: 0 });
    });
  });
});
