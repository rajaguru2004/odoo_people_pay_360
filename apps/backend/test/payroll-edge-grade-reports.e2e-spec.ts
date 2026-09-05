import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';
import { withSettings } from './utils/settings';

/**
 * `PE-GRADE` and `PE-RPT` — employee grades, and payroll reporting.
 *
 * The gap report calls grade "renamed — Employee.employmentType". It is not, and
 * the first case here is why: `employmentType` drives the overtime-policy
 * inheritance chain, so repurposing it would change overtime for everybody.
 * Grade is a new nullable axis that the payroll engine never reads.
 */
describe('Payroll edge — grades and reports (PE-GRADE, PE-RPT)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;

  const GRADE_ON = { employee_grade_enabled: 'true' };
  const REPORTS_ON = { payroll_reports_enabled: 'true' };

  let code = '';

  const makeGrade = (body: Record<string, unknown> = {}) =>
    api()
      .post('/grades')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ code, name: 'Officer', level: 3, ...body });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  beforeEach(() => {
    code = `G${Date.now().toString(36).slice(-6).toUpperCase()}`;
  });

  afterEach(async () => {
    await ctx.prisma.employee.updateMany({
      where: { branchId: branch() },
      data: { gradeId: null },
    });
    await ctx.prisma.grade.deleteMany({ where: { code: { startsWith: 'G' } } });
  });

  describe('PE-GRADE-01..07 — grades', () => {
    it('PE-GRADE-01: employmentType is NOT repurposed', async () => {
      // It is a CONTRACT_TYPE library label that drives the overtime-policy
      // inheritance chain. Grade sits beside it, nullable, and the engine never
      // reads it.
      await withSettings(ctx, GRADE_ON, async () => {
        const before = await ctx.prisma.employee.findUnique({
          where: { id: fx.fullMonthEmpId },
          select: { employmentType: true },
        });
        const grade = await makeGrade();
        await api()
          .post(`/grades/assign/${fx.fullMonthEmpId}`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ gradeId: grade.body.data.id });

        const after = await ctx.prisma.employee.findUnique({
          where: { id: fx.fullMonthEmpId },
          select: { employmentType: true, gradeId: true },
        });
        expect(after!.employmentType).toBe(before!.employmentType);
        expect(after!.gradeId).toBe(grade.body.data.id);
      });
    }, 90_000);

    it('PE-GRADE-02: with the flag OFF the route is unavailable', async () => {
      const res = await makeGrade();
      expect(res.status).toBe(404);
      expect(String(res.body?.message ?? '')).toMatch(/not enabled/i);
    }, 60_000);

    it('PE-GRADE-03: refuses a duplicate code by name', async () => {
      await withSettings(ctx, GRADE_ON, async () => {
        expect((await makeGrade()).status).toBe(201);
        const second = await makeGrade({ name: 'Something else' });
        expect(second.status).toBe(409);
        expect(String(second.body?.message ?? '')).toMatch(new RegExp(`${code} already exists`, 'i'));
      });
    }, 60_000);

    it('PE-GRADE-04: refuses a band whose ceiling is under its floor', async () => {
      // Every salary would be out of range, so the eligibility check would
      // reject every employee at that grade.
      await withSettings(ctx, GRADE_ON, async () => {
        const res = await makeGrade({ minSalary: 5000, maxSalary: 1000 });
        expect(res.status).toBe(400);
      });
    }, 60_000);

    it('PE-GRADE-05: refuses an assignment outside the band, naming both figures', async () => {
      await withSettings(ctx, GRADE_ON, async () => {
        const grade = await makeGrade({ minSalary: 900000, maxSalary: 1000000 });
        const res = await api()
          .post(`/grades/assign/${fx.fullMonthEmpId}`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ gradeId: grade.body.data.id });
        expect(res.status).toBe(400);
        expect(String(res.body?.message ?? '')).toMatch(/below the .* band, which starts at 900000/i);
      });
    }, 60_000);

    it('PE-GRADE-06: a template is a suggestion, not a payroll input', async () => {
      // `SalaryComponent` stays the only pay input the engine reads; the
      // template pre-fills a form.
      await withSettings(ctx, GRADE_ON, async () => {
        const grade = await makeGrade();
        await api()
          .put(`/grades/${grade.body.data.id}/components`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({
            components: [
              { componentType: 'HOUSING', valueType: 'PERCENT_OF_BASIC', value: 25 },
              { componentType: 'TRANSPORT', valueType: 'FIXED', value: 150 },
            ],
          });

        const res = await api()
          .get(`/grades/${grade.body.data.id}/template?basic=1000`)
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(res.status).toBe(200);
        const byType = Object.fromEntries(
          res.body.data.components.map((c: any) => [c.componentType, c.amount]),
        );
        expect(byType.HOUSING).toBe(250);
        expect(byType.TRANSPORT).toBe(150);

        // Nothing was written to the employee's actual structure.
        const components = await ctx.prisma.salaryComponent.count({
          where: { employeeId: fx.fullMonthEmpId, componentType: 'HOUSING' },
        });
        expect(components).toBe(0);
      });
    }, 90_000);

    it('PE-GRADE-07: refuses a percentage that is obviously basis points', async () => {
      await withSettings(ctx, GRADE_ON, async () => {
        const grade = await makeGrade();
        const res = await api()
          .put(`/grades/${grade.body.data.id}/components`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({
            components: [
              { componentType: 'HOUSING', valueType: 'PERCENT_OF_BASIC', value: 2500 },
            ],
          });
        expect(res.status).toBe(400);
        expect(String(res.body?.message ?? '')).toMatch(/basis points/i);
      });
    }, 60_000);
  });

  describe('PE-RPT-01..05 — reporting', () => {
    const period = () => fx.periodAt(110);

    const seedLockedRun = async () => {
      const p = period();
      const lastDay = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
      const rows: any[] = [];
      for (let day = 1; day <= lastDay; day++) {
        const date = new Date(Date.UTC(p.year, p.month - 1, day));
        if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
        rows.push({
          employeeId: fx.fullMonthEmpId,
          branchId: branch(),
          date,
          status: 'PRESENT',
          workHours: 8,
        });
      }
      await ctx.prisma.attendance.createMany({ data: rows, skipDuplicates: true });

      const created = await api()
        .post('/payrolls')
        .set(admin())
        .set('X-Branch-Id', branch())
        .send({ month: p.month, year: p.year, employeeIds: [fx.fullMonthEmpId] });
      const id = created.body.data.id;
      await api().post(`/payrolls/${id}/submit`).set(admin()).set('X-Branch-Id', branch()).send({});
      await api().post(`/payrolls/${id}/approve`).set(admin()).set('X-Branch-Id', branch()).send({});
      await api().post(`/payrolls/${id}/lock`).set(admin()).set('X-Branch-Id', branch()).send({});
      return id;
    };

    it('PE-RPT-01: the register reads LOCKED runs only', async () => {
      await withSettings(ctx, REPORTS_ON, async () => {
        const p = period();
        // Before locking: the period exists but nothing has been paid.
        const empty = await api()
          .get(`/payrolls/reports/register?month=${p.month}&year=${p.year}&branchId=${branch()}`)
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(empty.status).toBe(200);
        expect(empty.body.data.rows).toHaveLength(0);

        const id = await seedLockedRun();
        const after = await api()
          .get(`/payrolls/reports/register?month=${p.month}&year=${p.year}&branchId=${branch()}`)
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(after.body.data.rows.length).toBeGreaterThan(0);
        expect(after.body.data.totals.net).toBeGreaterThan(0);

        await api().post(`/payrolls/${id}/unlock`).set(admin()).set('X-Branch-Id', branch()).send({ reason: 'cleanup' });
        await api().delete(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 150_000);

    it('PE-RPT-02: every response names the runs that would move the numbers', async () => {
      // A reader who cannot see which drafts are outstanding cannot tell a
      // small month from an unlocked one.
      await withSettings(ctx, REPORTS_ON, async () => {
        const p = period();
        const res = await api()
          .get(`/payrolls/reports/register?month=${p.month}&year=${p.year}&branchId=${branch()}`)
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(res.body.data.meta).toHaveProperty('openPayrolls');
        expect(Array.isArray(res.body.data.meta.openPayrolls)).toBe(true);
      });
    }, 60_000);

    it('PE-RPT-03: cost groups by department', async () => {
      await withSettings(ctx, REPORTS_ON, async () => {
        const p = period();
        const id = await seedLockedRun();
        const res = await api()
          .get(`/payrolls/reports/cost?year=${p.year}&month=${p.month}&groupBy=department&branchId=${branch()}`)
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(res.status).toBe(200);
        expect(res.body.data.rows.length).toBeGreaterThan(0);
        expect(res.body.data.totals.net).toBeGreaterThan(0);

        await api().post(`/payrolls/${id}/unlock`).set(admin()).set('X-Branch-Id', branch()).send({ reason: 'cleanup' });
        await api().delete(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 150_000);

    it('PE-RPT-04: the statutory summary falls back to the combined columns', async () => {
      // Itemisation is off in this suite, so there is no PF/ESI split to report;
      // the combined figures must still be right rather than empty.
      await withSettings(ctx, REPORTS_ON, async () => {
        const p = period();
        const id = await seedLockedRun();
        const res = await api()
          .get(`/payrolls/reports/statutory-summary?month=${p.month}&year=${p.year}&branchId=${branch()}`)
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(res.status).toBe(200);
        expect(res.body.data.combined).toHaveProperty('insurance');
        expect(res.body.data.itemised).toEqual([]);

        await api().post(`/payrolls/${id}/unlock`).set(admin()).set('X-Branch-Id', branch()).send({ reason: 'cleanup' });
        await api().delete(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 150_000);

    it('PE-RPT-05: variance keeps headcount changes apart from pay changes', async () => {
      // The single most common way a variance report misleads.
      await withSettings(ctx, REPORTS_ON, async () => {
        const p = period();
        const res = await api()
          .get(`/payrolls/reports/variance?month=${p.month}&year=${p.year}&branchId=${branch()}`)
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(res.status).toBe(200);
        const t = res.body.data.totals;
        expect(t).toHaveProperty('fromPayChanges');
        expect(t).toHaveProperty('fromJoiners');
        expect(t).toHaveProperty('fromLeavers');
      });
    }, 60_000);
  });
});
