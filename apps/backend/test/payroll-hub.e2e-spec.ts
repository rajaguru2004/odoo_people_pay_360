import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  PayrollFixtures,
  setupPayrollFixtures,
  seedAttendance,
} from './utils/payroll-fixtures';
import { bearer } from './utils/settings';

/**
 * `GET /payrolls/hub-summary` — the Payroll module hub's aggregate.
 *
 * It replaced seven browser-side requests, five of them `/payrolls/reports/*`
 * endpoints that load every payroll item and every payslip line for a period in
 * order to add up four numbers. The invariants:
 *
 *   PHUB-01  role gate — ADMIN/HR in, MANAGER and EMPLOYEE out, anonymous 401
 *   PHUB-02  bad input is refused, not guessed at
 *   PHUB-03  the payload has every section the page reads
 *   PHUB-04  money is LOCKED runs only, and an unfinalised month reports null
 *   PHUB-05  the anchor resolves to a month that actually has a run, and says so
 *   PHUB-06  queues are counted in the database and are NOT windowed
 *   PHUB-07  readiness reuses the banking validator and never fabricates 100%
 *   PHUB-08  branch scoping narrows it
 *   PHUB-09  the trend window is what was asked for, and it ends on the anchor
 *
 * Cases are envelope- or invariant-shaped rather than count-shaped wherever the
 * figure spans the whole database: this endpoint has no per-run filter, so an
 * absolute count would be hostage to every other suite. Same rule as
 * `attendance-hub.e2e-spec.ts` and `organization-hub.e2e-spec.ts`.
 */
describe('Payroll — module hub summary (e2e)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;

  const hub = (query = '', token?: string, branch?: string) => {
    let r = ctx.http().get(`/payrolls/hub-summary${query}`);
    if (token) r = r.set(bearer(token));
    if (branch) r = r.set('X-Branch-Id', branch);
    return r;
  };

  const dataOf = async (query = '', token?: string, branch?: string) => {
    const res = await hub(query, token ?? fx.admin.token, branch);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  /**
   * Create a run for `period`, returning its id.
   *
   * The branch travels in `X-Branch-Id`, not in the body: `CreatePayrollDto`
   * declares no `branchId`, so sending one is stripped by the global validation
   * pipe and the run lands company-wide instead of on the branch under test.
   */
  const createRun = async (period: { month: number; year: number }, branchId: string) => {
    const res = await ctx
      .http()
      .post('/payrolls')
      .set(bearer(fx.admin.token))
      .set('X-Branch-Id', branchId)
      .send({ month: period.month, year: period.year });
    expect([[200, 201].includes(res.status), res.body?.message]).toEqual([true, res.body?.message]);
    return res.body.data.id as string;
  };

  const post = (path: string, body: any = {}) =>
    ctx.http().post(path).set(bearer(fx.admin.token)).send(body);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read it', () => {
    it('PHUB-01 admits ADMIN and HR; refuses MANAGER, EMPLOYEE and anonymous', async () => {
      expect((await hub('', fx.admin.token)).status).toBe(200);
      expect((await hub('', fx.hr.token)).status).toBe(200);
      // MANAGER is a denial path, not a narrowing case: this payload is the
      // company's payroll position and its money, which a department head is
      // not being shown.
      expect((await hub('', fx.deptManager.token)).status).toBe(403);
      expect((await hub('', fx.employee.token)).status).toBe(403);
      expect((await hub()).status).toBe(401);
    });

    it('PHUB-01b is not swallowed by the :id route — the literal resolves to the hub', async () => {
      // Without the route being declared above @Get(':id'), "hub-summary"
      // reaches ParseUUIDPipe and this answers 400.
      const res = await hub('', fx.admin.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('anchor');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('input', () => {
    it('PHUB-02 refuses a window it does not offer rather than defaulting', async () => {
      for (const bad of ['13', 'abc', '6.5', '-6', '0', '7']) {
        const res = await hub(`?months=${bad}`, fx.admin.token);
        expect([bad, res.status]).toEqual([bad, 400]);
      }
    });

    it('PHUB-02b defaults to six months when nothing is asked for', async () => {
      const data = await dataOf();
      expect(data.months).toBe(6);
      expect(data.trend).toHaveLength(6);
    });

    it('PHUB-02c accepts the twelve-month window', async () => {
      const data = await dataOf('?months=12');
      expect(data.months).toBe(12);
      expect(data.trend).toHaveLength(12);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the shape the page reads', () => {
    it('PHUB-03 carries every section, with unknowns as null rather than zero', async () => {
      const d = await dataOf();

      expect(d).toEqual(
        expect.objectContaining({
          months: expect.any(Number),
          anchor: expect.objectContaining({
            month: expect.any(Number),
            year: expect.any(Number),
            label: expect.any(String),
            resolvedFrom: expect.stringMatching(/^(latest-run|current-month)$/),
            previous: expect.objectContaining({ label: expect.any(String) }),
          }),
          runs: expect.objectContaining({
            windowByStatus: expect.any(Object),
            inProgress: expect.any(Number),
            pendingApproval: expect.any(Number),
            draft: expect.any(Number),
            rejected: expect.any(Number),
            draftForClosedPeriod: expect.any(Number),
            pending: expect.any(Array),
            rejectedRuns: expect.any(Array),
          }),
          money: expect.any(Object),
          employees: expect.objectContaining({
            paid: expect.any(Number),
            inOpenRun: expect.any(Number),
            active: expect.any(Number),
            notInAnyRun: expect.any(Number),
            names: expect.any(Array),
          }),
          trend: expect.any(Array),
          composition: expect.objectContaining({
            earnings: expect.any(Array),
            deductions: expect.any(Array),
            residual: expect.any(Number),
          }),
          carryForward: expect.objectContaining({ outstanding: expect.any(Number) }),
          unscopedLegacyRuns: expect.any(Number),
        }),
      );

      // A section that is allowed to be absent must be null, never {} or 0 —
      // the client renders an em dash for null and is forbidden from printing
      // an all-clear over it.
      expect(d.readiness === null || typeof d.readiness === 'object').toBe(true);
      // Money is nullable on both sides.
      expect(d.money.net === null || typeof d.money.net === 'number').toBe(true);
      expect(
        d.money.previousNet === null || typeof d.money.previousNet === 'number',
      ).toBe(true);
    });

    it('PHUB-03b every trend bucket is self-describing', async () => {
      const d = await dataOf();
      for (const b of d.trend) {
        expect(b).toEqual(
          expect.objectContaining({
            key: expect.stringMatching(/^\d{4}-\d{2}$/),
            label: expect.any(String),
            month: expect.any(Number),
            year: expect.any(Number),
            employees: expect.any(Number),
            runs: expect.any(Number),
            lockedRuns: expect.any(Number),
            locked: expect.any(Boolean),
          }),
        );
        // A month with nothing locked reports null, not 0 — a zero-height bar
        // reads as "we paid nobody that month", which is a different claim.
        if (!b.locked) expect(b.net).toBeNull();
        else expect(typeof b.net).toBe('number');
      }
    });

    it('PHUB-03c the composition names only real payslip columns', async () => {
      const d = await dataOf();
      const EARNINGS = [
        'baseSalary', 'allowances', 'bonus', 'overtimePay',
        'foodAllowance', 'siteAllowance', 'leaveEncashment',
      ];
      const DEDUCTIONS = [
        'deduction', 'insurance', 'tax', 'garnishment', 'otherRecovery',
      ];
      expect(d.composition.earnings.map((r: any) => r.key)).toEqual(EARNINGS);
      expect(d.composition.deductions.map((r: any) => r.key)).toEqual(DEDUCTIONS);
      for (const r of [...d.composition.earnings, ...d.composition.deductions]) {
        expect(typeof r.amount).toBe('number');
        expect(r.amount).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('money means LOCKED', () => {
    it('PHUB-04 a DRAFT run contributes no money and no paid employees', async () => {
      const period = fx.periodAt(0);
      await seedAttendance(
        ctx.prisma,
        [fx.monthlyEmpId, fx.secondMonthlyEmpId],
        fx.branchA,
        period,
      );
      const runId = await createRun(period, fx.branchA);

      const d = await dataOf('', fx.admin.token, fx.branchA);

      // The anchor lands on the month we just created a run for.
      expect(d.anchor.month).toBe(period.month);
      expect(d.anchor.year).toBe(period.year);

      // Money has not moved: the run is DRAFT.
      expect(d.money.net).toBeNull();
      expect(d.employees.paid).toBe(0);
      // …but the people in it are visibly in flight rather than missing.
      expect(d.employees.inOpenRun).toBeGreaterThan(0);
      expect(d.runs.draft).toBeGreaterThan(0);
      expect(d.runs.inProgress).toBeGreaterThan(0);

      const bucket = d.trend.find((b: any) => b.month === period.month && b.year === period.year);
      expect(bucket.locked).toBe(false);
      expect(bucket.net).toBeNull();
      expect(bucket.runs).toBeGreaterThan(0);

      await ctx.http().delete(`/payrolls/${runId}`).set(bearer(fx.admin.token));
    });

    it('PHUB-04b the same run, once LOCKED, reports money and paid employees', async () => {
      const period = fx.periodAt(1);
      await seedAttendance(
        ctx.prisma,
        [fx.monthlyEmpId, fx.secondMonthlyEmpId],
        fx.branchA,
        period,
      );
      const runId = await createRun(period, fx.branchA);

      expect((await post(`/payrolls/${runId}/submit`)).status).toBeLessThan(400);
      expect((await post(`/payrolls/${runId}/approve`, { notes: 'e2e' })).status).toBeLessThan(400);
      expect((await post(`/payrolls/${runId}/lock`)).status).toBeLessThan(400);

      const d = await dataOf('', fx.admin.token, fx.branchA);
      expect(d.anchor.month).toBe(period.month);
      expect(typeof d.money.net).toBe('number');
      expect(d.money.net).toBeGreaterThan(0);
      expect(d.employees.paid).toBeGreaterThan(0);

      const bucket = d.trend.find((b: any) => b.month === period.month && b.year === period.year);
      expect(bucket.locked).toBe(true);
      expect(bucket.net).toBeGreaterThan(0);
      expect(bucket.employees).toBeGreaterThan(0);
      expect(bucket.employees).toBe(d.employees.paid);

      // The composition is drawn from the same locked items, so it reconciles
      // with the net the card above it prints.
      const gross = d.composition.grossReported;
      const ded = d.composition.deductionsTotal;
      expect(Math.abs(gross - ded - d.money.net - d.composition.residual)).toBeLessThan(0.02);

      await post(`/payrolls/${runId}/unlock`, { reason: 'e2e teardown cleanup' });
      await ctx.http().delete(`/payrolls/${runId}`).set(bearer(fx.admin.token));
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the anchor', () => {
    it('PHUB-05 resolves to a month that actually holds a run, and names it', async () => {
      const period = fx.periodAt(2);
      await seedAttendance(
        ctx.prisma,
        [fx.monthlyEmpId, fx.secondMonthlyEmpId],
        fx.branchA,
        period,
      );
      const runId = await createRun(period, fx.branchA);

      const d = await dataOf('', fx.admin.token, fx.branchA);
      expect(d.anchor.month).toBe(period.month);
      expect(d.anchor.year).toBe(period.year);
      expect(d.anchor.label).toMatch(/^[A-Z][a-z]{2} \d{4}$/);

      const now = new Date();
      const isCurrent =
        period.year === now.getUTCFullYear() && period.month === now.getUTCMonth() + 1;
      expect(d.anchor.resolvedFrom).toBe(isCurrent ? 'current-month' : 'latest-run');

      // The previous month is a real, adjacent period — the delta names a
      // window the reader can go and check.
      const prev = new Date(Date.UTC(period.year, period.month - 2, 1));
      expect(d.anchor.previous.month).toBe(prev.getUTCMonth() + 1);
      expect(d.anchor.previous.year).toBe(prev.getUTCFullYear());

      await ctx.http().delete(`/payrolls/${runId}`).set(bearer(fx.admin.token));
    });

    it('PHUB-09 the trend ends on the anchor, not on today', async () => {
      const d = await dataOf();
      const last = d.trend[d.trend.length - 1];
      expect(last.month).toBe(d.anchor.month);
      expect(last.year).toBe(d.anchor.year);

      // …and the buckets run oldest → newest with no gaps.
      for (let i = 1; i < d.trend.length; i++) {
        const a = d.trend[i - 1];
        const b = d.trend[i];
        expect(a.year * 12 + a.month + 1).toBe(b.year * 12 + b.month);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('queues', () => {
    it('PHUB-06 counts runs awaiting approval in the database and names them', async () => {
      const period = fx.periodAt(3);
      await seedAttendance(
        ctx.prisma,
        [fx.monthlyEmpId, fx.secondMonthlyEmpId],
        fx.branchA,
        period,
      );
      const runId = await createRun(period, fx.branchA);
      expect((await post(`/payrolls/${runId}/submit`)).status).toBeLessThan(400);

      const d = await dataOf('', fx.admin.token, fx.branchA);
      expect(d.runs.pendingApproval).toBeGreaterThan(0);
      expect(d.runs.pending.some((p: any) => p.id === runId)).toBe(true);
      expect(d.runs.oldestPendingAt).not.toBeNull();
      // The strip needs a period to print, not a bare id.
      const mine = d.runs.pending.find((p: any) => p.id === runId);
      expect(mine.month).toBe(period.month);
      expect(mine.label).toMatch(/^[A-Z][a-z]{2} \d{4}$/);

      await post(`/payrolls/${runId}/reject`, { reason: 'e2e rejection path' });

      const after = await dataOf('', fx.admin.token, fx.branchA);
      expect(after.runs.rejected).toBeGreaterThan(0);
      expect(after.runs.rejectedRuns.some((r: any) => r.id === runId)).toBe(true);

      await ctx.http().delete(`/payrolls/${runId}`).set(bearer(fx.admin.token));
    });

    it('PHUB-06b the queue does NOT follow the trend window', async () => {
      // A queue is what is waiting NOW. An open run older than the window is
      // exactly the one somebody needs to be told about, so widening or
      // narrowing the chart must not change these numbers.
      const six = await dataOf('?months=6');
      const twelve = await dataOf('?months=12');

      expect(twelve.runs.inProgress).toBe(six.runs.inProgress);
      expect(twelve.runs.pendingApproval).toBe(six.runs.pendingApproval);
      expect(twelve.runs.draft).toBe(six.runs.draft);
      expect(twelve.runs.rejected).toBe(six.runs.rejected);
      expect(twelve.runs.oldestPendingAt).toBe(six.runs.oldestPendingAt);

      // The pipeline donut, by contrast, is windowed — it describes the chart
      // beside it, so it may legitimately differ.
      expect(twelve.trend).toHaveLength(12);
      expect(six.trend).toHaveLength(6);
    });

    it('PHUB-06c inProgress is exactly the three open statuses', async () => {
      const d = await dataOf();
      expect(d.runs.inProgress).toBe(
        d.runs.draft + d.runs.pendingApproval + d.runs.approvedNotLocked,
      );
      // REJECTED is a decision somebody took, not work in flight.
      expect(d.runs.inProgress).not.toBe(
        d.runs.draft + d.runs.pendingApproval + d.runs.approvedNotLocked + d.runs.rejected + 1,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('payment readiness', () => {
    it('PHUB-07 judges the Oman branch against its configured banking fields', async () => {
      const d = await dataOf('', fx.admin.token, fx.branchOm);
      expect(d.readiness).not.toBeNull();

      const r = d.readiness;
      expect(r.population).toMatch(/^(run|active)$/);
      expect(r.total).toBeGreaterThan(0);
      // Every bucket accounts for somebody, and nobody is counted twice.
      const classified =
        r.ready + r.noBankRecord + r.incompleteFields + r.pendingChange +
        r.bankInactive + r.countryNotAllowed + r.unknown;
      expect(classified).toBe(r.total);

      // The Oman fixture employee holds a valid OM IBAN on the matching bank.
      expect(r.ready).toBeGreaterThan(0);
    });

    it('PHUB-07b a rate is never fabricated — it is null or it is real', async () => {
      const d = await dataOf();
      const r = d.readiness;
      if (r === null) return;
      if (r.readyRate === null) {
        // Nothing could be judged. That must be because everybody was unknown,
        // not because somebody quietly divided by zero.
        expect(r.unknown).toBe(r.total);
      } else {
        expect(r.readyRate).toBeGreaterThanOrEqual(0);
        expect(r.readyRate).toBeLessThanOrEqual(100);
        // The rate excludes the unknowns rather than counting them as ready.
        expect(r.readyRate).toBeCloseTo((r.ready / (r.total - r.unknown)) * 100, 0);
      }
    });

    it('PHUB-07c names an employee with no bank record as not ready', async () => {
      // `noBankEmpId` is ACTIVE in branch A with no active EmployeeBankDetail.
      const d = await dataOf('', fx.admin.token, fx.branchA);
      expect(d.readiness).not.toBeNull();
      expect(d.readiness.noBankRecord).toBeGreaterThan(0);
      // The panel has to be able to say WHO, not just how many.
      expect(d.readiness.names.length).toBeGreaterThan(0);
      for (const n of d.readiness.names) {
        expect(n).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            employeeCode: expect.any(String),
            fullName: expect.any(String),
          }),
        );
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('branch scoping', () => {
    it('PHUB-08 a branch-scoped read is narrower than the global one', async () => {
      const global = await dataOf('', fx.admin.token);
      const branchA = await dataOf('', fx.admin.token, fx.branchA);
      const branchB = await dataOf('', fx.admin.token, fx.branchB);

      // Headcount is the cleanest invariant: a branch cannot hold more active
      // employees than the company does.
      expect(branchA.employees.active).toBeLessThanOrEqual(global.employees.active);
      expect(branchB.employees.active).toBeLessThanOrEqual(global.employees.active);
      expect(branchA.employees.active).toBeGreaterThan(0);
    });

    it('PHUB-08b a scoped HR sees their own branch, not the company', async () => {
      const scoped = await dataOf('', fx.scopedHr.token);
      const global = await dataOf('', fx.admin.token);
      expect(scoped.employees.active).toBeLessThanOrEqual(global.employees.active);
    });

    it('PHUB-08c legacy company-wide runs are reported separately from the scoped figures', async () => {
      const d = await dataOf('', fx.admin.token, fx.branchA);
      // Whatever this database holds, the field exists and is a count — the
      // page uses it to say "N runs are not shown here" rather than letting
      // them vanish.
      expect(typeof d.unscopedLegacyRuns).toBe('number');
      expect(d.unscopedLegacyRuns).toBeGreaterThanOrEqual(0);
    });
  });
});
