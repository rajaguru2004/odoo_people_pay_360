import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * Editing, drafting, disbursing — and the second signature on a restructure.
 *
 * Four gaps meet here, and all four were the same shape: a state the product
 * describes and cannot reach.
 *
 *  - **No edit route existed at all.** A submitted request could not be
 *    corrected by anyone, so a typo'd amount meant cancel and re-file — losing
 *    the queue position, the attachments and the audit thread.
 *  - **`DRAFT` was rendered and filterable** by the list screen while nothing
 *    could create one.
 *  - **`DISBURSED` was in the status list and the database CHECK constraint**
 *    and written by nothing, so "approved but not yet paid out" — the state a
 *    finance team lives in — could not be expressed.
 *  - **`loan_restructure_requires_approval` was seeded and read by nothing**, so
 *    one person could reshape an agreed repayment plan alone.
 */
describe('Finance — loan edit, draft, disbursement (e2e)', () => {
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

  const file = (payload: Record<string, unknown>, token = fx.employee.token) =>
    ctx.http().post('/advance-loans').set(bearer(token)).send(payload);

  const patch = (id: string, payload: Record<string, unknown>, token = fx.employee.token) =>
    ctx.http().patch(`/advance-loans/${id}`).set(bearer(token)).send(payload);

  const approve = (id: string, payload: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post(`/advance-loans/${id}/approve`)
      .set(bearer(fx.hrGlobal.token))
      .send(payload);

  const rowOf = (id: string) =>
    ctx.prisma.advanceLoanRequest.findUnique({ where: { id } });

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

  // ── Drafts ────────────────────────────────────────────────────────────────

  describe('a draft is a request nobody has been asked about yet', () => {
    it('is created as DRAFT and notifies nobody', async () => {
      const res = await file({ type: 'ADVANCE', amount: 200, draft: true });
      expectStatus(res, 201);
      expect(dataOf(res).status).toBe('DRAFT');

      const logs = await ctx.prisma.advanceLoanNotificationLog.findMany({
        where: { requestId: dataOf(res).id },
      });
      expect(logs).toHaveLength(0);
    });

    it('becomes PENDING on submit, and the approvers hear about it then', async () => {
      const draft = await file({ type: 'ADVANCE', amount: 200, draft: true });
      const id = dataOf(draft).id;

      const res = await ctx
        .http()
        .post(`/advance-loans/${id}/submit`)
        .set(bearer(fx.employee.token))
        .send({});
      expectStatus(res, 200);
      expect(dataOf(res).status).toBe('PENDING');

      const logs = await ctx.prisma.advanceLoanNotificationLog.findMany({
        where: { requestId: id },
      });
      expect(logs.length).toBeGreaterThan(0);
    });

    it('is re-checked at submit, not only when it was written', async () => {
      // A draft may sit for weeks. The rules it passed then are not the rules
      // it is judged by now.
      const draft = await file({ type: 'LOAN', amount: 600, installments: 6, draft: true });
      const id = dataOf(draft).id;

      await withSetting(ctx, 'advance_loan_enabled', 'false', async () => {
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/submit`)
          .set(bearer(fx.employee.token))
          .send({});
        expectStatus(res, 400);
      });
    });

    it('cannot be submitted twice', async () => {
      const draft = await file({ type: 'ADVANCE', amount: 200, draft: true });
      const id = dataOf(draft).id;

      await ctx
        .http()
        .post(`/advance-loans/${id}/submit`)
        .set(bearer(fx.employee.token))
        .send({});
      const second = await ctx
        .http()
        .post(`/advance-loans/${id}/submit`)
        .set(bearer(fx.employee.token))
        .send({});
      expectStatus(second, [400, 409]);
    });

    it('refuses to submit somebody else’s draft', async () => {
      const draft = await file({ type: 'ADVANCE', amount: 200, draft: true });
      const res = await ctx
        .http()
        .post(`/advance-loans/${dataOf(draft).id}/submit`)
        .set(bearer(fx.manager.token))
        .send({});
      expectStatus(res, [403, 404]);
    });
  });

  // ── Editing ───────────────────────────────────────────────────────────────

  describe('editing a request that nobody has decided yet', () => {
    it('changes the amount and the term', async () => {
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });
      const id = dataOf(filed).id;

      const res = await patch(id, { amount: 900, installments: 9 });
      expectStatus(res, 200);

      const row = await rowOf(id);
      expect(Number(row!.amount)).toBe(900);
      expect(row!.installments).toBe(9);
    });

    it('re-runs the same eligibility gate the create path uses', async () => {
      // Otherwise editing is a way to reach an amount that could not be filed.
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });

      await withSetting(ctx, 'loan_max_amount_multiple_of_salary', '1', async () => {
        const res = await patch(dataOf(filed).id, { amount: 999999 });
        expectStatus(res, 400);
      });
    });

    it('lets the owner edit and refuses a colleague', async () => {
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });
      const res = await patch(dataOf(filed).id, { reason: 'Nosy' }, fx.foreignEmployee.token);
      expectStatus(res, [403, 404]);
    });

    it('refuses to change the recovery priority as the requester', async () => {
      // Which debt yields to which is the employer's call.
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });
      const res = await patch(dataOf(filed).id, { priority: 1 });
      expectStatus(res, 403);
    });

    it('lets HR change the priority', async () => {
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });
      const res = await patch(
        dataOf(filed).id,
        { priority: 10 },
        fx.hrGlobal.token,
      );
      expectStatus(res, 200);
      expect((await rowOf(dataOf(filed).id))!.priority).toBe(10);
    });

    it('tells the loser when two people edit at once, instead of silently overwriting', async () => {
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });
      const id = dataOf(filed).id;
      const before = (await rowOf(id))!.updatedAt.toISOString();

      const first = await patch(id, { reason: 'First writer' });
      expectStatus(first, 200);

      const second = await patch(id, {
        reason: 'Second writer, working from a stale copy',
        expectedUpdatedAt: before,
      });
      expectStatus(second, 409);
      expect(body(second)).toMatch(/changed by somebody else/i);
    });

    it('refuses an empty edit rather than pretending something happened', async () => {
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });
      const res = await patch(dataOf(filed).id, {});
      expectStatus(res, 400);
    });
  });

  describe('editing a loan somebody has already agreed to', () => {
    const liveLoan = async () => {
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });
      const id = dataOf(filed).id;
      expectStatus(await approve(id), [200, 201]);
      return id;
    };

    it('refuses to change a term, and says what to do instead', async () => {
      const id = await liveLoan();
      const res = await patch(id, { amount: 900 }, fx.hrGlobal.token);
      expectStatus(res, 400);
      expect(body(res)).toMatch(/restructure/i);
    });

    it('allows the reason, but only with a reason for the change', async () => {
      const id = await liveLoan();

      const bare = await patch(id, { reason: 'Corrected purpose' }, fx.hrGlobal.token);
      expectStatus(bare, 400);
      expect(body(bare)).toMatch(/needs a reason/i);

      const withWhy = await patch(
        id,
        { reason: 'Corrected purpose', reason_for_change: 'Typo in the original filing' },
        fx.hrGlobal.token,
      );
      expectStatus(withWhy, 200);
    });

    it('refuses any edit once the loan is over', async () => {
      const id = await liveLoan();
      await ctx.prisma.advanceLoanRequest.update({
        where: { id },
        data: { status: 'CLOSED' },
      });

      const res = await patch(
        id,
        { reason: 'x', reason_for_change: 'Trying to edit a closed loan' },
        fx.hrGlobal.token,
      );
      expectStatus(res, 400);
      expect(body(res)).toMatch(/no longer be edited/i);
    });
  });

  // ── Disbursement ──────────────────────────────────────────────────────────

  describe('recording that the money was paid out', () => {
    const approved = async (over: Record<string, unknown> = {}) => {
      const filed = await file({ type: 'LOAN', amount: 1200, installments: 6, ...over });
      const id = dataOf(filed).id;
      expectStatus(await approve(id), [200, 201]);
      return id;
    };

    it('moves APPROVED to DISBURSED and stamps the date', async () => {
      const id = await approved();
      const res = await ctx
        .http()
        .post(`/advance-loans/${id}/disburse`)
        .set(bearer(fx.hrGlobal.token))
        .send({ disbursementDate: '2026-08-10', reference: 'NEFT-1234' });
      expectStatus(res, 200);

      const row = await rowOf(id);
      expect(row!.status).toBe('DISBURSED');
      expect(row!.disbursementDate?.toISOString().slice(0, 10)).toBe('2026-08-10');
    });

    it('defaults the payout to principal minus a fee taken at source', async () => {
      // The fee reduces what is HANDED OVER; the loan still owes the principal.
      const product = await ctx
        .http()
        .post('/loan-types')
        .set(bearer(fx.admin.token))
        .send({
          code: `DISB${Date.now().toString(36).toUpperCase()}`,
          name: 'Fee product',
          category: 'LOAN',
          defaultInstallments: 6,
          maxInstallments: 12,
          processingFeeFlat: 50,
        });
      expectStatus(product, 201);

      try {
        const id = await approved({ loanTypeId: dataOf(product).id });
        await ctx
          .http()
          .post(`/advance-loans/${id}/disburse`)
          .set(bearer(fx.hrGlobal.token))
          .send({});

        const row = await rowOf(id);
        expect(Number(row!.disbursedAmount)).toBe(1150);
        // The debt is unchanged by the fee.
        expect(Number(row!.amount)).toBe(1200);
      } finally {
        await ctx.prisma.advanceLoanRequest.updateMany({
          where: { loanTypeId: dataOf(product).id },
          data: { loanTypeId: null },
        });
        await ctx.prisma.loanType.delete({ where: { id: dataOf(product).id } });
      }
    });

    it('refuses a payout larger than the principal', async () => {
      const id = await approved();
      const res = await ctx
        .http()
        .post(`/advance-loans/${id}/disburse`)
        .set(bearer(fx.hrGlobal.token))
        .send({ disbursedAmount: 99999 });
      expectStatus(res, 400);
    });

    it('refuses a future payout — it has not happened yet', async () => {
      const id = await approved();
      const ahead = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const res = await ctx
        .http()
        .post(`/advance-loans/${id}/disburse`)
        .set(bearer(fx.hrGlobal.token))
        .send({ disbursementDate: ahead });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/future/i);
    });

    it('cannot disburse the same loan twice', async () => {
      const id = await approved();
      await ctx
        .http()
        .post(`/advance-loans/${id}/disburse`)
        .set(bearer(fx.hrGlobal.token))
        .send({});
      const second = await ctx
        .http()
        .post(`/advance-loans/${id}/disburse`)
        .set(bearer(fx.hrGlobal.token))
        .send({});
      expectStatus(second, [400, 409]);
    });

    it('cannot disburse something nobody approved', async () => {
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });
      const res = await ctx
        .http()
        .post(`/advance-loans/${dataOf(filed).id}/disburse`)
        .set(bearer(fx.hrGlobal.token))
        .send({});
      expectStatus(res, 400);
      expect(body(res)).toMatch(/only an approved loan/i);
    });

    it.each([
      ['manager', () => fx.manager.token],
      ['employee', () => fx.employee.token],
    ])('refuses %s — paying money out is a finance act', async (_who, token) => {
      const id = await approved();
      const res = await ctx
        .http()
        .post(`/advance-loans/${id}/disburse`)
        .set(bearer(token()))
        .send({});
      expectStatus(res, 403);
    });

    it('keeps recovering: DISBURSED is a recoverable status', async () => {
      // The point of the state is that it changes WHO knows what, not whether
      // payroll still collects.
      const id = await approved();
      await ctx
        .http()
        .post(`/advance-loans/${id}/disburse`)
        .set(bearer(fx.hrGlobal.token))
        .send({});

      const schedule = await ctx.prisma.loanSchedule.findMany({
        where: { requestId: id },
      });
      expect(schedule.length).toBeGreaterThan(0);
    });

    it('tells the employee their money is on the way', async () => {
      const id = await approved();
      const res = await ctx
        .http()
        .post(`/advance-loans/${id}/disburse`)
        .set(bearer(fx.hrGlobal.token))
        .send({ reference: 'NEFT-9' });
      expectStatus(res, 200, 'disburse');

      const logs = await ctx.prisma.advanceLoanNotificationLog.findMany({
        where: { requestId: id, event: 'LOAN_DISBURSED' },
      });
      expect(logs.length).toBe(1);
    });
  });

  // ── The second signature ──────────────────────────────────────────────────

  describe('a restructure needs a second signature when the switch is on', () => {
    const liveLoan = async () => {
      const filed = await file({ type: 'LOAN', amount: 1200, installments: 6 });
      const id = dataOf(filed).id;
      expectStatus(await approve(id), [200, 201]);
      return id;
    };

    it('applies immediately while the switch is off — the behaviour that shipped', async () => {
      // The key was seeded and read by nothing, so nobody has ever had this
      // enforced. Enabling it is opt-in; off must stay exactly as it was.
      await withSetting(ctx, 'loan_restructure_requires_approval', 'false', async () => {
        const id = await liveLoan();
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/skip-installment`)
          .set(bearer(fx.hrGlobal.token))
          .send({ installmentNo: 2, mode: 'EXTEND', reason: 'Employee asked to defer' });
        expectStatus(res, [200, 201]);
      });
    });

    it('refuses an unauthorised restructure when the switch is on', async () => {
      await withSetting(ctx, 'loan_restructure_requires_approval', 'true', async () => {
        const id = await liveLoan();
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/skip-installment`)
          .set(bearer(fx.hrGlobal.token))
          .send({ installmentNo: 2, mode: 'EXTEND', reason: 'Employee asked to defer' });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/second approver/i);
      });
    });

    it('refuses somebody authorising their own restructure', async () => {
      await withSetting(ctx, 'loan_restructure_requires_approval', 'true', async () => {
        const id = await liveLoan();
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/skip-installment`)
          .set(bearer(fx.hrGlobal.token))
          .send({
            installmentNo: 2,
            mode: 'EXTEND',
            reason: 'Employee asked to defer',
            authorisedBy: fx.hrGlobal.userId,
          });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/cannot be authorised by the person performing it/i);
      });
    });

    it('refuses an authoriser who cannot approve loans', async () => {
      await withSetting(ctx, 'loan_restructure_requires_approval', 'true', async () => {
        const id = await liveLoan();
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/skip-installment`)
          .set(bearer(fx.hrGlobal.token))
          .send({
            installmentNo: 2,
            mode: 'EXTEND',
            reason: 'Employee asked to defer',
            authorisedBy: fx.employee.userId,
          });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/cannot approve loans/i);
      });
    });

    it('allows it with a genuine second approver', async () => {
      await withSetting(ctx, 'loan_restructure_requires_approval', 'true', async () => {
        const id = await liveLoan();
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/skip-installment`)
          .set(bearer(fx.hrGlobal.token))
          .send({
            installmentNo: 2,
            mode: 'EXTEND',
            reason: 'Employee asked to defer',
            authorisedBy: fx.admin.userId,
          });
        expectStatus(res, [200, 201]);
      });
    });
  });
});
