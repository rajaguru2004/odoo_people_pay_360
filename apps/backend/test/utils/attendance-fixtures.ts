import * as bcrypt from 'bcrypt';
import { E2EContext } from './e2e-app';
import { readSetting, writeSetting, restoreSetting } from './settings';
import { TimezoneService } from '../../src/common/timezone/timezone.service';

/**
 * The Time & Attendance module's fixture set: three branches shaped around the
 * per-branch override chain, three departments, and the employees each of the
 * module's rules branches on.
 *
 * A NEW file rather than an extension of `org-fixtures.ts` or
 * `people-fixtures.ts`, deliberately, and the reason is stronger here than it
 * was for People:
 *
 *  1. DECISIVE — attendance's aggregate endpoints have no per-run filter.
 *     `getMonthlyReport`, `getStatistics`, `getAbsenteeismStats`,
 *     `validateAttendanceData`, `getTodayAllAttendances` and `autoMarkAbsent`
 *     read EVERY ACTIVE employee company-wide, with nothing but the branch
 *     middleware between them and the rest of the database. `people-fixtures.ts`
 *     creates fifteen ACTIVE employees; importing it would silently make every
 *     count in this suite depend on People's headcount, and
 *     `POST /auto-mark-absent` would write an ABSENT row for each of them.
 *
 *  2. `Attendance.branch` is `onDelete: Restrict` (schema.prisma L569). No
 *     existing fixture creates an attendance row carrying a `branchId`, so no
 *     existing `cleanup()` has ever had to delete Attendance before Branch.
 *     Folding attendance in would make every Organization and People teardown
 *     newly capable of failing on an FK edge neither module owns.
 *
 *  3. The branch rows are shaped differently. Attendance needs one branch with
 *     all SEVEN per-branch override columns set and one with all of them null,
 *     so a case can tell "the global said no" from "the branch column said no".
 *     Org's branches are shaped for branch CRUD; People's branch B is an empty
 *     404 target.
 *
 * What IS shared: `bearer` and the settings snapshot helpers from `./settings`.
 *
 * Everything is tagged with a unique `runId` so `cleanup()` can bulk-delete
 * without touching a shared database's real rows.
 *
 * ── WHO OWNS "TODAY" ────────────────────────────────────────────────────────
 * `Attendance` carries `@@unique([employeeId, date])`, which makes today's row
 * the scarcest resource in this module: two specs punching the same employee on
 * the same day collide with a 400 that reads exactly like a product bug. Each
 * actor below is therefore owned by EXACTLY ONE spec file for today's writes:
 *
 *   attendance-punch.e2e-spec.ts      puncher, puncher2, remoteAhead,
 *                                     remoteBehind, flexStaff, shiftStaff,
 *                                     overrideStaff
 *   attendance-admin.e2e-spec.ts      absentee, onLeaveStaff, finStaff, newHire
 *   attendance-correction.e2e-spec.ts correctionStaff
 *   attendance-face.e2e-spec.ts       nullBranchStaff
 *   attendance-scoping.e2e-spec.ts    foreignStaff
 *
 * A spec that needs to punch someone else's actor seeds its own employee.
 */

const PASSWORD = 'Passw0rd!';

/**
 * The historical block every read-side case asserts against.
 *
 * February 2019 is chosen deliberately: it is before every fixture `startDate`
 * below, it has 28 days, it contains no DST transition in any zone this suite
 * uses, and no other suite writes there (People uses relative dates). A
 * relative window would move under a long-lived database and collide with
 * whatever the previous run left.
 */
export const HIST_YEAR = 2019;
export const HIST_MONTH = 2;

/** A UTC-midnight `@db.Date` key, which is how Prisma stores `Attendance.date`. */
export const histDay = (day: number) =>
  new Date(Date.UTC(HIST_YEAR, HIST_MONTH - 1, day));

/** An instant on a historical day, at a given local-UTC hour/minute. */
const histAt = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(HIST_YEAR, HIST_MONTH - 1, day, hour, minute));

export interface AttendanceUser {
  userId: string;
  employeeId?: string;
  email: string;
  token: string;
}

export interface AttendanceFixtures {
  runId: string;
  password: string;

  /**
   * All seven per-branch config columns NULL — the branch that must fall
   * through to the global SystemSetting. Without a fully-null branch, an "OFF"
   * kill-switch case cannot tell "the global said no" from "the branch column
   * said no".
   */
  branchHome: string;
  branchHomeCode: string;
  /**
   * All seven columns set, each to a value that DIFFERS from the global
   * default, so "the branch column won" is provable. Also the DST branch:
   * America/New_York transitions, Asia/Kolkata does not.
   */
  branchOverride: string;
  branchOverrideCode: string;
  /**
   * Outside `scopedHr`'s envelope — every cross-branch 404 points here.
   * Deliberately unconfigured so a scoping case never accidentally also tests
   * an override.
   */
  branchForeign: string;
  branchForeignCode: string;

  /** In `branchHome`, headed by `mgr`. */
  deptOps: string;
  deptOpsCode: string;
  /**
   * SAME branch as `deptOps`, headed by nobody. This is what proves a MANAGER
   * denial is DEPARTMENT scope and not branch scope — without it, every manager
   * denial is confounded with the branch middleware.
   */
  deptFin: string;
  deptFinCode: string;
  /** In `branchForeign`, headed by `foreignMgr`. */
  deptForeign: string;
  deptForeignCode: string;

  /** Default self-service actor; backs the `employee` user. */
  puncherId: string;
  /** Second self-service actor — also the "EMP other" column. */
  puncher2Id: string;
  /** `timezone: 'Pacific/Kiritimati'` (UTC+14). */
  remoteAheadId: string;
  /** `timezone: 'Pacific/Honolulu'` (UTC-10) — the negative-offset twin. */
  remoteBehindId: string;
  /** Owns FLEXIBLE WorkSchedule rows. */
  flexStaffId: string;
  /** Owns a fixed schedule with explicit startTime/endTime. */
  shiftStaffId: string;
  /** In `branchOverride` — the per-branch geofence + office-hours actor. */
  overrideStaffId: string;
  /** In `deptFin`, same branch — cross-department target. Carries 5 descriptors. */
  finStaffId: string;
  /** In `deptForeign`/`branchForeign` — cross-branch target. */
  foreignStaffId: string;
  /** ACTIVE, never punches — the auto-absent and `validate` target. */
  absenteeId: string;
  /** ACTIVE with an APPROVED leave covering today — the auto-absent SKIP arm. */
  onLeaveStaffId: string;
  /** `startDate` = today — the onboarding-date boundary on two different doors. */
  newHireId: string;
  /** `branchId: null` — the only row reaching `assertInBranch`'s null arm. */
  nullBranchStaffId: string;
  /** Owns the correction lifecycle cases. */
  correctionStaffId: string;
  /** Owns the two seeded TERMINAL corrections — see the note on quota below. */
  correctionHistoryStaffId: string;

  /** Global ADMIN, deliberately with NO linked employee — see the note below. */
  admin: AttendanceUser;
  /** HR_MANAGER, global branch access. */
  hr: AttendanceUser;
  /** HR_MANAGER scoped to branchHome + branchOverride. branchForeign is the 404. */
  scopedHr: AttendanceUser;
  /** MANAGER heading `deptOps`. */
  mgr: AttendanceUser;
  /** MANAGER heading `deptForeign`. */
  foreignMgr: AttendanceUser;
  /** Plain EMPLOYEE linked to `puncher`. */
  employee: AttendanceUser;
  /** Plain EMPLOYEE linked to `puncher2` — "EMP other". */
  otherEmployee: AttendanceUser;
  /**
   * EMPLOYEE linked to `overrideStaff`, who lives in `branchOverride`.
   *
   * Exists so the per-branch geofence can be asserted on a SELF check-in. The
   * HR on-behalf route passes `skipGeofence = true`, so a case driven through
   * it proves nothing about the branch columns — only a punch the employee
   * makes themselves reaches `getGeofencingPolicy(employee.branchId)`.
   */
  overrideEmployee: AttendanceUser;

  /** The APPROVED correction seeded on `correctionHistoryStaff`. */
  approvedCorrectionId: string;
  /** The REJECTED correction seeded on `correctionHistoryStaff`. */
  rejectedCorrectionId: string;

  /** One of `puncher`'s two face descriptors — the DELETE target. */
  puncherDescriptorId: string;

  /**
   * Seeds a WorkSchedule and returns its id. NOT standing fixture data: a
   * schedule for "today" is wrong on the second calendar day a long-lived
   * database is used on, and `WorkSchedule` has no unique constraint on
   * `(employeeId, date)` so duplicates accumulate silently. Every case that
   * needs one seeds it and deletes it in `afterEach`.
   */
  seedSchedule: (
    employeeId: string,
    date: Date,
    shape?: {
      shiftType?: string;
      startTime?: Date | null;
      endTime?: Date | null;
      requiredHours?: number | null;
      isWorkDay?: boolean;
    },
  ) => Promise<string>;

  cleanup: () => Promise<void>;
}

async function login(ctx: E2EContext, email: string): Promise<string> {
  const res = await ctx
    .http()
    .post('/auth/login')
    .send({ email, password: PASSWORD });
  if (!res.body?.data?.accessToken) {
    throw new Error(
      `login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.body.data.accessToken;
}

const yearsAgo = (n: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d;
};

/**
 * A deterministic 128-float descriptor. Face MATCHING is out of scope for this
 * phase, so the vectors only have to be well-separated: `seed` scales the whole
 * vector, which puts any two seeds far beyond both the 0.3 duplicate-guard
 * threshold and the 0.6 match threshold.
 */
export const fakeDescriptor = (seed: number): number[] =>
  Array.from({ length: 128 }, (_, i) => ((i % 7) + 1) * 0.01 * seed);

/**
 * `withSetting` for `system_timezone`, PLUS the cache invalidation it needs.
 *
 * `companyTzCache` holds the company timezone for 60 seconds and is invalidated
 * by `SystemSettingsService` on a real save — but the settings helpers write the
 * row through Prisma directly, which does not. Without this, a timezone case
 * passes or fails depending on how long the PREVIOUS case took, which is the
 * worst failure mode a suite can have.
 */
export async function withCompanyTz<T>(
  ctx: E2EContext,
  tz: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tzSvc = ctx.app.get(TimezoneService);
  const previous = await readSetting(ctx, 'system_timezone');
  await writeSetting(ctx, 'system_timezone', tz);
  tzSvc.invalidateCache();
  try {
    return await fn();
  } finally {
    await restoreSetting(ctx, 'system_timezone', previous);
    tzSvc.invalidateCache();
  }
}

/**
 * Picks a company timezone in which "now" is mid-morning local, and pins it.
 *
 * This is the single most important harness decision in the module, and it
 * exists because two independent rules make attendance wall-clock dependent:
 *
 *   - With the default `attendance_day_end_time` of 23:59 and a company zone of
 *     Asia/Kolkata, the attendance day closes at 18:29 UTC — so EVERY check-in
 *     in a CI run started after 18:29 UTC is a 400.
 *   - `isReasonableWorkTime` gates the late/early flags to 06:00–23:00 local, so
 *     a run at 03:00 local silently makes every late assertion false.
 *
 * `Etc/GMT±N` is used rather than a city zone because it carries no DST. Note
 * the sign is INVERTED by POSIX convention: `Etc/GMT+5` is UTC−5.
 *
 * Returns the restore function; call it in `afterAll`.
 */
export async function pinCompanyTzToMidMorning(
  ctx: E2EContext,
): Promise<() => Promise<void>> {
  const tzSvc = ctx.app.get(TimezoneService);
  const utcHour = new Date().getUTCHours();
  // Target 10:00 local. offset = 10 - utcHour, clamped to the ±12 Etc/GMT range.
  let offset = 10 - utcHour;
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  // POSIX inversion: a +5 offset from UTC is spelled `Etc/GMT-5`.
  const tz = offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;

  const previous = await readSetting(ctx, 'system_timezone');
  await writeSetting(ctx, 'system_timezone', tz);
  tzSvc.invalidateCache();

  return async () => {
    await restoreSetting(ctx, 'system_timezone', previous);
    tzSvc.invalidateCache();
  };
}

/**
 * Minutes past local midnight, right now, in whatever zone the company is
 * currently pinned to.
 *
 * The punch spec needs this to place `office_start_time` a known number of
 * minutes either side of "now": `calculateIsLate` compares
 * `localMinutesOfDay(now, companyTZ)` against `workStart + LATE_THRESHOLD`,
 * where the 15-minute threshold is hardcoded. Computing the boundary from the
 * real clock is the only way to assert it at ±1 minute without freezing time.
 */
export async function companyLocalMinutes(ctx: E2EContext): Promise<number> {
  const tzSvc = ctx.app.get(TimezoneService);
  const tz = await tzSvc.getCompanyTZ();
  return tzSvc.localMinutesOfDay(new Date(), tz);
}

/** `HH:MM` for a given minutes-past-local-midnight, clamped into the day. */
export const hhmm = (minutes: number): string => {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export async function setupAttendanceFixtures(
  ctx: E2EContext,
): Promise<AttendanceFixtures> {
  const { prisma } = ctx;
  const runId = `att${Date.now()}`;
  const hash = await bcrypt.hash(PASSWORD, 10);

  // ── Branches ──────────────────────────────────────────────────────────────
  const branchHomeCode = `ATT-HOME-${runId}`;
  const branchOverrideCode = `ATT-OVR-${runId}`;
  const branchForeignCode = `ATT-FGN-${runId}`;

  // Every one of the seven per-branch columns left NULL, on purpose.
  const branchHome = await prisma.branch.create({
    data: { code: branchHomeCode, name: 'Attendance Home', isActive: true },
  });
  const branchOverride = await prisma.branch.create({
    data: {
      code: branchOverrideCode,
      name: 'Attendance Override',
      isActive: true,
      timezone: 'America/New_York',
      officeStartTime: '08:00',
      officeEndTime: '16:00',
      weeklyOffDays: '5,6',
      geofencingEnabled: true,
      latitude: 40.7128,
      longitude: -74.006,
      geofenceRadiusM: 150,
    },
  });
  const branchForeign = await prisma.branch.create({
    data: {
      code: branchForeignCode,
      name: 'Attendance Foreign',
      isActive: true,
      timezone: 'Asia/Kolkata',
    },
  });

  // ── Departments ───────────────────────────────────────────────────────────
  const deptOpsCode = `ATT-OPS-${runId}`;
  const deptFinCode = `ATT-FIN-${runId}`;
  const deptForeignCode = `ATT-FGND-${runId}`;

  const deptOps = await prisma.department.create({
    data: { code: deptOpsCode, name: 'Attendance Ops', isActive: true },
  });
  const deptFin = await prisma.department.create({
    data: { code: deptFinCode, name: 'Attendance Finance', isActive: true },
  });
  const deptForeign = await prisma.department.create({
    data: { code: deptForeignCode, name: 'Attendance Foreign Dept', isActive: true },
  });

  // ── Employees ─────────────────────────────────────────────────────────────
  let seq = 0;
  const createEmployee = (suffix: string, over: Record<string, unknown> = {}) => {
    const tag = `${suffix}${seq++}`;
    return prisma.employee.create({
      data: {
        employeeCode: `AEM-${runId}-${tag}`,
        fullName: `Attendance ${tag}`,
        dateOfBirth: new Date('1992-01-01'),
        idCard: `AID-${runId}-${tag}`,
        email: `${tag.toLowerCase()}-${runId}@test.local`,
        departmentId: deptOps.id,
        branchId: branchHome.id,
        position: 'Operator',
        // Before HIST (Feb 2019), so the historical block is never refused by
        // the "cannot record attendance before the onboarding date" guard.
        startDate: new Date('2018-01-01'),
        baseSalary: 50000,
        status: 'ACTIVE',
        ...over,
      } as any,
    });
  };

  const puncher = await createEmployee('PUNCH');
  const puncher2 = await createEmployee('PUNCH2');
  const remoteAhead = await createEmployee('AHEAD', {
    timezone: 'Pacific/Kiritimati', // UTC+14
  });
  const remoteBehind = await createEmployee('BEHIND', {
    timezone: 'Pacific/Honolulu', // UTC-10
  });
  const flexStaff = await createEmployee('FLEX');
  const shiftStaff = await createEmployee('SHIFT');
  const overrideStaff = await createEmployee('OVR', {
    branchId: branchOverride.id,
  });
  const finStaff = await createEmployee('FIN', { departmentId: deptFin.id });
  const foreignStaff = await createEmployee('FGN', {
    departmentId: deptForeign.id,
    branchId: branchForeign.id,
  });
  const absentee = await createEmployee('ABSENT');
  const onLeaveStaff = await createEmployee('ONLEAVE');
  // `startDate` today: the boundary for both the manual-entry and the
  // correction onboarding guards, which answer with two DIFFERENT sentences.
  const newHire = await createEmployee('NEWHIRE', { startDate: new Date() });
  const nullBranchStaff = await createEmployee('NOBRANCH', { branchId: null });
  const correctionStaff = await createEmployee('CORR');
  const correctionHistoryStaff = await createEmployee('CORRHIST');

  // Heads and the employee rows behind the users.
  const mgrEmp = await createEmployee('MGREMP', { position: 'Head of Ops' });
  const foreignMgrEmp = await createEmployee('FMGREMP', {
    departmentId: deptForeign.id,
    branchId: branchForeign.id,
    position: 'Head of Foreign',
  });
  const hrEmp = await createEmployee('HREMP');
  const scopedHrEmp = await createEmployee('SHREMP');

  await prisma.department.update({
    where: { id: deptOps.id },
    data: { managerId: mgrEmp.id },
  });
  await prisma.department.update({
    where: { id: deptForeign.id },
    data: { managerId: foreignMgrEmp.id },
  });

  // ── Users ─────────────────────────────────────────────────────────────────
  const mkUser = (suffix: string, role: string, over: Record<string, any> = {}) =>
    prisma.user.create({
      data: {
        email: `${suffix.toLowerCase()}-${runId}@test.local`,
        passwordHash: hash,
        role,
        isActive: true,
        isGlobalBranchAccess: true,
        ...over,
      },
    });

  // NO employeeId, deliberately. `getOverview` and `getAttendanceList` both
  // exclude `NOT: { user: { role: 'ADMIN' } }` from the roster, so an admin WITH
  // an employee silently drops out of every count and makes the deltas wrong.
  // The cost is A21 (an ADMIN with no employee hitting POST /check-in), which
  // gets its own pinning case rather than being designed around.
  const adminUser = await mkUser('AADMIN', 'ADMIN');
  const hrUser = await mkUser('AHR', 'HR_MANAGER', { employeeId: hrEmp.id });
  // TWO branches, so both "no header -> whole envelope" and "X-Branch-Id
  // narrows to one" are drivable; branchForeign is then the 404 target.
  const scopedHrUser = await mkUser('ASHR', 'HR_MANAGER', {
    employeeId: scopedHrEmp.id,
    isGlobalBranchAccess: false,
    branchAccess: {
      create: [{ branchId: branchHome.id }, { branchId: branchOverride.id }],
    },
  });
  const mgrUser = await mkUser('AMGR', 'MANAGER', { employeeId: mgrEmp.id });
  const foreignMgrUser = await mkUser('AFMGR', 'MANAGER', {
    employeeId: foreignMgrEmp.id,
  });
  const employeeUser = await mkUser('AEMP', 'EMPLOYEE', {
    employeeId: puncher.id,
    isGlobalBranchAccess: false,
  });
  const overrideEmployeeUser = await mkUser('AOVREMP', 'EMPLOYEE', {
    employeeId: overrideStaff.id,
    isGlobalBranchAccess: false,
  });
  const otherEmployeeUser = await mkUser('AOEMP', 'EMPLOYEE', {
    employeeId: puncher2.id,
    isGlobalBranchAccess: false,
  });

  // ── The historical attendance block (February 2019) ───────────────────────
  // Enough for report / statistics / my?month=2&year=2019 / list?period=custom /
  // export / dashboard-summary, and NOT on "today", which belongs to whichever
  // spec is punching.
  const mkAttendance = (
    employeeId: string,
    day: number,
    over: Record<string, unknown> = {},
  ) => ({
    employeeId,
    date: histDay(day),
    checkIn: histAt(day, 9),
    checkOut: histAt(day, 18),
    workHours: 8,
    status: 'PRESENT',
    source: 'ESS',
    ...over,
  });

  await prisma.attendance.createMany({
    data: [
      // puncher: 3 PRESENT (one late, one early-leave), 1 ABSENT, 1 MISSED_CHECKOUT
      mkAttendance(puncher.id, 4, { branchId: branchHome.id }),
      mkAttendance(puncher.id, 5, {
        branchId: branchHome.id,
        checkIn: histAt(5, 10),
        isLate: true,
      }),
      mkAttendance(puncher.id, 6, {
        branchId: branchHome.id,
        checkOut: histAt(6, 15),
        workHours: 5,
        isEarlyLeave: true,
      }),
      mkAttendance(puncher.id, 7, {
        branchId: branchHome.id,
        checkIn: null,
        checkOut: null,
        workHours: 0,
        status: 'ABSENT',
        source: 'AUTO',
      }),
      mkAttendance(puncher.id, 8, {
        branchId: branchHome.id,
        checkOut: null,
        workHours: 0,
        status: 'MISSED_CHECKOUT',
      }),
      // finStaff: the cross-department rows a MANAGER must not see
      mkAttendance(finStaff.id, 4, { branchId: branchHome.id }),
      mkAttendance(finStaff.id, 5, { branchId: branchHome.id }),
      // foreignStaff: the cross-branch rows a scoped HR must not see
      mkAttendance(foreignStaff.id, 4, { branchId: branchForeign.id }),
      mkAttendance(foreignStaff.id, 5, { branchId: branchForeign.id }),
      // overrideStaff: so X-Branch-Id narrowing has something to narrow TO
      mkAttendance(overrideStaff.id, 4, { branchId: branchOverride.id }),
      mkAttendance(overrideStaff.id, 5, { branchId: branchOverride.id }),
    ] as any,
  });

  // ── Leave covering today, for the auto-absent SKIP arm ────────────────────
  // Without it, "marked absent" and "skipped because on leave" are
  // indistinguishable in the auto-absent delta.
  // Spans YESTERDAY through TOMORROW, not just today.
  //
  // `autoMarkAbsent` targets the attendance day of whatever company timezone is
  // in force, and the admin spec deliberately pins a late-evening zone so the
  // day-end boundary has passed. At any UTC hour before 20:00 that zone is
  // behind UTC, so the day it targets is YESTERDAY in UTC terms — and a leave
  // that covered only today left this employee marked absent, which is the
  // exact thing the fixture exists to prevent. Three days covers every target
  // day the pinned zone can produce.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const leaveStart = new Date(todayStart);
  leaveStart.setUTCDate(leaveStart.getUTCDate() - 1);
  const leaveEnd = new Date(todayStart);
  leaveEnd.setUTCDate(leaveEnd.getUTCDate() + 1);
  await prisma.leaveRequest.create({
    data: {
      employeeId: onLeaveStaff.id,
      leaveType: 'ANNUAL',
      startDate: leaveStart,
      endDate: leaveEnd,
      totalDays: 3,
      reason: `attendance fixture leave ${runId}`,
      status: 'APPROVED',
    } as any,
  });

  // ── Corrections: two TERMINAL rows, none PENDING ──────────────────────────
  // `getMonthlyUsage` counts by `createdAt` in the CURRENT calendar month across
  // ALL statuses, so any seeded correction consumes quota NOW regardless of the
  // date it targets. They therefore live on a DEDICATED employee, so they can
  // never eat a lifecycle case's budget on `correctionStaff`. Nothing PENDING,
  // so the "one pending per date" rule starts clean.
  const approvedCorrection = await prisma.attendanceCorrection.create({
    data: {
      employeeId: correctionHistoryStaff.id,
      date: histDay(11),
      requestedCheckIn: histAt(11, 9),
      requestedCheckOut: histAt(11, 18),
      reason: `attendance fixture approved ${runId}`,
      status: 'APPROVED',
      approverId: adminUser.id,
      approvedAt: new Date(),
    },
  });
  const rejectedCorrection = await prisma.attendanceCorrection.create({
    data: {
      employeeId: correctionHistoryStaff.id,
      date: histDay(12),
      requestedCheckIn: histAt(12, 9),
      reason: `attendance fixture rejected ${runId}`,
      status: 'REJECTED',
      approverId: adminUser.id,
      rejectedReason: 'fixture rejection',
    },
  });

  // ── Face descriptors ──────────────────────────────────────────────────────
  // Seeded straight through Prisma: `descriptor` is a plain `Float[]`, so this
  // needs no model, no camera and no detection. `finStaff` gets exactly
  // FACE_RECOGNITION_MAX_DESCRIPTORS (5) because `registerFace` checks the cap
  // BEFORE it calls `extractDescriptor` — which is what makes the cap's 400
  // reachable with a one-pixel payload and no TensorFlow.
  const puncherDescriptor = await prisma.faceDescriptor.create({
    data: { employeeId: puncher.id, descriptor: fakeDescriptor(1), quality: 0.9 },
  });
  await prisma.faceDescriptor.create({
    data: { employeeId: puncher.id, descriptor: fakeDescriptor(2), quality: 0.9 },
  });
  for (let i = 0; i < 5; i++) {
    await prisma.faceDescriptor.create({
      data: {
        employeeId: finStaff.id,
        descriptor: fakeDescriptor(10 + i),
        quality: 0.9,
      },
    });
  }
  // puncher2 deliberately gets none — the `getRegistrationStatus` empty state.

  const userEmails = [
    adminUser.email,
    hrUser.email,
    scopedHrUser.email,
    mgrUser.email,
    foreignMgrUser.email,
    employeeUser.email,
    otherEmployeeUser.email,
    overrideEmployeeUser.email,
  ];

  const fixtures: AttendanceFixtures = {
    runId,
    password: PASSWORD,

    branchHome: branchHome.id,
    branchHomeCode,
    branchOverride: branchOverride.id,
    branchOverrideCode,
    branchForeign: branchForeign.id,
    branchForeignCode,

    deptOps: deptOps.id,
    deptOpsCode,
    deptFin: deptFin.id,
    deptFinCode,
    deptForeign: deptForeign.id,
    deptForeignCode,

    puncherId: puncher.id,
    puncher2Id: puncher2.id,
    remoteAheadId: remoteAhead.id,
    remoteBehindId: remoteBehind.id,
    flexStaffId: flexStaff.id,
    shiftStaffId: shiftStaff.id,
    overrideStaffId: overrideStaff.id,
    finStaffId: finStaff.id,
    foreignStaffId: foreignStaff.id,
    absenteeId: absentee.id,
    onLeaveStaffId: onLeaveStaff.id,
    newHireId: newHire.id,
    nullBranchStaffId: nullBranchStaff.id,
    correctionStaffId: correctionStaff.id,
    correctionHistoryStaffId: correctionHistoryStaff.id,

    admin: {
      userId: adminUser.id,
      email: adminUser.email,
      token: await login(ctx, adminUser.email),
    },
    hr: {
      userId: hrUser.id,
      employeeId: hrEmp.id,
      email: hrUser.email,
      token: await login(ctx, hrUser.email),
    },
    scopedHr: {
      userId: scopedHrUser.id,
      employeeId: scopedHrEmp.id,
      email: scopedHrUser.email,
      token: await login(ctx, scopedHrUser.email),
    },
    mgr: {
      userId: mgrUser.id,
      employeeId: mgrEmp.id,
      email: mgrUser.email,
      token: await login(ctx, mgrUser.email),
    },
    foreignMgr: {
      userId: foreignMgrUser.id,
      employeeId: foreignMgrEmp.id,
      email: foreignMgrUser.email,
      token: await login(ctx, foreignMgrUser.email),
    },
    employee: {
      userId: employeeUser.id,
      employeeId: puncher.id,
      email: employeeUser.email,
      token: await login(ctx, employeeUser.email),
    },
    overrideEmployee: {
      userId: overrideEmployeeUser.id,
      employeeId: overrideStaff.id,
      email: overrideEmployeeUser.email,
      token: await login(ctx, overrideEmployeeUser.email),
    },
    otherEmployee: {
      userId: otherEmployeeUser.id,
      employeeId: puncher2.id,
      email: otherEmployeeUser.email,
      token: await login(ctx, otherEmployeeUser.email),
    },

    approvedCorrectionId: approvedCorrection.id,
    rejectedCorrectionId: rejectedCorrection.id,
    puncherDescriptorId: puncherDescriptor.id,

    seedSchedule: async (employeeId, date, shape = {}) => {
      const row = await prisma.workSchedule.create({
        data: {
          employeeId,
          date,
          shiftType: (shape.shiftType ?? 'FULL_DAY') as any,
          startTime: shape.startTime ?? null,
          endTime: shape.endTime ?? null,
          requiredHours: shape.requiredHours ?? null,
          isWorkDay: shape.isWorkDay ?? true,
          notes: `attendance fixture ${runId}`,
        },
      });
      return row.id;
    },

    cleanup: async () => {
      // FK-ordered. Load-bearing in two places NEW to this module:
      //   Attendance.branch is onDelete: Restrict, so every attendance row must
      //     go BEFORE its branch — no other fixture file has hit this edge.
      //   AttendanceCorrection points at BOTH Attendance and Employee, so it
      //     goes before Attendance.
      const empWhere = {
        OR: [
          { employeeCode: { contains: runId } },
          { email: { contains: runId } },
        ],
      };
      const empIds = (
        await prisma.employee.findMany({ where: empWhere, select: { id: true } })
      ).map((e) => e.id);

      await prisma.faceDescriptor.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.attendanceCorrection.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      // MUST precede the branch delete below.
      await prisma.attendance.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.workSchedule.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.leaveRequest.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.overtimeRequest.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.holiday.deleteMany({
        where: { branch: { code: { contains: runId } } },
      });
      // notifyReviewers writes one row per ADMIN/HR per created correction.
      await prisma.notification.deleteMany({
        where: { user: { email: { contains: runId } } },
      });
      await prisma.auditLog.deleteMany({
        where: { user: { email: { in: userEmails } } },
      });
      await prisma.user.deleteMany({ where: { email: { contains: runId } } });

      await prisma.department.updateMany({
        where: { manager: empWhere },
        data: { managerId: null },
      });
      await prisma.branch.updateMany({
        where: { manager: empWhere },
        data: { managerId: null },
      });
      await prisma.employee.updateMany({
        where: { supervisorId: { in: empIds } },
        data: { supervisorId: null },
      });
      await prisma.employee.deleteMany({ where: empWhere });

      await prisma.department.deleteMany({
        where: { code: { contains: runId } },
      });
      await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
    },
  };

  return fixtures;
}
