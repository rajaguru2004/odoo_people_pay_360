import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer, withSetting, withSettings } from './utils/settings';

/**
 * The terms a natively filed loan can carry.
 *
 * The amortisation engine implements FLAT, REDUCING_BALANCE, WEEKLY, QUARTERLY
 * and grace in full, and is the best unit-tested thing in the module. None of
 * it was reachable: `CreateAdvanceLoanDto` had four fields and none of them was
 * a term, `LoanType` was wired to nothing, and the five `loan_default_*`
 * settings were seeded and read by no code at all — so every API-filed loan was
 * `interestMethod NONE, interestRate 0, deductionFrequency MONTHLY` from the
 * Prisma column defaults, whatever anyone asked for.
 *
 * The consequence was worse than a missing feature: the bulk IMPORTER was the
 * only route that could produce an interest-bearing loan, which is why it became
 * the de-facto loan factory for half this module's e2e suites.
 *
 * The resolution order under test throughout is: **what was asked for**, then
 * **the product**, then the **setting**.
 */
describe('Finance — loan terms (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;
  const products: string[] = [];

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

  const file = (payload: Record<string, unknown>) =>
    ctx.http().post('/advance-loans').set(bearer(fx.employee.token)).send(payload);

  const rowOf = (id: string) =>
    ctx.prisma.advanceLoanRequest.findUnique({ where: { id } });

  const mkProduct = async (over: Record<string, unknown> = {}) => {
    const res = await ctx
      .http()
      .post('/loan-types')
      .set(bearer(fx.admin.token))
      .send({
        code: `T${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)}`,
        name: 'Terms product',
        category: 'LOAN',
        defaultInstallments: 6,
        maxInstallments: 12,
        ...over,
      });
    expectStatus(res, 201, 'product create');
    products.push(dataOf(res).id);
    return dataOf(res);
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

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  });

  afterEach(purge);

  afterAll(async () => {
    await purge();
    if (products.length) {
      await ctx.prisma.loanType.deleteMany({ where: { id: { in: products } } });
    }
    await fx.cleanup();
    await ctx.app.close();
  });

  describe('interest is reachable natively at last', () => {
    it('files a REDUCING_BALANCE loan at a requested rate', async () => {
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          interestMethod: 'REDUCING_BALANCE',
          interestRate: 12,
        });
        expectStatus(res, 201);

        const row = await rowOf(dataOf(res).id);
        expect(row!.interestMethod).toBe('REDUCING_BALANCE');
        expect(Number(row!.interestRate)).toBe(12);
      });
    });

    it('files a FLAT loan', async () => {
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          interestMethod: 'FLAT',
          interestRate: 6.5,
        });
        expectStatus(res, 201);
        const row = await rowOf(dataOf(res).id);
        expect(row!.interestMethod).toBe('FLAT');
        expect(Number(row!.interestRate)).toBe(6.5);
      });
    });

    it('keeps a 3dp rate — the column holds Decimal(6,3)', async () => {
      // A rate the DTO accepts and the column then rounds is a loan charging a
      // rate nobody agreed to.
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          interestMethod: 'FLAT',
          interestRate: 8.375,
        });
        expectStatus(res, 201);
        const row = await rowOf(dataOf(res).id);
        expect(Number(row!.interestRate)).toBe(8.375);
      });
    });

    it('refuses a 4dp rate rather than silently rounding it', async () => {
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          interestMethod: 'FLAT',
          interestRate: 8.3751,
        });
        expectStatus(res, 400);
      });
    });

    it('refuses a method with no rate', async () => {
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          interestMethod: 'FLAT',
        });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/needs a rate above 0/i);
      });
    });

    it('refuses a rate with no method', async () => {
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          interestRate: 9,
        });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/method is NONE/i);
      });
    });

    it('refuses a rate outright while the kill-switch is off, naming the switch', async () => {
      // Coercing to NONE silently would let a requester agree to 9% and be
      // charged nothing — the loan and its schedule would disagree.
      await withSetting(ctx, 'loan_interest_enabled', 'false', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          interestMethod: 'FLAT',
          interestRate: 9,
        });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/loan_interest_enabled/);
      });
    });

    it('still files an interest-free loan while the switch is off', async () => {
      await withSetting(ctx, 'loan_interest_enabled', 'false', async () => {
        const res = await file({ type: 'LOAN', amount: 1200, installments: 6 });
        expectStatus(res, 201);
        const row = await rowOf(dataOf(res).id);
        expect(row!.interestMethod).toBe('NONE');
        expect(Number(row!.interestRate)).toBe(0);
      });
    });

    it('the schedule actually charges the interest that was agreed', async () => {
      // The end of the chain: a term that reaches the column but not the
      // schedule is still unreachable in every way that matters.
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        const filed = await file({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          interestMethod: 'REDUCING_BALANCE',
          interestRate: 12,
        });
        expectStatus(filed, 201);
        const id = dataOf(filed).id;

        const approved = await ctx
          .http()
          .post(`/advance-loans/${id}/approve`)
          .set(bearer(fx.hrGlobal.token))
          .send({});
        expectStatus(approved, [200, 201]);

        const rows = await ctx.prisma.loanSchedule.findMany({
          where: { requestId: id },
          orderBy: [{ version: 'desc' }, { installmentNo: 'asc' }],
        });
        expect(rows.length).toBeGreaterThan(0);
        const interest = rows.reduce((a, r) => a + Number(r.interestComponent), 0);
        expect(interest).toBeGreaterThan(0);
      });
    });
  });

  describe('the security deposit a product requires', () => {
    /**
     * `AdvanceLoanRequest.securityDeposit` is a v2 column no writer ever
     * touched — not the importer, not create(). `LoanType` says only WHETHER
     * security is required, so the amount comes from one company-wide rule
     * rather than from the requester: a deposit the borrower chooses is not a
     * deposit.
     */
    it('is taken as a percentage of the principal', async () => {
      const product = await mkProduct({ name: 'Secured product', requiresSecurity: true });

      await withSetting(ctx, 'loan_security_deposit_percent', '10', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 3000,
          installments: 6,
          loanTypeId: product.id,
          reason: 'security deposit is taken',
        });
        expectStatus(res, 201, 'secured filing');

        const row = await rowOf(dataOf(res).id);
        expect(Number(row!.securityDeposit)).toBe(300);
      });
    });

    it('refuses the filing when the product needs security and the rule is 0%', async () => {
      const product = await mkProduct({ name: 'Unfunded security', requiresSecurity: true });

      // 0 is the shipped default, so this is the state a site is in before
      // anybody sets the rule — and filing against the product then has to say
      // so rather than record a deposit of nothing.
      await withSetting(ctx, 'loan_security_deposit_percent', '0', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 3000,
          installments: 6,
          loanTypeId: product.id,
          reason: 'security rule not set',
        });
        expectStatus(res, 400, 'unfunded security filing');
        expect(body(res)).toContain('loan_security_deposit_percent');
      });
    });

    it('leaves it at zero for a product that requires none', async () => {
      const product = await mkProduct({ name: 'Unsecured product' });

      await withSetting(ctx, 'loan_security_deposit_percent', '10', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 3000,
          installments: 6,
          loanTypeId: product.id,
          reason: 'no security required',
        });
        expectStatus(res, 201, 'unsecured filing');
        expect(Number((await rowOf(dataOf(res).id))!.securityDeposit)).toBe(0);
      });
    });

    it('is settable and readable back, so it can be restored', async () => {
      const list = await ctx
        .http()
        .get('/system-settings')
        .set(bearer(fx.admin.token));
      expectStatus(list, 200, 'settings list');
      const rows = dataOf(list) as Array<{ key: string }>;
      expect(rows.some((r) => r.key === 'loan_security_deposit_percent')).toBe(true);
    });

    it('refuses a percentage outside 0..100 at the write boundary', async () => {
      const res = await ctx
        .http()
        .post('/system-settings')
        .set(bearer(fx.admin.token))
        .send({ settings: { loan_security_deposit_percent: '140' } });
      expectStatus(res, 400, 'out-of-range deposit percent');
      expect(body(res)).toContain('loan_security_deposit_percent');
    });
  });

  describe('the loan_default_* settings are read at last', () => {
    it('applies the default method and rate when the requester states neither', async () => {
      // Both keys were seeded and read by nothing.
      await withSettings(
        ctx,
        {
          loan_interest_enabled: 'true',
          loan_default_interest_method: 'FLAT',
          loan_default_interest_rate: '7',
        },
        async () => {
          const res = await file({ type: 'LOAN', amount: 1200, installments: 6 });
          expectStatus(res, 201);
          const row = await rowOf(dataOf(res).id);
          expect(row!.interestMethod).toBe('FLAT');
          expect(Number(row!.interestRate)).toBe(7);
        },
      );
    });

    it('applies the default deduction frequency', async () => {
      await withSetting(ctx, 'loan_default_frequency', 'QUARTERLY', async () => {
        const res = await file({ type: 'LOAN', amount: 1200, installments: 4 });
        expectStatus(res, 201);
        const row = await rowOf(dataOf(res).id);
        expect(row!.deductionFrequency).toBe('QUARTERLY');
      });
    });

    it('lets what was asked for beat the default', async () => {
      await withSettings(
        ctx,
        {
          loan_interest_enabled: 'true',
          loan_default_interest_method: 'FLAT',
          loan_default_interest_rate: '7',
        },
        async () => {
          const res = await file({
            type: 'LOAN',
            amount: 1200,
            installments: 6,
            interestMethod: 'REDUCING_BALANCE',
            interestRate: 3,
          });
          expectStatus(res, 201);
          const row = await rowOf(dataOf(res).id);
          expect(row!.interestMethod).toBe('REDUCING_BALANCE');
          expect(Number(row!.interestRate)).toBe(3);
        },
      );
    });

    it('lets the product beat the default, and the request beat the product', async () => {
      await withSettings(
        ctx,
        {
          loan_interest_enabled: 'true',
          loan_default_interest_method: 'FLAT',
          loan_default_interest_rate: '7',
        },
        async () => {
          const p = await mkProduct({ interestMethod: 'REDUCING_BALANCE', interestRate: 5 });

          const fromProduct = await file({
            type: 'LOAN',
            amount: 1200,
            installments: 6,
            loanTypeId: p.id,
          });
          expectStatus(fromProduct, 201);
          const a = await rowOf(dataOf(fromProduct).id);
          expect(a!.interestMethod).toBe('REDUCING_BALANCE');
          expect(Number(a!.interestRate)).toBe(5);
          await purge();

          const fromRequest = await file({
            type: 'LOAN',
            amount: 1200,
            installments: 6,
            loanTypeId: p.id,
            interestMethod: 'FLAT',
            interestRate: 2,
          });
          expectStatus(fromRequest, 201);
          const b = await rowOf(dataOf(fromRequest).id);
          expect(b!.interestMethod).toBe('FLAT');
          expect(Number(b!.interestRate)).toBe(2);
        },
      );
    });
  });

  describe('deduction frequency — WEEKLY and QUARTERLY were engine-only', () => {
    it.each(['WEEKLY', 'QUARTERLY', 'MONTHLY'])(
      'files a %s loan and schedules it on that cadence',
      async (frequency) => {
        const filed = await file({
          type: 'LOAN',
          amount: 1200,
          installments: 4,
          deductionFrequency: frequency,
        });
        expectStatus(filed, 201);
        const id = dataOf(filed).id;

        const row = await rowOf(id);
        expect(row!.deductionFrequency).toBe(frequency);

        const approved = await ctx
          .http()
          .post(`/advance-loans/${id}/approve`)
          .set(bearer(fx.hrGlobal.token))
          .send({});
        expectStatus(approved, [200, 201]);

        const rows = await ctx.prisma.loanSchedule.findMany({
          where: { requestId: id },
          orderBy: [{ version: 'desc' }, { installmentNo: 'asc' }],
        });
        expect(rows.length).toBe(4);

        // The gap between the first two due dates is what the cadence MEANS.
        const gapDays =
          (new Date(rows[1].dueDate).getTime() - new Date(rows[0].dueDate).getTime()) /
          86_400_000;
        if (frequency === 'WEEKLY') expect(gapDays).toBeLessThanOrEqual(10);
        if (frequency === 'MONTHLY') expect(gapDays).toBeGreaterThan(20);
        if (frequency === 'QUARTERLY') expect(gapDays).toBeGreaterThan(80);
      },
    );

    it('refuses a frequency the engine does not implement', async () => {
      const res = await file({
        type: 'LOAN',
        amount: 1200,
        installments: 4,
        deductionFrequency: 'DAILY',
      });
      expectStatus(res, 400);
    });
  });

  describe('grace periods', () => {
    it('pushes the first instalment out by the requested number of cycles', async () => {
      const noGrace = await file({ type: 'LOAN', amount: 1200, installments: 6 });
      expectStatus(noGrace, 201);
      const plainId = dataOf(noGrace).id;
      await ctx
        .http()
        .post(`/advance-loans/${plainId}/approve`)
        .set(bearer(fx.hrGlobal.token))
        .send({})
        .expect((r: any) => expectStatus(r, [200, 201]));
      const plainFirst = await ctx.prisma.loanSchedule.findFirst({
        where: { requestId: plainId },
        orderBy: [{ version: 'desc' }, { installmentNo: 'asc' }],
      });
      await purge();

      const withGrace = await file({
        type: 'LOAN',
        amount: 1200,
        installments: 6,
        gracePeriods: 3,
      });
      expectStatus(withGrace, 201);
      const graceId = dataOf(withGrace).id;
      const graceRow = await rowOf(graceId);
      expect(graceRow!.gracePeriods).toBe(3);

      await ctx
        .http()
        .post(`/advance-loans/${graceId}/approve`)
        .set(bearer(fx.hrGlobal.token))
        .send({})
        .expect((r: any) => expectStatus(r, [200, 201]));
      const graceFirst = await ctx.prisma.loanSchedule.findFirst({
        where: { requestId: graceId },
        orderBy: [{ version: 'desc' }, { installmentNo: 'asc' }],
      });

      expect(
        new Date(graceFirst!.dueDate).getTime(),
      ).toBeGreaterThan(new Date(plainFirst!.dueDate).getTime());
    });

    it('records NONE as the grace mode when no grace was asked for', async () => {
      const res = await file({ type: 'LOAN', amount: 1200, installments: 6 });
      expectStatus(res, 201);
      const row = await rowOf(dataOf(res).id);
      expect(row!.gracePeriods).toBe(0);
      expect(row!.graceMode).toBe('NONE');
    });

    it('refuses a negative grace period', async () => {
      const res = await file({
        type: 'LOAN',
        amount: 1200,
        installments: 6,
        gracePeriods: -1,
      });
      expectStatus(res, 400);
    });
  });

  describe('the importer can finally state a cadence', () => {
    // `preview` and `confirm` both hard-coded MONTHLY, so a weekly or quarterly
    // loan being migrated silently became a monthly one and its schedule
    // disagreed with the ledger it came from. The sheet gained a column.
    const importRow = (over: Record<string, unknown> = {}) => ({
      employeeCode: `EMP-IMPTERMS-${Date.now().toString(36)}`,
      referenceNo: `IMPT-${Date.now().toString(36)}`,
      type: 'LOAN',
      principal: 1200,
      interestMethod: 'NONE',
      interestRate: 0,
      installments: 4,
      disbursedOn: '2026-02-15',
      firstDeductionPeriod: '2026-03',
      installmentsPaid: 0,
      amountRepaid: 0,
      status: 'ACTIVE',
      ...over,
    });

    let employeeCode = '';
    beforeAll(async () => {
      const emp = await ctx.prisma.employee.findUnique({ where: { id: fx.earnerId } });
      employeeCode = emp!.employeeCode;
    });

    it('imports a QUARTERLY loan and schedules it quarterly', async () => {
      const res = await ctx
        .http()
        .post('/advance-loans/import/confirm')
        .set(bearer(fx.hrGlobal.token))
        .send({
          rows: [importRow({ employeeCode, deductionFrequency: 'QUARTERLY' })],
        });
      expectStatus(res, 201);
      expect(dataOf(res).summary.imported).toBe(1);

      const loanId = dataOf(res).results.find((r: any) => r.success).loanId;
      const row = await rowOf(loanId);
      expect(row!.deductionFrequency).toBe('QUARTERLY');

      const rows = await ctx.prisma.loanSchedule.findMany({
        where: { requestId: loanId },
        orderBy: [{ version: 'desc' }, { installmentNo: 'asc' }],
      });
      const gapDays =
        (new Date(rows[1].dueDate).getTime() - new Date(rows[0].dueDate).getTime()) /
        86_400_000;
      expect(gapDays).toBeGreaterThan(80);
    });

    it('treats a blank frequency as MONTHLY — an existing sheet still means what it did', async () => {
      const res = await ctx
        .http()
        .post('/advance-loans/import/confirm')
        .set(bearer(fx.hrGlobal.token))
        .send({ rows: [importRow({ employeeCode })] });
      expectStatus(res, 201);
      const loanId = dataOf(res).results.find((r: any) => r.success).loanId;
      const row = await rowOf(loanId);
      expect(row!.deductionFrequency).toBe('MONTHLY');
    });

    it('refuses a cadence the engine does not implement, naming the three', async () => {
      const res = await ctx
        .http()
        .post('/advance-loans/import/confirm')
        .set(bearer(fx.hrGlobal.token))
        .send({
          rows: [importRow({ employeeCode, deductionFrequency: 'FORTNIGHTLY' })],
        });
      expectStatus(res, 201);
      expect(dataOf(res).summary.imported).toBe(0);
      expect(body(res)).toMatch(/MONTHLY, WEEKLY or QUARTERLY/i);
    });
  });

  describe('every loan gets a reference number', () => {
    // `loan_reference_prefix` was seeded and read by nothing, and `referenceNo`
    // was written ONLY by the importer — so a natively filed loan had no
    // reference, support had nothing to quote back, and the
    // `DUPLICATE_REFERENCE` eligibility rule could never fire for one.
    it('mints one on a natively filed loan', async () => {
      const res = await file({ type: 'LOAN', amount: 600, installments: 6 });
      expectStatus(res, 201);
      const row = await rowOf(dataOf(res).id);
      expect(row!.referenceNo).toMatch(/^LN-\d{6}-\d{4}$/);
    });

    it('uses the configured prefix', async () => {
      await withSetting(ctx, 'loan_reference_prefix', 'ACME', async () => {
        const res = await file({ type: 'LOAN', amount: 600, installments: 6 });
        expectStatus(res, 201);
        const row = await rowOf(dataOf(res).id);
        expect(row!.referenceNo).toMatch(/^ACME-\d{6}-\d{4}$/);
      });
    });

    it('survives two filings racing for the same number', async () => {
      // `mintReference` counts existing references and adds one, so two
      // simultaneous creates compute the SAME sequence and the second loses on
      // the unique index. Without the retry that answered 500 — found by the
      // browser concurrency suite, because every backend e2e run is serial and
      // could not reproduce it.
      // Ten at once, not two: the count-based minting this replaced survived a
      // racing PAIR and lost to fifty, so a two-request case would have passed
      // against the broken implementation.
      await withSetting(ctx, 'loan_max_active_per_employee', '50', async () => {
        const many = await Promise.all(
          Array.from({ length: 10 }, () => file({ type: 'ADVANCE', amount: 100 })),
        );
        for (const res of many) expectStatus(res, 201, 'ten at once');
        const manyRefs = await Promise.all(
          many.map(async (r) => (await rowOf(dataOf(r).id))!.referenceNo),
        );
        expect(new Set(manyRefs).size).toBe(10);
      });
      await purge();

      const results = await Promise.all([
        file({ type: 'ADVANCE', amount: 100 }),
        file({ type: 'ADVANCE', amount: 100 }),
      ]);

      for (const res of results) {
        expectStatus(res, 201, 'concurrent filing');
      }
      const refs = await Promise.all(
        results.map(async (r) => (await rowOf(dataOf(r).id))!.referenceNo),
      );
      expect(new Set(refs).size).toBe(2);
    });

    it('gives two loans in the same month different references', async () => {
      const a = await file({ type: 'ADVANCE', amount: 100 });
      expectStatus(a, 201);
      const b = await file({ type: 'ADVANCE', amount: 100 });
      expectStatus(b, 201);

      const rowA = await rowOf(dataOf(a).id);
      const rowB = await rowOf(dataOf(b).id);
      expect(rowA!.referenceNo).not.toBe(rowB!.referenceNo);
    });

    it('falls back to LN when the prefix is set to nonsense', async () => {
      // The key has no validation rule (its allowed set is not established
      // anywhere), so the reader has to cope rather than mint `--202608-0001`.
      await withSetting(ctx, 'loan_reference_prefix', '!!!', async () => {
        const res = await file({ type: 'ADVANCE', amount: 100 });
        expectStatus(res, 201);
        const row = await rowOf(dataOf(res).id);
        expect(row!.referenceNo).toMatch(/^LN-/);
      });
    });
  });

  describe('a loan can say when it starts', () => {
    const isoDaysAgo = (n: number) =>
      new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const isoDaysAhead = (n: number) =>
      new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

    it('defaults to today when no date is given', async () => {
      const res = await file({ type: 'LOAN', amount: 600, installments: 6 });
      expectStatus(res, 201);
      const row = await rowOf(dataOf(res).id);
      expect(row!.effectiveDate?.toISOString().slice(0, 10)).toBe(
        new Date().toISOString().slice(0, 10),
      );
    });

    it('accepts a backdate inside the window', async () => {
      await withSetting(ctx, 'advance_loan_allow_backdated_days', '30', async () => {
        const when = isoDaysAgo(10);
        const res = await file({
          type: 'LOAN',
          amount: 600,
          installments: 6,
          effectiveDate: when,
        });
        expectStatus(res, 201);
        const row = await rowOf(dataOf(res).id);
        expect(row!.effectiveDate?.toISOString().slice(0, 10)).toBe(when);
      });
    });

    it('refuses a backdate beyond it, naming the limit and the distance', async () => {
      await withSetting(ctx, 'advance_loan_allow_backdated_days', '30', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 600,
          installments: 6,
          effectiveDate: isoDaysAgo(60),
        });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/at most 30 day/i);
      });
    });

    it('honours a window of 0 as "no backdating at all"', async () => {
      await withSetting(ctx, 'advance_loan_allow_backdated_days', '0', async () => {
        const res = await file({
          type: 'LOAN',
          amount: 600,
          installments: 6,
          effectiveDate: isoDaysAgo(1),
        });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/cannot be backdated/i);
      });
    });

    it('allows future-dating inside the same window', async () => {
      await withSetting(ctx, 'advance_loan_allow_backdated_days', '30', async () => {
        const when = isoDaysAhead(10);
        const res = await file({
          type: 'LOAN',
          amount: 600,
          installments: 6,
          effectiveDate: when,
        });
        expectStatus(res, 201);
        const row = await rowOf(dataOf(res).id);
        expect(row!.effectiveDate?.toISOString().slice(0, 10)).toBe(when);
      });
    });

    it('refuses an impossible calendar date rather than shifting it', async () => {
      // `2026-02-31` parses as 3 March everywhere; silently moving a loan's
      // start by three days is worse than refusing the typo.
      const res = await file({
        type: 'LOAN',
        amount: 600,
        installments: 6,
        effectiveDate: '2026-02-31',
      });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/not a real calendar date/i);
    });

    it('refuses a date in the wrong shape', async () => {
      const res = await file({
        type: 'LOAN',
        amount: 600,
        installments: 6,
        effectiveDate: '01/08/2026',
      });
      expectStatus(res, 400);
    });

    it('refuses a start before the employee joined', async () => {
      // The eligibility rule for this compared the joining date against TODAY,
      // because there was no requested date to compare with.
      await withSetting(ctx, 'advance_loan_allow_backdated_days', '9999', async () => {
        const employee = await ctx.prisma.employee.findUnique({
          where: { id: fx.earnerId },
        });
        const beforeJoining = new Date(employee!.startDate);
        beforeJoining.setUTCDate(beforeJoining.getUTCDate() - 1);

        const res = await file({
          type: 'LOAN',
          amount: 600,
          installments: 6,
          effectiveDate: beforeJoining.toISOString().slice(0, 10),
        });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/before the employee joined/i);
      });
    });

    it('builds the schedule from the date the loan starts', async () => {
      // The point of the field: a loan backdated to last month is due before
      // one filed today, so recovery resumes where the money actually is.
      await withSetting(ctx, 'advance_loan_allow_backdated_days', '60', async () => {
        const back = await file({
          type: 'LOAN',
          amount: 600,
          installments: 6,
          effectiveDate: isoDaysAgo(45),
        });
        expectStatus(back, 201);
        const backId = dataOf(back).id;
        await ctx
          .http()
          .post(`/advance-loans/${backId}/approve`)
          .set(bearer(fx.hrGlobal.token))
          .send({});
        const backFirst = await ctx.prisma.loanSchedule.findFirst({
          where: { requestId: backId },
          orderBy: [{ version: 'desc' }, { installmentNo: 'asc' }],
        });
        await purge();

        const now = await file({ type: 'LOAN', amount: 600, installments: 6 });
        expectStatus(now, 201);
        const nowId = dataOf(now).id;
        await ctx
          .http()
          .post(`/advance-loans/${nowId}/approve`)
          .set(bearer(fx.hrGlobal.token))
          .send({});
        const nowFirst = await ctx.prisma.loanSchedule.findFirst({
          where: { requestId: nowId },
          orderBy: [{ version: 'desc' }, { installmentNo: 'asc' }],
        });

        expect(new Date(backFirst!.dueDate).getTime()).toBeLessThan(
          new Date(nowFirst!.dueDate).getTime(),
        );
      });
    });
  });

  describe('recovery priority is settable at last', () => {
    // `priority` is the FIRST sort key in `LoanRecoveryService.sortCandidates`
    // and no route exposed it, so every API-created loan sat at 100 and the
    // rung could only ever tie-break.
    const approveAs = (id: string, payload: Record<string, unknown>) =>
      ctx
        .http()
        .post(`/advance-loans/${id}/approve`)
        .set(bearer(fx.hrGlobal.token))
        .send(payload);

    it('lets the approver set it', async () => {
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });
      expectStatus(filed, 201);
      const res = await approveAs(dataOf(filed).id, { priority: 10 });
      expectStatus(res, [200, 201]);

      const row = await rowOf(dataOf(filed).id);
      expect(row!.priority).toBe(10);
    });

    it('leaves the product’s priority alone when the approver says nothing', async () => {
      const p = await mkProduct({ priority: 25 });
      const filed = await file({
        type: 'LOAN',
        amount: 600,
        installments: 6,
        loanTypeId: p.id,
      });
      expectStatus(filed, 201);
      const res = await approveAs(dataOf(filed).id, {});
      expectStatus(res, [200, 201]);

      const row = await rowOf(dataOf(filed).id);
      expect(row!.priority).toBe(25);
    });

    it('is not settable by the requester — which debt yields is the employer’s call', async () => {
      const res = await file({
        type: 'LOAN',
        amount: 600,
        installments: 6,
        priority: 1,
      });
      // `forbidNonWhitelisted` refuses the unknown field outright rather than
      // accepting it and quietly dropping it.
      expectStatus(res, 400);
    });

    it('refuses a nonsense priority', async () => {
      const filed = await file({ type: 'LOAN', amount: 600, installments: 6 });
      expectStatus(filed, 201);
      const res = await approveAs(dataOf(filed).id, { priority: 0 });
      expectStatus(res, 400);
    });
  });

  describe('per-leave-type loan behaviour has an HTTP surface', () => {
    // `LibraryItem.loanDeductionPolicy` is read by payroll to decide
    // CONTINUE / PAUSE / EXTEND per leave type, and was absent from both
    // library DTOs — so the rule could only be set with direct database access.
    const created: string[] = [];

    afterAll(async () => {
      if (created.length) {
        await ctx.prisma.libraryItem.deleteMany({ where: { id: { in: created } } });
      }
    });

    it('accepts the policy on a LEAVE_TYPE', async () => {
      const res = await ctx
        .http()
        .post('/library-items')
        .set(bearer(fx.admin.token))
        .send({
          libraryType: 'LEAVE_TYPE',
          label: `E2E Loan Pause Leave ${Date.now()}`,
          loanDeductionPolicy: 'PAUSE',
        });
      expectStatus(res, 201);
      created.push(dataOf(res).id);
      expect(dataOf(res).loanDeductionPolicy).toBe('PAUSE');
    });

    it('refuses it on a library type payroll never reads it from', async () => {
      // A policy on a Position would change nothing and imply that it had.
      const res = await ctx
        .http()
        .post('/library-items')
        .set(bearer(fx.admin.token))
        .send({
          libraryType: 'POSITION',
          label: `E2E Bad Policy ${Date.now()}`,
          loanDeductionPolicy: 'PAUSE',
        });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/LEAVE_TYPE items only/i);
    });

    it('refuses a value outside CONTINUE / PAUSE / EXTEND', async () => {
      const res = await ctx
        .http()
        .post('/library-items')
        .set(bearer(fx.admin.token))
        .send({
          libraryType: 'LEAVE_TYPE',
          label: `E2E Bad Value ${Date.now()}`,
          loanDeductionPolicy: 'SOMETIMES',
        });
      expectStatus(res, 400);
    });

    it('clears the policy with an explicit null', async () => {
      const made = await ctx
        .http()
        .post('/library-items')
        .set(bearer(fx.admin.token))
        .send({
          libraryType: 'LEAVE_TYPE',
          label: `E2E Clearable ${Date.now()}`,
          loanDeductionPolicy: 'EXTEND',
        });
      expectStatus(made, 201);
      created.push(dataOf(made).id);

      const res = await ctx
        .http()
        .patch(`/library-items/${dataOf(made).id}`)
        .set(bearer(fx.admin.token))
        .send({ loanDeductionPolicy: null });
      expectStatus(res, 200);
      expect(dataOf(res).loanDeductionPolicy).toBeNull();
    });
  });

  describe('filing on somebody else’s behalf', () => {
    // Until now `POST /advance-loans` filed for the CALLER's own employee
    // record and nothing else, so a loan for an arbitrary employee could only
    // be produced by the bulk importer — a migration endpoint that
    // re-validates less than the ordinary path. `createdOnBehalfBy` and
    // `approvalSource = 'ON_BEHALF'` existed for this and were written by
    // nothing.
    const onBehalf = (payload: Record<string, unknown>, token = fx.hrGlobal.token) =>
      ctx.http().post('/advance-loans/on-behalf').set(bearer(token)).send(payload);

    it('records who filed it, and for whom', async () => {
      const res = await onBehalf({
        employeeId: fx.earnerId,
        type: 'LOAN',
        amount: 600,
        installments: 6,
      });
      expectStatus(res, 201);

      const row = await rowOf(dataOf(res).id);
      expect(row!.employeeId).toBe(fx.earnerId);
      expect(row!.createdOnBehalfBy).toBe(fx.hrGlobal.userId);
      expect(row!.approvalSource).toBe('ON_BEHALF');
    });

    it('is not a way around the eligibility rules', async () => {
      // The whole risk of an on-behalf route: it must run the same gate, or it
      // becomes the importer problem again in a new place.
      const res = await onBehalf({
        employeeId: fx.inactiveId,
        type: 'LOAN',
        amount: 600,
        installments: 6,
      });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/cannot take a new advance or loan/i);
    });

    it('mints a reference and dates the loan like any other', async () => {
      const res = await onBehalf({
        employeeId: fx.earnerId,
        type: 'ADVANCE',
        amount: 200,
      });
      expectStatus(res, 201);
      const row = await rowOf(dataOf(res).id);
      expect(row!.referenceNo).toMatch(/^LN-\d{6}-\d{4}$/);
      expect(row!.effectiveDate).toBeTruthy();
    });

    it.each([
      ['manager', () => fx.manager.token],
      ['employee', () => fx.employee.token],
    ])('refuses %s — filing for others is an HR act', async (_who, token) => {
      const res = await onBehalf(
        { employeeId: fx.earnerId, type: 'ADVANCE', amount: 200 },
        token(),
      );
      expectStatus(res, 403);
    });

    it('refuses an employee in another branch', async () => {
      const res = await onBehalf(
        { employeeId: fx.foreignId, type: 'ADVANCE', amount: 200 },
        fx.hrScoped.token,
      );
      expectStatus(res, [403, 404]);
    });

    it('refuses an unknown employee', async () => {
      const res = await onBehalf({
        employeeId: '00000000-0000-4000-8000-000000000000',
        type: 'ADVANCE',
        amount: 200,
      });
      expectStatus(res, 404);
    });
  });

  describe('an advance is unaffected', () => {
    it('stays a single-instalment, interest-free deduction', async () => {
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        const res = await file({ type: 'ADVANCE', amount: 300 });
        expectStatus(res, 201);
        const row = await rowOf(dataOf(res).id);
        expect(row!.installments).toBe(1);
        expect(row!.interestMethod).toBe('NONE');
      });
    });
  });
});
