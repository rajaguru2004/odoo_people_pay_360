import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';

/**
 * Proves the payroll EDGE fixture set boots, is reachable over HTTP, and tears
 * itself down.
 *
 * Same reasoning as `payroll-fixtures.smoke.e2e-spec.ts`: every `payroll-edge-*`
 * backend spec is built on `setupPayrollEdgeFixtures`, and a fixture that
 * half-builds shows up as a confusing failure in whichever spec runs next rather
 * than here. Keep it first and keep it cheap.
 *
 * The populations it adds are the ones whose employment or attendance does NOT
 * span the period — which is precisely where the browser suite found the
 * expensive defects (G25, G31), so a fixture that quietly gave them full
 * attendance would make every later case pass for the wrong reason.
 */
describe('Payroll edge fixtures (smoke)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  it('PE-FX-01: builds every edge population', () => {
    for (const [name, id] of Object.entries({
      fullMonth: fx.fullMonthEmpId,
      noAttendance: fx.noAttendanceEmpId,
      leaveNoAttendance: fx.leaveNoAttendanceEmpId,
      joiner: fx.joinerEmpId,
      leaver: fx.leaverEmpId,
    })) {
      expect(`${name}:${id ? 'ok' : 'MISSING'}`).toBe(`${name}:ok`);
    }
  });

  it('PE-FX-02: works two years clear of the base fixture period', () => {
    // The base set owns 6/2032 and steps forward. A payroll run claims rows for
    // its whole branch and period, so two suites sharing a month is not a slow
    // test — it is a wrong one.
    expect(fx.period.year).toBeGreaterThanOrEqual(fx.base.period.year + 2);
  });

  it('PE-FX-03: only the control has attendance captured', async () => {
    const { prisma } = ctx;
    const counts = await prisma.attendance.groupBy({
      by: ['employeeId'],
      where: {
        employeeId: {
          in: [fx.fullMonthEmpId, fx.noAttendanceEmpId, fx.joinerEmpId],
        },
      },
      _count: { _all: true },
    });
    const byId = new Map(counts.map((c) => [c.employeeId, c._count._all]));

    expect(byId.get(fx.fullMonthEmpId) ?? 0).toBeGreaterThan(0);
    // These two are deliberately uncaptured. If a future change gives them rows,
    // every case about missing attendance silently stops testing anything.
    expect(byId.get(fx.noAttendanceEmpId) ?? 0).toBe(0);
    expect(byId.get(fx.joinerEmpId) ?? 0).toBe(0);
  });

  it('PE-FX-04: the G25 shape exists — approved leave, and only a LEAVE-sourced row', async () => {
    const { prisma } = ctx;
    const rows = await prisma.attendance.findMany({
      where: { employeeId: fx.leaveNoAttendanceEmpId },
      select: { source: true, status: true },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('LEAVE');
    expect(rows[0].status).toBe('LEAVE');

    const leave = await prisma.leaveRequest.count({
      where: { employeeId: fx.leaveNoAttendanceEmpId, status: 'APPROVED' },
    });
    expect(leave).toBe(1);
  });

  it('PE-FX-05: the joiner starts inside the period and the leaver ends inside it', async () => {
    const { prisma } = ctx;
    const [joiner, leaver] = await Promise.all([
      prisma.employee.findUnique({
        where: { id: fx.joinerEmpId },
        select: { startDate: true },
      }),
      prisma.employee.findUnique({
        where: { id: fx.leaverEmpId },
        select: { endDate: true },
      }),
    ]);

    const start = new Date(Date.UTC(fx.period.year, fx.period.month - 1, 1));
    const end = new Date(Date.UTC(fx.period.year, fx.period.month, 0));

    expect(joiner!.startDate!.getTime()).toBeGreaterThan(start.getTime());
    expect(joiner!.startDate!.getTime()).toBeLessThanOrEqual(end.getTime());
    expect(leaver!.endDate!.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(leaver!.endDate!.getTime()).toBeLessThan(end.getTime());
  });

  it('PE-FX-06: every fixture user can authenticate over HTTP', async () => {
    for (const u of [fx.base.admin, fx.base.hr, fx.base.scopedHr]) {
      const res = await api()
        .get('/payrolls')
        .set(bearer(u.token))
        .set('X-Branch-Id', fx.base.branchA);
      expect([200, 403]).toContain(res.status);
    }
  });
});
