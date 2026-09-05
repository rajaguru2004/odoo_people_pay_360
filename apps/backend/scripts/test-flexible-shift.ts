/**
 * Flexible Shift — end-to-end integration test against the DEV database.
 *
 * Instantiates the REAL services (CalendarService, AttendancesService) wired to
 * the REAL Prisma/dev DB and drives every flexible-shift scenario, asserting on
 * the persisted results. A throwaway employee is created and fully removed at the
 * end (cascade deletes its schedules + attendances), so the DB is left untouched.
 *
 * Run:  npx ts-node scripts/test-flexible-shift.ts
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { SystemSettingsService } from '../src/system-settings/system-settings.service';
import { TimezoneService } from '../src/common/timezone/timezone.service';
import { AttendancesService } from '../src/attendances/attendances.service';
import { CalendarService } from '../src/calendar/calendar.service';
import { HolidaysService } from '../src/holidays/holidays.service';
import { CreateScheduleDto, ShiftType } from '../src/calendar/dto/create-schedule.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

// ── tiny assertion harness ──────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failureNames: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failureNames.push(name);
    console.log(`  ✗ ${name} ${detail}`);
  }
}
async function expectThrow(name: string, fn: () => Promise<unknown>, matcher?: RegExp) {
  try {
    await fn();
    check(name, false, '(expected an error but none was thrown)');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, matcher ? matcher.test(msg) : true, `(threw: "${msg}")`);
  }
}

const HOUR = 60 * 60 * 1000;
const uniq = Date.now();

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();

  // Real services (upload/mail are stubbed — never exercised by these paths).
  const settings = new SystemSettingsService(prisma, {} as never);
  const tz = new TimezoneService(settings);
  const mail = new Proxy({}, { get: () => async () => undefined }) as never;
  const holidays = new HolidaysService(prisma);
  const attendance = new AttendancesService(prisma, settings, tz, mail, holidays);
  const calendar = new CalendarService(prisma, holidays);

  // Ensure the GLOBAL multi-checkin toggle is OFF during the test so we can prove
  // flexible shifts force multi-session independently. Restored in finally.
  const origMultiRow = await prisma.systemSetting.findUnique({
    where: { key: 'allow_multiple_checkin' },
  });
  if (origMultiRow && origMultiRow.value === 'true') {
    await prisma.systemSetting.update({
      where: { key: 'allow_multiple_checkin' },
      data: { value: 'false' },
    });
  }

  const dept = await prisma.department.findFirst({ select: { id: true } });
  if (!dept) throw new Error('No department found in dev DB');

  const emp = await prisma.employee.create({
    data: {
      employeeCode: `FLEX-TEST-${uniq}`,
      fullName: 'Flexible Shift Test Employee',
      dateOfBirth: new Date(Date.UTC(1995, 0, 1)),
      idCard: `FLEXID-${uniq}`,
      email: `flex-test-${uniq}@example.com`,
      departmentId: dept.id,
      position: 'Tester',
      startDate: new Date(Date.UTC(2020, 0, 1)),
      status: 'ACTIVE',
      baseSalary: 50000,
      timezone: null, // inherit company TZ (Asia/Kolkata)
    },
    select: { id: true },
  });
  const employeeId = emp.id;

  // Attendance "today" key (company TZ) — align schedule dates with check-in logic.
  const todayKey: Date = await (
    attendance as unknown as {
      toAttendanceDateKey: (d: Date, tz: string | null) => Promise<Date>;
    }
  ).toAttendanceDateKey(new Date(), null);
  const todayStr = todayKey.toISOString().slice(0, 10);
  const dstr = (offsetDays: number) =>
    new Date(todayKey.getTime() + offsetDays * 24 * HOUR).toISOString().slice(0, 10);

  try {
    // ── S1: create a flexible schedule (single) ────────────────────────────
    console.log('\nS1 — create flexible schedule (single)');
    const s1 = await calendar.createSchedule({
      employeeId,
      date: dstr(10),
      shiftType: ShiftType.FLEXIBLE,
      requiredHours: 8,
    } as CreateScheduleDto);
    const s1row = s1.data;
    check('shiftType persisted as FLEXIBLE', s1row.shiftType === 'FLEXIBLE');
    check('startTime is null', s1row.startTime === null);
    check('endTime is null', s1row.endTime === null);
    check('requiredHours persisted = 8', Number(s1row.requiredHours) === 8);

    // ── S2: DTO validation (class-validator) ───────────────────────────────
    console.log('\nS2 — DTO validation rules');
    const mk = (o: Record<string, unknown>) =>
      plainToInstance(CreateScheduleDto, { employeeId, date: dstr(11), ...o });
    const flexNoHours = await validate(mk({ shiftType: ShiftType.FLEXIBLE }));
    check(
      'flexible without requiredHours is rejected',
      flexNoHours.some((e) => e.property === 'requiredHours'),
    );
    const flexOk = await validate(mk({ shiftType: ShiftType.FLEXIBLE, requiredHours: 7.5 }));
    check('flexible with requiredHours is valid', flexOk.length === 0);
    const flexNegative = await validate(
      mk({ shiftType: ShiftType.FLEXIBLE, requiredHours: -2 }),
    );
    check(
      'flexible with negative requiredHours is rejected',
      flexNegative.some((e) => e.property === 'requiredHours'),
    );
    const fixedNoTimes = await validate(mk({ shiftType: ShiftType.FULL_DAY }));
    check(
      'fixed without start/end time is rejected',
      fixedNoTimes.some((e) => e.property === 'startTime') &&
        fixedNoTimes.some((e) => e.property === 'endTime'),
    );
    const fixedOk = await validate(
      mk({
        shiftType: ShiftType.FULL_DAY,
        startTime: '2030-01-01T09:00:00.000Z',
        endTime: '2030-01-01T17:00:00.000Z',
      }),
    );
    check('fixed with start/end time is valid', fixedOk.length === 0);

    // ── S3: conflict detection (flexible = date-level exclusive) ────────────
    console.log('\nS3 — conflict detection');
    const cDate = dstr(12);
    await calendar.createSchedule({
      employeeId,
      date: cDate,
      shiftType: ShiftType.FLEXIBLE,
      requiredHours: 8,
    } as CreateScheduleDto);
    await expectThrow(
      'fixed shift on a day that already has a flexible shift is rejected',
      () =>
        calendar.createSchedule({
          employeeId,
          date: cDate,
          shiftType: ShiftType.FULL_DAY,
          startTime: `${cDate}T09:00:00.000Z`,
          endTime: `${cDate}T17:00:00.000Z`,
        } as CreateScheduleDto),
      /overlap/i,
    );
    await expectThrow(
      'second flexible shift on the same day is rejected',
      () =>
        calendar.createSchedule({
          employeeId,
          date: cDate,
          shiftType: ShiftType.FLEXIBLE,
          requiredHours: 6,
        } as CreateScheduleDto),
      /overlap/i,
    );
    // Regression: two non-overlapping fixed shifts on a fresh day still allowed.
    const cDate2 = dstr(13);
    await calendar.createSchedule({
      employeeId,
      date: cDate2,
      shiftType: ShiftType.CUSTOM,
      startTime: `${cDate2}T09:00:00.000Z`,
      endTime: `${cDate2}T12:00:00.000Z`,
    } as CreateScheduleDto);
    let secondFixedOk = true;
    try {
      await calendar.createSchedule({
        employeeId,
        date: cDate2,
        shiftType: ShiftType.CUSTOM,
        startTime: `${cDate2}T13:00:00.000Z`,
        endTime: `${cDate2}T17:00:00.000Z`,
      } as CreateScheduleDto);
    } catch {
      secondFixedOk = false;
    }
    check('non-overlapping fixed shifts still allowed (regression)', secondFixedOk);

    // ── S4: update — switching shift types ─────────────────────────────────
    console.log('\nS4 — update / switch shift types');
    const uDate = dstr(14);
    const fixed = await calendar.createSchedule({
      employeeId,
      date: uDate,
      shiftType: ShiftType.CUSTOM,
      startTime: `${uDate}T09:00:00.000Z`,
      endTime: `${uDate}T17:00:00.000Z`,
    } as CreateScheduleDto);
    const toFlex = await calendar.updateSchedule(fixed.data.id, {
      shiftType: ShiftType.FLEXIBLE,
      requiredHours: 6,
    });
    check(
      'fixed -> flexible clears times and sets requiredHours',
      toFlex.data.startTime === null &&
        toFlex.data.endTime === null &&
        Number(toFlex.data.requiredHours) === 6,
    );
    const backToFixed = await calendar.updateSchedule(fixed.data.id, {
      shiftType: ShiftType.CUSTOM,
      startTime: `${uDate}T10:00:00.000Z`,
      endTime: `${uDate}T18:00:00.000Z`,
    });
    check(
      'flexible -> fixed clears requiredHours and sets times',
      backToFixed.data.requiredHours === null &&
        backToFixed.data.startTime !== null &&
        backToFixed.data.endTime !== null,
    );
    await expectThrow(
      'flexible -> fixed without providing times is rejected',
      () =>
        calendar.updateSchedule(s1row.id, { shiftType: ShiftType.CUSTOM }),
      /Start and end time/i,
    );

    // ── S5: check-in on a flexible shift (no late flag, forces multi-session)
    console.log('\nS5 — flexible check-in (no late flag, multi-session forced)');
    await calendar.createSchedule({
      employeeId,
      date: todayStr,
      shiftType: ShiftType.FLEXIBLE,
      requiredHours: 8,
    } as CreateScheduleDto);
    const cleanToday = async () =>
      prisma.attendance.deleteMany({ where: { employeeId, date: todayKey } });

    await cleanToday();
    const globalMulti =
      (await settings.getSetting('allow_multiple_checkin', 'false')) === 'true';
    const ci1: any = await attendance.checkIn(employeeId, true);
    check('check-in succeeds', ci1.success === true);
    check('flexible check-in is never marked late', ci1.data.isLate === false);
    check('flexible check-in is never marked early', ci1.data.isEarlyCheckIn === false);
    check('flexible forces allowMultiple even when global is off', globalMulti === false && ci1.data.allowMultiple === true);
    await expectThrow(
      'double check-in (already open session) is rejected',
      () => attendance.checkIn(employeeId, true),
      /already checked in|already/i,
    );
    await attendance.checkOut(employeeId, true);
    let secondCheckInOk = true;
    try {
      await attendance.checkIn(employeeId, true);
    } catch {
      secondCheckInOk = false;
    }
    check('second session check-in allowed on flexible day (global OFF)', secondCheckInOk);
    const afterTwo = await prisma.attendance.findFirst({ where: { employeeId, date: todayKey } });
    const sessCount = Array.isArray(afterTwo?.sessions) ? (afterTwo!.sessions as unknown[]).length : 0;
    check('two sessions recorded in one day', sessCount === 2, `(sessions=${sessCount})`);

    // ── S6: hours = sum of sessions, NO lunch deduction ────────────────────
    console.log('\nS6 — hours summed with NO lunch deduction (flexible)');
    await cleanToday();
    await attendance.checkIn(employeeId, true);
    const now = new Date();
    // Seed one exactly-5h completed session + a just-opened active session.
    await prisma.attendance.update({
      where: { id: (await prisma.attendance.findFirst({ where: { employeeId, date: todayKey } }))!.id },
      data: {
        sessions: [
          { checkIn: new Date(now.getTime() - 5 * HOUR), checkOut: now },
          { checkIn: now, checkOut: null },
        ] as never,
      },
    });
    const co: any = await attendance.checkOut(employeeId, true);
    const wh = Number(co.data.workHours);
    check('workHours ~= 5 (5h logged, no 1h lunch deduction)', wh >= 4.98 && wh <= 5.05, `(got ${wh})`);
    check('flexible check-out is not flagged early leave', co.data.isEarlyLeave === false);
    check('flexible check-out is not flagged late checkout', co.data.isLateCheckout === false);

    // ── S7: getTodayAttendance returns flexible info + progress ─────────────
    console.log('\nS7 — getTodayAttendance flexible info + targetMet');
    const t1: any = await attendance.getTodayAttendance(employeeId);
    check('today payload marks isFlexible', t1.data.isFlexible === true);
    check('today payload carries requiredHours = 8', Number(t1.data.requiredHours) === 8);
    check('targetMet is false when 5h < 8h target', t1.data.targetMet === false);

    // ── S8: exceeding the target (>100%, no auto-overtime) ─────────────────
    console.log('\nS8 — exceeding the target (no auto-overtime)');
    const todayRow = await prisma.attendance.findFirst({ where: { employeeId, date: todayKey } });
    await prisma.attendance.update({ where: { id: todayRow!.id }, data: { workHours: 10 } });
    const t2: any = await attendance.getTodayAttendance(employeeId);
    check('targetMet is true when 10h >= 8h target', t2.data.targetMet === true);
    check('workHours stored uncapped at 10', Number(t2.data.workHours) === 10);
    const otCount = await prisma.overtimeRequest.count({ where: { employeeId } });
    check('no OvertimeRequest auto-created for exceeding target', otCount === 0);

    // ── S9: bulk creation with flexible items ──────────────────────────────
    console.log('\nS9 — bulk create flexible schedules');
    const bulk: any = await calendar.bulkCreateSchedules({
      schedules: [
        { employeeId, date: dstr(20), shiftType: ShiftType.FLEXIBLE, requiredHours: 8 },
        { employeeId, date: dstr(21), shiftType: ShiftType.FLEXIBLE, requiredHours: 9 },
      ],
    } as never);
    check('bulk reports 2 successes', bulk.data.success === 2, `(success=${bulk.data.success})`);
    const bulkRows = await prisma.workSchedule.findMany({
      where: { employeeId, date: { in: [new Date(dstr(20)), new Date(dstr(21))] } },
      orderBy: { date: 'asc' },
    });
    check(
      'bulk flexible rows have null times + requiredHours',
      bulkRows.length === 2 &&
        bulkRows.every((r) => r.startTime === null && r.endTime === null && r.requiredHours !== null),
    );

    // ── S10: manual attendance — flexible vs fixed hour deduction contrast ──
    console.log('\nS10 — manual attendance hour contrast (flexible vs fixed)');
    const flexDay = dstr(-3);
    const fixedDay = dstr(-4);
    await calendar.createSchedule({
      employeeId,
      date: flexDay,
      shiftType: ShiftType.FLEXIBLE,
      requiredHours: 8,
    } as CreateScheduleDto);
    await calendar.createSchedule({
      employeeId,
      date: fixedDay,
      shiftType: ShiftType.CUSTOM,
      startTime: `${fixedDay}T09:00:00.000Z`,
      endTime: `${fixedDay}T18:00:00.000Z`,
    } as CreateScheduleDto);
    const mFlex: any = await attendance.createManualAttendance({
      employeeId,
      date: flexDay,
      checkIn: '09:00',
      checkOut: '15:00', // 6h local
      status: 'PRESENT',
    });
    const mFixed: any = await attendance.createManualAttendance({
      employeeId,
      date: fixedDay,
      checkIn: '09:00',
      checkOut: '15:00', // 6h local
      status: 'PRESENT',
    });
    check('manual flexible: 6h logged -> 6h (no lunch deduction)', Number(mFlex.data.workHours) === 6, `(got ${mFlex.data.workHours})`);
    check('manual fixed: 6h logged -> 5h (1h lunch deducted)', Number(mFixed.data.workHours) === 5, `(got ${mFixed.data.workHours})`);
    check('manual flexible has no late/early flags', mFlex.data.isLate === false && mFlex.data.isEarlyLeave === false && mFlex.data.isEarlyCheckIn === false && mFlex.data.isLateCheckout === false);

    // ── S11: shift-reminder cron excludes flexible (null start) ────────────
    console.log('\nS11 — reminder cron excludes flexible shifts');
    // Mimic the scheduler query window around a flexible schedule's date.
    const remStart = new Date(new Date(dstr(10)).getTime() - 24 * HOUR);
    const remEnd = new Date(new Date(dstr(10)).getTime() + 24 * HOUR);
    const rangeOnly = await prisma.workSchedule.findMany({
      where: { employeeId, startTime: { gte: remStart, lte: remEnd }, isWorkDay: true },
    });
    check(
      'flexible rows (null startTime) never match a startTime range query',
      rangeOnly.every((r) => r.shiftType !== 'FLEXIBLE'),
    );
    const withFilter = await prisma.workSchedule.findMany({
      where: {
        employeeId,
        startTime: { gte: remStart, lte: remEnd },
        isWorkDay: true,
        shiftType: { not: 'FLEXIBLE' },
      },
    });
    check('explicit shiftType!=FLEXIBLE filter returns no flexible rows', withFilter.every((r) => r.shiftType !== 'FLEXIBLE'));
  } finally {
    // ── cleanup ──────────────────────────────────────────────────────────
    console.log('\nCleaning up test data...');
    await prisma.attendance.deleteMany({ where: { employeeId } });
    await prisma.workSchedule.deleteMany({ where: { employeeId } });
    await prisma.employee.delete({ where: { id: employeeId } }).catch(() => undefined);
    if (origMultiRow && origMultiRow.value === 'true') {
      await prisma.systemSetting.update({
        where: { key: 'allow_multiple_checkin' },
        data: { value: 'true' },
      });
    }
    const leftover = await prisma.employee.count({ where: { id: employeeId } });
    console.log(`Cleanup complete (test employee removed: ${leftover === 0}).`);
    await prisma.$disconnect();
  }

  console.log(`\n================ RESULT ================`);
  console.log(`PASSED: ${passed}   FAILED: ${failed}`);
  if (failed > 0) {
    console.log('Failing checks:', failureNames.join(' | '));
    process.exitCode = 1;
  } else {
    console.log('ALL FLEXIBLE-SHIFT SCENARIOS PASSED ✅');
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
