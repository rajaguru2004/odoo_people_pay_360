import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';
import { withSettings } from './utils/settings';

/**
 * `PE-REC-50..` — employer recoveries through payroll.
 *
 * `docs/PAYROLL-GAP-REPORT.md` §5 reserved these ids for asset damage and loss
 * recovery, noting that `clearance.service.ts` gates an exit but moves no money.
 * The ledger built here is generic — asset damage, an unreturned asset, a
 * training bond and a notice shortfall are mechanically the same thing — so it
 * closes §5 and four other cases the report never had ids for.
 */
describe('Payroll edge — employer recoveries (PE-REC)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;

  const ON = { payroll_employee_recovery_enabled: 'true' };

  const raise = (body: Record<string, unknown>) =>
    api()
      .post('/employee-recoveries')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({
        employeeId: fx.fullMonthEmpId,
        kind: 'ASSET_DAMAGE',
        totalAmount: 600,
        instalmentAmount: 200,
        reference: 'AST-001',
        startDate: '2030-01-01',
        ...body,
      });

  /**
   * Seed a FULL month of attendance, not one token day.
   *
   * One day of attendance is not "the period is open" — it is 21 days of loss of
   * pay, which leaves almost nothing for a recovery to take. These cases are
   * about how much a recovery collects, so the employee has to actually earn a
   * month first.
   */
  const openPeriod = async (employeeId: string, period: { month: number; year: number }) => {
    const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
    const rows: any[] = [];
    for (let day = 1; day <= lastDay; day++) {
      const date = new Date(Date.UTC(period.year, period.month - 1, day));
      const dow = date.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      rows.push({
        employeeId,
        branchId: branch(),
        date,
        status: 'PRESENT',
        workHours: 8,
      });
    }
    await ctx.prisma.attendance.createMany({ data: rows, skipDuplicates: true });
  };

  const runPayroll = async (period: { month: number; year: number }, ids: string[]) => {
    const created = await api()
      .post('/payrolls')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ month: period.month, year: period.year, employeeIds: ids });
    const id = created.body?.data?.id;
    const full = await api().get(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
    return { id, items: (full.body?.data?.items ?? []) as any[] };
  };

  const drop = (id: string) =>
    api().delete(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  afterEach(async () => {
    await ctx.prisma.payrollCarryForward.deleteMany({
      where: { branchId: branch(), kind: 'RECOVERY' },
    });
    await ctx.prisma.employeeRecovery.deleteMany({ where: { branchId: branch() } });
  });

  describe('PE-REC-50..53 — raising one', () => {
    it('PE-REC-50: records a recovery against an employee', async () => {
      const res = await raise({});
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(Number(res.body.data.amountRecovered)).toBe(0);
    }, 60_000);

    it('PE-REC-51: refuses a zero or negative total', async () => {
      expect((await raise({ totalAmount: 0 })).status).toBe(400);
      expect((await raise({ totalAmount: -100 })).status).toBe(400);
    }, 60_000);

    it('PE-REC-52: refuses an unknown kind, and lists the real ones', async () => {
      const res = await raise({ kind: 'BECAUSE_I_SAID_SO' });
      expect(res.status).toBe(400);
      expect(String(res.body?.message ?? '')).toMatch(/ASSET_DAMAGE.*TRAINING_BOND/);
    }, 60_000);

    it('PE-REC-53: refuses an asset link on a non-asset kind', async () => {
      // A training bond pointing at a laptop would double-count that asset's
      // cost in the asset report.
      const res = await raise({
        kind: 'TRAINING_BOND',
        assetAssignmentId: '00000000-0000-4000-8000-000000000000',
      });
      expect(res.status).toBe(400);
      expect(String(res.body?.message ?? '')).toMatch(/double-count/i);
    }, 60_000);
  });

  describe('PE-REC-54..58 — reaching the payslip', () => {
    it('PE-REC-54: with the flag OFF, nothing is recovered', async () => {
      await raise({});
      const period = fx.periodAt(90);
      await openPeriod(fx.fullMonthEmpId, period);
      const r = await runPayroll(period, [fx.fullMonthEmpId]);
      const item = r.items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
      expect(Number(item.otherRecovery)).toBe(0);
      await drop(r.id);
    }, 90_000);

    it('PE-REC-55: takes the instalment and advances the balance', async () => {
      await withSettings(ctx, ON, async () => {
        const created = await raise({});
        const period = fx.periodAt(91);
        await openPeriod(fx.fullMonthEmpId, period);
        const r = await runPayroll(period, [fx.fullMonthEmpId]);
        const item = r.items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
        expect(Number(item.otherRecovery)).toBe(200);

        const row = await ctx.prisma.employeeRecovery.findUnique({
          where: { id: created.body.data.id },
        });
        expect(Number(row!.amountRecovered)).toBe(200);
        await drop(r.id);
      });
    }, 120_000);

    it('PE-REC-56: names the recovery on the payslip', async () => {
      await withSettings(ctx, ON, async () => {
        await raise({});
        const period = fx.periodAt(92);
        await openPeriod(fx.fullMonthEmpId, period);
        const r = await runPayroll(period, [fx.fullMonthEmpId]);
        const item = r.items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
        // An unexplained deduction is the thing employees escalate.
        expect(String(item.notes ?? '')).toMatch(/Asset damage recovery AST-001: 200 recovered/);
        await drop(r.id);
      });
    }, 120_000);

    it('PE-REC-57: never collects past the debt', async () => {
      await withSettings(ctx, ON, async () => {
        const created = await raise({ totalAmount: 250, instalmentAmount: 200 });
        await ctx.prisma.employeeRecovery.update({
          where: { id: created.body.data.id },
          data: { amountRecovered: 150 },
        });

        const period = fx.periodAt(93);
        await openPeriod(fx.fullMonthEmpId, period);
        const r = await runPayroll(period, [fx.fullMonthEmpId]);
        const item = r.items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
        // 100 outstanding, not the 200 instalment.
        expect(Number(item.otherRecovery)).toBe(100);

        const row = await ctx.prisma.employeeRecovery.findUnique({
          where: { id: created.body.data.id },
        });
        expect(row!.status).toBe('COMPLETED');
        await drop(r.id);
      });
    }, 120_000);

    it('PE-REC-58: unlocking gives the money back', async () => {
      await withSettings(ctx, ON, async () => {
        const created = await raise({});
        const period = fx.periodAt(94);
        await openPeriod(fx.fullMonthEmpId, period);
        const r = await runPayroll(period, [fx.fullMonthEmpId]);

        await api().post(`/payrolls/${r.id}/submit`).set(admin()).set('X-Branch-Id', branch()).send({});
        await api().post(`/payrolls/${r.id}/approve`).set(admin()).set('X-Branch-Id', branch()).send({});
        await api().post(`/payrolls/${r.id}/lock`).set(admin()).set('X-Branch-Id', branch()).send({});
        await api()
          .post(`/payrolls/${r.id}/unlock`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ reason: 'reversing for a test' });

        const row = await ctx.prisma.employeeRecovery.findUnique({
          where: { id: created.body.data.id },
        });
        // A reversed run must not leave a recovery believing it collected money
        // no payslip carries.
        expect(Number(row!.amountRecovered)).toBe(0);
        await drop(r.id);
      });
    }, 150_000);
  });

  describe('PE-REC-59..60 — forgiving and leaving', () => {
    it('PE-REC-59: waiving demands a reason', async () => {
      const created = await raise({});
      const noReason = await api()
        .patch(`/employee-recoveries/${created.body.data.id}/waive`)
        .set(admin())
        .set('X-Branch-Id', branch())
        .send({});
      expect(noReason.status).toBe(400);

      const withReason = await api()
        .patch(`/employee-recoveries/${created.body.data.id}/waive`)
        .set(admin())
        .set('X-Branch-Id', branch())
        .send({ reason: 'Damage was pre-existing.' });
      expect(withReason.status).toBe(200);
      expect(withReason.body.data.status).toBe('WAIVED');
    }, 60_000);

    it('PE-REC-60: cancelling is a flag flip, never a delete', async () => {
      // Runs already generated under it reference it; deleting would leave those
      // payslips with a deduction nothing explains.
      const created = await raise({});
      const id = created.body.data.id;
      const res = await api()
        .delete(`/employee-recoveries/${id}`)
        .set(admin())
        .set('X-Branch-Id', branch());
      expect(res.status).toBe(200);

      const row = await ctx.prisma.employeeRecovery.findUnique({ where: { id } });
      expect(row).not.toBeNull();
      expect(row!.status).toBe('CANCELLED');
    }, 60_000);
  });
});
