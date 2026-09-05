import { Test } from '@nestjs/testing';
import { ApprovalEngineService } from './approval-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';

/**
 * Covers the per-workflow activation mode: SEQUENTIAL hands the request to one
 * role at a time (step N+1 only after step N accepts), PARALLEL opens every
 * step at once and finalizes on the last approval.
 */
describe('ApprovalEngineService — activation modes', () => {
  const REQUEST_ID = 'req-1';
  const EMPLOYEE_ID = 'emp-1';

  let engine: ApprovalEngineService;
  let rows: any[];
  let mode: 'SEQUENTIAL' | 'PARALLEL';

  const matches = (row: any, where: any) =>
    (where.requestId === undefined || row.requestId === where.requestId) &&
    (where.status === undefined ||
      (typeof where.status === 'string'
        ? row.status === where.status
        : where.status.in.includes(row.status))) &&
    (where.stepOrder?.gte === undefined || row.stepOrder >= where.stepOrder.gte);

  const prisma = {
    systemSetting: {
      findUnique: jest.fn().mockResolvedValue({ value: 'true' }),
    },
    approvalWorkflow: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'wf-1',
          mode,
          steps: [
            { stepOrder: 1, approverType: 'SUPERVISOR' },
            { stepOrder: 2, approverType: 'HR_MANAGER' },
          ],
        }),
      ),
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            id: 'wf-1',
            mode,
            steps: [
              { stepOrder: 1, approverType: 'SUPERVISOR' },
              { stepOrder: 2, approverType: 'HR_MANAGER' },
            ],
          },
        ]),
      ),
    },
    department: { count: jest.fn().mockResolvedValue(0) },
    employee: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue({
        id: EMPLOYEE_ID,
        fullName: 'Asha',
        departmentId: 'dep-1',
        supervisorId: 'emp-sup',
        user: { id: 'u-emp' },
        supervisor: { user: { id: 'u-sup' } },
        department: { manager: { user: { id: 'u-mgr' } } },
      }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([{ id: 'u-hr' }]),
    },
    requestApproval: {
      createMany: jest.fn(({ data }: any) => {
        data.forEach((d: any, i: number) =>
          rows.push({ id: `row-${d.stepOrder}-${i}`, resolvedApproverId: null, ...d }),
        );
        return Promise.resolve({ count: data.length });
      }),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          rows.filter((r) => matches(r, where)).sort((a, b) => a.stepOrder - b.stepOrder),
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

  const notifications = {
    notifyUsers: jest.fn().mockResolvedValue(undefined),
    notifyUser: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    rows = [];
    mode = 'SEQUENTIAL';
    const moduleRef = await Test.createTestingModule({
      providers: [
        ApprovalEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    engine = moduleRef.get(ApprovalEngineService);
  });

  const statuses = () =>
    rows.sort((a, b) => a.stepOrder - b.stepOrder).map((r) => r.status);

  it('SEQUENTIAL: step 2 stays untouched until step 1 approves', async () => {
    const init = await engine.initiate('LEAVE', REQUEST_ID, EMPLOYEE_ID);
    expect(init).toMatchObject({ engaged: true, finalized: false, nextStepOrder: 1 });
    expect(statuses()).toEqual(['ACTIVE', 'PENDING']);

    // The HR approver cannot jump the queue while step 1 is outstanding.
    await expect(
      engine.decide('LEAVE', REQUEST_ID, EMPLOYEE_ID, { id: 'u-hr', role: 'HR_MANAGER' }, 'APPROVE'),
    ).rejects.toThrow('not an eligible approver');

    const first = await engine.decide(
      'LEAVE',
      REQUEST_ID,
      EMPLOYEE_ID,
      { id: 'u-sup', role: 'EMPLOYEE' },
      'APPROVE',
    );
    expect(first).toMatchObject({ finalized: false, nextStepOrder: 2 });
    expect(statuses()).toEqual(['APPROVED', 'ACTIVE']);

    const second = await engine.decide(
      'LEAVE',
      REQUEST_ID,
      EMPLOYEE_ID,
      { id: 'u-hr', role: 'HR_MANAGER' },
      'APPROVE',
    );
    expect(second).toMatchObject({ finalized: true, outcome: 'APPROVED' });
  });

  it('PARALLEL: both steps open at once and the last approval finalizes', async () => {
    mode = 'PARALLEL';
    await engine.initiate('LEAVE', REQUEST_ID, EMPLOYEE_ID);
    expect(statuses()).toEqual(['ACTIVE', 'ACTIVE']);

    const hrFirst = await engine.decide(
      'LEAVE',
      REQUEST_ID,
      EMPLOYEE_ID,
      { id: 'u-hr', role: 'HR_MANAGER' },
      'APPROVE',
    );
    expect(hrFirst).toMatchObject({ finalized: false, nextStepOrder: 1 });

    const supLast = await engine.decide(
      'LEAVE',
      REQUEST_ID,
      EMPLOYEE_ID,
      { id: 'u-sup', role: 'EMPLOYEE' },
      'APPROVE',
    );
    expect(supLast).toMatchObject({ finalized: true, outcome: 'APPROVED' });
  });

  describe('canApprove — drives "Approvals" nav visibility', () => {
    it('is true for an HR manager named in a chain, with an empty inbox', async () => {
      await expect(
        engine.canApprove({ id: 'u-hr', role: 'HR_MANAGER', employeeId: 'emp-hr' }),
      ).resolves.toEqual({ isApprover: true, pending: 0 });
    });

    it('is true for an employee who supervises someone', async () => {
      prisma.employee.count.mockResolvedValueOnce(2);
      await expect(
        engine.canApprove({ id: 'u-sup', role: 'EMPLOYEE', employeeId: 'emp-sup' }),
      ).resolves.toMatchObject({ isApprover: true });
    });

    it('is false for ADMIN even with live steps — they override elsewhere', async () => {
      mode = 'PARALLEL';
      await engine.initiate('LEAVE', REQUEST_ID, EMPLOYEE_ID);
      await expect(
        engine.canApprove({ id: 'u-admin', role: 'ADMIN', employeeId: 'emp-admin' }),
      ).resolves.toEqual({ isApprover: false, pending: 0 });
    });

    it('is false for a plain employee in no chain', async () => {
      await expect(
        engine.canApprove({ id: 'u-emp', role: 'EMPLOYEE', employeeId: EMPLOYEE_ID }),
      ).resolves.toEqual({ isApprover: false, pending: 0 });
    });
  });

  it('a rejection closes every outstanding step', async () => {
    mode = 'PARALLEL';
    await engine.initiate('LEAVE', REQUEST_ID, EMPLOYEE_ID);

    const res = await engine.decide(
      'LEAVE',
      REQUEST_ID,
      EMPLOYEE_ID,
      { id: 'u-hr', role: 'HR_MANAGER' },
      'REJECT',
      'no budget',
    );
    expect(res).toMatchObject({ finalized: true, outcome: 'REJECTED' });
    expect(statuses()).toEqual(['SKIPPED', 'REJECTED']);
  });
});
