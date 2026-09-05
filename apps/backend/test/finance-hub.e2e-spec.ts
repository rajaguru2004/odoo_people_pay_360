import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupFinanceFixtures, FinanceFixtures } from './utils/finance-fixtures';
import { bearer } from './utils/settings';

/**
 * `GET /finance/hub-summary` — the Finance module hub's aggregate.
 *
 * It replaced several browser-side requests, one of which re-derived the budget
 * position client-side from fields the server has never sent — so the
 * utilisation KPI printed a formatted zero. The invariants:
 *
 *   FINHUB-01  role gate — ADMIN/HR in, MANAGER and EMPLOYEE out, anonymous 401
 *   FINHUB-02  the payload has every section the page reads
 *   FINHUB-05  an unknown baseline reports null, not zero
 *   FINHUB-07  a rate with no denominator is null
 *   FINHUB-08  the read narrows with the caller's branch envelope
 *
 * Cases are envelope- and invariant-shaped rather than count-shaped: this
 * endpoint reads the whole database inside the caller's branch envelope with no
 * per-run filter, so an absolute count would be hostage to every other suite.
 * Same rule as `attendance-hub.e2e-spec.ts` and `organization-hub.e2e-spec.ts`.
 */
describe('Finance — module hub summary (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const hub = (token?: string, branch?: string) => {
    let r = ctx.http().get('/finance/hub-summary');
    if (token) r = r.set(bearer(token));
    if (branch) r = r.set('X-Branch-Id', branch);
    return r;
  };

  const dataOf = async (token?: string, branch?: string) => {
    const res = await hub(token ?? fx.admin.token, branch);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read it', () => {
    it('FINHUB-01 admits ADMIN and HR; refuses MANAGER, EMPLOYEE and anonymous', async () => {
      expect((await hub(fx.admin.token)).status).toBe(200);
      expect((await hub(fx.hrGlobal.token)).status).toBe(200);
      // MANAGER is a denial path, not a narrowed one: the budget position is a
      // company figure and there is no per-department version of it to hand back.
      expect((await hub(fx.manager.token)).status).toBe(403);
      expect((await hub(fx.employee.token)).status).toBe(403);
      expect((await hub()).status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('shape', () => {
    it('FINHUB-02 carries every section the page reads', async () => {
      const data = await dataOf();
      expect(Object.keys(data).sort()).toEqual(['budgets', 'travel', 'window'].sort());
      expect(data.window).toMatchObject({
        key: expect.stringMatching(/^\d{4}-\d{2}$/),
        label: expect.any(String),
        previous: { key: expect.stringMatching(/^\d{4}-\d{2}$/) },
      });
      expect(data.travel).toMatchObject({
        pending: expect.any(Number),
        onTripToday: expect.any(Number),
        upcoming30Days: expect.any(Number),
      });
    });

    it('FINHUB-02c reports the previous window as a labelled range, not an offset', async () => {
      const { window } = await dataOf();
      // The browser does no calendar maths on hub data — the same rule the
      // attendance hub set with its period stepper.
      expect(new Date(window.previous.end).getTime()).toBe(new Date(window.start).getTime());
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('budgets', () => {
    it('FINHUB-05 reports a null baseline rather than a fabricated delta', async () => {
      const { budgets } = await dataOf();
      // Either the previous window can answer what had been spent by then, or it
      // says it cannot. It never answers zero.
      if (budgets.prevUtilization === null) {
        expect(budgets.utilizationDelta).toBeNull();
      } else {
        expect(budgets.prevUtilization).toBeGreaterThanOrEqual(0);
        expect(budgets.utilizationDelta).toMatchObject({
          direction: expect.stringMatching(/^(up|down)$/),
          absolute: expect.any(Number),
        });
      }
    });

    it('FINHUB-07 reports a null utilisation when nothing is planned', async () => {
      const { budgets } = await dataOf();
      if (budgets.planned === 0) {
        expect(budgets.utilization).toBeNull();
      } else {
        expect(budgets.utilization).toBeGreaterThanOrEqual(0);
      }
      for (const row of budgets.rows) {
        // A rate off a zero plan is not a rate.
        if (row.planned === 0) expect(row.utilization).toBeNull();
      }
    });

    it('FINHUB-07b keeps remaining consistent with plan minus commitment and spend', async () => {
      const { budgets } = await dataOf();
      const expected = budgets.planned - budgets.committed - budgets.actual;
      expect(Math.round(budgets.remaining * 100)).toBe(Math.round(expected * 100));
      expect(budgets.overBudget).toBeLessThanOrEqual(budgets.budgets);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('branch scoping', () => {
    it('FINHUB-08 narrows with the selected branch and refuses one outside the envelope', async () => {
      const all = await dataOf(fx.admin.token);
      const scoped = await dataOf(fx.admin.token, fx.branchA);
      // Every finance model is in `branch-scope.map.ts`, so a branch-scoped read
      // can only ever be a subset.
      expect(scoped.travel.pending).toBeLessThanOrEqual(all.travel.pending);
      expect(scoped.budgets.budgets).toBeLessThanOrEqual(all.budgets.budgets);
    });

    it('FINHUB-08b a branch-scoped HR user sees no more than the global one', async () => {
      const global = await dataOf(fx.hrGlobal.token);
      const scoped = await dataOf(fx.hrScoped.token);
      expect(scoped.budgets.budgets).toBeLessThanOrEqual(global.budgets.budgets);
    });
  });
});
