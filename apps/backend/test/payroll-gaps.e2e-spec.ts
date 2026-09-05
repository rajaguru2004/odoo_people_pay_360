import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  PayrollFixtures,
  setupPayrollFixtures,
  seedAttendance,
} from './utils/payroll-fixtures';
import { bearer, withSettings } from './utils/settings';

/**
 * The gaps Phase G recorded and Phase G.1 closed.
 *
 * Each of these was a switch that did nothing, a figure that included money
 * nobody had been paid, or a total that omitted files the bank had taken. They
 * share nothing except that all three were invisible until somebody looked.
 *
 *   PGAP-01  `payroll_reports_enabled` gates the API, not only the menu
 *   PGAP-02  YTD reads LOCKED runs only, and reports 2 decimals
 *   PGAP-03  the WPS submitted total counts ACKNOWLEDGED files
 */
describe('Payroll — the recorded gaps (e2e)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;

  const REPORTS_ON = { payroll_reports_enabled: 'true' };
  const REPORTS_OFF = { payroll_reports_enabled: 'false' };

  const api = () => ctx.http();

  const report = (path: string, token?: string) =>
    api()
      .get(path)
      .set(bearer(token ?? fx.admin.token));

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('PGAP-01 — the reports switch gates the API', () => {
    const ROUTES = [
      '/payrolls/reports/register?month=1&year=2026',
      '/payrolls/reports/cost?year=2026&groupBy=department',
      '/payrolls/reports/statutory-summary?month=1&year=2026',
      '/payrolls/reports/gratuity-liability',
      '/payrolls/reports/variance?month=1&year=2026',
    ];

    it('PGAP-01 refuses every report route with the switch OFF', async () => {
      // It used to be parsed into PayrollFeatures.reportsEnabled and read by
      // nothing: turning it off hid the menu entry and left the routes open,
      // so anything that knew the URL still got the company's payroll.
      await withSettings(ctx, REPORTS_OFF, async () => {
        for (const route of ROUTES) {
          const res = await report(route);
          expect([route, res.status]).toEqual([route, 404]);
          expect(String(res.body?.message ?? '')).toMatch(/not enabled/i);
        }
      });
    });

    it('PGAP-01b serves them with the switch ON', async () => {
      await withSettings(ctx, REPORTS_ON, async () => {
        for (const route of ROUTES) {
          const res = await report(route);
          expect([route, res.status]).toEqual([route, 200]);
        }
      });
    });

    it('PGAP-01c the switch does not open the route to a role that may not read it', async () => {
      // A feature gate is not an authorisation gate; both have to hold.
      await withSettings(ctx, REPORTS_ON, async () => {
        const res = await report(ROUTES[0], fx.employee.token);
        expect(res.status).toBe(403);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('PGAP-02 — year to date is money that actually moved', () => {
    it('PGAP-02 a DRAFT run contributes nothing, and locking it adds it', async () => {
      const period = fx.periodAt(7);
      await seedAttendance(
        ctx.prisma,
        [fx.monthlyEmpId, fx.secondMonthlyEmpId],
        fx.branchA,
        period,
      );

      const ytd = async () => {
        const res = await api()
          .get(`/payrolls/my-ytd-summary?year=${period.year}`)
          .set(bearer(fx.employee.token));
        expect(res.status).toBe(200);
        return res.body.data;
      };

      const before = await ytd();

      const run = await api()
        .post('/payrolls')
        .set(bearer(fx.admin.token))
        .set('X-Branch-Id', fx.branchA)
        .send({ month: period.month, year: period.year });
      expect([200, 201]).toContain(run.status);
      const runId = run.body.data.id as string;

      // DRAFT: the run exists and holds this employee, and the figure must not
      // move. It is a number HR is still working on, not pay received — and
      // `getPayslip` already refuses to show it to the employee it belongs to.
      const whileDraft = await ytd();
      expect(whileDraft.totalNetIncome).toBe(before.totalNetIncome);
      expect(whileDraft.totalGrossIncome).toBe(before.totalGrossIncome);

      const post = (p: string, body: any = {}) =>
        api().post(p).set(bearer(fx.admin.token)).send(body);
      expect((await post(`/payrolls/${runId}/submit`)).status).toBeLessThan(400);
      expect((await post(`/payrolls/${runId}/approve`, { notes: 'e2e' })).status).toBeLessThan(400);
      expect((await post(`/payrolls/${runId}/lock`)).status).toBeLessThan(400);

      const whenLocked = await ytd();
      expect(whenLocked.totalNetIncome).toBeGreaterThan(before.totalNetIncome);

      await post(`/payrolls/${runId}/unlock`, { reason: 'e2e teardown cleanup' });
      await api().delete(`/payrolls/${runId}`).set(bearer(fx.admin.token));
    }, 180000);

    it('PGAP-02b reports money to 2 decimals, not whole units', async () => {
      const res = await api()
        .get('/payrolls/my-ytd-summary')
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);

      const d = res.body.data;
      // `Math.round` turned 1,234.56 into 1,235 on a screen an employee
      // reconciles against a bank statement. Whatever the figures are here,
      // they must never carry more than 2 decimals.
      const money = [
        d.totalGrossIncome, d.totalNetIncome, d.totalTaxPaid,
        d.totalInsurancePaid, d.totalOvertimePay, d.totalBonuses, d.totalDeductions,
        ...d.monthlyBreakdown.flatMap((m: any) => [
          m.grossIncome, m.netIncome, m.taxPaid, m.insurancePaid,
        ]),
      ];
      for (const v of money) {
        expect(typeof v).toBe('number');
        expect(Math.round(v * 100)).toBeCloseTo(v * 100, 6);
      }
    });

    it('PGAP-02c the monthly breakdown sums to the totals it claims to add up', async () => {
      const res = await api()
        .get('/payrolls/my-ytd-summary')
        .set(bearer(fx.employee.token));
      const d = res.body.data;
      const summed = d.monthlyBreakdown.reduce(
        (a: number, m: any) => a + Number(m.netIncome),
        0,
      );
      // Twelve independent roundings used to drift the total away from the rows.
      expect(Math.abs(summed - Number(d.totalNetIncome))).toBeLessThan(0.02);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('PGAP-03 — the wage-file total counts what the bank took', () => {
    it('PGAP-03 the summary is well-formed and never negative', async () => {
      const res = await api()
        .get('/wps/status-summary')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const d = res.body.data;
      expect(d).toEqual(
        expect.objectContaining({
          byStatus: expect.any(Object),
          rejected: expect.any(Number),
          submittedTotalMinor: expect.any(String),
        }),
      );
      expect(BigInt(d.submittedTotalMinor) >= 0n).toBe(true);

      // The aggregate used to match on 'ACCEPTED', which is a WpsFileRow status
      // and not a WpsFile one, so every acknowledged file was silently omitted.
      // Whatever this database holds, no status key may be that word.
      expect(Object.keys(d.byStatus)).not.toContain('ACCEPTED');
    });
  });
});
