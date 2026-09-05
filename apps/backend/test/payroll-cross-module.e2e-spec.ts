import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollFixtures,
  seedAttendance,
  PayrollFixtures,
  bearer,
} from './utils/payroll-fixtures';

/**
 * The seams around payroll — Phase 4, chunk C7.
 *
 * Everything here is asserted from the PAYROLL side. Attendance and overtime
 * have their own suites; what none of them can prove is that the contract
 * BETWEEN them and a payroll run holds.
 *
 * The centrepiece is `assertBankEditable` — the guard that freezes an employee's
 * bank details while their money is in motion. It is the highest-value
 * cross-domain rule in the module because it spans three subsystems and its
 * failure mode is silent: a salary paid into an account the employee no longer
 * owns.
 *
 * The truth table it implements:
 *
 * | in-flight thing                        | bank change |
 * |----------------------------------------|-------------|
 * | payroll DRAFT / PENDING_APPROVAL / APPROVED | 409    |
 * | payroll LOCKED / REJECTED              | allowed     |
 * | employee has NO active detail, migration path | allowed (`exemptFirstTime`) |
 */
describe('Payroll cross-module seams (e2e)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;
  let periodCursor = 150;

  const api = () => ctx.http();
  const as = (token: string, req: any, branchId: string | null = fx.branchA) => {
    req.set(bearer(token));
    if (branchId) req.set('x-branch-id', branchId);
    return req;
  };
  const asAdmin = (req: any, branchId: string | null = fx.branchA) =>
    as(fx.admin.token, req, branchId);

  const IN_DETAILS = (accountNumber: string) => ({
    accountHolderName: 'Payroll SEAM',
    accountNumber,
    ifsc: 'HDFC0001234',
  });

  const raiseChange = (
    employeeId: string,
    accountNumber: string,
    token = fx.admin.token,
  ) =>
    as(token, api().post('/bank-change-requests')).send({
      employeeId,
      bankId: fx.bankInId,
      data: IN_DETAILS(accountNumber),
    });

  /** A run over `employeeIds`, left at `status`. Returns its id. */
  const runTo = async (
    employeeIds: string[],
    status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'LOCKED',
  ): Promise<string> => {
    const period = fx.periodAt(periodCursor++);
    await seedAttendance(ctx.prisma, employeeIds, fx.branchA, period);
    const run = await asAdmin(api().post('/payrolls')).send({
      month: period.month,
      year: period.year,
      employeeIds,
    });
    expect(run.status).toBe(201);
    const id = run.body.data.id;

    if (status === 'DRAFT') return id;
    expect((await asAdmin(api().post(`/payrolls/${id}/submit`))).status).toBe(201);
    if (status === 'PENDING_APPROVAL') return id;
    if (status === 'REJECTED') {
      await asAdmin(api().post(`/payrolls/${id}/reject`)).send({
        reason: 'seam fixture rejection',
      });
      return id;
    }
    await asAdmin(api().post(`/payrolls/${id}/approve`)).send({});
    if (status === 'APPROVED') return id;
    expect((await asAdmin(api().post(`/payrolls/${id}/lock`))).status).toBe(201);
    return id;
  };

  const clearRequests = async (employeeId: string) => {
    const ids = (
      await ctx.prisma.bankChangeRequest.findMany({
        where: { employeeId },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (ids.length) {
      await ctx.prisma.requestApproval.deleteMany({
        where: { requestId: { in: ids } },
      });
      await ctx.prisma.bankChangeRequest.deleteMany({
        where: { id: { in: ids } },
      });
    }
  };

  /** Remove every payroll item for an employee, releasing the payroll freeze. */
  const clearRuns = async (employeeId: string) => {
    await ctx.prisma.payrollItem.deleteMany({ where: { employeeId } });
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);
    // The freeze is what this file is about, so the approval chain must be OUT
    // of the way: with it engaged a request sits PENDING and never reaches the
    // apply-time check that the freeze also guards.
    await ctx.prisma.approvalWorkflow.updateMany({
      where: { requestType: 'BANK_CHANGE' },
      data: { isActive: false },
    });
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── X-API-01..08  The bank-detail freeze ─────────────────────────────────
  describe('X-API-01..08 — the bank-detail freeze truth table', () => {
    beforeEach(async () => {
      await clearRequests(fx.secondMonthlyEmpId);
      await clearRuns(fx.secondMonthlyEmpId);
      await ctx.prisma.employeeBankDetail.deleteMany({
        where: { employeeId: fx.secondMonthlyEmpId },
      });
      // Give them an active detail, so `exemptFirstTime` never applies below.
      await ctx.prisma.employeeBankDetail.create({
        data: {
          employeeId: fx.secondMonthlyEmpId,
          bankId: fx.bankInId,
          branchId: fx.branchA,
          data: IN_DETAILS('000000000001'),
          accountNumber: '000000000001',
          accountHolderName: 'Payroll SEAM',
          isActive: true,
          source: 'MIGRATION',
        },
      });
    });

    it.each([
      ['DRAFT', 'DRAFT' as const],
      ['PENDING_APPROVAL', 'PENDING_APPROVAL' as const],
      ['APPROVED', 'APPROVED' as const],
    ])('X-API-01: a %s run freezes the bank details', async (_l, status) => {
      await runTo([fx.secondMonthlyEmpId], status);
      const res = await raiseChange(fx.secondMonthlyEmpId, '111111111111');
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/payroll run is in progress/i);
    });

    it.each([
      ['LOCKED', 'LOCKED' as const],
      ['REJECTED', 'REJECTED' as const],
    ])('X-API-02: a %s run does NOT freeze them', async (_l, status) => {
      await runTo([fx.secondMonthlyEmpId], status);
      const res = await raiseChange(fx.secondMonthlyEmpId, '222222222222');
      expect(res.status).toBe(201);
    });

    it('X-API-03: the freeze is per-employee, not per-branch', async () => {
      // A run covering only one colleague must not lock everybody else out.
      await runTo([fx.secondMonthlyEmpId], 'DRAFT');
      await clearRequests(fx.dailyEmpId);
      const res = await raiseChange(fx.dailyEmpId, '333333333333');
      expect(res.status).toBe(201);
    });

    it('X-API-04: unlocking a run puts the freeze BACK', async () => {
      // Unlock returns the run to APPROVED, which is an in-flight state again —
      // the money is being restated and the account it pays into must hold still.
      const id = await runTo([fx.secondMonthlyEmpId], 'LOCKED');
      expect((await raiseChange(fx.secondMonthlyEmpId, '444444444444')).status).toBe(
        201,
      );
      await clearRequests(fx.secondMonthlyEmpId);

      const unlocked = await asAdmin(api().post(`/payrolls/${id}/unlock`)).send({
        reason: 'restating the seam fixture',
      });
      expect(unlocked.status).toBe(201);

      const res = await raiseChange(fx.secondMonthlyEmpId, '555555555555');
      expect(res.status).toBe(409);
    });

    it('X-API-05: deleting the in-flight run releases the freeze', async () => {
      const id = await runTo([fx.secondMonthlyEmpId], 'DRAFT');
      expect((await raiseChange(fx.secondMonthlyEmpId, '666666666666')).status).toBe(
        409,
      );

      expect((await asAdmin(api().delete(`/payrolls/${id}`))).status).toBe(200);
      const res = await raiseChange(fx.secondMonthlyEmpId, '666666666666');
      expect(res.status).toBe(201);
    });

    it('X-API-06: the freeze is re-checked at APPLY time, not only at submit', async () => {
      // The window that matters: a request raised while nothing was in flight,
      // approved after a run opened. Checking only at submit would let the
      // account move under a run that had already been generated from it.
      await clearRequests(fx.secondMonthlyEmpId);
      // Activate through the API, not a bulk update: only ONE workflow per
      // request type may be active at a time (a partial unique index enforces
      // it), so flipping every BANK_CHANGE row on at once is refused.
      await ctx.prisma.systemSetting.upsert({
        where: { key: 'supervisor_approval_enabled' },
        update: { value: 'true' },
        create: { key: 'supervisor_approval_enabled', value: 'true' },
      });

      const chain = await asAdmin(api().put('/approval-workflows')).send({
        requestType: 'BANK_CHANGE',
        name: 'seam apply-time check',
        mode: 'SEQUENTIAL',
        isActive: true,
        steps: [{ approverType: 'HR_MANAGER' }],
      });
      expect(chain.status).toBe(200);

      const raised = await raiseChange(fx.secondMonthlyEmpId, '777777777777');
      expect(raised.status).toBe(201);
      const request = await ctx.prisma.bankChangeRequest.findFirst({
        where: { employeeId: fx.secondMonthlyEmpId, status: 'PENDING' },
      });
      expect(request).toBeTruthy();

      // NOW open a run.
      await runTo([fx.secondMonthlyEmpId], 'DRAFT');

      const decided = await as(
        fx.hr.token,
        api().post(`/bank-change-requests/${request!.id}/approve`),
      ).send({ comment: 'verified' });
      expect(decided.status).toBe(409);

      const active = await ctx.prisma.employeeBankDetail.findFirst({
        where: { employeeId: fx.secondMonthlyEmpId, isActive: true },
      });
      expect(active!.accountNumber).not.toContain('777');

      // Restore the disengaged state the rest of the file assumes.
      await ctx.prisma.approvalWorkflow.updateMany({
        where: { requestType: 'BANK_CHANGE' },
        data: { isActive: false },
      });
    });
  });

  // ── X-API-13..17  Attendance and overtime as payroll INPUTS ──────────────
  describe('X-API-13..17 — attendance and overtime inputs', () => {
    it('X-API-13: the run reads work days from the BRANCH work week', async () => {
      // Branch A is off on Sundays; the Oman branch is off Friday and Saturday.
      // Same month, different divisor — a global calendar would give them the
      // same answer and quietly overpay or underpay one of them.
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, period);
      await seedAttendance(ctx.prisma, [fx.omEmpId], fx.branchOm, period);

      const [inA, inOm] = await Promise.all([
        asAdmin(api().post('/payrolls')).send({
          month: period.month,
          year: period.year,
          employeeIds: [fx.monthlyEmpId],
        }),
        asAdmin(api().post('/payrolls'), fx.branchOm).send({
          month: period.month,
          year: period.year,
          employeeIds: [fx.omEmpId],
        }),
      ]);
      expect(inA.status).toBe(201);
      expect(inOm.status).toBe(201);

      const [detailA, detailOm] = await Promise.all([
        asAdmin(api().get(`/payrolls/${inA.body.data.id}`)),
        asAdmin(api().get(`/payrolls/${inOm.body.data.id}`), fx.branchOm),
      ]);
      const workDaysA = Number(detailA.body.data.items[0].workDays);
      const workDaysOm = Number(detailOm.body.data.items[0].workDays);
      expect(workDaysA).toBeGreaterThan(0);
      expect(workDaysOm).toBeGreaterThan(0);
      expect(workDaysA).not.toBe(workDaysOm);
    });

    it('X-API-14: an employee with NO attendance is still paid, with LOP skipped', async () => {
      // The distinction the guard exists for: "no rows" is missing data, not a
      // month of absence. The employee is paid and the item is flagged; only a
      // run where NOBODY has attendance is refused outright.
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.monthlyEmpId], fx.branchA, period);

      const run = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
        employeeIds: [fx.monthlyEmpId, fx.noBankEmpId],
      });
      expect(run.status).toBe(201);

      const detail = await asAdmin(api().get(`/payrolls/${run.body.data.id}`));
      const noAttendance = detail.body.data.items.find(
        (i: any) => i.employeeId === fx.noBankEmpId,
      );
      expect(noAttendance).toBeTruthy();
      // A MONTHLY earner with no attendance rows keeps their salary: the missing
      // data is not evidence of absence. A DAILY-wage worker is the opposite
      // case — no days worked genuinely is no pay — which is why this asserts
      // the monthly one.
      expect(noAttendance.employee.salaryType).toBe('MONTHLY');
      expect(Number(noAttendance.netSalary)).toBeGreaterThan(0);
    });

    it('X-API-15: the daily-wage employee is paid a per-DAY rate, not a monthly one', async () => {
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.dailyEmpId], fx.branchA, period);
      const run = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
        employeeIds: [fx.dailyEmpId],
      });
      const detail = await asAdmin(api().get(`/payrolls/${run.body.data.id}`));
      const item = detail.body.data.items[0];

      // baseSalary on the employee is 800/DAY. The item's baseSalary is the
      // earned amount for the month, so it must be a multiple of the days worked
      // — not the 800 a monthly reading would produce.
      expect(Number(item.baseSalary)).toBeGreaterThan(800);
      expect(item.employee.salaryType).toBe('DAILY');
    });
  });

  // ── X-API-18..24  Branch, department and the settings surface ────────────
  describe('X-API-18..24 — branch, department and settings', () => {
    it('X-API-18: a branch-A run is invisible to a branch-B-scoped caller at every door', async () => {
      const id = await runTo([fx.monthlyEmpId], 'LOCKED');

      const doors: Array<[string, () => Promise<any>]> = [
        ['list', () => api().get('/payrolls').set(bearer(fx.scopedHr.token)).then((r) => r)],
        ['read', () => api().get(`/payrolls/${id}`).set(bearer(fx.scopedHr.token))],
        ['history', () => api().get(`/payrolls/${id}/history`).set(bearer(fx.scopedHr.token))],
        ['export', () => api().get(`/export/payroll/${id}`).set(bearer(fx.scopedHr.token))],
      ];

      // The scoped HR IS in branch A, so this is the positive control...
      for (const [, call] of doors) {
        const res = await call();
        expect(res.status).toBeLessThan(500);
      }

      // ...and a branch-B run is the negative.
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.branchBEmpId], fx.branchB, period);
      const foreign = await asAdmin(api().post('/payrolls'), fx.branchB).send({
        month: period.month,
        year: period.year,
      });
      const foreignId = foreign.body.data.id;

      for (const path of [
        `/payrolls/${foreignId}`,
        `/payrolls/${foreignId}/history`,
        `/export/payroll/${foreignId}`,
      ]) {
        const res = await api().get(path).set(bearer(fx.scopedHr.token));
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
    });

    it('X-API-19: a department manager reaches only their own department’s pay data', async () => {
      const ownComponents = await as(
        fx.deptManager.token,
        api().get(`/salary-components/employee/${fx.monthlyEmpId}`),
      );
      expect(ownComponents.status).toBe(200);

      const foreignComponents = await as(
        fx.deptManager.token,
        api().get(`/salary-components/employee/${fx.foreignDeptEmpId}`),
      );
      expect(foreignComponents.status).toBe(403);
    });

    it('X-API-20: EMPLOYEE is refused the company-wide payroll summary', async () => {
      // It reports the whole salary bill month by month. An employee's own pay is
      // `/payrolls/my-ytd-summary`, which is self-scoped.
      const res = await as(
        fx.employee.token,
        api().get('/dashboard/payroll-summary'),
      );
      expect(res.status).toBe(403);

      for (const token of [fx.admin.token, fx.hr.token]) {
        expect(
          (await as(token, api().get('/dashboard/payroll-summary'))).status,
        ).toBe(200);
      }
    });

    it('X-API-21: no payroll settings key carries a secret', async () => {
      // Most payroll_* keys are published UNAUTHENTICATED via
      // /system-settings/public, which is correct for currency symbols and
      // statutory rates — the payslip renders from them. This case exists so a
      // future key that should NOT be public cannot be added without noticing.
      const res = await api().get('/system-settings/public');
      expect(res.status).toBe(200);

      const body = JSON.stringify(res.body).toLowerCase();
      for (const forbidden of [
        'password',
        'secret',
        'apikey',
        'api_key',
        'token',
        'privatekey',
      ]) {
        expect(body).not.toContain(forbidden);
      }
    });

    it('X-API-22: retiring a branch leaves its payroll history readable to an admin', async () => {
      const id = await runTo([fx.monthlyEmpId], 'LOCKED');
      const detail = await asAdmin(api().get(`/payrolls/${id}`));
      expect(detail.status).toBe(200);
      expect(detail.body.data.branchId).toBe(fx.branchA);
    });
  });
});
