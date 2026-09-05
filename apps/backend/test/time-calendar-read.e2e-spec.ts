import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupScheduleFixtures,
  ScheduleFixtures,
  RESERVED,
  freeDate,
  atUtc,
} from './utils/schedule-fixtures';
import { bearer } from './utils/settings';

/**
 * Time & Schedules — the three READ endpoints: `my-calendar`, `overview`, `stats`.
 *
 * These are the endpoints the screens are built out of, and they answer three
 * different questions from overlapping data, which is where the bugs live:
 *
 *   - `my-calendar` MERGES four sources (schedules, approved leave, approved
 *     overtime, holidays) into one flat event list for ONE employee.
 *   - `overview` returns those four plus the resolved weekly-off days, unmerged
 *     and untyped, for EVERY employee. It used to return only three and say
 *     nothing about the work week, which is T16/T17.
 *   - `stats` aggregates a MONTH for the calling employee only.
 *
 * They used to disagree about what a calendar CONTAINS: the shift screen's legend
 * had a holiday swatch because it read the merged feed, and the overview's did
 * not, because its endpoint never returned one — same product, same month, two
 * answers. CAL-API-17 is where that is now pinned shut.
 *
 * This spec owns `freeDate(210..269)` — 2026-09-27 to 2026-11-25.
 */
describe('Time & Schedules — calendar reads (e2e)', () => {
  let ctx: E2EContext;
  let fx: ScheduleFixtures;

  const DATE_BASE = 210;
  let dateSeq = 0;
  const nextDate = () => freeDate(DATE_BASE + dateSeq++);

  const WINDOW_START = new Date(`${freeDate(DATE_BASE)}T00:00:00.000Z`);
  const WINDOW_END = new Date(`${freeDate(DATE_BASE + 59)}T00:00:00.000Z`);

  const scheduleIds: string[] = [];
  const leaveIds: string[] = [];
  const overtimeIds: string[] = [];
  const holidayIds: string[] = [];

  const seedSchedule = async (
    employeeId: string,
    date: string,
    over: Record<string, unknown> = {},
  ) => {
    const row = await ctx.prisma.workSchedule.create({
      data: {
        employeeId,
        date: new Date(`${date}T00:00:00.000Z`),
        shiftType: 'FULL_DAY',
        startTime: new Date(atUtc(date, '09:00')),
        endTime: new Date(atUtc(date, '18:00')),
        isWorkDay: true,
        ...over,
      },
    });
    scheduleIds.push(row.id);
    return row;
  };

  const seedLeave = async (
    employeeId: string,
    startDate: string,
    endDate: string,
    status = 'APPROVED',
  ) => {
    const row = await ctx.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveType: 'ANNUAL',
        startDate: new Date(`${startDate}T00:00:00.000Z`),
        endDate: new Date(`${endDate}T00:00:00.000Z`),
        totalDays: 1,
        reason: `calendar-read leave ${status} ${fx.runId}`,
        status,
      },
    });
    leaveIds.push(row.id);
    return row;
  };

  const seedOvertime = async (
    employeeId: string,
    date: string,
    status = 'APPROVED',
  ) => {
    const row = await ctx.prisma.overtimeRequest.create({
      data: {
        employeeId,
        date: new Date(`${date}T00:00:00.000Z`),
        startTime: new Date(atUtc(date, '19:00')),
        endTime: new Date(atUtc(date, '21:00')),
        hours: 2,
        reason: `calendar-read overtime ${status} ${fx.runId}`,
        status,
      },
    });
    overtimeIds.push(row.id);
    return row;
  };

  const seedBranchHoliday = async (date: string, branchId: string) => {
    const row = await ctx.prisma.holiday.create({
      data: {
        name: `Calendar Read Holiday ${fx.runId}`,
        date: new Date(`${date}T00:00:00.000Z`),
        year: Number(date.slice(0, 4)),
        branchId,
        description: `calendar-read fixture ${fx.runId}`,
      },
    });
    holidayIds.push(row.id);
    return row;
  };

  const myCalendar = (token: string, startDate: string, endDate: string, employeeId?: string) =>
    ctx
      .http()
      .get('/calendar/my-calendar')
      .query({ startDate, endDate, ...(employeeId ? { employeeId } : {}) })
      .set(bearer(token));

  const overview = (token: string, startDate: string, endDate: string) =>
    ctx
      .http()
      .get('/calendar/overview')
      .query({ startDate, endDate })
      .set(bearer(token));

  const stats = (token: string, month: unknown, year: unknown) =>
    ctx.http().get('/calendar/stats').query({ month, year }).set(bearer(token));

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupScheduleFixtures(ctx);
  }, 120000);

  afterEach(async () => {
    if (scheduleIds.length)
      await ctx.prisma.workSchedule.deleteMany({
        where: { id: { in: scheduleIds.splice(0) } },
      });
    if (leaveIds.length)
      await ctx.prisma.leaveRequest.deleteMany({
        where: { id: { in: leaveIds.splice(0) } },
      });
    if (overtimeIds.length)
      await ctx.prisma.overtimeRequest.deleteMany({
        where: { id: { in: overtimeIds.splice(0) } },
      });
    if (holidayIds.length)
      await ctx.prisma.holiday.deleteMany({
        where: { id: { in: holidayIds.splice(0) } },
      });
  });

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // my-calendar — the four-source merge
  // ══════════════════════════════════════════════════════════════════════════
  describe('CAL-API-01..09 — my-calendar merge', () => {
    it('CAL-API-01 returns one event of each of the four types', async () => {
      // Everything is seeded inside this spec's own window so the assertion is
      // about the MERGE and not about what else happens to live in the month.
      const workDate = nextDate();
      const leaveDate = nextDate();
      const overtimeDate = nextDate();
      const holidayDate = nextDate();

      await seedSchedule(fx.staffAId, workDate);
      await seedLeave(fx.staffAId, leaveDate, leaveDate);
      await seedOvertime(fx.staffAId, overtimeDate);
      await seedBranchHoliday(holidayDate, fx.branchA);

      const res = await myCalendar(fx.employee.token, workDate, holidayDate);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const types = res.body.data.map((e: any) => e.type);
      expect(types).toEqual(
        expect.arrayContaining(['work', 'leave', 'overtime', 'holiday']),
      );
    });

    it('CAL-API-02 gives a fixed-window shift its real start and end', async () => {
      const date = nextDate();
      await seedSchedule(fx.staffAId, date);

      const res = await myCalendar(fx.employee.token, date, date);
      const work = res.body.data.find((e: any) => e.type === 'work');

      expect(work.allDay).toBe(false);
      expect(work.startDate).toBe(atUtc(date, '09:00'));
      expect(work.endDate).toBe(atUtc(date, '18:00'));
      expect(work.title).toBe('Work - Full Day');
      expect(work.requiredHours).toBeNull();
    });

    it('CAL-API-03 renders a FLEXIBLE shift as an all-day marker on its date', async () => {
      // A flexible day has no window, so the calendar cannot draw it as a band.
      // Both ends are the DATE and `allDay` is true — the shape FullCalendar
      // needs, and the reason the screen must not read `startTime`.
      const date = nextDate();
      await seedSchedule(fx.staffAId, date, {
        shiftType: 'FLEXIBLE',
        startTime: null,
        endTime: null,
        requiredHours: 7.5,
      });

      const res = await myCalendar(fx.employee.token, date, date);
      const work = res.body.data.find((e: any) => e.type === 'work');

      expect(work.allDay).toBe(true);
      expect(work.startDate).toBe(`${date}T00:00:00.000Z`);
      expect(work.endDate).toBe(`${date}T00:00:00.000Z`);
      expect(work.requiredHours).toBe(7.5);
      expect(work.title).toBe('Work - Flexible (7.5h)');
    });

    it('CAL-API-04 includes leave and overtime only when APPROVED', async () => {
      const approvedLeave = nextDate();
      const pendingLeave = nextDate();
      const rejectedLeave = nextDate();
      const approvedOt = nextDate();
      const pendingOt = nextDate();

      await seedLeave(fx.staffAId, approvedLeave, approvedLeave, 'APPROVED');
      await seedLeave(fx.staffAId, pendingLeave, pendingLeave, 'PENDING');
      await seedLeave(fx.staffAId, rejectedLeave, rejectedLeave, 'REJECTED');
      await seedOvertime(fx.staffAId, approvedOt, 'APPROVED');
      await seedOvertime(fx.staffAId, pendingOt, 'PENDING');

      const res = await myCalendar(fx.employee.token, approvedLeave, pendingOt);
      const leaves = res.body.data.filter((e: any) => e.type === 'leave');
      const overtimes = res.body.data.filter((e: any) => e.type === 'overtime');

      // A pending request is a request, not a commitment — showing it on the
      // calendar would tell someone they have the day off before anyone said so.
      expect(leaves).toHaveLength(1);
      expect(overtimes).toHaveLength(1);
      expect(leaves[0].startDate).toBe(`${approvedLeave}T00:00:00.000Z`);
    });

    it('CAL-API-05 includes a leave that starts before and ends after the window', async () => {
      // Overlap, not containment. A month view that only returned leave
      // STARTING inside it would drop every long absence from its second month.
      const before = nextDate();
      const windowDay = nextDate();
      const after = nextDate();
      await seedLeave(fx.staffAId, before, after);

      const res = await myCalendar(fx.employee.token, windowDay, windowDay);
      const leaves = res.body.data.filter((e: any) => e.type === 'leave');

      expect(leaves).toHaveLength(1);
    });

    it('CAL-API-06 returns an empty list for a range with nothing in it', async () => {
      const date = nextDate();
      const res = await myCalendar(fx.employee.token, date, date);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: [] });
    });

    it('CAL-API-07 handles a single-day range where startDate equals endDate', async () => {
      const date = nextDate();
      await seedSchedule(fx.staffAId, date);

      const res = await myCalendar(fx.employee.token, date, date);

      // The boundary is inclusive at both ends, so a one-day query finds the
      // day. `gte`/`lte` rather than `gt`/`lt` is the whole rule.
      expect(res.body.data.filter((e: any) => e.type === 'work')).toHaveLength(
        1,
      );
    });

    it('CAL-API-08 returns nothing for an inverted range rather than failing', async () => {
      const early = nextDate();
      const late = nextDate();
      await seedSchedule(fx.staffAId, early);

      const res = await myCalendar(fx.employee.token, late, early);

      // `gte late AND lte early` is unsatisfiable, so the answer is empty. Not
      // a 400 — the endpoint takes the range at face value. Pinned because the
      // screens never send one and a future validation change should be
      // deliberate.
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('CAL-API-09 spans a month boundary and a year boundary', async () => {
      // The server side of T18. The DEFECT is in the client, which builds the
      // range with `toISOString()` on a locally-constructed midnight; the server
      // is asked for whatever it is asked for. These cases prove the server
      // returns the last day of a month when the range names it, so a missing
      // shift on the 31st can only be the caller's range.
      const monthEnd = '2026-10-31';
      const nextMonthStart = '2026-11-01';
      const yearEnd = '2026-12-31';

      await seedSchedule(fx.staffAId, monthEnd);
      await seedSchedule(fx.staffAId, nextMonthStart);
      await seedSchedule(fx.staffAId, yearEnd);

      const acrossMonths = await myCalendar(
        fx.employee.token,
        '2026-10-01',
        '2026-11-30',
      );
      const octoberOnly = await myCalendar(
        fx.employee.token,
        '2026-10-01',
        '2026-10-31',
      );
      const yearEndOnly = await myCalendar(
        fx.employee.token,
        '2026-12-01',
        yearEnd,
      );

      expect(
        acrossMonths.body.data.filter((e: any) => e.type === 'work'),
      ).toHaveLength(2);
      // The last day of the month is returned when the range includes it.
      expect(
        octoberOnly.body.data.filter((e: any) => e.type === 'work'),
      ).toHaveLength(1);
      expect(
        yearEndOnly.body.data.filter((e: any) => e.type === 'work'),
      ).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Holidays in the merge
  // ══════════════════════════════════════════════════════════════════════════
  describe('CAL-API-10..12 — holidays', () => {
    it('CAL-API-10 includes a company-wide holiday for an employee of any branch', async () => {
      const res = await myCalendar(
        fx.employee.token,
        fx.companyHolidayDate,
        fx.companyHolidayDate,
      );
      const holidays = res.body.data.filter((e: any) => e.type === 'holiday');

      expect(holidays.length).toBeGreaterThanOrEqual(1);
      expect(holidays.some((h: any) => h.id === fx.companyHolidayId)).toBe(true);
    });

    it('CAL-API-11 includes a branch holiday for that branch only', async () => {
      // `branchHolidayId` belongs to branch A. `staffA` is in branch A and
      // `staffB` is in branch B, so the same date answers differently for the
      // two of them — which is the whole point of a per-branch holiday.
      const forBranchA = await myCalendar(
        fx.employee.token,
        fx.branchHolidayDate,
        fx.branchHolidayDate,
      );
      // Read through the GLOBAL hr account: `staffB` is in branch B, so a
      // branch-A-scoped caller would come back empty for reasons that have
      // nothing to do with holidays and the case would pass for the wrong one.
      const forBranchB = await myCalendar(
        fx.hr.token,
        fx.branchHolidayDate,
        fx.branchHolidayDate,
        fx.staffBId,
      );

      expect(
        forBranchA.body.data.some((e: any) => e.id === fx.branchHolidayId),
      ).toBe(true);
      expect(
        forBranchB.body.data.some((e: any) => e.id === fx.branchHolidayId),
      ).toBe(false);
    });

    it('CAL-API-12 shapes a holiday as an all-day event on its own date', async () => {
      const res = await myCalendar(
        fx.employee.token,
        fx.branchHolidayDate,
        fx.branchHolidayDate,
      );
      const holiday = res.body.data.find(
        (e: any) => e.id === fx.branchHolidayId,
      );

      expect(holiday.allDay).toBe(true);
      expect(holiday.type).toBe('holiday');
      expect(holiday.startDate).toBe(holiday.endDate);
      expect(holiday.title).toContain('Schedule Branch Holiday');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // overview — the matrix feed
  // ══════════════════════════════════════════════════════════════════════════
  describe('CAL-API-13..18 — overview', () => {
    it('CAL-API-13 returns the three arrays the matrix is built from', async () => {
      const date = nextDate();
      await seedSchedule(fx.staffAId, date);

      const res = await overview(fx.admin.token, date, date);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.schedules)).toBe(true);
      expect(Array.isArray(res.body.data.leaves)).toBe(true);
      expect(Array.isArray(res.body.data.overtimes)).toBe(true);
    });

    it('CAL-API-14 serialises the schedule shape the grid depends on', async () => {
      // The grid keys cells on `date` as a plain `YYYY-MM-DD` string and does
      // arithmetic on `requiredHours`. A `Decimal` would serialise as a string
      // and every hours figure would become a concatenation instead of a sum.
      const date = nextDate();
      await seedSchedule(fx.staffAId, date, {
        shiftType: 'FLEXIBLE',
        startTime: null,
        endTime: null,
        requiredHours: 7.5,
      });

      const res = await overview(fx.admin.token, date, date);
      const row = res.body.data.schedules.find(
        (s: any) => s.employeeId === fx.staffAId,
      );

      expect(row.date).toBe(date);
      expect(typeof row.date).toBe('string');
      expect(typeof row.requiredHours).toBe('number');
      expect(row.requiredHours).toBe(7.5);
      expect(typeof row.isWorkDay).toBe('boolean');
    });

    it('CAL-API-15 serialises leave and overtime dates as plain date strings too', async () => {
      const leaveDate = nextDate();
      const otDate = nextDate();
      await seedLeave(fx.staffAId, leaveDate, leaveDate);
      await seedOvertime(fx.staffAId, otDate);

      const res = await overview(fx.admin.token, leaveDate, otDate);
      const leave = res.body.data.leaves.find(
        (l: any) => l.employeeId === fx.staffAId,
      );
      const ot = res.body.data.overtimes.find(
        (o: any) => o.employeeId === fx.staffAId,
      );

      expect(leave.startDate).toBe(leaveDate);
      expect(leave.endDate).toBe(leaveDate);
      expect(ot.date).toBe(otDate);
      expect(typeof ot.hours).toBe('number');
    });

    it('CAL-API-16 returns empty arrays, not null, for a range with no data', async () => {
      const date = nextDate();
      const res = await overview(fx.admin.token, date, date);

      expect(res.body.data.schedules).toEqual([]);
      expect(res.body.data.leaves).toEqual([]);
      expect(res.body.data.overtimes).toEqual([]);
    });

    it('CAL-API-17 FIXED (T16): overview serves holidays and the per-branch weekly-off', async () => {
      // `getEmployeeCalendar` returned holidays and `getOverviewCalendar` did
      // not, and it said nothing at all about the work week — so the matrix
      // shaded weekends from the GLOBAL `calendar_weekly_holidays` setting
      // (`overview/page.tsx:48`) while the app has per-branch work weeks. An
      // Oman branch resting Fri/Sat was shaded Sat/Sun, and no amount of correct
      // client code could fix it while the endpoint declined to say.
      //
      // Read with branch A narrowed, because the resolved answer IS per branch —
      // see CAL-API-17b for the other branch and CAL-API-17c for the
      // all-branches fallback.
      const res = await ctx
        .http()
        .get('/calendar/overview')
        .query({
          startDate: fx.branchHolidayDate,
          endDate: fx.branchHolidayDate,
        })
        .set(bearer(fx.admin.token))
        .set('X-Branch-Id', fx.branchA);

      expect(Array.isArray(res.body.data.holidays)).toBe(true);
      expect(
        res.body.data.holidays.some((h: any) => h.id === fx.branchHolidayId),
      ).toBe(true);
      // branchA rests Sat+Sun in the fixture.
      expect(res.body.data.weeklyOffDays).toEqual([0, 6]);
    });

    it('CAL-API-17b FIXED (T17): the weekly-off answer follows the BRANCH', async () => {
      // The assertion that makes CAL-API-17 mean something. A fixture where both
      // branches rested on the same days would let a global-setting fallback
      // pass as if it were per-branch, which is why `schedule-fixtures.ts` gives
      // branchA '0,6' and branchB '4,5'.
      const forBranchB = await ctx
        .http()
        .get('/calendar/overview')
        .query({
          startDate: fx.branchHolidayDate,
          endDate: fx.branchHolidayDate,
        })
        .set(bearer(fx.admin.token))
        .set('X-Branch-Id', fx.branchB);

      expect(forBranchB.body.data.weeklyOffDays).toEqual([4, 5]);
      // And branch A's holiday is not branch B's.
      expect(
        forBranchB.body.data.holidays.some(
          (h: any) => h.id === fx.branchHolidayId,
        ),
      ).toBe(false);
    });

    it('CAL-API-17c falls back to the global setting when no branch is narrowed', async () => {
      // The all-branches view cannot have one per-branch answer, so it keeps the
      // company default — which is exactly what the screen did before, meaning
      // the fix adds an answer where there was none rather than changing one.
      const res = await ctx
        .http()
        .get('/calendar/overview')
        .query({
          startDate: fx.branchHolidayDate,
          endDate: fx.branchHolidayDate,
        })
        .set(bearer(fx.admin.token));

      expect(Array.isArray(res.body.data.weeklyOffDays)).toBe(true);
      expect(res.body.data.weeklyOffDays.length).toBeGreaterThan(0);
    });

    it('CAL-API-18 overview covers every employee, not just the caller', async () => {
      const date = nextDate();
      await seedSchedule(fx.staffAId, date);
      await seedSchedule(fx.staffOtherDeptId, date);

      const res = await overview(fx.admin.token, date, date);
      const ids = res.body.data.schedules.map((s: any) => s.employeeId);

      expect(ids).toEqual(
        expect.arrayContaining([fx.staffAId, fx.staffOtherDeptId]),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // stats
  // ══════════════════════════════════════════════════════════════════════════
  describe('CAL-API-19..26 — stats', () => {
    it('CAL-API-19 counts work days, leave days, overtime hours and holidays', async () => {
      // October is used because this spec's `freeDate` window straddles it and
      // nothing else in the suite writes there.
      const d1 = '2026-10-05';
      const d2 = '2026-10-06';
      const leaveDay = '2026-10-08';
      const otDay = '2026-10-09';
      const holidayDay = '2026-10-12';

      await seedSchedule(fx.staffAId, d1);
      await seedSchedule(fx.staffAId, d2);
      await seedLeave(fx.staffAId, leaveDay, leaveDay);
      await seedOvertime(fx.staffAId, otDay);
      await seedBranchHoliday(holidayDay, fx.branchA);

      const res = await stats(fx.employee.token, 10, 2026);

      expect(res.status).toBe(200);
      expect(res.body.data.workDays).toBe(2);
      expect(res.body.data.leaveDays).toBe(1);
      expect(res.body.data.overtimeHours).toBe(2);
      expect(res.body.data.holidays).toBe(1);
    });

    it('CAL-API-20 counts only working days towards workDays', async () => {
      const workDay = '2026-10-14';
      const restDay = '2026-10-15';
      await seedSchedule(fx.staffAId, workDay);
      await seedSchedule(fx.staffAId, restDay, { isWorkDay: false });

      const res = await stats(fx.employee.token, 10, 2026);

      expect(res.body.data.workDays).toBe(1);
    });

    it('CAL-API-21 returns zeroes for a month with nothing in it', async () => {
      const res = await stats(fx.employee.token, 11, 2026);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        workDays: 0,
        leaveDays: 0,
        overtimeHours: 0,
        holidays: 0,
      });
    });

    it('CAL-API-22 counts a PENDING request towards nothing', async () => {
      await seedLeave(fx.staffAId, '2026-10-20', '2026-10-20', 'PENDING');
      await seedOvertime(fx.staffAId, '2026-10-21', 'PENDING');

      const res = await stats(fx.employee.token, 10, 2026);

      expect(res.body.data.leaveDays).toBe(0);
      expect(res.body.data.overtimeHours).toBe(0);
    });

    it('CAL-API-23 respects the month boundary at both ends', async () => {
      // A schedule on the last day of October must count for October and not
      // for November, and vice versa. `Date.UTC(year, month, 0)` is the last
      // day of the month — off by one in either direction and a day migrates.
      await seedSchedule(fx.staffAId, '2026-10-31');
      await seedSchedule(fx.staffAId, '2026-11-01');

      const october = await stats(fx.employee.token, 10, 2026);
      const november = await stats(fx.employee.token, 11, 2026);

      expect(october.body.data.workDays).toBe(1);
      expect(november.body.data.workDays).toBe(1);
    });

    it('CAL-API-24 FIXED: a month outside 1-12 is a 400', async () => {
      // There was no validation on the query at all. `Date.UTC(2026, -1, 1)` is
      // December 2025 and `Date.UTC(2026, 12, 1)` is January 2027, so the
      // endpoint answered confidently about a month the caller did not ask for.
      const zero = await stats(fx.employee.token, 0, 2026);
      const thirteen = await stats(fx.employee.token, 13, 2026);
      const valid = await stats(fx.employee.token, 12, 2026);

      expect(zero.status).toBe(400);
      expect(thirteen.status).toBe(400);
      // The boundary itself still works — a cap that was off by one would look
      // identical from the rejection side alone.
      expect(valid.status).toBe(200);
    });

    it('CAL-API-25 FIXED: a non-numeric month is a 400, not a 500', async () => {
      // `+month` was NaN, `Date.UTC(2026, NaN, 1)` an Invalid Date, and Prisma
      // rejected it — an unvalidated input becoming a server fault. Same family
      // as T15 and T25, and fixed the same way: refuse it at the door.
      const res = await stats(fx.employee.token, 'october', 2026);

      expect(res.status).toBe(400);
    });

    it('CAL-API-26 stats counts a multi-day leave by its total days', async () => {
      // `leaveDays` sums `totalDays` rather than counting requests, so one
      // three-day absence is three days off and not one.
      const row = await ctx.prisma.leaveRequest.create({
        data: {
          employeeId: fx.staffAId,
          leaveType: 'ANNUAL',
          startDate: new Date('2026-11-09T00:00:00.000Z'),
          endDate: new Date('2026-11-11T00:00:00.000Z'),
          totalDays: 3,
          reason: `calendar-read multi-day ${fx.runId}`,
          status: 'APPROVED',
        },
      });
      leaveIds.push(row.id);

      const res = await stats(fx.employee.token, 11, 2026);

      expect(res.body.data.leaveDays).toBe(3);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Malformed input
  // ══════════════════════════════════════════════════════════════════════════
  describe('CAL-API-27..28 — malformed ranges', () => {
    it('CAL-API-27 FIXED: an unparseable date is a 400', async () => {
      const res = await myCalendar(fx.employee.token, 'yesterday', 'tomorrow');

      expect(res.status).toBe(400);
      // And the refusal says nothing about the inside of the server.
      expect(JSON.stringify(res.body)).not.toContain('/home/');
    });

    it('CAL-API-28 FIXED: a missing range is a 400', async () => {
      // `startDate` and `endDate` were documented `required: true` in Swagger
      // and enforced nowhere — there was no DTO on these query parameters at
      // all, so an absent range became `new Date(undefined)` and failed at the
      // data layer instead of at the door.
      const res = await ctx
        .http()
        .get('/calendar/my-calendar')
        .set(bearer(fx.employee.token));

      expect(res.status).toBe(400);
    });

    it('CAL-API-28b the same validation guards overview and conflicts/check', async () => {
      // Three routes took the same range and only one of them would have been
      // fixed by patching a single handler. Asserted together so a fourth route
      // added later has an obvious pattern to follow.
      const overviewBad = await ctx
        .http()
        .get('/calendar/overview')
        .query({ startDate: 'whenever' })
        .set(bearer(fx.admin.token));
      const conflictsBad = await ctx
        .http()
        .get('/calendar/schedules/conflicts/check')
        .query({ employeeId: fx.staffAId, startDate: 'whenever' })
        .set(bearer(fx.admin.token));
      const conflictsNoEmployee = await ctx
        .http()
        .get('/calendar/schedules/conflicts/check')
        .query({ startDate: '2026-10-01', endDate: '2026-10-31' })
        .set(bearer(fx.admin.token));

      expect(overviewBad.status).toBe(400);
      expect(conflictsBad.status).toBe(400);
      expect(conflictsNoEmployee.status).toBe(400);
    });
  });
});
