import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer } from './utils/settings';

/**
 * The notification log — dedupe, delivery state and retry.
 *
 * `AdvanceLoanNotificationLog` shipped with a purpose-built unique index
 * (`requestId, event, periodKey, recipientUserId, channel`) and the only
 * reference to it in the whole backend was the branch-scope map. Nothing wrote
 * a row, so duplicates could not be detected, a failed send left no trace, and
 * there was nothing to retry.
 *
 * These cases prove the log over HTTP, where the unique index is real — the
 * unit spec models it, but only the database enforces it.
 */
describe('Finance — loan notification log (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any): any => res.body?.data ?? res.body;

  const expectStatus = (res: any, expected: number | number[], label = '') => {
    const want = Array.isArray(expected) ? expected : [expected];
    if (!want.includes(res.status)) {
      throw new Error(
        `${label ? `${label} — ` : ''}expected ${want.join(' or ')}, got ${res.status}: ${body(res)}`,
      );
    }
  };

  const purge = async () => {
    const ids = (
      await ctx.prisma.advanceLoanRequest.findMany({
        where: { employeeId: fx.earnerId },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (!ids.length) return;
    const where = { requestId: { in: ids } };
    await ctx.prisma.advanceLoanNotificationLog.deleteMany({ where });
    await ctx.prisma.loanTransaction.deleteMany({ where });
    await ctx.prisma.loanRateChange.deleteMany({ where });
    await ctx.prisma.advanceLoanDeduction.deleteMany({ where });
    await ctx.prisma.advanceLoanAttachment.deleteMany({ where });
    await ctx.prisma.loanSchedule.deleteMany({ where });
    await ctx.prisma.advanceLoanRequest.deleteMany({ where: { id: { in: ids } } });
  };

  const file = (payload: Record<string, unknown>) =>
    ctx.http().post('/advance-loans').set(bearer(fx.employee.token)).send(payload);

  const logsFor = (requestId: string) =>
    ctx.prisma.advanceLoanNotificationLog.findMany({ where: { requestId } });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  });

  afterEach(purge);

  afterAll(async () => {
    await purge();
    await fx.cleanup();
    await ctx.app.close();
  });

  describe('what gets recorded', () => {
    it('logs the approver fan-out when a request is filed', async () => {
      const res = await file({ type: 'ADVANCE', amount: 200 });
      expectStatus(res, 201);

      const logs = await logsFor(dataOf(res).id);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.every((l) => l.event === 'LOAN_SUBMITTED')).toBe(true);
      expect(logs.every((l) => l.status === 'SENT')).toBe(true);
      expect(logs.every((l) => l.sentAt !== null)).toBe(true);
      expect(logs.every((l) => l.attempts === 1)).toBe(true);
    });

    it('logs the decision against the requester', async () => {
      const filed = await file({ type: 'ADVANCE', amount: 200 });
      expectStatus(filed, 201);
      const id = dataOf(filed).id;

      const approved = await ctx
        .http()
        .post(`/advance-loans/${id}/approve`)
        .set(bearer(fx.hrGlobal.token))
        .send({});
      expectStatus(approved, [200, 201]);

      const logs = await logsFor(id);
      expect(logs.some((l) => l.event === 'LOAN_APPROVED')).toBe(true);
    });

    it('records an approval and a rejection as different events', async () => {
      // One shared event name would let the first decision dedupe the second
      // away on a re-filed request.
      const a = await file({ type: 'ADVANCE', amount: 200 });
      await ctx
        .http()
        .post(`/advance-loans/${dataOf(a).id}/approve`)
        .set(bearer(fx.hrGlobal.token))
        .send({});

      const b = await file({ type: 'ADVANCE', amount: 200 });
      await ctx
        .http()
        .post(`/advance-loans/${dataOf(b).id}/reject`)
        .set(bearer(fx.hrGlobal.token))
        .send({ remarks: 'Outside policy' });

      const logsA = await logsFor(dataOf(a).id);
      const logsB = await logsFor(dataOf(b).id);
      expect(logsA.some((l) => l.event === 'LOAN_APPROVED')).toBe(true);
      expect(logsB.some((l) => l.event === 'LOAN_REJECTED')).toBe(true);
    });

    it('records a lifecycle operation, and records a REPEAT of it too', async () => {
      // Two prepayments are two events: the borrower must hear about both, so
      // the log carries them without collapsing them.
      const filed = await file({ type: 'LOAN', amount: 1000, installments: 5 });
      const id = dataOf(filed).id;
      await ctx
        .http()
        .post(`/advance-loans/${id}/approve`)
        .set(bearer(fx.hrGlobal.token))
        .send({});

      for (const amount of [100, 150]) {
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/prepay`)
          .set(bearer(fx.hrGlobal.token))
          .send({ amount, mode: 'CASH' });
        expectStatus(res, [200, 201], `prepay ${amount}`);
      }

      const logs = await logsFor(id);
      const prepayments = logs.filter((l) => l.event.includes('PREPAYMENT'));
      expect(prepayments.length).toBe(2);
    });
  });

  describe('the dedupe index does its job', () => {
    it('refuses a second identical notice at the database level', async () => {
      // Written directly, because the point is the INDEX, not any call path.
      const filed = await file({ type: 'ADVANCE', amount: 200 });
      const requestId = dataOf(filed).id;

      const row = {
        requestId,
        event: 'EMI_DEDUCTED',
        periodKey: '2026-08',
        recipientUserId: fx.employee.userId,
        channel: 'IN_APP',
        status: 'SENT',
      };
      await ctx.prisma.advanceLoanNotificationLog.create({ data: row });

      await expect(
        ctx.prisma.advanceLoanNotificationLog.create({ data: row }),
      ).rejects.toThrow();
    });

    it('allows the same event in the next period', async () => {
      const filed = await file({ type: 'ADVANCE', amount: 200 });
      const requestId = dataOf(filed).id;

      for (const periodKey of ['2026-08', '2026-09']) {
        await ctx.prisma.advanceLoanNotificationLog.create({
          data: {
            requestId,
            event: 'EMI_DEDUCTED',
            periodKey,
            recipientUserId: fx.employee.userId,
            channel: 'IN_APP',
            status: 'SENT',
          },
        });
      }

      const logs = await logsFor(requestId);
      expect(logs.filter((l) => l.event === 'EMI_DEDUCTED').length).toBe(2);
    });

    it('allows the same event on a different channel', async () => {
      const filed = await file({ type: 'ADVANCE', amount: 200 });
      const requestId = dataOf(filed).id;

      for (const channel of ['IN_APP', 'EMAIL']) {
        await ctx.prisma.advanceLoanNotificationLog.create({
          data: {
            requestId,
            event: 'LOAN_APPROVED',
            periodKey: '',
            recipientUserId: fx.employee.userId,
            channel,
            status: 'SENT',
          },
        });
      }

      const logs = await logsFor(requestId);
      expect(logs.filter((l) => l.event === 'LOAN_APPROVED').length).toBe(2);
    });
  });

  describe('the history endpoint', () => {
    it('shows what was sent about a loan, newest first', async () => {
      const filed = await file({ type: 'ADVANCE', amount: 200 });
      const id = dataOf(filed).id;

      const res = await ctx
        .http()
        .get(`/advance-loans/${id}/notifications`)
        .set(bearer(fx.hrGlobal.token));
      expectStatus(res, 200);
      expect(Array.isArray(dataOf(res))).toBe(true);
      expect(dataOf(res).length).toBeGreaterThan(0);
    });

    it.each([
      ['manager', () => fx.manager.token],
      ['employee', () => fx.employee.token],
    ])('refuses %s — who was told what is an administrative view', async (_who, token) => {
      const filed = await file({ type: 'ADVANCE', amount: 200 });
      const res = await ctx
        .http()
        .get(`/advance-loans/${dataOf(filed).id}/notifications`)
        .set(bearer(token()));
      expectStatus(res, 403);
    });
  });

  describe('retrying what failed', () => {
    it('drains FAILED rows and marks them sent', async () => {
      const filed = await file({ type: 'ADVANCE', amount: 200 });
      const requestId = dataOf(filed).id;

      await ctx.prisma.advanceLoanNotificationLog.create({
        data: {
          requestId,
          event: 'EMI_DEDUCTED',
          periodKey: '2026-07',
          recipientUserId: fx.employee.userId,
          channel: 'IN_APP',
          status: 'FAILED',
          attempts: 1,
          lastError: 'transient',
        },
      });

      const res = await ctx
        .http()
        .post('/advance-loans/notifications/retry')
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(res, 200);
      expect(dataOf(res).sent).toBeGreaterThan(0);

      const after = await ctx.prisma.advanceLoanNotificationLog.findFirst({
        where: { requestId, event: 'EMI_DEDUCTED' },
      });
      expect(after!.status).toBe('SENT');
      expect(after!.attempts).toBe(2);
    });

    it('leaves a row that has already exhausted its attempts', async () => {
      const filed = await file({ type: 'ADVANCE', amount: 200 });
      const requestId = dataOf(filed).id;

      await ctx.prisma.advanceLoanNotificationLog.create({
        data: {
          requestId,
          event: 'EMI_DEDUCTED',
          periodKey: '2026-06',
          recipientUserId: fx.employee.userId,
          channel: 'IN_APP',
          status: 'FAILED',
          attempts: 5,
          lastError: 'mailbox does not exist',
        },
      });

      await ctx
        .http()
        .post('/advance-loans/notifications/retry')
        .set(bearer(fx.admin.token))
        .send({});

      const after = await ctx.prisma.advanceLoanNotificationLog.findFirst({
        where: { requestId, event: 'EMI_DEDUCTED' },
      });
      expect(after!.status).toBe('FAILED');
      expect(after!.attempts).toBe(5);
      // The reason survives for whoever investigates.
      expect(after!.lastError).toContain('mailbox');
    });

    it.each([
      ['hrGlobal', () => fx.hrGlobal.token],
      ['employee', () => fx.employee.token],
    ])('refuses %s — draining the queue is an admin act', async (_who, token) => {
      const res = await ctx
        .http()
        .post('/advance-loans/notifications/retry')
        .set(bearer(token()))
        .send({});
      expectStatus(res, 403);
    });
  });
});
