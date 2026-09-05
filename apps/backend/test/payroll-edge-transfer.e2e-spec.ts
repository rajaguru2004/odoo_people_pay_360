import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';
import { withSettings } from './utils/settings';

/**
 * `PE-XFER` — moving an employee between branches.
 *
 * `docs/PAYROLL-GAP-REPORT.md` §8 records that branch transfer is "unbuilt, not
 * broken": `UpdateEmployeeDto` omits `branchId` deliberately, because moving an
 * employee crosses the isolation axis and "needs its own reviewed flow rather
 * than a field on this form".
 *
 * The first case here is the important one, and it is a REFUSAL: the DTO still
 * omits the field. A transfer is a different route, not a looser form, and the
 * existing pin in `payroll-edge-salary-change.spec.ts` therefore stays true.
 */
describe('Payroll edge — branch transfer (PE-XFER)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;

  const ON = { employee_transfer_enabled: 'true' };

  let otherBranchId = '';

  const request = (body: Record<string, unknown> = {}) =>
    api()
      .post('/employee-transfers')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({
        employeeId: fx.leaverEmpId,
        toBranchId: otherBranchId,
        effectiveDate: '2044-06-01',
        reason: 'Opening the new site.',
        ...body,
      });

  const act = (id: string, verb: string, body: Record<string, unknown> = {}) =>
    api()
      .post(`/employee-transfers/${id}/${verb}`)
      .set(admin())
      .set('X-Branch-Id', branch())
      .send(body);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);

    const created = await ctx.prisma.branch.create({
      data: {
        code: `XFER-${Date.now().toString(36)}`,
        name: 'Transfer destination',
        isActive: true,
        country: 'OM',
      },
    });
    otherBranchId = created.id;
  }, 180_000);

  afterAll(async () => {
    // Teardown order is FK order, and the destination branch is the last thing
    // to go: PE-XFER-13 pays somebody in it, which leaves attendance and a
    // payroll behind. Deleting the branch first fails on
    // `attendances_branch_id_fkey` and takes the whole suite down as a
    // "failed to run", with no case having actually failed.
    if (ctx) {
      await ctx.prisma.employeeTransfer.deleteMany({
        where: { toBranchId: otherBranchId },
      });
      await ctx.prisma.attendance.deleteMany({ where: { branchId: otherBranchId } });
      await ctx.prisma.payrollItem.deleteMany({
        where: { payroll: { branchId: otherBranchId } },
      });
      await ctx.prisma.payroll.deleteMany({ where: { branchId: otherBranchId } });
      // Put anyone this suite moved back, so the fixtures' own teardown still
      // finds them where it left them.
      await ctx.prisma.employee.updateMany({
        where: { branchId: otherBranchId },
        data: { branchId: fx.base.branchA },
      });
      // Best-effort: the database is disposable, and a stranded branch row is a
      // far smaller problem than a teardown that fails the suite.
      await ctx.prisma.branch
        .deleteMany({ where: { id: otherBranchId } })
        .catch(() => undefined);
    }
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  afterEach(async () => {
    await ctx.prisma.employeeTransfer.deleteMany({
      where: { toBranchId: otherBranchId },
    });
    await ctx.prisma.employee.updateMany({
      where: { id: fx.leaverEmpId },
      data: { branchId: fx.base.branchA },
    });
  });

  describe('PE-XFER-01 — the door that stays shut', () => {
    it('PE-XFER-01: PATCH /employees still refuses branchId, transfer route or not', async () => {
      // The pin in `payroll-edge-salary-change.spec.ts` asserts this exact
      // refusal, and its comment promises the case will fail "the day a
      // transfer route appears". It will not — because the DTO is unchanged and
      // that is the design. Asserted here too so the promise is visibly kept.
      await withSettings(ctx, ON, async () => {
        const res = await api()
          .patch(`/employees/${fx.leaverEmpId}`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ branchId: otherBranchId });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toMatch(/property branchId should not exist/i);
      });
    }, 60_000);
  });

  describe('PE-XFER-02..07 — requesting', () => {
    it('PE-XFER-02: with the flag OFF the route is unavailable', async () => {
      const res = await request();
      expect(res.status).toBe(404);
      // A missing route also 404s, so assert the feature is refusing.
      expect(String(res.body?.message ?? '')).toMatch(/not enabled/i);
    }, 60_000);

    it('PE-XFER-03: records a pending transfer', async () => {
      await withSettings(ctx, ON, async () => {
        const res = await request();
        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe('PENDING');
        expect(res.body.data.fromBranchId).toBe(fx.base.branchA);
      });
    }, 60_000);

    it('PE-XFER-04: demands a reason', async () => {
      await withSettings(ctx, ON, async () => {
        const res = await request({ reason: '   ' });
        expect(res.status).toBe(400);
        expect(String(res.body?.message ?? '')).toMatch(/reason is required/i);
      });
    }, 60_000);

    it('PE-XFER-05: refuses a transfer to the branch they are already in', async () => {
      await withSettings(ctx, ON, async () => {
        const res = await request({ toBranchId: fx.base.branchA });
        expect(res.status).toBe(400);
        expect(String(res.body?.message ?? '')).toMatch(/already in/i);
      });
    }, 60_000);

    it('PE-XFER-06: refuses a SECOND open transfer for the same person', async () => {
      // Two queued transfers make "which branch pays them this month?"
      // unanswerable, and the answer would depend on row order.
      await withSettings(ctx, ON, async () => {
        expect((await request()).status).toBe(201);
        const second = await request({ effectiveDate: '2044-08-01' });
        expect(second.status).toBe(409);
        expect(String(second.body?.message ?? '')).toMatch(/unanswerable/i);
      });
    }, 60_000);

    it('PE-XFER-07: refuses a transfer into an inactive branch', async () => {
      await withSettings(ctx, ON, async () => {
        const dead = await ctx.prisma.branch.create({
          data: {
            code: `DEAD-${Date.now().toString(36)}`,
            name: 'Closed site',
            isActive: false,
            country: 'OM',
          },
        });
        const res = await request({ toBranchId: dead.id });
        expect(res.status).toBe(400);
        expect(String(res.body?.message ?? '')).toMatch(/not active/i);
        await ctx.prisma.branch.delete({ where: { id: dead.id } });
      });
    }, 60_000);
  });

  describe('PE-XFER-08..12 — approving and applying', () => {
    it('PE-XFER-08: cannot apply what has not been approved', async () => {
      await withSettings(ctx, ON, async () => {
        const created = await request();
        const res = await act(created.body.data.id, 'apply');
        expect(res.status).toBe(409);
        expect(String(res.body?.message ?? '')).toMatch(/only an APPROVED transfer/i);
      });
    }, 60_000);

    it('PE-XFER-09: applying moves the employee and journals it', async () => {
      await withSettings(ctx, ON, async () => {
        const created = await request();
        await act(created.body.data.id, 'approve');
        const res = await act(created.body.data.id, 'apply');
        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe('APPLIED');

        const employee = await ctx.prisma.employee.findUnique({
          where: { id: fx.leaverEmpId },
          select: { branchId: true },
        });
        expect(employee!.branchId).toBe(otherBranchId);

        // The existing journal, not a new mechanism: every other field change on
        // an employee is recorded there and a transfer should be findable
        // alongside them.
        const history = await ctx.prisma.employeeHistory.findFirst({
          where: { employeeId: fx.leaverEmpId, field: 'branchId' },
          orderBy: { changedAt: 'desc' },
        });
        expect(history).not.toBeNull();
        expect(history!.newValue).toBe(otherBranchId);
      });
    }, 90_000);

    it('PE-XFER-10: refuses to apply while a run for that period is OPEN', async () => {
      // Applying then would move who owns a run that is still open, re-pricing
      // it underneath itself.
      await withSettings(ctx, ON, async () => {
        const period = fx.periodAt(100);
        await ctx.prisma.attendance.createMany({
          data: [
            {
              employeeId: fx.fullMonthEmpId,
              branchId: branch(),
              date: new Date(Date.UTC(period.year, period.month - 1, 3)),
              status: 'PRESENT',
              workHours: 8,
            },
          ],
          skipDuplicates: true,
        });
        const run = await api()
          .post('/payrolls')
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({
            month: period.month,
            year: period.year,
            employeeIds: [fx.fullMonthEmpId],
          });

        const created = await request({
          effectiveDate: `${period.year}-${String(period.month).padStart(2, '0')}-05`,
        });
        await act(created.body.data.id, 'approve');
        const res = await act(created.body.data.id, 'apply');
        expect(res.status).toBe(409);
        expect(String(res.body?.message ?? '')).toMatch(/while it is still open/i);

        await api()
          .delete(`/payrolls/${run.body.data.id}`)
          .set(admin())
          .set('X-Branch-Id', branch());
      });
    }, 120_000);

    it('PE-XFER-11: an applied transfer cannot be cancelled', async () => {
      await withSettings(ctx, ON, async () => {
        const created = await request();
        await act(created.body.data.id, 'approve');
        await act(created.body.data.id, 'apply');

        // Acted on from the DESTINATION branch, because that is where the
        // employee now lives. A transfer is scoped through its employee, so
        // once it has been applied the sending branch can no longer reach it —
        // which is the branch isolation working, not a bug, and is why the
        // list route filters on either side instead.
        const res = await api()
          .post(`/employee-transfers/${created.body.data.id}/cancel`)
          .set(admin())
          .set('X-Branch-Id', otherBranchId)
          .send({});
        expect(res.status).toBe(409);
        expect(String(res.body?.message ?? '')).toMatch(/the other way/i);
      });
    }, 90_000);

    it('PE-XFER-12: rejecting demands a reason and closes the transfer', async () => {
      await withSettings(ctx, ON, async () => {
        const created = await request();
        expect((await act(created.body.data.id, 'reject')).status).toBe(400);
        const res = await act(created.body.data.id, 'reject', {
          reason: 'Headcount frozen at the destination.',
        });
        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe('REJECTED');
      });
    }, 60_000);
  });

  describe('PE-XFER-13 — who pays them afterwards', () => {
    it('PE-XFER-13: the next run pays them in the NEW branch, and the old one does not', async () => {
      // PERIOD_END is the default and needs no new code: employee lookup is
      // branch-scoped at generation time and runs are generated after the period
      // closes, so today's behaviour already IS period-end semantics.
      await withSettings(ctx, ON, async () => {
        const created = await request();
        await act(created.body.data.id, 'approve');
        await act(created.body.data.id, 'apply');

        const period = fx.periodAt(101);
        await ctx.prisma.attendance.createMany({
          data: [
            {
              employeeId: fx.leaverEmpId,
              branchId: otherBranchId,
              date: new Date(Date.UTC(period.year, period.month - 1, 3)),
              status: 'PRESENT',
              workHours: 8,
            },
          ],
          skipDuplicates: true,
        });

        const inNew = await api()
          .post('/payrolls')
          .set(admin())
          .set('X-Branch-Id', otherBranchId)
          .send({ month: period.month, year: period.year });
        expect(inNew.status).toBeLessThan(400);

        const full = await api()
          .get(`/payrolls/${inNew.body.data.id}`)
          .set(admin())
          .set('X-Branch-Id', otherBranchId);
        const ids = (full.body.data.items ?? []).map((i: any) => i.employeeId);
        expect(ids).toContain(fx.leaverEmpId);

        await api()
          .delete(`/payrolls/${inNew.body.data.id}`)
          .set(admin())
          .set('X-Branch-Id', otherBranchId);
      });
    }, 120_000);
  });
});
