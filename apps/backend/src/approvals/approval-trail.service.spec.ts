import { Test } from '@nestjs/testing';
import { ApprovalEngineService } from './approval-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';

/**
 * `trailFor` and the approver queue for the real-world chain that stalled:
 * OVERTIME, SEQUENTIAL, SUPERVISOR → MANAGER → HR_MANAGER.
 *
 * The reported bug: the supervisor accepted, the request sat at the MANAGER
 * step forever, and the detail screen offered Approve/Reject only to
 * ADMIN/HR_MANAGER — so the department manager who *was* the live approver had
 * no way to act, while an admin pressing Approve saw a success toast and a
 * request still marked Pending.
 *
 * `trailFor(...).canAct` is the contract that fixes it: it answers "may THIS
 * user decide the live step" using the exact eligibility rule `decide()`
 * enforces, so a screen gating its buttons on it can never diverge from what
 * the API will accept.
 */
describe('ApprovalEngineService — trail, canAct & approver queue', () => {
  const REQUEST_ID = 'ot-1';
  const EMPLOYEE_ID = 'emp-ravi';

  // The chain's cast. The supervisor is deliberately a plain EMPLOYEE-role user
  // and the manager a MANAGER who heads the requester's department — neither is
  // an "approver role" in the legacy sense.
  const SUPERVISOR = { id: 'u-sup', role: 'EMPLOYEE', employeeId: 'emp-prem' };
  const MANAGER = { id: 'u-mgr', role: 'MANAGER', employeeId: 'emp-tarakesh' };
  const OTHER_MANAGER = { id: 'u-mgr2', role: 'MANAGER', employeeId: 'emp-other' };
  const HR = { id: 'u-hr', role: 'HR_MANAGER', employeeId: 'emp-hr' };
  const ADMIN = { id: 'u-admin', role: 'ADMIN' };

  let engine: ApprovalEngineService;
  let rows: any[];

  const matches = (row: any, where: any) =>
    (where.requestId === undefined || row.requestId === where.requestId) &&
    (where.status === undefined ||
      (typeof where.status === 'string'
        ? row.status === where.status
        : where.status.in.includes(row.status))) &&
    (where.stepOrder?.gte === undefined || row.stepOrder >= where.stepOrder.gte);

  const prisma: any = {
    systemSetting: { findUnique: jest.fn().mockResolvedValue({ value: 'true' }) },
    approvalWorkflow: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'wf-ot',
          mode: 'SEQUENTIAL',
          steps: [
            { stepOrder: 1, approverType: 'SUPERVISOR' },
            { stepOrder: 2, approverType: 'MANAGER' },
            { stepOrder: 3, approverType: 'HR_MANAGER' },
          ],
        }),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    // Only MANAGER heads the requester's department.
    department: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          where.managerId === MANAGER.employeeId ? [{ id: 'dep-eng' }] : [],
        ),
      ),
    },
    employee: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue({
        id: EMPLOYEE_ID,
        fullName: 'Ravi',
        departmentId: 'dep-eng',
        supervisorId: SUPERVISOR.employeeId,
        user: { id: 'u-ravi' },
        supervisor: { user: { id: SUPERVISOR.id } },
        department: { manager: { user: { id: MANAGER.id } } },
      }),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ id: HR.id }]) },
    overtimeRequest: {
      findUnique: jest.fn().mockResolvedValue({ employeeId: EMPLOYEE_ID }),
    },
    leaveRequest: { findUnique: jest.fn().mockResolvedValue(null) },
    bankChangeRequest: { findUnique: jest.fn().mockResolvedValue(null) },
    requestApproval: {
      createMany: jest.fn(({ data }: any) => {
        data.forEach((d: any, i: number) =>
          rows.push({ id: `row-${d.stepOrder}-${i}`, resolvedApproverId: null, ...d }),
        );
        return Promise.resolve({ count: data.length });
      }),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          rows
            .filter((r) => matches(r, where ?? {}))
            .sort((a, b) => a.stepOrder - b.stepOrder),
        ),
      ),
      update: jest.fn(({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
      updateMany: jest.fn(({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return Promise.resolve({ count: hit.length });
      }),
    },
  };

  beforeEach(async () => {
    rows = [];
    const moduleRef = await Test.createTestingModule({
      providers: [
        ApprovalEngineService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: NotificationsService,
          useValue: {
            notifyUsers: jest.fn().mockResolvedValue(undefined),
            notifyUser: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    engine = moduleRef.get(ApprovalEngineService);
    await engine.initiate('OVERTIME', REQUEST_ID, EMPLOYEE_ID);
  });

  const trail = (user: any) => engine.trailFor('OVERTIME', REQUEST_ID, user);

  describe('canAct tracks the live step, not the caller role', () => {
    it('at step 1 only the supervisor (and ADMIN) may act', async () => {
      expect(await trail(SUPERVISOR)).toMatchObject({ engaged: true, activeStep: 1, canAct: true });
      expect((await trail(ADMIN)).canAct).toBe(true);
      expect((await trail(MANAGER)).canAct).toBe(false);
      expect((await trail(HR)).canAct).toBe(false);
    });

    it('after the supervisor approves, the DEPARTMENT MANAGER may act', async () => {
      await engine.decide('OVERTIME', REQUEST_ID, EMPLOYEE_ID, SUPERVISOR, 'APPROVE');

      const asManager = await trail(MANAGER);
      expect(asManager.activeStep).toBe(2);
      // The regression: this was false everywhere the UI asked "is the caller
      // ADMIN or HR?", stranding the request at step 2 forever.
      expect(asManager.canAct).toBe(true);

      // The supervisor already acted on step 1, so they remain a participant and
      // may still follow the request — they simply cannot act again.
      expect((await trail(SUPERVISOR)).canAct).toBe(false);
      expect((await trail(HR)).canAct).toBe(false);

      // A manager of an UNRELATED department is not a participant and does not
      // manage this employee, so the trail is no longer readable to them at all.
      // It used to answer `canAct: false`, which meant any authenticated user
      // could read who decided what, and when, by walking request ids.
      await expect(trail(OTHER_MANAGER)).rejects.toThrow(
        /outside your department/,
      );
    });

    it('the whole SUPERVISOR → MANAGER → HR chain reaches APPROVED', async () => {
      const s1 = await engine.decide('OVERTIME', REQUEST_ID, EMPLOYEE_ID, SUPERVISOR, 'APPROVE');
      expect(s1).toMatchObject({ finalized: false, nextStepOrder: 2 });

      const s2 = await engine.decide('OVERTIME', REQUEST_ID, EMPLOYEE_ID, MANAGER, 'APPROVE');
      expect(s2).toMatchObject({ finalized: false, nextStepOrder: 3 });

      const s3 = await engine.decide('OVERTIME', REQUEST_ID, EMPLOYEE_ID, HR, 'APPROVE');
      expect(s3).toMatchObject({ finalized: true, outcome: 'APPROVED' });

      const finished = await trail(ADMIN);
      expect(finished.activeStep).toBeNull();
      expect(finished.canAct).toBe(false);
      expect(finished.steps.map((s) => s.status)).toEqual([
        'APPROVED',
        'APPROVED',
        'APPROVED',
      ]);
    });

    it('a manager who does not head the department is refused by decide() too', async () => {
      await engine.decide('OVERTIME', REQUEST_ID, EMPLOYEE_ID, SUPERVISOR, 'APPROVE');
      await expect(
        engine.decide('OVERTIME', REQUEST_ID, EMPLOYEE_ID, OTHER_MANAGER, 'APPROVE'),
      ).rejects.toThrow('not an eligible approver');
    });

    it('an ungoverned request reports engaged:false so callers keep legacy rules', async () => {
      const res = await engine.trailFor('OVERTIME', 'no-chain-here', HR);
      expect(res).toEqual({ engaged: false, steps: [], activeStep: null, canAct: false });
    });
  });

  describe('the approver queue is scoped, not role-wide', () => {
    beforeEach(async () => {
      await engine.decide('OVERTIME', REQUEST_ID, EMPLOYEE_ID, SUPERVISOR, 'APPROVE');
    });

    it('the department head sees the live MANAGER step', async () => {
      const queue = await engine.pendingForUser(MANAGER);
      expect(queue.map((r) => r.stepOrder)).toEqual([2]);
    });

    it('a manager of another department does NOT see it', async () => {
      // Regression: matching on `approverType === user.role` alone put every
      // department's requests in every manager's queue.
      expect(await engine.pendingForUser(OTHER_MANAGER)).toEqual([]);
    });

    it('ADMIN still sees everything', async () => {
      expect((await engine.pendingForUser(ADMIN)).length).toBe(1);
    });

    it('HR sees nothing until its own step goes live', async () => {
      expect(await engine.pendingForUser(HR)).toEqual([]);
      await engine.decide('OVERTIME', REQUEST_ID, EMPLOYEE_ID, MANAGER, 'APPROVE');
      expect((await engine.pendingForUser(HR)).map((r) => r.stepOrder)).toEqual([3]);
    });
  });
});
