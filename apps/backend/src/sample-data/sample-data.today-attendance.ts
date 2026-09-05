/**
 * Nightly demo attendance top-up.
 *
 * The demo dataset seeds a fixed span of history, so the day after a seed every
 * screen that asks "who is in today?" opens empty — the attendance day list
 * shows the whole roster as "Not checked-in" and the dashboard's Active tile
 * reads 0. This closes that gap WITHOUT reseeding: a full reseed wipes anything
 * a demo viewer created, which is worse than stale data.
 *
 * Two passes, both idempotent:
 *
 *   1. Close yesterday — rows that have a check-in and no check-out get one, so
 *      history reads as completed days rather than a roster stuck at work.
 *   2. Open today — one PRESENT row per active employee, checked in just after
 *      their branch's office start.
 *
 * Deliberately NOT writing today's check-out: the demo should look like a day in
 * progress at 09:00, not one everybody already left. Tomorrow's run closes it.
 *
 * Every instant is built in the BRANCH's zone (see `atZonedTime`) because the UI
 * renders instants in `system_timezone`; tagging a local hour as UTC is what put
 * 14:03 check-ins on the demo in the first place.
 */
import { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

type PrismaLike = PrismaClient | any;

export interface TodayAttendanceResult {
  /** Rows created for today. */
  created: number;
  /** Yesterday's open rows given a check-out. */
  closed: number;
  /** Employees skipped because the day is a weekly off / holiday for them. */
  offDay: number;
  /** Employees skipped because a row for that date already existed. */
  existing: number;
}

/** Company-wide fallback when a branch sets no office window of its own. */
const DEFAULT_OFFICE = { start: '08:00', end: '17:00' };
/** Matches AttendancesService.LATE_THRESHOLD — seeded rows must agree with it. */
const LATE_GRACE_MINS = 15;
/** Share of the roster that arrives late, so "Going late today" is never empty. */
const LATE_SHARE = 0.15;

const parseHHMM = (hhmm: string | null | undefined, fallback: string): [number, number] => {
  const [h, m] = (hhmm || fallback).split(':').map(Number);
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0];
};

const parseWeeklyOff = (csv: string): number[] =>
  csv
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

/**
 * A branch may hold a typo'd zone — the demo data carries 'Aska/Kolkata' on two
 * of them. Luxon returns an Invalid DateTime for those: `toISODate()` yields
 * null, `dateKey(null)` an Invalid Date whose `getTime()` is NaN, and the
 * `Math.max` over the day keys below becomes NaN — an invalid Prisma filter
 * that throws and takes EVERY other branch's rows down with it. Fall back to a
 * known-good zone instead of failing the whole run for one bad row.
 */
const safeZone = (tz: string | null | undefined, fallback: string): string =>
  tz && DateTime.local().setZone(tz).isValid ? tz : fallback;

/** The instant of `HH:MM` on `localDay` ('YYYY-MM-DD') in `tz`. */
const atZonedTime = (localDay: string, tz: string, h: number, min: number): Date =>
  DateTime.fromISO(localDay, { zone: tz }).set({ hour: h, minute: min, second: 0, millisecond: 0 }).toJSDate();

/** UTC-midnight date key for a local calendar day — what Attendance.date stores. */
const dateKey = (localDay: string): Date => new Date(`${localDay}T00:00:00.000Z`);

/**
 * Stable per-employee-per-day jitter. A PRNG seeded off the id keeps re-runs
 * identical (a second run the same night must not shuffle everyone's minutes)
 * while still spreading the roster across the arrival window.
 */
const hashUnit = (...parts: string[]): number => {
  let h = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return ((h >>> 0) % 10000) / 10000;
};

interface BranchWindow {
  tz: string;
  startH: number;
  startM: number;
  endH: number;
  endM: number;
  weeklyOff: number[];
}

export async function seedTodayAttendance(
  prisma: PrismaLike,
  opts: { now?: Date; companyTz?: string; includeOffDays?: boolean } = {},
): Promise<TodayAttendanceResult> {
  const now = opts.now ?? new Date();
  const companyTz = safeZone(opts.companyTz, 'Asia/Kolkata');

  const globalOff = await prisma.systemSetting.findUnique({
    where: { key: 'calendar_weekly_holidays' },
  });
  const globalWeeklyOff = globalOff?.value ? parseWeeklyOff(globalOff.value) : [0];

  const branches = await prisma.branch.findMany({
    select: {
      id: true,
      timezone: true,
      officeStartTime: true,
      officeEndTime: true,
      weeklyOffDays: true,
    },
  });
  const windows = new Map<string, BranchWindow>();
  for (const b of branches) {
    const [startH, startM] = parseHHMM(b.officeStartTime, DEFAULT_OFFICE.start);
    const [endH, endM] = parseHHMM(b.officeEndTime, DEFAULT_OFFICE.end);
    windows.set(b.id, {
      tz: safeZone(b.timezone, companyTz),
      startH,
      startM,
      endH,
      endM,
      // '' means "never set", not "no days off". parseWeeklyOff('') returns [0]
      // (Number('') === 0), which silently pins Sunday and ignores the global
      // setting — only a non-empty CSV may override it.
      weeklyOff:
        b.weeklyOffDays != null && b.weeklyOffDays.trim() !== ''
          ? parseWeeklyOff(b.weeklyOffDays)
          : globalWeeklyOff,
    });
  }
  const companyWindow: BranchWindow = {
    tz: companyTz,
    startH: parseHHMM(null, DEFAULT_OFFICE.start)[0],
    startM: parseHHMM(null, DEFAULT_OFFICE.start)[1],
    endH: parseHHMM(null, DEFAULT_OFFICE.end)[0],
    endM: parseHHMM(null, DEFAULT_OFFICE.end)[1],
    weeklyOff: globalWeeklyOff,
  };

  const employees = await prisma.employee.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, branchId: true, timezone: true },
  });

  const result: TodayAttendanceResult = { created: 0, closed: 0, offDay: 0, existing: 0 };

  // ── Pass 1: close yesterday's open rows ──────────────────────────────────
  // Scoped to rows this job wrote (source AUTO) so a real ESS check-in left open
  // by a demo viewer is not silently "completed" behind their back.
  const openRows = await prisma.attendance.findMany({
    where: {
      source: 'AUTO',
      checkIn: { not: null },
      checkOut: null,
      date: { lt: dateKey(DateTime.fromJSDate(now).setZone(companyTz).toISODate() as string) },
    },
    select: { id: true, employeeId: true, date: true, checkIn: true, branchId: true },
  });
  for (const row of openRows) {
    const w = (row.branchId && windows.get(row.branchId)) || companyWindow;
    const localDay = row.date.toISOString().slice(0, 10);
    const jitter = Math.round(hashUnit(row.employeeId, localDay, 'out') * 45) - 10;
    const checkOut = atZonedTime(localDay, w.tz, w.endH, w.endM + jitter);
    const workHours = Math.round(((checkOut.getTime() - row.checkIn.getTime()) / 3_600_000) * 100) / 100;
    await prisma.attendance.update({
      where: { id: row.id },
      data: {
        checkOut,
        workHours,
        isEarlyLeave: jitter < -5,
        isLateCheckout: jitter > 30,
      },
    });
    result.closed += 1;
  }

  // ── Pass 2: open today ───────────────────────────────────────────────────
  // Runs after pass 1 on purpose: closing yesterday is worth doing even on an
  // empty roster (an emptied demo still has history to tidy).
  if (!employees.length) return result;

  const rows: any[] = [];
  const localDayOf = (empTz: string): string =>
    DateTime.fromJSDate(now).setZone(empTz).toISODate() as string;

  // Approved leave covering the employee's local today → a LEAVE row, not a
  // phantom check-in. Fetched once for the whole roster rather than per person.
  const todayKeys = new Set(
    employees.map((e) => {
      const w = (e.branchId && windows.get(e.branchId)) || companyWindow;
      return localDayOf(safeZone(e.timezone, w.tz));
    }),
  );
  const keyList = [...todayKeys].map(dateKey);
  const onLeave = await prisma.leaveRequest.findMany({
    where: {
      status: 'APPROVED',
      startDate: { lte: new Date(Math.max(...keyList.map((d) => d.getTime()))) },
      endDate: { gte: new Date(Math.min(...keyList.map((d) => d.getTime()))) },
    },
    select: { employeeId: true, startDate: true, endDate: true },
  });

  const existing = await prisma.attendance.findMany({
    where: { date: { in: keyList }, employeeId: { in: employees.map((e) => e.id) } },
    select: { employeeId: true, date: true },
  });
  const already = new Set(existing.map((a) => `${a.employeeId}|${a.date.toISOString().slice(0, 10)}`));

  for (const emp of employees) {
    const w = (emp.branchId && windows.get(emp.branchId)) || companyWindow;
    const tz = safeZone(emp.timezone, w.tz);
    const localDay = localDayOf(tz);

    if (already.has(`${emp.id}|${localDay}`)) {
      result.existing += 1;
      continue;
    }
    const dow = DateTime.fromISO(localDay, { zone: tz }).weekday % 7; // luxon 1=Mon..7=Sun → 0=Sun
    // A demo tenant is judged on never opening empty, so it can be told to fill
    // weekly offs as well. The branch's real working week is untouched either
    // way — rest-day overtime and the holiday calendar still read weeklyOffDays.
    if (!opts.includeOffDays && w.weeklyOff.includes(dow)) {
      result.offDay += 1;
      continue;
    }

    const key = dateKey(localDay);
    const leave = onLeave.find(
      (l) => l.employeeId === emp.id && l.startDate <= key && l.endDate >= key,
    );
    if (leave) {
      rows.push({
        employeeId: emp.id,
        date: key,
        status: 'LEAVE',
        branchId: emp.branchId ?? null,
        source: 'AUTO',
      });
      continue;
    }

    const roll = hashUnit(emp.id, localDay, 'in');
    const late = roll < LATE_SHARE;
    // On time: office start + 0..12 min. Late: +25..50, past the 15-minute grace.
    const offset = late ? 25 + Math.round(roll * 100) : Math.round(roll * 12);
    const checkIn = atZonedTime(localDay, tz, w.startH, w.startM + offset);
    rows.push({
      employeeId: emp.id,
      date: key,
      checkIn,
      status: 'PRESENT',
      isLate: offset > LATE_GRACE_MINS,
      branchId: emp.branchId ?? null,
      source: 'AUTO',
    });
  }

  if (rows.length) {
    const written = await prisma.attendance.createMany({ data: rows, skipDuplicates: true });
    result.created = written.count;
  }
  return result;
}
