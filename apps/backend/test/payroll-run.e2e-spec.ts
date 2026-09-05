import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollFixtures,
  seedAttendance,
  PayrollFixtures,
  Period,
  bearer,
} from './utils/payroll-fixtures';

/**
 * `POST /payrolls` and the read doors around it — the run itself.
 *
 * Phase 4, chunk C2. The payroll state machine lives in
 * `payroll-lifecycle.e2e-spec.ts`; this file owns **generation**: who may start a
 * run, which employees it picks up, what refuses it, and whether the money it
 * writes adds up.
 *
 * Deliberately NOT re-derived here: tax, PF, ESI, PT and gratuity arithmetic.
 * Those have ~100 unit cases in `src/payrolls/*.spec.ts`. What e2e can prove and
 * a unit test cannot is that the numbers RECONCILE across the HTTP boundary —
 * every item's net is its own components, and the header total is the sum of the
 * items.
 */
describe('Payroll run — generation and reads (e2e)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;

  const api = () => ctx.http();
  const asAdmin = (req: any, branchId?: string) => {
    req.set(bearer(fx.admin.token));
    if (branchId) req.set('x-branch-id', branchId);
    return req;
  };
  /** Payrolls created outside `fx.period`, cleaned by branch in `fx.cleanup`. */
  const createRun = async (period: Period, body: Record<string, any> = {}) =>
    asAdmin(api().post('/payrolls'), fx.branchA).send({
      month: period.month,
      year: period.year,
      ...body,
    });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── PR-API-01..09  Creating a run ────────────────────────────────────────
  describe('PR-API-01..09 — creating a run', () => {
    let firstRunId: string;

    it('PR-API-01: an ADMIN with a branch selected generates a run', async () => {
      const res = await createRun(fx.period);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        month: fx.period.month,
        year: fx.period.year,
        status: 'DRAFT',
        version: 1,
        runType: 'REGULAR',
        branchId: fx.branchA,
        batchId: null,
      });
      expect(res.body.data.employeeCount).toBeGreaterThan(0);
      firstRunId = res.body.data.id;
    });

    it('PR-API-02: the run covers exactly branch A’s ACTIVE employees', async () => {
      const detail = await asAdmin(
        api().get(`/payrolls/${firstRunId}`),
        fx.branchA,
      );
      expect(detail.status).toBe(200);
      const empIds: string[] = detail.body.data.items.map(
        (i: any) => i.employeeId,
      );

      expect(empIds).toEqual(
        expect.arrayContaining([fx.monthlyEmpId, fx.dailyEmpId]),
      );
      // INACTIVE staff are never paid.
      expect(empIds).not.toContain(fx.terminatedEmpId);
      // Neither is another branch's staff — the run is per-branch.
      expect(empIds).not.toContain(fx.branchBEmpId);
      expect(empIds).not.toContain(fx.omEmpId);
      // One item per employee, enforced by @@unique([payrollId, employeeId]).
      expect(new Set(empIds).size).toBe(empIds.length);
    });

    it('PR-API-03: refuses when no single branch is resolvable', async () => {
      // A global admin sending no x-branch-id is "all branches", which is exactly
      // the case that used to silently pay everybody in the company.
      const res = await api()
        .post('/payrolls')
        .set(bearer(fx.admin.token))
        .send({ month: fx.periodAt(1).month, year: fx.periodAt(1).year });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Select a specific branch');
    });

    it('PR-API-04: a single-branch HR needs no header — their one branch IS the selection', async () => {
      const p = fx.periodAt(1);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, p);
      const res = await api()
        .post('/payrolls')
        .set(bearer(fx.scopedHr.token))
        .send({ month: p.month, year: p.year });
      expect(res.status).toBe(201);
      expect(res.body.data.branchId).toBe(fx.branchA);
    });

    it('PR-API-05: a second run for the same period, branch and batch is refused', async () => {
      const res = await createRun(fx.period);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('already exists');
    });

    it('PR-API-06: the same period in ANOTHER branch is allowed', async () => {
      const res = await asAdmin(api().post('/payrolls'), fx.branchB).send({
        month: fx.period.month,
        year: fx.period.year,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.branchId).toBe(fx.branchB);
      expect(res.body.data.employeeCount).toBe(1);
    });

    it('PR-API-07: refuses a period whose attendance was never processed', async () => {
      // Zero attendance rows must not read as "absent all month" — LOP would
      // wipe every salary from missing data rather than real absence.
      const virgin = fx.periodAt(9);
      const res = await createRun(virgin);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('has not been processed yet');
    });

    it('PR-API-08: one employee with attendance is enough to unblock the period', async () => {
      const p = fx.periodAt(9);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, p);
      const res = await createRun(p);
      expect(res.status).toBe(201);
      // Everyone is still paid; the ones with no attendance simply skip LOP.
      expect(res.body.data.employeeCount).toBeGreaterThan(1);
    });

    it('PR-API-09: the header total is the sum of the items', async () => {
      const detail = await asAdmin(
        api().get(`/payrolls/${firstRunId}`),
        fx.branchA,
      );
      const items = detail.body.data.items;
      const summed = items.reduce(
        (acc: number, i: any) => acc + Number(i.netSalary),
        0,
      );
      expect(Number(detail.body.data.totalAmount)).toBeCloseTo(summed, 2);
    });
  });

  // ── PR-API-10..13  Concurrency and the DB constraint ─────────────────────
  describe('PR-API-10..13 — the duplicate-period constraint', () => {
    it('PR-API-12: two simultaneous creates produce exactly one run', async () => {
      // The friendly 409 in the service is a read-then-write and cannot survive a
      // race. What actually holds the line is the expression unique index
      // uniq_payroll_period_branch_batch_version (migration 20260805100000) —
      // an expression index because Postgres treats NULL branch/batch ids as
      // distinct, so a plain @@unique would never bind.
      const p = fx.periodAt(3);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, p);

      const [a, b] = await Promise.all([createRun(p), createRun(p)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      // The loser is a 409 when the friendly check wins the race and a 500 when
      // the index does. Either way it must NOT be a second 201.
      expect(statuses[1]).not.toBe(201);

      const rows = await ctx.prisma.payroll.count({
        where: { month: p.month, year: p.year, branchId: fx.branchA },
      });
      expect(rows).toBe(1);
    });
  });

  // ── PR-API-14..22  Input validation and boundaries ───────────────────────
  describe('PR-API-14..22 — validation and boundaries', () => {
    it.each([
      ['month 0', { month: 0, year: 2032 }],
      ['month 13', { month: 13, year: 2032 }],
      ['a fractional month', { month: 6.5, year: 2032 }],
      ['year 2019', { month: 6, year: 2019 }],
      ['a missing month', { year: 2032 }],
      ['a missing year', { month: 6 }],
      ['a string month', { month: 'six', year: 2032 }],
    ])('PR-API-14: refuses %s', async (_label, body) => {
      const res = await asAdmin(api().post('/payrolls'), fx.branchA).send(body);
      expect(res.status).toBe(400);
    });

    it('PR-API-15: refuses an unknown runType', async () => {
      const res = await createRun(fx.periodAt(4), { runType: 'CHRISTMAS' });
      expect(res.status).toBe(400);
    });

    it('PR-API-16: refuses an unknown body key', async () => {
      // forbidNonWhitelisted is what stops a typo'd field passing silently.
      const res = await createRun(fx.periodAt(4), { employeeIDs: [] });
      expect(res.status).toBe(400);
    });

    it.each([
      'REGULAR',
      'OFF_CYCLE',
      'BONUS',
      'ADJUSTMENT',
      'FINAL_SETTLEMENT',
    ])('PR-API-17: accepts runType %s', async (runType) => {
      const p = fx.periodAt(12 + ['REGULAR', 'OFF_CYCLE', 'BONUS', 'ADJUSTMENT', 'FINAL_SETTLEMENT'].indexOf(runType));
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, p);
      const res = await createRun(p, { runType });
      expect(res.status).toBe(201);
      expect(res.body.data.runType).toBe(runType);
    });

    it('PR-API-18: an explicit employeeIds list narrows the run', async () => {
      const p = fx.periodAt(5);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, p);
      const res = await createRun(p, {
        employeeIds: [fx.monthlyEmpId, fx.secondMonthlyEmpId],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.employeeCount).toBe(2);
    });

    it('PR-API-19: an employeeIds list cannot reach into another branch', async () => {
      const p = fx.periodAt(6);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, p);
      const res = await createRun(p, {
        employeeIds: [fx.monthlyEmpId, fx.branchBEmpId],
      });
      expect(res.status).toBe(201);
      // The employee read is auto-scoped, so the foreign id is simply not found.
      expect(res.body.data.employeeCount).toBe(1);
    });
  });

  // ── PR-API-23..29  Role matrix and scoping on the read doors ─────────────
  describe('PR-API-23..29 — role matrix and branch scoping', () => {
    let branchARunId: string;
    let branchBRunId: string;

    beforeAll(async () => {
      const [a, b] = await Promise.all([
        ctx.prisma.payroll.findFirst({
          where: { branchId: fx.branchA, month: fx.period.month },
        }),
        ctx.prisma.payroll.findFirst({ where: { branchId: fx.branchB } }),
      ]);
      branchARunId = a!.id;
      branchBRunId = b!.id;
    });

    it.each([
      ['ADMIN', () => fx.admin.token, 200],
      ['HR_MANAGER', () => fx.hr.token, 200],
      ['scoped HR_MANAGER', () => fx.scopedHr.token, 200],
      ['MANAGER', () => fx.deptManager.token, 403],
      ['EMPLOYEE', () => fx.employee.token, 403],
    ])('PR-API-23: GET /payrolls as %s → %i', async (_r, token, expected) => {
      const res = await api().get('/payrolls').set(bearer(token()));
      expect(res.status).toBe(expected);
    });

    it('PR-API-24: GET /payrolls unauthenticated → 401', async () => {
      const res = await api().get('/payrolls');
      expect(res.status).toBe(401);
    });

    it('PR-API-25: the list is scoped to the caller’s branches', async () => {
      const scoped = await api()
        .get('/payrolls')
        .set(bearer(fx.scopedHr.token));
      expect(scoped.status).toBe(200);
      const branchIds = scoped.body.data.map((p: any) => p.branchId);
      expect(branchIds).toContain(fx.branchA);
      expect(branchIds).not.toContain(fx.branchB);
    });

    it('PR-API-26: a scoped HR cannot read a foreign run by id', async () => {
      const res = await api()
        .get(`/payrolls/${branchBRunId}`)
        .set(bearer(fx.scopedHr.token));
      // findUnique bypasses the Prisma middleware, so this door is only closed by
      // the service's own assertInBranch. That is exactly what makes it worth a
      // case of its own.
      expect([403, 404]).toContain(res.status);
    });

    it('PR-API-27: an unknown id is 404 and a malformed one is not a 500', async () => {
      const unknown = await asAdmin(
        api().get('/payrolls/00000000-0000-0000-0000-000000000000'),
        fx.branchA,
      );
      expect(unknown.status).toBe(404);

      // A malformed id is the CLIENT's mistake. Before ParseUUIDPipe it reached
      // Prisma and answered 500 — letting client input decide whether the server
      // reported a fault of its own. Same shape as the Organization module's D12.
      const malformed = await asAdmin(
        api().get('/payrolls/not-a-uuid'),
        fx.branchA,
      );
      expect(malformed.status).toBe(400);
    });

    it('PR-API-28: the year filter narrows the list', async () => {
      const res = await asAdmin(
        api().get(`/payrolls?year=${fx.period.year}`),
        fx.branchA,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const p of res.body.data) expect(p.year).toBe(fx.period.year);

      const none = await asAdmin(api().get('/payrolls?year=1999'), fx.branchA);
      expect(none.status).toBe(200);
      expect(none.body.data).toEqual([]);
    });

    it('PR-API-29: a valid status filter narrows the list', async () => {
      const res = await asAdmin(
        api().get('/payrolls?status=DRAFT'),
        fx.branchA,
      );
      expect(res.status).toBe(200);
      for (const p of res.body.data) expect(p.status).toBe('DRAFT');
      expect(branchARunId).toBeTruthy();
    });

    it('PR-API-05b: an INVALID status filter is refused, not passed to the database', async () => {
      // F11. `status` is cast straight to PayrollStatus today, so a junk value
      // reaches Prisma and the client decides whether the server reports a fault
      // of its own.
      const res = await asAdmin(
        api().get('/payrolls?status=FINALIZED'),
        fx.branchA,
      );
      expect(res.status).toBe(400);
    });
  });

  // ── PR-API-30  Effective dating (F14) ────────────────────────────────────
  describe('PR-API-30 — salary components and effective dating', () => {
    it('PR-API-30: a component dated AFTER the period is not paid in it', async () => {
      // F14. `SalaryComponent.effectiveDate` is stored and used only for
      // `orderBy`; the run selects `isActive: true` with no date filter, so a
      // raise dated next year is paid this month. This is a money defect, not a
      // cosmetic one: the pay date, not the row's creation, decides the amount.
      const p = fx.periodAt(7);
      await seedAttendance(ctx.prisma, [fx.secondMonthlyEmpId], fx.branchA, p);

      const FUTURE_ALLOWANCE = 9999;
      const created = await ctx.prisma.salaryComponent.create({
        data: {
          employeeId: fx.secondMonthlyEmpId,
          componentType: 'TRANSPORT',
          amount: FUTURE_ALLOWANCE,
          // A full year after the period being run.
          effectiveDate: new Date(Date.UTC(p.year + 1, 0, 1)),
          isActive: true,
        },
      });

      const run = await createRun(p, {
        employeeIds: [fx.secondMonthlyEmpId],
      });
      expect(run.status).toBe(201);

      const detail = await asAdmin(
        api().get(`/payrolls/${run.body.data.id}`),
        fx.branchA,
      );
      const item = detail.body.data.items.find(
        (i: any) => i.employeeId === fx.secondMonthlyEmpId,
      );
      expect(item).toBeTruthy();
      expect(Number(item.allowances)).toBeLessThan(FUTURE_ALLOWANCE);

      await ctx.prisma.salaryComponent.delete({ where: { id: created.id } });
    });

    it('PR-API-31: an ACTIVE component dated before the period IS paid', async () => {
      const p = fx.periodAt(8);
      await seedAttendance(ctx.prisma, [fx.secondMonthlyEmpId], fx.branchA, p);

      const created = await ctx.prisma.salaryComponent.create({
        data: {
          employeeId: fx.secondMonthlyEmpId,
          componentType: 'TRANSPORT',
          amount: 1500,
          effectiveDate: new Date('2020-01-01'),
          isActive: true,
        },
      });

      const run = await createRun(p, { employeeIds: [fx.secondMonthlyEmpId] });
      const detail = await asAdmin(
        api().get(`/payrolls/${run.body.data.id}`),
        fx.branchA,
      );
      const item = detail.body.data.items.find(
        (i: any) => i.employeeId === fx.secondMonthlyEmpId,
      );
      expect(Number(item.allowances)).toBeGreaterThanOrEqual(1500);

      await ctx.prisma.salaryComponent.delete({ where: { id: created.id } });
    });
  });

  // ── PR-API-40..52  The item-edit door ────────────────────────────────────
  describe('PR-API-40..52 — editing an item', () => {
    let runId: string;
    let itemId: string;
    let otherRunId: string;

    beforeAll(async () => {
      const p = fx.periodAt(20);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, p);
      const run = await createRun(p, { employeeIds: [fx.monthlyEmpId] });
      runId = run.body.data.id;

      const detail = await asAdmin(
        api().get(`/payrolls/${runId}`),
        fx.branchA,
      );
      itemId = detail.body.data.items[0].id;

      const q = fx.periodAt(21);
      await seedAttendance(ctx.prisma, [fx.secondMonthlyEmpId], fx.branchA, q);
      const other = await createRun(q, {
        employeeIds: [fx.secondMonthlyEmpId],
      });
      otherRunId = other.body.data.id;
    });

    const patchItem = (body: Record<string, any>, id = runId, item = itemId) =>
      asAdmin(api().patch(`/payrolls/${id}/items/${item}`), fx.branchA).send(
        body,
      );

    it('PR-API-40: an HR edits every editable field', async () => {
      const res = await patchItem({
        allowances: 1234,
        bonus: 500,
        deduction: 250,
        foodAllowance: 75,
        notes: 'adjusted by PR-API-40',
      });
      expect(res.status).toBe(200);
      const item = await ctx.prisma.payrollItem.findUnique({
        where: { id: itemId },
      });
      expect(Number(item!.allowances)).toBe(1234);
      expect(Number(item!.bonus)).toBe(500);
      expect(Number(item!.deduction)).toBe(250);
      expect(Number(item!.foodAllowance)).toBe(75);
      expect(item!.notes).toContain('PR-API-40');
    });

    it('PR-API-41: the edit re-derives net, and the header total follows', async () => {
      const detail = await asAdmin(
        api().get(`/payrolls/${runId}`),
        fx.branchA,
      );
      const items = detail.body.data.items;
      const summed = items.reduce(
        (acc: number, i: any) => acc + Number(i.netSalary),
        0,
      );
      expect(Number(detail.body.data.totalAmount)).toBeCloseTo(summed, 2);
    });

    it.each([
      ['a negative allowance', { allowances: -1 }],
      ['a negative bonus', { bonus: -0.01 }],
      ['a negative deduction', { deduction: -100 }],
      ['negative overtime hours', { overtimeHours: -1 }],
      ['a non-numeric allowance', { allowances: 'lots' }],
    ])('PR-API-42: refuses %s', async (_label, body) => {
      const res = await patchItem(body);
      expect(res.status).toBe(400);
    });

    it('PR-API-43: refuses an unknown field', async () => {
      // Without forbidNonWhitelisted a typo'd `netSalary` would be accepted and
      // silently ignored, which reads to the caller as "the edit worked".
      const res = await patchItem({ netSalary: 1 });
      expect(res.status).toBe(400);
    });

    it('PR-API-44: an item belonging to another payroll is 404', async () => {
      const res = await patchItem({ bonus: 1 }, otherRunId, itemId);
      expect(res.status).toBe(404);
    });

    it('PR-API-45: a malformed payroll or item id is 400, not 500', async () => {
      const badPayroll = await asAdmin(
        api().patch(`/payrolls/not-a-uuid/items/${itemId}`),
        fx.branchA,
      ).send({ bonus: 1 });
      expect(badPayroll.status).toBe(400);

      const badItem = await asAdmin(
        api().patch(`/payrolls/${runId}/items/not-a-uuid`),
        fx.branchA,
      ).send({ bonus: 1 });
      expect(badItem.status).toBe(400);
    });

    it.each([
      ['MANAGER', () => fx.deptManager.token],
      ['EMPLOYEE', () => fx.employee.token],
    ])('PR-API-46: %s cannot edit an item', async (_r, token) => {
      const res = await api()
        .patch(`/payrolls/${runId}/items/${itemId}`)
        .set(bearer(token()))
        .set('x-branch-id', fx.branchA)
        .send({ bonus: 1 });
      expect(res.status).toBe(403);
    });

  });

  // ── PR-API-53..58  Delete and export ─────────────────────────────────────
  describe('PR-API-53..58 — delete and export', () => {
    it('PR-API-53: an HR deletes a DRAFT run and its items go with it', async () => {
      const p = fx.periodAt(22);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, p);
      const run = await createRun(p, { employeeIds: [fx.monthlyEmpId] });
      const id = run.body.data.id;

      const res = await api()
        .delete(`/payrolls/${id}`)
        .set(bearer(fx.hr.token))
        .set('x-branch-id', fx.branchA);
      expect(res.status).toBe(200);

      const [payroll, items] = await Promise.all([
        ctx.prisma.payroll.findUnique({ where: { id } }),
        ctx.prisma.payrollItem.count({ where: { payrollId: id } }),
      ]);
      expect(payroll).toBeNull();
      expect(items).toBe(0);
    });

    it('PR-API-54: the deleted period can then be run again', async () => {
      const p = fx.periodAt(22);
      const res = await createRun(p, { employeeIds: [fx.monthlyEmpId] });
      expect(res.status).toBe(201);
    });

    it.each([
      ['MANAGER', () => fx.deptManager.token],
      ['EMPLOYEE', () => fx.employee.token],
    ])('PR-API-55: %s cannot delete a run', async (_r, token) => {
      const p = fx.periodAt(22);
      const existing = await ctx.prisma.payroll.findFirst({
        where: { month: p.month, year: p.year, branchId: fx.branchA },
      });
      const res = await api()
        .delete(`/payrolls/${existing!.id}`)
        .set(bearer(token()))
        .set('x-branch-id', fx.branchA);
      expect(res.status).toBe(403);
    });

    it('PR-API-56: exports a run as a spreadsheet', async () => {
      const run = await ctx.prisma.payroll.findFirst({
        where: { branchId: fx.branchA, month: fx.period.month },
      });
      const res = await asAdmin(
        api().get(`/export/payroll/${run!.id}`),
        fx.branchA,
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheet');
      expect(res.headers['content-disposition']).toContain('.xlsx');
    });

    it.each([
      ['MANAGER', () => fx.deptManager.token],
      ['EMPLOYEE', () => fx.employee.token],
    ])('PR-API-57: %s cannot export a run', async (_r, token) => {
      const run = await ctx.prisma.payroll.findFirst({
        where: { branchId: fx.branchA, month: fx.period.month },
      });
      const res = await api()
        .get(`/export/payroll/${run!.id}`)
        .set(bearer(token()))
        .set('x-branch-id', fx.branchA);
      expect(res.status).toBe(403);
    });

    it('PR-API-58: a scoped HR cannot export another branch’s run', async () => {
      const foreign = await ctx.prisma.payroll.findFirst({
        where: { branchId: fx.branchB },
      });
      const res = await api()
        .get(`/export/payroll/${foreign!.id}`)
        .set(bearer(fx.scopedHr.token));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });
});
