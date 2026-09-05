import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupAttendanceFixtures,
  AttendanceFixtures,
  pinCompanyTzToMidMorning,
  HIST_YEAR,
  HIST_MONTH,
  histDay,
} from './utils/attendance-fixtures';
import { bearer, withSettings } from './utils/settings';
import { TimezoneService } from '../src/common/timezone/timezone.service';

/**
 * The administrative read and write surface of Time & Attendance.
 *
 * Eight of these endpoints return EVERY employee's attendance, and before this
 * file none of them had a single test — not a unit spec, not an e2e case. That
 * is what this suite is for, and it is why three of its cases are pinning a data
 * leak rather than asserting a rule:
 *
 *   A1  GET /attendances/list admits EMPLOYEE and narrows only for MANAGER, so
 *       any employee pages the whole company's attendance.
 *   A2  GET /attendances/employee/:employeeId — the targeted twin. The
 *       controller checks the MANAGER department rule and nothing else, so an
 *       employee reads any colleague's month by id.
 *   A3  GET /dashboard/attendance-summary — same shape again.
 *
 * Each of the three is a `it(...)` pinning today's behaviour plus an
 * `it.failing(...)` twin naming the intent, and each asserts a NAMED foreign
 * employee's row rather than a count, so the twin cannot pass by accident.
 *
 * ── Reading this suite ──────────────────────────────────────────────────────
 *
 * Every aggregate here (`report`, `statistics`, `absenteeism-stats`, `validate`,
 * `today/all`, `dashboard-summary`) reads the whole database inside the caller's
 * branch envelope, with no per-run filter. So NO case asserts an absolute count.
 * Each one either measures a delta or asserts the presence/absence of a named
 * employee's row. See docs/TEST-PLAN-ATTENDANCE.md §6.9.
 *
 * This file owns "today" for `absentee`, `onLeaveStaff`, `finStaff` and
 * `newHire`. It must not punch anyone else's actor — see the ownership table in
 * `test/utils/attendance-fixtures.ts`.
 */
describe('Attendance — administrative surface (e2e)', () => {
  let ctx: E2EContext;
  let fx: AttendanceFixtures;
  let restoreTz: () => Promise<void>;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };
  /** Employee ids present in a `/attendances/list` payload, virtual rows included. */
  const employeeIdsOf = (res: any): string[] =>
    rowsOf(res)
      .map((r) => r.employeeId ?? r.employee?.id)
      .filter(Boolean);

  const created: string[] = [];

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupAttendanceFixtures(ctx);
    // Without this the suite is wall-clock dependent: with the default day end
    // of 23:59 and a company zone of Asia/Kolkata the attendance day closes at
    // 18:29 UTC, and every write below would 400 in an evening CI run.
    restoreTz = await pinCompanyTzToMidMorning(ctx);
  }, 120000);

  afterAll(async () => {
    if (created.length) {
      await ctx.prisma.attendance
        .deleteMany({ where: { id: { in: created } } })
        .catch(() => undefined);
    }
    if (restoreTz) await restoreTz();
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read the administrative endpoints', () => {
    it('ATA-API-01 today/all admits ADMIN and HR, refuses MANAGER and EMPLOYEE', async () => {
      const get = (token?: string) => {
        const r = ctx.http().get('/attendances/today/all');
        return token ? r.set(bearer(token)) : r;
      };
      expect((await get(fx.admin.token)).status).toBe(200);
      expect((await get(fx.hr.token)).status).toBe(200);
      expect((await get(fx.mgr.token)).status).toBe(403);
      expect((await get(fx.employee.token)).status).toBe(403);
      expect((await get()).status).toBe(401);
    });

    /**
     * A22. These six take no `user` argument at all. Branch scoping still holds
     * for the reads — they use findMany/count/aggregate, every one of which is
     * in BRANCH_READ_ACTIONS — so this is a verified decision rather than a
     * leak. What was never stated anywhere is that MANAGER is excluded, which
     * is what these assertions put on the record.
     */
    it.each([
      ['report', `/attendances/report?month=${HIST_MONTH}&year=${HIST_YEAR}`],
      ['statistics', `/attendances/statistics?month=${HIST_MONTH}&year=${HIST_YEAR}`],
      ['absenteeism-stats', '/attendances/absenteeism-stats'],
      ['validate', `/attendances/validate?month=${HIST_MONTH}&year=${HIST_YEAR}`],
    ])(
      'ATA-API-02 %s is ADMIN/HR only — MANAGER and EMPLOYEE are refused',
      async (_label, path) => {
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
      },
    );

    it('ATA-API-03 overview admits MANAGER but refuses EMPLOYEE', async () => {
      const get = (token?: string) => {
        const r = ctx.http().get('/attendances/overview?period=today');
        return token ? r.set(bearer(token)) : r;
      };
      expect((await get(fx.admin.token)).status).toBe(200);
      expect((await get(fx.hr.token)).status).toBe(200);
      expect((await get(fx.mgr.token)).status).toBe(200);
      expect((await get(fx.employee.token)).status).toBe(403);
      expect((await get()).status).toBe(401);
    });

    it('ATA-API-04 manual entry and auto-absent are ADMIN/HR only', async () => {
      for (const path of ['/attendances/manual', '/attendances/auto-mark-absent']) {
        expect(
          (await ctx.http().post(path).set(bearer(fx.mgr.token)).send({})).status,
        ).toBe(403);
        expect(
          (await ctx.http().post(path).set(bearer(fx.employee.token)).send({}))
            .status,
        ).toBe(403);
        expect((await ctx.http().post(path).send({})).status).toBe(401);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('envelopes and empty states', () => {
    it('ATA-API-05 report groups by employee and carries a summary per row', async () => {
      const res = await ctx
        .http()
        .get(`/attendances/report?month=${HIST_MONTH}&year=${HIST_YEAR}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const rows = rowsOf(res);
      const mine = rows.find(
        (r) => (r.employee?.id ?? r.employeeId) === fx.puncherId,
      );
      expect(mine).toBeDefined();
      // The fixture writes five February 2019 rows for `puncher`: three PRESENT
      // (one late, one early-leave), one ABSENT and one MISSED_CHECKOUT.
      expect(mine.summary ?? mine).toBeDefined();
      expect(body(res)).toContain(fx.puncherId);
    });

    it('ATA-API-06 a month with no attendance answers an empty report, not a 404', async () => {
      const res = await ctx
        .http()
        // 2017 predates every fixture row AND every fixture startDate.
        .get('/attendances/report?month=1&year=2017')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(rowsOf(res)).toEqual([]);
    });

    /**
     * The division guard. `lateRate` and `earlyLeaveRate` are computed against a
     * record count, so an empty month is the case that decides between 0 and
     * NaN — and NaN serialises to `null`, which reads as "no data" on screen
     * rather than as a bug.
     */
    it('ATA-API-07 statistics on an empty month return zero rates, not NaN', async () => {
      const res = await ctx
        .http()
        .get('/attendances/statistics?month=1&year=2017')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      const d = res.body?.data ?? res.body;
      for (const key of Object.keys(d ?? {})) {
        if (typeof d[key] === 'number') expect(Number.isNaN(d[key])).toBe(false);
      }
    });

    it('ATA-API-08 absenteeism-stats returns today, week and month blocks', async () => {
      const res = await ctx
        .http()
        .get('/attendances/absenteeism-stats')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      const d = res.body?.data ?? res.body;
      expect(d).toHaveProperty('today');
      expect(d).toHaveProperty('week');
      expect(d).toHaveProperty('month');
    });

    it('ATA-API-09 validate surfaces the never-present employee as a missing-days issue', async () => {
      const res = await ctx
        .http()
        .get(`/attendances/validate?month=${HIST_MONTH}&year=${HIST_YEAR}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      // `absentee` has no February 2019 rows at all, so it must appear. The
      // assertion is on OUR employee's presence, never on the issue count —
      // validate walks every ACTIVE employee in the database.
      expect(body(res)).toContain(fx.absenteeId);
    });

    it('ATA-API-10 overview accepts all four periods and a custom range without a start date', async () => {
      for (const period of ['today', 'week', 'month', 'custom']) {
        const res = await ctx
          .http()
          .get(`/attendances/overview?period=${period}`)
          .set(bearer(fx.admin.token));
        expect(res.status).toBe(200);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the attendance list', () => {
    const listPath = (q: string) =>
      `/attendances/list?period=custom&startDate=${HIST_YEAR}-0${HIST_MONTH}-01&endDate=${HIST_YEAR}-0${HIST_MONTH}-28&${q}`;

    it('ATA-API-11 returns a paginated envelope with both totals', async () => {
      const res = await ctx
        .http()
        .get(listPath('page=1&limit=10'))
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      const meta = res.body?.data?.meta ?? res.body?.meta;
      expect(meta).toBeDefined();
      // `totalUnfiltered` is the denominator the filter panel's "N of M" line is
      // built from, and it is computed from a SNAPSHOT of the employee filter
      // taken before search/department are applied.
      expect(meta).toHaveProperty('total');
      expect(meta).toHaveProperty('totalUnfiltered');
      expect(meta.page).toBe(1);
      expect(meta.limit).toBe(10);
    });

    it('ATA-API-12 period=today builds virtual NOT_CHECKED_IN rows for employees with no record', async () => {
      const res = await ctx
        .http()
        .get('/attendances/list?period=today&limit=1000')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      // A response contract nothing else asserts, and one the browser layer
      // depends on: a single-day list is employees-first, not attendance-first.
      const virtual = rowsOf(res).filter(
        (r) => typeof r.id === 'string' && r.id.startsWith('virtual-'),
      );
      expect(virtual.length).toBeGreaterThan(0);
      expect(virtual[0].status).toBe('NOT_CHECKED_IN');
    });

    it('ATA-API-13 search narrows by full name and by employee code, case-insensitively', async () => {
      const byCode = await ctx
        .http()
        .get(listPath(`search=${fx.runId}&limit=1000`))
        .set(bearer(fx.admin.token));
      expect(byCode.status).toBe(200);
      const ids = employeeIdsOf(byCode);
      expect(ids).toContain(fx.puncherId);

      const nomatch = await ctx
        .http()
        .get(listPath('search=zzz-no-such-employee&limit=1000'))
        .set(bearer(fx.admin.token));
      expect(nomatch.status).toBe(200);
      expect(rowsOf(nomatch)).toEqual([]);
    });

    it('ATA-API-14 departmentId narrows, and departmentId=all does not', async () => {
      const scoped = await ctx
        .http()
        .get(listPath(`departmentId=${fx.deptFin}&limit=1000`))
        .set(bearer(fx.admin.token));
      expect(scoped.status).toBe(200);
      const scopedIds = employeeIdsOf(scoped);
      expect(scopedIds).toContain(fx.finStaffId);
      expect(scopedIds).not.toContain(fx.puncherId);

      const all = await ctx
        .http()
        .get(listPath('departmentId=all&limit=1000'))
        .set(bearer(fx.admin.token));
      expect(employeeIdsOf(all)).toContain(fx.puncherId);
    });

    it('ATA-API-15 the five status filters each narrow to their own rows', async () => {
      const late = await ctx
        .http()
        .get(listPath('status=late&limit=1000'))
        .set(bearer(fx.admin.token));
      expect(late.status).toBe(200);
      expect(rowsOf(late).every((r) => r.isLate === true)).toBe(true);

      const earlyLeave = await ctx
        .http()
        .get(listPath('status=early-leave&limit=1000'))
        .set(bearer(fx.admin.token));
      expect(rowsOf(earlyLeave).every((r) => r.isEarlyLeave === true)).toBe(true);

      const notCheckedOut = await ctx
        .http()
        .get(listPath('status=not-checked-out&limit=1000'))
        .set(bearer(fx.admin.token));
      expect(
        rowsOf(notCheckedOut).every((r) => r.checkIn && r.checkOut === null),
      ).toBe(true);
    });

    it('ATA-API-16 an unknown status falls through unfiltered rather than erroring', async () => {
      const unknown = await ctx
        .http()
        .get(listPath('status=not-a-status&limit=1000'))
        .set(bearer(fx.admin.token));
      expect(unknown.status).toBe(200);
      expect(employeeIdsOf(unknown)).toContain(fx.puncherId);
    });

    it('ATA-API-17 limit=1 returns one row and reports the real total behind it', async () => {
      const res = await ctx
        .http()
        .get(listPath('page=1&limit=1'))
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(rowsOf(res).length).toBeLessThanOrEqual(1);
      const meta = res.body?.data?.meta ?? res.body?.meta;
      expect(meta.total).toBeGreaterThan(1);
    });

    it('ATA-API-18 a page past the end is empty, not an error', async () => {
      const res = await ctx
        .http()
        .get(listPath('page=9999&limit=10'))
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(rowsOf(res)).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('manual attendance entry', () => {
    const manual = (token: string, payload: Record<string, unknown>) =>
      ctx.http().post('/attendances/manual').set(bearer(token)).send(payload);

    const track = (res: any) => {
      const id = res.body?.data?.id ?? res.body?.id;
      if (id) created.push(id);
      return res;
    };

    it('ATA-API-19 a plain HH:MM entry is built in the employee timezone and stored', async () => {
      const res = track(
        await manual(fx.hr.token, {
          employeeId: fx.finStaffId,
          date: `${HIST_YEAR}-0${HIST_MONTH}-14`,
          checkIn: '09:00',
          checkOut: '17:30',
          status: 'PRESENT',
          notes: `manual ${fx.runId}`,
        }),
      );
      expect(res.status).toBe(201);

      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.finStaffId, date: histDay(14) },
      });
      expect(row).toBeTruthy();
      expect(row!.checkIn).toBeTruthy();
      expect(row!.checkOut).toBeTruthy();
      // The branch stamp is what an approved correction fails to write (A8), so
      // asserting it here is what makes that finding a contrast rather than a
      // guess.
      expect(row!.branchId).toBe(fx.branchHome);
      expect(row!.source).toBe('MANUAL');
    });

    it('ATA-API-20 a full ISO timestamp is used as-is', async () => {
      const iso = `${HIST_YEAR}-0${HIST_MONTH}-15T08:15:00.000Z`;
      const res = track(
        await manual(fx.hr.token, {
          employeeId: fx.finStaffId,
          date: `${HIST_YEAR}-0${HIST_MONTH}-15`,
          checkIn: iso,
          checkOut: `${HIST_YEAR}-0${HIST_MONTH}-15T17:00:00.000Z`,
        }),
      );
      expect(res.status).toBe(201);

      // Located by a RANGE, not by `histDay(15)`. `createManualAttendance`
      // files the row under the ATTENDANCE day the check-in belongs to
      // (`toAttendanceDateKey`), which is the employee's day boundary, not the
      // raw calendar date — so with the suite's timezone pinned relative to the
      // real clock the key legitimately lands on the 14th, 15th or 16th
      // depending on the offset. The rule under test is that the INSTANT
      // survives untouched, and that is what is asserted.
      const row = await ctx.prisma.attendance.findFirst({
        where: {
          employeeId: fx.finStaffId,
          date: { gte: histDay(14), lte: histDay(16) },
          checkIn: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(row).toBeTruthy();
      expect(row!.checkIn!.toISOString()).toBe(iso);
    });

    /**
     * The `@@unique([employeeId, date])` is used as an UPSERT key, not as a
     * conflict. A second entry for the same date silently overwrites the first
     * — which is a decision (HR correcting their own typo) rather than an
     * oversight, and is asserted so it stays one.
     */
    it('ATA-API-21 a second entry for the same date upserts rather than conflicting', async () => {
      const day = `${HIST_YEAR}-0${HIST_MONTH}-16`;
      track(
        await manual(fx.hr.token, {
          employeeId: fx.finStaffId,
          date: day,
          checkIn: '09:00',
          checkOut: '17:00',
        }),
      );
      const second = await manual(fx.hr.token, {
        employeeId: fx.finStaffId,
        date: day,
        checkIn: '10:00',
        checkOut: '18:00',
      });
      expect(second.status).toBe(201);

      const rows = await ctx.prisma.attendance.findMany({
        where: { employeeId: fx.finStaffId, date: histDay(16) },
      });
      expect(rows).toHaveLength(1);
    });

    it('ATA-API-22 an entry before the onboarding date is refused, naming that date', async () => {
      const res = await manual(fx.hr.token, {
        employeeId: fx.newHireId,
        date: `${HIST_YEAR}-0${HIST_MONTH}-10`,
        checkIn: '09:00',
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('onboarding date');
    });

    it('ATA-API-23 an unknown employee is a 404', async () => {
      const res = await manual(fx.hr.token, {
        employeeId: '00000000-0000-0000-0000-000000000000',
        date: `${HIST_YEAR}-0${HIST_MONTH}-10`,
        checkIn: '09:00',
      });
      expect(res.status).toBe(404);
    });

    /**
     * A12, FIXED. `Attendance.status` is a free VarChar and the service writes
     * `dto.status || 'PRESENT'` verbatim, so an invented value used to be
     * persisted and then counted as neither present nor absent by
     * `getOverview`, matching no filter in `getAttendanceList`. Payroll reads
     * this column. The DTO now carries the allowlist it always documented.
     */
    it('ATA-API-24 an invented status is refused against the four the DTO documents', async () => {
      const res = await manual(fx.hr.token, {
        employeeId: fx.finStaffId,
        date: `${HIST_YEAR}-0${HIST_MONTH}-17`,
        status: 'BANANA',
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('PRESENT');

      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.finStaffId, date: histDay(17) },
      });
      expect(row).toBeNull();
    });

    it('ATA-API-24b each documented status is still accepted', async () => {
      for (const [i, status] of ['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY'].entries()) {
        const res = track(
          await manual(fx.hr.token, {
            employeeId: fx.finStaffId,
            date: `${HIST_YEAR}-0${HIST_MONTH}-${String(18 + i).padStart(2, '0')}`,
            status,
          }),
        );
        expect(res.status).toBe(201);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the employee-facing read doors leak the whole company', () => {
    /**
     * A1, FIXED. `getAttendanceList`'s employee filter used to be
     * `{ status: 'ACTIVE', NOT: { user: { role: 'ADMIN' } } }` plus a MANAGER
     * arm, with no EMPLOYEE arm anywhere in the 3505-line service — so any
     * employee could page the whole company's attendance, bounded only by their
     * branch envelope. It now narrows to the caller.
     *
     * The assertion names `finStaff` — a colleague in a different department —
     * rather than counting rows, so it cannot pass on an empty result.
     */
    it('ATA-API-25 an EMPLOYEE lists only their own attendance', async () => {
      const res = await ctx
        .http()
        .get(
          `/attendances/list?period=custom&startDate=${HIST_YEAR}-0${HIST_MONTH}-01&endDate=${HIST_YEAR}-0${HIST_MONTH}-28&limit=1000`,
        )
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);

      const ids = new Set(employeeIdsOf(res));
      expect(ids.has(fx.finStaffId)).toBe(false);
      ids.delete(fx.puncherId);
      expect([...ids]).toEqual([]);
    });

    /**
     * A2, FIXED. The targeted twin of A1: the controller checked
     * `user.role === 'MANAGER'` against `isDeptInManagerScope` and stopped, so
     * EMPLOYEE — which IS in `@Roles` — walked straight through to any
     * colleague's month. `GET /attendances/:id` always carried the self-check;
     * this sibling door never did.
     */
    it('ATA-API-26 an EMPLOYEE is refused a colleague’s month by id', async () => {
      const res = await ctx
        .http()
        .get(
          `/attendances/employee/${fx.finStaffId}?month=${HIST_MONTH}&year=${HIST_YEAR}`,
        )
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(403);
    });

    it('ATA-API-27 an EMPLOYEE reading their OWN month is correct and must keep working', async () => {
      const res = await ctx
        .http()
        .get(
          `/attendances/employee/${fx.puncherId}?month=${HIST_MONTH}&year=${HIST_YEAR}`,
        )
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);
    });

    /**
     * A3, FIXED — and this one was narrower than the survey predicted. The
     * employee's numbers never equalled the administrator's, because the branch
     * middleware already narrows a non-global user to their own envelope. The
     * leak was real but branch-bounded: every colleague in their own branch.
     * `deptFilter` now has an EMPLOYEE arm, so the summary counts only them.
     */
    it('ATA-API-28 an EMPLOYEE’s dashboard summary counts only their own days', async () => {
      const mine = await ctx
        .http()
        .get(`/dashboard/attendance-summary?month=${HIST_MONTH}&year=${HIST_YEAR}`)
        .set(bearer(fx.employee.token));
      expect(mine.status).toBe(200);

      const ownRows = await ctx.prisma.attendance.count({
        where: {
          employeeId: fx.puncherId,
          date: { gte: histDay(1), lte: histDay(28) },
        },
      });
      expect((mine.body?.data ?? mine.body)?.summary?.total).toBe(ownRows);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('manager scope on the aggregate reads', () => {
    it('ATA-API-29 a MANAGER’s overview covers their own department and not a sibling', async () => {
      const res = await ctx
        .http()
        .get('/attendances/list?period=today&limit=1000')
        .set(bearer(fx.mgr.token));
      expect(res.status).toBe(200);
      const ids = employeeIdsOf(res);
      // `deptFin` shares a BRANCH with `deptOps`, which is what makes this a
      // department-scope assertion rather than a branch-scope one.
      expect(ids).toContain(fx.puncherId);
      expect(ids).not.toContain(fx.finStaffId);
    });

    /**
     * A30, FIXED — found by running this suite rather than by reading the code.
     *
     * `getAttendanceList` set the manager's scope and then, twelve lines later,
     * overwrote it:
     *
     *     if (user?.role === 'MANAGER' && user?.departmentId)
     *       employeeFilter.departmentId = { in: managerDeptScope(user) };
     *     ...
     *     if (departmentId && departmentId !== 'all')
     *       employeeFilter.departmentId = departmentId;   // unconditional
     *
     * So a MANAGER escaped their own scope by passing the query parameter the
     * screen already sends — and `deptFin` is in the SAME branch, so the branch
     * middleware did not catch it either. The filter now INTERSECTS.
     */
    it('ATA-API-30 ?departmentId intersects a MANAGER’s scope rather than replacing it', async () => {
      const res = await ctx
        .http()
        .get(
          `/attendances/list?period=today&limit=1000&departmentId=${fx.deptFin}`,
        )
        .set(bearer(fx.mgr.token));
      expect(res.status).toBe(200);
      expect(employeeIdsOf(res)).not.toContain(fx.finStaffId);
    });

    it('ATA-API-30b ?departmentId still narrows within a department they DO head', async () => {
      const res = await ctx
        .http()
        .get(
          `/attendances/list?period=today&limit=1000&departmentId=${fx.deptOps}`,
        )
        .set(bearer(fx.mgr.token));
      expect(res.status).toBe(200);
      expect(employeeIdsOf(res)).toContain(fx.puncherId);
    });

    it('ATA-API-30c an ADMIN is unaffected and may still filter to any department', async () => {
      const res = await ctx
        .http()
        .get(
          `/attendances/list?period=today&limit=1000&departmentId=${fx.deptFin}`,
        )
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(employeeIdsOf(res)).toContain(fx.finStaffId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('export', () => {
    it('ATA-API-31 exports an xlsx for a month, and narrows by employee', async () => {
      const res = await ctx
        .http()
        .get(`/export/attendance/${HIST_MONTH}/${HIST_YEAR}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(String(res.headers['content-type'])).toContain('sheet');

      const scoped = await ctx
        .http()
        .get(
          `/export/attendance/${HIST_MONTH}/${HIST_YEAR}?employeeId=${fx.puncherId}`,
        )
        .set(bearer(fx.admin.token));
      expect(scoped.status).toBe(200);
    });

    it('ATA-API-32 export is refused to MANAGER and EMPLOYEE', async () => {
      const path = `/export/attendance/${HIST_MONTH}/${HIST_YEAR}`;
      expect(
        (await ctx.http().get(path).set(bearer(fx.mgr.token))).status,
      ).toBe(403);
      expect(
        (await ctx.http().get(path).set(bearer(fx.employee.token))).status,
      ).toBe(403);
    });

    /**
     * A14, FIXED. Same shape as People's P27: an unvalidated id reached a
     * `@db.Uuid` column, Prisma answered P2023, and the caller got a 500
     * carrying driver text. `ParseUUIDPipe({ optional: true })` keeps the
     * whole-company export working while refusing junk.
     */
    it('ATA-API-33 a malformed employeeId on export is a 400, not a 500', async () => {
      const res = await ctx
        .http()
        .get(`/export/attendance/${HIST_MONTH}/${HIST_YEAR}?employeeId=not-a-uuid`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('cross-endpoint agreement', () => {
    /**
     * `/dashboard/attendance-summary` and `/attendances/statistics` compute the
     * same numbers from two different code paths in two different services. A
     * divergence means one screen is lying, and nothing else would catch it.
     */
    it('ATA-API-34 the dashboard summary agrees with the attendance statistics', async () => {
      const stats = await ctx
        .http()
        .get(`/attendances/statistics?month=${HIST_MONTH}&year=${HIST_YEAR}`)
        .set(bearer(fx.admin.token));
      const summary = await ctx
        .http()
        .get(`/dashboard/attendance-summary?month=${HIST_MONTH}&year=${HIST_YEAR}`)
        .set(bearer(fx.admin.token));

      expect(stats.status).toBe(200);
      expect(summary.status).toBe(200);

      const s = stats.body?.data ?? stats.body;
      const d = summary.body?.data ?? summary.body;
      for (const key of ['present', 'absent', 'late']) {
        if (typeof s?.[key] === 'number' && typeof d?.[key] === 'number') {
          expect(d[key]).toBe(s[key]);
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Deliberately LAST in the file: auto-mark-absent writes a row for every
  // ACTIVE employee in the caller's envelope, including employees this suite
  // does not own. Running it earlier would hand every case above a row it did
  // not create. See docs/TEST-PLAN-ATTENDANCE.md §6.4.
  describe('auto-mark-absent (runs last — it writes outside this suite)', () => {
    const suiteStart = new Date();

    /**
     * The manual trigger only settles a day whose END BOUNDARY HAS PASSED
     * (`hasDayEndBoundaryPassed(targetDay)`), and the rest of this file runs
     * with local time pinned to mid-morning so that punches are legal. Those two
     * requirements are opposites, so the marking cases move the clock instead:
     * a company zone in which "now" is late evening, plus a day end of 19:00 —
     * which is >= 12:00, so the noon rule keeps `targetDay` on TODAY rather than
     * rolling it back to yesterday.
     *
     * `calendar_weekly_holidays` is pinned for the same block because
     * `autoMarkAbsent` skips any employee whose branch treats the target day as
     * a weekly-off day, and CI must not behave differently on one day of the
     * week. See `weeklyOffNotToday()` below for why it is pinned to a real day
     * rather than emptied.
     */
    const lateEveningTz = () => {
      const utcHour = new Date().getUTCHours();
      let offset = 20 - utcHour;
      if (offset > 12) offset -= 24;
      if (offset < -12) offset += 24;
      // POSIX inverts the sign: a +5 offset from UTC is spelled `Etc/GMT-5`.
      return offset === 0
        ? 'UTC'
        : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
    };

    /**
     * A weekly-off day that is provably NOT today.
     *
     * This was `''`, which looks like "no weekly holidays" and is not:
     * `HolidaysService.getWeeklyOffDays` reads
     *
     *     const parsed = setting?.value ? this.parseDays(setting.value) : [];
     *     return parsed.length ? parsed : [0];
     *
     * so an empty string is falsy, `parsed` is empty, and the fallback `[0]` —
     * SUNDAY — is returned. `autoMarkAbsent` then gates on
     * `isWorkingDayForBranch` and marks nobody, the endpoint still answers 201,
     * and the case failed every Sunday and passed the other six days.
     *
     * Found on a Sunday by the Time & Schedules session, who ruled out their
     * own changes first. It is the day-of-week twin of the wall-clock hazard
     * this file already guards with `lateEveningTz()`, and the same lesson:
     * a fixture value that means "off" has to be a value the parser agrees is
     * off, not merely one that looks empty.
     */
    const weeklyOffNotToday = () => String((new Date().getUTCDay() + 3) % 7);

    const runAutoAbsent = (token: string, headers: Record<string, string> = {}) =>
      withSettings(
        ctx,
        {
          system_timezone: lateEveningTz(),
          attendance_day_end_time: '19:00',
          calendar_weekly_holidays: weeklyOffNotToday(),
        },
        async () => {
          ctx.app.get(TimezoneService).invalidateCache();
          const req = ctx
            .http()
            .post('/attendances/auto-mark-absent')
            .set(bearer(token));
          for (const [k, v] of Object.entries(headers)) req.set(k, v);
          const res = await req.send({});
          return res;
        },
      ).finally(() => ctx.app.get(TimezoneService).invalidateCache());

    afterAll(async () => {
      await ctx.prisma.attendance
        .deleteMany({
          where: { source: 'AUTO', createdAt: { gte: suiteStart } },
        })
        .catch(() => undefined);
    });

    /**
     * A31 — found by this suite. Triggered at any point before the day-end
     * boundary, `POST /attendances/auto-mark-absent` returns 201 with
     * `success: true` and a "Skipped" message, having done nothing. The
     * Attendance Manager screen reports that as a success, so for most of the
     * working day the button is a no-op that looks like it worked.
     */
    it('ATA-API-35 KNOWN GAP: before the day-end boundary it reports success and does nothing', async () => {
      const before = await ctx.prisma.attendance.count({
        where: { source: 'AUTO', createdAt: { gte: suiteStart } },
      });
      // The suite-wide pin puts local time at mid-morning, so the boundary is
      // hours away.
      const res = await ctx
        .http()
        .post('/attendances/auto-mark-absent')
        .set(bearer(fx.admin.token))
        .send({});
      expect(res.status).toBe(201);
      expect(body(res)).toContain('Skipped');

      const after = await ctx.prisma.attendance.count({
        where: { source: 'AUTO', createdAt: { gte: suiteStart } },
      });
      expect(after).toBe(before);
    });

    it('ATA-API-36 past the boundary it marks the never-present employee and skips the one on leave', async () => {
      const res = await runAutoAbsent(fx.admin.token);
      expect(res.status).toBe(201);

      /**
       * The target day comes from the RESPONSE, not from `new Date()`.
       *
       * `runAutoAbsent` pins a company zone in which "now" is late evening so
       * the day-end boundary has passed — and at any UTC hour before 20:00 that
       * zone is behind UTC, so the attendance day the service targets is
       * YESTERDAY in UTC terms. This assertion used to query `date: today`
       * (real UTC midnight) and therefore looked for the row in the wrong place
       * for most of the day.
       *
       * `autoMarkAbsent` returns the day it actually used, so asking it is both
       * correct and self-documenting. Same class of mistake as ATA-API-20,
       * which located a manual entry by a fixed date key rather than by the
       * attendance day the service filed it under.
       */
      const targetDay = new Date((res.body?.data ?? res.body).date);
      expect(Number.isNaN(targetDay.getTime())).toBe(false);

      const absenteeRow = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.absenteeId, date: targetDay },
      });
      const onLeaveRow = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.onLeaveStaffId, date: targetDay, source: 'AUTO' },
      });

      expect(absenteeRow).toBeTruthy();
      expect(absenteeRow!.status).toBe('ABSENT');
      expect(absenteeRow!.source).toBe('AUTO');
      // Without the leave fixture, "marked absent" and "skipped because on
      // leave" are indistinguishable — this is what separates them.
      expect(onLeaveRow).toBeNull();
    });

    it('ATA-API-37 a second run past the boundary adds nothing', async () => {
      const before = await ctx.prisma.attendance.count({
        where: { source: 'AUTO', createdAt: { gte: suiteStart } },
      });
      const res = await runAutoAbsent(fx.admin.token);
      expect(res.status).toBe(201);
      const after = await ctx.prisma.attendance.count({
        where: { source: 'AUTO', createdAt: { gte: suiteStart } },
      });
      expect(after).toBe(before);
    });

    /**
     * A11, FIXED. The AUTO row's branch used to come from the request context
     * rather than the employee — so with no `X-Branch-Id` header every row
     * carried `branchId: null`, and `Attendance` is a `direct`-rule model where
     * `branchId IN (…)` never matches NULL. Those days were invisible to every
     * branch-scoped caller: the employee was marked absent, and their own
     * branch's list, report and logs grid could not see it. Worse, WITH a
     * header it stamped that branch onto employees of every other branch in the
     * caller's envelope.
     */
    it('ATA-API-38 an auto-absent row carries the employee’s own branch', async () => {
      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.absenteeId, source: 'AUTO' },
      });
      expect(row).toBeTruthy();
      expect(row!.branchId).toBe(fx.branchHome);
    });
  });
});
