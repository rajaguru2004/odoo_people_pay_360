/**
 * Today's attendance for the Bengaluru Hub branch.
 *
 * The Bangalore demo seed writes 100 days of history but stops at yesterday and
 * skips weekends outright, so on any weekend — and on the morning of any day it
 * has not been re-run — `/dashboard` answers "Nobody was expected in today" and
 * the attendance card prints an em dash. This fills in the one day the dashboard
 * actually asks about.
 *
 * SCOPE. One branch (`SMP-BLR`), one date. It writes:
 *
 *   - an `attendances` row per ACTIVE employee of that branch
 *   - the matching `work_schedules` row for the same day
 *
 * The roster row is written alongside deliberately. `expected` on the dashboard
 * is derived from the attendance rows themselves (present + absent + not-checked-
 * in), so attendance alone would already fill the card — but the roster screen
 * reads `work_schedules`, and a day where twenty people are marked present while
 * the roster says nobody was rostered is two screens disagreeing about the same
 * morning. NOTE that this marks the day a WORKING day even when it falls on a
 * weekend, which is the point when you are seeding "today" on a Sunday.
 *
 * DETERMINISTIC. The status mix is drawn from a generator seeded by the date, so
 * a given day always produces the same board and a screenshot stays reproducible.
 *
 * Run from apps/backend, against a DEV/LOCAL database — never PROD:
 *   npm run prisma:seed:blr-today
 *
 * A specific day instead of today, and a different branch:
 *   SEED_DATE=2026-09-04 SEED_BRANCH=SMP-MAA npm run prisma:seed:blr-today
 *
 * Undo (removes exactly what the same invocation would have written):
 *   SEED_CLEANUP=1 npm run prisma:seed:blr-today
 *
 * Re-running converges rather than duplicating: the day's rows for the branch
 * are deleted before they are rewritten.
 */

import 'reflect-metadata';
import { Prisma, PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

const prisma = new PrismaClient();

const BRANCH_CODE = process.env.SEED_BRANCH ?? 'SMP-BLR';
const CLEANUP = process.env.SEED_CLEANUP === '1';

/** Same board every run for a given day: a screenshot keeps matching. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dec = (n: number | string) => new Prisma.Decimal(n);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The company's calendar date, as the date column stores it.
 *
 * Mirrors `TimezoneService.toDateKey`: take the local Y-M-D in the company zone
 * and pin it to UTC midnight. Deriving it from the process clock instead would
 * seed the WRONG DAY for most of the evening — 19:30 UTC is already tomorrow in
 * Kolkata, and the dashboard asks about the Kolkata day.
 */
function dateKey(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * A wall-clock time on `iso` in `tz`, as the instant it denotes.
 *
 * Luxon rather than an offset subtraction, so a branch on a zone that observes
 * DST is still handed the instant its people actually clocked in at.
 */
function at(iso: string, tz: string, hour: number, minute: number): Date {
  return DateTime.fromISO(iso, { zone: tz })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

/** "09:00" → {hour: 9, minute: 0}; anything unparseable falls back. */
function parseClock(value: string | null, fallback: [number, number]) {
  const m = /^(\d{1,2}):(\d{2})/.exec(value ?? '');
  if (!m) return { hour: fallback[0], minute: fallback[1] };
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Deterministic Fisher-Yates, so the quotas below land on stable people. */
function shuffled<T>(xs: readonly T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type Status =
  | 'PRESENT'
  | 'MISSED_CHECKOUT'
  | 'LEAVE'
  | 'ABSENT'
  | 'NOT_CHECKED_IN';

/**
 * How the day is split.
 *
 * Quotas rather than a per-person dice roll, so every bucket the dashboard
 * counts is filled at any headcount — a roll can hand you a day with nobody
 * absent, and a card that reads 100% every time is not showing that it works.
 *
 * `LEAVE` is deliberately outside `expected`: the dashboard divides by the
 * working calendar MINUS approved leave, so somebody on leave must not drag the
 * rate down.
 */
function statusPlan(headcount: number, rng: () => number): Status[] {
  const slice = (fraction: number) =>
    Math.min(headcount, Math.max(1, Math.round(headcount * fraction)));

  const onLeave = slice(0.08);
  const absent = slice(0.08);
  const notCheckedIn = slice(0.08);
  const missedCheckout = headcount >= 12 ? 1 : 0;
  const present = Math.max(
    0,
    headcount - onLeave - absent - notCheckedIn - missedCheckout,
  );

  const plan: Status[] = [
    ...Array<Status>(present).fill('PRESENT'),
    ...Array<Status>(missedCheckout).fill('MISSED_CHECKOUT'),
    ...Array<Status>(onLeave).fill('LEAVE'),
    ...Array<Status>(absent).fill('ABSENT'),
    ...Array<Status>(notCheckedIn).fill('NOT_CHECKED_IN'),
  ];
  return shuffled(plan, rng);
}

async function main() {
  const branch = await prisma.branch.findUnique({
    where: { code: BRANCH_CODE },
    select: {
      id: true,
      code: true,
      name: true,
      timezone: true,
      officeStartTime: true,
      officeEndTime: true,
    },
  });
  if (!branch) {
    throw new Error(
      `No branch with code ${BRANCH_CODE}. Run the base seed first, or pass SEED_BRANCH.`,
    );
  }

  // The company zone is what the dashboard resolves "today" in; the branch zone
  // is only the fallback for a company that never set one.
  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'system_timezone' },
    select: { value: true },
  });
  const rawTz = setting?.value ?? branch.timezone ?? 'Asia/Kolkata';
  const tz = DateTime.now().setZone(rawTz).isValid ? rawTz : 'Asia/Kolkata';

  const iso = process.env.SEED_DATE ?? DateTime.now().setZone(tz).toISODate()!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`SEED_DATE must be YYYY-MM-DD, got "${iso}".`);
  }
  const date = dateKey(iso);
  const weekday = DateTime.fromISO(iso).toFormat('cccc');

  const employees = await prisma.employee.findMany({
    where: { branchId: branch.id, status: 'ACTIVE' },
    select: { id: true, employeeCode: true, fullName: true },
    orderBy: { employeeCode: 'asc' },
  });
  if (!employees.length) {
    throw new Error(`${branch.name} has no active employees to write for.`);
  }

  const ids = employees.map((e) => e.id);

  // Delete before write, for both modes: cleanup stops here, a seed run
  // continues and rewrites, so a re-run converges instead of colliding with the
  // unique (employee, date) index.
  const removedAttendance = await prisma.attendance.deleteMany({
    where: { date, employeeId: { in: ids } },
  });
  const removedSchedules = await prisma.workSchedule.deleteMany({
    where: { date, employeeId: { in: ids } },
  });

  if (CLEANUP) {
    console.log(
      `🧹 ${branch.name} — ${iso}: removed ${removedAttendance.count} attendance row(s) ` +
        `and ${removedSchedules.count} roster row(s).`,
    );
    return;
  }

  const open = parseClock(branch.officeStartTime, [9, 0]);
  const close = parseClock(branch.officeEndTime, [18, 0]);
  const shiftStart = at(iso, tz, open.hour, open.minute);
  const shiftEnd = at(iso, tz, close.hour, close.minute);
  // "Late" and "left early" are judged against the branch's own hours, not a
  // hardcoded 9-to-6 — a branch that opens at 09:30 has different late arrivals.
  const lateAfter = at(iso, tz, open.hour, open.minute + 15);
  const lateCheckoutAfter = at(iso, tz, close.hour, close.minute + 30);

  const rng = mulberry32(Number(iso.replace(/-/g, '')));
  const plan = statusPlan(employees.length, rng);
  const roster = shuffled(employees, rng);

  const attendance: Prisma.AttendanceCreateManyInput[] = [];
  const schedules: Prisma.WorkScheduleCreateManyInput[] = [];
  const syncedAt = new Date();

  roster.forEach((employee, i) => {
    const status = plan[i];

    schedules.push({
      employeeId: employee.id,
      date,
      shiftType: 'FULL_DAY',
      startTime: shiftStart,
      endTime: shiftEnd,
      requiredHours: dec(
        round2((shiftEnd.getTime() - shiftStart.getTime()) / 3_600_000),
      ),
      isWorkDay: true,
      notes: `Seeded working day — ${weekday}.`,
    });

    if (
      status === 'LEAVE' ||
      status === 'ABSENT' ||
      status === 'NOT_CHECKED_IN'
    ) {
      attendance.push({
        employeeId: employee.id,
        date,
        status,
        branchId: branch.id,
        // MANUAL for the two a human decides, so a later import cannot silently
        // undo them. NOT_CHECKED_IN is the system's own placeholder for a day
        // still open, and stays AUTO.
        source: status === 'NOT_CHECKED_IN' ? 'AUTO' : 'MANUAL',
        notes:
          status === 'LEAVE'
            ? 'Approved leave.'
            : status === 'ABSENT'
              ? 'No check-in recorded.'
              : 'Rostered, not yet checked in.',
      });
      return;
    }

    const late = rng() > 0.78;
    const early = rng() > 0.88;
    const checkIn = at(
      iso,
      tz,
      open.hour,
      open.minute +
        (late ? 22 + Math.floor(rng() * 30) : -8 + Math.floor(rng() * 12)),
    );

    if (status === 'MISSED_CHECKOUT') {
      // Checked in and never closed the day out. No workHours: an unfinished
      // day has no measured length, and inventing one would put hours into the
      // reports that nobody worked.
      attendance.push({
        employeeId: employee.id,
        date,
        status,
        branchId: branch.id,
        checkIn,
        isLate: checkIn.getTime() > lateAfter.getTime(),
        isEarlyCheckIn: checkIn.getTime() < shiftStart.getTime(),
        checkInLatitude: dec(round2(12.926 + rng() * 0.004).toFixed(7)),
        checkInLongitude: dec(round2(77.6762 + rng() * 0.004).toFixed(7)),
        checkInAccuracy: dec(round2(6 + rng() * 14)),
        source: 'AUTO',
        externalRef: `TP-${employee.employeeCode}-${iso}`,
        syncedAt,
        notes: 'No check-out recorded.',
      });
      return;
    }

    const checkOut = at(
      iso,
      tz,
      early ? close.hour - 1 : close.hour,
      early ? close.minute - 20 : close.minute + Math.floor(rng() * 45),
    );
    attendance.push({
      employeeId: employee.id,
      date,
      status: 'PRESENT',
      branchId: branch.id,
      checkIn,
      checkOut,
      isLate: checkIn.getTime() > lateAfter.getTime(),
      isEarlyLeave: checkOut.getTime() < shiftEnd.getTime(),
      isEarlyCheckIn: checkIn.getTime() < shiftStart.getTime(),
      isLateCheckout: checkOut.getTime() > lateCheckoutAfter.getTime(),
      workHours: dec(
        round2((checkOut.getTime() - checkIn.getTime()) / 3_600_000),
      ),
      checkInLatitude: dec(round2(12.926 + rng() * 0.004).toFixed(7)),
      checkInLongitude: dec(round2(77.6762 + rng() * 0.004).toFixed(7)),
      checkInAccuracy: dec(round2(6 + rng() * 14)),
      source: rng() > 0.25 ? 'AUTO' : 'FACE',
      externalRef: `TP-${employee.employeeCode}-${iso}`,
      syncedAt,
    });
  });

  await prisma.attendance.createMany({ data: attendance });
  await prisma.workSchedule.createMany({ data: schedules });

  const count = (s: Status) => attendance.filter((a) => a.status === s).length;
  const present = count('PRESENT') + count('MISSED_CHECKOUT');
  const expected = present + count('ABSENT') + count('NOT_CHECKED_IN');

  console.log(
    `🌱 ${branch.name} (${branch.code}) — ${iso} (${weekday}), ${tz}`,
  );
  console.log(
    `  ✓ ${attendance.length} attendance rows, ${schedules.length} roster rows`,
  );
  console.table([
    {
      present,
      late: attendance.filter((a) => a.isLate).length,
      absent: count('ABSENT'),
      onLeave: count('LEAVE'),
      notCheckedIn: count('NOT_CHECKED_IN'),
      expected,
      // The dashboard's own rule: null when there was nothing to divide by, so
      // an empty branch never prints 0.0% as if it had measured something.
      attendanceRate: expected
        ? `${round2((present / expected) * 100)}%`
        : null,
    },
  ]);
  console.log(
    `  ℹ ${weekday} is marked a working day for these ${schedules.length} employees, ` +
      `so the roster agrees with the attendance board.`,
  );
  console.log(
    `  ↩ undo: SEED_CLEANUP=1 SEED_DATE=${iso} npm run prisma:seed:blr-today`,
  );
}

main()
  .catch((e) => {
    console.error("❌ Seeding today's attendance failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
