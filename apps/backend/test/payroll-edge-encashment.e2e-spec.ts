import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';
import { withSettings } from './utils/settings';

/**
 * `PE-IN-40..` — leave encashment, and the year-end carry-forward.
 *
 * `RECOVER_FROM_LEAVE_ENCASHMENT` has been a loan-settlement action since the
 * loans work landed, recovering against a figure nothing produced;
 * `leave_type_balances.carried_over` has been a real column no endpoint wrote.
 * These cases are what makes both of those true statements false.
 *
 * `PE-IN-46` is deliberately NOT claimed here: it belongs to the leave-cancel
 * case that is still blocked by NO_LOGIN, and taking the id would hide that.
 */
describe('Payroll edge — leave encashment (PE-IN)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;

  const ON = {
    leave_encashment_enabled: 'true',
    leave_carry_forward_enabled: 'true',
  };

  const TYPE = 'Annual Leave';
  const YEAR = 2044;

  const setPolicy = (body: Record<string, unknown>) =>
    api()
      .post('/leave-encashment/policies')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ leaveTypeKey: TYPE, ...body });

  const setBalance = (
    employeeId: string,
    year: number,
    allocated: number,
    used: number,
    carriedOver = 0,
  ) =>
    ctx.prisma.leaveTypeBalance.upsert({
      where: {
        employeeId_year_leaveTypeKey: { employeeId, year, leaveTypeKey: TYPE },
      },
      create: { employeeId, year, leaveTypeKey: TYPE, allocated, used, carriedOver },
      update: { allocated, used, carriedOver, carryForwardRunId: null },
    });

  const request = (employeeId: string, days: number, year = YEAR) =>
    api()
      .post('/leave-encashment/requests')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ employeeId, leaveTypeKey: TYPE, year, days });

  const approve = (id: string) =>
    api()
      .post(`/leave-encashment/requests/${id}/approve`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({});

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  afterEach(async () => {
    await ctx.prisma.leaveEncashmentRequest.deleteMany({
      where: { branchId: branch() },
    });
  });

  // ── Policy ───────────────────────────────────────────────────────────────

  describe('PE-IN-40..41 — the policy decides what may be encashed', () => {
    it('PE-IN-40: a leave type is not encashable until somebody says so', async () => {
      await withSettings(ctx, ON, async () => {
        await setPolicy({ encashable: false });
        const res = await request(fx.fullMonthEmpId, 5);
        expect(res.status).toBe(400);
        expect(String(res.body?.message ?? '')).toMatch(/cannot be encashed/i);
      });
    }, 60_000);

    it('PE-IN-41: a branch policy overrides the company-wide one', async () => {
      await withSettings(ctx, ON, async () => {
        await setPolicy({ encashable: true, maxEncashDaysPerYear: 5 });
        await setPolicy({
          encashable: true,
          maxEncashDaysPerYear: 12,
          branchId: branch(),
        });
        await setBalance(fx.fullMonthEmpId, YEAR, 30, 0);

        // 8 exceeds the company-wide cap of 5 but sits inside the branch cap.
        const res = await request(fx.fullMonthEmpId, 8);
        expect(res.status).toBe(201);

        await ctx.prisma.leaveTypePolicy.deleteMany({
          where: { leaveTypeKey: TYPE, branchId: branch() },
        });
      });
    }, 60_000);
  });

  // ── Requests ─────────────────────────────────────────────────────────────

  describe('PE-IN-42..45 — requesting, and the bounds', () => {
    beforeEach(async () => {
      await setPolicy({
        encashable: true,
        maxEncashDaysPerYear: 10,
        encashBasis: 'BASIC',
        monthDays: 30,
      });
    });

    it('PE-IN-42: refuses more days than the balance holds, and says how many', async () => {
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.fullMonthEmpId, YEAR, 10, 8);
        const res = await request(fx.fullMonthEmpId, 5);
        expect(res.status).toBe(400);
        expect(String(res.body?.message ?? '')).toMatch(/Only 2 day\(s\)/);
      });
    }, 60_000);

    it('PE-IN-43: refuses a second live request for the same type and year', async () => {
      // Two requests against one balance is how an employee is paid twice for
      // the same days.
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.fullMonthEmpId, YEAR, 30, 0);
        const first = await request(fx.fullMonthEmpId, 3);
        expect(first.status).toBe(201);

        const second = await request(fx.fullMonthEmpId, 2);
        expect(second.status).toBe(409);
        expect(String(second.body?.message ?? '')).toMatch(/paid for the same days twice/i);
      });
    }, 60_000);

    it('PE-IN-44: approval snapshots the rate', async () => {
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.fullMonthEmpId, YEAR, 30, 0);
        const created = await request(fx.fullMonthEmpId, 3);
        const approved = await approve(created.body.data.id);
        expect(approved.status).toBe(201);

        const row = approved.body.data;
        // A figure nobody can defend once the salary changes is a figure that
        // loses an argument.
        expect(Number(row.ratePerDay)).toBeGreaterThan(0);
        expect(Number(row.amount)).toBeCloseTo(Number(row.ratePerDay) * 3, 2);
      });
    }, 60_000);

    it('PE-IN-45: HR can file on an employee’s behalf', async () => {
      // The thing the reimbursement DTO cannot do, and the reason encashment
      // carries an explicit employeeId: HR files for a leaver every day.
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.leaverEmpId, YEAR, 20, 0);
        const res = await request(fx.leaverEmpId, 4);
        expect(res.status).toBe(201);
        expect(res.body.data.employeeId).toBe(fx.leaverEmpId);
      });
    }, 60_000);
  });

  // ── The payslip ──────────────────────────────────────────────────────────

  describe('PE-IN-47..49 — encashment reaches the payslip once', () => {
    beforeEach(async () => {
      await setPolicy({ encashable: true, maxEncashDaysPerYear: 10, monthDays: 30 });
    });

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

    it('PE-IN-47: an approved request is paid by the next run', async () => {
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.fullMonthEmpId, YEAR, 30, 0);
        const created = await request(fx.fullMonthEmpId, 3);
        const approved = await approve(created.body.data.id);
        const amount = Number(approved.body.data.amount);

        const period = fx.periodAt(70);
        await openPeriod(fx.fullMonthEmpId, period);
        const r = await runPayroll(period, [fx.fullMonthEmpId]);
        const item = r.items.find((i) => i.employeeId === fx.fullMonthEmpId)!;

        expect(Number(item.leaveEncashment)).toBeCloseTo(amount, 2);

        await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 120_000);

    it('PE-IN-48: a second run does not pay the same request again', async () => {
      // `payrollItemId: null` is the double-inclusion guard, exactly as it is
      // for reimbursements.
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.fullMonthEmpId, YEAR, 30, 0);
        const created = await request(fx.fullMonthEmpId, 3);
        await approve(created.body.data.id);

        const first = fx.periodAt(71);
        await openPeriod(fx.fullMonthEmpId, first);
        const r1 = await runPayroll(first, [fx.fullMonthEmpId]);
        expect(
          Number(r1.items.find((i) => i.employeeId === fx.fullMonthEmpId)!.leaveEncashment),
        ).toBeGreaterThan(0);

        const second = fx.periodAt(72);
        await openPeriod(fx.fullMonthEmpId, second);
        const r2 = await runPayroll(second, [fx.fullMonthEmpId]);
        expect(
          Number(r2.items.find((i) => i.employeeId === fx.fullMonthEmpId)!.leaveEncashment),
        ).toBe(0);

        await api().delete(`/payrolls/${r2.id}`).set(admin()).set('X-Branch-Id', branch());
        await api().delete(`/payrolls/${r1.id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 150_000);

    it('PE-IN-54: taxable vs post-tax changes the TAX, never the payment', async () => {
      // The setting exists because whether encashment is taxable is a local
      // legal question, not an engineering one. What must hold either way is
      // that the employee receives the same money — only the statutory base
      // moves. A setting that changed the payment would be a bug, not a policy.
      const measure = async (taxable: string, period: { month: number; year: number }) =>
        withSettings(ctx, { ...ON, leave_encashment_taxable: taxable }, async () => {
          await setBalance(fx.fullMonthEmpId, YEAR, 30, 0);
          const created = await request(fx.fullMonthEmpId, 3);
          await approve(created.body.data.id);

          await openPeriod(fx.fullMonthEmpId, period);
          const r = await runPayroll(period, [fx.fullMonthEmpId]);
          const item = r.items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
          const out = {
            encash: Number(item.leaveEncashment),
            tax: Number(item.tax),
            insurance: Number(item.insurance),
          };
          await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
          await ctx.prisma.leaveEncashmentRequest.deleteMany({ where: { branchId: branch() } });
          return out;
        });

      const post = await measure('false', fx.periodAt(74));
      const taxed = await measure('true', fx.periodAt(75));

      // Same payment.
      expect(taxed.encash).toBe(post.encash);
      expect(taxed.encash).toBeGreaterThan(0);
      // Different statutory base — taxing it can only ever take more, never less.
      expect(taxed.tax + taxed.insurance).toBeGreaterThanOrEqual(
        post.tax + post.insurance,
      );
    }, 180_000);

    it('PE-IN-49: with the flag OFF, an approved request is not paid at all', async () => {
      let requestId = '';
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.fullMonthEmpId, YEAR, 30, 0);
        const created = await request(fx.fullMonthEmpId, 3);
        await approve(created.body.data.id);
        requestId = created.body.data.id;
      });

      const period = fx.periodAt(73);
      await openPeriod(fx.fullMonthEmpId, period);
      const r = await runPayroll(period, [fx.fullMonthEmpId]);
      const item = r.items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
      expect(Number(item.leaveEncashment)).toBe(0);

      const row = await ctx.prisma.leaveEncashmentRequest.findUnique({
        where: { id: requestId },
      });
      // Still approved and still unlinked — it waits for the feature, rather
      // than being silently consumed by a run that could not pay it.
      expect(row?.status).toBe('APPROVED');
      expect(row?.payrollItemId).toBeNull();

      await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
    }, 120_000);
  });

  // ── Carry-forward ────────────────────────────────────────────────────────

  describe('PE-IN-50..53 — the year end', () => {
    beforeEach(async () => {
      await setPolicy({
        encashable: true,
        carryForwardEnabled: true,
        carryForwardMaxDays: 5,
      });
      await ctx.prisma.leaveCarryForwardRun.deleteMany({ where: { branchId: branch() } });
    });

    const carry = (fromYear: number, toYear: number) =>
      api()
        .post('/leave-encashment/carry-forward')
        .set(admin())
        .set('X-Branch-Id', branch())
        .send({ branchId: branch(), fromYear, toYear });

    it('PE-IN-50: writes carriedOver, capped by the policy', async () => {
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.fullMonthEmpId, 2040, 30, 10);
        const res = await carry(2040, 2041);
        expect(res.status).toBe(201);

        const next = await ctx.prisma.leaveTypeBalance.findUnique({
          where: {
            employeeId_year_leaveTypeKey: {
              employeeId: fx.fullMonthEmpId,
              year: 2041,
              leaveTypeKey: TYPE,
            },
          },
        });
        // 20 unused, capped at 5.
        expect(next?.carriedOver).toBe(5);
        expect(next?.carriedFromYear).toBe(2040);
      });
    }, 90_000);

    it('PE-IN-51: running it twice is REFUSED, not doubled', async () => {
      // The failure this guards against is an ordinary human mistake with a
      // permanent consequence: every employee's balance silently doubles.
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.fullMonthEmpId, 2042, 30, 10);
        expect((await carry(2042, 2043)).status).toBe(201);

        const again = await carry(2042, 2043);
        expect(again.status).toBe(409);
        expect(String(again.body?.message ?? '')).toMatch(/would double every carried balance/i);
      });
    }, 90_000);

    it('PE-IN-52: a reversal undoes exactly the rows that run touched', async () => {
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.fullMonthEmpId, 2046, 30, 10);
        const res = await carry(2046, 2047);
        const runId = res.body.data.id;

        const reversed = await api()
          .post(`/leave-encashment/carry-forward/${runId}/reverse`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({});
        expect(reversed.status).toBe(201);

        const next = await ctx.prisma.leaveTypeBalance.findUnique({
          where: {
            employeeId_year_leaveTypeKey: {
              employeeId: fx.fullMonthEmpId,
              year: 2047,
              leaveTypeKey: TYPE,
            },
          },
        });
        expect(next?.carriedOver).toBe(0);
        expect(next?.carryForwardRunId).toBeNull();
      });
    }, 90_000);

    it('PE-IN-53: a day already encashed is not also carried', async () => {
      // Paid for the day AND keeps it — an error that compounds every year.
      await withSettings(ctx, ON, async () => {
        await setBalance(fx.fullMonthEmpId, 2048, 30, 10);
        const created = await request(fx.fullMonthEmpId, 4, 2048);
        const approved = await approve(created.body.data.id);
        await ctx.prisma.leaveEncashmentRequest.update({
          where: { id: approved.body.data.id },
          data: { status: 'PAID', paidAt: new Date(), settlementId: created.body.data.id },
        });

        await setPolicy({
          encashable: true,
          carryForwardEnabled: true,
          carryForwardMaxDays: 100,
        });
        await carry(2048, 2049);

        const next = await ctx.prisma.leaveTypeBalance.findUnique({
          where: {
            employeeId_year_leaveTypeKey: {
              employeeId: fx.fullMonthEmpId,
              year: 2049,
              leaveTypeKey: TYPE,
            },
          },
        });
        // 20 unused minus the 4 already paid out.
        expect(next?.carriedOver).toBe(16);
      });
    }, 90_000);
  });
});
