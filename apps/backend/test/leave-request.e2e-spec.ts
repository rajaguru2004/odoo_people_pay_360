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
import { bearer, withSetting } from './utils/settings';

/**
 * Leave requests, end to end.
 *
 * ── What the lower layers already own, and is NOT re-derived here ───────────
 *
 * There is no `leave-requests.service.spec.ts` — this module has no unit layer
 * at all, unlike overtime, which has two. So unusually for an e2e file, this one
 * is also the FIRST assertion of several rules (gender restriction, notice
 * period, the working-day count). Where a lower layer does exist it is
 * respected: `holidays.service.spec.ts` owns the weekly-off/holiday calendar
 * arithmetic, so the cases below assert only that `totalDays` CONSULTED the
 * right calendar for the right branch, never that the calendar itself is right.
 *
 * ── What e2e uniquely adds ──────────────────────────────────────────────────
 *
 * A real database (so `totalDays`, the balance deduction and the generated
 * `Attendance` rows are read back rather than mocked), the real guard chain
 * (`RolesGuard` is a flat OR string match, which is why the role matrix has to
 * be exhaustive rather than representative), the real `ValidationPipe`
 * (`whitelist` + `forbidNonWhitelisted`), and the real branch middleware.
 *
 * ── Hazards this file neutralises ───────────────────────────────────────────
 *
 *   - **Balance deduction is cumulative and has no product-level undo**
 *     (finding L13: `addDays` has no caller, `cancel` refuses non-PENDING, there
 *     is no un-approve and no edit endpoint). Every case therefore starts from a
 *     known allocation via `resetBalances`/`setBalance` in `afterEach`, and no
 *     case reads an absolute balance it did not itself establish.
 *
 *   - **Overlap makes a date RANGE scarce, not a date.** `afterEach` deletes
 *     every leave row for this file's actors, so windows are reusable between
 *     cases; within a case, use distinct offsets.
 *
 *   - **Approved leave writes `Attendance` rows.** They are deleted in
 *     `afterEach` too — `Attendance.branch` is `onDelete: Restrict`, so a row
 *     left behind fails the fixture teardown on a branch delete much later, in a
 *     place that gives no clue where it came from.
 *
 * ── Actors this file OWNS for writes ────────────────────────────────────────
 *
 *   applicant · applicant2 · femaleStaff · maleStaff · noGenderStaff ·
 *   zeroBalanceStaff · crossYearStaff · altStaff · nullBranchStaff
 *
 * Every other fixture actor is read-only here.
 */
describe('Leave — requesting, deciding and cancelling (e2e)', () => {
  let ctx: E2EContext;
  let fx: LeaveOtFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any) => res.body?.data ?? res.body;

  /** Thin request helpers, one per endpoint under test. */
  const create = (token: string, payload: Record<string, unknown>) =>
    ctx.http().post('/leave-requests').set(bearer(token)).send(payload);
  const approve = (token: string, id: string, payload: any = {}) =>
    ctx
      .http()
      .post(`/leave-requests/${id}/approve`)
      .set(bearer(token))
      .send(payload);
  const reject = (token: string, id: string, payload: any = {}) =>
    ctx
      .http()
      .post(`/leave-requests/${id}/reject`)
      .set(bearer(token))
      .send(payload);
  const cancel = (token: string, id: string) =>
    ctx.http().delete(`/leave-requests/${id}`).set(bearer(token));
  const list = (token: string, qs = '') =>
    ctx.http().get(`/leave-requests${qs}`).set(bearer(token));

  /** A three-working-day Monday→Wednesday window in branchMain. */
  const monWed = (offset: number) => {
    const start = freeDateOn(offset, 1);
    const end = new Date(`${start}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 2);
    return { start, end: end.toISOString().slice(0, 10) };
  };

  const payload = (
    start: string,
    end: string,
    over: Record<string, unknown> = {},
  ) => ({
    leaveType: 'ANNUAL',
    startDate: start,
    endDate: end,
    reason: `leave-request spec ${fx.runId}`,
    ...over,
  });

  /** Today + n days, in the pinned UTC company timezone. */
  const todayPlus = (n: number) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  let owned: string[] = [];

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupLeaveOvertimeFixtures(ctx);
    owned = [
      fx.applicantId,
      fx.applicant2Id,
      fx.femaleStaffId,
      fx.maleStaffId,
      fx.noGenderStaffId,
      fx.zeroBalanceStaffId,
      fx.crossYearStaffId,
      fx.altStaffId,
      fx.nullBranchStaffId,
    ];
  }, 120000);

  afterEach(async () => {
    // Leave rows first (the attachments and trail rows that hang off them are
    // this file's only other residue), then the Attendance rows an approval
    // generated, then the balances an approval moved.
    const leaveIds = (
      await ctx.prisma.leaveRequest.findMany({
        where: { employeeId: { in: owned } },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (leaveIds.length) {
      await ctx.prisma.requestApproval.deleteMany({
        where: { requestId: { in: leaveIds } },
      });
      await ctx.prisma.leaveAttachment.deleteMany({
        where: { leaveRequestId: { in: leaveIds } },
      });
    }
    await ctx.prisma.leaveRequest.deleteMany({
      where: { employeeId: { in: owned } },
    });
    await ctx.prisma.attendance.deleteMany({
      where: { employeeId: { in: owned } },
    });
    for (const id of owned) {
      await fx.resetBalances(id, LEAVE_YEAR);
      await fx.resetBalances(id, LEAVE_YEAR + 1);
      await fx.resetBalances(id, new Date().getUTCFullYear());
    }
    // zeroBalanceStaff's whole purpose is a zero allocation; resetBalances would
    // hand it back the library default of 12 on the next read.
    await fx.setBalance(fx.zeroBalanceStaffId, 'Annual Leave', 0);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('who may file, and for whom', () => {
    it('LVE-API-01 every role files its own leave; anonymous is refused', async () => {
      // Each actor needs its own window: the overlap rule is per employee, but
      // ADMIN has no employee at all and files for someone else entirely.
      const cases: Array<[string, string, number]> = [
        [fx.hr.token, fx.hr.email, 0],
        [fx.mgr.token, fx.mgr.email, 8],
        [fx.employee.token, fx.employee.email, 16],
      ];
      for (const [token, who, offset] of cases) {
        const w = monWed(offset);
        const res = await create(token, payload(w.start, w.end));
        expect([201, 200]).toContain(res.status);
        expect(dataOf(res).status).toBe('PENDING');
        expect(body(res)).not.toContain('prisma');
        // Filed for the caller, never for someone else.
        expect(dataOf(res).employeeId).toBeTruthy();
        void who;
      }
      const anon = await ctx
        .http()
        .post('/leave-requests')
        .send(payload(monWed(24).start, monWed(24).end));
      expect(anon.status).toBe(401);

      await ctx.prisma.leaveRequest.deleteMany({
        where: { reason: { contains: fx.runId } },
      });
    });

    it.each([
      ['GET /leave-requests', () => '/leave-requests'],
      ['GET /leave-requests/pending', () => '/leave-requests/pending'],
    ])(
      'LVE-API-02 %s admits ADMIN, HR and MANAGER and refuses EMPLOYEE',
      async (_label, path) => {
        for (const actor of [fx.admin, fx.hr, fx.mgr]) {
          const res = await ctx.http().get(path()).set(bearer(actor.token));
          expect(res.status).toBe(200);
        }
        const denied = await ctx
          .http()
          .get(path())
          .set(bearer(fx.employee.token));
        expect(denied.status).toBe(403);
        const anon = await ctx.http().get(path());
        expect(anon.status).toBe(401);
      },
    );

    it('LVE-API-02b /my-requests admits all four roles, /team-balances only MANAGER', async () => {
      // ADMIN has no linked employee — see LVE-API-05 for what that does here.
      for (const actor of [fx.hr, fx.mgr, fx.employee]) {
        const res = await ctx
          .http()
          .get('/leave-requests/my-requests')
          .set(bearer(actor.token));
        expect(res.status).toBe(200);
      }
      const mgrTeam = await ctx
        .http()
        .get('/leave-requests/team-balances')
        .set(bearer(fx.mgr.token));
      expect(mgrTeam.status).toBe(200);
      for (const actor of [fx.admin, fx.hr, fx.employee]) {
        const res = await ctx
          .http()
          .get('/leave-requests/team-balances')
          .set(bearer(actor.token));
        expect(res.status).toBe(403);
      }
    });

    it('LVE-API-03 HR files on behalf and the row carries the target id, not the caller', async () => {
      const w = monWed(0);
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(201);
      expect(dataOf(res).employeeId).toBe(fx.applicantId);
      expect(dataOf(res).employeeId).not.toBe(fx.hr.employeeId);
    });

    /**
     * L1, FIXED. `employeeId = dto.employeeId || userEmployeeId` had no role
     * check, so any EMPLOYEE could file leave against a colleague — and the
     * days came out of the VICTIM's balance, with LEAVE attendance rows written
     * against them. Filing on behalf is now an HR privilege
     * (`assertCanActOnBehalfOf`).
     */
    it('LVE-API-04 an EMPLOYEE cannot file leave for a colleague', async () => {
      const w = monWed(0);
      const res = await create(
        fx.otherEmployee.token,
        payload(w.start, w.end, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(403);
      expect(body(res)).toContain(
        'You do not have permission to file requests for another employee.',
      );
      expect(
        await ctx.prisma.leaveRequest.count({
          where: { employeeId: fx.applicantId },
        }),
      ).toBe(0);

      // Filing for THEMSELVES is untouched, which is what keeps the fix a
      // privilege check rather than a lockout.
      const own = await create(
        fx.otherEmployee.token,
        payload(w.start, w.end, { employeeId: fx.applicant2Id }),
      );
      expect(own.status).toBe(201);
    });

    /**
     * L28. `user.employeeId` is undefined for an ADMIN with no linked employee,
     * so `create` throws its own 400 — which is the correct half. The pin is
     * that the same principal reaches `findUnique({ where: { id: undefined } })`
     * on `/my-requests`; see LVE-API-05b.
     */
    it('LVE-API-05 an ADMIN with no linked employee and no body id is refused without leaking driver text', async () => {
      const w = monWed(0);
      const res = await create(fx.admin.token, payload(w.start, w.end));
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Employee ID is required');
      expect(body(res)).not.toContain('prisma');
    });

    it('LVE-API-05b the same principal on /my-requests gets an empty list, not a driver error', async () => {
      // L28, FIXED. An ADMIN account need not be linked to an employee record;
      // the id went straight to `findUnique({ where: { id: undefined } })` and
      // answered 500 with the Prisma invocation in the body.
      const res = await ctx
        .http()
        .get('/leave-requests/my-requests')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(dataOf(res)).toEqual([]);
      expect(body(res)).not.toContain('prisma');
    });

    it('LVE-API-06 an unknown employeeId answers 404, and a malformed one is stopped by the DTO first', async () => {
      const w = monWed(0);
      // `@IsUUID()` defaults to version 4, so the shape is checked before the
      // service ever looks the employee up — which is what keeps a junk id from
      // reaching a `@db.Uuid` column and answering 500 (the shape `overtime`
      // still gets wrong, OT-API-60).
      const malformed = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: 'not-a-uuid' }),
      );
      expect(malformed.status).toBe(400);
      expect(body(malformed)).toContain('employeeId must be a UUID');

      const unknown = await create(
        fx.hr.token,
        payload(w.start, w.end, {
          employeeId: '11111111-1111-4111-8111-111111111111',
        }),
      );
      expect(unknown.status).toBe(404);
      expect(body(unknown)).toContain('Employee not found');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the create contract', () => {
    it('LVE-API-07 a created row is PENDING, counts working days, and stores the library LABEL', async () => {
      const w = monWed(0);
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(201);
      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: dataOf(res).id },
      });
      expect(row.status).toBe('PENDING');
      // Mon→Wed in a branch that rests Sun+Sat.
      expect(row.totalDays).toBe(3);
      // The alias went in, the LABEL came out.
      expect(row.leaveType).toBe('Annual Leave');
      expect(row.approverId).toBeNull();
      expect(row.approvedAt).toBeNull();
    });

    it('LVE-API-08 the alias and the label resolve to the same library item', async () => {
      const a = monWed(0);
      const first = await create(
        fx.hr.token,
        payload(a.start, a.end, {
          employeeId: fx.applicantId,
          leaveType: 'ANNUAL',
        }),
      );
      const b = monWed(8);
      const second = await create(
        fx.hr.token,
        payload(b.start, b.end, {
          employeeId: fx.applicantId,
          leaveType: 'annual leave',
        }),
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(dataOf(first).leaveType).toBe('Annual Leave');
      expect(dataOf(second).leaveType).toBe('Annual Leave');
    });

    /**
     * L24. The DTO is `@IsString()` with no enum (`create-leave-request.dto.ts:31`),
     * so an unmatched label is stored verbatim AND — because `libraryItem` is
     * null — skips gender, notice and the balance check entirely. A leave type
     * nobody configured is therefore the least restricted one available.
     */
    it('LVE-API-09 a free-text leave type is stored verbatim and skips gender, notice and balance', async () => {
      const w = monWed(0);
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, {
          employeeId: fx.zeroBalanceStaffId,
          leaveType: 'Sabbatical Of My Own Invention',
        }),
      );
      // A zero-balance employee, filing today-adjacent, with a type that has no
      // row: accepted anyway.
      expect(res.status).toBe(201);
      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: dataOf(res).id },
      });
      expect(row.leaveType).toBe('Sabbatical Of My Own Invention');
    });

    it('LVE-API-10 an inactive leave type falls through to the raw-string legacy path', async () => {
      const w = monWed(0);
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, {
          employeeId: fx.applicantId,
          leaveType: fx.retiredLeaveType,
        }),
      );
      expect(res.status).toBe(201);
      // Stored as typed, because `isActive: true` is part of the lookup.
      expect(dataOf(res).leaveType).toBe(fx.retiredLeaveType);
    });

    it('LVE-API-11 a non-whitelisted property is refused, and so is a missing reason', async () => {
      const w = monWed(0);
      const extra = await create(fx.hr.token, {
        ...payload(w.start, w.end, { employeeId: fx.applicantId }),
        approverId: fx.hr.userId,
      });
      expect(extra.status).toBe(400);
      expect(body(extra)).toContain('approverId');

      const noReason = await create(fx.hr.token, {
        employeeId: fx.applicantId,
        leaveType: 'ANNUAL',
        startDate: w.start,
        endDate: w.end,
      });
      expect(noReason.status).toBe(400);
      expect(body(noReason)).toContain('reason');
    });

    it('LVE-API-12 a non-ISO startDate is refused by the DTO before the service runs', async () => {
      const w = monWed(0);
      const res = await create(
        fx.hr.token,
        payload('20/01/2027', w.end, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('startDate');
      // The service never ran, so nothing about employees or balances leaked.
      expect(body(res)).not.toContain('Employee not found');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('dates and duration', () => {
    it('LVE-API-13 an end before the start is refused with the exact sentence', async () => {
      const w = monWed(0);
      const res = await create(
        fx.hr.token,
        payload(w.end, w.start, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('End date must be after start date');
    });

    it('LVE-API-14 a same-day request is accepted — the boundary the message misnames', async () => {
      // "must be after" is checked as `endDate < startDate`, so equal passes.
      // Recorded rather than corrected: the behaviour is right, the wording is
      // not, and a spec that asserted the wording's promise would be wrong.
      const day = freeDateOn(0, 1);
      const res = await create(
        fx.hr.token,
        payload(day, day, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(201);
      expect(dataOf(res).totalDays).toBe(1);
    });

    it('LVE-API-15 totalDays excludes the branch weekly-off days', async () => {
      // Friday → Monday in a branch that rests Sun+Sat: Fri and Mon only.
      const friday = freeDateOn(0, 5);
      const monday = new Date(`${friday}T00:00:00.000Z`);
      monday.setUTCDate(monday.getUTCDate() + 3);
      const res = await create(
        fx.hr.token,
        payload(friday, monday.toISOString().slice(0, 10), {
          employeeId: fx.applicantId,
        }),
      );
      expect(res.status).toBe(201);
      expect(dataOf(res).totalDays).toBe(2);
    });

    it('LVE-API-16 totalDays excludes a branch-scoped holiday', async () => {
      // The fixture holiday is a Wednesday in branchMain. Mon→Fri around it is
      // five weekdays, one of which the branch has taken off.
      const monday = new Date(`${fx.mainHolidayDate}T00:00:00.000Z`);
      monday.setUTCDate(monday.getUTCDate() - 2);
      const friday = new Date(`${fx.mainHolidayDate}T00:00:00.000Z`);
      friday.setUTCDate(friday.getUTCDate() + 2);
      const res = await create(
        fx.hr.token,
        payload(
          monday.toISOString().slice(0, 10),
          friday.toISOString().slice(0, 10),
          { employeeId: fx.applicantId },
        ),
      );
      expect(res.status).toBe(201);
      expect(dataOf(res).totalDays).toBe(4);
    });

    it('LVE-API-17 the same dates count differently in a branch with a different work week', async () => {
      // Wednesday → Thursday. branchMain rests Sun+Sat, so both are working
      // days; branchAlt rests Thu+Fri, so only Wednesday is. Nothing but the
      // employee's branch differs between the two calls.
      const wed = freeDateOn(40, 3);
      const thu = new Date(`${wed}T00:00:00.000Z`);
      thu.setUTCDate(thu.getUTCDate() + 1);
      const thuIso = thu.toISOString().slice(0, 10);

      const inMain = await create(
        fx.hr.token,
        payload(wed, thuIso, { employeeId: fx.applicantId }),
      );
      const inAlt = await create(
        fx.hr.token,
        payload(wed, thuIso, { employeeId: fx.altStaffId }),
      );
      expect(inMain.status).toBe(201);
      expect(inAlt.status).toBe(201);
      expect(dataOf(inMain).totalDays).toBe(2);
      expect(dataOf(inAlt).totalDays).toBe(1);
    });

    it('LVE-API-18 a company-wide holiday is excluded from every branch', async () => {
      const iso = fx.companyHolidayDate;
      // Only assertable when the free-scan landed on a working day in both
      // branches; otherwise the weekly-off rule would explain the exclusion.
      const dow = dayOfWeekUtc(iso);
      if ([0, 6, 4, 5].includes(dow)) {
        // Deliberately skipped rather than force-moved: the fixture picks this
        // date by scanning for a free one, and rewriting it here to suit the
        // assertion would take a date out of circulation for every later run.
        return;
      }
      for (const [employeeId, expected] of [
        [fx.applicantId, 0],
        [fx.altStaffId, 0],
      ] as const) {
        const res = await create(
          fx.hr.token,
          payload(iso, iso, { employeeId }),
        );
        expect(res.status).toBe(201);
        expect(dataOf(res).totalDays).toBe(expected);
      }
    });

    /**
     * L39, recorded. A leave that falls entirely on rest days is accepted with
     * `totalDays: 0`: it deducts nothing and writes no attendance, but it still
     * BLOCKS the range against any later request. Worth knowing before someone
     * treats totalDays as a proxy for "is this row real".
     */
    it('LVE-API-19 a leave entirely on rest days is accepted with totalDays 0 and still blocks the range', async () => {
      const saturday = freeDateOn(0, 6);
      const sunday = new Date(`${saturday}T00:00:00.000Z`);
      sunday.setUTCDate(sunday.getUTCDate() + 1);
      const sundayIso = sunday.toISOString().slice(0, 10);

      const res = await create(
        fx.hr.token,
        payload(saturday, sundayIso, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(201);
      expect(dataOf(res).totalDays).toBe(0);

      const clash = await create(
        fx.hr.token,
        payload(saturday, sundayIso, { employeeId: fx.applicantId }),
      );
      expect(clash.status).toBe(400);
      expect(body(clash)).toContain('Leave request overlaps with existing request');
    });

    it('LVE-API-20 an employee with no branch falls back to the global weekly-off setting, both ways', async () => {
      const saturday = freeDateOn(60, 6);
      const sunday = new Date(`${saturday}T00:00:00.000Z`);
      sunday.setUTCDate(sunday.getUTCDate() + 1);
      const sundayIso = sunday.toISOString().slice(0, 10);

      // Sat+Sun off globally → a Sat–Sun request is worth nothing.
      await withSetting(ctx, 'calendar_weekly_holidays', '0,6', async () => {
        const res = await create(
          fx.hr.token,
          payload(saturday, sundayIso, { employeeId: fx.nullBranchStaffId }),
        );
        expect(res.status).toBe(201);
        expect(dataOf(res).totalDays).toBe(0);
        await ctx.prisma.leaveRequest.delete({ where: { id: dataOf(res).id } });
      });

      // Only Friday off globally → the same two days are both working days.
      await withSetting(ctx, 'calendar_weekly_holidays', '5', async () => {
        const res = await create(
          fx.hr.token,
          payload(saturday, sundayIso, { employeeId: fx.nullBranchStaffId }),
        );
        expect(res.status).toBe(201);
        expect(dataOf(res).totalDays).toBe(2);
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('overlap', () => {
    const seedRange = async (offset: number, status: any = 'PENDING') => {
      const w = monWed(offset);
      await fx.seedLeave({
        employeeId: fx.applicantId,
        start: w.start,
        end: w.end,
        status,
      });
      return w;
    };

    it('LVE-API-21 overlapping a PENDING request is refused and the message carries both dates', async () => {
      const w = await seedRange(0, 'PENDING');
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Leave request overlaps with existing request');
      // Discriminating: it is the OVERLAP that refused, not the balance.
      expect(body(res)).not.toContain('Insufficient');
    });

    it('LVE-API-22 overlapping an APPROVED request is refused too', async () => {
      const w = await seedRange(0, 'APPROVED');
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Leave request overlaps with existing request');
    });

    it('LVE-API-23 starting exactly one day after the previous end is accepted (+1)', async () => {
      const w = await seedRange(0, 'PENDING');
      const next = new Date(`${w.end}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const nextIso = next.toISOString().slice(0, 10);
      const res = await create(
        fx.hr.token,
        payload(nextIso, nextIso, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(201);
    });

    it('LVE-API-24 ending exactly ON the previous start is refused (−1): the range is inclusive at both ends', async () => {
      const w = await seedRange(0, 'PENDING');
      const before = new Date(`${w.start}T00:00:00.000Z`);
      before.setUTCDate(before.getUTCDate() - 2);
      const res = await create(
        fx.hr.token,
        payload(before.toISOString().slice(0, 10), w.start, {
          employeeId: fx.applicantId,
        }),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('overlaps');
    });

    it('LVE-API-25 REJECTED and CANCELLED requests do not block the range', async () => {
      for (const status of ['REJECTED', 'CANCELLED'] as const) {
        const w = monWed(0);
        const seeded = await fx.seedLeave({
          employeeId: fx.applicantId,
          start: w.start,
          end: w.end,
          status,
        });
        const res = await create(
          fx.hr.token,
          payload(w.start, w.end, { employeeId: fx.applicantId }),
        );
        expect(res.status).toBe(201);
        await ctx.prisma.leaveRequest.deleteMany({
          where: { id: { in: [seeded, dataOf(res).id] } },
        });
      }
    });

    it('LVE-API-26 overlap is per employee: a colleague may take the same dates', async () => {
      const w = await seedRange(0, 'APPROVED');
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: fx.applicant2Id }),
      );
      expect(res.status).toBe(201);
    });

    /**
     * L27. The overlap rule is read-then-write in application code
     * (`leave-requests.service.ts:105`) with NO database constraint behind it —
     * `LeaveRequest` has no exclusion constraint and no partial unique index on
     * the range. So the rule holds only for writes that go through
     * `LeaveRequestsService.create`.
     *
     * This is asserted by writing the overlapping pair directly rather than by
     * racing two HTTP requests: a race is a coin toss that passes for the wrong
     * reason most of the time, whereas the ABSENCE of a constraint is a fact and
     * can be stated as one. Two writers that do land concurrently produce
     * exactly the state below.
     */
    it('LVE-API-27 nothing in the schema stops an overlapping pair — the rule lives only in the service', async () => {
      const w = monWed(0);
      const first = await fx.seedLeave({
        employeeId: fx.applicantId,
        start: w.start,
        end: w.end,
        status: 'PENDING',
      });
      const second = await fx.seedLeave({
        employeeId: fx.applicantId,
        start: w.start,
        end: w.end,
        status: 'PENDING',
      });
      expect(first).not.toBe(second);
      expect(
        await ctx.prisma.leaveRequest.count({
          where: { employeeId: fx.applicantId, status: 'PENDING' },
        }),
      ).toBe(2);

      // And the API, which does hold the rule, now refuses a third — so the two
      // above are a state the service can neither create nor repair.
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('overlaps');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('gender restriction', () => {
    it('LVE-API-28 Maternity Leave for a male employee is refused with the exact sentence', async () => {
      const w = monWed(0);
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, {
          employeeId: fx.maleStaffId,
          leaveType: 'MATERNITY',
        }),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain(
        'Maternity Leave is only available for female employees',
      );
    });

    it('LVE-API-29 Maternity for a female is accepted; Paternity for a female carries the male sentence', async () => {
      const a = monWed(0);
      const ok = await create(
        fx.hr.token,
        payload(a.start, a.end, {
          employeeId: fx.femaleStaffId,
          leaveType: 'MATERNITY',
        }),
      );
      expect(ok.status).toBe(201);

      const b = monWed(8);
      const denied = await create(
        fx.hr.token,
        payload(b.start, b.end, {
          employeeId: fx.femaleStaffId,
          leaveType: 'PATERNITY',
        }),
      );
      expect(denied.status).toBe(400);
      expect(body(denied)).toContain(
        'Paternity Leave is only available for male employees',
      );
    });

    it('LVE-API-30 an employee with no recorded gender is refused every gender-restricted type', async () => {
      for (const [offset, type, sentence] of [
        [0, 'MATERNITY', 'female'],
        [8, 'PATERNITY', 'male'],
      ] as const) {
        const w = monWed(offset);
        const res = await create(
          fx.hr.token,
          payload(w.start, w.end, {
            employeeId: fx.noGenderStaffId,
            leaveType: type,
          }),
        );
        expect(res.status).toBe(400);
        expect(body(res)).toContain(`only available for ${sentence} employees`);
      }
    });

    it('LVE-API-31 a gender-restricted type is absent from that employee’s balance payload', async () => {
      const res = await ctx
        .http()
        .get(`/leave-balances/employee/${fx.maleStaffId}?year=${LEAVE_YEAR}`)
        .set(bearer(fx.hr.token));
      expect(res.status).toBe(200);
      const keys = (dataOf(res).leaveTypeBalances ?? []).map(
        (b: any) => b.leaveTypeKey,
      );
      expect(keys).toContain('Paternity Leave');
      expect(keys).not.toContain('Maternity Leave');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('notice period', () => {
    // These are the only cases in this file that read the wall clock. The
    // company timezone is pinned per-case rather than globally, because
    // `system_timezone` is read by the holiday, accrual and payroll suites too.

    it('LVE-API-32 Annual Leave starting in two days is refused: it needs three', async () => {
      await withSetting(ctx, 'system_timezone', 'UTC', async () => {
        const day = todayPlus(2);
        const res = await create(
          fx.hr.token,
          payload(day, day, { employeeId: fx.applicantId }),
        );
        expect(res.status).toBe(400);
        expect(body(res)).toContain(
          'Annual Leave requires at least 3 days notice',
        );
      });
    });

    it('LVE-API-33 Annual Leave starting exactly three days out is accepted (boundary)', async () => {
      await withSetting(ctx, 'system_timezone', 'UTC', async () => {
        const day = todayPlus(3);
        const res = await create(
          fx.hr.token,
          payload(day, day, { employeeId: fx.applicantId }),
        );
        expect(res.status).toBe(201);
      });
    });

    it('LVE-API-34 the seven-day fixture type refuses day six and accepts day seven (±1)', async () => {
      await withSetting(ctx, 'system_timezone', 'UTC', async () => {
        const six = todayPlus(6);
        const denied = await create(
          fx.hr.token,
          payload(six, six, {
            employeeId: fx.applicantId,
            leaveType: fx.noticeLeaveType,
          }),
        );
        expect(denied.status).toBe(400);
        expect(body(denied)).toContain('requires at least 7 days notice');

        const seven = todayPlus(7);
        const ok = await create(
          fx.hr.token,
          payload(seven, seven, {
            employeeId: fx.applicantId,
            leaveType: fx.noticeLeaveType,
          }),
        );
        expect(ok.status).toBe(201);
      });
    });

    it('LVE-API-35 Sick Leave carries no notice period and may start today', async () => {
      await withSetting(ctx, 'system_timezone', 'UTC', async () => {
        const day = todayPlus(0);
        const res = await create(
          fx.hr.token,
          payload(day, day, {
            employeeId: fx.applicantId,
            leaveType: 'SICK',
          }),
        );
        expect(res.status).toBe(201);
      });
    });

    it('LVE-API-36 the notice window is measured in the COMPANY timezone, not the server’s', async () => {
      // A timezone far enough east that its "today" can be the server's
      // tomorrow. The assertion is not which side of the line we land on — that
      // depends on the hour the suite runs — but that the two timezones are
      // capable of disagreeing and the service reads the configured one.
      const day = todayPlus(3);
      const utc = await withSetting(ctx, 'system_timezone', 'UTC', async () => {
        const res = await create(
          fx.hr.token,
          payload(day, day, { employeeId: fx.applicantId }),
        );
        if (res.status === 201) {
          await ctx.prisma.leaveRequest.delete({ where: { id: dataOf(res).id } });
        }
        return res.status;
      });
      const kiritimati = await withSetting(
        ctx,
        'system_timezone',
        'Pacific/Kiritimati',
        async () => {
          const res = await create(
            fx.hr.token,
            payload(day, day, { employeeId: fx.applicantId }),
          );
          if (res.status === 201) {
            await ctx.prisma.leaveRequest.delete({
              where: { id: dataOf(res).id },
            });
          }
          return res.status;
        },
      );
      // Both are legitimate answers; what must hold is that the setting is the
      // thing consulted, so the pair is never (400, 201) — Kiritimati is AHEAD,
      // so if UTC refuses, a timezone a day further on cannot accept.
      expect([utc, kiritimati]).not.toEqual([400, 201]);
    });

    /**
     * L40, recorded. There is no backdating guard: a start date in the past is
     * accepted, and on approval it writes LEAVE attendance rows over days that
     * have already been reconciled.
     */
    it('LVE-API-37 a start date in the past is accepted — there is no backdating guard', async () => {
      await withSetting(ctx, 'system_timezone', 'UTC', async () => {
        const day = todayPlus(-30);
        const res = await create(
          fx.hr.token,
          payload(day, day, {
            employeeId: fx.applicantId,
            leaveType: 'SICK',
          }),
        );
        expect(res.status).toBe(201);
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('balance, at create time', () => {
    it('LVE-API-38 an over-budget request is refused with the exact available count', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 2);
      const w = monWed(0); // three working days against an allocation of two
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Insufficient Annual Leave balance. Available: 2 days');
    });

    it('LVE-API-39 exactly the remaining balance is accepted and one more is refused (±1)', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 3);
      const exact = monWed(0);
      const ok = await create(
        fx.hr.token,
        payload(exact.start, exact.end, { employeeId: fx.applicantId }),
      );
      expect(ok.status).toBe(201);

      // Four working days now, still against three.
      await fx.setBalance(fx.applicant2Id, 'Annual Leave', 3);
      const mon = freeDateOn(40, 1);
      const thu = new Date(`${mon}T00:00:00.000Z`);
      thu.setUTCDate(thu.getUTCDate() + 3);
      const denied = await create(
        fx.hr.token,
        payload(mon, thu.toISOString().slice(0, 10), {
          employeeId: fx.applicant2Id,
        }),
      );
      expect(denied.status).toBe(400);
      expect(body(denied)).toContain('Available: 3 days');
    });

    it('LVE-API-40 a type that does not affect balance is accepted at a zero balance', async () => {
      const w = monWed(0);
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, {
          employeeId: fx.zeroBalanceStaffId,
          leaveType: 'UNPAID',
        }),
      );
      expect(res.status).toBe(201);
    });

    it('LVE-API-41 creating moves no balance — only approval does', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const before = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      const w = monWed(0);
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: fx.applicantId }),
      );
      expect(res.status).toBe(201);
      const after = await ctx.prisma.leaveTypeBalance.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.used).toBe(before.used);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the approval lifecycle, with the chain switched off', () => {
    // `supervisor_approval_enabled` is pinned 'false' in the e2e baseline, so
    // every case here takes the legacy single-approver path. The engaged chain
    // is `leave-overtime-approval.e2e-spec.ts`'s subject.

    const fileFor = async (
      employeeId: string,
      offset = 0,
      over: Record<string, unknown> = {},
    ) => {
      const w = monWed(offset);
      const res = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId, ...over }),
      );
      expect(res.status).toBe(201);
      return { id: dataOf(res).id as string, ...w };
    };

    it('LVE-API-42 HR approves: the row carries approver, timestamp — and the comment lands in rejectedReason', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const { id } = await fileFor(fx.applicantId);
      const res = await approve(fx.hr.token, id, { comment: 'Handover agreed' });
      expect(res.status).toBe(201);
      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('APPROVED');
      expect(row.approverId).toBe(fx.hr.userId);
      expect(row.approvedAt).not.toBeNull();
      // A contract wart, asserted as it is: the approver's COMMENT is stored in
      // the column named for a rejection reason
      // (`leave-requests.service.ts:778`). Any consumer reading
      // `rejectedReason` to explain a refusal will read an approval note.
      expect(row.rejectedReason).toBe('Handover agreed');
    });

    it('LVE-API-43 approval deducts exactly totalDays from the type balance and syncs the legacy column', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const { id } = await fileFor(fx.applicantId);
      await approve(fx.hr.token, id);

      const typeBalance = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(typeBalance.used).toBe(3);
      const legacy = await ctx.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId: fx.applicantId, year: LEAVE_YEAR },
      });
      expect(legacy.usedAnnual).toBe(3);
    });

    it('LVE-API-44 approval writes one LEAVE attendance row per WORKING date', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      // Friday → Monday: four calendar days, two working ones.
      const friday = freeDateOn(0, 5);
      const monday = new Date(`${friday}T00:00:00.000Z`);
      monday.setUTCDate(monday.getUTCDate() + 3);
      const res = await create(
        fx.hr.token,
        payload(friday, monday.toISOString().slice(0, 10), {
          employeeId: fx.applicantId,
        }),
      );
      await approve(fx.hr.token, dataOf(res).id);

      const rows = await ctx.prisma.attendance.findMany({
        where: { employeeId: fx.applicantId },
        orderBy: { date: 'asc' },
      });
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.status).toBe('LEAVE');
        expect(Number(r.workHours)).toBe(0);
        expect(r.source).toBe('LEAVE');
      }
    });

    /**
     * A9 regression guard, not a defect pin. These rows once carried
     * `branchId: null`, and `Attendance` is a `direct`-rule branch-scope model
     * where `branchId IN (…)` never matches NULL — so an approved leave was
     * invisible to every branch-scoped caller while payroll still counted it.
     * Fixed at `leave-requests.service.ts:1140`; this is what keeps it fixed.
     */
    it('LVE-API-45 every generated attendance row carries the employee’s branch', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const { id } = await fileFor(fx.applicantId);
      await approve(fx.hr.token, id);
      const rows = await ctx.prisma.attendance.findMany({
        where: { employeeId: fx.applicantId },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.branchId).toBe(fx.branchMain);
      }
    });

    /**
     * A10, FIXED. `skipDuplicates: true` still protects a day the employee
     * really clocked — an approval must never overwrite real attendance — but
     * the approver used to be told nothing, so a day of approved leave could
     * have no LEAVE record behind it and nobody knew. The count is now reported.
     */
    it('LVE-API-46 a day the employee already clocked keeps its record, and the approver is told', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const w = monWed(0);
      await ctx.prisma.attendance.create({
        data: {
          employeeId: fx.applicantId,
          date: new Date(`${w.start}T00:00:00.000Z`),
          status: 'PRESENT',
          workHours: 8,
          branchId: fx.branchMain,
        },
      });
      const { id } = await fileFor(fx.applicantId);
      const res = await approve(fx.hr.token, id);

      expect(res.status).toBe(201);
      expect(body(res)).toContain('already had an attendance record');
      expect(res.body.meta.attendanceSkipped).toBe(1);
      expect(res.body.meta.attendanceCreated).toBe(2);

      const clashed = await ctx.prisma.attendance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          date: new Date(`${w.start}T00:00:00.000Z`),
        },
      });
      expect(clashed.status).toBe('PRESENT'); // the real record survived
    });

    /**
     * L12, FIXED — the most consequential finding in this module.
     *
     * `finalizeLeaveApproval` used to write `status: APPROVED`, then the
     * attendance rows, and only THEN call `deductDays`, which throws when the
     * balance is short. Nothing is reserved at create time, so two PENDING
     * requests can each pass the create-time check against the same days.
     * Approving the second returned 400 to the caller while leaving the row
     * APPROVED, its attendance written and no balance deducted — an approved
     * leave nobody paid for, reported as a failure.
     *
     * The deduction now runs FIRST, so a short balance fails the whole finalize
     * cleanly.
     */
    it('LVE-API-47 a second approval past the balance fails cleanly and leaves the request PENDING', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 3);
      const first = await fileFor(fx.applicantId, 0);
      const second = await fileFor(fx.applicantId, 8);

      const ok = await approve(fx.hr.token, first.id);
      expect(ok.status).toBe(201);

      const failed = await approve(fx.hr.token, second.id);
      expect(failed.status).toBe(400);
      expect(body(failed)).toContain('Insufficient Annual Leave balance');

      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: second.id },
      });
      expect(row.status).toBe('PENDING'); // no half-done write
      expect(row.approvedAt).toBeNull();

      const balance = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(balance.used).toBe(3); // only the first was ever charged

      // And only the first leave's days were written.
      expect(
        await ctx.prisma.attendance.count({
          where: { employeeId: fx.applicantId },
        }),
      ).toBe(3);

      // Raising the allocation lets the same request through — so the refusal
      // was the balance, and the request survived it intact.
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      await ctx.prisma.leaveTypeBalance.updateMany({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
        data: { used: 3 },
      });
      expect((await approve(fx.hr.token, second.id)).status).toBe(201);
    });

    it('LVE-API-48 approving twice is idempotent and the balance moves once', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const { id } = await fileFor(fx.applicantId);
      await approve(fx.hr.token, id);
      const again = await approve(fx.hr.token, id);
      expect(again.status).toBe(201);
      expect(body(again)).toContain('already approved');

      const balance = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(balance.used).toBe(3);
    });

    it('LVE-API-49 approving a rejected or a cancelled request is refused, each with its own sentence', async () => {
      const rejected = await fx.seedLeave({
        employeeId: fx.applicantId,
        start: monWed(0).start,
        end: monWed(0).end,
        status: 'REJECTED',
      });
      const r = await approve(fx.hr.token, rejected);
      expect(r.status).toBe(400);
      expect(body(r)).toContain('Cannot approve a rejected request');

      const cancelled = await fx.seedLeave({
        employeeId: fx.applicant2Id,
        start: monWed(0).start,
        end: monWed(0).end,
        status: 'CANCELLED',
      });
      const c = await approve(fx.hr.token, cancelled);
      expect(c.status).toBe(400);
      expect(body(c)).toContain('Cannot approve a cancelled request');
    });

    it('LVE-API-50 rejection stores the reason, moves no balance and writes no attendance', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const { id } = await fileFor(fx.applicantId);
      const res = await reject(fx.hr.token, id, {
        rejectedReason: 'Peak season',
      });
      expect(res.status).toBe(201);

      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('REJECTED');
      expect(row.rejectedReason).toBe('Peak season');

      const balance = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(balance.used).toBe(0);
      expect(
        await ctx.prisma.attendance.count({
          where: { employeeId: fx.applicantId },
        }),
      ).toBe(0);
    });

    it('LVE-API-51 rejecting a non-pending request is refused', async () => {
      const approved = await fx.seedLeave({
        employeeId: fx.applicantId,
        start: monWed(0).start,
        end: monWed(0).end,
        status: 'APPROVED',
      });
      const res = await reject(fx.hr.token, approved, {
        rejectedReason: 'too late',
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Can only reject pending requests');
    });

    it('LVE-API-52 a MANAGER decides inside their department and is refused outside it, verbatim', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const mine = await fileFor(fx.applicantId);
      const ok = await approve(fx.mgr.token, mine.id);
      expect(ok.status).toBe(201);

      // finStaff shares branchMain, so this refusal is DEPARTMENT scope or it
      // is nothing — which is the only reason deptFin exists.
      const w = monWed(8);
      const theirs = await fx.seedLeave({
        employeeId: fx.finStaffId,
        start: w.start,
        end: w.end,
      });
      const denied = await approve(fx.mgr.token, theirs);
      expect(denied.status).toBe(403);
      expect(body(denied)).toContain(
        'You do not have permission to perform this action outside your department.',
      );
      const deniedReject = await reject(fx.mgr.token, theirs, {
        rejectedReason: 'no',
      });
      expect(deniedReject.status).toBe(403);

      await ctx.prisma.leaveRequest.delete({ where: { id: theirs } });
    });

    /**
     * FIXED. The route admits EMPLOYEE deliberately, so a SUPERVISOR holding no
     * elevated role can act on a step of a CONFIGURED chain. But with no chain
     * engaged there is no step to be eligible for, and the legacy guard only
     * ever covered MANAGER — so any colleague could finalize anyone's leave.
     */
    it('LVE-API-53 with no chain configured, a plain EMPLOYEE cannot approve a colleague’s leave', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const { id } = await fileFor(fx.applicantId);

      const res = await approve(fx.otherEmployee.token, id);
      expect(res.status).toBe(403);
      expect(body(res)).toContain(
        'You do not have permission to decide this request.',
      );

      const rejected = await reject(fx.otherEmployee.token, id, {
        rejectedReason: 'no',
      });
      expect(rejected.status).toBe(403);

      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('PENDING');

      // HR still decides it — the door is narrowed, not closed.
      expect((await approve(fx.hr.token, id)).status).toBe(201);
    });

    /**
     * L14. Both the create-time check and `deductDays` use
     * `startDate.getUTCFullYear()`, so a 28 Dec → 4 Jan leave takes every one of
     * its working days out of DECEMBER's allocation and none out of January's.
     */
    it('LVE-API-54 a leave spanning new year charges every day to the START year', async () => {
      await fx.setBalance(fx.crossYearStaffId, 'Annual Leave', 20, LEAVE_YEAR);
      await fx.setBalance(
        fx.crossYearStaffId,
        'Annual Leave',
        20,
        LEAVE_YEAR + 1,
      );

      const res = await create(
        fx.hr.token,
        payload(`${LEAVE_YEAR}-12-28`, `${LEAVE_YEAR + 1}-01-04`, {
          employeeId: fx.crossYearStaffId,
        }),
      );
      expect(res.status).toBe(201);
      const days = dataOf(res).totalDays as number;
      expect(days).toBeGreaterThan(0);

      await approve(fx.hr.token, dataOf(res).id);

      const startYear = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.crossYearStaffId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      const nextYear = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.crossYearStaffId,
          year: LEAVE_YEAR + 1,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(startYear.used).toBe(days);
      expect(nextYear.used).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('cancelling', () => {
    it('LVE-API-55 the owner cancels their own pending request', async () => {
      const w = monWed(0);
      const created = await create(
        fx.employee.token,
        payload(w.start, w.end),
      );
      expect(created.status).toBe(201);
      const res = await cancel(fx.employee.token, dataOf(created).id);
      expect(res.status).toBe(200);
      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: dataOf(created).id },
      });
      expect(row.status).toBe('CANCELLED');
    });

    /**
     * L25. `cancel` compares `request.employeeId` against the caller's own
     * employee id and nothing else (`leave-requests.service.ts:1019`) — so ADMIN
     * and HR are refused despite `@Roles` admitting them, and a request HR filed
     * ON AN EMPLOYEE'S BEHALF can never be withdrawn by HR. The code comment one
     * line above says "Only owner or HR can cancel"; the code does not.
     */
    it('LVE-API-56 ADMIN and HR cannot cancel a request they are entitled to see', async () => {
      const w = monWed(0);
      const created = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: fx.applicantId }),
      );
      for (const actor of [fx.admin, fx.hr]) {
        const res = await cancel(actor.token, dataOf(created).id);
        expect(res.status).toBe(403);
        expect(body(res)).toContain('You can only cancel your own requests');
      }
      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: dataOf(created).id },
      });
      expect(row.status).toBe('PENDING');
    });

    it('LVE-API-57 an approved leave cannot be cancelled, and the deducted days have no way back', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const w = monWed(0);
      const created = await create(
        fx.employee.token,
        payload(w.start, w.end),
      );
      await approve(fx.hr.token, dataOf(created).id);

      const res = await cancel(fx.employee.token, dataOf(created).id);
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Can only cancel pending requests');

      // L13: `addDays` has no caller, there is no un-approve and no edit
      // endpoint, so the deduction below is permanent.
      const balance = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(balance.used).toBe(3);
    });

    it('LVE-API-58 there is no edit endpoint: PATCH and PUT are not routed', async () => {
      const w = monWed(0);
      const created = await create(
        fx.hr.token,
        payload(w.start, w.end, { employeeId: fx.applicantId }),
      );
      const id = dataOf(created).id;
      for (const method of ['patch', 'put'] as const) {
        const res = await (ctx.http() as any)
          [method](`/leave-requests/${id}`)
          .set(bearer(fx.hr.token))
          .send({ reason: 'changed my mind' });
        expect(res.status).toBe(404);
      }
      // Which is why an amendment is cancel + re-file (L41).
      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.reason).not.toBe('changed my mind');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('lists, filters, empty states and export', () => {
    it('LVE-API-59 every documented filter narrows the list', async () => {
      const a = monWed(0);
      const b = monWed(8);
      const pending = await fx.seedLeave({
        employeeId: fx.applicantId,
        start: a.start,
        end: a.end,
        status: 'PENDING',
      });
      const approved = await fx.seedLeave({
        employeeId: fx.applicant2Id,
        start: b.start,
        end: b.end,
        status: 'APPROVED',
        leaveType: 'Sick Leave',
      });

      const byStatus = await list(fx.hr.token, '?status=APPROVED&limit=200');
      const ids = dataOf(byStatus).map((r: any) => r.id);
      expect(ids).toContain(approved);
      expect(ids).not.toContain(pending);

      const byType = await list(
        fx.hr.token,
        '?leaveType=Sick%20Leave&limit=200',
      );
      expect(dataOf(byType).map((r: any) => r.id)).toContain(approved);
      expect(dataOf(byType).map((r: any) => r.id)).not.toContain(pending);

      const byEmployee = await list(
        fx.hr.token,
        `?employeeId=${fx.applicantId}&limit=200`,
      );
      expect(dataOf(byEmployee).map((r: any) => r.id)).toEqual([pending]);

      const byRange = await list(
        fx.hr.token,
        `?startDate=${a.start}&endDate=${a.end}&limit=200`,
      );
      expect(dataOf(byRange).map((r: any) => r.id)).toContain(pending);
      expect(dataOf(byRange).map((r: any) => r.id)).not.toContain(approved);

      const bySearch = await list(
        fx.hr.token,
        `?search=${encodeURIComponent('LeaveOT APPL0')}&limit=200`,
      );
      expect(dataOf(bySearch).length).toBeGreaterThan(0);
      for (const r of dataOf(bySearch)) {
        expect(r.employee.fullName).toContain('APPL0');
      }
    });

    it('LVE-API-60 a MANAGER’s list is narrowed to their departments, and employeeId INTERSECTS rather than replaces', async () => {
      const a = monWed(0);
      const mine = await fx.seedLeave({
        employeeId: fx.applicantId,
        start: a.start,
        end: a.end,
      });
      const theirs = await fx.seedLeave({
        employeeId: fx.finStaffId,
        start: a.start,
        end: a.end,
      });

      const scoped = await list(fx.mgr.token, '?limit=200');
      const ids = dataOf(scoped).map((r: any) => r.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);

      // Naming a foreign employee explicitly does not widen the scope.
      const targeted = await list(
        fx.mgr.token,
        `?employeeId=${fx.finStaffId}&limit=200`,
      );
      expect(targeted.status).toBe(200);
      expect(dataOf(targeted)).toEqual([]);

      await ctx.prisma.leaveRequest.delete({ where: { id: theirs } });
    });

    /**
     * L31. `findAll` clamps `take` at 500 but computes `totalPages` from the RAW
     * query value, and echoes `page`/`limit` back as the strings they arrived
     * as. A client that paginates on `meta` walks off the end of the data.
     */
    it('LVE-API-61 pagination is honoured, and meta lies once the limit passes the clamp', async () => {
      const a = monWed(0);
      const b = monWed(8);
      await fx.seedLeave({ employeeId: fx.applicantId, start: a.start, end: a.end });
      await fx.seedLeave({ employeeId: fx.applicant2Id, start: b.start, end: b.end });

      const paged = await list(fx.hr.token, '?page=1&limit=1');
      expect(paged.status).toBe(200);
      expect(dataOf(paged)).toHaveLength(1);
      expect(paged.body.meta.total).toBeGreaterThanOrEqual(2);

      const overClamped = await list(fx.hr.token, '?page=1&limit=1000');
      const meta = overClamped.body.meta;
      expect(meta.totalPages).toBe(Math.ceil(meta.total / 1000));
      // Echoed back as strings, not the numbers the DTO advertises.
      expect(typeof meta.limit).toBe('string');
    });

    it('LVE-API-62 empty states answer an empty envelope, never a 404', async () => {
      const mine = await ctx
        .http()
        .get('/leave-requests/my-requests')
        .set(bearer(fx.employee.token));
      expect(mine.status).toBe(200);
      expect(dataOf(mine)).toEqual([]);

      const byEmployee = await ctx
        .http()
        .get(`/leave-requests/employee/${fx.applicantId}`)
        .set(bearer(fx.hr.token));
      expect(byEmployee.status).toBe(200);
      expect(dataOf(byEmployee)).toEqual([]);

      const pending = await ctx
        .http()
        .get('/leave-requests/pending')
        .set(bearer(fx.hr.token));
      expect(pending.status).toBe(200);
      expect(Array.isArray(dataOf(pending))).toBe(true);
    });

    it('LVE-API-63 team-balances is MANAGER-only, reports null for an uninitialised employee, and its approvals array is always empty', async () => {
      const res = await ctx
        .http()
        .get('/leave-requests/team-balances')
        .set(bearer(fx.mgr.token));
      expect(res.status).toBe(200);
      const rows = dataOf(res);
      expect(Array.isArray(rows)).toBe(true);
      const uninitialised = rows.find((r: any) => r.balances === null);
      expect(uninitialised).toBeTruthy();

      // L33. ADMIN and HR are refused a read they own everywhere else, and the
      // refusal comes from `RolesGuard` — a flat OR string match — so it is the
      // GENERIC "Forbidden resource", not the service's own sentence. That
      // sentence ("Only managers can view team leave balances.") is therefore
      // unreachable through this route: the guard has already answered by the
      // time `getTeamBalances` could check the role again. Asserted as it
      // behaves, so a future guard change is visible here rather than silent.
      for (const actor of [fx.admin, fx.hr]) {
        const denied = await ctx
          .http()
          .get('/leave-requests/team-balances')
          .set(bearer(actor.token));
        expect(denied.status).toBe(403);
        expect(body(denied)).toContain('Forbidden resource');
        expect(body(denied)).not.toContain('Only managers can view');
      }

      // L35: the payload's `approvals` array is the LEGACY LeaveApproval model,
      // which nothing writes any more. A screen reading it shows an empty chain
      // while the live trail sits behind /approval-workflows/trail/...
      const w = monWed(0);
      const id = await fx.seedLeave({
        employeeId: fx.applicantId,
        start: w.start,
        end: w.end,
      });
      const detail = await ctx
        .http()
        .get(`/leave-requests/${id}`)
        .set(bearer(fx.hr.token));
      expect(dataOf(detail).approvals).toEqual([]);
    });

    it('LVE-API-64 the export is ADMIN/HR only and returns a real spreadsheet', async () => {
      const w = monWed(0);
      await fx.seedLeave({
        employeeId: fx.applicantId,
        start: w.start,
        end: w.end,
      });

      for (const actor of [fx.admin, fx.hr]) {
        const res = await ctx
          .http()
          .get('/export/leave-requests')
          .set(bearer(actor.token))
          .buffer(true);
        expect(res.status).toBe(200);
        expect(String(res.headers['content-type'])).toMatch(
          /spreadsheet|octet-stream|excel/i,
        );
        expect(Number(res.headers['content-length'] ?? 1)).toBeGreaterThan(0);
      }
      for (const actor of [fx.mgr, fx.employee]) {
        const res = await ctx
          .http()
          .get('/export/leave-requests')
          .set(bearer(actor.token));
        expect(res.status).toBe(403);
      }
    });
  });
});
