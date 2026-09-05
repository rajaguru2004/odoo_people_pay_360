import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollFixtures,
  seedAttendance,
  PayrollFixtures,
  bearer,
} from './utils/payroll-fixtures';

/**
 * Payroll batches — Phase 4, chunk C4.
 *
 * A batch is a named, per-branch group of employees. It has **no lifecycle**:
 * `PayrollBatch` carries `isActive` and nothing writes it, there is no
 * PROCESSING/COMPLETED state and no batch-run endpoint. "Batch processing" is
 * expressed entirely as `POST /payrolls { batchId }`, which expands
 * `PayrollBatchMember` into the run's target employees.
 *
 * That absence is worth asserting rather than assuming: a regression that
 * introduced a half-built status column would otherwise pass unnoticed.
 */
describe('Payroll batches (e2e)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;
  let periodCursor = 60;

  const api = () => ctx.http();
  const as = (token: string, req: any, branchId?: string | null) => {
    req.set(bearer(token));
    if (branchId) req.set('x-branch-id', branchId);
    return req;
  };
  const asAdmin = (req: any, branchId: string | null = fx.branchA) =>
    as(fx.admin.token, req, branchId);

  const createBatch = (employeeIds: string[], name?: string, branch = fx.branchA) =>
    asAdmin(api().post('/payroll-batches'), branch).send({
      name: name ?? `Batch ${fx.runId}-${periodCursor++}`,
      description: 'created by payroll-batch.e2e-spec',
      employeeIds,
    });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── PB-API-01..09  CRUD ──────────────────────────────────────────────────
  describe('PB-API-01..09 — create, read, update, delete', () => {
    let batchId: string;

    it('PB-API-01: an ADMIN creates a batch with members', async () => {
      const res = await createBatch([fx.monthlyEmpId, fx.dailyEmpId]);
      expect(res.status).toBe(201);
      expect(res.body.data.branchId).toBe(fx.branchA);
      expect(res.body.data.isActive).toBe(true);
      batchId = res.body.data.id;

      const members = await ctx.prisma.payrollBatchMember.count({
        where: { batchId },
      });
      expect(members).toBe(2);
    });

    it('PB-API-02: reading a batch returns its members and a count', async () => {
      const res = await asAdmin(api().get(`/payroll-batches/${batchId}`));
      expect(res.status).toBe(200);
      const memberIds = res.body.data.members.map((m: any) => m.employeeId);
      expect(memberIds.sort()).toEqual(
        [fx.monthlyEmpId, fx.dailyEmpId].sort(),
      );
    });

    it('PB-API-03: the list is scoped to the caller’s branches', async () => {
      const foreign = await createBatch([fx.branchBEmpId], undefined, fx.branchB);
      expect(foreign.status).toBe(201);

      const scoped = await api()
        .get('/payroll-batches')
        .set(bearer(fx.scopedHr.token));
      expect(scoped.status).toBe(200);
      const ids = scoped.body.data.map((b: any) => b.id);
      expect(ids).toContain(batchId);
      expect(ids).not.toContain(foreign.body.data.id);
    });

    it('PB-API-04: duplicate employeeIds are de-duplicated', async () => {
      const res = await createBatch([
        fx.monthlyEmpId,
        fx.monthlyEmpId,
        fx.secondMonthlyEmpId,
      ]);
      expect(res.status).toBe(201);
      const members = await ctx.prisma.payrollBatchMember.count({
        where: { batchId: res.body.data.id },
      });
      expect(members).toBe(2);
    });

    it('PB-API-05: a batch cannot reach into another branch', async () => {
      const res = await createBatch([fx.monthlyEmpId, fx.branchBEmpId]);
      expect(res.status).toBe(400);
    });

    it('PB-API-06: creating without a concrete branch is refused', async () => {
      const res = await api()
        .post('/payroll-batches')
        .set(bearer(fx.admin.token))
        .send({ name: `Unbranched ${fx.runId}`, employeeIds: [fx.monthlyEmpId] });
      expect(res.status).toBe(400);
    });

    it('PB-API-07: PATCH with employeeIds replaces the WHOLE member set', async () => {
      const res = await asAdmin(
        api().patch(`/payroll-batches/${batchId}`),
      ).send({ employeeIds: [fx.secondMonthlyEmpId] });
      expect(res.status).toBe(200);

      const members = await ctx.prisma.payrollBatchMember.findMany({
        where: { batchId },
      });
      expect(members.map((m) => m.employeeId)).toEqual([
        fx.secondMonthlyEmpId,
      ]);
    });

    it('PB-API-08: PATCH without employeeIds leaves the members untouched', async () => {
      const res = await asAdmin(
        api().patch(`/payroll-batches/${batchId}`),
      ).send({ description: 'renamed only' });
      expect(res.status).toBe(200);

      const members = await ctx.prisma.payrollBatchMember.count({
        where: { batchId },
      });
      expect(members).toBe(1);
    });

    it('PB-API-09: `isActive` is never written by any path — there is no batch lifecycle', async () => {
      // Regression lock. `PayrollBatch.isActive` exists but no service path sets
      // it; a batch has no PROCESSING or COMPLETED state. If that ever changes it
      // must be a deliberate feature, not a side effect.
      await asAdmin(api().patch(`/payroll-batches/${batchId}`)).send({
        description: 'still active',
      });
      const row = await ctx.prisma.payrollBatch.findUnique({
        where: { id: batchId },
      });
      expect(row!.isActive).toBe(true);

      const rejected = await asAdmin(
        api().patch(`/payroll-batches/${batchId}`),
      ).send({ isActive: false });
      expect(rejected.status).toBe(400);
    });
  });

  // ── PB-API-10..19  Members ───────────────────────────────────────────────
  describe('PB-API-10..19 — members', () => {
    let batchId: string;

    beforeAll(async () => {
      const res = await createBatch([fx.monthlyEmpId]);
      batchId = res.body.data.id;
    });

    it('PB-API-10: adds members', async () => {
      const res = await asAdmin(
        api().post(`/payroll-batches/${batchId}/members`),
      ).send({ employeeIds: [fx.secondMonthlyEmpId, fx.dailyEmpId] });
      expect(res.status).toBe(201);
      expect(
        await ctx.prisma.payrollBatchMember.count({ where: { batchId } }),
      ).toBe(3);
    });

    it('PB-API-11: adding an existing member is a no-op, not a duplicate', async () => {
      const res = await asAdmin(
        api().post(`/payroll-batches/${batchId}/members`),
      ).send({ employeeIds: [fx.monthlyEmpId] });
      expect(res.status).toBe(201);
      expect(
        await ctx.prisma.payrollBatchMember.count({
          where: { batchId, employeeId: fx.monthlyEmpId },
        }),
      ).toBe(1);
    });

    it('PB-API-12: two simultaneous adds of the same employee still leave one row', async () => {
      // @@unique([batchId, employeeId]) is what holds this; the "already a
      // member" read in the service is advisory.
      const fresh = await createBatch([fx.monthlyEmpId]);
      const id = fresh.body.data.id;
      await Promise.all([
        asAdmin(api().post(`/payroll-batches/${id}/members`)).send({
          employeeIds: [fx.dailyEmpId],
        }),
        asAdmin(api().post(`/payroll-batches/${id}/members`)).send({
          employeeIds: [fx.dailyEmpId],
        }),
      ]);
      expect(
        await ctx.prisma.payrollBatchMember.count({
          where: { batchId: id, employeeId: fx.dailyEmpId },
        }),
      ).toBe(1);
    });

    it('PB-API-13: adding a cross-branch employee is refused', async () => {
      const res = await asAdmin(
        api().post(`/payroll-batches/${batchId}/members`),
      ).send({ employeeIds: [fx.branchBEmpId] });
      expect(res.status).toBe(400);
    });

    it('PB-API-14: removes a member', async () => {
      const res = await asAdmin(
        api().delete(`/payroll-batches/${batchId}/members/${fx.dailyEmpId}`),
      );
      expect(res.status).toBe(200);
      expect(
        await ctx.prisma.payrollBatchMember.count({
          where: { batchId, employeeId: fx.dailyEmpId },
        }),
      ).toBe(0);
    });

    it('PB-API-15: removing a non-member is 404', async () => {
      const res = await asAdmin(
        api().delete(`/payroll-batches/${batchId}/members/${fx.dailyEmpId}`),
      );
      expect(res.status).toBe(404);
    });

    it('PB-API-18: a scoped HR cannot touch another branch’s batch', async () => {
      const foreign = await createBatch(
        [fx.branchBEmpId],
        undefined,
        fx.branchB,
      );
      const id = foreign.body.data.id;

      const read = await api()
        .get(`/payroll-batches/${id}`)
        .set(bearer(fx.scopedHr.token));
      expect([403, 404]).toContain(read.status);

      const removal = await api()
        .delete(`/payroll-batches/${id}/members/${fx.branchBEmpId}`)
        .set(bearer(fx.scopedHr.token));
      expect([403, 404]).toContain(removal.status);
      // And the member is still there.
      expect(
        await ctx.prisma.payrollBatchMember.count({ where: { batchId: id } }),
      ).toBe(1);
    });

    it('PB-API-19: the members body is validated', async () => {
      for (const body of [
        {},
        { employeeIds: 'not-an-array' },
        { employeeIds: [] },
        { employeeIds: ['not-a-uuid'] },
        { employeeIds: [fx.monthlyEmpId], extra: true },
      ]) {
        const res = await asAdmin(
          api().post(`/payroll-batches/${batchId}/members`),
        ).send(body);
        expect(res.status).toBe(400);
      }
    });

    it('PB-API-20: a malformed batch or employee id is 400, not 500', async () => {
      expect(
        (await asAdmin(api().get('/payroll-batches/not-a-uuid'))).status,
      ).toBe(400);
      expect(
        (
          await asAdmin(
            api().delete(`/payroll-batches/${batchId}/members/not-a-uuid`),
          )
        ).status,
      ).toBe(400);
    });
  });

  // ── PB-API-21..26  Role matrix, delete, and the run seam ─────────────────
  describe('PB-API-21..26 — roles, delete, and running a batch', () => {
    it.each([
      ['MANAGER', () => fx.deptManager.token],
      ['EMPLOYEE', () => fx.employee.token],
    ])('PB-API-21: %s is refused every batch door', async (_r, token) => {
      const existing = await createBatch([fx.monthlyEmpId]);
      const id = existing.body.data.id;
      for (const call of [
        () => as(token(), api().get('/payroll-batches'), fx.branchA),
        () => as(token(), api().get(`/payroll-batches/${id}`), fx.branchA),
        () =>
          as(token(), api().post('/payroll-batches'), fx.branchA).send({
            name: 'nope',
            employeeIds: [fx.monthlyEmpId],
          }),
        () =>
          as(token(), api().delete(`/payroll-batches/${id}`), fx.branchA),
      ]) {
        expect((await call()).status).toBe(403);
      }
    });

    it('PB-API-22: an anonymous caller is 401', async () => {
      expect((await api().get('/payroll-batches')).status).toBe(401);
    });

    it('PB-API-23: a batch drives a payroll run over exactly its members', async () => {
      const batch = await createBatch([fx.monthlyEmpId, fx.secondMonthlyEmpId]);
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(
        ctx.prisma,
        [fx.monthlyEmpId, fx.secondMonthlyEmpId],
        fx.branchA,
        period,
      );

      const run = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
        batchId: batch.body.data.id,
      });
      expect(run.status).toBe(201);
      expect(run.body.data.employeeCount).toBe(2);
      expect(run.body.data.batchId).toBe(batch.body.data.id);
    });

    it('PB-API-24: an EMPTY batch cannot be run', async () => {
      const batch = await createBatch([fx.monthlyEmpId]);
      await asAdmin(
        api().delete(
          `/payroll-batches/${batch.body.data.id}/members/${fx.monthlyEmpId}`,
        ),
      );
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, period);

      const run = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
        batchId: batch.body.data.id,
      });
      expect(run.status).toBe(400);
      expect(run.body.message).toContain('no employees');
    });

    it('PB-API-25: the same period can be run once per batch AND once unbatched', async () => {
      // The uniqueness index keys on (month, year, branch, batch, version), so a
      // batch run and a whole-branch run for one month are different rows — which
      // is the point of batches, and would break if the index dropped batch_id.
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, period);
      const batch = await createBatch([fx.monthlyEmpId]);

      const batched = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
        batchId: batch.body.data.id,
      });
      expect(batched.status).toBe(201);

      const unbatched = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
      });
      expect(unbatched.status).toBe(201);

      const again = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
        batchId: batch.body.data.id,
      });
      expect(again.status).toBe(409);
    });

    it('PB-API-26: deleting a batch cascades members and detaches the run', async () => {
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, period);
      const batch = await createBatch([fx.monthlyEmpId]);
      const batchId = batch.body.data.id;

      const run = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
        batchId,
      });
      expect(run.status).toBe(201);

      const res = await asAdmin(api().delete(`/payroll-batches/${batchId}`));
      expect(res.status).toBe(200);

      const [members, payroll] = await Promise.all([
        ctx.prisma.payrollBatchMember.count({ where: { batchId } }),
        ctx.prisma.payroll.findUnique({ where: { id: run.body.data.id } }),
      ]);
      expect(members).toBe(0);
      // SetNull, not cascade: the run happened and its history must survive the
      // group it was generated from.
      expect(payroll).not.toBeNull();
      expect(payroll!.batchId).toBeNull();
    });
  });
});
