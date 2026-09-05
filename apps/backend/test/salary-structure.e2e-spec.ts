import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollFixtures,
  seedAttendance,
  PayrollFixtures,
  bearer,
} from './utils/payroll-fixtures';

/**
 * Salary structures — Phase 4, chunk C5.
 *
 * There is no `salary_structure` table and no assignment entity. An employee's
 * structure IS their set of active `SalaryComponent` rows, and only two
 * `componentType` codes mean anything to the engine:
 *
 *  - **`BASIC`** — the basic part of the contracted rate. At most one active per
 *    employee.
 *  - **`PAYROLL_CONFIG`** — per-employee deduction overrides carried as JSON in
 *    `note`, with `amount` forced to 0. A singleton: creating one retires the
 *    previous.
 *
 * Everything else — `HOUSING`, `TRANSPORT`, an admin-defined `HRA` — is summed
 * as an allowance. `componentType` is an open slug, not an enum, so the shape of
 * what is accepted is itself a contract worth pinning.
 *
 * The rule this file exists to protect is that **pay history is not rewritable**.
 * An amount change retires the old row and writes a new one; a component behind
 * a locked payroll cannot be deleted at all.
 */
describe('Salary structure (e2e)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;
  let periodCursor = 90;

  const api = () => ctx.http();
  const as = (token: string, req: any, branchId: string | null = fx.branchA) => {
    req.set(bearer(token));
    if (branchId) req.set('x-branch-id', branchId);
    return req;
  };
  const asAdmin = (req: any, branchId: string | null = fx.branchA) =>
    as(fx.admin.token, req, branchId);

  const createComponent = (body: Record<string, any>, token = fx.admin.token) =>
    as(token, api().post('/salary-components')).send(body);

  /** An employee with no locked payroll, so delete stays reachable. */
  const CLEAN_EMP = () => fx.noBankEmpId;

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── SC-API-01..10  Creating components ───────────────────────────────────
  describe('SC-API-01..10 — creating components', () => {
    it('SC-API-01: an ADMIN creates an allowance', async () => {
      const res = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: 'TRANSPORT',
        amount: 1200,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.componentType).toBe('TRANSPORT');
      expect(Number(res.body.data.amount)).toBe(1200);
      expect(res.body.data.isActive).toBe(true);
    });

    it('SC-API-02: componentType is normalised to an upper-case slug', async () => {
      const res = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: '  site_bonus  ',
        amount: 10,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.componentType).toBe('SITE_BONUS');
    });

    it.each([
      ['a leading digit', '1BONUS'],
      ['punctuation', 'BON-US'],
      ['a space inside', 'SITE BONUS'],
      ['over 50 characters', 'A'.repeat(51)],
      ['empty', ''],
    ])('SC-API-03: refuses %s as a componentType', async (_l, componentType) => {
      const res = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType,
        amount: 1,
      });
      expect(res.status).toBe(400);
    });

    it('SC-API-04: an admin-defined slug is as valid as a shipped one', async () => {
      // The type is an open set on purpose — HRA and DA are library codes an
      // administrator defines, not enum members someone has to ship.
      const res = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: 'HRA',
        amount: 500,
      });
      expect(res.status).toBe(201);
    });

    it.each([
      ['a negative amount', { amount: -1 }],
      ['a non-numeric amount', { amount: 'lots' }],
      ['a missing amount', {}],
      ['an invalid effectiveDate', { amount: 1, effectiveDate: 'yesterday' }],
      ['an unknown key', { amount: 1, currency: 'INR' }],
    ])('SC-API-05: refuses %s', async (_l, over) => {
      const res = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: 'TRANSPORT',
        ...over,
      });
      expect(res.status).toBe(400);
    });

    it('SC-API-06: a second active BASIC is refused', async () => {
      // fx.monthlyEmpId already has one from the fixture.
      const res = await createComponent({
        employeeId: fx.monthlyEmpId,
        componentType: 'BASIC',
        amount: 1,
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('basic salary');
    });

    it('SC-API-07: PAYROLL_CONFIG is a singleton and its amount is forced to zero', async () => {
      const first = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: 'PAYROLL_CONFIG',
        amount: 999,
        note: JSON.stringify({ pfEnabled: false }),
      });
      expect(first.status).toBe(201);
      expect(Number(first.body.data.amount)).toBe(0);

      const second = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: 'PAYROLL_CONFIG',
        amount: 0,
        note: JSON.stringify({ pfEnabled: true }),
      });
      expect(second.status).toBe(201);

      const active = await ctx.prisma.salaryComponent.count({
        where: {
          employeeId: CLEAN_EMP(),
          componentType: 'PAYROLL_CONFIG',
          isActive: true,
        },
      });
      expect(active).toBe(1);
      // The retired one is kept, not deleted — it explains an older payslip.
      const all = await ctx.prisma.salaryComponent.count({
        where: { employeeId: CLEAN_EMP(), componentType: 'PAYROLL_CONFIG' },
      });
      expect(all).toBe(2);
    });

    it('SC-API-08: an unknown employee is 404 and a foreign one is refused', async () => {
      const ghost = await createComponent({
        employeeId: '00000000-0000-0000-0000-000000000000',
        componentType: 'TRANSPORT',
        amount: 1,
      });
      expect(ghost.status).toBe(404);

      const foreign = await createComponent({
        employeeId: fx.branchBEmpId,
        componentType: 'TRANSPORT',
        amount: 1,
      });
      expect(foreign.status).toBeGreaterThanOrEqual(400);
      expect(foreign.status).toBeLessThan(500);
    });
  });

  // ── SC-API-11..19  Reads, filters and scoping ────────────────────────────
  describe('SC-API-11..19 — reading', () => {
    it('SC-API-11: the list paginates and reports meta', async () => {
      const res = await asAdmin(api().get('/salary-components?page=1&limit=2'));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 2 });
      expect(res.body.meta.total).toBeGreaterThan(0);
    });

    it('SC-API-12: the employeeId, componentType and isActive filters narrow it', async () => {
      const byEmployee = await asAdmin(
        api().get(`/salary-components?employeeId=${fx.monthlyEmpId}`),
      );
      expect(byEmployee.status).toBe(200);
      for (const c of byEmployee.body.data) {
        expect(c.employeeId).toBe(fx.monthlyEmpId);
      }

      const byType = await asAdmin(
        api().get(`/salary-components?employeeId=${fx.monthlyEmpId}&componentType=BASIC`),
      );
      for (const c of byType.body.data) expect(c.componentType).toBe('BASIC');

      const inactive = await asAdmin(
        api().get('/salary-components?isActive=false'),
      );
      for (const c of inactive.body.data) expect(c.isActive).toBe(false);
    });

    it('SC-API-13: a filter that matches nothing is an empty list, not an error', async () => {
      const res = await asAdmin(
        api().get(`/salary-components?employeeId=${fx.terminatedEmpId}`),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });

    it('SC-API-14: read-by-employee returns the active set and a total', async () => {
      const res = await asAdmin(
        api().get(`/salary-components/employee/${fx.monthlyEmpId}`),
      );
      expect(res.status).toBe(200);
      const payload = res.body.data;
      expect(payload.totalSalary ?? payload.total).toBeGreaterThan(0);
    });

    it('SC-API-15: a MANAGER reads their own department and is refused another', async () => {
      const own = await as(
        fx.deptManager.token,
        api().get(`/salary-components/employee/${fx.monthlyEmpId}`),
      );
      expect(own.status).toBe(200);

      const foreign = await as(
        fx.deptManager.token,
        api().get(`/salary-components/employee/${fx.foreignDeptEmpId}`),
      );
      expect(foreign.status).toBe(403);
    });

    it('SC-API-16: an EMPLOYEE is refused every salary-component door', async () => {
      for (const call of [
        () => as(fx.employee.token, api().get('/salary-components')),
        () =>
          as(
            fx.employee.token,
            api().get(`/salary-components/employee/${fx.monthlyEmpId}`),
          ),
        () =>
          as(fx.employee.token, api().post('/salary-components')).send({
            employeeId: fx.monthlyEmpId,
            componentType: 'BONUS',
            amount: 1,
          }),
      ]) {
        expect((await call()).status).toBe(403);
      }
    });

    it('SC-API-17: an anonymous caller is 401', async () => {
      expect((await api().get('/salary-components')).status).toBe(401);
    });

    it('SC-API-18: a scoped HR cannot read a foreign component by id', async () => {
      const foreign = await ctx.prisma.salaryComponent.create({
        data: {
          employeeId: fx.branchBEmpId,
          componentType: 'TRANSPORT',
          amount: 100,
          effectiveDate: new Date('2020-01-01'),
          isActive: true,
        },
      });
      const res = await api()
        .get(`/salary-components/${foreign.id}`)
        .set(bearer(fx.scopedHr.token));
      expect([403, 404]).toContain(res.status);
    });

    it('SC-API-19: a malformed id is 400, not 500', async () => {
      expect(
        (await asAdmin(api().get('/salary-components/not-a-uuid'))).status,
      ).toBe(400);
    });
  });

  // ── SC-API-20..27  Amending, deactivating and deleting ───────────────────
  describe('SC-API-20..27 — amend, deactivate, delete', () => {
    it('SC-API-20: changing the AMOUNT retires the old row and writes a new one', async () => {
      // Pay history is not rewritable. An in-place edit left the payslip that had
      // already been produced from the old figure with no row that explained it.
      const created = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: 'POSITION',
        amount: 1000,
      });
      const originalId = created.body.data.id;

      const res = await asAdmin(
        api().patch(`/salary-components/${originalId}`),
      ).send({ amount: 1500 });
      expect(res.status).toBe(200);
      expect(res.body.data.id).not.toBe(originalId);
      expect(Number(res.body.data.amount)).toBe(1500);
      expect(res.body.data.isActive).toBe(true);

      const original = await ctx.prisma.salaryComponent.findUnique({
        where: { id: originalId },
      });
      expect(original).not.toBeNull();
      expect(original!.isActive).toBe(false);
      expect(Number(original!.amount)).toBe(1000);

      // Exactly one POSITION applies now.
      const active = await ctx.prisma.salaryComponent.count({
        where: {
          employeeId: CLEAN_EMP(),
          componentType: 'POSITION',
          isActive: true,
        },
      });
      expect(active).toBe(1);
    });

    it('SC-API-21: editing metadata alone still edits in place', async () => {
      const created = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: 'PHONE',
        amount: 300,
      });
      const id = created.body.data.id;

      const res = await asAdmin(api().patch(`/salary-components/${id}`)).send({
        note: 'corrected the description only',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);

      const rows = await ctx.prisma.salaryComponent.count({
        where: { employeeId: CLEAN_EMP(), componentType: 'PHONE' },
      });
      expect(rows).toBe(1);
    });

    it('SC-API-22: re-sending the SAME amount is not an amendment', async () => {
      const created = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: 'LUNCH',
        amount: 250,
      });
      const id = created.body.data.id;
      const res = await asAdmin(api().patch(`/salary-components/${id}`)).send({
        amount: 250,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
    });

    it('SC-API-23: an amended BASIC does not trip the one-active-BASIC rule', async () => {
      // The retire-and-create pair runs in one transaction, so there is never a
      // moment with two active BASIC rows — and the create inside it does not
      // route through the guard that would refuse the second one.
      const basic = await ctx.prisma.salaryComponent.findFirst({
        where: {
          employeeId: fx.secondMonthlyEmpId,
          componentType: 'BASIC',
          isActive: true,
        },
      });
      expect(basic).not.toBeNull();

      const res = await asAdmin(
        api().patch(`/salary-components/${basic!.id}`),
      ).send({ amount: 25000 });
      expect(res.status).toBe(200);

      const active = await ctx.prisma.salaryComponent.count({
        where: {
          employeeId: fx.secondMonthlyEmpId,
          componentType: 'BASIC',
          isActive: true,
        },
      });
      expect(active).toBe(1);
    });

    it('SC-API-24: deactivate retires a component without deleting it', async () => {
      const created = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: 'OTHER',
        amount: 60,
      });
      const id = created.body.data.id;

      const res = await asAdmin(
        api().post(`/salary-components/${id}/deactivate`),
      );
      expect(res.status).toBe(201);

      const row = await ctx.prisma.salaryComponent.findUnique({
        where: { id },
      });
      expect(row!.isActive).toBe(false);
    });

    it('SC-API-25: DELETE is ADMIN-only — HR is refused', async () => {
      const created = await createComponent({
        employeeId: CLEAN_EMP(),
        componentType: 'BONUS',
        amount: 90,
      });
      const id = created.body.data.id;

      const hr = await as(fx.hr.token, api().delete(`/salary-components/${id}`));
      expect(hr.status).toBe(403);

      const admin = await asAdmin(api().delete(`/salary-components/${id}`));
      expect(admin.status).toBe(200);
      expect(
        await ctx.prisma.salaryComponent.count({ where: { id } }),
      ).toBe(0);
    });

    it('SC-API-26: a component behind LOCKED payroll history cannot be deleted', async () => {
      // The row is what a produced payslip was calculated from. Once any run for
      // this employee is locked, erasing it leaves a paid figure unexplained —
      // deactivate is the door, and the refusal says so.
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.dailyEmpId], fx.branchA, period);
      const run = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
        employeeIds: [fx.dailyEmpId],
      });
      const runId = run.body.data.id;
      await asAdmin(api().post(`/payrolls/${runId}/submit`));
      await asAdmin(api().post(`/payrolls/${runId}/approve`)).send({});
      expect((await asAdmin(api().post(`/payrolls/${runId}/lock`))).status).toBe(
        201,
      );

      const created = await createComponent({
        employeeId: fx.dailyEmpId,
        componentType: 'SITE_ALLOWANCE',
        amount: 40,
      });
      const id = created.body.data.id;

      const res = await asAdmin(api().delete(`/salary-components/${id}`));
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Deactivate it instead');
      expect(await ctx.prisma.salaryComponent.count({ where: { id } })).toBe(1);

      // ...and the door it points at works.
      const deactivated = await asAdmin(
        api().post(`/salary-components/${id}/deactivate`),
      );
      expect(deactivated.status).toBe(201);
    });

    it('SC-API-27: an unknown component is 404 on every write door', async () => {
      const ghost = '00000000-0000-0000-0000-000000000000';
      expect(
        (await asAdmin(api().patch(`/salary-components/${ghost}`)).send({ note: 'x' }))
          .status,
      ).toBe(404);
      expect(
        (await asAdmin(api().post(`/salary-components/${ghost}/deactivate`)))
          .status,
      ).toBe(404);
      expect(
        (await asAdmin(api().delete(`/salary-components/${ghost}`))).status,
      ).toBe(404);
    });
  });

  // ── SC-API-28..30  The seam with the run ─────────────────────────────────
  describe('SC-API-28..30 — what the run actually reads', () => {
    it('SC-API-28: a deactivated component stops being paid', async () => {
      const created = await createComponent({
        employeeId: fx.secondMonthlyEmpId,
        componentType: 'TRANSPORT',
        amount: 2000,
        effectiveDate: '2020-01-01',
      });
      const id = created.body.data.id;

      const withIt = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.secondMonthlyEmpId], fx.branchA, withIt);
      const paid = await asAdmin(api().post('/payrolls')).send({
        month: withIt.month,
        year: withIt.year,
        employeeIds: [fx.secondMonthlyEmpId],
      });
      const paidDetail = await asAdmin(
        api().get(`/payrolls/${paid.body.data.id}`),
      );
      const paidAllowances = Number(paidDetail.body.data.items[0].allowances);
      expect(paidAllowances).toBeGreaterThanOrEqual(2000);

      await asAdmin(api().post(`/salary-components/${id}/deactivate`));

      const without = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.secondMonthlyEmpId], fx.branchA, without);
      const unpaid = await asAdmin(api().post('/payrolls')).send({
        month: without.month,
        year: without.year,
        employeeIds: [fx.secondMonthlyEmpId],
      });
      const unpaidDetail = await asAdmin(
        api().get(`/payrolls/${unpaid.body.data.id}`),
      );
      expect(Number(unpaidDetail.body.data.items[0].allowances)).toBeLessThan(
        paidAllowances,
      );
    });

    it('SC-API-29: an amended amount is what the NEXT run pays', async () => {
      const created = await createComponent({
        employeeId: fx.migrationCandidateId,
        componentType: 'TRANSPORT',
        amount: 1000,
        effectiveDate: '2020-01-01',
      });

      await asAdmin(api().patch(`/salary-components/${created.body.data.id}`)).send(
        { amount: 3000, effectiveDate: '2020-01-01' },
      );

      const period = fx.periodAt(periodCursor++);
      await seedAttendance(
        ctx.prisma,
        [fx.migrationCandidateId],
        fx.branchA,
        period,
      );
      const run = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
        employeeIds: [fx.migrationCandidateId],
      });
      const detail = await asAdmin(api().get(`/payrolls/${run.body.data.id}`));
      const allowances = Number(detail.body.data.items[0].allowances);
      // The retired 1000 row must not be paid alongside the 3000 that replaced it.
      expect(allowances).toBeGreaterThanOrEqual(3000);
      expect(allowances).toBeLessThan(4000);
    });
  });
});
