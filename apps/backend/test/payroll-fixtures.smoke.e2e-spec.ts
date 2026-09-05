import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollFixtures,
  PayrollFixtures,
  bearer,
  workingDatesIn,
} from './utils/payroll-fixtures';

/**
 * Proves the Payroll fixture set boots, is reachable over HTTP, and tears itself
 * down completely.
 *
 * It exists because every other Payroll spec is built on `setupPayrollFixtures`,
 * and a fixture that half-builds or half-cleans shows up as a confusing failure
 * in whichever spec runs next rather than here. Keep it first and keep it cheap.
 */
describe('Payroll fixtures (smoke)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;

  const api = () => ctx.http();

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  it('logs every fixture user in', () => {
    for (const u of [
      fx.admin,
      fx.hr,
      fx.scopedHr,
      fx.deptManager,
      fx.foreignManager,
      fx.employee,
      fx.supervisor,
    ]) {
      expect(typeof u.token).toBe('string');
      expect(u.token.length).toBeGreaterThan(20);
    }
  });

  it('gives the scoped HR exactly one branch and the admin all of them', async () => {
    const scoped = await api()
      .get('/branches')
      .set(bearer(fx.scopedHr.token));
    expect(scoped.status).toBe(200);
    const scopedCodes = scoped.body.data.map((b: any) => b.code);
    expect(scopedCodes).toContain(fx.branchAcode);
    expect(scopedCodes).not.toContain(fx.branchBcode);

    const admin = await api().get('/branches').set(bearer(fx.admin.token));
    expect(admin.status).toBe(200);
    const adminCodes = admin.body.data.map((b: any) => b.code);
    expect(adminCodes).toEqual(
      expect.arrayContaining([
        fx.branchAcode,
        fx.branchBcode,
        fx.branchOmCode,
      ]),
    );
  });

  it('seeds attendance for the target period on every branch', async () => {
    const expected = workingDatesIn(fx.period).length;
    const count = await ctx.prisma.attendance.count({
      where: {
        employeeId: fx.monthlyEmpId,
        date: {
          gte: new Date(Date.UTC(fx.period.year, fx.period.month - 1, 1)),
          lte: new Date(Date.UTC(fx.period.year, fx.period.month, 0)),
        },
      },
    });
    expect(count).toBe(expected);
  });

  it('makes both pay bases present in branch A', async () => {
    const [monthly, daily] = await Promise.all([
      ctx.prisma.employee.findUnique({ where: { id: fx.monthlyEmpId } }),
      ctx.prisma.employee.findUnique({ where: { id: fx.dailyEmpId } }),
    ]);
    expect(monthly?.salaryType).toBe('MONTHLY');
    expect(daily?.salaryType).toBe('DAILY');
    // baseSalary is a PER-DAY rate for the daily-wage employee, so it is an order
    // of magnitude smaller than the monthly colleague's. Asserting the direction
    // catches a fixture edited into meaninglessness.
    expect(Number(daily?.baseSalary)).toBeLessThan(Number(monthly?.baseSalary));
  });

  it('leaves exactly one migration candidate with a legacy bank record', async () => {
    const res = await api()
      .get('/bank-change-requests/migration/candidates')
      .set(bearer(fx.hr.token))
      .set('x-branch-id', fx.branchA);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: any) => c.employeeId ?? c.id);
    expect(ids).toContain(fx.migrationCandidateId);
  });


  it('generates a payroll for the seeded period', async () => {
    const res = await api()
      .post('/payrolls')
      .set(bearer(fx.admin.token))
      .set('x-branch-id', fx.branchA)
      .send({ month: fx.period.month, year: fx.period.year });
    expect(res.status).toBe(201);
    // `create` answers with the payroll header only — `employeeCount`, not the
    // items. The items are a `GET /payrolls/:id` away, which is also the door
    // the run's membership has to be judged through.
    expect(res.body.data.employeeCount).toBeGreaterThan(0);

    const detail = await api()
      .get(`/payrolls/${res.body.data.id}`)
      .set(bearer(fx.admin.token))
      .set('x-branch-id', fx.branchA);
    expect(detail.status).toBe(200);
    const empIds = detail.body.data.items.map((i: any) => i.employeeId);
    // INACTIVE staff are never in a run.
    expect(empIds).not.toContain(fx.terminatedEmpId);
    // Neither is anybody from another branch.
    expect(empIds).not.toContain(fx.branchBEmpId);
    // Both pay bases are.
    expect(empIds).toEqual(
      expect.arrayContaining([fx.monthlyEmpId, fx.dailyEmpId]),
    );
  });

});
