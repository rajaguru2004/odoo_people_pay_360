import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';

/**
 * `PE-RUN` — the guards around generating a payroll run.
 *
 * A run is the operation that turns records into money leaving a bank account,
 * and it is not undoable the way an ordinary write is — an unlock is a
 * compensating action, not an erase. So the guards are asserted on the SERVER'S
 * OWN SENTENCE, never on a status code alone: a 409 tells an operator nothing,
 * and the sentence is the only part they can act on.
 */
describe('Payroll edge — run guards (PE-RUN)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;

  const openPeriod = async (employeeId: string, period: { month: number; year: number }) => {
    await ctx.prisma.attendance.createMany({
      data: [
        {
          employeeId,
          branchId: branch(),
          date: new Date(Date.UTC(period.year, period.month - 1, 3)),
          status: 'PRESENT',
          workHours: 8,
        },
      ],
      skipDuplicates: true,
    });
  };

  const create = (body: Record<string, unknown>, withBranch = true) => {
    const req = api().post('/payrolls').set(admin());
    if (withBranch) req.set('X-Branch-Id', branch());
    return req.send(body);
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  describe('PE-RUN-01..04 — the payload judges itself, in words', () => {
    it('PE-RUN-01: a thirteenth month is refused by name', async () => {
      const res = await create({ month: 13, year: fx.period.year });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body?.message)).toMatch(/month must not be greater than 12/i);
    });

    it('PE-RUN-02: a year before the product existed is refused by name', async () => {
      const res = await create({ month: 1, year: 2019 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body?.message)).toMatch(/year must not be less than 2020/i);
    });

    it('PE-RUN-03: an unknown run type is refused and the valid set is listed', async () => {
      const res = await create({
        month: fx.period.month,
        year: fx.period.year,
        runType: 'NOT_A_TYPE',
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body?.message)).toMatch(/FINAL_SETTLEMENT/);
    });

    it('PE-RUN-04: with no branch selected, the refusal says what to do', async () => {
      // Payroll is per-branch by design and the header is the whole selection.
      // The sentence matters more than the code: the fix is a UI action.
      const res = await create({ month: fx.period.month, year: fx.period.year }, false);
      expect(res.status).toBe(400);
      expect(String(res.body?.message ?? '')).toMatch(/select a specific branch/i);
      expect(String(res.body?.message ?? '')).toMatch(/per-branch/i);
    });
  });

  describe('PE-RUN-10..13 — who a run picks up', () => {
    it('PE-RUN-10: INACTIVE staff are not paid', async () => {
      const period = fx.periodAt(5);
      await openPeriod(fx.fullMonthEmpId, period);

      const inactive = await ctx.prisma.employee.findFirst({
        where: { id: fx.base.terminatedEmpId },
        select: { id: true, status: true },
      });
      expect(inactive!.status).toBe('INACTIVE');

      const res = await create({
        month: period.month,
        year: period.year,
        employeeIds: [fx.fullMonthEmpId, inactive!.id],
      });
      expect(res.status).toBe(201);

      const full = await api()
        .get(`/payrolls/${res.body?.data?.id ?? res.body?.id}`)
        .set(admin())
        .set('X-Branch-Id', branch());
      const paid = ((full.body?.data ?? full.body).items ?? []).map((i: any) => i.employeeId);

      expect(paid).toContain(fx.fullMonthEmpId);
      expect(paid).not.toContain(inactive!.id);
    });

    it('PE-RUN-11: G23 — a run naming only unknown employees is REFUSED, not created empty', async () => {
      // Previously this answered 201 with zero items and totalAmount 0, and the
      // run-level attendance guard is skipped entirely when the population is
      // empty — so "payroll produced nothing" and "payroll was never given
      // anyone" were indistinguishable, and a mistyped filter produced a clean,
      // approvable, zero-value payroll.
      const period = fx.periodAt(6);
      const res = await create({
        month: period.month,
        year: period.year,
        employeeIds: ['00000000-0000-0000-0000-000000000000'],
      });

      expect(res.status).toBe(400);
      expect(String(res.body?.message ?? '')).toMatch(/none of the 1 selected employee/i);
      expect(String(res.body?.message ?? '')).toMatch(/payroll was not created/i);

      const rows = await ctx.prisma.payroll.count({
        where: { month: period.month, year: period.year, branchId: branch() },
      });
      expect(rows).toBe(0);
    });

    it('PE-RUN-11b: G23 — a PARTLY matched selection is created, and names the ids that matched nobody', async () => {
      // The common shape: some ids good, some stale. A flat refusal would block
      // a legitimate run, so the run is created for the ids that resolved and
      // the ones that did not are returned rather than silently dropped.
      const period = fx.periodAt(11);
      await openPeriod(fx.fullMonthEmpId, period);

      const ghost = '00000000-0000-0000-0000-000000000000';
      const res = await create({
        month: period.month,
        year: period.year,
        employeeIds: [fx.fullMonthEmpId, ghost],
      });

      expect(res.status).toBe(201);
      expect(res.body?.data?.unmatchedEmployeeIds).toEqual([ghost]);
      expect(res.body?.data?.employeeCount).toBe(1);
    });

    it('PE-RUN-12: a partial run covers exactly the employees it was given', async () => {
      const period = fx.periodAt(7);
      await openPeriod(fx.fullMonthEmpId, period);

      const res = await create({
        month: period.month,
        year: period.year,
        employeeIds: [fx.fullMonthEmpId],
      });
      expect(res.status).toBe(201);

      const full = await api()
        .get(`/payrolls/${res.body?.data?.id ?? res.body?.id}`)
        .set(admin())
        .set('X-Branch-Id', branch());
      const paid = ((full.body?.data ?? full.body).items ?? []).map((i: any) => i.employeeId);

      expect(paid).toEqual([fx.fullMonthEmpId]);
      expect(paid).not.toContain(fx.noAttendanceEmpId);
    });

    it('PE-RUN-13: a period with no attendance anywhere is refused, and says so', async () => {
      const period = fx.periodAt(8);
      const res = await create({
        month: period.month,
        year: period.year,
        employeeIds: [fx.fullMonthEmpId],
      });
      expect(res.status).toBe(400);
      expect(String(res.body?.message ?? '')).toMatch(
        /attendance for .* has not been processed/i,
      );
    });
  });

  describe('PE-RUN-20..22 — a period that is already occupied', () => {
    let lockedId = '';

    beforeAll(async () => {
      const period = fx.periodAt(9);
      await openPeriod(fx.fullMonthEmpId, period);
      const res = await create({
        month: period.month,
        year: period.year,
        employeeIds: [fx.fullMonthEmpId],
      });
      lockedId = res.body?.data?.id ?? res.body?.id;
      await api().post(`/payrolls/${lockedId}/submit`).set(admin()).set('X-Branch-Id', branch()).send({});
      await api().post(`/payrolls/${lockedId}/approve`).set(admin()).set('X-Branch-Id', branch()).send({});
      await api().post(`/payrolls/${lockedId}/lock`).set(admin()).set('X-Branch-Id', branch()).send({});
    });

    it('PE-RUN-20: G24 — regenerating over a LOCKED run names the lock AND the remedy', async () => {
      // The refusal used to be the same sentence an unlocked duplicate gets, so
      // the operator could not tell "wait for the current run" from "this period
      // is settled". Those need different actions, and only one of them works.
      const period = fx.periodAt(9);
      const again = await create({
        month: period.month,
        year: period.year,
        employeeIds: [fx.fullMonthEmpId],
      });
      expect(again.status).toBe(409);
      expect(String(again.body?.message ?? '')).toMatch(/is LOCKED/i);
      expect(String(again.body?.message ?? '')).toMatch(/create a revision/i);
    });

    it('PE-RUN-20b: an UNLOCKED duplicate still gets the plain occupied-period message', async () => {
      // The lock wording is scoped to locked runs; an in-flight DRAFT must not
      // tell an operator to create a revision, which would not work.
      const period = fx.periodAt(12);
      await openPeriod(fx.fullMonthEmpId, period);
      await create({
        month: period.month,
        year: period.year,
        employeeIds: [fx.fullMonthEmpId],
      });

      const again = await create({
        month: period.month,
        year: period.year,
        employeeIds: [fx.fullMonthEmpId],
      });
      expect(again.status).toBe(409);
      expect(String(again.body?.message ?? '')).toMatch(/already exists/i);
      expect(String(again.body?.message ?? '')).not.toMatch(/is LOCKED/i);
    });

    it('PE-RUN-21: a LOCKED run cannot be deleted, and THAT refusal names the lock', async () => {
      const res = await api()
        .delete(`/payrolls/${lockedId}`)
        .set(admin())
        .set('X-Branch-Id', branch());
      expect(res.status).toBe(400);
      expect(String(res.body?.message ?? '')).toMatch(/lock/i);
    });

    it('PE-RUN-22: two SIMULTANEOUS creates leave exactly one run behind', async () => {
      const period = fx.periodAt(10);
      await openPeriod(fx.fullMonthEmpId, period);

      const body = {
        month: period.month,
        year: period.year,
        employeeIds: [fx.fullMonthEmpId],
      };
      const [a, b] = await Promise.all([create(body), create(body)]);
      const statuses = [a.status, b.status].sort();

      // This is the assertion that a duplicate-period INDEX exists at all. Phase
      // 4 found the e2e template had none — the real one is an EXPRESSION index
      // that `prisma db push` cannot create — so two simultaneous creates both
      // returned 201 and a period could be paid twice. Read a failure here as
      // "the index is missing again", not as a flaky race.
      expect(statuses[0]).toBe(201);
      expect(statuses[1]).toBeGreaterThanOrEqual(400);

      const rows = await ctx.prisma.payroll.count({
        where: { month: period.month, year: period.year, branchId: branch() },
      });
      expect(rows).toBe(1);
    });
  });
});
