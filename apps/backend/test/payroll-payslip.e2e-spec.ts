import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollFixtures,
  seedAttendance,
  PayrollFixtures,
  Period,
  bearer,
} from './utils/payroll-fixtures';

/**
 * Payslips and the employee self-service doors — Phase 4, chunk C4.
 *
 * There are TWO ways to read a payslip and they do not agree by accident:
 *
 *  - `GET /payrolls/my-payslips/*` derives the employee from the TOKEN and has
 *    always been limited to `APPROVED | LOCKED`.
 *  - `GET /payrolls/payslip/:employeeId/:month/:year` takes the employee from
 *    the URL. Its role rules live in the controller, and until Phase 4 it had no
 *    status gate at all — so an in-scope manager could read a subordinate's
 *    DRAFT payslip while the same person's own self-service view refused it.
 *
 * The pair is the point of this file: the same employee, the same month, read
 * through both doors, must never disagree about what is publishable.
 */
describe('Payslips and employee self-service (e2e)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;

  /** A LOCKED run over the whole of branch A, in `fx.period`. */
  let lockedPeriod: Period;
  /** A DRAFT run over the whole of branch A, in another period. */
  let draftPeriod: Period;

  const api = () => ctx.http();
  const as = (token: string, req: any, branchId: string | null = fx.branchA) => {
    req.set(bearer(token));
    if (branchId) req.set('x-branch-id', branchId);
    return req;
  };
  const asAdmin = (req: any, branchId: string | null = fx.branchA) =>
    as(fx.admin.token, req, branchId);

  const payslipPath = (employeeId: string, p: Period) =>
    `/payrolls/payslip/${employeeId}/${p.month}/${p.year}`;

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);

    lockedPeriod = fx.period;
    const locked = await asAdmin(api().post('/payrolls')).send({
      month: lockedPeriod.month,
      year: lockedPeriod.year,
    });
    const lockedId = locked.body.data.id;
    await asAdmin(api().post(`/payrolls/${lockedId}/submit`));
    await asAdmin(api().post(`/payrolls/${lockedId}/approve`)).send({});
    await asAdmin(api().post(`/payrolls/${lockedId}/lock`));

    draftPeriod = fx.periodAt(80);
    await seedAttendance(
      ctx.prisma,
      [fx.monthlyEmpId, fx.foreignDeptEmpId],
      fx.branchA,
      draftPeriod,
    );
    await asAdmin(api().post('/payrolls')).send({
      month: draftPeriod.month,
      year: draftPeriod.year,
    });
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── PS-API-01..07  my-payslips ───────────────────────────────────────────
  describe('PS-API-01..07 — the self-service doors', () => {
    it('PS-API-01: an employee lists only their own finalized payslips', async () => {
      const res = await as(fx.employee.token, api().get('/payrolls/my-payslips/list'));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const slip of res.body.data) {
        expect(slip.employeeId).toBe(fx.monthlyEmpId);
        expect(['APPROVED', 'LOCKED']).toContain(slip.payroll.status);
      }
    });

    it('PS-API-02: the DRAFT run is absent from that list', async () => {
      const res = await as(fx.employee.token, api().get('/payrolls/my-payslips/list'));
      const periods = res.body.data.map((s: any) => `${s.payroll.month}/${s.payroll.year}`);
      expect(periods).not.toContain(`${draftPeriod.month}/${draftPeriod.year}`);
      expect(periods).toContain(`${lockedPeriod.month}/${lockedPeriod.year}`);
    });

    it('PS-API-03: an employee can open their own payslip detail', async () => {
      const list = await as(fx.employee.token, api().get('/payrolls/my-payslips/list'));
      const itemId = list.body.data[0].id;
      const res = await as(
        fx.employee.token,
        api().get(`/payrolls/my-payslips/${itemId}`),
      );
      expect(res.status).toBe(200);
      expect(res.body.data.employeeId ?? res.body.data.employee?.id).toBe(
        fx.monthlyEmpId,
      );
    });

    it('PS-API-04: an employee cannot open a colleague’s payslip item', async () => {
      const colleague = await ctx.prisma.payrollItem.findFirst({
        where: { employeeId: fx.secondMonthlyEmpId },
      });
      const res = await as(
        fx.employee.token,
        api().get(`/payrolls/my-payslips/${colleague!.id}`),
      );
      expect(res.status).toBe(404);
    });

    it('PS-API-05: a DRAFT payslip item is 404 through the self-service door', async () => {
      const draftRun = await ctx.prisma.payroll.findFirst({
        where: { month: draftPeriod.month, year: draftPeriod.year, branchId: fx.branchA },
        include: { items: { where: { employeeId: fx.monthlyEmpId } } },
      });
      const res = await as(
        fx.employee.token,
        api().get(`/payrolls/my-payslips/${draftRun!.items[0].id}`),
      );
      expect(res.status).toBe(404);
    });

    it('PS-API-06: the YTD summary is self-scoped and answers zero for an empty year', async () => {
      const res = await as(
        fx.employee.token,
        api().get(`/payrolls/my-ytd-summary?year=${lockedPeriod.year}`),
      );
      expect(res.status).toBe(200);

      const empty = await as(
        fx.employee.token,
        api().get('/payrolls/my-ytd-summary?year=1999'),
      );
      expect(empty.status).toBe(200);
      expect(JSON.stringify(empty.body.data)).not.toContain('null');
    });

    it('PS-API-07: every role reaches the self-service doors, anonymous does not', async () => {
      for (const token of [
        fx.admin.token,
        fx.hr.token,
        fx.deptManager.token,
        fx.employee.token,
      ]) {
        expect(
          (await as(token, api().get('/payrolls/my-payslips/list'))).status,
        ).toBe(200);
      }
      expect((await api().get('/payrolls/my-payslips/list')).status).toBe(401);
    });
  });

  // ── PS-API-08..16  The by-path door ──────────────────────────────────────
  describe('PS-API-08..16 — the payslip-by-path door', () => {
    it('PS-API-08: an employee reads their own payslip by path', async () => {
      const res = await as(
        fx.employee.token,
        api().get(payslipPath(fx.monthlyEmpId, lockedPeriod)),
      );
      expect(res.status).toBe(200);
      expect(res.body.data.payroll.status).toBe('LOCKED');
    });

    it('PS-API-09: an employee cannot read a colleague’s payslip by path', async () => {
      const res = await as(
        fx.employee.token,
        api().get(payslipPath(fx.secondMonthlyEmpId, lockedPeriod)),
      );
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('your own payslip');
    });

    it('PS-API-10: a manager reads a payslip inside their department', async () => {
      const res = await as(
        fx.deptManager.token,
        api().get(payslipPath(fx.monthlyEmpId, lockedPeriod)),
      );
      expect(res.status).toBe(200);
    });

    it('PS-API-11: a manager cannot read one outside their department', async () => {
      const res = await as(
        fx.deptManager.token,
        api().get(payslipPath(fx.foreignDeptEmpId, lockedPeriod)),
      );
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('outside your department');
    });

    it('PS-API-12: a manager cannot read a DRAFT payslip through this door', async () => {
      // The gap this closes: the by-path door took the employee from the URL and
      // applied no status filter, while `my-payslips/*` has always refused
      // anything but APPROVED|LOCKED. A manager therefore saw figures HR was
      // still working on — and the employee, looking at the same month in their
      // own portal, saw nothing at all.
      const res = await as(
        fx.deptManager.token,
        api().get(payslipPath(fx.monthlyEmpId, draftPeriod)),
      );
      expect(res.status).toBe(404);
    });

    it('PS-API-13: an employee cannot read their OWN draft payslip either', async () => {
      const res = await as(
        fx.employee.token,
        api().get(payslipPath(fx.monthlyEmpId, draftPeriod)),
      );
      expect(res.status).toBe(404);
    });

    it('PS-API-14: HR and ADMIN DO see the draft — the run is theirs to work on', async () => {
      for (const token of [fx.admin.token, fx.hr.token]) {
        const res = await as(token, api().get(payslipPath(fx.monthlyEmpId, draftPeriod)));
        expect(res.status).toBe(200);
        expect(res.body.data.payroll.status).toBe('DRAFT');
      }
    });

    it('PS-API-15: an unknown employee or a period with no run is 404', async () => {
      const ghost = await asAdmin(
        api().get(payslipPath('00000000-0000-0000-0000-000000000000', lockedPeriod)),
      );
      expect(ghost.status).toBe(404);

      const noRun = await asAdmin(
        api().get(payslipPath(fx.monthlyEmpId, fx.periodAt(99))),
      );
      expect(noRun.status).toBe(404);
    });

    it('PS-API-16: a malformed employee id is 400, not 500', async () => {
      const res = await asAdmin(
        api().get(`/payrolls/payslip/not-a-uuid/${lockedPeriod.month}/${lockedPeriod.year}`),
      );
      expect(res.status).toBe(400);
    });

    it('PS-API-17: an anonymous caller is 401', async () => {
      expect(
        (await api().get(payslipPath(fx.monthlyEmpId, lockedPeriod))).status,
      ).toBe(401);
    });
  });

  // ── PS-API-18..20  The two doors must agree ──────────────────────────────
  describe('PS-API-18..20 — the two doors agree', () => {
    it('PS-API-18: the same payslip reads the same net through both doors', async () => {
      const byPath = await as(
        fx.employee.token,
        api().get(payslipPath(fx.monthlyEmpId, lockedPeriod)),
      );
      const list = await as(fx.employee.token, api().get('/payrolls/my-payslips/list'));
      const slip = list.body.data.find(
        (s: any) =>
          s.payroll.month === lockedPeriod.month &&
          s.payroll.year === lockedPeriod.year,
      );
      expect(Number(byPath.body.data.netSalary ?? byPath.body.data.item?.netSalary)).toBeCloseTo(
        Number(slip.netSalary),
        2,
      );
    });

    it('PS-API-19: what one door hides, the other hides too', async () => {
      // The invariant the F3 fix installs: for a non-privileged caller, a period
      // visible through one door is visible through the other, and vice versa.
      const list = await as(fx.employee.token, api().get('/payrolls/my-payslips/list'));
      const visiblePeriods: string[] = list.body.data.map(
        (s: any) => `${s.payroll.month}/${s.payroll.year}`,
      );

      for (const period of [lockedPeriod, draftPeriod]) {
        const key = `${period.month}/${period.year}`;
        const byPath = await as(
          fx.employee.token,
          api().get(payslipPath(fx.monthlyEmpId, period)),
        );
        if (visiblePeriods.includes(key)) {
          expect(byPath.status).toBe(200);
        } else {
          expect(byPath.status).toBe(404);
        }
      }
    });

    it('PS-API-20: a scoped HR cannot read a payslip from another branch', async () => {
      const period = fx.periodAt(81);
      await seedAttendance(ctx.prisma, [fx.branchBEmpId], fx.branchB, period);
      const run = await asAdmin(api().post('/payrolls'), fx.branchB).send({
        month: period.month,
        year: period.year,
      });
      expect(run.status).toBe(201);

      const res = await api()
        .get(payslipPath(fx.branchBEmpId, period))
        .set(bearer(fx.scopedHr.token));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });
});
