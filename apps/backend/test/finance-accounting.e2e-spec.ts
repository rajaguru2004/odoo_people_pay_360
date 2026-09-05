import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer } from './utils/settings';

/**
 * Loan money reaching a general ledger.
 *
 * Gap report §1 and the whole of catalogue §14: there was no accounting module
 * anywhere, and `LoanTransaction.journalRef` was declared, indexed and written
 * by nothing — so loan receivable, payroll liability, interest income,
 * write-off and settlement journals, plus the rollback and duplicate-journal
 * cases, were 0% testable because none of it existed.
 *
 * The feed was already right: `LoanTransaction` is append-only, typed by event
 * and split into principal/interest/fee. These cases drive the posting side and
 * assert the three properties that make it safe — it is replayable, it refuses
 * what it has not been told how to post, and it reverses rather than deletes.
 */
describe('Finance — accounting and journal posting (e2e)', () => {
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

  const account = async (code: string, type = 'ASSET') => {
    const res = await ctx
      .http()
      .post('/accounting/accounts')
      .set(bearer(fx.admin.token))
      .send({ code, name: `E2E ${code}`, type });
    expectStatus(res, 201, `account ${code}`);
    return dataOf(res);
  };

  const map = async (payload: Record<string, unknown>) => {
    const res = await ctx
      .http()
      .post('/accounting/mappings')
      .set(bearer(fx.admin.token))
      .send(payload);
    expectStatus(res, 201, 'mapping');
    return dataOf(res);
  };

  /** A loan with one EMI_RECOVERY transaction of 200 principal + 6 interest. */
  const seedTransaction = async (over: Record<string, any> = {}) => {
    const loan = await ctx.prisma.advanceLoanRequest.create({
      data: {
        employeeId: fx.earnerId,
        type: 'LOAN',
        amount: 1200,
        installments: 6,
        installmentAmount: 206,
        status: 'ACTIVE',
        referenceNo: `AC-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
      },
    });
    const txn = await ctx.prisma.loanTransaction.create({
      data: {
        requestId: loan.id,
        type: 'EMI_RECOVERY',
        transactionDate: new Date('2026-08-31'),
        amount: 206,
        principalComponent: 200,
        interestComponent: 6,
        feeComponent: 0,
        ...over,
      },
    });
    return { loan, txn };
  };

  const clearAll = async () => {
    await ctx.prisma.journalLine.deleteMany({});
    await ctx.prisma.journalEntry.deleteMany({});
    await ctx.prisma.ledgerMapping.deleteMany({});
    await ctx.prisma.ledgerAccount.deleteMany({ where: { code: { startsWith: 'E2E' } } });
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
    await ctx.prisma.advanceLoanDeduction.deleteMany({ where });
    await ctx.prisma.loanSchedule.deleteMany({ where });
    await ctx.prisma.advanceLoanRequest.deleteMany({ where: { id: { in: ids } } });
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  });

  afterEach(clearAll);

  afterAll(async () => {
    await clearAll();
    await fx.cleanup();
    await ctx.app.close();
  });

  // ── The chart of accounts ─────────────────────────────────────────────────

  describe('the chart of accounts', () => {
    it('is created and listed', async () => {
      await account('E2E1310', 'ASSET');
      const res = await ctx
        .http()
        .get('/accounting/accounts')
        .set(bearer(fx.hrGlobal.token));
      expectStatus(res, 200);
      expect(dataOf(res).some((a: any) => a.code === 'E2E1310')).toBe(true);
    });

    it('refuses a duplicate code by name', async () => {
      await account('E2E1310');
      const res = await ctx
        .http()
        .post('/accounting/accounts')
        .set(bearer(fx.admin.token))
        .send({ code: 'E2E1310', name: 'Clash', type: 'ASSET' });
      expectStatus(res, 409);
    });

    it('refuses an account type outside the four', async () => {
      const res = await ctx
        .http()
        .post('/accounting/accounts')
        .set(bearer(fx.admin.token))
        .send({ code: 'E2EBAD', name: 'Bad', type: 'VIBES' });
      expectStatus(res, 400);
    });

    it.each([
      ['hrGlobal', () => fx.hrGlobal.token],
      ['employee', () => fx.employee.token],
    ])('refuses %s — a wrong account misstates a balance sheet', async (_who, token) => {
      const res = await ctx
        .http()
        .post('/accounting/accounts')
        .set(bearer(token()))
        .send({ code: 'E2ENO', name: 'No', type: 'ASSET' });
      expectStatus(res, 403);
    });

    it('refuses to delete an account a journal line names', async () => {
      const bank = await account('E2EBANK');
      const recv = await account('E2ERECV');
      await map({ event: 'EMI_RECOVERY', debitAccountId: bank.id, creditAccountId: recv.id });
      const { txn } = await seedTransaction();
      await ctx
        .http()
        .post(`/accounting/journal/post/${txn.id}`)
        .set(bearer(fx.admin.token))
        .send({});

      const res = await ctx
        .http()
        .delete(`/accounting/accounts/${bank.id}`)
        .set(bearer(fx.admin.token));
      expectStatus(res, 409);
      expect(body(res)).toMatch(/Deactivate it instead/i);
    });
  });

  // ── Mappings ──────────────────────────────────────────────────────────────

  describe('mapping an event to accounts', () => {
    it('refuses a mapping whose two sides are the same account', async () => {
      // An entry that debits and credits one account moves nothing, and hides
      // that it moves nothing.
      const one = await account('E2EONE');
      const res = await ctx
        .http()
        .post('/accounting/mappings')
        .set(bearer(fx.admin.token))
        .send({ event: 'EMI_RECOVERY', debitAccountId: one.id, creditAccountId: one.id });
      expectStatus(res, 400);
    });

    it('refuses an event the module cannot post', async () => {
      const a = await account('E2EA');
      const b = await account('E2EB');
      const res = await ctx
        .http()
        .post('/accounting/mappings')
        .set(bearer(fx.admin.token))
        .send({ event: 'BIRTHDAY', debitAccountId: a.id, creditAccountId: b.id });
      expectStatus(res, 400);
    });

    it('updates in place rather than duplicating', async () => {
      const a = await account('E2EA');
      const b = await account('E2EB');
      const c = await account('E2EC');
      await map({ event: 'EMI_RECOVERY', debitAccountId: a.id, creditAccountId: b.id });
      await map({ event: 'EMI_RECOVERY', debitAccountId: c.id, creditAccountId: b.id });

      const rows = await ctx.prisma.ledgerMapping.findMany({
        where: { event: 'EMI_RECOVERY' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].debitAccountId).toBe(c.id);
    });
  });

  // ── Posting ───────────────────────────────────────────────────────────────

  describe('posting a loan transaction', () => {
    const setupMapping = async () => {
      const bank = await account('E2EBANK');
      const recv = await account('E2ERECV');
      await map({ event: 'EMI_RECOVERY', debitAccountId: bank.id, creditAccountId: recv.id });
      return { bank, recv };
    };

    it('writes a balanced entry and stamps journalRef back onto the transaction', async () => {
      // `journalRef` had been in the schema since v2 with no writer at all.
      await setupMapping();
      const { txn } = await seedTransaction();

      const res = await ctx
        .http()
        .post(`/accounting/journal/post/${txn.id}`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(res, 200);
      expect(dataOf(res).created).toBe(true);

      const after = await ctx.prisma.loanTransaction.findUnique({ where: { id: txn.id } });
      expect(after!.journalRef).toMatch(/^JE-202608-\d{4}$/);

      const entry = await ctx.prisma.journalEntry.findFirst({
        where: { sourceId: txn.id },
        include: { lines: true },
      });
      expect(entry!.lines).toHaveLength(1);
      expect(Number(entry!.lines[0].amount)).toBe(206);
    });

    it('posting twice returns the same entry rather than a second one', async () => {
      // The catalogue's duplicate-journal case, answered by the unique index
      // rather than by a check-then-write.
      await setupMapping();
      const { txn } = await seedTransaction();

      const first = await ctx
        .http()
        .post(`/accounting/journal/post/${txn.id}`)
        .set(bearer(fx.admin.token))
        .send({});
      const second = await ctx
        .http()
        .post(`/accounting/journal/post/${txn.id}`)
        .set(bearer(fx.admin.token))
        .send({});

      expect(dataOf(first).created).toBe(true);
      expect(dataOf(second).created).toBe(false);
      expect(dataOf(second).entry.id).toBe(dataOf(first).entry.id);

      const count = await ctx.prisma.journalEntry.count({ where: { sourceId: txn.id } });
      expect(count).toBe(1);
    });

    it('refuses an unmapped event, naming it', async () => {
      const { txn } = await seedTransaction();
      const res = await ctx
        .http()
        .post(`/accounting/journal/post/${txn.id}`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(res, 400);
      expect(body(res)).toMatch(/No ledger mapping for EMI_RECOVERY/);
    });

    it('splits principal and interest to different accounts', async () => {
      // The point of a component-level mapping: interest income is separable
      // from principal recovery, which is what §14 asks for.
      const bank = await account('E2EBANK');
      const recv = await account('E2ERECV');
      const income = await account('E2EINCOME', 'INCOME');
      await map({
        event: 'EMI_RECOVERY',
        component: 'PRINCIPAL',
        debitAccountId: bank.id,
        creditAccountId: recv.id,
      });
      await map({
        event: 'EMI_RECOVERY',
        component: 'INTEREST',
        debitAccountId: bank.id,
        creditAccountId: income.id,
      });

      const { txn } = await seedTransaction();
      const res = await ctx
        .http()
        .post(`/accounting/journal/post/${txn.id}`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(res, 200);

      const entry = await ctx.prisma.journalEntry.findFirst({
        where: { sourceId: txn.id },
        include: { lines: true },
      });
      const byComponent = Object.fromEntries(
        entry!.lines.map((l) => [l.component, Number(l.amount)]),
      );
      expect(byComponent.PRINCIPAL).toBe(200);
      expect(byComponent.INTEREST).toBe(6);
    });

    it('never touches the loan’s money', async () => {
      // The rule that lets accounting fail safely: it reads the ledger and
      // writes journals, and cannot change what a borrower owes.
      await setupMapping();
      const { loan, txn } = await seedTransaction();
      const before = await ctx.prisma.advanceLoanRequest.findUnique({
        where: { id: loan.id },
      });

      await ctx
        .http()
        .post(`/accounting/journal/post/${txn.id}`)
        .set(bearer(fx.admin.token))
        .send({});

      const after = await ctx.prisma.advanceLoanRequest.findUnique({
        where: { id: loan.id },
      });
      expect(Number(after!.amountRepaid)).toBe(Number(before!.amountRepaid));
      expect(after!.status).toBe(before!.status);
    });

    it.each([
      ['hrGlobal', () => fx.hrGlobal.token],
      ['employee', () => fx.employee.token],
    ])('refuses %s', async (_who, token) => {
      await setupMapping();
      const { txn } = await seedTransaction();
      const res = await ctx
        .http()
        .post(`/accounting/journal/post/${txn.id}`)
        .set(bearer(token()))
        .send({});
      expectStatus(res, 403);
    });
  });

  // ── Replay ────────────────────────────────────────────────────────────────

  describe('replaying after a mapping is fixed', () => {
    it('posts what it can and reports what it cannot', async () => {
      const bank = await account('E2EBANK');
      const recv = await account('E2ERECV');
      await map({ event: 'EMI_RECOVERY', debitAccountId: bank.id, creditAccountId: recv.id });

      await seedTransaction();
      const { loan } = await seedTransaction();
      await ctx.prisma.loanTransaction.create({
        data: {
          requestId: loan.id,
          type: 'WRITE_OFF',
          transactionDate: new Date('2026-08-31'),
          amount: 100,
          principalComponent: 100,
        },
      });

      const res = await ctx
        .http()
        .post('/accounting/journal/post-pending')
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(res, 200);

      expect(dataOf(res).posted).toBe(2);
      expect(dataOf(res).failures).toHaveLength(1);
      expect(dataOf(res).failures[0].reason).toMatch(/WRITE_OFF/);
    });

    it('posts nothing twice on a second replay', async () => {
      const bank = await account('E2EBANK');
      const recv = await account('E2ERECV');
      await map({ event: 'EMI_RECOVERY', debitAccountId: bank.id, creditAccountId: recv.id });
      await seedTransaction();

      await ctx
        .http()
        .post('/accounting/journal/post-pending')
        .set(bearer(fx.admin.token))
        .send({});
      const again = await ctx
        .http()
        .post('/accounting/journal/post-pending')
        .set(bearer(fx.admin.token))
        .send({});

      expect(dataOf(again).posted).toBe(0);
    });
  });

  // ── Reversal ──────────────────────────────────────────────────────────────

  describe('reversing a posting', () => {
    const postOne = async () => {
      const bank = await account('E2EBANK');
      const recv = await account('E2ERECV');
      await map({ event: 'EMI_RECOVERY', debitAccountId: bank.id, creditAccountId: recv.id });
      const { txn } = await seedTransaction();
      const res = await ctx
        .http()
        .post(`/accounting/journal/post/${txn.id}`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(res, 200);
      return { txn, entry: dataOf(res).entry, bank, recv };
    };

    it('writes a reversing entry with the sides swapped, and keeps the original', async () => {
      const { entry, bank, recv } = await postOne();

      const res = await ctx
        .http()
        .post(`/accounting/journal/${entry.id}/reverse`)
        .set(bearer(fx.admin.token))
        .send({ reason: 'Posted to the wrong period' });
      expectStatus(res, 200);

      const reversal = await ctx.prisma.journalEntry.findUnique({
        where: { id: dataOf(res).id },
        include: { lines: true },
      });
      expect(reversal!.lines[0].debitAccountId).toBe(recv.id);
      expect(reversal!.lines[0].creditAccountId).toBe(bank.id);

      const original = await ctx.prisma.journalEntry.findUnique({
        where: { id: entry.id },
      });
      expect(original).toBeTruthy();
      expect(original!.status).toBe('REVERSED');
    });

    it('makes the transaction postable again', async () => {
      // Otherwise a mistaken posting could never be corrected.
      const { txn, entry } = await postOne();
      await ctx
        .http()
        .post(`/accounting/journal/${entry.id}/reverse`)
        .set(bearer(fx.admin.token))
        .send({ reason: 'Wrong account' });

      const cleared = await ctx.prisma.loanTransaction.findUnique({ where: { id: txn.id } });
      expect(cleared!.journalRef).toBeNull();

      const reposted = await ctx
        .http()
        .post(`/accounting/journal/post/${txn.id}`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(reposted, 200);
      expect(dataOf(reposted).created).toBe(true);
    });

    it('refuses to reverse the same entry twice', async () => {
      const { entry } = await postOne();
      await ctx
        .http()
        .post(`/accounting/journal/${entry.id}/reverse`)
        .set(bearer(fx.admin.token))
        .send({ reason: 'First' });

      const second = await ctx
        .http()
        .post(`/accounting/journal/${entry.id}/reverse`)
        .set(bearer(fx.admin.token))
        .send({ reason: 'Second' });
      expectStatus(second, 400);
    });

    it('requires a reason', async () => {
      const { entry } = await postOne();
      const res = await ctx
        .http()
        .post(`/accounting/journal/${entry.id}/reverse`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(res, 400);
    });
  });
});
