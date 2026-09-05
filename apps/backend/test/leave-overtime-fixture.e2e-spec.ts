import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupLeaveOvertimeFixtures,
  LeaveOtFixtures,
  freeWindow,
  freeDate,
  freeDateOn,
  dayOfWeekUtc,
  LEAVE_YEAR,
} from './utils/leave-overtime-fixtures';
import { bearer } from './utils/settings';

/**
 * The fixture's own smoke test — WP-1's landing gate, not a coverage suite.
 *
 * It exists because every other spec in this module inherits whatever this file
 * gets wrong, and two of the things it must get right are invisible from a
 * passing suite:
 *
 *   - **`cleanup()` must be idempotent.** `RequestApproval` has no foreign key
 *     to anything and `LeaveAttachment` is outside `BRANCH_SCOPE`, so a mid-run
 *     failure leaves orphans that the next run's by-requestId delete cannot
 *     reach. `LOT-FIX-08` runs the teardown twice and asserts the second is a
 *     no-op rather than a throw.
 *
 *   - **`LeaveAttachmentsModule` is actually mounted** (WP-0). Until it was
 *     added to `test-app.module.ts` every request to
 *     `/leave-requests/:id/attachments` answered 404 rather than failing
 *     honestly — the same class of lie Phase 3 found with
 *     `AttendanceCorrectionsModule`. `LOT-FIX-07` is the assertion that the
 *     route exists at all; without it the whole attachment suite would report
 *     green-adjacent 404s forever.
 *
 * What it deliberately does NOT do: assert any product rule. Those belong to
 * the six module suites.
 */
describe('Leave & Overtime — fixture and harness (e2e)', () => {
  let ctx: E2EContext;
  let fx: LeaveOtFixtures;

  const body = (res: any) => JSON.stringify(res.body);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupLeaveOvertimeFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  describe('the window allocator', () => {
    it('LOT-FIX-01 free windows are contiguous and land in the reserved year', () => {
      const w = freeWindow(0, 3);
      expect(w.start).toBe(`${LEAVE_YEAR}-03-01`);
      expect(w.end).toBe(`${LEAVE_YEAR}-03-03`);
      expect(freeDate(0)).toBe(w.start);
    });

    it('LOT-FIX-02 two slots a stride apart never touch', () => {
      // The stride the specs use is lengthDays + 1, so an off-by-one in
      // getWorkDaysBetween cannot bridge two windows and turn a clean case into
      // an overlap 400 that reads exactly like a broken rule.
      const a = freeWindow(0, 3);
      const b = freeWindow(4, 3);
      expect(new Date(b.start).getTime()).toBeGreaterThan(
        new Date(a.end).getTime(),
      );
    });

    it('LOT-FIX-03 freeDateOn finds the requested weekday inside a week', () => {
      for (let weekday = 0; weekday < 7; weekday++) {
        const iso = freeDateOn(60, weekday);
        expect(dayOfWeekUtc(iso)).toBe(weekday);
      }
    });
  });

  describe('the actors', () => {
    it('LOT-FIX-04 every actor authenticates and carries the role it claims', async () => {
      const expected: Array<[string, string]> = [
        [fx.admin.token, 'ADMIN'],
        [fx.hr.token, 'HR_MANAGER'],
        [fx.scopedHr.token, 'HR_MANAGER'],
        [fx.mgr.token, 'MANAGER'],
        [fx.foreignMgr.token, 'MANAGER'],
        [fx.employee.token, 'EMPLOYEE'],
        [fx.otherEmployee.token, 'EMPLOYEE'],
        [fx.supervisor.token, 'EMPLOYEE'],
      ];
      for (const [token, role] of expected) {
        const res = await ctx.http().get('/auth/me').set(bearer(token));
        expect(res.status).toBe(200);
        expect(body(res)).toContain(role);
      }
    });

    it('LOT-FIX-05 the ADMIN has no linked employee, which is what makes the null-employee doors reachable', async () => {
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: fx.admin.userId },
      });
      expect(user.employeeId).toBeNull();
    });

    it('LOT-FIX-06 the supervisor holds role EMPLOYEE and supervises the chain requester', async () => {
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: fx.supervisor.userId },
      });
      expect(user.role).toBe('EMPLOYEE');
      const requester = await ctx.prisma.employee.findUniqueOrThrow({
        where: { id: fx.chainRequesterId },
      });
      expect(requester.supervisorId).toBe(fx.supervisorEmpId);
      const noSupervisor = await ctx.prisma.employee.findUniqueOrThrow({
        where: { id: fx.chainRequester2Id },
      });
      expect(noSupervisor.supervisorId).toBeNull();
    });
  });

  describe('the branches and the holidays they disagree about', () => {
    it('LOT-FIX-07 the two work weeks differ, so a rest day in one is a working day in the other', async () => {
      const main = await ctx.prisma.branch.findUniqueOrThrow({
        where: { id: fx.branchMain },
      });
      const alt = await ctx.prisma.branch.findUniqueOrThrow({
        where: { id: fx.branchAlt },
      });
      expect(main.weeklyOffDays).toBe('0,6');
      expect(alt.weeklyOffDays).toBe('4,5');
      // Saturday: a rest day in main, an ordinary working day in alt.
      const saturday = freeDateOn(80, 6);
      expect(main.weeklyOffDays!.split(',')).toContain('6');
      expect(alt.weeklyOffDays!.split(',')).not.toContain(
        String(dayOfWeekUtc(saturday)),
      );
    });

    it('LOT-FIX-08 the branch holiday falls on a Wednesday, so only the branch scope can explain a totalDays difference', () => {
      expect(dayOfWeekUtc(fx.mainHolidayDate)).toBe(3);
    });

    it('LOT-FIX-09 the company-wide holiday took a date nothing else owns', async () => {
      const clashes = await ctx.prisma.holiday.count({
        where: {
          branchId: null,
          date: new Date(`${fx.companyHolidayDate}T00:00:00.000Z`),
        },
      });
      expect(clashes).toBe(1);
    });
  });

  describe('the overtime policies', () => {
    it('LOT-FIX-10 every fixture policy is runId-tagged and none of them is the company default', async () => {
      const ids = [
        fx.policyTightCaps,
        fx.policyIneligible,
        fx.policyIgnoreHoliday,
        fx.policyBoundary,
        fx.policyByType,
      ];
      const rows = await ctx.prisma.overtimePolicy.findMany({
        where: { id: { in: ids } },
      });
      expect(rows).toHaveLength(5);
      for (const p of rows) {
        expect(p.name).toContain(fx.runId);
        expect(p.isDefault).toBe(false);
      }
    });

    it('LOT-FIX-11 withPolicyRules refuses a policy the fixture does not own', async () => {
      const companyDefault = await ctx.prisma.overtimePolicy.findFirst({
        where: { isDefault: true },
      });
      if (!companyDefault) {
        // Nothing to protect against on a database that has no default yet.
        return;
      }
      await expect(
        fx.withPolicyRules(companyDefault.id, { maxHoursPerDay: 1 }, async () =>
          undefined,
        ),
      ).rejects.toThrow(/refuses a policy this fixture does not own/);
      const after = await ctx.prisma.overtimePolicy.findUniqueOrThrow({
        where: { id: companyDefault.id },
      });
      expect(after.rules).toEqual(companyDefault.rules);
    });

    it('LOT-FIX-12 withPolicyRules restores the blob even when the body throws', async () => {
      const before = await ctx.prisma.overtimePolicy.findUniqueOrThrow({
        where: { id: fx.policyTightCaps },
      });
      await expect(
        fx.withPolicyRules(fx.policyTightCaps, { maxHoursPerDay: 99 }, async () => {
          const during = await ctx.prisma.overtimePolicy.findUniqueOrThrow({
            where: { id: fx.policyTightCaps },
          });
          expect((during.rules as any).maxHoursPerDay).toBe(99);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const after = await ctx.prisma.overtimePolicy.findUniqueOrThrow({
        where: { id: fx.policyTightCaps },
      });
      expect((after.rules as any).maxHoursPerDay).toBe(
        (before.rules as any).maxHoursPerDay,
      );
    });
  });

  describe('withWorkflow, which touches shared environment configuration', () => {
    it('LOT-FIX-13 installs a chain, then reactivates whatever it displaced', async () => {
      const activeBefore = await ctx.prisma.approvalWorkflow.findMany({
        where: { requestType: 'LEAVE', isActive: true },
        select: { id: true },
      });

      await fx.withWorkflow(
        { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
        async () => {
          const during = await ctx.prisma.approvalWorkflow.findMany({
            where: { requestType: 'LEAVE', isActive: true },
            include: { steps: true },
          });
          expect(during).toHaveLength(1);
          expect(during[0].name).toContain(fx.runId);
          expect(
            during[0].steps
              .sort((a, b) => a.stepOrder - b.stepOrder)
              .map((s) => s.approverType),
          ).toEqual(['SUPERVISOR', 'HR_MANAGER']);
        },
      );

      const activeAfter = await ctx.prisma.approvalWorkflow.findMany({
        where: { requestType: 'LEAVE', isActive: true },
        select: { id: true },
      });
      expect(activeAfter.map((w) => w.id).sort()).toEqual(
        activeBefore.map((w) => w.id).sort(),
      );
      // And the one it created is gone, steps and all.
      const leaked = await ctx.prisma.approvalWorkflow.count({
        where: { name: { contains: fx.runId } },
      });
      expect(leaked).toBe(0);
    });
  });

  describe('the seed helpers', () => {
    it('LOT-FIX-14 seedLeave writes a row bypassing create() validation', async () => {
      const w = freeWindow(790, 3);
      const id = await fx.seedLeave({
        employeeId: fx.applicantId,
        start: w.start,
        end: w.end,
        status: 'APPROVED',
      });
      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('APPROVED');
      expect(row.totalDays).toBe(3);
      await ctx.prisma.leaveRequest.delete({ where: { id } });
    });

    it('LOT-FIX-15 seedOvertime writes a row with a real window', async () => {
      const id = await fx.seedOvertime({
        employeeId: fx.otStaffId,
        date: freeDate(795),
        hours: 2,
      });
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(Number(row.hours)).toBe(2);
      expect(row.status).toBe('PENDING');
      await ctx.prisma.overtimeRequest.delete({ where: { id } });
    });

    it('LOT-FIX-16 resetBalances clears both balance models for that employee and year', async () => {
      await fx.setBalance(fx.balanceStaffId, 'Annual Leave', 7);
      expect(
        await ctx.prisma.leaveTypeBalance.count({
          where: { employeeId: fx.balanceStaffId, year: LEAVE_YEAR },
        }),
      ).toBeGreaterThan(0);
      await fx.resetBalances(fx.balanceStaffId);
      expect(
        await ctx.prisma.leaveTypeBalance.count({
          where: { employeeId: fx.balanceStaffId, year: LEAVE_YEAR },
        }),
      ).toBe(0);
      expect(
        await ctx.prisma.leaveBalance.count({
          where: { employeeId: fx.balanceStaffId, year: LEAVE_YEAR },
        }),
      ).toBe(0);
    });
  });

  describe('WP-0 — the module that was never mounted', () => {
    it('LOT-FIX-17 /leave-requests/:id/attachments is routed, so a refusal is a refusal and not a 404', async () => {
      const w = freeWindow(797, 1);
      const leaveId = await fx.seedLeave({
        employeeId: fx.attachStaffId,
        start: w.start,
        end: w.end,
      });
      try {
        const res = await ctx
          .http()
          .get(`/leave-requests/${leaveId}/attachments`)
          .set(bearer(fx.hr.token));
        // The assertion is the ROUTE, not the rule: before WP-0 this answered
        // 404 for every id, which is indistinguishable from "no such request".
        expect(res.status).toBe(200);
        expect(res.body?.data).toEqual([]);

        // And the unauthenticated door still answers 401 rather than 404 —
        // which is what proves the 200 above came from the guard chain running,
        // not from a route that happens to exist unguarded.
        const anon = await ctx
          .http()
          .get(`/leave-requests/${leaveId}/attachments`);
        expect(anon.status).toBe(401);
      } finally {
        await ctx.prisma.leaveRequest.delete({ where: { id: leaveId } });
      }
    });
  });

  describe('teardown', () => {
    it('LOT-FIX-18 cleanup() is idempotent — running it twice is a no-op, not a throw', async () => {
      // The real cleanup runs in afterAll. This proves the SECOND run survives,
      // which is the case a mid-run failure produces: orphaned RequestApproval
      // and LeaveAttachment rows that a by-requestId delete can no longer see.
      await fx.cleanup();
      await expect(fx.cleanup()).resolves.toBeUndefined();

      const employeesLeft = await ctx.prisma.employee.count({
        where: { employeeCode: { contains: fx.runId } },
      });
      expect(employeesLeft).toBe(0);
      const branchesLeft = await ctx.prisma.branch.count({
        where: { code: { contains: fx.runId } },
      });
      expect(branchesLeft).toBe(0);
      const policiesLeft = await ctx.prisma.overtimePolicy.count({
        where: { name: { contains: fx.runId } },
      });
      expect(policiesLeft).toBe(0);
      const typesLeft = await ctx.prisma.libraryItem.count({
        where: { label: { contains: fx.runId } },
      });
      expect(typesLeft).toBe(0);
      const holidaysLeft = await ctx.prisma.holiday.count({
        where: { description: { contains: fx.runId } },
      });
      expect(holidaysLeft).toBe(0);
    });
  });
});
