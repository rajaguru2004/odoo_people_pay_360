import * as bcrypt from 'bcrypt';
import { E2EContext } from './e2e-app';

/**
 * The Time & Schedules module's fixture set: two branches whose WORK WEEKS
 * differ, a department the manager heads and one they do not, employees in every
 * state a schedule rule branches on, and the seven actors the role matrix needs.
 *
 * A NEW file rather than an extension of `org-fixtures.ts` or
 * `people-fixtures.ts`, for the reason People gave for not extending
 * Organization: those two are shaped by a five-department tree and an
 * eight-table FK teardown that nothing here needs and every spec would pay for.
 * Schedule teardown is shallow — WorkSchedule and the three approved-request
 * tables, then the usual employee/department/branch unwind.
 *
 * What IS shared: `bearer` and the settings snapshot helpers in `./settings`.
 *
 * Two things this fixture set owns that the others do not:
 *
 *   - **Reserved dates.** `WorkSchedule` is one row per employee per date, so a
 *     spec that picks a date the fixture already used collides with it rather
 *     than with another spec. Every date the fixture writes is exported as a
 *     constant, and `freeDate(n)` hands out the window nothing else touches.
 *
 *   - **Differing weekly-off days.** branchA rests Sat+Sun, branchB rests
 *     Thu+Fri. `HolidaysService.getWeeklyOffDays(branchId)` is the engine under
 *     test there, and a fixture where both branches rest on the same days would
 *     let a global-setting fallback pass as if it were per-branch.
 *
 * Everything is tagged with a unique `runId` so `cleanup()` can bulk-delete
 * without touching a shared database's real rows.
 */

const PASSWORD = 'Passw0rd!';

/**
 * The contract window every fixture employee's ACTIVE contract spans. Boundary
 * cases (`startDate - 1`, `startDate`, `endDate`, `endDate + 1`) are expressed
 * against these, so they must stay a full calendar year and must CONTAIN every
 * reserved date below.
 */
export const CONTRACT_START = '2026-01-01';
export const CONTRACT_END = '2026-12-31';

/**
 * Dates the fixture itself writes a row on. A spec that needs a clean date must
 * use `freeDate(n)`; picking one of these produces a conflict 400 that looks
 * exactly like a broken rule.
 */
export const RESERVED = {
  /** `scheduleBId` — a FULL_DAY shift on the branch-B employee. */
  branchBShift: '2026-06-01',
  /** `flexibleScheduleId` — a FLEXIBLE 7.5h day on `staffFlexible`. */
  flexibleShift: '2026-06-02',
  /** APPROVED leave on `staffOnLeave`, inclusive. */
  leaveStart: '2026-06-10',
  leaveMiddle: '2026-06-11',
  leaveEnd: '2026-06-12',
  /** APPROVED overtime on `staffA`, so the calendar merge has all four types. */
  overtime: '2026-06-15',
} as const;

/**
 * The window no fixture row occupies: 2026-03-01 onwards, 90 days of it, all
 * inside the contract. `freeDate(0)` is 2026-03-01.
 *
 * Give each spec its own base offset (spec A from 0, spec B from 30, …) so two
 * files cannot land on the same day even though jest runs them in one process
 * against one database.
 */
export function freeDate(offset: number): string {
  const d = new Date(Date.UTC(2026, 2, 1));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DDTHH:MM:00.000Z` for a reserved/free date — fixed-window shifts. */
export function atUtc(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00.000Z`;
}

export interface ScheduleUser {
  userId: string;
  employeeId?: string;
  email: string;
  token: string;
}

export interface ScheduleFixtures {
  runId: string;
  password: string;

  /** Rests Sat+Sun (`weeklyOffDays: '0,6'`), Asia/Kolkata. Holds most rows. */
  branchA: string;
  branchAcode: string;
  /**
   * Rests Thu+Fri (`weeklyOffDays: '4,5'`), Asia/Muscat. Every "404, no
   * existence leak" assertion points here, and it is the branch that proves the
   * weekly-off calendar is per-branch rather than a global setting.
   */
  branchB: string;
  branchBcode: string;

  /** Top-level, in branch A, headed by `manager`. */
  deptAId: string;
  deptAcode: string;
  /**
   * Top-level, in branch A, headed by `otherManager`. Same branch on purpose:
   * it isolates the DEPARTMENT-scope rule from the branch-scope rule, which a
   * department in branch B would confound.
   */
  deptOtherId: string;
  deptOtherCode: string;
  /** Top-level, holds the branch-B staff. */
  deptBId: string;
  deptBcode: string;

  /** ACTIVE, deptA/branchA, one ACTIVE contract spanning the window above. */
  staffAId: string;
  /** ACTIVE, deptA/branchA, NO contract — the unbounded-date path. */
  staffNoContractId: string;
  /** INACTIVE — "schedules can only be created for active employees". */
  staffInactiveId: string;
  /** ACTIVE, holds the APPROVED leave over RESERVED.leaveStart..leaveEnd. */
  staffOnLeaveId: string;
  /** ACTIVE, owns `flexibleScheduleId`. The flexible-hours arithmetic target. */
  staffFlexibleId: string;
  /** ACTIVE, deptOther/branchA — in scope for `otherManager`, not for `manager`. */
  staffOtherDeptId: string;
  /** ACTIVE, deptB/branchB. Owns `scheduleBId`. */
  staffBId: string;

  /** The ACTIVE contract on `staffA`. */
  contractAId: string;

  /**
   * A FULL_DAY shift on `staffB`, i.e. in branch B. This is the row every
   * cross-branch by-id assertion reads, updates and deletes — it must exist
   * before the spec runs, because a scoped HR cannot create it.
   */
  scheduleBId: string;
  /** A FLEXIBLE 7.5h day on `staffFlexible`. */
  flexibleScheduleId: string;

  /** APPROVED leave on `staffOnLeave`. */
  leaveId: string;
  /** APPROVED overtime on `staffA`, on RESERVED.overtime. */
  overtimeId: string;

  /** Holiday scoped to branch A. Invisible to a branch-B employee's calendar. */
  branchHolidayId: string;
  branchHolidayDate: string;
  /** Holiday with `branchId: null` — visible from every branch. */
  companyHolidayId: string;
  companyHolidayDate: string;

  /** Global ADMIN. */
  admin: ScheduleUser;
  /** HR_MANAGER, global branch access. */
  hr: ScheduleUser;
  /** HR_MANAGER scoped to branch A only — every cross-branch case uses this. */
  scopedHr: ScheduleUser;
  /** MANAGER heading `deptA`. */
  manager: ScheduleUser;
  /** MANAGER heading `deptOther`. */
  otherManager: ScheduleUser;
  /** Plain EMPLOYEE, linked to `staffA`. */
  employee: ScheduleUser;
  /** A second plain EMPLOYEE, linked to `staffOtherDept` — the IDOR counterpart. */
  otherEmployee: ScheduleUser;

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

const monthsAgo = (n: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
};

/**
 * `holidays_date_global_uq` is a PARTIAL unique index on `(date) WHERE branch_id
 * IS NULL`, so a company-wide holiday cannot share a date with one the seed (or
 * a real deployment) already owns. Scanning for a free day keeps the fixture
 * usable against any database instead of failing at setup on a date collision
 * that has nothing to do with the code under test.
 */
async function findFreeGlobalHolidayDate(
  ctx: E2EContext,
  startIso: string,
): Promise<string> {
  const taken = new Set(
    (
      await ctx.prisma.holiday.findMany({
        where: { branchId: null },
        select: { date: true },
      })
    ).map((h) => h.date.toISOString().slice(0, 10)),
  );
  const d = new Date(`${startIso}T00:00:00.000Z`);
  for (let i = 0; i < 120; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (!taken.has(iso)) return iso;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  throw new Error(
    'schedule-fixtures: no free company-wide holiday date in a 120-day window',
  );
}

export async function setupScheduleFixtures(
  ctx: E2EContext,
): Promise<ScheduleFixtures> {
  const { prisma } = ctx;
  const runId = `sch${Date.now()}`;
  const hash = await bcrypt.hash(PASSWORD, 10);

  // ── Branches ──────────────────────────────────────────────────────────────
  // The weekly-off days differ on purpose: see the file header.
  const branchAcode = `SCH-A-${runId}`;
  const branchBcode = `SCH-B-${runId}`;
  const branchA = await prisma.branch.create({
    data: {
      code: branchAcode,
      name: 'Schedule Branch A',
      isActive: true,
      timezone: 'Asia/Kolkata',
      officeStartTime: '09:00',
      officeEndTime: '18:00',
      weeklyOffDays: '0,6',
    },
  });
  const branchB = await prisma.branch.create({
    data: {
      code: branchBcode,
      name: 'Schedule Branch B',
      isActive: true,
      timezone: 'Asia/Muscat',
      officeStartTime: '08:00',
      officeEndTime: '17:00',
      weeklyOffDays: '4,5',
    },
  });

  // ── Departments ───────────────────────────────────────────────────────────
  const deptAcode = `SCH-DA-${runId}`;
  const deptOtherCode = `SCH-DO-${runId}`;
  const deptBcode = `SCH-DB-${runId}`;

  const deptA = await prisma.department.create({
    data: { code: deptAcode, name: 'Schedule Dept A', isActive: true },
  });
  const deptOther = await prisma.department.create({
    data: { code: deptOtherCode, name: 'Schedule Dept Other', isActive: true },
  });
  const deptB = await prisma.department.create({
    data: { code: deptBcode, name: 'Schedule Dept B', isActive: true },
  });

  // ── Employees ─────────────────────────────────────────────────────────────
  let seq = 0;
  const mkEmployee = (suffix: string, over: Record<string, unknown> = {}) => ({
    employeeCode: `SEM-${runId}-${suffix}`,
    fullName: `Schedule ${suffix}`,
    dateOfBirth: new Date('1992-01-01'),
    idCard: `SID-${runId}-${suffix}`,
    email: `${suffix.toLowerCase()}-${runId}@test.local`,
    departmentId: deptA.id,
    branchId: branchA.id,
    position: 'Engineer',
    startDate: monthsAgo(36),
    baseSalary: 50000,
    status: 'ACTIVE',
    ...over,
  });
  const createEmployee = (suffix: string, over: Record<string, unknown> = {}) =>
    prisma.employee.create({
      data: mkEmployee(`${suffix}${seq++}`, over) as any,
    });

  const staffA = await createEmployee('STAFFA');
  const staffNoContract = await createEmployee('NOCON');
  const staffInactive = await createEmployee('INACTIVE', {
    status: 'INACTIVE',
  });
  const staffOnLeave = await createEmployee('ONLEAVE');
  const staffFlexible = await createEmployee('FLEX');
  const staffOtherDept = await createEmployee('OTHERDEPT', {
    departmentId: deptOther.id,
  });
  const staffB = await createEmployee('BRANCHB', {
    departmentId: deptB.id,
    branchId: branchB.id,
  });

  // Heads. `manager` heads deptA; `otherManager` heads deptOther — both in
  // branch A, so "out of my department" is testable without also being "out of
  // my branch".
  const headEmp = await createEmployee('HEAD', { position: 'Head of Dept A' });
  const otherHeadEmp = await createEmployee('OHEAD', {
    departmentId: deptOther.id,
    position: 'Head of Dept Other',
  });
  const hrEmp = await createEmployee('HREMP');
  const scopedHrEmp = await createEmployee('SCOPEDHR');

  await prisma.department.update({
    where: { id: deptA.id },
    data: { managerId: headEmp.id },
  });
  await prisma.department.update({
    where: { id: deptOther.id },
    data: { managerId: otherHeadEmp.id },
  });

  // ── Users ─────────────────────────────────────────────────────────────────
  const mkUser = (
    suffix: string,
    role: string,
    over: Record<string, any> = {},
  ) =>
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

  const adminUser = await mkUser('SADMIN', 'ADMIN');
  const hrUser = await mkUser('SHRG', 'HR_MANAGER', { employeeId: hrEmp.id });
  const scopedHrUser = await mkUser('SHRS', 'HR_MANAGER', {
    employeeId: scopedHrEmp.id,
    isGlobalBranchAccess: false,
    branchAccess: { create: [{ branchId: branchA.id }] },
  });
  const managerUser = await mkUser('SMGR', 'MANAGER', {
    employeeId: headEmp.id,
  });
  const otherManagerUser = await mkUser('SOMGR', 'MANAGER', {
    employeeId: otherHeadEmp.id,
  });
  const employeeUser = await mkUser('SEMP', 'EMPLOYEE', {
    employeeId: staffA.id,
    isGlobalBranchAccess: false,
  });
  const otherEmployeeUser = await mkUser('SOEMP', 'EMPLOYEE', {
    employeeId: staffOtherDept.id,
    isGlobalBranchAccess: false,
  });

  // ── Contract ──────────────────────────────────────────────────────────────
  // Only `staffA` gets one: the contract-window rule has to be assertable in
  // both directions, and `staffNoContract` is the other half of that pair.
  const contractA = await prisma.contract.create({
    data: {
      employeeId: staffA.id,
      contractType: 'FIXED_TERM',
      contractNumber: `SCON-${runId}-1`,
      startDate: new Date(`${CONTRACT_START}T00:00:00.000Z`),
      endDate: new Date(`${CONTRACT_END}T00:00:00.000Z`),
      salary: 50000,
      status: 'ACTIVE',
    },
  });

  // ── Approved leave + overtime, so the calendar merge has real sources ─────
  const leave = await prisma.leaveRequest.create({
    data: {
      employeeId: staffOnLeave.id,
      leaveType: 'ANNUAL',
      startDate: new Date(`${RESERVED.leaveStart}T00:00:00.000Z`),
      endDate: new Date(`${RESERVED.leaveEnd}T00:00:00.000Z`),
      totalDays: 3,
      reason: `schedule fixture approved leave ${runId}`,
      status: 'APPROVED',
    },
  });
  const overtime = await prisma.overtimeRequest.create({
    data: {
      employeeId: staffA.id,
      date: new Date(`${RESERVED.overtime}T00:00:00.000Z`),
      startTime: new Date(atUtc(RESERVED.overtime, '19:00')),
      endTime: new Date(atUtc(RESERVED.overtime, '21:00')),
      hours: 2,
      reason: `schedule fixture approved overtime ${runId}`,
      status: 'APPROVED',
    },
  });

  // ── Pre-created schedules ─────────────────────────────────────────────────
  // `scheduleB` exists because a branch-A-scoped HR cannot create it, and every
  // cross-branch by-id case needs a real target to be refused on.
  const scheduleB = await prisma.workSchedule.create({
    data: {
      employeeId: staffB.id,
      date: new Date(`${RESERVED.branchBShift}T00:00:00.000Z`),
      shiftType: 'FULL_DAY',
      startTime: new Date(atUtc(RESERVED.branchBShift, '08:00')),
      endTime: new Date(atUtc(RESERVED.branchBShift, '17:00')),
      isWorkDay: true,
      notes: `schedule fixture branch-B shift ${runId}`,
    },
  });
  const flexibleSchedule = await prisma.workSchedule.create({
    data: {
      employeeId: staffFlexible.id,
      date: new Date(`${RESERVED.flexibleShift}T00:00:00.000Z`),
      shiftType: 'FLEXIBLE',
      startTime: null,
      endTime: null,
      requiredHours: 7.5,
      isWorkDay: true,
      notes: `schedule fixture flexible shift ${runId}`,
    },
  });

  // ── Holidays ──────────────────────────────────────────────────────────────
  // The branch-scoped one may reuse a date freely (its partial index is per
  // branch, and this branch is new); the company-wide one may not.
  const branchHolidayDate = '2026-07-01';
  const branchHoliday = await prisma.holiday.create({
    data: {
      name: `Schedule Branch Holiday ${runId}`,
      date: new Date(`${branchHolidayDate}T00:00:00.000Z`),
      year: 2026,
      branchId: branchA.id,
      description: `schedule fixture ${runId}`,
    },
  });
  const companyHolidayDate = await findFreeGlobalHolidayDate(ctx, '2026-07-02');
  const companyHoliday = await prisma.holiday.create({
    data: {
      name: `Schedule Company Holiday ${runId}`,
      date: new Date(`${companyHolidayDate}T00:00:00.000Z`),
      year: 2026,
      branchId: null,
      description: `schedule fixture ${runId}`,
    },
  });

  const userEmails = [
    adminUser.email,
    hrUser.email,
    scopedHrUser.email,
    managerUser.email,
    otherManagerUser.email,
    employeeUser.email,
    otherEmployeeUser.email,
  ];

  const fixtures: ScheduleFixtures = {
    runId,
    password: PASSWORD,

    branchA: branchA.id,
    branchAcode,
    branchB: branchB.id,
    branchBcode,

    deptAId: deptA.id,
    deptAcode,
    deptOtherId: deptOther.id,
    deptOtherCode,
    deptBId: deptB.id,
    deptBcode,

    staffAId: staffA.id,
    staffNoContractId: staffNoContract.id,
    staffInactiveId: staffInactive.id,
    staffOnLeaveId: staffOnLeave.id,
    staffFlexibleId: staffFlexible.id,
    staffOtherDeptId: staffOtherDept.id,
    staffBId: staffB.id,

    contractAId: contractA.id,

    scheduleBId: scheduleB.id,
    flexibleScheduleId: flexibleSchedule.id,

    leaveId: leave.id,
    overtimeId: overtime.id,

    branchHolidayId: branchHoliday.id,
    branchHolidayDate,
    companyHolidayId: companyHoliday.id,
    companyHolidayDate,

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
    manager: {
      userId: managerUser.id,
      employeeId: headEmp.id,
      email: managerUser.email,
      token: await login(ctx, managerUser.email),
    },
    otherManager: {
      userId: otherManagerUser.id,
      employeeId: otherHeadEmp.id,
      email: otherManagerUser.email,
      token: await login(ctx, otherManagerUser.email),
    },
    employee: {
      userId: employeeUser.id,
      employeeId: staffA.id,
      email: employeeUser.email,
      token: await login(ctx, employeeUser.email),
    },
    otherEmployee: {
      userId: otherEmployeeUser.id,
      employeeId: staffOtherDept.id,
      email: otherEmployeeUser.email,
      token: await login(ctx, otherEmployeeUser.email),
    },

    cleanup: async () => {
      // FK order. WorkSchedule cascades from Employee, but it is deleted
      // explicitly for a reason the other fixture files do not have: specs
      // create schedules on FIXTURE employees, so the rows to remove are not
      // all ones this file wrote, and matching by employee is the only way to
      // catch them.
      const empWhere = {
        OR: [
          { employeeCode: { contains: runId } },
          { email: { contains: runId } },
        ],
      };
      const empIds = (
        await prisma.employee.findMany({
          where: empWhere,
          select: { id: true },
        })
      ).map((e) => e.id);

      await prisma.workSchedule.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.leaveRequest.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.overtimeRequest.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.attendance.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.contract.deleteMany({
        where: { employeeId: { in: empIds } },
      });

      // The company-wide holiday has branchId null, so nothing cascades it —
      // leaving it behind would take a date out of circulation for every later
      // run against the same database.
      await prisma.holiday.deleteMany({
        where: { description: { contains: runId } },
      });

      await prisma.auditLog.deleteMany({
        where: { user: { email: { in: userEmails } } },
      });
      await prisma.user.deleteMany({
        where: { email: { contains: runId } },
      });

      await prisma.department.updateMany({
        where: { manager: empWhere },
        data: { managerId: null },
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
