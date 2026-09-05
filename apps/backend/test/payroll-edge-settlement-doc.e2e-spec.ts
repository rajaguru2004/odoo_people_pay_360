import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';
import { withSettings } from './utils/settings';

/**
 * `PE-EOSB-35..` — the final settlement DOCUMENT.
 *
 * Distinct from `payroll-edge-settlement.e2e-spec.ts`, which covers the
 * FINAL_SETTLEMENT payroll RUN. The run pays pending salary through payroll;
 * this document composes the whole exit package and records the working.
 *
 * The properties worth asserting are the ones that protect a leaver: one open
 * settlement per person, an override that cannot be silent, and a document that
 * can say the employee owes money rather than flooring at zero the way a
 * payslip must.
 */
describe('Payroll edge — final settlement document (PE-EOSB)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;

  const ON = {
    payroll_eosb_enabled: 'true',
    payroll_eosb_settlement_enabled: 'true',
    payroll_eosb_accrual_enabled: 'true',
    payroll_country: 'OM',
  };

  const setClass = (employeeId: string, nationalityClass: string | null) =>
    ctx.prisma.employeeProfile.upsert({
      where: { employeeId },
      create: { employeeId, nationalityClass: nationalityClass ?? undefined },
      update: { nationalityClass },
    });

  const prepare = (body: Record<string, unknown>) =>
    api()
      .post('/final-settlements')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({
        variant: 'RESIGNATION',
        lastWorkingDate: '2044-06-30',
        ...body,
      });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  afterEach(async () => {
    await ctx.prisma.finalSettlement.deleteMany({ where: { branchId: branch() } });
  });

  describe('PE-EOSB-35..38 — preparing', () => {
    it('PE-EOSB-35: composes earnings and deductions into a net', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, ON, async () => {
        const res = await prepare({
          employeeId: fx.fullMonthEmpId,
          pendingSalary: 1000,
        });
        expect(res.status).toBe(201);

        const d = res.body.data;
        expect(d.status).toBe('DRAFT');
        const codes = d.lines.map((l: any) => l.code);
        expect(codes).toContain('PENDING_SALARY');
        expect(codes).toContain('GRATUITY');
        expect(Number(d.netPayable)).toBeGreaterThan(0);
      });
    }, 90_000);

    it('PE-EOSB-36: stores the working, including the gratuity bands', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, ON, async () => {
        const res = await prepare({ employeeId: fx.fullMonthEmpId, pendingSalary: 500 });
        const working = res.body.data.workingJson;
        // "The system would calculate it differently now" is not an answer to a
        // settlement queried five years later.
        expect(working).toBeTruthy();
        expect(Array.isArray(working.lines)).toBe(true);
        expect(Array.isArray(working.gratuity)).toBe(true);
      });
    }, 90_000);

    it('PE-EOSB-37: refuses a SECOND open settlement for the same person', async () => {
      // Two HR users each preparing one, both approved, pays that person twice.
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, ON, async () => {
        expect((await prepare({ employeeId: fx.fullMonthEmpId })).status).toBe(201);
        const second = await prepare({ employeeId: fx.fullMonthEmpId });
        expect(second.status).toBe(409);
        expect(String(second.body?.message ?? '')).toMatch(/how somebody is paid twice/i);
      });
    }, 90_000);

    it('PE-EOSB-38: refuses an unknown exit variant, and lists the real ones', async () => {
      await withSettings(ctx, ON, async () => {
        const res = await prepare({
          employeeId: fx.fullMonthEmpId,
          variant: 'QUIT_IN_A_HUFF',
        });
        expect(res.status).toBe(400);
        expect(String(res.body?.message ?? '')).toMatch(/RESIGNATION.*TERMINATION/);
      });
    }, 60_000);
  });

  describe('PE-EOSB-39..42 — adjusting a line', () => {
    it('PE-EOSB-39: refuses an adjustment with no reason', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, ON, async () => {
        const created = await prepare({ employeeId: fx.fullMonthEmpId, pendingSalary: 1000 });
        const line = created.body.data.lines[0];

        const res = await api()
          .patch(`/final-settlements/${created.body.data.id}/lines/${line.id}`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ amount: 500 });
        expect(res.status).toBe(400);
        expect(String(res.body?.message ?? '')).toMatch(/reason is required/i);
      });
    }, 90_000);

    it('PE-EOSB-40: records the reason alongside the figure', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, ON, async () => {
        const created = await prepare({ employeeId: fx.fullMonthEmpId, pendingSalary: 1000 });
        const line = created.body.data.lines.find((l: any) => l.code === 'PENDING_SALARY');

        const res = await api()
          .patch(`/final-settlements/${created.body.data.id}/lines/${line.id}`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ amount: 750, reason: 'Three unpaid days in the final week.' });
        expect(res.status).toBe(200);

        const stored = await ctx.prisma.finalSettlementLine.findUnique({
          where: { id: line.id },
        });
        expect(Number(stored!.adjustedAmount)).toBe(750);
        expect(stored!.adjustmentReason).toMatch(/three unpaid days/i);
        expect(stored!.adjustedBy).not.toBeNull();
        // The computed figure survives beside the override, so the change is
        // legible rather than just the result of it.
        expect(Number(stored!.computedAmount)).toBe(1000);
      });
    }, 90_000);

    it('PE-EOSB-41: an adjustment of ZERO is a decision, not a no-op', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, ON, async () => {
        const created = await prepare({ employeeId: fx.fullMonthEmpId, pendingSalary: 1000 });
        const before = Number(created.body.data.netPayable);
        const line = created.body.data.lines.find((l: any) => l.code === 'PENDING_SALARY');

        const res = await api()
          .patch(`/final-settlements/${created.body.data.id}/lines/${line.id}`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ amount: 0, reason: 'Already paid in the June run.' });
        expect(res.status).toBe(200);
        // Reading 0 as "no adjustment" would quietly pay the original figure.
        expect(Number(res.body.data.netPayable)).toBe(before - 1000);
      });
    }, 90_000);

    it('PE-EOSB-42: totals never disagree with the lines beneath them', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, ON, async () => {
        const created = await prepare({ employeeId: fx.fullMonthEmpId, pendingSalary: 1000 });
        const id = created.body.data.id;
        const line = created.body.data.lines.find((l: any) => l.code === 'GRATUITY');

        await api()
          .patch(`/final-settlements/${id}/lines/${line.id}`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ amount: 111.11, reason: 'Agreed at exit interview.' });

        const after = await api()
          .get(`/final-settlements/${id}`)
          .set(admin())
          .set('X-Branch-Id', branch());
        const d = after.body.data;
        const earnings = d.lines
          .filter((l: any) => l.category === 'EARNING')
          .reduce(
            (a: number, l: any) =>
              a + Number(l.adjustedAmount ?? l.computedAmount),
            0,
          );
        expect(Number(d.totalEarnings)).toBeCloseTo(earnings, 2);
      });
    }, 90_000);
  });

  describe('PE-EOSB-43..46 — the lifecycle, and what it does to the provision', () => {
    it('PE-EOSB-43: approving marks the provisions SETTLED', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, ON, async () => {
        await ctx.prisma.gratuityAccrual.create({
          data: {
            employeeId: fx.fullMonthEmpId,
            branchId: branch(),
            payrollId: fx.fullMonthEmpId, // stand-in id; no FK to payroll by design
            month: 1,
            year: 2044,
            basisAmount: 900,
            serviceYears: 4,
            daysAccrued: 120,
            amount: 300,
            employerShare: 1,
            workingJson: { seeded: true },
            status: 'ACCRUED',
          },
        });

        const created = await prepare({ employeeId: fx.fullMonthEmpId });
        const res = await api()
          .post(`/final-settlements/${created.body.data.id}/approve`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({});
        expect(res.status).toBe(201);

        const accruals = await ctx.prisma.gratuityAccrual.findMany({
          where: { employeeId: fx.fullMonthEmpId },
        });
        expect(accruals.every((a) => a.status === 'SETTLED')).toBe(true);

        await ctx.prisma.gratuityAccrual.deleteMany({
          where: { employeeId: fx.fullMonthEmpId },
        });
      });
    }, 90_000);

    it('PE-EOSB-44: cancelling RELEASES them again', async () => {
      // Otherwise the payroll they came from stays permanently un-unlockable,
      // for a settlement that no longer exists.
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, ON, async () => {
        await ctx.prisma.gratuityAccrual.create({
          data: {
            employeeId: fx.fullMonthEmpId,
            branchId: branch(),
            payrollId: fx.fullMonthEmpId,
            month: 2,
            year: 2044,
            basisAmount: 900,
            serviceYears: 4,
            daysAccrued: 120,
            amount: 300,
            employerShare: 1,
            workingJson: { seeded: true },
            status: 'ACCRUED',
          },
        });
        const created = await prepare({ employeeId: fx.fullMonthEmpId });
        const id = created.body.data.id;
        await api().post(`/final-settlements/${id}/approve`).set(admin()).set('X-Branch-Id', branch()).send({});

        const res = await api()
          .post(`/final-settlements/${id}/cancel`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ reason: 'Employee withdrew their resignation.' });
        expect(res.status).toBe(201);

        const accruals = await ctx.prisma.gratuityAccrual.findMany({
          where: { employeeId: fx.fullMonthEmpId },
        });
        expect(accruals.every((a) => a.status === 'ACCRUED')).toBe(true);
        expect(accruals.every((a) => a.settlementId === null)).toBe(true);

        await ctx.prisma.gratuityAccrual.deleteMany({
          where: { employeeId: fx.fullMonthEmpId },
        });
      });
    }, 90_000);

    it('PE-EOSB-45: a paid settlement cannot be cancelled', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, ON, async () => {
        const created = await prepare({ employeeId: fx.fullMonthEmpId, pendingSalary: 100 });
        const id = created.body.data.id;
        await api().post(`/final-settlements/${id}/approve`).set(admin()).set('X-Branch-Id', branch()).send({});
        await api().post(`/final-settlements/${id}/pay`).set(admin()).set('X-Branch-Id', branch()).send({});

        const res = await api()
          .post(`/final-settlements/${id}/cancel`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ reason: 'Mistake' });
        expect(res.status).toBe(409);
        expect(String(res.body?.message ?? '')).toMatch(/raise a correction instead/i);
      });
    }, 90_000);

    it('PE-EOSB-46: with the flag OFF the routes are unavailable', async () => {
      const res = await prepare({ employeeId: fx.fullMonthEmpId });
      expect(res.status).toBe(404);
      // A missing route also answers 404, so assert it is the FEATURE refusing
      // rather than the router. Without this the case passes just as happily
      // when the module was never registered at all — which is exactly how it
      // passed while every other case in this file was failing.
      expect(String(res.body?.message ?? '')).toMatch(/not enabled/i);
    }, 60_000);
  });
});
