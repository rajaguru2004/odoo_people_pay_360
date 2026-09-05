import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * The branch level of the loan policy chain.
 *
 * `LoanPolicy(branchId)` → `LoanPolicy(null)` → `SystemSetting` → built-in
 * default is the documented resolution order, and the first rung was
 * unreachable: `prisma.loanPolicy` was only ever `findMany`'d inside
 * `resolve()`, with no route to create a row. Worse, six of its columns had no
 * reader at all, so even a hand-inserted row would have changed nothing —
 * which is why this suite spends most of its time proving EFFECT rather than
 * storage.
 */
describe('Finance — branch loan policy (e2e)', () => {
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

  const upsert = (payload: Record<string, unknown>, token = fx.admin.token) =>
    ctx.http().post('/loan-policies').set(bearer(token)).send(payload);

  const effective = (branchId?: string, token = fx.admin.token) =>
    ctx
      .http()
      .get(`/loan-policies/effective${branchId ? `?branchId=${branchId}` : ''}`)
      .set(bearer(token));

  const clearPolicies = () =>
    ctx.prisma.loanPolicy.deleteMany({
      where: { OR: [{ branchId: fx.branchA }, { branchId: fx.branchB }, { branchId: null }] },
    });

  const purgeLoans = async () => {
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
    await clearPolicies();
  });

  afterEach(async () => {
    await clearPolicies();
    await purgeLoans();
  });

  afterAll(async () => {
    await clearPolicies();
    await purgeLoans();
    await fx.cleanup();
    await ctx.app.close();
  });

  describe('the door', () => {
    it.each([
      ['hrGlobal', () => fx.hrGlobal.token],
      ['manager', () => fx.manager.token],
      ['employee', () => fx.employee.token],
    ])('%s cannot write a policy', async (_who, token) => {
      const res = await upsert({ branchId: fx.branchA, minServiceMonths: 6 }, token());
      expectStatus(res, 403);
    });

    it('HR may read the effective policy — it explains refusals they have to relay', async () => {
      const res = await effective(fx.branchA, fx.hrGlobal.token);
      expectStatus(res, 200);
    });

    it('an employee may not', async () => {
      const res = await effective(fx.branchA, fx.employee.token);
      expectStatus(res, 403);
    });

    it('refuses a malformed branch id rather than answering a driver 500', async () => {
      const res = await ctx
        .http()
        .get('/loan-policies/effective?branchId=not-a-uuid')
        .set(bearer(fx.admin.token));
      expectStatus(res, 400);
    });
  });

  describe('storing a policy', () => {
    it('creates a branch row and reads it back', async () => {
      const res = await upsert({ branchId: fx.branchA, minServiceMonths: 6 });
      expectStatus(res, 201);
      expect(dataOf(res).branchId).toBe(fx.branchA);
      expect(dataOf(res).minServiceMonths).toBe(6);
    });

    it('upserts rather than duplicating — a branch has exactly one policy', async () => {
      await upsert({ branchId: fx.branchA, minServiceMonths: 6 });
      const second = await upsert({ branchId: fx.branchA, minServiceMonths: 9 });
      expectStatus(second, 201);

      const rows = await ctx.prisma.loanPolicy.findMany({
        where: { branchId: fx.branchA },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].minServiceMonths).toBe(9);
    });

    it('leaves untouched fields alone on a second write', async () => {
      await upsert({ branchId: fx.branchA, minServiceMonths: 6, maxActivePerEmployee: 1 });
      await upsert({ branchId: fx.branchA, minServiceMonths: 9 });

      const row = await ctx.prisma.loanPolicy.findFirst({ where: { branchId: fx.branchA } });
      expect(row!.maxActivePerEmployee).toBe(1);
    });

    it('accepts an explicit null as "stop overriding this"', async () => {
      // Without this a branch could never hand a decision back to the company.
      await upsert({ branchId: fx.branchA, minServiceMonths: 6 });
      await upsert({ branchId: fx.branchA, minServiceMonths: null });

      const row = await ctx.prisma.loanPolicy.findFirst({ where: { branchId: fx.branchA } });
      expect(row!.minServiceMonths).toBeNull();
    });

    it('refuses a value outside the allowed set', async () => {
      const res = await upsert({ branchId: fx.branchA, shortfallPolicy: 'BANANA' });
      expectStatus(res, 400);
    });

    it('refuses a role list that is not a role list', async () => {
      const res = await upsert({ branchId: fx.branchA, writeOffRoles: 'admin; drop table' });
      expectStatus(res, 400);
    });

    it('deletes a policy, returning the branch to the company rules', async () => {
      const made = await upsert({ branchId: fx.branchA, minServiceMonths: 6 });
      const res = await ctx
        .http()
        .delete(`/loan-policies/${dataOf(made).id}`)
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);

      const row = await ctx.prisma.loanPolicy.findFirst({ where: { branchId: fx.branchA } });
      expect(row).toBeNull();
    });
  });

  describe('the chain resolves in the documented order', () => {
    it('falls back to the system setting when no row exists', async () => {
      await withSetting(ctx, 'loan_min_service_months', '4', async () => {
        const res = await effective(fx.branchA);
        expectStatus(res, 200);
        expect(dataOf(res).effective.minServiceMonths).toBe(4);
      });
    });

    it('lets the global row beat the setting', async () => {
      await withSetting(ctx, 'loan_min_service_months', '4', async () => {
        await upsert({ minServiceMonths: 7 });
        const res = await effective(fx.branchA);
        expect(dataOf(res).effective.minServiceMonths).toBe(7);
      });
    });

    it('lets the branch row beat the global row', async () => {
      await withSetting(ctx, 'loan_min_service_months', '4', async () => {
        await upsert({ minServiceMonths: 7 });
        await upsert({ branchId: fx.branchA, minServiceMonths: 12 });

        const forA = await effective(fx.branchA);
        expect(dataOf(forA).effective.minServiceMonths).toBe(12);

        // …and leaves another branch on the global answer.
        const forB = await effective(fx.branchB);
        expect(dataOf(forB).effective.minServiceMonths).toBe(7);
      });
    });

    it('shows the stored row and the resolved answer separately', async () => {
      // A screen showing only the row would show mostly nulls and explain
      // nothing; showing only the resolution would hide what this branch chose.
      await upsert({ branchId: fx.branchA, minServiceMonths: 12 });
      const res = await effective(fx.branchA);

      expect(dataOf(res).policy.minServiceMonths).toBe(12);
      expect(dataOf(res).policy.maxActivePerEmployee).toBeNull();
      expect(dataOf(res).effective.maxActivePerEmployee).toBeGreaterThan(0);
    });
  });

  describe('the six columns that had no reader now decide something', () => {
    const file = (payload: Record<string, unknown>) =>
      ctx.http().post('/advance-loans').set(bearer(fx.employee.token)).send(payload);

    it('minServiceMonths — a branch can demand longer service than the company', async () => {
      await withSetting(ctx, 'loan_min_service_months', '0', async () => {
        await upsert({ branchId: fx.branchA, minServiceMonths: 600 });

        const res = await file({ type: 'LOAN', amount: 600, installments: 6 });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/service/i);
      });
    });

    it('maxActivePerEmployee — a branch can allow fewer live loans', async () => {
      await withSetting(ctx, 'loan_max_active_per_employee', '5', async () => {
        await upsert({ branchId: fx.branchA, maxActivePerEmployee: 1 });

        const first = await file({ type: 'ADVANCE', amount: 100 });
        expectStatus(first, 201);

        const second = await file({ type: 'ADVANCE', amount: 100 });
        expectStatus(second, 400);
        expect(body(second)).toMatch(/active advance\/loan record/i);
      });
    });

    it('maxAmountMultipleOfSalary — a branch can cap the amount', async () => {
      await withSetting(ctx, 'loan_max_amount_multiple_of_salary', '0', async () => {
        // The fixture earner is on 1000/month, so 0.5x is 500.
        await upsert({ branchId: fx.branchA, maxAmountMultipleOfSalary: 0.5 });

        const res = await file({ type: 'LOAN', amount: 5000, installments: 6 });
        expectStatus(res, 400);
      });
    });

    it('interestDefaultMethod — a branch can set the default terms', async () => {
      await withSetting(ctx, 'loan_interest_enabled', 'true', async () => {
        await upsert({ branchId: fx.branchA, interestDefaultMethod: 'FLAT' });

        const res = await effective(fx.branchA);
        expect(dataOf(res).effective.interestDefaultMethod).toBe('FLAT');
      });
    });

    it('writeOffRoles — a branch can narrow who may forgive money', async () => {
      // The company allows ADMIN; this branch allows nobody but HR, so an
      // ADMIN is refused HERE while remaining an admin everywhere else.
      const loan = await ctx.prisma.advanceLoanRequest.create({
        data: {
          employeeId: fx.earnerId,
          type: 'LOAN',
          amount: 1000,
          installments: 5,
          installmentAmount: 200,
          status: 'ACTIVE',
        },
      });

      await upsert({ branchId: fx.branchA, writeOffRoles: 'HR_MANAGER' });

      const res = await ctx
        .http()
        .post(`/advance-loans/${loan.id}/write-off`)
        .set(bearer(fx.admin.token))
        .send({ reason: 'A reason long enough to satisfy the rule' });
      expectStatus(res, 403);
      expect(body(res)).toMatch(/this branch does not permit/i);
    });

    it('a branch cannot WIDEN authority past the company list', async () => {
      // Stricter-wins: the global gate runs first, so naming HR here does not
      // let HR write off when the company says ADMIN only.
      const loan = await ctx.prisma.advanceLoanRequest.create({
        data: {
          employeeId: fx.earnerId,
          type: 'LOAN',
          amount: 1000,
          installments: 5,
          installmentAmount: 200,
          status: 'ACTIVE',
        },
      });

      await withSetting(ctx, 'advance_loan_writeoff_roles', 'ADMIN', async () => {
        await upsert({ branchId: fx.branchA, writeOffRoles: 'ADMIN,HR_MANAGER' });

        const res = await ctx
          .http()
          .post(`/advance-loans/${loan.id}/write-off`)
          .set(bearer(fx.hrGlobal.token))
          .send({ reason: 'A reason long enough to satisfy the rule' });
        expectStatus(res, 403);
      });
    });

    it('waiverRoles — same rule for waivers', async () => {
      const loan = await ctx.prisma.advanceLoanRequest.create({
        data: {
          employeeId: fx.earnerId,
          type: 'LOAN',
          amount: 1000,
          installments: 5,
          installmentAmount: 200,
          status: 'ACTIVE',
        },
      });

      await upsert({ branchId: fx.branchA, waiverRoles: 'ADMIN' });

      const res = await ctx
        .http()
        .post(`/advance-loans/${loan.id}/waive`)
        .set(bearer(fx.hrGlobal.token))
        .send({ reason: 'A reason long enough', waiveType: 'INTEREST' });
      expectStatus(res, 403);
      expect(body(res)).toMatch(/this branch does not permit/i);
    });
  });

  describe('the two documented defaults now agree', () => {
    it('maxTotalDeductionPercentOfNet resolves to 50, not 100', async () => {
      // The hardcoded fallback said 100 and the seeded setting said 50, so the
      // pair disagreed and the setting silently won — the fallback only
      // surfaced on a database whose settings row was missing.
      const res = await effective();
      expectStatus(res, 200);
      expect(dataOf(res).effective.maxTotalDeductionPercentOfNet).toBe(50);
    });
  });
});
