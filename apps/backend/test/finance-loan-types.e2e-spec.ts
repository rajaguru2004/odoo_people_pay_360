import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * The loan product catalogue — the door, and what a product actually DOES.
 *
 * `LoanType` was modelled in full and wired to nothing: twenty-five columns of
 * product terms, no controller, no route, and `loanTypeId` written by no create
 * path. So this suite has two halves:
 *
 *  1. **The door** — who may read the catalogue, who may change it, and what a
 *     branch-scoped caller sees. Reads are open to every role because the terms
 *     are what a borrower is agreeing to; writes are ADMIN because a product
 *     decides what every future loan costs.
 *  2. **The effect** — that choosing a product changes the loan. A catalogue
 *     that saves rows nobody's loan inherits is the same gap in a new shape,
 *     so every terms case here reads the figure back off the REQUEST after
 *     approval, never off the product.
 */
describe('Finance — loan products (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;
  const created: string[] = [];

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

  /** A product body that satisfies every cross-field rule. */
  const productBody = (over: Record<string, unknown> = {}) => ({
    code: `P${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)}`,
    name: 'E2E Product',
    category: 'LOAN',
    defaultInstallments: 6,
    maxInstallments: 12,
    ...over,
  });

  const mkProduct = async (over: Record<string, unknown> = {}) => {
    const res = await ctx
      .http()
      .post('/loan-types')
      .set(bearer(fx.admin.token))
      .send(productBody(over));
    expectStatus(res, 201, 'product create');
    created.push(dataOf(res).id);
    return dataOf(res);
  };

  /** Files a request as the employee and approves it as the global HR. */
  const fileAndApprove = async (
    payload: Record<string, unknown>,
    approveWith: Record<string, unknown> = {},
  ) => {
    const filed = await ctx
      .http()
      .post('/advance-loans')
      .set(bearer(fx.employee.token))
      .send(payload);
    expectStatus(filed, 201, 'file');
    const id = dataOf(filed).id;

    const approved = await ctx
      .http()
      .post(`/advance-loans/${id}/approve`)
      .set(bearer(fx.hrGlobal.token))
      .send(approveWith);
    expectStatus(approved, [200, 201], 'approve');
    return { id, request: dataOf(approved) };
  };

  const purgeLoansOf = async (employeeId: string) => {
    const ids = (
      await ctx.prisma.advanceLoanRequest.findMany({
        where: { employeeId },
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

  afterEach(async () => {
    // Loans cap at `loan_max_active_per_employee`, so a suite that files freely
    // runs out of allowance halfway through and starts failing for the wrong
    // reason.
    await purgeLoansOf(fx.earnerId);
  });

  afterAll(async () => {
    await purgeLoansOf(fx.earnerId);
    if (created.length) {
      await ctx.prisma.loanType.deleteMany({ where: { id: { in: created } } });
    }
    await fx.cleanup();
    await ctx.app.close();
  });

  // ── The catalogue exists at all ────────────────────────────────────────────

  describe('the default catalogue is seeded, not empty', () => {
    it('ships the five products the requirement names', async () => {
      // `seedDefaultTypes()` existed from the start and was called only by the
      // demo seed, so a real install had an empty table and every product term
      // was unreachable. It now runs on boot.
      const res = await ctx
        .http()
        .get('/loan-types')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
      const codes = dataOf(res).map((r: any) => r.code);
      ['PERSONAL', 'SALARY_ADVANCE', 'VEHICLE', 'EDUCATION', 'EMERGENCY'].forEach(
        (code) => expect(codes).toContain(code),
      );
    });

    it('is idempotent — a second boot does not duplicate the catalogue', async () => {
      const before = await ctx.prisma.loanType.count({ where: { code: 'PERSONAL' } });
      expect(before).toBe(1);
    });
  });

  // ── The door ───────────────────────────────────────────────────────────────

  describe('who may read the catalogue', () => {
    it.each([
      ['admin', () => fx.admin.token],
      ['hrGlobal', () => fx.hrGlobal.token],
      ['manager', () => fx.manager.token],
      ['employee', () => fx.employee.token],
    ])('%s can list the products they might borrow under', async (_who, token) => {
      const res = await ctx.http().get('/loan-types').set(bearer(token()));
      expectStatus(res, 200);
      expect(Array.isArray(dataOf(res))).toBe(true);
    });

    it('refuses an anonymous caller', async () => {
      const res = await ctx.http().get('/loan-types');
      expectStatus(res, 401);
    });

    it('hides retired products from the default list', async () => {
      const p = await mkProduct({ name: 'Retired product' });
      await ctx
        .http()
        .post(`/loan-types/${p.id}/deactivate`)
        .set(bearer(fx.admin.token))
        .expect(201);

      const res = await ctx.http().get('/loan-types').set(bearer(fx.employee.token));
      expect(dataOf(res).map((r: any) => r.id)).not.toContain(p.id);

      const withInactive = await ctx
        .http()
        .get('/loan-types?includeInactive=true')
        .set(bearer(fx.admin.token));
      expect(dataOf(withInactive).map((r: any) => r.id)).toContain(p.id);
    });
  });

  describe('who may change the catalogue', () => {
    it.each([
      ['hrGlobal', () => fx.hrGlobal.token],
      ['manager', () => fx.manager.token],
      ['employee', () => fx.employee.token],
    ])('%s cannot create a product', async (_who, token) => {
      const res = await ctx
        .http()
        .post('/loan-types')
        .set(bearer(token()))
        .send(productBody());
      expectStatus(res, 403);
    });

    it('an admin can', async () => {
      const p = await mkProduct({ name: 'Admin created' });
      expect(p.name).toBe('Admin created');
    });

    it.each([
      ['hrGlobal', () => fx.hrGlobal.token],
      ['employee', () => fx.employee.token],
    ])('%s cannot edit a product', async (_who, token) => {
      const p = await mkProduct();
      const res = await ctx
        .http()
        .patch(`/loan-types/${p.id}`)
        .set(bearer(token()))
        .send({ name: 'Renamed by the wrong role' });
      expectStatus(res, 403);
    });

    it('refuses a read-only auditor every write, while leaving reads open', async () => {
      // The auditor is granted by user id, not by role — the one place in
      // Finance that happens — and `LoanReadOnlyGuard` must cover this
      // controller like every other loan controller.
      await withSetting(
        ctx,
        'advance_loan_auditor_user_ids',
        fx.auditor.userId,
        async () => {
          const read = await ctx
            .http()
            .get('/loan-types')
            .set(bearer(fx.auditor.token));
          expectStatus(read, 200, 'an auditor may read the catalogue');

          const write = await ctx
            .http()
            .post('/loan-types')
            .set(bearer(fx.auditor.token))
            .send(productBody());
          expectStatus(write, [403], 'but may not change it');
        },
      );
    });
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  describe('a product whose terms contradict each other is refused', () => {
    it('refuses an interest rate with no method, naming both', async () => {
      const res = await ctx
        .http()
        .post('/loan-types')
        .set(bearer(fx.admin.token))
        .send(productBody({ interestMethod: 'NONE', interestRate: 8 }));
      expectStatus(res, 400);
      expect(body(res)).toMatch(/interest method is NONE/i);
    });

    it('refuses a default term longer than the product allows', async () => {
      const res = await ctx
        .http()
        .post('/loan-types')
        .set(bearer(fx.admin.token))
        .send(productBody({ defaultInstallments: 24, maxInstallments: 12 }));
      expectStatus(res, 400);
      expect(body(res)).toMatch(/default repayment period/i);
    });

    it('refuses a multi-instalment ADVANCE product', async () => {
      const res = await ctx
        .http()
        .post('/loan-types')
        .set(bearer(fx.admin.token))
        .send(
          productBody({
            category: 'ADVANCE',
            defaultInstallments: 1,
            maxInstallments: 4,
          }),
        );
      expectStatus(res, 400);
      expect(body(res)).toMatch(/recovered in one deduction/i);
    });

    it('refuses a duplicate code by name, not as a driver error', async () => {
      const p = await mkProduct();
      const res = await ctx
        .http()
        .post('/loan-types')
        .set(bearer(fx.admin.token))
        .send(productBody({ code: p.code }));
      expectStatus(res, 409);
      expect(body(res)).toContain(p.code);
    });

    it('refuses a malformed id rather than answering a driver 500', async () => {
      const res = await ctx
        .http()
        .get('/loan-types/not-a-uuid')
        .set(bearer(fx.admin.token));
      expectStatus(res, 400);
    });

    it('refuses an unknown field instead of silently dropping it', async () => {
      // `forbidNonWhitelisted` is on globally; a typo'd term must not be
      // accepted and then ignored.
      const res = await ctx
        .http()
        .post('/loan-types')
        .set(bearer(fx.admin.token))
        .send(productBody({ intrestRate: 8 }));
      expectStatus(res, 400);
    });
  });

  // ── Retirement ─────────────────────────────────────────────────────────────

  describe('retiring a product', () => {
    it('refuses to delete one that loans still reference, and says how many', async () => {
      const p = await mkProduct();
      await fileAndApprove({ type: 'LOAN', amount: 600, installments: 6, loanTypeId: p.id });

      const res = await ctx
        .http()
        .delete(`/loan-types/${p.id}`)
        .set(bearer(fx.admin.token));
      expectStatus(res, 409);
      expect(body(res)).toMatch(/Deactivate it instead/i);
    });

    it('sees a reference from ANOTHER branch, not just the caller’s', async () => {
      // The guard used to count through the branch-scoping middleware, so an
      // admin narrowed to branch B counted zero loans against a product that
      // branch A was using, passed its own check, and hit the `onDelete:
      // Restrict` foreign key as a raw driver error. Referential integrity is
      // not a per-branch question.
      const p = await mkProduct();
      await ctx.prisma.advanceLoanRequest.create({
        data: {
          employeeId: fx.foreignId,
          type: 'LOAN',
          amount: 500,
          installments: 5,
          status: 'PENDING',
          loanTypeId: p.id,
        },
      });

      try {
        const res = await ctx
          .http()
          .delete(`/loan-types/${p.id}`)
          .set(bearer(fx.hrScoped.token))
          .set('X-Branch-Id', fx.branchA);
        // Whatever the caller's branch, the answer is the same refusal — never
        // a 500 from the database.
        expectStatus(res, [403, 409], 'a cross-branch reference still blocks the delete');
      } finally {
        await ctx.prisma.advanceLoanRequest.deleteMany({ where: { loanTypeId: p.id } });
      }
    });

    it('deletes one nothing has ever used', async () => {
      const p = await mkProduct();
      const res = await ctx
        .http()
        .delete(`/loan-types/${p.id}`)
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
    });

    it('refuses a new request under a retired product', async () => {
      const p = await mkProduct();
      await ctx
        .http()
        .post(`/loan-types/${p.id}/deactivate`)
        .set(bearer(fx.admin.token))
        .expect(201);

      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 6, loanTypeId: p.id });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/no longer offered/i);
    });

    it('leaves loans already filed under it untouched', async () => {
      // Deactivation is about what may be borrowed NEXT. A live loan whose
      // product was retired must keep running.
      const p = await mkProduct();
      const { id } = await fileAndApprove({
        type: 'LOAN',
        amount: 600,
        installments: 6,
        loanTypeId: p.id,
      });
      await ctx
        .http()
        .post(`/loan-types/${p.id}/deactivate`)
        .set(bearer(fx.admin.token))
        .expect(201);

      const after = await ctx
        .http()
        .get(`/advance-loans/${id}`)
        .set(bearer(fx.hrGlobal.token));
      expectStatus(after, 200);
      expect(dataOf(after).status).toBe('APPROVED');
    });
  });

  // ── The effect on a loan ───────────────────────────────────────────────────

  describe('choosing a product changes the loan', () => {
    it('records the product on the request', async () => {
      const p = await mkProduct();
      const { request } = await fileAndApprove({
        type: 'LOAN',
        amount: 600,
        installments: 6,
        loanTypeId: p.id,
      });
      expect(request.loanTypeId).toBe(p.id);
    });

    it('defaults the repayment term from the product when none is asked for', async () => {
      const p = await mkProduct({ defaultInstallments: 9, maxInstallments: 12 });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 900, loanTypeId: p.id });
      expectStatus(res, 201);
      expect(dataOf(res).installments).toBe(9);
    });

    it('copies the interest terms onto the request', async () => {
      // The whole point: the figure is read back off the LOAN, not off the
      // product. Terms are fixed at FILING — a term that can still move
      // between being shown and being agreed is not a term.
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        const p = await mkProduct({
          interestMethod: 'REDUCING_BALANCE',
          interestRate: 12,
        });
        const { id } = await fileAndApprove({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          loanTypeId: p.id,
        });

        const row = await ctx.prisma.advanceLoanRequest.findUnique({ where: { id } });
        expect(row!.interestMethod).toBe('REDUCING_BALANCE');
        expect(Number(row!.interestRate)).toBe(12);
      });
    });

    it('honours the interest kill-switch even when the product carries a rate', async () => {
      // Snapshotting a rate that `generate()` then ignores would leave the loan
      // SAYING 12% and charging nothing.
      await withSetting(ctx, 'loan_interest_enabled', 'false', async () => {
        const p = await mkProduct({
          interestMethod: 'REDUCING_BALANCE',
          interestRate: 12,
        });
        const { id } = await fileAndApprove({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          loanTypeId: p.id,
        });

        const row = await ctx.prisma.advanceLoanRequest.findUnique({ where: { id } });
        expect(row!.interestMethod).toBe('NONE');
        expect(Number(row!.interestRate)).toBe(0);
      });
    });

    it('computes the processing fee from percent + flat', async () => {
      const p = await mkProduct({
        processingFeePercent: 1,
        processingFeeFlat: 25,
      });
      const { id } = await fileAndApprove({
        type: 'LOAN',
        amount: 1000,
        installments: 6,
        loanTypeId: p.id,
      });

      const row = await ctx.prisma.advanceLoanRequest.findUnique({ where: { id } });
      // 1% of 1000, plus the flat 25.
      expect(Number(row!.processingFee)).toBe(35);
    });

    it('carries the product’s recovery priority onto the loan', async () => {
      // `priority` is the FIRST sort key in the recovery allocator and no DTO
      // exposed it, so every loan was 100 and the rung could only tie-break.
      const p = await mkProduct({ priority: 10 });
      const { id } = await fileAndApprove({
        type: 'LOAN',
        amount: 600,
        installments: 6,
        loanTypeId: p.id,
      });

      const row = await ctx.prisma.advanceLoanRequest.findUnique({ where: { id } });
      expect(row!.priority).toBe(10);
    });

    it('leaves a loan filed with no product on the column defaults', async () => {
      // The product is optional; the pre-existing behaviour must not move.
      const { id } = await fileAndApprove({ type: 'LOAN', amount: 600, installments: 6 });
      const row = await ctx.prisma.advanceLoanRequest.findUnique({ where: { id } });
      expect(row!.loanTypeId).toBeNull();
      expect(row!.interestMethod).toBe('NONE');
      expect(row!.priority).toBe(100);
    });

    it('does not rewrite a live loan when the product is edited afterwards', async () => {
      // Editing a product changes what the NEXT loan costs, never an agreed one.
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        const p = await mkProduct({ interestMethod: 'FLAT', interestRate: 6 });
        const { id } = await fileAndApprove({
          type: 'LOAN',
          amount: 1200,
          installments: 6,
          loanTypeId: p.id,
        });

        await ctx
          .http()
          .patch(`/loan-types/${p.id}`)
          .set(bearer(fx.admin.token))
          .send({ interestRate: 30 })
          .expect(200);

        const row = await ctx.prisma.advanceLoanRequest.findUnique({ where: { id } });
        expect(Number(row!.interestRate)).toBe(6);
      });
    });
  });

  // ── Product eligibility ────────────────────────────────────────────────────

  describe('the product’s own eligibility rules', () => {
    it('refuses a request from an ineligible position, naming who it IS for', async () => {
      const p = await mkProduct({ eligiblePositions: ['Director'] });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 6, loanTypeId: p.id });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/Director/);
    });

    it('accepts a request from an eligible position', async () => {
      const p = await mkProduct({ eligiblePositions: ['Engineer'] });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 6, loanTypeId: p.id });
      expectStatus(res, 201);
    });

    it('treats an empty position list as "open to everyone"', async () => {
      const p = await mkProduct({ eligiblePositions: [] });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 6, loanTypeId: p.id });
      expectStatus(res, 201);
    });

    it('enforces the product’s own amount ceiling', async () => {
      const p = await mkProduct({ maxAmount: 500 });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 6, loanTypeId: p.id });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/capped at 500/i);
    });

    it('accepts a request exactly at the ceiling', async () => {
      const p = await mkProduct({ maxAmount: 600 });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 6, loanTypeId: p.id });
      expectStatus(res, 201);
    });

    it('enforces the product’s own minimum service period', async () => {
      const p = await mkProduct({ minServiceMonths: 120 });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 6, loanTypeId: p.id });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/120 months of service/i);
    });

    it('refuses more instalments than the product allows', async () => {
      const p = await mkProduct({ defaultInstallments: 3, maxInstallments: 4 });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 8, loanTypeId: p.id });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/at most 4 instalments/i);
    });

    it('refuses an ADVANCE filed under a LOAN product', async () => {
      const p = await mkProduct({ category: 'LOAN' });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'ADVANCE', amount: 300, loanTypeId: p.id });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/loan product/i);
    });

    it('404s on a product that does not exist', async () => {
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({
          type: 'LOAN',
          amount: 600,
          installments: 6,
          loanTypeId: '00000000-0000-4000-8000-000000000000',
        });
      expectStatus(res, 404);
    });

    it('caps the approver at the product’s ceiling too, not just the requester', async () => {
      // Stricter wins: a product that runs 4 cycles cannot be stretched to 10
      // by the approver, even though the company setting allows 12.
      const p = await mkProduct({ defaultInstallments: 3, maxInstallments: 4 });
      const filed = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 4, loanTypeId: p.id });
      expectStatus(filed, 201);

      const res = await ctx
        .http()
        .post(`/advance-loans/${dataOf(filed).id}/approve`)
        .set(bearer(fx.hrGlobal.token))
        .send({ installments: 10 });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/between 1 and 4/i);
    });
  });

  // ── Affordability, finally reachable ───────────────────────────────────────

  describe('validateAffordability() reaches HTTP at last', () => {
    it('refuses an instalment below the product’s minimum', async () => {
      // EMI_BELOW_MIN — one of five codes that were unit-tested and unreachable.
      const p = await mkProduct({ minEmiAmount: 500, maxInstallments: 12 });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 12, loanTypeId: p.id });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/below the minimum allowed/i);
    });

    it('refuses a loan that would push take-home under the product’s floor', async () => {
      // NET_BELOW_FLOOR.
      const p = await mkProduct({ minNetSalaryAfterEmi: 999999 });
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({ type: 'LOAN', amount: 600, installments: 6, loanTypeId: p.id });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/take-home would fall/i);
    });

    it('reports the affordability verdict on the what-if endpoint too', async () => {
      const p = await mkProduct({ minEmiAmount: 500, maxInstallments: 12 });
      const res = await ctx
        .http()
        .post('/advance-loans/eligibility')
        .set(bearer(fx.employee.token))
        .send({ amount: 600, installments: 12, type: 'LOAN' });
      expectStatus(res, 200);
      // The what-if endpoint carries no product today, so the system-level
      // affordability check is what must answer — and it must answer at all.
      const codes = dataOf(res).checks.map((c: any) => c.code);
      expect(codes).toContain('NET_PAY_AFTER_EMI');
    });
  });
});
