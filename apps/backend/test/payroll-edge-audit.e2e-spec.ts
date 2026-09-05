import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';

/**
 * `PE-AUD` — the payroll audit trail, at the API.
 *
 * The catalogue asks for an immutable record of every payroll action naming
 * user, timestamp, before/after values and an approval reference. Before this
 * phase that could not pass: `PayrollsService` made no `AuditService.log()`
 * calls at all, so every transition arrived through the global
 * `AuditInterceptor` as `action: 'CREATE'` (derived from the HTTP verb), and no
 * row carried both sides of a change.
 *
 * Now each transition records its own verb with both sides. These cases assert
 * that, and — as importantly — that the LOCK survives a reversal, because
 * locking is the transition that moves money and unlocking used to erase it.
 */
describe('Payroll edge — the audit trail (PE-AUD)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;

  let payrollId = '';

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);

    const created = await api()
      .post('/payrolls')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({
        month: fx.period.month,
        year: fx.period.year,
        employeeIds: [fx.fullMonthEmpId],
      });
    payrollId = created.body?.data?.id ?? created.body?.id;

    // Drive the whole lifecycle once, including a reversal.
    await api().post(`/payrolls/${payrollId}/submit`).set(admin()).set('X-Branch-Id', branch()).send({});
    await api().post(`/payrolls/${payrollId}/approve`).set(admin()).set('X-Branch-Id', branch()).send({});
    await api().post(`/payrolls/${payrollId}/lock`).set(admin()).set('X-Branch-Id', branch()).send({});
    await api()
      .post(`/payrolls/${payrollId}/unlock`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ reason: 'PE-AUD: reversing to inspect the trail' });
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  /** Payroll-written rows for this run, oldest first. */
  const namedRows = async () => {
    const rows = await ctx.prisma.auditLog.findMany({
      where: { resourceType: 'Payroll', resourceId: payrollId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.filter((r: any) => String(r.action).startsWith('PAYROLL_'));
  };

  it('PE-AUD-01: every transition is recorded under its own verb, in order', async () => {
    const actions = (await namedRows()).map((r: any) => r.action);
    expect(actions).toEqual([
      'PAYROLL_SUBMITTED',
      'PAYROLL_APPROVED',
      'PAYROLL_LOCKED',
      'PAYROLL_UNLOCKED',
    ]);
  });

  it('PE-AUD-02: each row names the actor, the time and the branch', async () => {
    for (const r of await namedRows()) {
      expect(r.userId).toBeTruthy();
      expect(r.createdAt).toBeTruthy();
      expect(r.branchId).toBe(branch());
      expect(r.resourceId).toBe(payrollId);
    }
  });

  it('PE-AUD-03: a row carries BOTH sides of the change', async () => {
    // The compliance requirement is before/after VALUES. Previously a row had one
    // or the other — 47 of 126 rows carried a pre-image and 79 a post-image, none
    // both — so no single row showed a transition.
    for (const r of await namedRows()) {
      const before = (r.oldData ?? {}) as Record<string, unknown>;
      const after = (r.newData ?? {}) as Record<string, unknown>;
      expect(before.status).toBeTruthy();
      expect(after.status).toBeTruthy();
    }
  });

  it('PE-AUD-04: the reason a run was reversed is on the record', async () => {
    const unlock = (await namedRows()).find((r: any) => r.action === 'PAYROLL_UNLOCKED')!;
    const after = (unlock.newData ?? {}) as Record<string, unknown>;
    expect(String(after.unlockReason ?? '')).toMatch(/reversing to inspect the trail/i);
  });

  it('PE-AUD-05: the LOCK survives the reversal in the run history', async () => {
    // Locking settles reimbursements and writes the loan ledger. `unlockPayroll`
    // used to null `lockedAt`, and `getApprovalHistory()` derives its LOCKED step
    // from that column — so a reversal erased the evidence that money had moved.
    const res = await api()
      .get(`/payrolls/${payrollId}/history`)
      .set(admin())
      .set('X-Branch-Id', branch());
    const steps = (res.body?.data?.history ?? []).map((h: any) => h.action);

    expect(steps).toContain('LOCKED');
    expect(steps).toContain('UNLOCKED');
    expect(steps.indexOf('UNLOCKED')).toBeGreaterThan(steps.indexOf('LOCKED'));
  });

  it('PE-AUD-06: the lock timestamp itself is not erased', async () => {
    const row = await ctx.prisma.payroll.findUnique({
      where: { id: payrollId },
      select: { lockedAt: true, unlockCount: true, status: true },
    });
    expect(row!.lockedAt).toBeTruthy();
    expect(row!.unlockCount).toBe(1);
    expect(row!.status).toBe('APPROVED');
  });

  it('PE-AUD-07: a rejection records its reason under its own verb', async () => {
    const period = fx.periodAt(2);
    await ctx.prisma.attendance.createMany({
      data: [
        {
          employeeId: fx.fullMonthEmpId,
          branchId: branch(),
          date: new Date(Date.UTC(period.year, period.month - 1, 4)),
          status: 'PRESENT',
          workHours: 8,
        },
      ],
      skipDuplicates: true,
    });

    const created = await api()
      .post('/payrolls')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ month: period.month, year: period.year, employeeIds: [fx.fullMonthEmpId] });
    const id = created.body?.data?.id ?? created.body?.id;

    await api().post(`/payrolls/${id}/submit`).set(admin()).set('X-Branch-Id', branch()).send({});
    const REASON = 'PE-AUD-07: overtime hours were wrong for one employee';
    await api()
      .post(`/payrolls/${id}/reject`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ reason: REASON });

    const rows = await ctx.prisma.auditLog.findMany({
      where: { resourceType: 'Payroll', resourceId: id, action: 'PAYROLL_REJECTED' },
    });
    expect(rows.length).toBe(1);
    expect(String((rows[0].newData as any)?.rejectionReason ?? '')).toBe(REASON);
  });
});
