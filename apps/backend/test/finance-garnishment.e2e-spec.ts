import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer } from './utils/settings';

/**
 * Court orders, and the recovery ladder they complete.
 *
 * The requirement doc's headline case is "statutory deductions and garnishments
 * compete for a limited net salary". Only the statutory half was implemented;
 * the garnishment rung was `garnishment: 0`, hard-coded in
 * `payrolls.service.ts`, because there was nowhere to record that an order
 * existed. `PayrollItem.garnishment` had been a column of zeroes since v2.
 *
 * The ordering claim is structural, not a sort: payroll subtracts the order
 * from the pool BEFORE any other recovery is offered it, so nothing else can
 * reach money a court has already claimed. That is what the payroll cases here
 * check.
 */
describe('Finance — garnishment orders (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const MONTH = 7;
  const YEAR = 2031;

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

  const order = (payload: Record<string, unknown>, token = fx.hrGlobal.token) =>
    ctx.http().post('/garnishments').set(bearer(token)).send({
      employeeId: fx.earnerId,
      reference: `CIV/${Date.now().toString(36)}`,
      startDate: '2031-01-01',
      ...payload,
    });

  const runPayroll = () =>
    ctx
      .http()
      .post('/payrolls')
      .set(bearer(fx.admin.token))
      .set('X-Branch-Id', fx.branchA)
      .send({ month: MONTH, year: YEAR, employeeIds: [fx.earnerId] });

  const lock = async (payrollId: string) => {
    await ctx.http().post(`/payrolls/${payrollId}/submit`).set(bearer(fx.admin.token)).send({});
    await ctx.http().post(`/payrolls/${payrollId}/approve`).set(bearer(fx.admin.token)).send({});
    return ctx.http().post(`/payrolls/${payrollId}/lock`).set(bearer(fx.admin.token)).send({});
  };

  const itemFor = (payrollId: string) =>
    ctx.prisma.payrollItem.findFirst({
      where: { payrollId, employeeId: fx.earnerId },
    });

  const clearPayrolls = async () => {
    const ids = (
      await ctx.prisma.payroll.findMany({ where: { year: YEAR }, select: { id: true } })
    ).map((p) => p.id);
    if (!ids.length) return;
    await ctx.prisma.garnishmentDeduction.deleteMany({
      where: { payrollItemId: { not: null } },
    });
    await ctx.prisma.payrollItem.deleteMany({ where: { payrollId: { in: ids } } });
    await ctx.prisma.payroll.deleteMany({ where: { id: { in: ids } } });
  };

  const clearOrders = async () => {
    await ctx.prisma.garnishmentDeduction.deleteMany({
      where: { order: { employeeId: fx.earnerId } },
    });
    await ctx.prisma.garnishmentOrder.deleteMany({ where: { employeeId: fx.earnerId } });
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);

    // Payroll refuses a period with no processed attendance, so the earner gets
    // a full month of PRESENT days in the target cycle.
    const daysInMonth = new Date(Date.UTC(YEAR, MONTH, 0)).getUTCDate();
    await ctx.prisma.attendance.createMany({
      data: Array.from({ length: daysInMonth }, (_, i) => ({
        employeeId: fx.earnerId,
        branchId: fx.branchA,
        date: new Date(Date.UTC(YEAR, MONTH - 1, i + 1)),
        status: 'PRESENT' as const,
      })),
      skipDuplicates: true,
    });
  });

  afterEach(async () => {
    await clearPayrolls();
    await clearOrders();
  });

  afterAll(async () => {
    await clearPayrolls();
    await clearOrders();
    await ctx.prisma.attendance.deleteMany({
      where: {
        employeeId: fx.earnerId,
        date: {
          gte: new Date(Date.UTC(YEAR, MONTH - 1, 1)),
          lte: new Date(Date.UTC(YEAR, MONTH, 0)),
        },
      },
    });
    await fx.cleanup();
    await ctx.app.close();
  });

  // ── The record ────────────────────────────────────────────────────────────

  describe('recording an order', () => {
    it('stores a fixed-amount order', async () => {
      const res = await order({ amount: 100 });
      expectStatus(res, 201);
      expect(Number(dataOf(res).amount)).toBe(100);
    });

    it('stores a percentage order', async () => {
      const res = await order({ percentOfNet: 15 });
      expectStatus(res, 201);
      expect(Number(dataOf(res).percentOfNet)).toBe(15);
    });

    it('refuses an order that says both an amount and a percentage', async () => {
      const res = await order({ amount: 100, percentOfNet: 15 });
      expectStatus(res, 400);
      expect(body(res)).toMatch(/not both/i);
    });

    it('refuses an order that says neither', async () => {
      const res = await order({});
      expectStatus(res, 400);
    });

    it('refuses an order that ends before it starts', async () => {
      const res = await order({ amount: 100, startDate: '2031-06-01', endDate: '2031-01-01' });
      expectStatus(res, 400);
    });

    it.each([
      ['manager', () => fx.manager.token],
      ['employee', () => fx.employee.token],
    ])('refuses %s — an order takes pay ahead of everything else', async (_who, token) => {
      const res = await order({ amount: 100 }, token());
      expectStatus(res, 403);
    });

    it('refuses an employee in another branch', async () => {
      const res = await ctx
        .http()
        .post('/garnishments')
        .set(bearer(fx.hrScoped.token))
        .set('X-Branch-Id', fx.branchA)
        .send({
          employeeId: fx.foreignId,
          reference: 'CIV/foreign',
          amount: 100,
          startDate: '2031-01-01',
        });
      expectStatus(res, [403, 404]);
    });
  });

  // ── The ladder ────────────────────────────────────────────────────────────

  describe('what payroll does with one', () => {
    it('deducts the order and writes it on the payslip', async () => {
      // The column had been zero on every payslip ever produced.
      const made = await order({ amount: 100 });
      expectStatus(made, 201);

      const created = await runPayroll();
      expectStatus(created, 201, 'payroll create');

      const item = await itemFor(dataOf(created).id);
      expect(Number(item!.garnishment)).toBe(100);
    });

    it('takes it out of net pay', async () => {
      const noOrder = await runPayroll();
      const before = Number((await itemFor(dataOf(noOrder).id))!.netSalary);
      await clearPayrolls();

      await order({ amount: 100 });
      const withOrder = await runPayroll();
      const after = Number((await itemFor(dataOf(withOrder).id))!.netSalary);

      expect(after).toBe(before - 100);
    });

    it('never drives a payslip negative', async () => {
      await order({ amount: 999999 });

      const created = await runPayroll();
      expectStatus(created, 201);
      const item = await itemFor(dataOf(created).id);

      // The payslip is emptied, never overdrawn: what the order could not
      // take this cycle it takes in the next one.
      expect(Number(item!.netSalary)).toBe(0);
      expect(Number(item!.garnishment)).toBeGreaterThan(0);
      expect(Number(item!.garnishment)).toBeLessThan(999999);
    });

    it('ignores an order that has not started, and one that has ended', async () => {
      await order({ amount: 100, startDate: '2032-01-01' });
      await order({ amount: 100, startDate: '2030-01-01', endDate: '2030-12-31' });

      const created = await runPayroll();
      const item = await itemFor(dataOf(created).id);
      expect(Number(item!.garnishment)).toBe(0);
    });

    it('ignores a deactivated order', async () => {
      const made = await order({ amount: 100 });
      await ctx
        .http()
        .patch(`/garnishments/${dataOf(made).id}`)
        .set(bearer(fx.hrGlobal.token))
        .send({ isActive: false })
        .expect((r: any) => expectStatus(r, 200));

      const created = await runPayroll();
      const item = await itemFor(dataOf(created).id);
      expect(Number(item!.garnishment)).toBe(0);
    });
  });

  // ── Collection history ────────────────────────────────────────────────────

  describe('what a locked payroll records', () => {
    it('records the collection against the order when the run prices it, and reverses it if the draft is deleted', async () => {
      const made = await order({ amount: 100 });
      const orderId = dataOf(made).id;

      const created = await runPayroll();

      // BEHAVIOUR CHANGED IN THE MERGE, deliberately.
      //
      // This used to record at lock, on the reasoning that a draft can be
      // deleted and money that never moved must not count against a cap. The
      // carry-forward ledger needs the allocation at generation instead — a
      // shortfall has to be priced against the same net the payslip was — so
      // the collection is now written in the same transaction as the items,
      // and the cap is protected by REVERSAL rather than by deferral:
      // deleting or unlocking the run rolls each order back by exactly what
      // the ledger says it took (`PE-GARN-15`, `-16`, `-23`).
      //
      // The one visible cost is that an unlocked draft reads as collected on
      // the orders screen until it is locked or deleted.
      let row = await ctx.prisma.garnishmentOrder.findUnique({ where: { id: orderId } });
      expect(Number(row!.collected)).toBe(100);

      expectStatus(await lock(dataOf(created).id), [200, 201], 'lock');

      // Locking is idempotent against the cycle's unique (order, month, year):
      // it does not collect a second time.
      row = await ctx.prisma.garnishmentOrder.findUnique({ where: { id: orderId } });
      expect(Number(row!.collected)).toBe(100);

      const history = await ctx.prisma.garnishmentDeduction.findMany({
        where: { orderId },
      });
      expect(history).toHaveLength(1);
      expect(history[0].month).toBe(MONTH);
      expect(history[0].year).toBe(YEAR);
    });

    it('stops at the total cap', async () => {
      const made = await order({ amount: 100, totalCap: 60 });
      const orderId = dataOf(made).id;

      const created = await runPayroll();
      const item = await itemFor(dataOf(created).id);
      // Only what is left of the cap is taken, not the stated instalment.
      expect(Number(item!.garnishment)).toBe(60);

      expectStatus(await lock(dataOf(created).id), [200, 201]);
      const row = await ctx.prisma.garnishmentOrder.findUnique({ where: { id: orderId } });
      expect(Number(row!.collected)).toBe(60);
    });

    it('takes nothing once the cap is already collected', async () => {
      const made = await order({ amount: 100, totalCap: 100 });
      await ctx.prisma.garnishmentOrder.update({
        where: { id: dataOf(made).id },
        data: { collected: 100 },
      });

      const created = await runPayroll();
      const item = await itemFor(dataOf(created).id);
      expect(Number(item!.garnishment)).toBe(0);
    });
  });

  // ── Deleting ──────────────────────────────────────────────────────────────

  describe('closing an order', () => {
    it('deletes one nothing has been collected under', async () => {
      const made = await order({ amount: 100 });
      const res = await ctx
        .http()
        .delete(`/garnishments/${dataOf(made).id}`)
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
    });

    it('refuses to delete one that has taken money, and says to deactivate', async () => {
      // What was deducted from somebody's pay under a court order is not ours
      // to erase.
      const made = await order({ amount: 100 });
      await ctx.prisma.garnishmentOrder.update({
        where: { id: dataOf(made).id },
        data: { collected: 100 },
      });

      const res = await ctx
        .http()
        .delete(`/garnishments/${dataOf(made).id}`)
        .set(bearer(fx.admin.token));
      expectStatus(res, 400);
      expect(body(res)).toMatch(/deactivate it instead/i);
    });

    it('refuses HR — deleting is an admin act even though HR may create', async () => {
      const made = await order({ amount: 100 });
      const res = await ctx
        .http()
        .delete(`/garnishments/${dataOf(made).id}`)
        .set(bearer(fx.hrGlobal.token));
      expectStatus(res, 403);
    });
  });
});
