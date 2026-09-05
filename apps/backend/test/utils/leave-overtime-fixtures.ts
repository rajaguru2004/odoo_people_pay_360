import * as bcrypt from 'bcrypt';
import { unlink } from 'fs/promises';
import { resolve as resolvePath } from 'path';
import { E2EContext } from './e2e-app';
import { readApprovalSwitch, restoreApprovalSwitch } from './approval-switch';

/**
 * The Leave & Overtime module's fixture set.
 *
 * A NEW file rather than an extension of `attendance-fixtures.ts` or
 * `schedule-fixtures.ts`, for three reasons the other modules do not have:
 *
 *   1. **Decisive — two endpoints here mutate rows this module does not own,
 *      and one of them is destructive.** `POST /leave-balances/accrual/run`
 *      adds +1 annual day to EVERY ACTIVE employee in the caller's envelope and
 *      writes a `LeaveAccrualHistory` row for each; `POST
 *      /leave-balances/set-default-allocation` resets `allocated` to the library
 *      defaults for EVERY employee (no status filter), destroying manual
 *      allocations and accrued days alike. Importing a fixture set with 15+
 *      extra ACTIVE employees puts them all in the blast radius.
 *
 *   2. **`Attendance.branch` is `onDelete: Restrict` and approved leave now
 *      stamps it.** `leave-requests.service.ts` writes LEAVE attendance rows
 *      carrying `employee.branchId`, so this is the first non-attendance fixture
 *      whose teardown must delete `Attendance` BEFORE `Branch`.
 *
 *   3. **`RequestApproval` has no foreign key to anything** (schema.prisma:725)
 *      and is not in `BRANCH_SCOPE`. Nothing cascades it; trail rows outlive the
 *      requests they describe unless deleted by explicit `requestId`.
 *
 * What IS shared, not re-implemented: `bearer` / `withSetting` / `withSettings`
 * from `./settings`, and `readApprovalSwitch` / `restoreApprovalSwitch` from
 * `./approval-switch`.
 *
 * ── Two things this fixture set owns that the others do not ─────────────────
 *
 *   - **Reserved date RANGES, not dates.** Leave's overlap rule refuses any
 *     request whose [start,end] intersects an existing PENDING or APPROVED one
 *     for the same employee, so the scarce resource is a contiguous window, not
 *     a single day. `freeWindow(offset, days)` hands out windows from
 *     {@link LEAVE_YEAR}-03-01; give each spec file the offset block listed
 *     below so two files cannot collide even though jest runs them in one
 *     process against one database.
 *
 *   - **Per-branch work weeks.** `branchMain` rests Sun+Sat, `branchAlt` rests
 *     Thu+Fri. The SAME calendar date is therefore a rest day in one and a
 *     working day in the other, which is the only way to prove
 *     `getWorkDaysBetween` and the overtime `dayType` are per-branch rather than
 *     a global setting reading through.
 *
 * ── Offset blocks (into `freeWindow` / `otDate`) ────────────────────────────
 *
 *     leave-request.e2e-spec.ts        0–199
 *     leave-balance.e2e-spec.ts      200–299
 *     leave-attachment.e2e-spec.ts   300–349
 *     overtime-request.e2e-spec.ts   350–549
 *     leave-overtime-approval        550–699
 *     leave-overtime-scoping         700–799
 *     overtime-approver-edit         800–899
 *
 * ── A correction worth stating up front ─────────────────────────────────────
 *
 * Overtime caps, rates and thresholds do **not** come from system settings for
 * a normally-assigned employee. `OvertimePolicyService.onModuleInit` seeds a
 * "Company Default" policy from the globals at first boot, and
 * `mergeRulesOverGlobal` takes `rules.maxHoursPerDay` (etc.) OVER the live
 * setting. `withSetting('overtime_max_hours_per_day', …)` changes nothing for
 * such an employee. Every cap/rate/threshold case must drive a fixture-owned
 * `OvertimePolicy` through {@link withPolicyRules}; only `overtime_enabled`,
 * `overtime_allow_employee_submit`, `overtime_require_reason`,
 * `office_start_time`, `attendance_day_end_time` and
 * `calendar_weekly_holidays` remain live globals.
 *
 * Everything is tagged with a unique `runId` so `cleanup()` can bulk-delete
 * without touching a shared database's real rows. `cleanup()` is idempotent.
 */

const PASSWORD = 'Passw0rd!';

/**
 * The year every fixture leave and overtime row lives in.
 *
 * 2027 is deliberate: attendance owns Feb 2019, `schedule-fixtures.ts` owns all
 * of 2026, and `daily-wage-overtime.e2e-spec.ts` owns Nov 2029. Charging leave
 * to 2027 also isolates this module's balances from the CURRENT year, which is
 * what `accrual/run` and `company-overview` default to.
 */
export const LEAVE_YEAR = 2027;

/** UTC day-of-week, 0 = Sunday. */
export function dayOfWeekUtc(iso: string): number {
  return new Date(`${iso}T00:00:00.000Z`).getUTCDay();
}

const isoPlus = (base: string, days: number): string => {
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The base of every free window and free overtime date. */
const WINDOW_BASE = `${LEAVE_YEAR}-03-01`;

/**
 * A contiguous window nothing else touches, `lengthDays` long, starting at
 * `WINDOW_BASE + offset`.
 *
 * Slots are spaced by the caller: use a stride of at least `lengthDays + 1` so
 * an off-by-one in `getWorkDaysBetween` can never bridge two windows and turn a
 * clean case into an overlap 400 that reads exactly like a broken rule.
 */
export function freeWindow(
  offset: number,
  lengthDays = 3,
): { start: string; end: string } {
  const start = isoPlus(WINDOW_BASE, offset);
  return { start, end: isoPlus(start, lengthDays - 1) };
}

/** A single free date, from the same base and the same offset blocks. */
export function freeDate(offset: number): string {
  return isoPlus(WINDOW_BASE, offset);
}

/**
 * A free date whose UTC weekday is `weekday` (0 = Sunday), at or after
 * `offset`. Overtime day-classification cases need a date that is a rest day in
 * one branch and a working day in the other, and hardcoding one would break the
 * moment {@link LEAVE_YEAR} moves.
 */
export function freeDateOn(offset: number, weekday: number): string {
  for (let i = 0; i < 7; i++) {
    const iso = freeDate(offset + i);
    if (dayOfWeekUtc(iso) === weekday) return iso;
  }
  /* istanbul ignore next — a 7-day scan always hits every weekday. */
  throw new Error(`leave-overtime-fixtures: no weekday ${weekday} near ${offset}`);
}

/** `YYYY-MM-DDTHH:MM:00.000Z`. */
export function atUtc(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00.000Z`;
}

export interface LeaveOtUser {
  userId: string;
  employeeId?: string;
  email: string;
  token: string;
}

export interface LeaveOtFixtures {
  runId: string;
  password: string;

  // ── Branches ──────────────────────────────────────────────────────────────
  /** Rests Sun+Sat (`weeklyOffDays: '0,6'`), Asia/Kolkata, 09:00–18:00. */
  branchMain: string;
  branchMainCode: string;
  /**
   * Rests Thu+Fri (`weeklyOffDays: '4,5'`), Asia/Muscat, 08:00–17:00. The same
   * date is a rest day here and a working day in main — that contrast is the
   * whole reason this branch exists.
   */
  branchAlt: string;
  branchAltCode: string;
  /** Outside `scopedHr`'s envelope. Every "404, no existence leak" points here. */
  branchForeign: string;
  branchForeignCode: string;

  // ── Departments ───────────────────────────────────────────────────────────
  /** branchMain, headed by `mgr`. */
  deptOps: string;
  deptOpsCode: string;
  /**
   * branchMain TOO, headed by nobody. Same branch on purpose: it is what makes
   * a MANAGER refusal DEPARTMENT scope and not branch scope, which a department
   * in another branch would confound.
   */
  deptFin: string;
  deptFinCode: string;
  /** branchAlt. */
  deptAlt: string;
  deptAltCode: string;
  /** branchForeign, headed by `foreignMgr`. */
  deptForeign: string;
  deptForeignCode: string;

  // ── Employees, each named for one rule ────────────────────────────────────
  /** Plain, branchMain/deptOps. The default leave actor. */
  applicantId: string;
  /** The IDOR counterpart — same branch, same department, a different person. */
  applicant2Id: string;
  femaleStaffId: string;
  maleStaffId: string;
  /** `gender: null` — refused every gender-restricted type. */
  noGenderStaffId: string;
  /** Balances zeroed at setup: the insufficient-balance arm. */
  zeroBalanceStaffId: string;
  /** Owns the Dec→Jan leave (L14). */
  crossYearStaffId: string;
  /** branchAlt/deptAlt — the per-branch work-week contrast. */
  altStaffId: string;

  /** One balance actor per concern, so no case eats another's history. */
  balanceStaffId: string;
  accrualStaffId: string;
  allocStaffId: string;
  /** `status: 'INACTIVE'` — excluded from accrual, NOT from the bulk reset. */
  terminatedStaffId: string;

  /** Owns the attachment lifecycle. */
  attachStaffId: string;

  /** Plain OT actor — resolves to the Company Default policy. */
  otStaffId: string;
  otCappedId: string;
  otIneligibleId: string;
  otIgnoreId: string;
  otBoundaryId: string;
  /** `employmentType = otEmploymentType` → resolves via the EMPLOYMENT_TYPE tier. */
  otTypeStaffId: string;

  /** `supervisorId = supervisorEmpId`. The chain's requester. */
  chainRequesterId: string;
  /** NO supervisor — the zero-approver auto-skip arm. */
  chainRequester2Id: string;
  supervisorEmpId: string;

  /** deptForeign/branchForeign. */
  foreignStaffId: string;
  /** deptFin/branchMain — cross-department inside ONE branch. */
  finStaffId: string;
  /** `branchId: null` — `assertInBranch`'s null arm. */
  nullBranchStaffId: string;

  // ── Holidays ──────────────────────────────────────────────────────────────
  /**
   * Scoped to branchMain, on a WEDNESDAY: excluded from `totalDays` for a main
   * employee, an ordinary working day for `altStaff`.
   */
  mainHolidayId: string;
  mainHolidayDate: string;
  /** `branchId: null` — visible from every branch. Date found by a free scan. */
  companyHolidayId: string;
  companyHolidayDate: string;

  // ── Overtime policies (all runId-tagged; Company Default is NEVER touched) ─
  /** `maxHoursPerDay 2 / PerDoubleDay 4 / PerMonth 6 / PerYear 10`. */
  policyTightCaps: string;
  /** `eligible: false` — the create gate AND the re-check at approval. */
  policyIneligible: string;
  /** `holidayBehavior: 'IGNORE'` — a public holiday collapses to a weekday. */
  policyIgnoreHoliday: string;
  /** `dayEndBoundary: '22:00'` — stored `hours` < submitted `hours`. */
  policyBoundary: string;
  /** Scoped to {@link otEmploymentType}. */
  policyByType: string;
  /** A fixture-only EMPLOYMENT_TYPE label, so no real employee is captured. */
  otEmploymentType: string;

  // ── Fixture-only leave types (both affectsBalance:false — see below) ───────
  /** `requiresNoticeDays: 7` — a notice value nothing else in the DB uses. */
  noticeLeaveType: string;
  /** `isActive: false` — proves an inactive type falls to the legacy path. */
  retiredLeaveType: string;

  // ── Actors ────────────────────────────────────────────────────────────────
  /**
   * Global ADMIN with **no linked employee**, deliberately: it is the only way
   * to reach the `user.employeeId === undefined` doors on `POST
   * /leave-requests` and `POST /overtime`. Unlike attendance, no aggregate in
   * this module excludes ADMINs, so the cost that fixture paid does not apply.
   */
  admin: LeaveOtUser;
  /** HR_MANAGER, global branch access. */
  hr: LeaveOtUser;
  /**
   * HR_MANAGER scoped to branchMain + branchAlt, so BOTH "the whole envelope"
   * and `X-Branch-Id` narrowing are drivable. branchForeign is its 404.
   */
  scopedHr: LeaveOtUser;
  /** MANAGER heading `deptOps`. */
  mgr: LeaveOtUser;
  /** MANAGER heading `deptForeign`. */
  foreignMgr: LeaveOtUser;
  /** Plain EMPLOYEE → `applicant`. */
  employee: LeaveOtUser;
  /** Plain EMPLOYEE → `applicant2`. The IDOR counterpart. */
  otherEmployee: LeaveOtUser;
  /**
   * Holds role `EMPLOYEE` and supervises `chainRequester`. Approval authority
   * here is DATA (`Employee.supervisorId`), not RBAC — which is exactly why the
   * approve/reject routes admit EMPLOYEE at all.
   */
  supervisor: LeaveOtUser;

  // ── Helpers ───────────────────────────────────────────────────────────────
  seedLeave: (opts: SeedLeaveOpts) => Promise<string>;
  seedOvertime: (opts: SeedOvertimeOpts) => Promise<string>;
  resetBalances: (employeeId: string, year?: number) => Promise<void>;
  setBalance: (
    employeeId: string,
    leaveTypeKey: string,
    allocated: number,
    year?: number,
  ) => Promise<void>;
  withWorkflow: <T>(spec: WorkflowSpec, fn: () => Promise<T>) => Promise<T>;
  withPolicyRules: <T>(
    policyId: string,
    partial: Record<string, unknown>,
    fn: () => Promise<T>,
  ) => Promise<T>;
  runAccrualAndRevert: <T>(fn: () => Promise<T>) => Promise<T>;

  /** Every employee id this fixture owns — for per-spec `afterEach` cleanup. */
  allEmployeeIds: string[];

  cleanup: () => Promise<void>;
}

export interface SeedLeaveOpts {
  employeeId: string;
  leaveType?: string;
  start: string;
  end: string;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  totalDays?: number;
  reason?: string;
}

export interface SeedOvertimeOpts {
  employeeId: string;
  date: string;
  startHhmm?: string;
  endHhmm?: string;
  hours?: number;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  reason?: string;
}

export interface WorkflowSpec {
  requestType: 'LEAVE' | 'OVERTIME';
  mode?: 'SEQUENTIAL' | 'PARALLEL';
  /** In step order. `['SUPERVISOR','HR_MANAGER']` → two steps, 1 then 2. */
  steps: Array<'SUPERVISOR' | 'MANAGER' | 'HR_MANAGER' | 'ADMIN'>;
  name?: string;
}

/** A deterministic buffer for `supertest.attach()`. */
export function attachmentFile(bytes: number, fill = 0x41): Buffer {
  return Buffer.alloc(bytes, fill);
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
 * `holidays_date_global_uq` is a PARTIAL unique index on `(date) WHERE
 * branch_id IS NULL`, so a company-wide holiday cannot share a date with one
 * the seed — or another fixture, or a real deployment — already owns. Scanning
 * keeps setup from failing on a collision that has nothing to do with the code
 * under test. (Same scanner as `schedule-fixtures.ts:201`.)
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
    'leave-overtime-fixtures: no free company-wide holiday date in a 120-day window',
  );
}

export async function setupLeaveOvertimeFixtures(
  ctx: E2EContext,
): Promise<LeaveOtFixtures> {
  const { prisma } = ctx;
  const runId = `lot${Date.now()}`;
  const hash = await bcrypt.hash(PASSWORD, 10);

  // ── Branches ──────────────────────────────────────────────────────────────
  const branchMainCode = `LOT-M-${runId}`;
  const branchAltCode = `LOT-A-${runId}`;
  const branchForeignCode = `LOT-F-${runId}`;

  const branchMain = await prisma.branch.create({
    data: {
      code: branchMainCode,
      name: 'Leave/OT Main',
      isActive: true,
      timezone: 'Asia/Kolkata',
      officeStartTime: '09:00',
      officeEndTime: '18:00',
      weeklyOffDays: '0,6',
    },
  });
  const branchAlt = await prisma.branch.create({
    data: {
      code: branchAltCode,
      name: 'Leave/OT Alt',
      isActive: true,
      timezone: 'Asia/Muscat',
      officeStartTime: '08:00',
      officeEndTime: '17:00',
      weeklyOffDays: '4,5',
    },
  });
  // Deliberately unconfigured: it exists to be refused, not to be reasoned about.
  const branchForeign = await prisma.branch.create({
    data: {
      code: branchForeignCode,
      name: 'Leave/OT Foreign',
      isActive: true,
    },
  });

  // ── Departments ───────────────────────────────────────────────────────────
  const deptOpsCode = `LOT-DO-${runId}`;
  const deptFinCode = `LOT-DF-${runId}`;
  const deptAltCode = `LOT-DA-${runId}`;
  const deptForeignCode = `LOT-DX-${runId}`;

  const deptOps = await prisma.department.create({
    data: { code: deptOpsCode, name: 'Leave/OT Ops', isActive: true },
  });
  const deptFin = await prisma.department.create({
    data: { code: deptFinCode, name: 'Leave/OT Finance', isActive: true },
  });
  const deptAlt = await prisma.department.create({
    data: { code: deptAltCode, name: 'Leave/OT Alt Dept', isActive: true },
  });
  const deptForeign = await prisma.department.create({
    data: { code: deptForeignCode, name: 'Leave/OT Foreign Dept', isActive: true },
  });

  // ── Employees ─────────────────────────────────────────────────────────────
  let seq = 0;
  const createEmployee = (suffix: string, over: Record<string, unknown> = {}) => {
    const tag = `${suffix}${seq++}`;
    return prisma.employee.create({
      data: {
        employeeCode: `LEM-${runId}-${tag}`,
        fullName: `LeaveOT ${tag}`,
        dateOfBirth: new Date('1992-01-01'),
        idCard: `LID-${runId}-${tag}`,
        email: `${tag.toLowerCase()}-${runId}@test.local`,
        departmentId: deptOps.id,
        branchId: branchMain.id,
        position: 'Engineer',
        startDate: monthsAgo(36),
        baseSalary: 60000,
        status: 'ACTIVE',
        ...over,
      } as any,
    });
  };

  const applicant = await createEmployee('APPL');
  const applicant2 = await createEmployee('APPL2');
  const femaleStaff = await createEmployee('FEM', { gender: 'FEMALE' });
  const maleStaff = await createEmployee('MALE', { gender: 'MALE' });
  const noGenderStaff = await createEmployee('NOGEN', { gender: null });
  const zeroBalanceStaff = await createEmployee('ZEROBAL');
  const crossYearStaff = await createEmployee('XYEAR');
  const altStaff = await createEmployee('ALT', {
    departmentId: deptAlt.id,
    branchId: branchAlt.id,
  });

  const balanceStaff = await createEmployee('BAL');
  const accrualStaff = await createEmployee('ACCR');
  const allocStaff = await createEmployee('ALLOC');
  const terminatedStaff = await createEmployee('TERM', { status: 'INACTIVE' });

  const attachStaff = await createEmployee('ATT');

  const otStaff = await createEmployee('OTPLAIN');
  const otCapped = await createEmployee('OTCAP');
  const otIneligible = await createEmployee('OTINEL');
  const otIgnore = await createEmployee('OTIGN');
  const otBoundary = await createEmployee('OTBND');
  const otEmploymentType = `LOT-TYPE-${runId}`;
  const otTypeStaff = await createEmployee('OTTYPE', {
    employmentType: otEmploymentType,
  });

  const supervisorEmp = await createEmployee('SUPV');
  const chainRequester = await createEmployee('CHAIN', {
    supervisorId: supervisorEmp.id,
  });
  const chainRequester2 = await createEmployee('CHAIN2');

  const foreignStaff = await createEmployee('FOREIGN', {
    departmentId: deptForeign.id,
    branchId: branchForeign.id,
  });
  const finStaff = await createEmployee('FIN', { departmentId: deptFin.id });
  const nullBranchStaff = await createEmployee('NULLBR', { branchId: null });

  // Role-backing employees.
  const mgrEmp = await createEmployee('MGREMP', { position: 'Head of Ops' });
  const foreignMgrEmp = await createEmployee('FMGREMP', {
    departmentId: deptForeign.id,
    branchId: branchForeign.id,
    position: 'Head of Foreign',
  });
  const hrEmp = await createEmployee('HREMP');
  const scopedHrEmp = await createEmployee('SHREMP');

  // `deptFin` is deliberately left headless — see the interface comment.
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

  const adminUser = await mkUser('LADMIN', 'ADMIN'); // no employeeId, on purpose
  const hrUser = await mkUser('LHRG', 'HR_MANAGER', { employeeId: hrEmp.id });
  const scopedHrUser = await mkUser('LHRS', 'HR_MANAGER', {
    employeeId: scopedHrEmp.id,
    isGlobalBranchAccess: false,
    branchAccess: {
      create: [{ branchId: branchMain.id }, { branchId: branchAlt.id }],
    },
  });
  const mgrUser = await mkUser('LMGR', 'MANAGER', { employeeId: mgrEmp.id });
  const foreignMgrUser = await mkUser('LFMGR', 'MANAGER', {
    employeeId: foreignMgrEmp.id,
  });
  const employeeUser = await mkUser('LEMP', 'EMPLOYEE', {
    employeeId: applicant.id,
    isGlobalBranchAccess: false,
  });
  const otherEmployeeUser = await mkUser('LOEMP', 'EMPLOYEE', {
    employeeId: applicant2.id,
    isGlobalBranchAccess: false,
  });
  const supervisorUser = await mkUser('LSUPV', 'EMPLOYEE', {
    employeeId: supervisorEmp.id,
    isGlobalBranchAccess: false,
  });

  // ── Holidays ──────────────────────────────────────────────────────────────
  // A WEDNESDAY, so it is an ordinary working day in BOTH branches' work weeks
  // (main rests Sun+Sat, alt rests Thu+Fri) — the branch-scoped holiday is then
  // the only thing that can explain a difference in `totalDays`.
  const mainHolidayDate = freeDateOn(120, 3);
  const mainHoliday = await prisma.holiday.create({
    data: {
      name: `Leave/OT Branch Holiday ${runId}`,
      date: new Date(`${mainHolidayDate}T00:00:00.000Z`),
      year: LEAVE_YEAR,
      branchId: branchMain.id,
      description: `leave-ot fixture ${runId}`,
    },
  });
  const companyHolidayDate = await findFreeGlobalHolidayDate(
    ctx,
    freeDate(140),
  );
  const companyHoliday = await prisma.holiday.create({
    data: {
      name: `Leave/OT Company Holiday ${runId}`,
      date: new Date(`${companyHolidayDate}T00:00:00.000Z`),
      year: LEAVE_YEAR,
      branchId: null,
      description: `leave-ot fixture ${runId}`,
    },
  });

  // ── Fixture-only library items ────────────────────────────────────────────
  // `payBasis: null` on the employment type: a non-null value would DERIVE
  // Employee.salaryType and change the pay basis of anyone assigned to it.
  await prisma.libraryItem.create({
    data: {
      libraryType: 'EMPLOYMENT_TYPE',
      label: otEmploymentType,
      isActive: true,
      payBasis: null,
    },
  });

  /**
   * Both custom leave types are `affectsBalance: false`, and that constraint is
   * load-bearing rather than incidental: `LeaveBalancesService.getBalance`
   * auto-creates a `LeaveTypeBalance` row for EVERY active `affectsBalance`
   * type on EVERY read, for ANY employee — so an `affectsBalance: true` custom
   * type would silently materialise rows on other suites' employees, and
   * `LeaveTypeBalance.leaveTypeKey` is a plain string with no FK, so deleting
   * the LibraryItem would strand them. If a future case genuinely needs one,
   * `cleanup()` must also delete `leaveTypeBalance` by
   * `leaveTypeKey: { contains: runId }` GLOBALLY, not per employee — which it
   * already does, precisely so that change stays safe.
   *
   * Neither label may collide with a seeded default: `@@unique([libraryType,
   * label])` would make an upsert update nothing and silently reuse the real
   * row.
   */
  const noticeLeaveType = `Notice Leave ${runId}`;
  const retiredLeaveType = `Retired Leave ${runId}`;
  await prisma.libraryItem.create({
    data: {
      libraryType: 'LEAVE_TYPE',
      label: noticeLeaveType,
      isActive: true,
      defaultDays: 5,
      isPaid: true,
      requiresNoticeDays: 7,
      affectsBalance: false,
      genderRestriction: null,
    },
  });
  await prisma.libraryItem.create({
    data: {
      libraryType: 'LEAVE_TYPE',
      label: retiredLeaveType,
      isActive: false,
      defaultDays: 5,
      isPaid: true,
      requiresNoticeDays: 0,
      affectsBalance: false,
      genderRestriction: null,
    },
  });

  // ── Overtime policies ─────────────────────────────────────────────────────
  // Built from the Company Default's rules so every unspecified field inherits
  // exactly what a normal employee gets, and only the field under test moves.
  const companyDefault = await prisma.overtimePolicy.findFirst({
    where: { isDefault: true, isActive: true },
  });
  const baseRules: Record<string, unknown> = {
    ...((companyDefault?.rules as Record<string, unknown>) ?? {}),
  };

  const mkPolicy = (
    suffix: string,
    rules: Record<string, unknown>,
    over: Record<string, unknown> = {},
  ) =>
    prisma.overtimePolicy.create({
      data: {
        name: `LOT ${suffix} ${runId}`,
        description: `leave-ot fixture ${runId}`,
        isActive: true,
        isDefault: false,
        schemaVersion: 1,
        rules: { ...baseRules, ...rules } as any,
        ...over,
      },
    });

  // Tight caps make every cap boundary reachable in 2–3 requests instead of the
  // ~30h of setup the real defaults would demand.
  const policyTightCaps = await mkPolicy('TIGHT', {
    maxHoursPerDay: 2,
    maxHoursPerDoubleDay: 4,
    maxHoursPerMonth: 6,
    maxHoursPerYear: 10,
  });
  const policyIneligible = await mkPolicy('INELIGIBLE', { eligible: false });
  const policyIgnoreHoliday = await mkPolicy('IGNOREHOL', {
    holidayBehavior: 'IGNORE',
  });
  const policyBoundary = await mkPolicy('BOUNDARY', {
    dayEndBoundary: '22:00',
  });
  const policyByType = await mkPolicy(
    'BYTYPE',
    { maxHoursPerDay: 3 },
    { employmentType: otEmploymentType },
  );

  await prisma.employee.update({
    where: { id: otCapped.id },
    data: { overtimePolicyId: policyTightCaps.id },
  });
  await prisma.employee.update({
    where: { id: otIneligible.id },
    data: { overtimePolicyId: policyIneligible.id },
  });
  await prisma.employee.update({
    where: { id: otIgnore.id },
    data: { overtimePolicyId: policyIgnoreHoliday.id },
  });
  await prisma.employee.update({
    where: { id: otBoundary.id },
    data: { overtimePolicyId: policyBoundary.id },
  });

  const fixturePolicyIds = [
    policyTightCaps.id,
    policyIneligible.id,
    policyIgnoreHoliday.id,
    policyBoundary.id,
    policyByType.id,
  ];

  // ── Zero out the insufficient-balance actor ───────────────────────────────
  await prisma.leaveBalance.create({
    data: {
      employeeId: zeroBalanceStaff.id,
      year: LEAVE_YEAR,
      annualLeave: 0,
      sickLeave: 0,
      usedAnnual: 0,
      usedSick: 0,
      carriedOver: 0,
    },
  });
  await prisma.leaveTypeBalance.createMany({
    data: [
      {
        employeeId: zeroBalanceStaff.id,
        year: LEAVE_YEAR,
        leaveTypeKey: 'Annual Leave',
        allocated: 0,
      },
      {
        employeeId: zeroBalanceStaff.id,
        year: LEAVE_YEAR,
        leaveTypeKey: 'Sick Leave',
        allocated: 0,
      },
    ],
    skipDuplicates: true,
  });

  const allEmployeeIds = [
    applicant.id,
    applicant2.id,
    femaleStaff.id,
    maleStaff.id,
    noGenderStaff.id,
    zeroBalanceStaff.id,
    crossYearStaff.id,
    altStaff.id,
    balanceStaff.id,
    accrualStaff.id,
    allocStaff.id,
    terminatedStaff.id,
    attachStaff.id,
    otStaff.id,
    otCapped.id,
    otIneligible.id,
    otIgnore.id,
    otBoundary.id,
    otTypeStaff.id,
    supervisorEmp.id,
    chainRequester.id,
    chainRequester2.id,
    foreignStaff.id,
    finStaff.id,
    nullBranchStaff.id,
    mgrEmp.id,
    foreignMgrEmp.id,
    hrEmp.id,
    scopedHrEmp.id,
  ];

  const userEmails = [
    adminUser.email,
    hrUser.email,
    scopedHrUser.email,
    mgrUser.email,
    foreignMgrUser.email,
    employeeUser.email,
    otherEmployeeUser.email,
    supervisorUser.email,
  ];

  const originalApprovalSwitch = await readApprovalSwitch(prisma);

  /**
   * When this fixture booted. Used by `cleanup()` to sweep the approval
   * engine's user-less audit rows — see the comment at teardown step 14.
   */
  const startedAt = new Date();

  // Workflows this fixture's `withWorkflow` created, and the ones it had to
  // deactivate to do so. Both are needed on teardown.
  const createdWorkflowIds: string[] = [];

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Write a leave row straight to the database, bypassing `create()`'s
   * validation. Read-side cases need requests in states the API will not
   * produce on demand (an APPROVED one in the past, an overlapping pair, a
   * REJECTED one), and paying notice-period + overlap + balance validation to
   * set up a list assertion is how a fixture ends up asserting the code under
   * test.
   */
  const seedLeave = async (o: SeedLeaveOpts): Promise<string> => {
    const start = new Date(`${o.start}T00:00:00.000Z`);
    const end = new Date(`${o.end}T00:00:00.000Z`);
    const days =
      o.totalDays ??
      Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    const row = await prisma.leaveRequest.create({
      data: {
        employeeId: o.employeeId,
        leaveType: o.leaveType ?? 'Annual Leave',
        startDate: start,
        endDate: end,
        totalDays: days,
        reason: o.reason ?? `leave-ot fixture seeded leave ${runId}`,
        status: o.status ?? 'PENDING',
      },
    });
    return row.id;
  };

  const seedOvertime = async (o: SeedOvertimeOpts): Promise<string> => {
    const startHhmm = o.startHhmm ?? '19:00';
    const endHhmm = o.endHhmm ?? '21:00';
    const row = await prisma.overtimeRequest.create({
      data: {
        employeeId: o.employeeId,
        date: new Date(`${o.date}T00:00:00.000Z`),
        startTime: new Date(atUtc(o.date, startHhmm)),
        endTime: new Date(atUtc(o.date, endHhmm)),
        hours: o.hours ?? 2,
        reason: o.reason ?? `leave-ot fixture seeded overtime ${runId}`,
        status: o.status ?? 'PENDING',
      },
    });
    return row.id;
  };

  /**
   * Delete both balance models for one employee/year so a case starts from the
   * library defaults rather than from whatever the previous case deducted.
   * Deduction is cumulative and has no product-level undo (finding L13), so
   * without this every balance assertion after the first is a moving target.
   */
  const resetBalances = async (employeeId: string, year = LEAVE_YEAR) => {
    await prisma.leaveTypeBalance.deleteMany({ where: { employeeId, year } });
    await prisma.leaveBalance.deleteMany({ where: { employeeId, year } });
  };

  const setBalance = async (
    employeeId: string,
    leaveTypeKey: string,
    allocated: number,
    year = LEAVE_YEAR,
  ) => {
    await prisma.leaveTypeBalance.upsert({
      where: {
        employeeId_year_leaveTypeKey: { employeeId, year, leaveTypeKey },
      },
      create: { employeeId, year, leaveTypeKey, allocated, used: 0 },
      update: { allocated, used: 0, carriedOver: 0 },
    });
    if (leaveTypeKey === 'Annual Leave' || leaveTypeKey === 'Sick Leave') {
      const col = leaveTypeKey === 'Annual Leave' ? 'annualLeave' : 'sickLeave';
      await prisma.leaveBalance.upsert({
        where: { employeeId_year: { employeeId, year } },
        create: {
          employeeId,
          year,
          annualLeave: col === 'annualLeave' ? allocated : 12,
          sickLeave: col === 'sickLeave' ? allocated : 30,
        },
        update: { [col]: allocated, usedAnnual: 0, usedSick: 0 } as any,
      });
    }
  };

  /**
   * Install an approval workflow for the duration of `fn`, then remove it and
   * reactivate whatever it displaced.
   *
   * This is shared, ENVIRONMENT-WIDE configuration: `PUT /approval-workflows`
   * deactivates the previous active workflow for that request type, and the
   * databases these suites run against are also used for demos. A spec that
   * installs a chain without putting the old one back silently disables every
   * configured approval chain in that environment.
   *
   * `supervisor-approval.e2e-spec.ts:53-70,193-211` does this by hand; this
   * promotes it so the next suite does not have to get it right again.
   */
  const withWorkflow = async <T>(
    spec: WorkflowSpec,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const displaced = await prisma.approvalWorkflow.findMany({
      where: { requestType: spec.requestType as any, isActive: true },
      select: { id: true },
    });
    await prisma.approvalWorkflow.updateMany({
      where: { id: { in: displaced.map((w) => w.id) } },
      data: { isActive: false },
    });
    const wf = await prisma.approvalWorkflow.create({
      data: {
        requestType: spec.requestType as any,
        name: spec.name ?? `LOT ${spec.requestType} ${runId}`,
        mode: (spec.mode ?? 'SEQUENTIAL') as any,
        isActive: true,
        steps: {
          create: spec.steps.map((approverType, i) => ({
            stepOrder: i + 1,
            approverType: approverType as any,
          })),
        },
      },
    });
    createdWorkflowIds.push(wf.id);
    try {
      return await fn();
    } finally {
      await prisma.approvalStep.deleteMany({ where: { workflowId: wf.id } });
      await prisma.approvalWorkflow.deleteMany({ where: { id: wf.id } });
      await prisma.approvalWorkflow.updateMany({
        where: { id: { in: displaced.map((w) => w.id) } },
        data: { isActive: true },
      });
    }
  };

  /**
   * Patch a fixture policy's `rules` blob for the duration of `fn`.
   *
   * The ONLY way to move an overtime cap, rate or threshold for a policied
   * employee — see the correction in the file header. Never point this at
   * "Company Default": it is the environment's fallback for every employee that
   * has no override.
   */
  const withPolicyRules = async <T>(
    policyId: string,
    partial: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const before = await prisma.overtimePolicy.findUniqueOrThrow({
      where: { id: policyId },
    });
    if (!fixturePolicyIds.includes(policyId)) {
      throw new Error(
        `withPolicyRules refuses a policy this fixture does not own: ${before.name}`,
      );
    }
    await prisma.overtimePolicy.update({
      where: { id: policyId },
      data: { rules: { ...(before.rules as object), ...partial } as any },
    });
    try {
      return await fn();
    } finally {
      await prisma.overtimePolicy.update({
        where: { id: policyId },
        data: { rules: before.rules as any },
      });
    }
  };

  /**
   * Run `fn` around one of the two GLOBAL balance mutations and put the whole
   * database back.
   *
   * `POST /leave-balances/accrual/run` adds +1 annual day to every ACTIVE
   * employee in the caller's envelope and writes a `LeaveAccrualHistory` row
   * for each. `POST /leave-balances/set-default-allocation` is worse: it
   * iterates EVERY employee with no status filter and overwrites `allocated`
   * from the library defaults, destroying manual allocations and accrued days
   * alike. Neither has a dry run, a confirmation or an undo.
   *
   * So: snapshot both balance models for every employee, restore them field by
   * field afterwards, delete every row that did not exist before, and remove
   * the accrual history the call wrote. Without this, every absolute-balance
   * assertion in every suite that runs later is measuring a different number —
   * and the failure surfaces in a file that never called either endpoint.
   */
  const runAccrualAndRevert = async <T>(fn: () => Promise<T>): Promise<T> => {
    const balancesBefore = await prisma.leaveBalance.findMany();
    const typeBalancesBefore = await prisma.leaveTypeBalance.findMany();
    const historyIdsBefore = new Set(
      (await prisma.leaveAccrualHistory.findMany({ select: { id: true } })).map(
        (h) => h.id,
      ),
    );
    try {
      return await fn();
    } finally {
      for (const b of balancesBefore) {
        await prisma.leaveBalance
          .update({
            where: { id: b.id },
            data: {
              annualLeave: b.annualLeave,
              sickLeave: b.sickLeave,
              usedAnnual: b.usedAnnual,
              usedSick: b.usedSick,
              carriedOver: b.carriedOver,
            },
          })
          .catch(() => undefined);
      }
      for (const t of typeBalancesBefore) {
        await prisma.leaveTypeBalance
          .update({
            where: { id: t.id },
            data: {
              allocated: t.allocated,
              used: t.used,
              carriedOver: t.carriedOver,
            },
          })
          .catch(() => undefined);
      }
      const after = await prisma.leaveAccrualHistory.findMany({
        select: { id: true },
      });
      const created = after
        .map((h) => h.id)
        .filter((id) => !historyIdsBefore.has(id));
      if (created.length) {
        await prisma.leaveAccrualHistory.deleteMany({
          where: { id: { in: created } },
        });
      }
      // Rows the call CREATED are not in the snapshot, so restoring by id
      // cannot remove them — and `set-default-allocation` creates a
      // `LeaveTypeBalance` per active type for EVERY employee in the system.
      // Anything that did not exist before this window did not exist at all:
      // the suite runs `maxWorkers: 1`, so no other writer could have added it.
      const knownBalanceIds = new Set(balancesBefore.map((b) => b.id));
      const strayBalances = (await prisma.leaveBalance.findMany({
        select: { id: true },
      })).filter((b) => !knownBalanceIds.has(b.id));
      if (strayBalances.length) {
        await prisma.leaveBalance.deleteMany({
          where: { id: { in: strayBalances.map((b) => b.id) } },
        });
      }

      const knownTypeIds = new Set(typeBalancesBefore.map((t) => t.id));
      const strayTypes = (await prisma.leaveTypeBalance.findMany({
        select: { id: true },
      })).filter((t) => !knownTypeIds.has(t.id));
      if (strayTypes.length) {
        await prisma.leaveTypeBalance.deleteMany({
          where: { id: { in: strayTypes.map((t) => t.id) } },
        });
      }
    }
  };

  const fixtures: LeaveOtFixtures = {
    runId,
    password: PASSWORD,

    branchMain: branchMain.id,
    branchMainCode,
    branchAlt: branchAlt.id,
    branchAltCode,
    branchForeign: branchForeign.id,
    branchForeignCode,

    deptOps: deptOps.id,
    deptOpsCode,
    deptFin: deptFin.id,
    deptFinCode,
    deptAlt: deptAlt.id,
    deptAltCode,
    deptForeign: deptForeign.id,
    deptForeignCode,

    applicantId: applicant.id,
    applicant2Id: applicant2.id,
    femaleStaffId: femaleStaff.id,
    maleStaffId: maleStaff.id,
    noGenderStaffId: noGenderStaff.id,
    zeroBalanceStaffId: zeroBalanceStaff.id,
    crossYearStaffId: crossYearStaff.id,
    altStaffId: altStaff.id,

    balanceStaffId: balanceStaff.id,
    accrualStaffId: accrualStaff.id,
    allocStaffId: allocStaff.id,
    terminatedStaffId: terminatedStaff.id,

    attachStaffId: attachStaff.id,

    otStaffId: otStaff.id,
    otCappedId: otCapped.id,
    otIneligibleId: otIneligible.id,
    otIgnoreId: otIgnore.id,
    otBoundaryId: otBoundary.id,
    otTypeStaffId: otTypeStaff.id,

    chainRequesterId: chainRequester.id,
    chainRequester2Id: chainRequester2.id,
    supervisorEmpId: supervisorEmp.id,

    foreignStaffId: foreignStaff.id,
    finStaffId: finStaff.id,
    nullBranchStaffId: nullBranchStaff.id,

    mainHolidayId: mainHoliday.id,
    mainHolidayDate,
    companyHolidayId: companyHoliday.id,
    companyHolidayDate,

    policyTightCaps: policyTightCaps.id,
    policyIneligible: policyIneligible.id,
    policyIgnoreHoliday: policyIgnoreHoliday.id,
    policyBoundary: policyBoundary.id,
    policyByType: policyByType.id,
    otEmploymentType,

    noticeLeaveType,
    retiredLeaveType,

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
      employeeId: applicant.id,
      email: employeeUser.email,
      token: await login(ctx, employeeUser.email),
    },
    otherEmployee: {
      userId: otherEmployeeUser.id,
      employeeId: applicant2.id,
      email: otherEmployeeUser.email,
      token: await login(ctx, otherEmployeeUser.email),
    },
    supervisor: {
      userId: supervisorUser.id,
      employeeId: supervisorEmp.id,
      email: supervisorUser.email,
      token: await login(ctx, supervisorUser.email),
    },

    seedLeave,
    seedOvertime,
    resetBalances,
    setBalance,
    withWorkflow,
    withPolicyRules,
    runAccrualAndRevert,

    allEmployeeIds,

    /**
     * FK-safe teardown. The order is load-bearing at the five marked points,
     * and the whole thing is idempotent — a mid-run failure leaves orphans that
     * a by-id delete cannot reach, so every step is written to survive being
     * run twice (and the WP-1 smoke spec runs it twice for exactly that
     * reason).
     */
    cleanup: async () => {
      const empWhere = {
        OR: [
          { employeeCode: { contains: runId } },
          { email: { contains: runId } },
        ],
      };
      const empIds = (
        await prisma.employee.findMany({ where: empWhere, select: { id: true } })
      ).map((e) => e.id);

      // 0. Capture what later steps cannot rediscover.
      const attachments = await prisma.leaveAttachment.findMany({
        where: { leaveRequest: { employeeId: { in: empIds } } },
        select: { id: true, fileUrl: true },
      });
      const leaveIds = (
        await prisma.leaveRequest.findMany({
          where: { employeeId: { in: empIds } },
          select: { id: true },
        })
      ).map((r) => r.id);
      const otIds = (
        await prisma.overtimeRequest.findMany({
          where: { employeeId: { in: empIds } },
          select: { id: true },
        })
      ).map((r) => r.id);

      // 1. FIRST, and by explicit id: RequestApproval has NO foreign key to
      //    anything (schema.prisma:725) and is in no branch-scope rule. Nothing
      //    cascades it — the rows outlive the requests they describe.
      if (leaveIds.length || otIds.length) {
        await prisma.requestApproval.deleteMany({
          where: { requestId: { in: [...leaveIds, ...otIds] } },
        });
      }

      // 2. Before LeaveRequest. A cascade exists, but soft-deleted rows and the
      //    file list captured above make the explicit pass worth keeping.
      if (leaveIds.length) {
        await prisma.leaveAttachment.deleteMany({
          where: { leaveRequestId: { in: leaveIds } },
        });
      }

      // 3. MUST precede the branch delete: `Attendance.branch` is
      //    `onDelete: Restrict`, and approved leave now stamps `branchId`.
      await prisma.attendance.deleteMany({
        where: { employeeId: { in: empIds } },
      });

      await prisma.leaveApproval.deleteMany({
        where: { leaveRequestId: { in: leaveIds } },
      });
      await prisma.leaveRequest.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.overtimeRequest.deleteMany({
        where: { employeeId: { in: empIds } },
      });

      // 6. The second clause catches rows `accrual/run` wrote for FOREIGN
      //    employees — `triggeredBy` is the only handle those rows have.
      await prisma.leaveAccrualHistory.deleteMany({
        where: {
          OR: [
            { employeeId: { in: empIds } },
            { triggeredBy: { in: [adminUser.id, hrUser.id, scopedHrUser.id] } },
          ],
        },
      });

      await prisma.leaveTypeBalance.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      // Global on purpose: a custom leave type auto-materialises rows on OTHER
      // suites' employees, and `leaveTypeKey` is a plain string with no FK.
      await prisma.leaveTypeBalance.deleteMany({
        where: { leaveTypeKey: { contains: runId } },
      });
      await prisma.leaveBalance.deleteMany({
        where: { employeeId: { in: empIds } },
      });

      // 9. Detach before delete. `name: { contains: runId }` can NEVER match
      //    "Company Default" — the environment's fallback, which `remove()`
      //    refuses to delete while it is the active default anyway.
      await prisma.employee.updateMany({
        where: { overtimePolicyId: { in: fixturePolicyIds } },
        data: { overtimePolicyId: null },
      });
      await prisma.overtimePolicy.deleteMany({
        where: { name: { contains: runId } },
      });

      await prisma.libraryItem.deleteMany({
        where: { libraryType: 'LEAVE_TYPE', label: { contains: runId } },
      });
      await prisma.libraryItem.deleteMany({
        where: { libraryType: 'EMPLOYMENT_TYPE', label: { contains: runId } },
      });

      // 11. `withWorkflow` unwinds itself, so this only catches a mid-run death.
      await prisma.approvalStep.deleteMany({
        where: { workflow: { name: { contains: runId } } },
      });
      await prisma.approvalWorkflow.deleteMany({
        where: { name: { contains: runId } },
      });

      // 12. The company-wide holiday has `branchId: null`, so nothing cascades
      //     it — leaving it behind takes a date out of circulation for every
      //     later run against the same database (partial unique index).
      await prisma.holiday.deleteMany({
        where: { description: { contains: runId } },
      });

      // 13. The engine writes one notification per approver per activated step.
      await prisma.notification.deleteMany({
        where: { user: { email: { contains: runId } } },
      });
      await prisma.auditLog.deleteMany({
        where: { user: { email: { in: userEmails } } },
      });
      // …and again by resource id, because the approval engine's own audit rows
      // carry `userId: null`. `initiate()` is called by `create()` WITHOUT an
      // actor argument (`leave-requests.service.ts`, `overtime.service.ts`), so
      // `APPROVAL_INITIATED` — and every `LeaveRequest` / `OvertimeRequest` row
      // written the same way — has no user to match on. A relation filter over a
      // null foreign key matches nothing, so the pass above silently leaves them
      // behind.
      if (leaveIds.length || otIds.length) {
        await prisma.auditLog.deleteMany({
          where: { resourceId: { in: [...leaveIds, ...otIds] } },
        });
      }
      // And once more by TIME, because a spec's own `afterEach` deletes its
      // leave and overtime rows long before `cleanup()` runs — so by now the id
      // list above no longer contains most of what this run audited. Scoped to
      // the three resource types this module writes, to rows with no user, and
      // to this fixture's lifetime: the suite runs `maxWorkers: 1`, so nothing
      // else could have written one in that window.
      await prisma.auditLog.deleteMany({
        where: {
          userId: null,
          resourceType: {
            in: ['LeaveRequest', 'OvertimeRequest', 'RequestApproval'],
          },
          createdAt: { gte: startedAt },
        },
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

      await restoreApprovalSwitch(prisma, originalApprovalSwitch);

      // 21. `StorageService` falls back to LOCAL DISK when MinIO is
      //     unconfigured (and again when a configured MinIO fails), so an e2e
      //     upload really writes a file. A run that dies mid-file leaves one,
      //     which is untidy but harmless.
      for (const a of attachments) {
        if (!a.fileUrl || /^https?:\/\//i.test(a.fileUrl)) continue;
        await unlink(
          resolvePath(process.cwd(), a.fileUrl.replace(/^\/+/, '')),
        ).catch(() => undefined);
      }
    },
  };

  return fixtures;
}
