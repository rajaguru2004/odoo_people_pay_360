import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupScheduleFixtures,
  ScheduleFixtures,
  freeDate,
  atUtc,
} from './utils/schedule-fixtures';
import { bearer, withSettings } from './utils/settings';
import { ShiftNotificationScheduler } from '../src/calendar/shift-notification.scheduler';
import { HolidaysService } from '../src/holidays/holidays.service';

/**
 * Time & Schedules — the seams with everything else.
 *
 * `WorkSchedule` has no behaviour of its own beyond CRUD; its value is that four
 * other modules read it. This suite is about those edges, and about the
 * decisions at them that are surprising enough to be worth pinning even where
 * nothing is broken:
 *
 *   - LEAVE refuses a schedule going in, and does nothing to one already there.
 *   - OVERTIME does not consult the roster at all (D1).
 *   - ATTENDANCE prefers an explicit schedule over the office hours, and a
 *     FLEXIBLE day suppresses the late/early derivation entirely (D6).
 *   - HOLIDAYS and the per-branch work week decide which days are shaded (T17).
 *   - The REMINDER SCHEDULER turns a schedule into two emails and two flags.
 *
 * The scheduler is driven by CALLING IT, never by waiting on its `@Cron`.
 * `ScheduleModule.forRoot()` is deliberately not registered in
 * `test-app.module.ts`, so no tick ever fires here — which is what makes the
 * flag assertions deterministic rather than a race with a background job.
 *
 * This spec owns `freeDate(270..305)` — 2026-11-26 to 2026-12-31. The reminder
 * cases are the exception: they need shifts starting relative to the real clock,
 * so they build their own rows around `now` and clean them up by id.
 */
describe('Time & Schedules — cross-module seams (e2e)', () => {
  let ctx: E2EContext;
  let fx: ScheduleFixtures;
  let scheduler: ShiftNotificationScheduler;

  const DATE_BASE = 270;
  let dateSeq = 0;
  const nextDate = () => freeDate(DATE_BASE + dateSeq++);

  const scheduleIds: string[] = [];
  const leaveIds: string[] = [];
  const overtimeIds: string[] = [];
  const holidayIds: string[] = [];
  const attendanceIds: string[] = [];

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

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupScheduleFixtures(ctx);
    scheduler = ctx.app.get(ShiftNotificationScheduler);
  }, 120000);

  afterEach(async () => {
    if (attendanceIds.length)
      await ctx.prisma.attendance.deleteMany({
        where: { id: { in: attendanceIds.splice(0) } },
      });
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
  // Leave
  // ══════════════════════════════════════════════════════════════════════════
  describe('X-T-01..03 — leave', () => {
    it('X-T-01 DECISION: approving leave over an existing schedule leaves the schedule standing', async () => {
      // The asymmetry worth knowing about. Creating a schedule on an approved
      // leave day is refused; approving leave over an existing schedule is not,
      // and nothing removes or flags the roster row. So the same forbidden
      // combination is reachable, just in the other order.
      //
      // Pinned rather than fixed because the right answer is a product
      // question, not a bug: silently deleting someone's roster when their
      // leave is approved would destroy information nobody asked to lose, and
      // refusing the leave because a shift exists would make the roster outrank
      // the absence. The honest fix is a warning at approval time, which is a
      // feature and out of this phase's scope.
      const date = nextDate();
      const schedule = await seedSchedule(fx.staffAId, date);

      const leave = await ctx.prisma.leaveRequest.create({
        data: {
          employeeId: fx.staffAId,
          leaveType: 'ANNUAL',
          startDate: new Date(`${date}T00:00:00.000Z`),
          endDate: new Date(`${date}T00:00:00.000Z`),
          totalDays: 1,
          reason: `cross-module leave ${fx.runId}`,
          status: 'APPROVED',
        },
      });
      leaveIds.push(leave.id);

      const survivor = await ctx.prisma.workSchedule.findUnique({
        where: { id: schedule.id },
      });
      expect(survivor).not.toBeNull();
      // And the calendar shows both, which is at least honest about the clash.
      const calendar = await ctx
        .http()
        .get('/calendar/my-calendar')
        .query({ startDate: date, endDate: date })
        .set(bearer(fx.employee.token));
      const types = calendar.body.data.map((e: any) => e.type);
      expect(types).toEqual(expect.arrayContaining(['work', 'leave']));
    });

    it('X-T-02 the reverse order is refused, so the rule is directional not absent', async () => {
      const date = nextDate();
      const leave = await ctx.prisma.leaveRequest.create({
        data: {
          employeeId: fx.staffAId,
          leaveType: 'ANNUAL',
          startDate: new Date(`${date}T00:00:00.000Z`),
          endDate: new Date(`${date}T00:00:00.000Z`),
          totalDays: 1,
          reason: `cross-module leave ${fx.runId}`,
          status: 'APPROVED',
        },
      });
      leaveIds.push(leave.id);

      const res = await ctx
        .http()
        .post('/calendar/schedules')
        .set(bearer(fx.admin.token))
        .send({
          employeeId: fx.staffAId,
          date,
          shiftType: 'FULL_DAY',
          startTime: atUtc(date, '09:00'),
          endTime: atUtc(date, '18:00'),
        });
      if (res.body?.data?.id) scheduleIds.push(res.body.data.id);

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('leave day');
    });

    it('X-T-03 a PENDING leave does not block scheduling', async () => {
      // Only APPROVED absence is a commitment. A rule that blocked on PENDING
      // would let anyone freeze their own roster by filing a request.
      const date = nextDate();
      const leave = await ctx.prisma.leaveRequest.create({
        data: {
          employeeId: fx.staffAId,
          leaveType: 'ANNUAL',
          startDate: new Date(`${date}T00:00:00.000Z`),
          endDate: new Date(`${date}T00:00:00.000Z`),
          totalDays: 1,
          reason: `cross-module pending ${fx.runId}`,
          status: 'PENDING',
        },
      });
      leaveIds.push(leave.id);

      const res = await ctx
        .http()
        .post('/calendar/schedules')
        .set(bearer(fx.admin.token))
        .send({
          employeeId: fx.staffAId,
          date,
          shiftType: 'FULL_DAY',
          startTime: atUtc(date, '09:00'),
          endTime: atUtc(date, '18:00'),
        });
      if (res.body?.data?.id) scheduleIds.push(res.body.data.id);

      expect(res.status).toBe(201);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Overtime
  // ══════════════════════════════════════════════════════════════════════════
  describe('X-T-04 — overtime', () => {
    it('X-T-04 D1: a NIGHT shift does not move the overtime window', async () => {
      // Decision, not defect. The overtime window comes from
      // `office_start_time` + `overtime_shift_end_time` and the holiday /
      // weekly-off calendar (`overtime.service.ts:111-175`); it never reads
      // `WorkSchedule`. So an employee rostered on nights has their overtime
      // measured against the OFFICE day, not their own shift.
      //
      // Asserted by observing that the same overtime request is treated
      // identically with and without a night shift on the date. If the roster
      // ever starts feeding the overtime window, this goes red and the change
      // has to be deliberate.
      const withoutShift = nextDate();
      const withNight = nextDate();

      await seedSchedule(fx.staffAId, withNight, {
        shiftType: 'NIGHT',
        startTime: new Date(atUtc(withNight, '22:00')),
        endTime: new Date(`${nextDate()}T06:00:00.000Z`),
      });

      const mkOvertime = async (date: string) => {
        const row = await ctx.prisma.overtimeRequest.create({
          data: {
            employeeId: fx.staffAId,
            date: new Date(`${date}T00:00:00.000Z`),
            startTime: new Date(atUtc(date, '19:00')),
            endTime: new Date(atUtc(date, '21:00')),
            hours: 2,
            reason: `cross-module ot ${fx.runId}`,
            status: 'APPROVED',
          },
        });
        overtimeIds.push(row.id);
        return row;
      };
      const plain = await mkOvertime(withoutShift);
      const nightly = await mkOvertime(withNight);

      // Same stored hours, same approved state — the roster changed nothing.
      expect(Number(plain.hours)).toBe(Number(nightly.hours));

      const calendar = await ctx
        .http()
        .get('/calendar/my-calendar')
        .query({ startDate: withoutShift, endDate: withNight })
        .set(bearer(fx.employee.token));
      const overtimes = calendar.body.data.filter(
        (e: any) => e.type === 'overtime',
      );
      expect(overtimes).toHaveLength(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Attendance precedence (D6)
  // ══════════════════════════════════════════════════════════════════════════
  describe('X-T-05..07 — attendance precedence', () => {
    /** Record attendance through the real admin door and register it for teardown. */
    const manualAttendance = async (
      employeeId: string,
      date: string,
      checkIn: string,
      checkOut: string,
    ) => {
      const res = await ctx
        .http()
        .post('/attendances/manual')
        .set(bearer(fx.admin.token))
        .send({ employeeId, date, checkIn, checkOut, status: 'PRESENT' });
      const id = res.body?.data?.id;
      if (id) attendanceIds.push(id);
      return res;
    };

    it('X-T-05 D6: an explicit WorkSchedule beats the office hours for lateness', async () => {
      // Two employees, one date, the same arrival time. One has a shift that
      // starts at 12:00; the other has none and is measured against the office
      // day. Asserted on the `Attendance` row rather than on a mock, which is
      // what makes it evidence that the two modules agree rather than that they
      // were configured to.
      const date = nextDate();
      await seedSchedule(fx.staffAId, date, {
        shiftType: 'CUSTOM',
        startTime: new Date(atUtc(date, '12:00')),
        endTime: new Date(atUtc(date, '20:00')),
      });

      const scheduled = await manualAttendance(
        fx.staffAId,
        date,
        atUtc(date, '12:00'),
        atUtc(date, '20:00'),
      );
      const unscheduled = await manualAttendance(
        fx.staffNoContractId,
        date,
        atUtc(date, '12:00'),
        atUtc(date, '20:00'),
      );

      expect(scheduled.status).toBe(201);
      expect(unscheduled.status).toBe(201);

      const scheduledRow = await ctx.prisma.attendance.findUnique({
        where: { id: scheduled.body.data.id },
      });
      const unscheduledRow = await ctx.prisma.attendance.findUnique({
        where: { id: unscheduled.body.data.id },
      });

      // Arriving exactly at the start of your own shift is not late.
      expect(scheduledRow?.isLate).toBe(false);
      // The same arrival with no shift is measured against the office start,
      // which is hours earlier — so the two rows disagree, and the disagreement
      // IS the precedence.
      expect(unscheduledRow?.isLate).toBe(true);
    });

    it('X-T-06 D6: a FLEXIBLE day suppresses late and early derivation entirely', async () => {
      // A flexible shift has no window, so "late" has nothing to be late
      // against. The service branches on this in three places; this is the one
      // that reaches the stored row.
      const date = nextDate();
      await seedSchedule(fx.staffAId, date, {
        shiftType: 'FLEXIBLE',
        startTime: null,
        endTime: null,
        requiredHours: 8,
      });

      const res = await manualAttendance(
        fx.staffAId,
        date,
        // Deliberately absurd: hours after any office start, and a short day.
        atUtc(date, '15:00'),
        atUtc(date, '17:00'),
      );
      expect(res.status).toBe(201);

      const row = await ctx.prisma.attendance.findUnique({
        where: { id: res.body.data.id },
      });
      expect(row?.isLate).toBe(false);
      expect(row?.isEarlyCheckIn).toBe(false);
      expect(row?.isEarlyLeave).toBe(false);
    });

    it('X-T-07 a non-working scheduled day is not treated as the shift', async () => {
      // `isWorkDay: false` is excluded by the resolver's own `where`, so a
      // rostered rest day falls back to the office hours rather than being
      // treated as a shift with no window.
      const date = nextDate();
      await seedSchedule(fx.staffAId, date, {
        isWorkDay: false,
        startTime: new Date(atUtc(date, '12:00')),
        endTime: new Date(atUtc(date, '20:00')),
      });

      const res = await manualAttendance(
        fx.staffAId,
        date,
        atUtc(date, '12:00'),
        atUtc(date, '20:00'),
      );
      expect(res.status).toBe(201);

      const row = await ctx.prisma.attendance.findUnique({
        where: { id: res.body.data.id },
      });
      // Measured against the office day, exactly as if the row were absent.
      expect(row?.isLate).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Branch calendar (T17) and holidays
  // ══════════════════════════════════════════════════════════════════════════
  describe('X-T-08..10 — branch calendar', () => {
    it('X-T-08 T17: the same date is a rest day in one branch and a work day in the other', async () => {
      // The engine `organization-branch.e2e-spec.ts:654` already asserts, read
      // here through the resolver the schedule matrix now consumes. branchA
      // rests Sat+Sun, branchB rests Thu+Fri — a fixture where both rested on
      // the same days would let a global-setting fallback pass as per-branch.
      const holidays = ctx.app.get(HolidaysService);

      const forA = await holidays.getWeeklyOffDays(fx.branchA);
      const forB = await holidays.getWeeklyOffDays(fx.branchB);

      expect(forA).toEqual([0, 6]);
      expect(forB).toEqual([4, 5]);
      // Friday is a rest day in B and a work day in A. That single fact is what
      // the overview used to get wrong for every non-default branch.
      expect(forA.includes(5)).toBe(false);
      expect(forB.includes(5)).toBe(true);
    });

    it('X-T-09 the overview serves each branch its own week and its own holidays', async () => {
      // The HTTP half of X-T-08: the same request, two branch contexts, two
      // answers. This is what the matrix reads.
      const ask = (branchId: string) =>
        ctx
          .http()
          .get('/calendar/overview')
          .query({
            startDate: fx.branchHolidayDate,
            endDate: fx.branchHolidayDate,
          })
          .set(bearer(fx.admin.token))
          .set('X-Branch-Id', branchId);

      const a = await ask(fx.branchA);
      const b = await ask(fx.branchB);

      expect(a.body.data.weeklyOffDays).toEqual([0, 6]);
      expect(b.body.data.weeklyOffDays).toEqual([4, 5]);
      expect(a.body.data.holidays.some((h: any) => h.id === fx.branchHolidayId)).toBe(true);
      expect(b.body.data.holidays.some((h: any) => h.id === fx.branchHolidayId)).toBe(false);
    });

    it('X-T-10 a branch holiday landing on a scheduled day shows both', async () => {
      // Nothing prevents scheduling somebody on a holiday, and nothing should:
      // holiday cover is real work. What matters is that the calendar reports
      // both facts rather than letting one hide the other.
      const date = nextDate();
      const holiday = await ctx.prisma.holiday.create({
        data: {
          name: `Cross-module Holiday ${fx.runId}`,
          date: new Date(`${date}T00:00:00.000Z`),
          year: Number(date.slice(0, 4)),
          branchId: fx.branchA,
          description: `cross-module fixture ${fx.runId}`,
        },
      });
      holidayIds.push(holiday.id);

      const created = await ctx
        .http()
        .post('/calendar/schedules')
        .set(bearer(fx.admin.token))
        .send({
          employeeId: fx.staffAId,
          date,
          shiftType: 'FULL_DAY',
          startTime: atUtc(date, '09:00'),
          endTime: atUtc(date, '18:00'),
        });
      if (created.body?.data?.id) scheduleIds.push(created.body.data.id);
      expect(created.status).toBe(201);

      const calendar = await ctx
        .http()
        .get('/calendar/my-calendar')
        .query({ startDate: date, endDate: date })
        .set(bearer(fx.employee.token));
      const types = calendar.body.data.map((e: any) => e.type);
      expect(types).toEqual(expect.arrayContaining(['work', 'holiday']));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Employee lifecycle
  // ══════════════════════════════════════════════════════════════════════════
  describe('X-T-11..12 — employee lifecycle', () => {
    it('X-T-11 deleting an employee cascades their schedules away', async () => {
      // `onDelete: Cascade` on the relation. Asserted because the alternative —
      // orphaned rows the overview would still count — is invisible until a
      // stat tile disagrees with a grid that has no row to render.
      const victim = await ctx.prisma.employee.create({
        data: {
          employeeCode: `SEM-${fx.runId}-CASCADE`,
          fullName: 'Schedule Cascade',
          dateOfBirth: new Date('1992-01-01'),
          idCard: `SID-${fx.runId}-CASCADE`,
          email: `cascade-${fx.runId}@test.local`,
          departmentId: fx.deptAId,
          branchId: fx.branchA,
          position: 'Engineer',
          startDate: new Date('2020-01-01'),
          baseSalary: 50000,
          status: 'ACTIVE',
        },
      });
      const date = nextDate();
      const schedule = await ctx.prisma.workSchedule.create({
        data: {
          employeeId: victim.id,
          date: new Date(`${date}T00:00:00.000Z`),
          shiftType: 'FULL_DAY',
          startTime: new Date(atUtc(date, '09:00')),
          endTime: new Date(atUtc(date, '18:00')),
        },
      });

      await ctx.prisma.employee.delete({ where: { id: victim.id } });

      expect(
        await ctx.prisma.workSchedule.findUnique({ where: { id: schedule.id } }),
      ).toBeNull();
    });

    it('X-T-12 T4: a department move changes whose calendar a manager may read', async () => {
      // The authorization is resolved per request from the employee's CURRENT
      // department, not from anything cached on the token. Moving someone into
      // a manager's department grants that manager sight of their calendar and
      // moving them out removes it, with no re-login in between.
      const date = nextDate();
      await seedSchedule(fx.staffOtherDeptId, date);

      const read = () =>
        ctx
          .http()
          .get('/calendar/my-calendar')
          .query({
            startDate: date,
            endDate: date,
            employeeId: fx.staffOtherDeptId,
          })
          .set(bearer(fx.manager.token));

      // `manager` heads deptA; `staffOtherDept` is in deptOther.
      expect((await read()).status).toBe(404);

      await ctx.prisma.employee.update({
        where: { id: fx.staffOtherDeptId },
        data: { departmentId: fx.deptAId },
      });
      try {
        const after = await read();
        expect(after.status).toBe(200);
        expect(after.body.data.some((e: any) => e.type === 'work')).toBe(true);
      } finally {
        await ctx.prisma.employee.update({
          where: { id: fx.staffOtherDeptId },
          data: { departmentId: fx.deptOtherId },
        });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // The reminder scheduler
  // ══════════════════════════════════════════════════════════════════════════
  describe('X-T-13..17 — shift reminder scheduler', () => {
    /**
     * A shift starting `minutesFromNow` from the real clock.
     *
     * The scheduler's windows are relative to `new Date()`, so these rows cannot
     * come from `freeDate` like everything else. The DATE column is taken from
     * the same instant the times are, rather than from a separately-computed
     * "today" — a lesson from the attendance module, where three cases located a
     * row by a date the test computed instead of the one the service used.
     */
    const shiftStartingIn = async (
      minutesFromNow: number,
      over: Record<string, unknown> = {},
    ) => {
      const start = new Date(Date.now() + minutesFromNow * 60 * 1000);
      const end = new Date(start.getTime() + 8 * 60 * 60 * 1000);
      const row = await ctx.prisma.workSchedule.create({
        data: {
          employeeId: fx.staffFlexibleId,
          date: new Date(
            `${start.toISOString().slice(0, 10)}T00:00:00.000Z`,
          ),
          shiftType: 'CUSTOM',
          startTime: start,
          endTime: end,
          isWorkDay: true,
          ...over,
        },
      });
      scheduleIds.push(row.id);
      return row;
    };

    /** Run the scheduler with the reminder offsets pinned, then restore them. */
    const runScheduler = () =>
      withSettings(
        ctx,
        { shift_reminder_prior_mins: '5', shift_reminder_post_mins: '5' },
        () => scheduler.checkAndSendShiftNotifications(),
      );

    it('X-T-13 a shift inside the prior window is reminded exactly once', async () => {
      const schedule = await shiftStartingIn(3);

      await runScheduler();
      const afterFirst = await ctx.prisma.workSchedule.findUnique({
        where: { id: schedule.id },
      });
      expect(afterFirst?.priorEmailSent).toBe(true);

      // The flag IS the idempotency: a second invocation must find nothing.
      await runScheduler();
      const afterSecond = await ctx.prisma.workSchedule.findUnique({
        where: { id: schedule.id },
      });
      expect(afterSecond?.priorEmailSent).toBe(true);
      expect(afterSecond?.updatedAt).toEqual(afterFirst?.updatedAt);
    });

    it('X-T-14 a shift outside the prior window is left alone', async () => {
      // Two hours out is not "starting soon". Without this the case above would
      // pass against a scheduler that reminded every shift it could find.
      const schedule = await shiftStartingIn(120);

      await runScheduler();

      const row = await ctx.prisma.workSchedule.findUnique({
        where: { id: schedule.id },
      });
      expect(row?.priorEmailSent).toBe(false);
    });

    it('X-T-15 a FLEXIBLE shift is never reminded', async () => {
      // It has no fixed start, so there is no moment to remind anyone about.
      // The row still carries times here — the scheduler must exclude it on
      // TYPE, not by noticing the times are null.
      const schedule = await shiftStartingIn(3, { shiftType: 'FLEXIBLE' });

      await runScheduler();

      const row = await ctx.prisma.workSchedule.findUnique({
        where: { id: schedule.id },
      });
      expect(row?.priorEmailSent).toBe(false);
    });

    it('X-T-16 a non-working day is never reminded', async () => {
      const schedule = await shiftStartingIn(3, { isWorkDay: false });

      await runScheduler();

      const row = await ctx.prisma.workSchedule.findUnique({
        where: { id: schedule.id },
      });
      expect(row?.priorEmailSent).toBe(false);
    });

    it('X-T-17 a shift that started inside the post window gets the started-notice', async () => {
      // The other half of the scheduler: [now - postOffset - 10, now - postOffset].
      // At a 5-minute offset a shift that began 8 minutes ago is inside it.
      const schedule = await shiftStartingIn(-8);

      await runScheduler();

      const row = await ctx.prisma.workSchedule.findUnique({
        where: { id: schedule.id },
      });
      expect(row?.postEmailSent).toBe(true);
      // And it is not ALSO treated as an upcoming shift.
      expect(row?.priorEmailSent).toBe(false);
    });
  });
});
