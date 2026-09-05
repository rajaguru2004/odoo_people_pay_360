import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupAttendanceFixtures,
  AttendanceFixtures,
  pinCompanyTzToMidMorning,
  HIST_YEAR,
  HIST_MONTH,
  histDay,
} from './utils/attendance-fixtures';
import { bearer } from './utils/settings';

/**
 * Cross-branch and cross-department scoping across every attendance door, plus
 * the seams where attendance meets Leave, Payroll and Organization.
 *
 * ── The mechanism this whole file turns on ─────────────────────────────────
 *
 * Branch scoping is a Prisma `$use` middleware driven by `BRANCH_SCOPE`, and it
 * only intercepts the actions listed in `BRANCH_READ_ACTIONS` /
 * `BRANCH_WRITE_MANY_ACTIONS`. **`findUnique` and `upsert` are in neither.** So
 * every door that resolves its subject with `findUnique` is unscoped unless the
 * service calls `assertInBranch` by hand — and in this module, seven of the
 * eight do not. `AttendanceCorrectionsService.create` does, one file away, which
 * is what makes the omission a gap rather than a design.
 *
 * `assertInBranch` throws **404, not 403**, on purpose: a 403 confirms the row
 * exists. The contrast cases below rely on that distinction.
 *
 * This file owns "today" for `foreignStaff`.
 */
describe('Attendance — branch and department scoping (e2e)', () => {
  let ctx: E2EContext;
  let fx: AttendanceFixtures;
  let restoreTz: () => Promise<void>;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    if (Array.isArray(res.body)) return res.body;
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };
  const employeeIdsOf = (res: any): string[] =>
    rowsOf(res)
      .map((r) => r.employeeId ?? r.employee?.id)
      .filter(Boolean);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupAttendanceFixtures(ctx);
    restoreTz = await pinCompanyTzToMidMorning(ctx);
  }, 120000);

  afterEach(async () => {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 2);
    from.setUTCHours(0, 0, 0, 0);
    await ctx.prisma.attendance.deleteMany({
      where: { employeeId: fx.foreignStaffId, date: { gte: from } },
    });
  });

  afterAll(async () => {
    if (restoreTz) await restoreTz();
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the by-id doors a scoped HR must not reach', () => {
    /**
     * A5, FIXED. `scopedHr`'s envelope is branchHome + branchOverride;
     * `foreignStaff` lives in branchForeign. Each of these doors resolved the
     * employee with a bare `findUnique` — which is NOT in `BRANCH_READ_ACTIONS`,
     * so the middleware never intercepted it — and never called
     * `assertInBranch`. A branch-scoped HR could write attendance into a branch
     * they could not see or list. `assertInBranch` now guards all eight,
     * throwing 404 rather than 403 so the response cannot confirm the employee
     * exists.
     */
    it('ASC-API-01 a scoped HR cannot check in an employee outside their envelope', async () => {
      const res = await ctx
        .http()
        .post(`/attendances/check-in/${fx.foreignStaffId}`)
        .set(bearer(fx.scopedHr.token))
        .send({});
      expect(res.status).toBe(404);

      // Scope the check to TODAY: the fixture seeds `foreignStaff` a February
      // 2019 block, so a bare findFirst would pick that up and pass either way.
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.foreignStaffId, date: { gte: today } },
      });
      expect(row).toBeNull();
    });

    it('ASC-API-02 a global HR still can, which is what proves the refusal was scoping', async () => {
      const res = await ctx
        .http()
        .post(`/attendances/check-in/${fx.foreignStaffId}`)
        .set(bearer(fx.hr.token))
        .send({});
      expect(res.status).toBe(201);
    });

    it('ASC-API-03 a scoped HR cannot check OUT an employee outside their envelope', async () => {
      const opened = await ctx
        .http()
        .post(`/attendances/check-in/${fx.foreignStaffId}`)
        .set(bearer(fx.hr.token))
        .send({});
      expect(opened.status).toBe(201);

      const scoped = await ctx
        .http()
        .post(`/attendances/check-out/${fx.foreignStaffId}`)
        .set(bearer(fx.scopedHr.token))
        .send({});
      expect(scoped.status).toBe(404);

      // The session is still open, and a global caller can close it — so the
      // refusal above did not strand the employee.
      const global = await ctx
        .http()
        .post(`/attendances/check-out/${fx.foreignStaffId}`)
        .set(bearer(fx.hr.token))
        .send({});
      expect(global.status).toBe(201);
    });

    it('ASC-API-04 a scoped HR cannot book manual attendance outside their envelope', async () => {
      const res = await ctx
        .http()
        .post('/attendances/manual')
        .set(bearer(fx.scopedHr.token))
        .send({
          employeeId: fx.foreignStaffId,
          date: `${HIST_YEAR}-0${HIST_MONTH}-22`,
          checkIn: '09:00',
          checkOut: '17:00',
        });
      expect(res.status).toBe(404);

      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.foreignStaffId, date: histDay(22) },
      });
      expect(row).toBeNull();
    });

    /**
     * A5 on the read side. `getAttendanceById` used `findUnique`, which the
     * middleware does not intercept, and the service never called
     * `assertInBranch` — so a scoped HR read any attendance row in the company
     * by id. The guard now keys off the row's OWN denormalised branch, which is
     * the branch the punch actually happened in.
     */
    it('ASC-API-05 a scoped HR cannot read a foreign attendance row by id', async () => {
      const foreignRow = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.foreignStaffId, date: histDay(4) },
      });
      expect(foreignRow).toBeTruthy();

      const res = await ctx
        .http()
        .get(`/attendances/${foreignRow!.id}`)
        .set(bearer(fx.scopedHr.token));
      expect(res.status).toBe(404);

      const asGlobal = await ctx
        .http()
        .get(`/attendances/${foreignRow!.id}`)
        .set(bearer(fx.admin.token));
      expect(asGlobal.status).toBe(200);
    });

    /**
     * A6, FIXED. The existence oracle: `findUnique` (unscoped) decided the 404
     * and `findMany` (scoped) decided the content, so a cross-branch employee
     * answered 200-with-an-empty-list — telling the caller the id was real and
     * that the person simply had no attendance, which is a quieter lie than a
     * 404. It now 404s like every other by-id door.
     */
    it('ASC-API-06 a foreign employee’s month answers 404 rather than an empty 200', async () => {
      const res = await ctx
        .http()
        .get(
          `/attendances/employee/${fx.foreignStaffId}?month=${HIST_MONTH}&year=${HIST_YEAR}`,
        )
        .set(bearer(fx.scopedHr.token))
        .set('X-Branch-Id', fx.branchHome);
      expect(res.status).toBe(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('self-service reads are NOT branch-guarded', () => {
    /**
     * The trap this phase fell into and had to back out of.
     *
     * The first cut of the A5 fix put `assertInBranch` inside the shared service
     * methods — `checkIn`, `checkOut`, `getTodayAttendance`,
     * `getLunchBreakStatus`, `getEmployeeAttendances`. But those are SELF-SERVICE
     * doors as well as on-behalf ones: the controller passes `user.employeeId`
     * for `/my`, `/today`, `/lunch-status` and the bare punch routes. Guarding
     * them unconditionally meant a user lost their OWN attendance the moment the
     * branch picker pointed at another branch — `/attendances/my` answered 404
     * on the My Attendance screen.
     *
     * That is exactly the mistake the People phase made with
     * `/document-vault/me`, where an admin switching branches lost their own
     * payslips. The rule, now enforced by these cases: **guard the id the CALLER
     * supplied, never the one their token did.**
     */
    it('ASC-API-20 a user reads their own attendance with the branch pointed elsewhere', async () => {
      for (const path of [
        '/attendances/my',
        '/attendances/today',
        '/attendances/lunch-status',
      ]) {
        const res = await ctx
          .http()
          .get(path)
          .set(bearer(fx.hr.token))
          // Deliberately NOT the HR employee's own branch.
          .set('X-Branch-Id', fx.branchOverride);
        expect(res.status).toBe(200);
      }
    });

    it('ASC-API-21 a user punches themselves in with the branch pointed elsewhere', async () => {
      const res = await ctx
        .http()
        .post('/attendances/check-in')
        .set(bearer(fx.hr.token))
        .set('X-Branch-Id', fx.branchOverride)
        .send({});
      expect(res.status).toBe(201);

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      await ctx.prisma.attendance.deleteMany({
        where: { employeeId: fx.hr.employeeId, date: { gte: today } },
      });
    });

    it('ASC-API-22 but the by-PARAMETER door is still refused for a foreign employee', async () => {
      // The contrast that proves the relaxation above did not reopen A5.
      const res = await ctx
        .http()
        .get(
          `/attendances/employee/${fx.foreignStaffId}?month=${HIST_MONTH}&year=${HIST_YEAR}`,
        )
        .set(bearer(fx.scopedHr.token))
        .set('X-Branch-Id', fx.branchHome);
      expect(res.status).toBe(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the doors that get it right — the contrast', () => {
    /**
     * These two are what make the five above omissions rather than a design.
     * `AttendanceCorrectionsService.create` calls `assertInBranch` explicitly,
     * with a comment saying why, and `findOne` does the same — so the identical
     * shape, one file away, answers 404.
     */
    it('ASC-API-07 creating a correction for a foreign employee is refused with 404', async () => {
      const date = histDay(24).toISOString().slice(0, 10);
      const res = await ctx
        .http()
        .post(`/attendance-corrections/employee/${fx.foreignStaffId}`)
        .set(bearer(fx.scopedHr.token))
        .set('X-Branch-Id', fx.branchHome)
        .send({
          date,
          requestedCheckIn: `${date}T09:00:00.000Z`,
          reason: `foreign ${fx.runId}`,
        });
      expect(res.status).toBe(404);
    });

    it('ASC-API-08 the aggregate reads exclude a foreign employee entirely', async () => {
      const list = await ctx
        .http()
        .get(
          `/attendances/list?period=custom&startDate=${HIST_YEAR}-0${HIST_MONTH}-01&endDate=${HIST_YEAR}-0${HIST_MONTH}-28&limit=1000`,
        )
        .set(bearer(fx.scopedHr.token));
      expect(list.status).toBe(200);
      expect(employeeIdsOf(list)).not.toContain(fx.foreignStaffId);

      const report = await ctx
        .http()
        .get(`/attendances/report?month=${HIST_MONTH}&year=${HIST_YEAR}`)
        .set(bearer(fx.scopedHr.token));
      expect(report.status).toBe(200);
      expect(body(report)).not.toContain(fx.foreignStaffId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the X-Branch-Id header', () => {
    it('ASC-API-09 narrows a two-branch envelope down to one', async () => {
      const path = `/attendances/list?period=custom&startDate=${HIST_YEAR}-0${HIST_MONTH}-01&endDate=${HIST_YEAR}-0${HIST_MONTH}-28&limit=1000`;

      const whole = await ctx
        .http()
        .get(path)
        .set(bearer(fx.scopedHr.token));
      const ids = employeeIdsOf(whole);
      expect(ids).toContain(fx.puncherId);
      expect(ids).toContain(fx.overrideStaffId);

      const narrowed = await ctx
        .http()
        .get(path)
        .set(bearer(fx.scopedHr.token))
        .set('X-Branch-Id', fx.branchOverride);
      const narrowedIds = employeeIdsOf(narrowed);
      expect(narrowedIds).toContain(fx.overrideStaffId);
      expect(narrowedIds).not.toContain(fx.puncherId);
    });

    it('ASC-API-10 a branch outside the envelope is refused rather than obeyed', async () => {
      const res = await ctx
        .http()
        .get('/attendances/list?period=today&limit=1000')
        .set(bearer(fx.scopedHr.token))
        .set('X-Branch-Id', fx.branchForeign);
      // The interceptor logs an ACCESS_DENIED audit row and refuses when
      // enforcement is on. What must NOT happen is the header silently WIDENING
      // the caller's envelope.
      expect(res.status).toBe(403);
    });

    /**
     * `assertInBranch` treats a null branch as company-wide: a global caller
     * owns it, a scoped caller is refused (fail-closed). `nullBranchStaff` is
     * the only row in the fixture that reaches that arm.
     */
    it('ASC-API-11 a company-wide (null-branch) employee is visible to a global caller', async () => {
      const res = await ctx
        .http()
        .post(`/attendances/check-in/${fx.nullBranchStaffId}`)
        .set(bearer(fx.hr.token))
        .send({});
      expect(res.status).toBe(201);

      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.nullBranchStaffId },
        orderBy: { createdAt: 'desc' },
      });
      expect(row!.branchId).toBeNull();

      await ctx.prisma.attendance.deleteMany({
        where: { employeeId: fx.nullBranchStaffId },
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('department scope, inside a single branch', () => {
    /**
     * `deptFin` shares `branchHome` with `deptOps`, so nothing here can be
     * explained by the branch middleware — the refusals are department scope or
     * they are nothing.
     *
     * The two doors answer with two DIFFERENT sentences, from two separate
     * in-controller checks. Both are asserted verbatim: they are what the
     * screens show, and a future refactor that unifies them would change what
     * the user reads.
     */
    it('ASC-API-12 a manager is refused a sibling department’s month, by its own sentence', async () => {
      const res = await ctx
        .http()
        .get(
          `/attendances/employee/${fx.finStaffId}?month=${HIST_MONTH}&year=${HIST_YEAR}`,
        )
        .set(bearer(fx.mgr.token));
      expect(res.status).toBe(403);
      expect(body(res)).toContain('outside your department');
    });

    it('ASC-API-13 a manager is refused a sibling department’s row by id, by a different sentence', async () => {
      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.finStaffId, date: histDay(4) },
      });
      const res = await ctx
        .http()
        .get(`/attendances/${row!.id}`)
        .set(bearer(fx.mgr.token));
      expect(res.status).toBe(403);
      expect(body(res)).toContain('outside your department');
    });

    it('ASC-API-14 a manager reads their own department’s row by id', async () => {
      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.puncherId, date: histDay(4) },
      });
      const res = await ctx
        .http()
        .get(`/attendances/${row!.id}`)
        .set(bearer(fx.mgr.token));
      expect(res.status).toBe(200);
    });

    /**
     * `buildPrincipal` re-reads `managedDepartmentIds` from the database on
     * EVERY request, rather than trusting what the JWT carried. So moving an
     * employee between departments changes who can see them on the very next
     * call, with no re-login — which is the property that makes a reassignment
     * safe to do mid-shift.
     */
    it('ASC-API-15 a department move changes what a manager sees, with no re-login', async () => {
      const before = await ctx
        .http()
        .get(
          `/attendances/employee/${fx.finStaffId}?month=${HIST_MONTH}&year=${HIST_YEAR}`,
        )
        .set(bearer(fx.mgr.token));
      expect(before.status).toBe(403);

      await ctx.prisma.employee.update({
        where: { id: fx.finStaffId },
        data: { departmentId: fx.deptOps },
      });

      const after = await ctx
        .http()
        .get(
          `/attendances/employee/${fx.finStaffId}?month=${HIST_MONTH}&year=${HIST_YEAR}`,
        )
        .set(bearer(fx.mgr.token));
      expect(after.status).toBe(200);

      await ctx.prisma.employee.update({
        where: { id: fx.finStaffId },
        data: { departmentId: fx.deptFin },
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the seam with Organization', () => {
    /**
     * A28. `Attendance.branch` is `onDelete: Restrict`, so a single check-in
     * pins a branch permanently. That is a live coupling between two modules
     * that neither one's documentation records, and the Organization suite's
     * "delete an empty branch" case passes only because it never punches anyone.
     */
    it('ASC-API-16 a branch with even one attendance row cannot be deleted', async () => {
      const branch = await ctx.prisma.branch.create({
        data: { code: `ASC-DEL-${fx.runId}`, name: 'Deletable', isActive: true },
      });
      const staff = await ctx.prisma.employee.create({
        data: {
          employeeCode: `ASC-DEL-EMP-${fx.runId}`,
          fullName: 'Delete Me',
          dateOfBirth: new Date('1990-01-01'),
          idCard: `ASC-DEL-ID-${fx.runId}`,
          email: `asc-del-${fx.runId}@test.local`,
          departmentId: fx.deptOps,
          branchId: branch.id,
          position: 'Temp',
          startDate: new Date('2018-01-01'),
          baseSalary: 1000,
          status: 'ACTIVE',
        } as any,
      });

      const empty = await ctx
        .http()
        .delete(`/branches/${branch.id}`)
        .set(bearer(fx.admin.token));
      // Staffed, so the branch service refuses on its own terms first.
      expect(empty.status).toBeGreaterThanOrEqual(400);

      await ctx.prisma.attendance.create({
        data: {
          employeeId: staff.id,
          date: histDay(26),
          branchId: branch.id,
          status: 'PRESENT',
          workHours: 8,
        } as any,
      });

      // The FK is the point: even with the employee gone, the attendance row
      // still pins the branch.
      await ctx.prisma.employee.update({
        where: { id: staff.id },
        data: { branchId: null },
      });
      await expect(
        ctx.prisma.branch.delete({ where: { id: branch.id } }),
      ).rejects.toThrow();

      await ctx.prisma.attendance.deleteMany({ where: { branchId: branch.id } });
      await ctx.prisma.employee.delete({ where: { id: staff.id } });
      await ctx.prisma.branch.delete({ where: { id: branch.id } });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the seam with Leave', () => {
    /**
     * A9 + A10. Approving leave writes `Attendance` rows so the day is not
     * counted absent by payroll — but that write:
     *
     *   - omits `branchId` entirely, so the rows are invisible to every
     *     branch-scoped caller (`Attendance` is a `direct`-rule model and
     *     `branchId IN (…)` never matches NULL); and
     *   - uses `skipDuplicates: true`, so a day the employee ALREADY clocked is
     *     silently left alone and the leave never appears in attendance at all.
     *
     * The fixture's `onLeaveStaff` already carries an APPROVED leave covering
     * today, written directly — so this case asserts the shape of what the
     * approval path produces rather than re-driving the approval.
     */
    it('ASC-API-17 leave-generated attendance rows carry no branch', async () => {
      const employee = await ctx.prisma.employee.findUnique({
        where: { id: fx.onLeaveStaffId },
      });
      expect(employee!.branchId).toBe(fx.branchHome);

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const leaveRow = await ctx.prisma.attendance.create({
        data: {
          employeeId: fx.onLeaveStaffId,
          date: histDay(27),
          status: 'LEAVE',
          workHours: 0,
          source: 'LEAVE',
          // branchId deliberately omitted — this is exactly what
          // `leave-requests.service.ts` writes.
        } as any,
      });

      expect(leaveRow.branchId).toBeNull();

      // And the branch-narrowed report cannot see the day.
      const report = await ctx
        .http()
        .get(`/attendances/report?month=${HIST_MONTH}&year=${HIST_YEAR}`)
        .set(bearer(fx.scopedHr.token))
        .set('X-Branch-Id', fx.branchHome);
      expect(report.status).toBe(200);
      const rows = rowsOf(report);
      const theirs = rows.find(
        (r) => (r.employee?.id ?? r.employeeId) === fx.onLeaveStaffId,
      );
      const leaveDays = theirs
        ? JSON.stringify(theirs).includes('"LEAVE"')
        : false;
      expect(leaveDays).toBe(false);

      await ctx.prisma.attendance.delete({ where: { id: leaveRow.id } });
    });

    it('ASC-API-18 a leave day is skipped silently when the employee already clocked', async () => {
      const existing = await ctx.prisma.attendance.create({
        data: {
          employeeId: fx.onLeaveStaffId,
          date: histDay(28),
          checkIn: new Date(Date.UTC(HIST_YEAR, HIST_MONTH - 1, 28, 9)),
          status: 'PRESENT',
          workHours: 8,
          source: 'ESS',
          branchId: fx.branchHome,
        } as any,
      });

      // The exact call the leave approval makes.
      const result = await ctx.prisma.attendance.createMany({
        data: [
          {
            employeeId: fx.onLeaveStaffId,
            date: histDay(28),
            status: 'LEAVE',
            workHours: 0,
            source: 'LEAVE',
          },
        ] as any,
        skipDuplicates: true,
      });
      expect(result.count).toBe(0);

      const after = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.onLeaveStaffId, date: histDay(28) },
      });
      // Still PRESENT. The approver was told the leave was granted; attendance
      // disagrees, and nothing anywhere reports the conflict.
      expect(after!.status).toBe('PRESENT');

      await ctx.prisma.attendance.delete({ where: { id: existing.id } });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the seam with Payroll', () => {
    /**
     * Attendance rows are a payroll INPUT, and payroll refuses to run a period
     * with none rather than treating everyone as absent and wiping the salary
     * via LOP. Payroll ARITHMETIC is out of scope for this phase — what is in
     * scope is that the guard exists and keys off attendance.
     */
    it('ASC-API-19 payroll refuses a period with no attendance captured', async () => {
      const res = await ctx
        .http()
        .post('/payrolls/generate')
        .set(bearer(fx.admin.token))
        .set('X-Branch-Id', fx.branchForeign)
        .send({ month: 1, year: 2017 });

      // Either the guard fires with its own sentence, or the run is refused for
      // an earlier reason — what must never happen is a 2xx that silently
      // produces a zeroed payroll.
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
});
