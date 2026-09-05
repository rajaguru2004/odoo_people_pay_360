import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';

/**
 * `PE-REC` — what happens when deductions exceed the pay they come out of.
 *
 * The GARNISHMENT rung is owned by `payroll-edge-garnishment.e2e-spec.ts`
 * (`PE-GARN`) — when this file was written that rung could not be driven at all,
 * because `PayrollItem.garnishment` had exactly one writer in the codebase, the
 * literal `garnishment: 0`, and no DTO field anywhere (G28). The `Garnishment`
 * model closed that; the pin is collapsed and the cases live next door.
 *
 * What is left, and what this covers, is the rung anyone can reach: an ad-hoc
 * `deduction` on the item.
 */
describe('Payroll edge — recoveries (PE-REC)', () => {
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

  const runAndItem = async (period: { month: number; year: number }) => {
    await openPeriod(fx.fullMonthEmpId, period);
    const created = await api()
      .post('/payrolls')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ month: period.month, year: period.year, employeeIds: [fx.fullMonthEmpId] });
    const id = created.body?.data?.id ?? created.body?.id;
    const full = await api().get(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
    const items = ((full.body?.data ?? full.body).items ?? []) as any[];
    return { id, item: items.find((i) => i.employeeId === fx.fullMonthEmpId)! };
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  it('PE-REC-01: a deduction larger than the pay floors net at zero, never negative', async () => {
    const { id, item } = await runAndItem(fx.periodAt(20));
    expect(num(item.netSalary)).toBeGreaterThan(0);

    const res = await api()
      .patch(`/payrolls/${id}/items/${item.id}`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ deduction: 99_999 });
    expect(res.status).toBe(200);

    const full = await api().get(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
    const after = ((full.body?.data ?? full.body).items ?? []).find(
      (i: any) => i.employeeId === fx.fullMonthEmpId,
    );
    // Nobody is ever billed by their own payslip.
    expect(num(after.netSalary)).toBe(0);
    expect(num(after.netSalary)).toBeGreaterThanOrEqual(0);
  });

  it('PE-REC-02: G29 FIXED — the floored item still reconciles, and names the shortfall', async () => {
    // The pin this replaces recorded the cost of implementing the floor by
    // clamping the ANSWER: the full deduction stayed on the item, so
    // `gross - deductions` no longer equalled `netSalary` and nothing recorded
    // that the remainder had never been taken.
    //
    // The input is clamped instead. The item stores the largest deduction the
    // pay could bear, the rest becomes a `PayrollCarryForward` row collected by
    // the next run, and the payslip says so. `PE-GARN-20`..`23` own the ledger
    // behaviour; this case owns the arithmetic.
    const { id, item } = await runAndItem(fx.periodAt(21));

    const gross = (i: any) =>
      num(i.baseSalary) + num(i.allowances) + num(i.bonus) + num(i.overtimePay) +
      num(i.foodAllowance);
    const deductions = (i: any) =>
      num(i.deduction) + num(i.insurance) + num(i.tax) + num(i.garnishment);

    // Control: an ordinary item DOES reconcile. Without this the assertion below
    // could pass because the arithmetic never held.
    expect(gross(item) - deductions(item)).toBeCloseTo(num(item.netSalary), 2);

    await api()
      .patch(`/payrolls/${id}/items/${item.id}`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ deduction: Math.round(gross(item) * 10) });

    const full = await api().get(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
    const after = ((full.body?.data ?? full.body).items ?? []).find(
      (i: any) => i.employeeId === fx.fullMonthEmpId,
    );

    expect(num(after.netSalary)).toBe(0);

    // It ADDS UP. Measured at roughly −97,940 against a stated net of 0 before
    // the fix; the two agree to the stored precision now.
    const arithmetic = gross(after) - deductions(after);
    expect(arithmetic).toBeCloseTo(num(after.netSalary), 1);

    // And the payslip names what was not taken, instead of leaving a reader to
    // infer it from figures that did not agree.
    expect(String(after.notes ?? '')).toMatch(/carried forward to the next payroll/i);

    const carried = await ctx.prisma.payrollCarryForward.findMany({
      where: { employeeId: fx.fullMonthEmpId, kind: 'DEDUCTION' },
    });
    expect(carried.length).toBeGreaterThan(0);
  });

  it('PE-REC-03: a negative deduction is refused by name', async () => {
    const { id, item } = await runAndItem(fx.periodAt(22));
    const res = await api()
      .patch(`/payrolls/${id}/items/${item.id}`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ deduction: -5 });

    // A negative deduction is a payment dressed as a recovery.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body?.message)).toMatch(/deduction must not be less than 0/i);
  });

  it('PE-REC-04: deleting a DRAFT run and regenerating it charges exactly once', async () => {
    const period = fx.periodAt(23);
    const first = await runAndItem(period);
    const firstNet = num(first.item.netSalary);

    await api().delete(`/payrolls/${first.id}`).set(admin()).set('X-Branch-Id', branch());

    const second = await runAndItem(period);
    expect(second.id).not.toBe(first.id);
    expect(num(second.item.netSalary)).toBe(firstNet);

    const rows = await ctx.prisma.payroll.count({
      where: { month: period.month, year: period.year, branchId: branch() },
    });
    expect(rows).toBe(1);
  });

  it('PE-REC-05: G28 FIXED — garnishment comes from a court ORDER, never from a payslip edit', async () => {
    // The employee has no order against them, so the rung is zero — and it is
    // zero because nothing attaches, not because nothing can. `PE-GARN-05`
    // proves the same column carries a real figure once an order exists.
    const { id, item } = await runAndItem(fx.periodAt(24));
    expect(num(item.garnishment)).toBe(0);

    const res = await api()
      .patch(`/payrolls/${id}/items/${item.id}`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ garnishment: 100 });

    // Still refused by `forbidNonWhitelisted`, and deliberately so: an
    // attachment of earnings is a court instrument with a reference, a priority
    // and a validity window. Letting one be typed into a payslip line would
    // strip all three and leave an auditor nothing to check. POST /garnishments
    // is the only door.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body?.message)).toMatch(/garnishment should not exist/i);
  });
});
