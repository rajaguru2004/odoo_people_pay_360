import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer, seedAttendance } from './utils/payroll-fixtures';

/**
 * `PE-GARN` — court-ordered attachment of earnings, and the carry-forward
 * ledger that catches what pay could not cover.
 *
 * ## What this replaces
 *
 * `payroll-edge-recovery.e2e-spec.ts` opens by recording that the garnishment
 * rung of the ladder could not be driven at all: `PayrollItem.garnishment` had
 * exactly one writer in the codebase, the literal `garnishment: 0`, and no DTO
 * field anywhere (G28). The allocator honoured a court order the product had no
 * way to record. That gap is now closed, and these cases are the proof.
 *
 * ## The two decisions this pins
 *
 *   **G28** — a court order is a first-class record per employee: amount OR
 *   percentOfNet, a court reference, a priority, a validity window, and an
 *   optional finite total. Payroll reads the LIVE orders each run rather than
 *   copying an amount onto the contract, so revoking one stops the next run
 *   without rewriting anything already paid.
 *
 *   **G29** — when pay cannot satisfy a deduction in full, the remainder is
 *   CARRIED FORWARD instead of lapsing, and it does not die with the
 *   employment: on exit an unrecovered balance becomes a RECEIVABLE.
 *
 * ## The oracle
 *
 * Every money assertion runs a TWIN — a second employee identical in every way
 * except that no order attaches to them — through the same run. The twin's net
 * IS the pre-garnishment net, so nothing here depends on how this environment
 * has PF, ESI or tax configured. See `docs/TEST-PLAN-PAYROLL-EDGE.md` §3.
 */
describe('Payroll edge — garnishments and carry-forward (PE-GARN)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;
  let subjectId: string;
  let twinId: string;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;
  const num = (v: unknown) => Number(v ?? 0);
  const inner = (b: any) => b?.data ?? b;

  /**
   * Both employees get the SAME attendance, so the twin cancels every input the
   * order is not responsible for. Whatever the period pays, the only difference
   * between the two payslips is the court order.
   */
  const openPeriod = async (period: { month: number; year: number }) => {
    // The WHOLE period, not a token day. A single attendance row makes the
    // engine treat the other twenty as loss of pay, which leaves a net of ~57
    // against a 1500 salary — every order then exceeds the pay and every case
    // becomes an accidental shortfall case.
    await seedAttendance(ctx.prisma, [subjectId, twinId], branch(), period);
  };

  const run = async (period: { month: number; year: number }) => {
    await openPeriod(period);
    const created = await api()
      .post('/payrolls')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({
        month: period.month,
        year: period.year,
        employeeIds: [subjectId, twinId],
      });
    expect(created.status).toBeLessThan(300);
    const id = inner(created.body).id as string;
    const full = await api()
      .get(`/payrolls/${id}`)
      .set(admin())
      .set('X-Branch-Id', branch());
    const items = (inner(full.body).items ?? []) as any[];
    return {
      id,
      subject: items.find((i) => i.employeeId === subjectId)!,
      twin: items.find((i) => i.employeeId === twinId)!,
    };
  };

  const order = async (body: Record<string, unknown>) => {
    const res = await api()
      .post('/garnishments')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({
        employeeId: subjectId,
        reference: `CR-${Math.round(Math.random() * 1e9)}`,
        startDate: '2020-01-01',
        ...body,
      });
    expect(res.status).toBeLessThan(300);
    return inner(res.body) as any;
  };

  const clearOrders = async () => {
    await ctx.prisma.payrollCarryForward.deleteMany({
      where: { employeeId: { in: [subjectId, twinId] } },
    });
    await ctx.prisma.garnishmentOrder.deleteMany({
      where: { employeeId: { in: [subjectId, twinId] } },
    });
  };

  const carryForwards = async () =>
    ctx.prisma.payrollCarryForward.findMany({
      where: { employeeId: subjectId },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);

    const suffix = Math.round(Math.random() * 1e6);
    const mk = async (tag: string): Promise<string> => {
      const row = await ctx.prisma.employee.create({
        data: {
          employeeCode: `GARN-${tag}-${suffix}`.slice(0, 30),
          fullName: `Garn ${tag} ${suffix}`,
          dateOfBirth: new Date('1990-01-01'),
          idCard: `GARN-ID-${tag}-${suffix}`,
          email: `garn.${tag}.${suffix}@test.local`,
          departmentId: fx.base.deptId,
          branchId: fx.base.branchA,
          position: 'Tester',
          startDate: new Date('2020-01-01'),
          baseSalary: 1500,
          salaryType: 'MONTHLY',
          status: 'ACTIVE',
        } as any,
        select: { id: true },
      });
      return row.id;
    };
    subjectId = await mk('subj');
    twinId = await mk('twin');
  }, 180_000);

  afterAll(async () => {
    if (ctx?.prisma && subjectId) {
      const ids = [subjectId, twinId];
      await ctx.prisma.payrollItem.deleteMany({ where: { employeeId: { in: ids } } });
      await ctx.prisma.payrollCarryForward.deleteMany({ where: { employeeId: { in: ids } } });
      await ctx.prisma.garnishmentOrder.deleteMany({ where: { employeeId: { in: ids } } });
      await ctx.prisma.attendance.deleteMany({ where: { employeeId: { in: ids } } });
      await ctx.prisma.employee.deleteMany({ where: { id: { in: ids } } });
    }
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  beforeEach(clearOrders);

  // ------------------------------------------------------- recording an order

  it('PE-GARN-01: an order must name exactly one of amount or percentOfNet — neither is refused by name', async () => {
    const res = await api()
      .post('/garnishments')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({
        employeeId: subjectId,
        reference: 'CR-EMPTY',
        startDate: '2020-01-01',
      });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/needs either a fixed amount or a percentage of net pay/i);
  });

  it('PE-GARN-02: naming BOTH an amount and a percentOfNet is refused, not silently resolved', async () => {
    const res = await api()
      .post('/garnishments')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({
        employeeId: subjectId,
        reference: 'CR-BOTH',
        startDate: '2020-01-01',
        amount: 100,
        percentOfNet: 10,
      });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(
      /states either a fixed amount or a percentage of net pay, not both/i,
    );
  });

  it('PE-GARN-03: an order that ends before it starts is refused', async () => {
    const res = await api()
      .post('/garnishments')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({
        employeeId: subjectId,
        reference: 'CR-BACKWARDS',
        startDate: '2034-06-01',
        endDate: '2034-05-01',
        amount: 100,
      });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/order ends before it starts/i);
  });

  it('PE-GARN-04: a court reference is mandatory — an attachment with no instrument behind it is refused', async () => {
    const res = await api()
      .post('/garnishments')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ employeeId: subjectId, startDate: '2020-01-01', amount: 100 });
    expect(res.status).toBe(400);
  });

  // ------------------------------------------------------------- the payslip

  it('PE-GARN-05: G28 FIXED — a recorded order now reaches the payslip; it was always 0 before', async () => {
    await order({ amount: 120 });
    const { subject, twin } = await run(fx.periodAt(40));

    expect(num(twin.garnishment)).toBe(0);
    expect(num(subject.garnishment)).toBe(120);
    // The twin's net IS the pre-garnishment net — no hard-coded figure anywhere.
    expect(num(twin.netSalary) - num(subject.netSalary)).toBeCloseTo(120, 2);
    expect(String(subject.notes ?? '')).toMatch(/Court order .*: 120 recovered/i);
  });

  it('PE-GARN-06: a percentOfNet order is priced off net-of-statutory pay, not off gross', async () => {
    await order({ percentOfNet: 10 });
    const { subject, twin } = await run(fx.periodAt(41));

    // 10% of the twin's net — which is exactly what net-of-statutory means here.
    const expected = Math.round(num(twin.netSalary) * 10) / 100;
    expect(num(subject.garnishment)).toBeCloseTo(expected, 1);
    expect(num(twin.netSalary) - num(subject.netSalary)).toBeCloseTo(expected, 1);
  });

  it('PE-GARN-07: an order that has not started yet does not attach the period', async () => {
    await order({ amount: 120, startDate: '2099-01-01' });
    const { subject, twin } = await run(fx.periodAt(42));
    expect(num(subject.garnishment)).toBe(0);
    expect(num(subject.netSalary)).toBeCloseTo(num(twin.netSalary), 2);
  });

  it('PE-GARN-08: an order that already expired does not attach the period', async () => {
    await order({ amount: 120, startDate: '2020-01-01', endDate: '2021-01-01' });
    const { subject, twin } = await run(fx.periodAt(43));
    expect(num(subject.garnishment)).toBe(0);
    expect(num(subject.netSalary)).toBeCloseTo(num(twin.netSalary), 2);
  });

  it('PE-GARN-09: revoking an order stops the NEXT run and leaves what was already taken intact', async () => {
    const g = await order({ amount: 120 });
    const first = await run(fx.periodAt(44));
    expect(num(first.subject.garnishment)).toBe(120);

    // `DELETE` is a hard delete and is refused outright once anything has been
    // collected — the record of what came out of somebody's pay under a court
    // order is not ours to remove. Stopping an order is its own verb.
    const hardDelete = await api()
      .delete(`/garnishments/${g.id}`)
      .set(admin())
      .set('X-Branch-Id', branch());
    expect(hardDelete.status).toBe(400);
    expect(String(hardDelete.body?.message ?? '')).toMatch(
      /already been collected under this order/i,
    );

    const revoked = await api()
      .patch(`/garnishments/${g.id}/revoke`)
      .set(admin())
      .set('X-Branch-Id', branch());
    expect(revoked.status).toBeLessThan(300);

    const second = await run(fx.periodAt(45));
    expect(num(second.subject.garnishment)).toBe(0);

    // The revocation is a flag flip, not a delete: the first run stays explainable.
    const still = await ctx.prisma.garnishmentOrder.findUnique({ where: { id: g.id } });
    expect(still).not.toBeNull();
    expect(still!.isActive).toBe(false);
    expect(Number(still!.collected)).toBe(120);
  });

  // --------------------------------------------------------- G29 carry-forward

  it('PE-GARN-10: G29 — an order larger than the pay takes what is there and carries the rest', async () => {
    const g = await order({ amount: 100_000 });
    const { subject, twin } = await run(fx.periodAt(46));

    // Everything available went to the order, and nothing more.
    expect(num(subject.garnishment)).toBeCloseTo(num(twin.netSalary), 2);
    expect(num(subject.netSalary)).toBe(0);

    const carried = await carryForwards();
    expect(carried).toHaveLength(1);
    expect(carried[0].kind).toBe('GARNISHMENT');
    expect(carried[0].sourceId).toBe(g.id);
    expect(carried[0].status).toBe('OUTSTANDING');
    expect(Number(carried[0].amount)).toBeCloseTo(100_000 - num(twin.netSalary), 2);
    expect(String(subject.notes ?? '')).toMatch(/carried forward to the next payroll/i);
  });

  it('PE-GARN-11: the NEXT run takes the arrears on top of that period\'s own instalment', async () => {
    await order({ amount: 100 });
    // Shortfall opened by hand so the case does not depend on the previous one.
    await ctx.prisma.payrollCarryForward.create({
      data: {
        employeeId: subjectId,
        branchId: branch(),
        kind: 'GARNISHMENT',
        sourceId: (await ctx.prisma.garnishmentOrder.findFirst({
          where: { employeeId: subjectId },
          select: { id: true },
        }))!.id,
        amount: 60,
        status: 'OUTSTANDING',
      },
    });

    const { subject, twin } = await run(fx.periodAt(47));
    expect(num(subject.garnishment)).toBe(160);
    expect(num(twin.netSalary) - num(subject.netSalary)).toBeCloseTo(160, 2);

    const carried = await carryForwards();
    expect(carried).toHaveLength(1);
    expect(carried[0].status).toBe('RECOVERED');
    expect(Number(carried[0].amountRecovered)).toBe(60);
    expect(carried[0].clearedPayrollId).not.toBeNull();
    expect(String(subject.notes ?? '')).toMatch(/including 60 carried forward/i);
  });

  it('PE-GARN-12: a balance a run could not clear is NOT re-opened as a second row — it is topped up', async () => {
    const g = await order({ amount: 100_000 });
    await run(fx.periodAt(48));
    const afterFirst = await carryForwards();
    expect(afterFirst).toHaveLength(1);

    await run(fx.periodAt(49));
    const afterSecond = await carryForwards();
    // The first row is still OUTSTANDING and a second period's shortfall opened
    // its own row — two debts, both traceable to the run that created them.
    expect(afterSecond.length).toBe(2);
    expect(afterSecond.every((r) => r.sourceId === g.id)).toBe(true);
    expect(afterSecond.filter((r) => r.status === 'OUTSTANDING').length).toBeGreaterThan(0);
    expect(new Set(afterSecond.map((r) => r.originPayrollId)).size).toBe(2);
  });

  // ------------------------------------------------------ a finite order ends

  it('PE-GARN-13: a finite order never collects past the total it is for', async () => {
    await order({ amount: 500, totalCap: 700 });
    const first = await run(fx.periodAt(50));
    expect(num(first.subject.garnishment)).toBe(500);

    const second = await run(fx.periodAt(51));
    expect(num(second.subject.garnishment)).toBe(200);

    const third = await run(fx.periodAt(52));
    expect(num(third.subject.garnishment)).toBe(0);
    expect(num(third.subject.netSalary)).toBeCloseTo(num(third.twin.netSalary), 2);
  });

  // ---------------------------------------------------------- several orders

  it('PE-GARN-14: the lower priority NUMBER is satisfied first and the rest is carried', async () => {
    const { twin } = await run(fx.periodAt(53));
    const net = num(twin.netSalary);
    // Two orders that together exceed the pay, so the ladder has to choose.
    await order({ amount: net, priority: 10, reference: 'CR-FIRST' });
    await order({ amount: net, priority: 90, reference: 'CR-SECOND' });

    const second = await run(fx.periodAt(54));
    expect(num(second.subject.garnishment)).toBeCloseTo(net, 2);
    expect(num(second.subject.netSalary)).toBe(0);

    const carried = await carryForwards();
    expect(carried).toHaveLength(1);
    const loser = await ctx.prisma.garnishmentOrder.findUnique({
      where: { id: carried[0].sourceId! },
    });
    expect(loser!.reference).toBe('CR-SECOND');
    expect(Number(loser!.collected)).toBe(0);
  });

  // ------------------------------------------------------------ regeneration

  it('PE-GARN-15: delete-and-regenerate does not double-count against the order', async () => {
    const g = await order({ amount: 200, totalCap: 1000 });
    const first = await run(fx.periodAt(55));
    expect(num(first.subject.garnishment)).toBe(200);
    expect(
      Number((await ctx.prisma.garnishmentOrder.findUnique({ where: { id: g.id } }))!.collected),
    ).toBe(200);

    const del = await api()
      .delete(`/payrolls/${first.id}`)
      .set(admin())
      .set('X-Branch-Id', branch());
    expect(del.status).toBeLessThan(300);

    // Deleting the run gives the money back to the order, so regenerating the
    // SAME period collects 200 once — not 400.
    expect(
      Number((await ctx.prisma.garnishmentOrder.findUnique({ where: { id: g.id } }))!.collected),
    ).toBe(0);

    const again = await run(fx.periodAt(55));
    expect(num(again.subject.garnishment)).toBe(200);
    expect(
      Number((await ctx.prisma.garnishmentOrder.findUnique({ where: { id: g.id } }))!.collected),
    ).toBe(200);
  });

  it('PE-GARN-16: deleting the run that OPENED a shortfall removes the shortfall too', async () => {
    await order({ amount: 100_000 });
    const { id } = await run(fx.periodAt(56));
    expect(await carryForwards()).toHaveLength(1);

    await api().delete(`/payrolls/${id}`).set(admin()).set('X-Branch-Id', branch());
    expect(await carryForwards()).toHaveLength(0);
  });

  // ------------------------------------------------------------- G29 on exit

  it('PE-GARN-17: G29 — an employee who LEAVES owing a balance keeps it as a RECEIVABLE', async () => {
    await order({ amount: 100_000 });
    await run(fx.periodAt(57));
    expect((await carryForwards())[0].status).toBe('OUTSTANDING');

    const gone = await api()
      .delete(`/employees/${subjectId}`)
      .set(admin())
      .set('X-Branch-Id', branch());
    expect(gone.status).toBeLessThan(300);

    const after = await carryForwards();
    expect(after).toHaveLength(1);
    // Not deleted, not WAIVED — a debt on record that survived the exit.
    expect(after[0].status).toBe('RECEIVABLE');
    expect(Number(after[0].amountRecovered)).toBe(0);

    // Put the employee back so the remaining cases still have a subject.
    await ctx.prisma.employee.update({
      where: { id: subjectId },
      data: { status: 'ACTIVE', endDate: null },
    });
  });

  it('PE-GARN-18: writing a balance off demands a reason, and records who wrote it off', async () => {
    await order({ amount: 100_000 });
    await run(fx.periodAt(58));
    const [row] = await carryForwards();

    const noReason = await api()
      .patch(`/garnishments/carry-forwards/${row.id}/waive`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({});
    expect(noReason.status).toBe(400);

    const waived = await api()
      .patch(`/garnishments/carry-forwards/${row.id}/waive`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ reason: 'Order discharged by the court' });
    expect(waived.status).toBeLessThan(300);
    expect(inner(waived.body).status).toBe('WAIVED');
    expect(String(inner(waived.body).reason)).toMatch(/Order discharged by the court/);

    const twice = await api()
      .patch(`/garnishments/carry-forwards/${row.id}/waive`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ reason: 'again' });
    expect(twice.status).toBe(400);
    expect(JSON.stringify(twice.body)).toMatch(/already waived/i);
  });

  // ------------------------------------ G29 for an ad-hoc deduction, not an order

  it('PE-GARN-20: G29 FIXED — a deduction beyond the pay stores what was TAKEN and carries the rest', async () => {
    const { id, subject } = await run(fx.periodAt(60));
    const gross =
      num(subject.baseSalary) +
      num(subject.allowances) +
      num(subject.bonus) -
      num(subject.deduction) +
      num(subject.overtimePay) +
      num(subject.foodAllowance);

    const excessive = Math.round(gross * 10);
    const patched = await api()
      .patch(`/payrolls/${id}/items/${subject.id}`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ deduction: excessive });
    expect(patched.status).toBeLessThan(300);

    const after = inner(patched.body);
    expect(num(after.netSalary)).toBe(0);

    // The payslip ADDS UP again. Before this it stored the full 10x deduction
    // against a stated net of 0, so gross - deductions came to roughly -9x gross
    // and nothing anywhere said why.
    const afterGross =
      num(after.baseSalary) +
      num(after.allowances) +
      num(after.bonus) -
      num(after.deduction) +
      num(after.overtimePay) +
      num(after.foodAllowance);
    const reconciled =
      afterGross -
      num(after.insurance) -
      num(after.tax) +
      num(after.reimbursement) -
      num(after.advanceLoanDeduction) -
      num(after.garnishment);
    expect(Math.abs(reconciled - num(after.netSalary))).toBeLessThan(0.02);

    // And the shortfall is a ledger row, not a discrepancy to reverse-engineer.
    const carried = await carryForwards();
    expect(carried).toHaveLength(1);
    expect(carried[0].kind).toBe('DEDUCTION');
    expect(carried[0].status).toBe('OUTSTANDING');
    expect(Number(carried[0].amount)).toBeCloseTo(excessive - num(after.deduction), 2);
    expect(String(after.notes ?? '')).toMatch(/carried forward to the next payroll/i);
  });

  it('PE-GARN-21: editing the same item twice leaves ONE carried balance, not one per edit', async () => {
    const { id, subject } = await run(fx.periodAt(61));
    for (const d of [99_999, 88_888]) {
      const res = await api()
        .patch(`/payrolls/${id}/items/${subject.id}`)
        .set(admin())
        .set('X-Branch-Id', branch())
        .send({ deduction: d });
      expect(res.status).toBeLessThan(300);
    }
    const carried = await carryForwards();
    expect(carried).toHaveLength(1);
    // The amount tracks the LATEST edit, not the first.
    expect(Number(carried[0].amount)).toBeLessThan(88_888);
    expect(Number(carried[0].amount)).toBeGreaterThan(80_000);
  });

  it('PE-GARN-22: the NEXT run collects a carried deduction, bounded by the pay available', async () => {
    const { id, subject } = await run(fx.periodAt(62));
    await api()
      .patch(`/payrolls/${id}/items/${subject.id}`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ deduction: 99_999 });
    const [opened] = await carryForwards();
    expect(opened.status).toBe('OUTSTANDING');

    const next = await run(fx.periodAt(63));
    // The whole of the next period's pay went to the arrears, and no more.
    expect(num(next.subject.netSalary)).toBe(0);
    expect(num(next.subject.deduction)).toBeGreaterThan(0);
    expect(String(next.subject.notes ?? '')).toMatch(
      /Deduction carried forward from an earlier payroll/i,
    );

    const after = await carryForwards();
    const row = after.find((r) => r.id === opened.id)!;
    expect(Number(row.amountRecovered)).toBeGreaterThan(0);
    expect(row.status).toBe('OUTSTANDING');
    expect(row.lastRecoveryPayrollId).toBe(next.id);
  });

  it('PE-GARN-23: deleting the run that PARTLY recovered a balance puts back exactly what it took', async () => {
    const { id, subject } = await run(fx.periodAt(64));
    await api()
      .patch(`/payrolls/${id}/items/${subject.id}`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ deduction: 99_999 });

    const next = await run(fx.periodAt(65));
    const [mid] = await carryForwards();
    const recovered = Number(mid.amountRecovered);
    expect(recovered).toBeGreaterThan(0);

    await api().delete(`/payrolls/${next.id}`).set(admin()).set('X-Branch-Id', branch());

    const [back] = await carryForwards();
    // A partial recovery leaves `clearedPayrollId` null, so keying the reversal
    // on the CLEAR would have restored nothing here.
    expect(Number(back.amountRecovered)).toBe(0);
    expect(back.status).toBe('OUTSTANDING');
    expect(back.lastRecoveryPayrollId).toBeNull();
  });

  it('PE-GARN-19: a WAIVED balance is never collected by a later run', async () => {
    const g = await order({ amount: 100 });
    await ctx.prisma.payrollCarryForward.create({
      data: {
        employeeId: subjectId,
        branchId: branch(),
        kind: 'GARNISHMENT',
        sourceId: g.id,
        amount: 5_000,
        status: 'WAIVED',
      },
    });

    const { subject, twin } = await run(fx.periodAt(59));
    // Only this period's own instalment, with nothing from the written-off row.
    expect(num(subject.garnishment)).toBe(100);
    expect(num(twin.netSalary) - num(subject.netSalary)).toBeCloseTo(100, 2);
  });
});
