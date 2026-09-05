import { Test } from '@nestjs/testing';
import { ApprovalEngineService } from './approval-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';

/**
 * The approver's record of what they have already decided.
 *
 * The inbox is a QUEUE — a row leaves it the instant it is acted on, which is
 * right for "what still needs me" and wrong for "what did I decide". An
 * approver who approved something watched the card vanish, taking with it any
 * trace of the correction they made on the way through.
 *
 * Two things this pins, both of which are silent when wrong:
 *
 *   1. History hydrates with `anyStatus`. Every row in it is decided by
 *      definition, so hydrating pending-only — which is what the inbox does —
 *      returns nothing and the screen reads as permanently empty.
 *   2. It is keyed on `decidedById`, not on current eligibility. A supervisor's
 *      record must survive them later losing the step that let them act.
 */
describe('ApprovalEngineService — decided history', () => {
  const USER = { id: 'u-sup', role: 'EMPLOYEE' };

  let engine: ApprovalEngineService;
  let prisma: any;
  let approvalRows: any[];

  const row = (over: Record<string, unknown> = {}) => ({
    requestType: 'OVERTIME',
    requestId: 'ot-1',
    stepOrder: 1,
    approverType: 'SUPERVISOR',
    status: 'APPROVED',
    decidedById: USER.id,
    decidedAt: new Date('2026-08-20T12:00:00Z'),
    comment: null,
    ...over,
  });

  beforeEach(async () => {
    approvalRows = [row()];
    prisma = {
      systemSetting: { findUnique: jest.fn().mockResolvedValue({ value: 'true' }) },
      requestApproval: {
        findMany: jest.fn(({ where }: any) =>
          Promise.resolve(
            approvalRows.filter(
              (r) =>
                r.decidedById === where.decidedById &&
                where.status.in.includes(r.status),
            ),
          ),
        ),
      },
      overtimeRequest: {
        findMany: jest.fn(({ where }: any) =>
          Promise.resolve(
            // The real delegate applies the status filter the registry built,
            // so a pending-only hydrate genuinely returns nothing here.
            [
              {
                id: 'ot-1',
                status: 'APPROVED',
                hours: '3.5',
                siteAllowance: '25',
                employee: { id: 'emp-1', fullName: 'Priya R' },
              },
            ].filter(
              (r) =>
                where.id.in.includes(r.id) &&
                (where.status === undefined || where.status === r.status),
            ),
          ),
        ),
        findUnique: jest
          .fn()
          .mockResolvedValue({ employeeId: 'emp-1' }),
      },
      employee: { findUnique: jest.fn().mockResolvedValue({ branchId: null }) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ApprovalEngineService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: NotificationsService,
          useValue: { notifyUsers: jest.fn(), notifyUser: jest.fn() },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    engine = moduleRef.get(ApprovalEngineService);
  });

  it('returns a decided request, hydrated despite not being PENDING', async () => {
    const res = await engine.historyForUser(USER);

    expect(res.data).toHaveLength(1);
    const item: any = res.data[0];
    expect(item.requestId).toBe('ot-1');
    expect(item.request.status).toBe('APPROVED');
    // The correction the approver made is part of the record they keep.
    expect(item.request.siteAllowance).toBe('25');

    // Proved at the query, not only at the result: a pending-only hydrate is
    // the single change that would empty this screen.
    const where = prisma.overtimeRequest.findMany.mock.calls[0][0].where;
    expect(where.status).toBeUndefined();
  });

  it('reports what THIS user did, which is not the request’s final status', async () => {
    approvalRows = [row({ status: 'REJECTED' })];

    const item: any = (await engine.historyForUser(USER)).data[0];

    expect(item.decision).toBe('REJECTED');
    expect(item.decidedAt).toEqual(new Date('2026-08-20T12:00:00Z'));
  });

  it('carries the step that routed the request to them', async () => {
    approvalRows = [row({ stepOrder: 2, approverType: 'HR_MANAGER' })];

    const item: any = (await engine.historyForUser(USER)).data[0];

    expect(item.stepOrder).toBe(2);
    expect(item.approverType).toBe('HR_MANAGER');
  });

  it('never returns another approver’s decisions', async () => {
    approvalRows = [row({ decidedById: 'u-someone-else' })];

    expect((await engine.historyForUser(USER)).data).toEqual([]);
  });

  it('omits steps that are still open — those belong to the inbox', async () => {
    approvalRows = [row({ status: 'ACTIVE', decidedAt: null })];

    expect((await engine.historyForUser(USER)).data).toEqual([]);
  });

  it('drops a row whose request has since been deleted', async () => {
    prisma.overtimeRequest.findMany.mockResolvedValue([]);

    expect((await engine.historyForUser(USER)).data).toEqual([]);
  });

  it('answers empty for a caller with no user', async () => {
    expect((await engine.historyForUser(null)).data).toEqual([]);
    expect(prisma.requestApproval.findMany).not.toHaveBeenCalled();
  });

  it('clamps the page size rather than trusting the query string', async () => {
    await engine.historyForUser(USER, 10_000);
    expect(prisma.requestApproval.findMany.mock.calls[0][0].take).toBe(200);

    await engine.historyForUser(USER, -5);
    expect(prisma.requestApproval.findMany.mock.calls[1][0].take).toBe(1);
  });

  it('orders newest first', async () => {
    await engine.historyForUser(USER);
    expect(prisma.requestApproval.findMany.mock.calls[0][0].orderBy).toEqual({
      decidedAt: 'desc',
    });
  });
});
