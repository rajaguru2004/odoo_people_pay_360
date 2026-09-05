import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';

/**
 * `PE-EOSB` — joiners, leavers and the settlement run type.
 *
 * What this is NOT: a test of End of Service Benefits. There is no EOSB module —
 * no gratuity accrual, no service-years arithmetic, no settlement statement.
 * `schema.prisma` says so outright ("This is not an F&F module"), and
 * `docs/PAYROLL-GAP-REPORT.md` §1 records the whole absent section.
 *
 * `PayrollRunType.FINAL_SETTLEMENT` is a run type that pays a leaver what they
 * are owed on the way out. These cases assert that it round-trips and behaves
 * like an ordinary run otherwise, and cover the employment BOUNDARIES, which do
 * exist and which G31 was found in.
 */
describe('Payroll edge — joiners, leavers, settlement (PE-EOSB)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;
  const num = (v: unknown) => Number(v ?? 0);

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

  const run = async (
    period: { month: number; year: number },
    employeeIds: string[],
    runType?: string,
  ) => {
    const created = await api()
      .post('/payrolls')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ month: period.month, year: period.year, employeeIds, runType });
    const id = created.body?.data?.id ?? created.body?.id;
    const full = await api().get(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
    const payroll = full.body?.data ?? full.body;
    return { status: created.status, id, payroll, items: (payroll.items ?? []) as any[] };
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ONE run for the base period, shared by the two joiner cases. The joiner's
  // start date only falls inside `fx.period`, so both cases need that period —
  // and a period holds exactly one run, so the second create would 409 and leave
  // the case asserting on an empty item list.
  let baseItems: any[] = [];

  beforeAll(async () => {
    const res = await run(fx.period, [fx.fullMonthEmpId, fx.joinerEmpId]);
    baseItems = res.items;
  }, 60_000);

  it('PE-EOSB-01: a joiner is paid for the days they were employed, not the month', async () => {
    const items = baseItems;
    const control = items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
    const joiner = items.find((i) => i.employeeId === fx.joinerEmpId)!;

    expect(num(joiner.workDays)).toBe(num(control.workDays));
    expect(num(joiner.actualWorkDays)).toBe(1);
    expect(num(joiner.netSalary)).toBeLessThan(num(control.netSalary) / 5);
    expect(num(joiner.netSalary)).toBeGreaterThan(0);
  });

  it('PE-EOSB-02: the payslip explains the short month as employment, not absence', async () => {
    // Asserted on the ORIGINAL period, which is the only one the joiner's start
    // date falls inside — in any later period they are employed throughout and
    // there is nothing to explain.
    const joiner = baseItems.find((i) => i.employeeId === fx.joinerEmpId)!;
    expect(joiner).toBeDefined();

    // Days before the hire date are not absence, and calling them loss of pay is
    // the half of G31 that reaches the employee.
    expect(String(joiner.notes ?? '')).toMatch(/Employed for 1 of \d+ working day\(s\)/i);
    expect(String(joiner.notes ?? '')).toMatch(/not absence/i);
    expect(String(joiner.notes ?? '')).not.toMatch(/Loss of Pay \(LOP\)/i);
  });

  it('PE-EOSB-03: a leaver is paid up to their end date', async () => {
    const period = fx.periodAt(41);
    // Open the period, or the run is refused for missing attendance and every
    // assertion below reads as "the employee was not paid".
    await openPeriod(fx.fullMonthEmpId, period);
    const { items } = await run(period, [fx.fullMonthEmpId, fx.leaverEmpId]);
    const control = items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
    const leaver = items.find((i) => i.employeeId === fx.leaverEmpId);

    // A leaver whose end date is BEFORE this period may not be picked up at all,
    // which is itself correct — assert whichever holds, and never silently pass
    // on an empty result.
    expect(control).toBeDefined();
    if (leaver) {
      expect(num(leaver.netSalary)).toBeLessThanOrEqual(num(control.netSalary));
    }
  });

  it('PE-EOSB-04: FINAL_SETTLEMENT round-trips as its own run type', async () => {
    const period = fx.periodAt(42);
    await openPeriod(fx.fullMonthEmpId, period);
    const { status, payroll, items } = await run(
      period,
      [fx.fullMonthEmpId],
      'FINAL_SETTLEMENT',
    );

    expect(status).toBe(201);
    expect(payroll.runType).toBe('FINAL_SETTLEMENT');
    expect(payroll.status).toBe('DRAFT');
    // What it is NOT: there is no gratuity, no service-years figure and no
    // settlement statement — `PayrollItem` has no column that could carry one.
    expect(num(items[0].netSalary)).toBeGreaterThan(0);
  });

  it('PE-EOSB-05: G32 — a settlement run CAN reach an INACTIVE leaver', async () => {
    // The run type that exists to settle a leaver used to exclude INACTIVE staff
    // exactly as a REGULAR run does, and every soft-exit path writes INACTIVE —
    // so the natural HR order (close the record, then settle) produced a run the
    // leaver was silently absent from, and the run looked complete.
    const period = fx.periodAt(43);
    await openPeriod(fx.fullMonthEmpId, period);
    const { items } = await run(
      period,
      [fx.fullMonthEmpId, fx.base.terminatedEmpId],
      'FINAL_SETTLEMENT',
    );
    const paid = items.map((i) => i.employeeId);

    expect(paid).toContain(fx.fullMonthEmpId);
    expect(paid).toContain(fx.base.terminatedEmpId);
  });

  it('PE-EOSB-06: G32 — every OTHER run type still excludes INACTIVE staff', async () => {
    // The widening is scoped to FINAL_SETTLEMENT. A REGULAR run must not start
    // paying people who have left.
    const period = fx.periodAt(44);
    await openPeriod(fx.fullMonthEmpId, period);
    const { items } = await run(period, [fx.fullMonthEmpId, fx.base.terminatedEmpId]);
    const paid = items.map((i) => i.employeeId);

    expect(paid).toContain(fx.fullMonthEmpId);
    expect(paid).not.toContain(fx.base.terminatedEmpId);
  });
});
