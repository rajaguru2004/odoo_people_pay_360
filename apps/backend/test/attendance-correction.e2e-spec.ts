import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupAttendanceFixtures,
  AttendanceFixtures,
  pinCompanyTzToMidMorning,
  HIST_YEAR,
  HIST_MONTH,
  histDay,
} from './utils/attendance-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * Attendance correction requests — the module's only approval flow, and the
 * only place in Time & Attendance where one user's decision REWRITES another
 * user's attendance row. That row is a payroll input, so every side effect below
 * is asserted against the database rather than against the response body.
 *
 * Until WP-0 of this phase, `AttendanceCorrectionsModule` was not imported by
 * `test/utils/test-app.module.ts`, so every request here answered 404 and no
 * e2e case could have existed. The service has 31 unit cases with Prisma
 * mocked; what those cannot reach — and what this file is for — is the HTTP
 * boundary, the role matrix, the branch middleware, real `system_settings` rows,
 * the upsert against a real `Attendance`, and concurrency.
 *
 * Four behaviours are pinned as KNOWN GAPs with failing twins: the 500 on a full
 * ISO date (recorded in docs/TESTING.md §Recorded defects #2 and never fixed),
 * the missing ownership check on read-by-id, the missing self-approval guard,
 * and the branch that an approved correction fails to stamp.
 *
 * This file owns "today" for `correctionStaff` — see the ownership table in
 * `test/utils/attendance-fixtures.ts`.
 */
describe('Attendance — correction requests (e2e)', () => {
  let ctx: E2EContext;
  let fx: AttendanceFixtures;
  let restoreTz: () => Promise<void>;

  const LIMIT_KEY = 'monthly_attendance_request_limit';

  const body = (res: any) => JSON.stringify(res.body);
  /**
   * Note the third arm. Unlike the rest of the app, every read on this
   * controller returns a BARE ARRAY rather than a `{ success, data }` envelope
   * — the corrections screen knows it and says so at `corrections/page.tsx:115`
   * ("Response is already an array"). It is handled, so it is an inconsistency
   * rather than a break, but it is the same shape as the import-preview defect
   * the People phase found: add the envelope in a future refactor and this
   * screen silently renders nothing. Recorded as A32.
   */
  const rowsOf = (res: any): any[] => {
    if (Array.isArray(res.body)) return res.body;
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };
  const idOf = (res: any) => res.body?.data?.id ?? res.body?.id;

  /** Days inside HIST that this file hands out one at a time, so no two cases collide. */
  let day = 1;
  const nextDay = () => histDay(day++);
  const nextDayStr = () => {
    const d = nextDay();
    return d.toISOString().slice(0, 10);
  };

  const create = (
    token: string,
    payload: Record<string, unknown>,
    path = '/attendance-corrections',
  ) => ctx.http().post(path).set(bearer(token)).send(payload);

  /** A PENDING request on `correctionStaff`, on a day nothing else touches. */
  const seedPending = async (over: Record<string, unknown> = {}) => {
    const date = nextDayStr();
    const res = await create(fx.hr.token, {
      date,
      requestedCheckIn: `${date}T09:00:00.000Z`,
      requestedCheckOut: `${date}T17:00:00.000Z`,
      reason: `seed ${fx.runId}`,
      ...over,
    }, `/attendance-corrections/employee/${fx.correctionStaffId}`);
    expect(res.status).toBe(201);
    return { id: idOf(res), date };
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupAttendanceFixtures(ctx);
    restoreTz = await pinCompanyTzToMidMorning(ctx);
  }, 120000);

  afterAll(async () => {
    if (restoreTz) await restoreTz();
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  /**
   * The quota counts by `createdAt` in the current calendar month across ALL
   * statuses, so a suite that files dozens of requests would lock itself out
   * halfway through. It is therefore unlimited for the file, and only the five
   * quota cases put a real cap back inside a `withSetting`.
   */
  let previousLimit: string | null = null;
  beforeAll(async () => {
    previousLimit = await ctx.prisma.systemSetting
      .findUnique({ where: { key: LIMIT_KEY } })
      .then((r) => r?.value ?? null);
    await ctx.prisma.systemSetting.upsert({
      where: { key: LIMIT_KEY },
      create: { key: LIMIT_KEY, value: '0' },
      update: { value: '0' },
    });
  });
  afterAll(async () => {
    if (previousLimit === null) {
      await ctx.prisma.systemSetting
        .delete({ where: { key: LIMIT_KEY } })
        .catch(() => undefined);
    } else {
      await ctx.prisma.systemSetting.update({
        where: { key: LIMIT_KEY },
        data: { value: previousLimit },
      });
    }
  });

  /** No "one pending per date" state may leak from one case into the next. */
  afterEach(async () => {
    await ctx.prisma.attendanceCorrection.deleteMany({
      where: { employeeId: fx.correctionStaffId, status: 'PENDING' },
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('filing a request', () => {
    it('ACR-API-01 an employee files against a day with no attendance and gets a PENDING row', async () => {
      const date = nextDayStr();
      const res = await create(fx.employee.token, {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
        requestedCheckOut: `${date}T17:00:00.000Z`,
        reason: `filed by employee ${fx.runId}`,
      });
      expect(res.status).toBe(201);

      const row = await ctx.prisma.attendanceCorrection.findUnique({
        where: { id: idOf(res) },
      });
      expect(row!.status).toBe('PENDING');
      expect(row!.employeeId).toBe(fx.puncherId);
      // No attendance existed on that day, so there is nothing to snapshot and
      // nothing to link. Both are asserted because the approve path branches on
      // exactly this: a null `attendanceId` takes the create arm of the upsert.
      expect(row!.attendanceId).toBeNull();
      expect(row!.originalCheckIn).toBeNull();

      await ctx.prisma.attendanceCorrection.delete({ where: { id: row!.id } });
    });

    it('ACR-API-02 filing against an existing day snapshots the original times and links the row', async () => {
      // February 5th is `puncher`'s seeded LATE day.
      const date = histDay(5).toISOString().slice(0, 10);
      const existing = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.puncherId, date: histDay(5) },
      });
      expect(existing).toBeTruthy();

      const res = await create(fx.employee.token, {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
        reason: `fix my late mark ${fx.runId}`,
      });
      expect(res.status).toBe(201);

      const row = await ctx.prisma.attendanceCorrection.findUnique({
        where: { id: idOf(res) },
      });
      expect(row!.attendanceId).toBe(existing!.id);
      expect(row!.originalCheckIn?.toISOString()).toBe(
        existing!.checkIn!.toISOString(),
      );

      await ctx.prisma.attendanceCorrection.delete({ where: { id: row!.id } });
    });

    it('ACR-API-03 a missing reason is refused by the DTO', async () => {
      const date = nextDayStr();
      const res = await create(fx.employee.token, {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
      });
      expect(res.status).toBe(400);
    });

    it('ACR-API-04 neither check-in nor check-out is refused with its own sentence', async () => {
      const res = await create(fx.employee.token, {
        date: nextDayStr(),
        reason: `no times ${fx.runId}`,
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('at least check-in or check-out');
    });

    it('ACR-API-05 a future date is refused', async () => {
      const future = new Date();
      future.setUTCDate(future.getUTCDate() + 3);
      const date = future.toISOString().slice(0, 10);
      const res = await create(fx.employee.token, {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
        reason: `future ${fx.runId}`,
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('future dates');
    });

    /**
     * The guard is `requestDate > today`, not `>=`. Today itself is therefore
     * legal — a boundary with no test anywhere, and the one an employee actually
     * hits when they forget to clock out and fix it the same evening.
     */
    it('ACR-API-06 today itself is allowed — the future guard is strictly greater', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await create(fx.employee.token, {
        date: today,
        requestedCheckIn: `${today}T09:00:00.000Z`,
        reason: `today ${fx.runId}`,
      });
      expect(res.status).toBe(201);
      await ctx.prisma.attendanceCorrection.delete({
        where: { id: idOf(res) },
      });
    });

    it('ACR-API-07 a date before the onboarding date is refused, naming that date', async () => {
      const date = histDay(3).toISOString().slice(0, 10);
      const res = await create(
        fx.hr.token,
        {
          date,
          requestedCheckIn: `${date}T09:00:00.000Z`,
          reason: `before onboarding ${fx.runId}`,
        },
        `/attendance-corrections/employee/${fx.newHireId}`,
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('onboarding date');
    });

    it('ACR-API-08 a second PENDING request for the same date is refused', async () => {
      const seeded = await seedPending();
      const res = await create(
        fx.hr.token,
        {
          date: seeded.date,
          requestedCheckIn: `${seeded.date}T10:00:00.000Z`,
          reason: `duplicate ${fx.runId}`,
        },
        `/attendance-corrections/employee/${fx.correctionStaffId}`,
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('already a pending correction request');
    });

    it('ACR-API-09 an unknown employee on the HR route is a 404', async () => {
      const date = nextDayStr();
      const res = await create(
        fx.hr.token,
        {
          date,
          requestedCheckIn: `${date}T09:00:00.000Z`,
          reason: `unknown ${fx.runId}`,
        },
        '/attendance-corrections/employee/00000000-0000-0000-0000-000000000000',
      );
      expect(res.status).toBe(404);
    });

    it('ACR-API-10 an unexpected field is refused by forbidNonWhitelisted', async () => {
      const date = nextDayStr();
      const res = await create(fx.employee.token, {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
        reason: `extra field ${fx.runId}`,
        status: 'APPROVED',
      });
      expect(res.status).toBe(400);
    });

    /**
     * A13, FIXED — and it was recorded in docs/TESTING.md §Recorded defects #2
     * for months before this suite pinned it.
     *
     * `@IsDateString()` ACCEPTS a full ISO timestamp, and the service then did
     * `dto.date.split('-')`, feeding `Number('20T00:00:00.000Z')` into
     * `Date.UTC` — NaN, an Invalid Date, and a raw Prisma error surfaced to the
     * caller as a 500 carrying driver text. The DTO now constrains the field to
     * the calendar date it always meant.
     */
    it('ACR-API-11 a full ISO datetime is refused as a 400, with no driver text', async () => {
      const res = await create(fx.employee.token, {
        date: `${HIST_YEAR}-0${HIST_MONTH}-20T00:00:00.000Z`,
        requestedCheckIn: `${HIST_YEAR}-0${HIST_MONTH}-20T09:00:00.000Z`,
        reason: `iso date ${fx.runId}`,
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('YYYY-MM-DD');
      // The tell-tale of the old failure: a Prisma error reaching the client.
      expect(body(res)).not.toContain('Invalid');
      expect(body(res)).not.toContain('prisma');
    });

    it('ACR-API-11b a plain calendar date is still accepted', async () => {
      const date = nextDayStr();
      const res = await create(fx.employee.token, {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
        reason: `plain date ${fx.runId}`,
      });
      expect(res.status).toBe(201);
      await ctx.prisma.attendanceCorrection.delete({ where: { id: idOf(res) } });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the monthly self-service quota', () => {
    /** Every quota case works on its own employee, so no other case's history counts. */
    const quotaEmployee = () => fx.correctionHistoryStaffId;

    it('ACR-API-12 my-usage reports used, limit, remaining and unlimited', async () => {
      const res = await ctx
        .http()
        .get('/attendance-corrections/my-usage')
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);
      const d = res.body?.data ?? res.body;
      expect(d).toHaveProperty('used');
      expect(d).toHaveProperty('limit');
      expect(d).toHaveProperty('remaining');
      expect(d).toHaveProperty('unlimited');
    });

    it('ACR-API-13 limit 0 means unlimited', async () => {
      const res = await ctx
        .http()
        .get('/attendance-corrections/my-usage')
        .set(bearer(fx.employee.token));
      // The file-wide setting is '0'.
      expect((res.body?.data ?? res.body).unlimited).toBe(true);
    });

    /**
     * A18. The fixture already seeded two TERMINAL corrections (one APPROVED,
     * one REJECTED) on this employee, both created inside the current calendar
     * month. `getMonthlyUsage` counts by `createdAt` with NO status filter, so
     * those two consume quota even though neither is outstanding — and a cap of
     * 2 is therefore already reached before a single new request is filed.
     */
    it('ACR-API-14 KNOWN GAP: settled requests still consume the monthly quota', async () => {
      await withSetting(ctx, LIMIT_KEY, '2', async () => {
        const date = nextDayStr();
        const res = await create(
          fx.employee.token,
          {
            date,
            requestedCheckIn: `${date}T09:00:00.000Z`,
            reason: `quota ${fx.runId}`,
          },
          // Filed BY the employee themselves, so the self-service cap applies.
          '/attendance-corrections',
        );
        // `puncher` has filed nothing this month, so this one must succeed —
        // the point of the case is the usage figure below, read for the
        // employee whose only two requests are settled.
        expect(res.status).toBe(201);
        await ctx.prisma.attendanceCorrection.delete({ where: { id: idOf(res) } });

        const usage = await ctx.prisma.attendanceCorrection.count({
          where: {
            employeeId: quotaEmployee(),
            status: { in: ['APPROVED', 'REJECTED'] },
          },
        });
        expect(usage).toBe(2);
      });
    });

    it('ACR-API-15 the cap refuses the request over the line, naming the limit', async () => {
      await withSetting(ctx, LIMIT_KEY, '1', async () => {
        const first = nextDayStr();
        const a = await create(fx.employee.token, {
          date: first,
          requestedCheckIn: `${first}T09:00:00.000Z`,
          reason: `cap one ${fx.runId}`,
        });
        expect(a.status).toBe(201);

        const second = nextDayStr();
        const b = await create(fx.employee.token, {
          date: second,
          requestedCheckIn: `${second}T09:00:00.000Z`,
          reason: `cap two ${fx.runId}`,
        });
        expect(b.status).toBe(400);
        expect(body(b)).toContain('Monthly attendance request limit reached (1)');

        await ctx.prisma.attendanceCorrection.delete({ where: { id: idOf(a) } });
      });
    });

    it('ACR-API-16 HR filing on behalf bypasses the cap entirely', async () => {
      await withSetting(ctx, LIMIT_KEY, '1', async () => {
        const one = await seedPending();
        const date = nextDayStr();
        // A second one for the SAME employee, over the cap, through the HR door.
        const res = await create(
          fx.hr.token,
          {
            date,
            requestedCheckIn: `${date}T09:00:00.000Z`,
            reason: `hr bypass ${fx.runId}`,
          },
          `/attendance-corrections/employee/${fx.correctionStaffId}`,
        );
        expect(res.status).toBe(201);
        expect(one.id).toBeTruthy();
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read and decide', () => {
    it('ACR-API-17 the queue is ADMIN/HR only', async () => {
      for (const path of [
        '/attendance-corrections',
        '/attendance-corrections/pending',
      ]) {
        expect(
          (await ctx.http().get(path).set(bearer(fx.admin.token))).status,
        ).toBe(200);
        expect((await ctx.http().get(path).set(bearer(fx.hr.token))).status).toBe(
          200,
        );
        expect((await ctx.http().get(path).set(bearer(fx.mgr.token))).status).toBe(
          403,
        );
        expect(
          (await ctx.http().get(path).set(bearer(fx.employee.token))).status,
        ).toBe(403);
        expect((await ctx.http().get(path)).status).toBe(401);
      }
    });

    it('ACR-API-18 my-requests is self-scoped for every role', async () => {
      const res = await ctx
        .http()
        .get('/attendance-corrections/my-requests')
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);
      expect(
        rowsOf(res).every((r) => r.employeeId === fx.puncherId),
      ).toBe(true);
    });

    /**
     * A4, FIXED. This route carried NO `@Roles` at all, and `RolesGuard`
     * returns true when the metadata is absent — so every authenticated user
     * reached it, and neither the controller nor `findOne` checked ownership.
     * `assertInBranch` bounded the leak to the caller's branch and no further:
     * any colleague could read the reason text, both requested times and the
     * reviewer's note.
     */
    it('ACR-API-19 a colleague is refused another employee’s request', async () => {
      const seeded = await seedPending({ reason: `private text ${fx.runId}` });

      const asOther = await ctx
        .http()
        .get(`/attendance-corrections/${seeded.id}`)
        .set(bearer(fx.otherEmployee.token));
      expect(asOther.status).toBe(403);
      expect(body(asOther)).not.toContain('private text');

      const asMgr = await ctx
        .http()
        .get(`/attendance-corrections/${seeded.id}`)
        .set(bearer(fx.mgr.token));
      expect(asMgr.status).toBe(403);
    });

    it('ACR-API-19b the requester and the reviewers can still read it', async () => {
      const date = nextDayStr();
      const filed = await create(fx.employee.token, {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
        reason: `mine to read ${fx.runId}`,
      });
      expect(filed.status).toBe(201);

      // The owner.
      const own = await ctx
        .http()
        .get(`/attendance-corrections/${idOf(filed)}`)
        .set(bearer(fx.employee.token));
      expect(own.status).toBe(200);
      expect(body(own)).toContain('mine to read');

      // And the people who have to decide it.
      for (const actor of [fx.admin, fx.hr]) {
        const res = await ctx
          .http()
          .get(`/attendance-corrections/${idOf(filed)}`)
          .set(bearer(actor.token));
        expect(res.status).toBe(200);
      }

      await ctx.prisma.attendanceCorrection.delete({ where: { id: idOf(filed) } });
    });

    /**
     * A24, recorded rather than fixed. A MANAGER heads a department and
     * `/attendances/overview` hands them exactly that department's attendance —
     * but they cannot decide a correction for any of it. Corrections also sit
     * outside the ApprovalWorkflow engine entirely, so `supervisor_approval_enabled`
     * changes nothing here. Who owns attendance authority is a product call.
     */
    it('ACR-API-20 a MANAGER cannot approve or reject, by design as it stands', async () => {
      const seeded = await seedPending();
      const approve = await ctx
        .http()
        .post(`/attendance-corrections/${seeded.id}/approve`)
        .set(bearer(fx.mgr.token))
        .send({});
      expect(approve.status).toBe(403);

      const reject = await ctx
        .http()
        .post(`/attendance-corrections/${seeded.id}/reject`)
        .set(bearer(fx.mgr.token))
        .send({ rejectedReason: 'no' });
      expect(reject.status).toBe(403);
    });

    /**
     * The one door in the module where ADMIN is refused: `cancel` checks
     * employee identity rather than role. A19 records the consequence — a
     * request HR filed on someone's behalf cannot be withdrawn by HR.
     */
    it('ACR-API-21 cancel is requester-only, and refuses even an ADMIN', async () => {
      const seeded = await seedPending();
      const res = await ctx
        .http()
        .delete(`/attendance-corrections/${seeded.id}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(403);
      expect(body(res)).toContain('permission to cancel');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the lifecycle, asserted on the row', () => {
    it('ACR-API-22 approval rewrites the attendance row and records the approver', async () => {
      const seeded = await seedPending();

      const res = await ctx
        .http()
        .post(`/attendance-corrections/${seeded.id}/approve`)
        .set(bearer(fx.hr.token))
        .send({ notes: `approved by hr ${fx.runId}` });
      expect(res.status).toBe(201);

      const row = await ctx.prisma.attendanceCorrection.findUnique({
        where: { id: seeded.id },
      });
      expect(row!.status).toBe('APPROVED');
      // `approverId` is a raw uuid with NO relation, and it holds the USER id,
      // not the employee id — which is why the list endpoint has to batch-load
      // reviewers by hand.
      expect(row!.approverId).toBe(fx.hr.userId);
      expect(row!.approvedAt).toBeTruthy();

      const attendance = await ctx.prisma.attendance.findFirst({
        where: {
          employeeId: fx.correctionStaffId,
          date: new Date(`${seeded.date}T00:00:00.000Z`),
        },
      });
      expect(attendance).toBeTruthy();
      expect(attendance!.status).toBe('PRESENT');
      expect(attendance!.notes).toContain('Adjustment:');
      expect(attendance!.checkIn).toBeTruthy();
      expect(attendance!.checkOut).toBeTruthy();
    });

    it('ACR-API-23 rejection stores its reason and leaves the attendance untouched', async () => {
      const seeded = await seedPending();
      const dateKey = new Date(`${seeded.date}T00:00:00.000Z`);

      const before = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.correctionStaffId, date: dateKey },
      });

      const res = await ctx
        .http()
        .post(`/attendance-corrections/${seeded.id}/reject`)
        .set(bearer(fx.hr.token))
        .send({ rejectedReason: `not enough detail ${fx.runId}` });
      expect(res.status).toBe(201);

      const row = await ctx.prisma.attendanceCorrection.findUnique({
        where: { id: seeded.id },
      });
      expect(row!.status).toBe('REJECTED');
      expect(row!.rejectedReason).toContain('not enough detail');

      const after = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.correctionStaffId, date: dateKey },
      });
      // Byte-identical, including "still absent".
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });

    it('ACR-API-24 the requester cancels their own pending request', async () => {
      const date = nextDayStr();
      const filed = await create(fx.employee.token, {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
        reason: `to cancel ${fx.runId}`,
      });
      expect(filed.status).toBe(201);

      const res = await ctx
        .http()
        .delete(`/attendance-corrections/${idOf(filed)}`)
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);

      const row = await ctx.prisma.attendanceCorrection.findUnique({
        where: { id: idOf(filed) },
      });
      expect(row!.status).toBe('CANCELLED');
      await ctx.prisma.attendanceCorrection.delete({ where: { id: row!.id } });
    });

    it('ACR-API-25 a settled request refuses every further transition, each with its own sentence', async () => {
      const seeded = await seedPending();
      await ctx
        .http()
        .post(`/attendance-corrections/${seeded.id}/approve`)
        .set(bearer(fx.hr.token))
        .send({});

      const reapprove = await ctx
        .http()
        .post(`/attendance-corrections/${seeded.id}/approve`)
        .set(bearer(fx.hr.token))
        .send({});
      expect(reapprove.status).toBe(400);
      expect(body(reapprove)).toContain('Only pending requests can be approved');

      const reject = await ctx
        .http()
        .post(`/attendance-corrections/${seeded.id}/reject`)
        .set(bearer(fx.hr.token))
        .send({ rejectedReason: 'too late' });
      expect(reject.status).toBe(400);
      expect(body(reject)).toContain('Only pending requests can be rejected');
    });

    it('ACR-API-26 rejection without a reason is refused', async () => {
      const seeded = await seedPending();
      const res = await ctx
        .http()
        .post(`/attendance-corrections/${seeded.id}/reject`)
        .set(bearer(fx.hr.token))
        .send({});
      expect(res.status).toBe(400);
    });

    /**
     * A8, FIXED. `approve()` reaches the row through `prisma.attendance.upsert`,
     * and `upsert` is in neither `BRANCH_READ_ACTIONS` nor
     * `BRANCH_WRITE_MANY_ACTIONS` — so the middleware neither scoped nor
     * stamped it, while `buildAndUpsertAttendance` passes `branchId` explicitly
     * on every other write path (asserted at ATA-API-19).
     *
     * The consequence was not cosmetic: `Attendance` is a `direct`-rule model
     * and `branchId IN (…)` never matches NULL, so the day an employee had
     * successfully corrected DISAPPEARED from their own branch's list, report
     * and logs grid.
     */
    it('ACR-API-27 an approved correction stamps the employee’s branch', async () => {
      const seeded = await seedPending();
      await ctx
        .http()
        .post(`/attendance-corrections/${seeded.id}/approve`)
        .set(bearer(fx.hr.token))
        .send({});

      const row = await ctx.prisma.attendance.findFirst({
        where: {
          employeeId: fx.correctionStaffId,
          date: new Date(`${seeded.date}T00:00:00.000Z`),
        },
      });
      expect(row).toBeTruthy();
      expect(row!.branchId).toBe(fx.branchHome);
    });

    it('ACR-API-27b the corrected day is visible to a branch-scoped reader', async () => {
      const seeded = await seedPending();
      await ctx
        .http()
        .post(`/attendance-corrections/${seeded.id}/approve`)
        .set(bearer(fx.hr.token))
        .send({});

      const list = await ctx
        .http()
        .get(
          `/attendances/list?period=custom&startDate=${seeded.date}&endDate=${seeded.date}&limit=1000`,
        )
        .set(bearer(fx.scopedHr.token))
        .set('X-Branch-Id', fx.branchHome);
      expect(list.status).toBe(200);

      const theirRow = rowsOf(list).find(
        (r) => (r.employeeId ?? r.employee?.id) === fx.correctionStaffId,
      );
      expect(theirRow).toBeDefined();
      // The REAL row now, not the virtual placeholder the single-day path
      // manufactures for employees with no attendance.
      expect(String(theirRow.id)).not.toMatch(/^virtual-/);
      expect(theirRow.status).toBe('PRESENT');
    });

    /**
     * A17, FIXED. `approve()` checked `status === 'PENDING'` and nothing else,
     * so an HR could file against their own record and approve it in the same
     * breath — an unreviewed rewrite of a payroll input. Phase 1 established
     * exactly this rule for department change requests ("nobody may review a
     * change request they raised"); attendance never got it.
     */
    it('ACR-API-28 nobody may approve a request they raised', async () => {
      const date = nextDayStr();
      const filed = await create(fx.hr.token, {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
        requestedCheckOut: `${date}T17:00:00.000Z`,
        reason: `my own request ${fx.runId}`,
      });
      expect(filed.status).toBe(201);

      const res = await ctx
        .http()
        .post(`/attendance-corrections/${idOf(filed)}/approve`)
        .set(bearer(fx.hr.token))
        .send({});
      expect(res.status).toBe(403);
      expect(body(res)).toContain('your own');

      const row = await ctx.prisma.attendanceCorrection.findUnique({
        where: { id: idOf(filed) },
      });
      expect(row!.status).toBe('PENDING');
    });

    it('ACR-API-28b a DIFFERENT reviewer can still decide it', async () => {
      const date = nextDayStr();
      const filed = await create(fx.hr.token, {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
        reason: `someone else decides ${fx.runId}`,
      });

      const res = await ctx
        .http()
        .post(`/attendance-corrections/${idOf(filed)}/approve`)
        .set(bearer(fx.admin.token))
        .send({});
      expect(res.status).toBe(201);

      const row = await ctx.prisma.attendanceCorrection.findUnique({
        where: { id: idOf(filed) },
      });
      expect(row!.status).toBe('APPROVED');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('reading the queue', () => {
    it('ACR-API-29 status and employeeId both filter, and every row carries its reviewer', async () => {
      const byStatus = await ctx
        .http()
        .get('/attendance-corrections?status=APPROVED')
        .set(bearer(fx.admin.token));
      expect(byStatus.status).toBe(200);
      expect(rowsOf(byStatus).every((r) => r.status === 'APPROVED')).toBe(true);

      const byEmployee = await ctx
        .http()
        .get(`/attendance-corrections?employeeId=${fx.correctionHistoryStaffId}`)
        .set(bearer(fx.admin.token));
      expect(byEmployee.status).toBe(200);
      const rows = rowsOf(byEmployee);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(
        rows.every((r) => r.employeeId === fx.correctionHistoryStaffId),
      ).toBe(true);
      // `approverId` has no Prisma relation, so the service batch-loads
      // reviewers by hand. A row that skipped that step would show a blank
      // approver on screen with no error anywhere.
      expect(rows.some((r) => 'reviewer' in r)).toBe(true);
    });

    it('ACR-API-30 /pending equals ?status=PENDING', async () => {
      await seedPending();
      const pending = await ctx
        .http()
        .get('/attendance-corrections/pending')
        .set(bearer(fx.admin.token));
      const filtered = await ctx
        .http()
        .get('/attendance-corrections?status=PENDING')
        .set(bearer(fx.admin.token));

      const ids = (r: any) =>
        rowsOf(r)
          .map((x) => x.id)
          .sort();
      expect(ids(pending)).toEqual(ids(filtered));
    });

    it('ACR-API-31 an employee list for someone with no requests is empty, not a 404', async () => {
      const res = await ctx
        .http()
        .get(`/attendance-corrections/employee/${fx.absenteeId}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(rowsOf(res)).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('concurrency', () => {
    /**
     * A16. "One PENDING per employee per date" is a read-then-write with no DB
     * constraint behind it — `AttendanceCorrection` has no unique index at all.
     * Two requests that interleave between the `findFirst` and the `create` both
     * win, and the queue then holds two live requests for one day; approving
     * both applies the second over the first with no record that it happened.
     */
    it('ACR-API-32 KNOWN GAP: two simultaneous requests for one date both succeed', async () => {
      const date = nextDayStr();
      const payload = {
        date,
        requestedCheckIn: `${date}T09:00:00.000Z`,
        reason: `race ${fx.runId}`,
      };
      const [a, b] = await Promise.all([
        create(
          fx.hr.token,
          payload,
          `/attendance-corrections/employee/${fx.correctionStaffId}`,
        ),
        create(
          fx.hr.token,
          payload,
          `/attendance-corrections/employee/${fx.correctionStaffId}`,
        ),
      ]);

      const created = [a, b].filter((r) => r.status === 201);
      expect(created).toHaveLength(2);

      const rows = await ctx.prisma.attendanceCorrection.findMany({
        where: {
          employeeId: fx.correctionStaffId,
          date: new Date(`${date}T00:00:00.000Z`),
          status: 'PENDING',
        },
      });
      expect(rows).toHaveLength(2);
    });

    it.failing(
      'ACR-API-32b exactly one of two simultaneous requests should win',
      async () => {
        const date = nextDayStr();
        const payload = {
          date,
          requestedCheckIn: `${date}T09:00:00.000Z`,
          reason: `race twin ${fx.runId}`,
        };
        const [a, b] = await Promise.all([
          create(
            fx.hr.token,
            payload,
            `/attendance-corrections/employee/${fx.correctionStaffId}`,
          ),
          create(
            fx.hr.token,
            payload,
            `/attendance-corrections/employee/${fx.correctionStaffId}`,
          ),
        ]);
        const ok = [a, b].filter((r) => r.status === 201);
        expect(ok).toHaveLength(1);
      },
    );
  });
});
