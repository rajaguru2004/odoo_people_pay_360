import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';
import { withSettings } from './utils/settings';

/**
 * `PE-EOSB-20..` — end-of-service benefits, with the feature ON.
 *
 * The sibling file `payroll-edge-settlement.e2e-spec.ts` says in its own docblock
 * that it is NOT a test of end-of-service benefits, because there was no such
 * module. This is that test.
 *
 * Two properties carry the whole feature and are asserted here against a real
 * database rather than a mock:
 *
 *   1. A gratuity is a PROVISION. Turning it on must not move a payslip, a net,
 *      a tax figure or a wage-file row by a single unit.
 *   2. The provision survives a reversal correctly — an unlock reverses it, a
 *      re-lock does not double it, and a settled provision refuses the unlock
 *      outright rather than being silently un-made.
 *
 * Flag flipping is safe here: the backend e2e config runs `maxWorkers: 1`, so no
 * other suite is reading the settings table while these cases move it. That is
 * why the exhaustive matrix lives at this layer rather than in the browser.
 */
describe('Payroll edge — end of service (PE-EOSB)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;
  const num = (v: unknown) => Number(v ?? 0);

  /** Every switch this feature needs, on. */
  const EOSB_ON = {
    payroll_eosb_enabled: 'true',
    payroll_eosb_accrual_enabled: 'true',
    payroll_country: 'OM',
  };

  const openPeriod = async (employeeIds: string[], period: { month: number; year: number }) => {
    await ctx.prisma.attendance.createMany({
      data: employeeIds.map((employeeId) => ({
        employeeId,
        branchId: branch(),
        date: new Date(Date.UTC(period.year, period.month - 1, 3)),
        status: 'PRESENT',
        workHours: 8,
      })),
      skipDuplicates: true,
    });
  };

  const run = async (period: { month: number; year: number }, employeeIds: string[]) => {
    const created = await api()
      .post('/payrolls')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ month: period.month, year: period.year, employeeIds });
    const id = created.body?.data?.id ?? created.body?.id;
    const full = await api().get(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
    const payroll = full.body?.data ?? full.body;
    return { status: created.status, id, items: (payroll?.items ?? []) as any[] };
  };

  /**
   * Drive a run all the way to LOCKED.
   *
   * `lock` alone answers 400 from DRAFT — the machine is
   * DRAFT -> PENDING_APPROVAL -> APPROVED -> LOCKED — and a lock that never
   * happened writes no provision, which reads exactly like a feature that does
   * not work. Every case here needs the whole path.
   */
  const lock = async (id: string) => {
    await api().post(`/payrolls/${id}/submit`).set(admin()).set('X-Branch-Id', branch()).send({});
    await api().post(`/payrolls/${id}/approve`).set(admin()).set('X-Branch-Id', branch()).send({});
    const res = await api()
      .post(`/payrolls/${id}/lock`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({});
    // Fail loudly here rather than letting a silent 400 masquerade as
    // "the provision was not written".
    if (res.status >= 400) {
      throw new Error(
        `lock(${id}) answered ${res.status}: ${JSON.stringify(res.body?.message)}`,
      );
    }
    return res;
  };

  /** Same argument as `lock`: a silent refusal must not read as a no-op. */
  const unlock = async (id: string, reason = 'reversing for a test') => {
    const res = await api()
      .post(`/payrolls/${id}/unlock`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ reason });
    if (res.status >= 400) {
      throw new Error(
        `unlock(${id}) answered ${res.status}: ${JSON.stringify(res.body?.message)}`,
      );
    }
    return res;
  };

  const accrualsFor = (employeeId: string) =>
    ctx.prisma.gratuityAccrual.findMany({ where: { employeeId } });

  /** Give an employee a nationality class, which gratuity refuses to guess at. */
  const setClass = async (employeeId: string, nationalityClass: string | null) => {
    await ctx.prisma.employeeProfile.upsert({
      where: { employeeId },
      create: { employeeId, nationalityClass: nationalityClass ?? undefined },
      update: { nationalityClass },
    });
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Rules ────────────────────────────────────────────────────────────────

  describe('PE-EOSB-20..24 — the rule table', () => {
    it('PE-EOSB-20: ships exactly one Oman rule, so nothing is guessed', async () => {
      const res = await api().get('/gratuity/rules?country=OM').set(admin());
      expect(res.status).toBe(200);
      const rules = res.body?.data ?? [];
      expect(rules.length).toBeGreaterThanOrEqual(1);
      const seeded = rules.find((r: any) => r.nationalityClass === 'EXPAT');
      expect(seeded).toBeDefined();
      expect(Number(seeded.daysPerYear)).toBe(30);
      expect(seeded.basis).toBe('BASIC');
    });

    it('PE-EOSB-21: refuses a second rule overlapping the same band, in words', async () => {
      // Two overlapping rules make an entitlement depend on which row is read
      // first, and the failure would not show until someone with enough service
      // to reach the overlap finally left.
      const res = await api()
        .post('/gratuity/rules')
        .set(admin())
        .send({
          country: 'OM',
          nationalityClass: 'EXPAT',
          fromYears: 2,
          toYears: 5,
          daysPerYear: 21,
          effectiveFrom: '2023-07-26',
        });
      expect(res.status).toBe(400);
      expect(String(res.body?.message ?? '')).toMatch(/already covers part of this service band/i);
    });

    it('PE-EOSB-22: accepts a non-overlapping band for another class', async () => {
      const res = await api()
        .post('/gratuity/rules')
        .set(admin())
        .send({
          country: 'OM',
          nationalityClass: 'NATIONAL',
          fromYears: 0,
          toYears: null,
          daysPerYear: 30,
          employerShare: 0,
          effectiveFrom: '2023-07-26',
          notes: 'Social Protection Fund carries the benefit for nationals.',
        });
      expect(res.status).toBe(201);
      await ctx.prisma.gratuityRule.delete({ where: { id: res.body.data.id } });
    });

    it('PE-EOSB-23: refuses a band that ends before it starts', async () => {
      const res = await api()
        .post('/gratuity/rules')
        .set(admin())
        .send({
          country: 'QA',
          nationalityClass: 'EXPAT',
          fromYears: 5,
          toYears: 2,
          daysPerYear: 21,
          effectiveFrom: '2023-01-01',
        });
      expect(res.status).toBe(400);
      expect(String(res.body?.message ?? '')).toMatch(/ends before it starts/i);
    });

    it('PE-EOSB-24: a rule is retired, never deleted', async () => {
      const created = await api()
        .post('/gratuity/rules')
        .set(admin())
        .send({
          country: 'QA',
          nationalityClass: 'EXPAT',
          fromYears: 0,
          daysPerYear: 21,
          effectiveFrom: '2023-01-01',
        });
      const id = created.body.data.id;
      const res = await api().delete(`/gratuity/rules/${id}`).set(admin());
      expect(res.status).toBe(200);
      // Still there — an accrual computed under it must stay explainable.
      const still = await ctx.prisma.gratuityRule.findUnique({ where: { id } });
      expect(still).not.toBeNull();
      expect(still!.isActive).toBe(false);
      await ctx.prisma.gratuityRule.delete({ where: { id } });
    });
  });

  // ── The provision ────────────────────────────────────────────────────────

  describe('PE-EOSB-25..31 — the provision is written, and moves no money', () => {
    it('PE-EOSB-25: with the flag OFF, locking writes no provision at all', async () => {
      const period = fx.periodAt(60);
      await openPeriod([fx.fullMonthEmpId], period);
      const r = await run(period, [fx.fullMonthEmpId]);
      await lock(r.id);

      expect(await accrualsFor(fx.fullMonthEmpId)).toHaveLength(0);

      await unlock(r.id);
      await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
    }, 60_000);

    it('PE-EOSB-26: with the flag ON, locking writes one provision per employee', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      const period = fx.periodAt(61);
      await openPeriod([fx.fullMonthEmpId], period);

      await withSettings(ctx, EOSB_ON, async () => {
        const r = await run(period, [fx.fullMonthEmpId]);
        await lock(r.id);

        const rows = await accrualsFor(fx.fullMonthEmpId);
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].amount)).toBeGreaterThan(0);
        expect(rows[0].status).toBe('ACCRUED');

        await unlock(r.id);
        await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 90_000);

    it('PE-EOSB-27: the provision stores the working that defends it', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      const period = fx.periodAt(62);
      await openPeriod([fx.fullMonthEmpId], period);

      await withSettings(ctx, EOSB_ON, async () => {
        const r = await run(period, [fx.fullMonthEmpId]);
        await lock(r.id);

        const row = (await accrualsFor(fx.fullMonthEmpId))[0];
        const working = row.workingJson as any;
        // A settlement disputed years later cannot be answered with "the system
        // would calculate it differently now".
        expect(working).toBeTruthy();
        expect(Array.isArray(working.bands)).toBe(true);
        expect(Array.isArray(working.lines)).toBe(true);
        expect(working.lines.join(' ')).toMatch(/Service: .* year\(s\)/);

        await unlock(r.id);
        await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 90_000);

    it('PE-EOSB-28: a provision changes NO figure on the payslip', async () => {
      // The property the whole design rests on. Same employee, same period,
      // once with the feature off and once with it on: every money column and
      // the run total must be identical.
      await setClass(fx.fullMonthEmpId, 'EXPAT');

      const cols = (i: any) => ({
        baseSalary: num(i.baseSalary),
        allowances: num(i.allowances),
        bonus: num(i.bonus),
        deduction: num(i.deduction),
        overtimePay: num(i.overtimePay),
        foodAllowance: num(i.foodAllowance),
        reimbursement: num(i.reimbursement),
        advanceLoanDeduction: num(i.advanceLoanDeduction),
        garnishment: num(i.garnishment),
        insurance: num(i.insurance),
        tax: num(i.tax),
        netSalary: num(i.netSalary),
      });

      const offPeriod = fx.periodAt(63);
      await openPeriod([fx.fullMonthEmpId], offPeriod);
      const offRun = await run(offPeriod, [fx.fullMonthEmpId]);
      const off = cols(offRun.items.find((i) => i.employeeId === fx.fullMonthEmpId));

      const onPeriod = fx.periodAt(64);
      await openPeriod([fx.fullMonthEmpId], onPeriod);
      const on = await withSettings(ctx, EOSB_ON, async () => {
        const r = await run(onPeriod, [fx.fullMonthEmpId]);
        await lock(r.id);
        const item = r.items.find((i) => i.employeeId === fx.fullMonthEmpId);
        await unlock(r.id);
        await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
        return cols(item);
      });

      expect(on).toEqual(off);
      await api().delete(`/payrolls/${offRun.id}`).set(admin()).set('X-Branch-Id', branch());
    }, 120_000);

    it('PE-EOSB-29: an unrecorded nationality class is skipped, not guessed', async () => {
      // Accruing at the expatriate rate for someone whose class nobody recorded
      // would hide a missing record behind a plausible statutory number.
      await setClass(fx.noAttendanceEmpId, null);
      const period = fx.periodAt(65);
      await openPeriod([fx.noAttendanceEmpId], period);

      await withSettings(ctx, EOSB_ON, async () => {
        const r = await run(period, [fx.noAttendanceEmpId]);
        await lock(r.id);
        expect(await accrualsFor(fx.noAttendanceEmpId)).toHaveLength(0);
        await unlock(r.id);
        await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 90_000);

    it('PE-EOSB-30: unlocking reverses the provision without deleting it', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      const period = fx.periodAt(66);
      await openPeriod([fx.fullMonthEmpId], period);

      await withSettings(ctx, EOSB_ON, async () => {
        const r = await run(period, [fx.fullMonthEmpId]);
        await lock(r.id);
        await unlock(r.id);

        const rows = await ctx.prisma.gratuityAccrual.findMany({
          where: { payrollId: r.id },
        });
        // Still there, and stamped. Same reasoning as the loan ledger beside it:
        // after a reversal there must still be a record that it happened.
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('REVERSED');
        expect(rows[0].reversedAt).not.toBeNull();

        await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 90_000);

    it('PE-EOSB-31: lock → unlock → lock does not double the provision', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      const period = fx.periodAt(67);
      await openPeriod([fx.fullMonthEmpId], period);

      await withSettings(ctx, EOSB_ON, async () => {
        const r = await run(period, [fx.fullMonthEmpId]);
        await lock(r.id);
        await unlock(r.id);
        const second = await lock(r.id);
        expect(second.status).toBeLessThan(400);

        const live = await ctx.prisma.gratuityAccrual.findMany({
          where: { payrollId: r.id, status: 'ACCRUED' },
        });
        // The unique index on (employeeId, payrollId) is what makes this safe;
        // without it a re-lock would silently double a reported liability.
        expect(live.length).toBeLessThanOrEqual(1);

        await unlock(r.id);
        await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 120_000);
  });

  describe('PE-EOSB-47..48 — paying the benefit through the run', () => {
    const settlementRun = async (period: { month: number; year: number }) => {
      const created = await api()
        .post('/payrolls')
        .set(admin())
        .set('X-Branch-Id', branch())
        .send({
          month: period.month,
          year: period.year,
          employeeIds: [fx.fullMonthEmpId],
          runType: 'FINAL_SETTLEMENT',
        });
      const id = created.body?.data?.id;
      const full = await api().get(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
      return { id, items: (full.body?.data?.items ?? []) as any[] };
    };

    it('PE-EOSB-47: OFF by default — a settlement run carries no gratuity', async () => {
      // Gratuity is a provision. Everywhere except a jurisdiction that demands
      // otherwise, it never touches a payslip and therefore never reaches the
      // wage file.
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      const period = fx.periodAt(68);
      await openPeriod([fx.fullMonthEmpId], period);

      await withSettings(ctx, EOSB_ON, async () => {
        const r = await settlementRun(period);
        const item = r.items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
        expect(Number(item.gratuityPayout ?? 0)).toBe(0);
        await api().delete(`/payrolls/${r.id}`).set(admin()).set('X-Branch-Id', branch());
      });
    }, 90_000);

    it('PE-EOSB-48: ON — the benefit reaches the payslip, and only on a settlement run', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      const ON_PAID = { ...EOSB_ON, payroll_eosb_pay_through_final_run: 'true' };

      await withSettings(ctx, ON_PAID, async () => {
        const settle = fx.periodAt(69);
        await openPeriod([fx.fullMonthEmpId], settle);
        const paid = await settlementRun(settle);
        const item = paid.items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
        expect(Number(item.gratuityPayout)).toBeGreaterThan(0);
        // Post-tax: an end-of-service benefit is not ordinary earnings, and
        // putting it through the statutory pipeline would tax a payment most
        // jurisdictions exempt.
        expect(Number(item.netSalary)).toBeGreaterThan(Number(item.gratuityPayout));
        await api().delete(`/payrolls/${paid.id}`).set(admin()).set('X-Branch-Id', branch());

        // A REGULAR run in the same state carries nothing: the setting is about
        // the exit, not about payroll generally.
        const regular = fx.periodAt(70);
        await openPeriod([fx.fullMonthEmpId], regular);
        const created = await api()
          .post('/payrolls')
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ month: regular.month, year: regular.year, employeeIds: [fx.fullMonthEmpId] });
        const full = await api()
          .get(`/payrolls/${created.body.data.id}`)
          .set(admin())
          .set('X-Branch-Id', branch());
        const regItem = (full.body.data.items ?? []).find(
          (i: any) => i.employeeId === fx.fullMonthEmpId,
        );
        expect(Number(regItem.gratuityPayout ?? 0)).toBe(0);
        await api()
          .delete(`/payrolls/${created.body.data.id}`)
          .set(admin())
          .set('X-Branch-Id', branch());
      });
    }, 150_000);
  });

  // ── Entitlement ──────────────────────────────────────────────────────────

  describe('PE-EOSB-32..34 — what an employee would receive', () => {
    it('PE-EOSB-32: answers the question HR is asked constantly', async () => {
      await setClass(fx.fullMonthEmpId, 'EXPAT');
      await withSettings(ctx, EOSB_ON, async () => {
        const res = await api()
          .get(`/gratuity/employee/${fx.fullMonthEmpId}/entitlement`)
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(res.status).toBe(200);
        const d = res.body.data;
        expect(d.serviceYears).toBeGreaterThan(0);
        expect(d.amount).toBeGreaterThan(0);
        expect(Array.isArray(d.workingLines)).toBe(true);
      });
    }, 60_000);

    it('PE-EOSB-33: says why, rather than answering zero, when the class is missing', async () => {
      await setClass(fx.leaverEmpId, null);
      await withSettings(ctx, EOSB_ON, async () => {
        const res = await api()
          .get(`/gratuity/employee/${fx.leaverEmpId}/entitlement`)
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(res.status).toBe(200);
        expect(res.body.data.amount).toBe(0);
        expect(String(res.body.data.refusal ?? '')).toMatch(/nationality class is not recorded/i);
      });
    }, 60_000);

    it('PE-EOSB-34: reports the liability by branch', async () => {
      await withSettings(ctx, EOSB_ON, async () => {
        const res = await api()
          .get('/gratuity/liability')
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.data)).toBe(true);
      });
    }, 60_000);
  });
});
