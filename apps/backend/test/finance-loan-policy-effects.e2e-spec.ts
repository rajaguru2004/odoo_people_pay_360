import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer, withSettings } from './utils/settings';

/**
 * The four settings that were resolved and branched on nowhere.
 *
 * `docs/LOAN-ADVANCES-GAP-REPORT.md` §16 calls these "silent no-ops", and says
 * they are arguably worse than an absent feature because they look supported:
 * an administrator could set any of them, see it saved, and get the old
 * behaviour forever.
 *
 *   `paymentAllocationOrder`  — `splitPayment` was hardcoded fee→interest→principal
 *   `autoCloseOnFullRecovery` — the closure sweep ran unconditionally
 *   `gracePeriodCycles`       — resolved, never consulted
 *   `deferralMode`            — both values behaved as CARRY_FORWARD
 *
 * Each case here sets one and reads the CONSEQUENCE back off the money.
 */
describe('Finance — loan policy that finally does something (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const MONTH = 5;
  const YEAR = 2032;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any): any => res.body?.data ?? res.body;

  const expectStatus = (res: any, expected: number | number[], label = '') => {
    const want = Array.isArray(expected) ? expected : [expected];
    if (!want.includes(res.status)) {
      throw new Error(
        `${label ? `${label} — ` : ''}expected ${want.join(' or ')}, got ${res.status}: ${body(res)}`,
      );
    }
  };

  /** A live loan with one instalment due in the target cycle. */
  const seedLoan = async (over: Record<string, any> = {}) => {
    const loan = await ctx.prisma.advanceLoanRequest.create({
      data: {
        employeeId: fx.earnerId,
        type: 'LOAN',
        amount: 1000,
        installments: 5,
        installmentAmount: 200,
        status: 'ACTIVE',
        scheduleVersion: 1,
        outstandingPrincipal: 1000,
        ...(over.request ?? {}),
      },
    });
    await ctx.prisma.loanSchedule.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        requestId: loan.id,
        version: 1,
        installmentNo: i + 1,
        dueDate: new Date(Date.UTC(YEAR, MONTH - 1 + i, 28)),
        dueCycleKey: YEAR * 12 + MONTH + i,
        dueMonth: ((MONTH - 1 + i) % 12) + 1,
        dueYear: YEAR + Math.floor((MONTH - 1 + i) / 12),
        openingBalance: 1000 - i * 200,
        principalComponent: over.principal ?? 200,
        interestComponent: over.interest ?? 0,
        emiAmount: (over.principal ?? 200) + (over.interest ?? 0),
        closingBalance: 800 - i * 200,
        status: 'SCHEDULED' as const,
      })),
    });
    return loan;
  };

  const runPayroll = () =>
    ctx
      .http()
      .post('/payrolls')
      .set(bearer(fx.admin.token))
      .set('X-Branch-Id', fx.branchA)
      .send({ month: MONTH, year: YEAR, employeeIds: [fx.earnerId] });

  const lock = async (payrollId: string) => {
    await ctx.http().post(`/payrolls/${payrollId}/submit`).set(bearer(fx.admin.token)).send({});
    await ctx.http().post(`/payrolls/${payrollId}/approve`).set(bearer(fx.admin.token)).send({});
    return ctx.http().post(`/payrolls/${payrollId}/lock`).set(bearer(fx.admin.token)).send({});
  };

  const deductionsFor = (requestId: string) =>
    ctx.prisma.advanceLoanDeduction.findMany({ where: { requestId } });

  const clearAll = async () => {
    const payrollIds = (
      await ctx.prisma.payroll.findMany({ where: { year: YEAR }, select: { id: true } })
    ).map((p) => p.id);
    if (payrollIds.length) {
      await ctx.prisma.advanceLoanDeduction.deleteMany({
        where: { payrollItem: { payrollId: { in: payrollIds } } },
      });
      await ctx.prisma.payrollItem.deleteMany({ where: { payrollId: { in: payrollIds } } });
      await ctx.prisma.payroll.deleteMany({ where: { id: { in: payrollIds } } });
    }
    const loanIds = (
      await ctx.prisma.advanceLoanRequest.findMany({
        where: { employeeId: fx.earnerId },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (!loanIds.length) return;
    const where = { requestId: { in: loanIds } };
    await ctx.prisma.advanceLoanNotificationLog.deleteMany({ where });
    await ctx.prisma.loanTransaction.deleteMany({ where });
    await ctx.prisma.advanceLoanDeduction.deleteMany({ where });
    await ctx.prisma.loanSchedule.deleteMany({ where });
    await ctx.prisma.advanceLoanRequest.deleteMany({ where: { id: { in: loanIds } } });
  };

  /** v2 on, no floors: the setting under test is the only thing deciding. */
  const V2 = {
    loan_module_v2_enabled: 'true',
    loan_min_net_pay_amount: '0',
    loan_min_net_pay_percent: '0',
    loan_max_total_deduction_percent_of_net: '100',
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);

    const daysInMonth = new Date(Date.UTC(YEAR, MONTH, 0)).getUTCDate();
    await ctx.prisma.attendance.createMany({
      data: Array.from({ length: daysInMonth }, (_, i) => ({
        employeeId: fx.earnerId,
        branchId: fx.branchA,
        date: new Date(Date.UTC(YEAR, MONTH - 1, i + 1)),
        status: 'PRESENT' as const,
      })),
      skipDuplicates: true,
    });
  });

  afterEach(clearAll);

  afterAll(async () => {
    await clearAll();
    await ctx.prisma.attendance.deleteMany({
      where: {
        employeeId: fx.earnerId,
        date: {
          gte: new Date(Date.UTC(YEAR, MONTH - 1, 1)),
          lte: new Date(Date.UTC(YEAR, MONTH, 0)),
        },
      },
    });
    await fx.cleanup();
    await ctx.app.close();
  });

  // ── paymentAllocationOrder ────────────────────────────────────────────────

  describe('paymentAllocationOrder decides what a payment pays off', () => {
    /** An instalment that is half interest, so the split is visible. */
    const seedInterestBearing = () =>
      seedLoan({ principal: 100, interest: 100 });

    it('INTEREST_FIRST clears the interest before the principal', async () => {
      await withSettings(
        ctx,
        { ...V2, loan_payment_allocation_order: 'INTEREST_FIRST', loan_shortfall_policy: 'PARTIAL' },
        async () => {
          const loan = await seedInterestBearing();
          // Only 150 of the 200 instalment is affordable, so the split shows.
          await ctx.prisma.employee.update({
            where: { id: fx.earnerId },
            data: { baseSalary: 150 },
          });

          const created = await runPayroll();
          expectStatus(created, 201, 'payroll create');
          const rows = await deductionsFor(loan.id);
          // The claim is the ORDER, not the exact figures: net pay is salary
          // less tax and PF, so the shortfall is not a round number.
          expect(rows.length).toBe(1);
          expect(Number(rows[0].interestComponent)).toBe(100);
          expect(Number(rows[0].principalComponent)).toBeGreaterThan(0);
          expect(Number(rows[0].principalComponent)).toBeLessThan(100);
        },
      );
    });

    it('PRINCIPAL_FIRST clears the principal before the interest', async () => {
      // The whole point of the setting, and it changed nothing before.
      await withSettings(
        ctx,
        { ...V2, loan_payment_allocation_order: 'PRINCIPAL_FIRST', loan_shortfall_policy: 'PARTIAL' },
        async () => {
          const loan = await seedInterestBearing();
          await ctx.prisma.employee.update({
            where: { id: fx.earnerId },
            data: { baseSalary: 150 },
          });

          const created = await runPayroll();
          expectStatus(created, 201, 'payroll create');
          const rows = await deductionsFor(loan.id);
          expect(rows.length).toBe(1);
          expect(Number(rows[0].principalComponent)).toBe(100);
          expect(Number(rows[0].interestComponent)).toBeGreaterThan(0);
          expect(Number(rows[0].interestComponent)).toBeLessThan(100);
        },
      );
    });

    afterEach(async () => {
      await ctx.prisma.employee.update({
        where: { id: fx.earnerId },
        data: { baseSalary: 1000 },
      });
    });
  });

  // ── gracePeriodCycles ─────────────────────────────────────────────────────

  describe('gracePeriodCycles holds recovery off a new loan', () => {
    it('recovers nothing while the loan is inside the grace window', async () => {
      await withSettings(ctx, { ...V2, loan_grace_period_cycles: '3' }, async () => {
        const loan = await seedLoan();
        const created = await runPayroll();
        expectStatus(created, 201, 'payroll create');

        const rows = await deductionsFor(loan.id);
        expect(rows.every((r) => Number(r.amount) === 0)).toBe(true);
        expect(rows.some((r) => r.reason === 'GRACE_PERIOD')).toBe(true);
      });
    });

    it('recovers normally once the window has passed', async () => {
      await withSettings(ctx, { ...V2, loan_grace_period_cycles: '0' }, async () => {
        const loan = await seedLoan();
        const created = await runPayroll();
        expectStatus(created, 201);

        const rows = await deductionsFor(loan.id);
        expect(rows.some((r) => Number(r.amount) > 0)).toBe(true);
      });
    });
  });

  // ── autoCloseOnFullRecovery ───────────────────────────────────────────────

  describe('autoCloseOnFullRecovery decides whether a repaid loan closes itself', () => {
    /** A loan with one instalment left, which this run will finish. */
    const seedNearlyDone = async () => {
      const loan = await ctx.prisma.advanceLoanRequest.create({
        data: {
          employeeId: fx.earnerId,
          type: 'LOAN',
          amount: 200,
          installments: 1,
          installmentAmount: 200,
          status: 'ACTIVE',
          scheduleVersion: 1,
          outstandingPrincipal: 200,
        },
      });
      await ctx.prisma.loanSchedule.create({
        data: {
          requestId: loan.id,
          version: 1,
          installmentNo: 1,
          dueDate: new Date(Date.UTC(YEAR, MONTH - 1, 28)),
          dueCycleKey: YEAR * 12 + MONTH,
          dueMonth: MONTH,
          dueYear: YEAR,
          openingBalance: 200,
          principalComponent: 200,
          emiAmount: 200,
          closingBalance: 0,
          status: 'SCHEDULED',
        },
      });
      return loan;
    };

    it('closes it when the flag is on', async () => {
      await withSettings(
        ctx,
        { ...V2, loan_auto_close_on_full_recovery: 'true' },
        async () => {
          const loan = await seedNearlyDone();
          const created = await runPayroll();
          expectStatus(await lock(dataOf(created).id), [200, 201], 'lock');

          const row = await ctx.prisma.advanceLoanRequest.findUnique({
            where: { id: loan.id },
          });
          expect(row!.status).toBe('COMPLETED');
        },
      );
    });

    it('leaves it open when the flag is off', async () => {
      // For a company that wants a human to confirm closure — a final fee or
      // an interest adjustment may still be coming.
      await withSettings(
        ctx,
        { ...V2, loan_auto_close_on_full_recovery: 'false' },
        async () => {
          const loan = await seedNearlyDone();
          const created = await runPayroll();
          expectStatus(await lock(dataOf(created).id), [200, 201], 'lock');

          const row = await ctx.prisma.advanceLoanRequest.findUnique({
            where: { id: loan.id },
          });
          expect(row!.status).not.toBe('COMPLETED');
          // The money still moved; only the closure is withheld.
          expect(Number(row!.amountRepaid)).toBeGreaterThan(0);
        },
      );
    });
  });

  // ── deferralMode ──────────────────────────────────────────────────────────

  describe('deferralMode decides where a missed instalment goes', () => {
    /** Nothing affordable this cycle, so the instalment must be deferred. */
    const seedUnaffordable = async () => {
      const loan = await seedLoan();
      await ctx.prisma.employee.update({
        where: { id: fx.earnerId },
        data: { baseSalary: 1 },
      });
      return loan;
    };

    afterEach(async () => {
      await ctx.prisma.employee.update({
        where: { id: fx.earnerId },
        data: { baseSalary: 1000 },
      });
    });

    it('CARRY_FORWARD leaves the plan the same length', async () => {
      await withSettings(
        ctx,
        { ...V2, loan_deferral_mode: 'CARRY_FORWARD', loan_shortfall_policy: 'DEFER' },
        async () => {
          const loan = await seedUnaffordable();
          const created = await runPayroll();
          expectStatus(await lock(dataOf(created).id), [200, 201], 'lock');

          const rows = await ctx.prisma.loanSchedule.findMany({
            where: { requestId: loan.id },
          });
          const versions = new Set(rows.map((r) => r.version));
          // The schedule was not re-planned: one version, as generated.
          expect(versions.size).toBe(1);
        },
      );
    });

    it('EXTEND_TENURE gives the plan another cycle instead', async () => {
      // Both values behaved as CARRY_FORWARD before, so a company asking for
      // "extend the loan rather than double next month" got the opposite.
      await withSettings(
        ctx,
        { ...V2, loan_deferral_mode: 'EXTEND_TENURE', loan_shortfall_policy: 'DEFER' },
        async () => {
          const loan = await seedUnaffordable();
          const created = await runPayroll();
          expectStatus(await lock(dataOf(created).id), [200, 201], 'lock');

          const after = await ctx.prisma.advanceLoanRequest.findUnique({
            where: { id: loan.id },
          });
          expect(after!.scheduleVersion).toBeGreaterThan(1);
        },
      );
    });
  });
});
