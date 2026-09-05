import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';

/**
 * `PE-CONC` — two payroll administrators acting at once.
 *
 * The lifecycle's write points are not equally guarded, and the asymmetry is
 * what these cases pin:
 *
 *   • **generate** — a real uniqueness index (an EXPRESSION index over
 *     `COALESCE(...)`, which `prisma db push` cannot create; Phase 4's F30 found
 *     the e2e template had none at all, so a period could be paid twice)
 *   • **lock** — an optimistic guard; the loser gets a sentence naming the state
 *   • **unlock** — reverses exactly once, which matters because a second
 *     reversal would credit the employee twice
 *   • **approve** — was a read-then-write and both callers succeeded (G35); now
 *     conditional in the database
 *
 * Race outcomes are never asserted directly — which caller wins is a timing
 * detail, and a test that asserts it is a flake by construction. What is
 * asserted is the INVARIANT that must hold whichever way the race falls.
 */
describe('Payroll edge — concurrency (PE-CONC)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;

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

  const makeRun = async (period: { month: number; year: number }) => {
    await openPeriod(fx.fullMonthEmpId, period);
    const created = await api()
      .post('/payrolls')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ month: period.month, year: period.year, employeeIds: [fx.fullMonthEmpId] });
    return created.body?.data?.id ?? created.body?.id;
  };

  const post = (id: string, action: string, body: Record<string, unknown> = {}) =>
    api().post(`/payrolls/${id}/${action}`).set(admin()).set('X-Branch-Id', branch()).send(body);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  it('PE-CONC-01: two simultaneous approvals leave one approval on record', async () => {
    const id = await makeRun(fx.periodAt(30));
    await post(id, 'submit');

    const [a, b] = await Promise.all([post(id, 'approve'), post(id, 'approve')]);
    const ok = [a, b].filter((r) => r.status < 400);
    const refused = [a, b].filter((r) => r.status >= 400);

    // Exactly one claims it. Before G35's fix both did, and two people each held
    // a success receipt for an approval only one is recorded as performing.
    expect(ok.length).toBe(1);
    expect(refused.length).toBe(1);

    // TWO refusal paths, both correct, and which fires is timing: a slow race is
    // caught by the status READ at the top (400), a fast one by the conditional
    // update (409). What must hold is that the loser is told, in words.
    const msg = String(refused[0].body?.message ?? '');
    expect(msg).toMatch(
      /no longer awaiting approval|approved or changed concurrently|can only approve payroll in PENDING_APPROVAL/i,
    );
    expect(msg).not.toMatch(/could not be completed|invalid input|something went wrong/i);

    const row = await ctx.prisma.payroll.findUnique({
      where: { id },
      select: { status: true, approvedBy: true, approvedAt: true },
    });
    expect(row!.status).toBe('APPROVED');
    expect(row!.approvedBy).toBeTruthy();
    expect(row!.approvedAt).toBeTruthy();
  });

  it('PE-CONC-02: two simultaneous locks settle the money exactly once', async () => {
    // G14: Phase 4's `PL-API-24` asserted the loser answers 400 and it answers
    // 409. Both are refusals and the money invariant it exists to protect was
    // never what failed — only the status code. This case asserts the invariant
    // and accepts either refusal.
    const id = await makeRun(fx.periodAt(31));
    await post(id, 'submit');
    await post(id, 'approve');

    const before = await ctx.prisma.payrollItem.findMany({
      where: { payrollId: id },
      select: { employeeId: true, netSalary: true },
    });

    const [a, b] = await Promise.all([post(id, 'lock'), post(id, 'lock')]);
    const ok = [a, b].filter((r) => r.status < 400);
    const refused = [a, b].filter((r) => r.status >= 400);

    expect(ok.length).toBe(1);
    expect(refused.length).toBe(1);
    expect(refused[0].status).toBeGreaterThanOrEqual(400);
    expect(String(refused[0].body?.message ?? '')).toMatch(
      /no longer in a lockable state|locked or changed concurrently/i,
    );

    const after = await ctx.prisma.payrollItem.findMany({
      where: { payrollId: id },
      select: { employeeId: true, netSalary: true },
    });
    expect(after.length).toBe(before.length);
    expect(Number(after[0].netSalary)).toBe(Number(before[0].netSalary));

    const row = await ctx.prisma.payroll.findUnique({
      where: { id },
      select: { status: true, unlockCount: true },
    });
    expect(row!.status).toBe('LOCKED');
    expect(row!.unlockCount).toBe(0);
  });

  it('PE-CONC-03: two simultaneous unlocks reverse the run exactly once', async () => {
    // Unlock is compensating: it reverses recoveries and restores balances.
    // Applying it twice would credit the employee twice.
    const id = await makeRun(fx.periodAt(32));
    await post(id, 'submit');
    await post(id, 'approve');
    await post(id, 'lock');

    const reason = 'PE-CONC-03: simultaneous reversal probe';
    await Promise.all([
      post(id, 'unlock', { reason }),
      post(id, 'unlock', { reason }),
    ]);

    const row = await ctx.prisma.payroll.findUnique({
      where: { id },
      select: { status: true, unlockCount: true, lockedAt: true },
    });
    expect(row!.unlockCount).toBe(1);
    expect(row!.status).toBe('APPROVED');
    // And the lock it reversed is still on the record (G34).
    expect(row!.lockedAt).toBeTruthy();
  });

  it('PE-CONC-04: two simultaneous creates leave exactly one run', async () => {
    const period = fx.periodAt(33);
    await openPeriod(fx.fullMonthEmpId, period);

    const body = {
      month: period.month,
      year: period.year,
      employeeIds: [fx.fullMonthEmpId],
    };
    const send = () =>
      api().post('/payrolls').set(admin()).set('X-Branch-Id', branch()).send(body);

    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()[0]).toBe(201);
    expect([a.status, b.status].sort()[1]).toBeGreaterThanOrEqual(400);

    const rows = await ctx.prisma.payroll.count({
      where: { month: period.month, year: period.year, branchId: branch() },
    });
    expect(rows).toBe(1);
  });
});
