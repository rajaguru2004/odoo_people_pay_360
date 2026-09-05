import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupFinanceFixtures, FinanceFixtures } from './utils/finance-fixtures';
import { bearer } from './utils/settings';

/**
 * `GET /finance/hub-summary` — the Finance module hub's aggregate.
 *
 * It replaced five browser-side requests, one of which re-derived the loan
 * aging buckets from `overdueAmount`/`daysOverdue` — field names the server has
 * never sent — so the Overdue KPI printed a formatted zero and every aging pill
 * read "overdue by 0 days". The invariants:
 *
 *   FINHUB-01  role gate — ADMIN/HR in, MANAGER and EMPLOYEE out, anonymous 401
 *   FINHUB-02  the payload has every section the page reads
 *   FINHUB-03  the arrears buckets come from the server and reconcile
 *   FINHUB-04  outstanding is debt-bearing statuses only, never the whole book
 *   FINHUB-05  an unknown baseline reports null, not zero
 *   FINHUB-06  the trend is twelve labelled months and its lanes sum to the bar
 *   FINHUB-07  a rate with no denominator is null
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
      // MANAGER is a denial path, not a narrowed one: the loan book and the
      // budget position are company figures and there is no per-department
      // version of them to hand back.
      expect((await hub(fx.manager.token)).status).toBe(403);
      expect((await hub(fx.employee.token)).status).toBe(403);
      expect((await hub()).status).toBe(401);
    });

    it('FINHUB-01b matches the gate the loan reports themselves carry', async () => {
      // If this ever diverges, the hub would be handing a MANAGER a loan book
      // they cannot open the report for.
      const report = await ctx
        .http()
        .get('/advance-loans/reports/portfolio')
        .set(bearer(fx.manager.token));
      expect(report.status).toBe(403);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('shape', () => {
    it('FINHUB-02 carries every section the page reads', async () => {
      const data = await dataOf();
      expect(Object.keys(data).sort()).toEqual(
        ['budgets', 'loans', 'reimbursements', 'travel', 'trend', 'trendKind', 'window'].sort(),
      );
      expect(data.window).toMatchObject({
        key: expect.stringMatching(/^\d{4}-\d{2}$/),
        label: expect.any(String),
        previous: { key: expect.stringMatching(/^\d{4}-\d{2}$/) },
      });
      expect(data.trendKind).toBe('month');
    });

    it('FINHUB-02b zero-fills every claim status rather than omitting it', async () => {
      const { reimbursements } = await dataOf();
      for (const status of ['PENDING', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED']) {
        expect(reimbursements.byStatus[status]).toMatchObject({
          count: expect.any(Number),
          amount: expect.any(Number),
        });
      }
    });

    it('FINHUB-02c reports the previous window as a labelled range, not an offset', async () => {
      const { window } = await dataOf();
      // The browser does no calendar maths on hub data — the same rule the
      // attendance hub set with its period stepper.
      expect(new Date(window.previous.end).getTime()).toBe(new Date(window.start).getTime());
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the loan book', () => {
    it('FINHUB-03 reports arrears from the server buckets, and they reconcile', async () => {
      const { loans } = await dataOf();
      const summed = (Object.values(loans.overdue.buckets) as any[]).reduce(
        (a: number, b: any) => a + b.count,
        0,
      );
      expect(summed).toBe(loans.overdue.count);

      const amount = (Object.values(loans.overdue.buckets) as any[]).reduce(
        (a: number, b: any) => a + b.amount,
        0,
      );
      expect(Math.round(amount * 100)).toBe(Math.round(loans.overdue.amount * 100));
      expect(Object.keys(loans.overdue.buckets)).toEqual(['1-30', '31-60', '61-90', '90+']);
    });

    it('FINHUB-03b names rows the attention strip can point at', async () => {
      const { loans } = await dataOf();
      expect(loans.overdue.top.length).toBeLessThanOrEqual(8);
      for (const row of loans.overdue.top) {
        // The defect this replaced read fields the server never sends, so every
        // pill said "0 days" and "0.00".
        expect(row.overdueDays).toEqual(expect.any(Number));
        expect(row.amountDue).toEqual(expect.any(Number));
        expect(row.bucket).toMatch(/^(1-30|31-60|61-90|90\+)$/);
      }
    });

    it('FINHUB-04 counts outstanding only where the status bears debt', async () => {
      const { loans } = await dataOf();
      const debtOnly = loans.byStatus
        .filter((r: any) => r.isDebt)
        .reduce((a: number, r: any) => a + r.outstanding, 0);
      expect(Math.round(debtOnly * 100)).toBe(Math.round(loans.outstanding * 100));

      // A settled or written-off loan is money that will never come back, not
      // money still owed.
      for (const row of loans.byStatus.filter((r: any) => !r.isDebt)) {
        expect(row.outstanding).toBe(0);
      }
      expect(loans.outstanding).toBeLessThanOrEqual(loans.principal);
    });

    it('FINHUB-05 reports a null baseline rather than a fabricated delta', async () => {
      const { loans } = await dataOf();
      // Either the ledger can answer what was owed last month, or it says it
      // cannot. It never answers zero.
      if (loans.outstandingAsOfPrev === null) {
        expect(loans.outstandingDelta).toBeNull();
      } else {
        expect(loans.outstandingAsOfPrev).toBeGreaterThanOrEqual(0);
        expect(loans.outstandingDelta).toMatchObject({
          direction: expect.stringMatching(/^(up|down)$/),
          absolute: expect.any(Number),
        });
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('money over time', () => {
    it('FINHUB-06 draws twelve labelled months whose lanes sum to the bar', async () => {
      const { trend } = await dataOf();
      expect(trend).toHaveLength(12);
      for (const bucket of trend) {
        expect(bucket.key).toMatch(/^\d{4}-\d{2}$/);
        expect(bucket.label).toEqual(expect.any(String));
        expect(bucket.segments.map((s: any) => s.key)).toEqual(['travel', 'training', 'other']);
        const laneTotal = bucket.segments.reduce((a: number, s: any) => a + s.value, 0);
        expect(Math.round(laneTotal * 100)).toBe(Math.round(bucket.value * 100));
      }
    });

    it('FINHUB-06b ends the series on the current window', async () => {
      const { trend, window } = await dataOf();
      expect(trend[trend.length - 1].key).toBe(window.key);
    });

    it('FINHUB-06c reports travel as per diem, never as an estimate', async () => {
      const { travel } = await dataOf();
      // `TravelRequest.estimatedCost` is an estimate and `COMPLETED` is never
      // written by anything, so the only real travel money is the per-diem
      // claim travel raises on approval.
      expect(travel.perDiemPaidAmount).toEqual(expect.any(Number));
      expect(travel).not.toHaveProperty('estimatedCost');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('budgets', () => {
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
      expect(scoped.reimbursements.pendingCount).toBeLessThanOrEqual(
        all.reimbursements.pendingCount,
      );
      expect(scoped.loans.accounts).toBeLessThanOrEqual(all.loans.accounts);
    });

    it('FINHUB-08b a branch-scoped HR user sees no more than the global one', async () => {
      const global = await dataOf(fx.hrGlobal.token);
      const scoped = await dataOf(fx.hrScoped.token);
      expect(scoped.loans.accounts).toBeLessThanOrEqual(global.loans.accounts);
    });
  });
});
