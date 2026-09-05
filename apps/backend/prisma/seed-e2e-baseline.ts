/**
 * The deterministic starting state for the browser suite.
 *
 * Runs AFTER `prisma:seed`, and adds only what the browser tests need on top of
 * it. Two things it fixes about the base seed:
 *
 *  1. **There is no MANAGER user.** `prisma/seed.ts` creates ADMIN, HR_MANAGER
 *     and EMPLOYEE only, so manager scoping, `/dashboard/my-team` and
 *     `/dashboard/my-department` cannot be exercised at all. This is also a
 *     real gap for local development, not just for tests.
 *  2. **Feature flags are inherited, not pinned.** A suite that reads whatever
 *     `system_settings` happens to hold is not reproducible: the same spec
 *     passes or fails depending on what the last person toggled. Every flag the
 *     tests depend on is written explicitly below.
 *
 * Safety: this script writes and overwrites. It refuses to run against anything
 * that is not the disposable local test database, mirroring `assertDevDb()` in
 * `test/utils/mcp-harness.ts`. The tracked `apps/backend/.env` points at a
 * REMOTE host, which is exactly the accident this guard exists to prevent.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { LETTER_TEMPLATE_DEFAULTS } from '../src/letters/letter-defaults';

const prisma = new PrismaClient();

/** Only the throwaway test Postgres. Anything else is refused. */
const ALLOWED_DB_HOSTS = ['localhost:8069', '127.0.0.1:8069'];

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!ALLOWED_DB_HOSTS.some((host) => url.includes(host))) {
    throw new Error(
      `Refusing to seed: DATABASE_URL does not point at the test database.\n` +
        `  Expected one of: ${ALLOWED_DB_HOSTS.join(', ')}\n` +
        `  Got: ${url.replace(/:\/\/[^@]*@/, '://***@') || '(unset)'}\n` +
        `Use apps/backend/.env.test — the tracked .env points at a remote host.`,
    );
  }
}

/**
 * Flags the browser suite depends on, and the value it assumes.
 *
 * Anything a spec branches on belongs here. A flag NOT listed is one no test
 * should be reading.
 */
const PINNED_SETTINGS: Record<string, string> = {
  // Off is the production default; the template-on journey flips it against its
  // own database copy so it cannot race the rest of the suite.
  employee_template_enabled: 'false',
  // Document engine. Pinned OFF so the default e2e run exercises the pre-engine
  // behaviour; suites that need it flip it through withSetting, restored in a
  // finally around a single case.
  document_engine_enabled: 'false',
  document_live_preview_enabled: 'false',
  document_bulk_enabled: 'false',
  document_visual_editor_enabled: 'false',
  // The overtime journey needs the module present.
  overtime_enabled: 'true',
  // Legacy single-approver path, which is what most specs assume.
  supervisor_approval_enabled: 'false',
  // ── Finance ───────────────────────────────────────────────────────────────
  // Authorization in Finance is TWO gates: the `@Roles()` decorator, and one of
  // these CSV role lists read from the database at request time. A suite that
  // leaves them unpinned is not testing a permission model, it is reporting
  // whatever the last person to open Settings happened to leave behind.
  travel_approver_roles: 'HR_MANAGER,ADMIN',
  // The classic dashboard, not the v2 experiment.
  dashboard_layout: 'v1',
  // Keeps the hard-delete path reachable in the employee journey.
  allow_hard_delete_terminated: 'true',
  // ── Time & Schedules ──────────────────────────────────────────────────────
  // The schedule matrix shades its columns from the branch's work week and
  // falls back to this when no branch is narrowed. Pinned so the shading is the
  // same on a Sunday run as on a Wednesday one.
  calendar_weekly_holidays: '0,6',
  // The hours arithmetic on both schedule screens. A shift screen that computed
  // 9h where the spec expected 8h would look like a broken shift, not a lunch
  // policy nobody pinned.
  lunch_break_start: '13:00',
  lunch_break_duration_minutes: '60',
  payroll_work_hours_per_day: '8',
  // The shift reminder offsets. No browser case waits on the cron — the backend
  // suite calls the scheduler directly — but an unpinned offset would let a
  // running server's own tick flip `priorEmailSent` under a spec asserting the
  // shift list.
  shift_reminder_prior_mins: '5',
  shift_reminder_post_mins: '5',
  // ── Attendance ────────────────────────────────────────────────────────────
  // Face RECOGNITION off, but the capture screen stays: check-in is still a
  // camera frame, the backend just stores it instead of matching it. Left on,
  // every check-in button is disabled until the employee enrols a face, and the
  // attendance journey could not run at all. Default is 'true', so this must be
  // written rather than assumed.
  face_recognition_enabled: 'false',
  attendance_face_only: 'false',
  // Multiple sessions per day — the flexible-shift shape the journey asserts.
  allow_multiple_checkin: 'true',
  strict_attendance_mode: 'false',
  // Self-service correction quota. Set high on purpose: the corrections journey
  // files several requests in one month and each retry files more, so a
  // realistic cap turns a retry into "New request is disabled" rather than into
  // the assertion the spec is actually making. The settings journey changes
  // this value and puts it back, which is how the cap itself gets tested.
  monthly_attendance_request_limit: '50',
  // Fixed so date assertions do not depend on the host machine.
  system_timezone: 'UTC',
  // ── People ────────────────────────────────────────────────────────────────
  // Both clearance switches ON, because the interesting People journeys are the
  // ones where offboarding is REFUSED. Defaults are already 'true', so this
  // pins what is already true rather than changing it.
  clearance_blocking_enabled: 'true',
  //
  // ── Workplace ─────────────────────────────────────────────────────────────
  // Letters render a real PDF, and `workplace-letters.e2e-spec.ts` turns this
  // OFF for one case (the auto-issue orphan, LET-API-14) and back on again. A
  // leaked 'false' fails `letters-grievance-vault.e2e-spec.ts`, which never
  // touched the flag — so the starting state has to be stated rather than
  // inherited. The default is already 'true'; this pins it.
  pdf_enabled: 'true',
  //
  // `reminder_days_asset_warranty` is deliberately NOT pinned, for the same
  // reason as the two reminder settings below: `workplace-asset-clearance`
  // drives its own tiers with `withSetting` and asserts which ones fire.
  //
  // NOT pinned here, deliberately, and this is the trap to know about:
  // `test:e2e` (the backend suite) runs against the SAME `ess_e2e` database the
  // browser suite does, so a value written here is the starting state for both.
  // Three settings look like obvious candidates and are not:
  //
  //   employee_start_date_max_past_days / _max_future_days
  //     `backdated-onboarding.e2e-spec.ts` asserts the seeded defaults ('' and
  //     '180'). Pinning them blank fails that spec.
  //   reminder_days_legal_document / reminder_days_contract
  //     `reminders.e2e-spec.ts` drives its own thresholds and asserts which
  //     ones fire. Pinning them changes what it observes.
  //
  // A People spec that needs any of these takes them with `withSetting(...)`
  // and puts them back — which is what that helper is for.
};

async function pinSettings(): Promise<void> {
  for (const [key, value] of Object.entries(PINNED_SETTINGS)) {
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
  console.log(`⚙️  Pinned ${Object.keys(PINNED_SETTINGS).length} system settings`);
}

/**
 * The missing MANAGER, plus the department headship that makes them one.
 *
 * A MANAGER with no department is indistinguishable from an employee as far as
 * every scoping check is concerned, so the headship is the point — not the role
 * string.
 */
async function seedManager(): Promise<void> {
  const department = await prisma.department.findFirst({ where: { code: 'HRD' } });
  const branch = await prisma.branch.findFirst({ where: { code: 'HO' } });
  if (!department || !branch) {
    throw new Error('Base seed missing: expected department HRD and branch HO. Run prisma:seed first.');
  }

  const email = 'manager@company.com';
  const passwordHash = await bcrypt.hash('Password123!', 10);

  let employee = await prisma.employee.findUnique({ where: { email } });
  if (!employee) {
    employee = await prisma.employee.create({
      data: {
        employeeCode: 'MGR001',
        fullName: 'Department Manager',
        email,
        idCard: 'ID-MGR-001',
        position: 'Department Manager',
        departmentId: department.id,
        branchId: branch.id,
        startDate: new Date('2024-01-01'),
        baseSalary: 0,
        status: 'ACTIVE',
        dateOfBirth: new Date('1988-01-01'),
      },
    });
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: 'MANAGER', isActive: true, isGlobalBranchAccess: false },
    create: {
      email,
      passwordHash,
      role: 'MANAGER',
      employeeId: employee.id,
      isActive: true,
      isEmailVerified: true,
      isGlobalBranchAccess: false,
    },
  });

  // Heads the department — without this, manager scoping resolves to an empty
  // set and every /my-department screen is legitimately blank.
  await prisma.department.update({
    where: { id: department.id },
    data: { managerId: employee.id },
  });

  await prisma.userBranchAccess.upsert({
    where: { userId_branchId: { userId: user.id, branchId: branch.id } },
    update: {},
    create: { userId: user.id, branchId: branch.id },
  });

  console.log(`👤 MANAGER ${email} heads ${department.name}`);
}

/**
 * Gives the base EMPLOYEE a supervisee, so the data-driven "My Team" overlay in
 * the sidebar is exercised by something other than a mock.
 */
async function seedSupervisee(): Promise<void> {
  const supervisor = await prisma.employee.findUnique({ where: { email: 'employee1@company.com' } });
  const department = await prisma.department.findFirst({ where: { code: 'HRD' } });
  const branch = await prisma.branch.findFirst({ where: { code: 'HO' } });
  if (!supervisor || !department || !branch) return;

  const email = 'employee2@company.com';
  const existing = await prisma.employee.findUnique({ where: { email } });
  if (existing) {
    await prisma.employee.update({ where: { id: existing.id }, data: { supervisorId: supervisor.id } });
    await linkSuperviseeUser(existing.id, email);
    return;
  }

  const created = await prisma.employee.create({
    data: {
      employeeCode: 'EMP002',
      fullName: 'Reporting Employee',
      email,
      idCard: 'ID-EMP-002',
      position: 'Junior Developer',
      departmentId: department.id,
      branchId: branch.id,
      startDate: new Date('2025-01-01'),
      baseSalary: 0,
      status: 'ACTIVE',
      dateOfBirth: new Date('1998-01-01'),
      supervisorId: supervisor.id,
    },
  });

  await linkSuperviseeUser(created.id, email);
  console.log('👥 employee1 now supervises employee2');
}

/**
 * `employee2` had an Employee row but no User, so nobody could sign in as them.
 *
 * The approval-chain spec needs a REQUESTER whose supervisor is a real
 * Playwright role: `employee1` supervises `employee2`, so a leave filed by
 * `employee2` puts step 1 in the hands of the `employee` project and step 2 in
 * HR's — the only configuration where both halves of a chain are drivable in a
 * browser.
 */
async function linkSuperviseeUser(employeeId: string, email: string): Promise<void> {
  const passwordHash = await bcrypt.hash('Password123!', 10);
  await prisma.user.upsert({
    where: { email },
    update: { employeeId, isActive: true },
    create: {
      email,
      passwordHash,
      role: 'EMPLOYEE',
      isActive: true,
      isGlobalBranchAccess: false,
      employeeId,
    },
  });
}

/**
 * A second branch in a different timezone.
 *
 * Branch switching is only meaningful with somewhere to switch to, and a second
 * zone is what makes a timezone bug visible rather than theoretical. Mirrors
 * what `test/utils/fixtures.ts` builds for the backend suite.
 */
async function seedSecondBranch(): Promise<void> {
  await prisma.branch.upsert({
    where: { code: 'E2E-BR2' },
    update: {},
    create: {
      code: 'E2E-BR2',
      name: 'E2E Second Branch',
      isActive: true,
      timezone: 'Asia/Muscat',
      officeStartTime: '08:00',
      officeEndTime: '16:00',
      geofencingEnabled: false,
    },
  });
  console.log('🏢 Second branch E2E-BR2 (Asia/Muscat) ready');
}

/**
 * A department hierarchy worth testing against.
 *
 * The base seed leaves exactly one department, `HRD`, which every employee
 * belongs to. With a single flat node there is no tree to render, no second
 * option in a parent select, no way to see a filter narrow anything, and no way
 * to exercise the guards that refuse to delete or move a department — the rules
 * that make up most of this module.
 *
 * So: one more top-level department with a child (structure and the
 * has-sub-departments guard), and one empty top-level department (the parent
 * options list, and a filter that has something to exclude). None of them has
 * staff, which is deliberate — the has-employees guard already has `HRD`.
 */
async function seedOrgHierarchy(): Promise<void> {
  const ops = await prisma.department.upsert({
    where: { code: 'E2E-OPS' },
    update: { isActive: true },
    create: {
      code: 'E2E-OPS',
      name: 'Operations',
      description: 'Second top-level department, for hierarchy tests',
      isActive: true,
    },
  });

  await prisma.department.upsert({
    where: { code: 'E2E-OPS-TEAM' },
    update: { isActive: true, parentId: ops.id },
    create: {
      code: 'E2E-OPS-TEAM',
      name: 'Operations Team',
      description: 'Child of Operations — makes the tree two levels deep',
      isActive: true,
      parentId: ops.id,
    },
  });

  await prisma.department.upsert({
    where: { code: 'E2E-FIN' },
    update: { isActive: true },
    create: {
      code: 'E2E-FIN',
      name: 'Finance',
      description: 'Top-level department with no staff and no children',
      isActive: true,
    },
  });

  console.log('🏛  Departments E2E-OPS → E2E-OPS-TEAM and E2E-FIN ready');
}

/**
 * Gives the base-seed employees a working history.
 *
 * `prisma/seed.ts` sets `startDate: new Date()` for ADM001, HRM001 and EMP001,
 * so on a freshly built template every one of them joined the company today.
 * That is not merely unrealistic — it makes whole flows untestable, because the
 * backend refuses anything dated before an employee's onboarding:
 *
 *   Cannot adjust attendance before the employee's onboarding date (…)
 *
 * An attendance correction is by definition about a day that already happened,
 * and the form's `max` is today, so with a start date of today there is no legal
 * date at all. Backdating here fixes the fixture rather than weakening the rule.
 */
async function backdateFoundingEmployees(): Promise<void> {
  const started = new Date('2024-01-01T00:00:00.000Z');
  const { count } = await prisma.employee.updateMany({
    where: { employeeCode: { in: ['ADM001', 'HRM001', 'EMP001'] } },
    data: { startDate: started },
  });
  console.log(`📅 Backdated ${count} base employees to ${started.toISOString().slice(0, 10)}`);
}

/**
 * Give the loggable accounts a salary.
 *
 * Every login-capable seeded account carried `baseSalary: 0`, and any rule
 * guarded on a positive pay figure was therefore vacuously satisfied for
 * exactly the accounts a browser test can log in as. A test written against
 * them proved nothing about the rules it appeared to exercise.
 *
 * The figure is deliberately generous (50,000) so those rules are LIVE without
 * being tripped by the ordinary journeys: a suite that now refuses its own
 * happy path would be a different kind of wrong.
 */
async function payFoundingEmployees(): Promise<void> {
  const { count } = await prisma.employee.updateMany({
    where: {
      employeeCode: { in: ['ADM001', 'HRM001', 'MGR001', 'EMP001', 'EMP002'] },
      baseSalary: 0,
    },
    data: { baseSalary: 50000 },
  });
  if (count > 0) {
    console.log(`💵 Gave ${count} base employees a salary, so the affordability rules are live`);
  }
}

/**
 * The People module's baseline: a second MANAGER, staff in states the People
 * rules branch on, teams on both sides of the branch boundary, and visas.
 *
 * Why a SECOND manager rather than reusing `manager@company.com`: the People
 * role matrix needs "manager in scope" and "manager out of scope" to be two
 * real sessions. With one manager heading one department there is no such thing
 * as out of scope, and every cross-department denial would have to be simulated
 * rather than driven.
 *
 * Why the staff states are seeded rather than created per-spec: the browser
 * suite runs against a disposable clone with no teardown, but a journey that
 * TERMINATES or DELETES an employee must never touch the four role accounts —
 * so it needs its own people to do that to, present before the run starts.
 */
async function seedPeopleBaseline(): Promise<void> {
  const ops = await prisma.department.findFirst({ where: { code: 'E2E-OPS' } });
  const fin = await prisma.department.findFirst({ where: { code: 'E2E-FIN' } });
  const ho = await prisma.branch.findFirst({ where: { code: 'HO' } });
  const br2 = await prisma.branch.findFirst({ where: { code: 'E2E-BR2' } });
  if (!ops || !fin || !ho || !br2) {
    throw new Error(
      'People baseline needs E2E-OPS, E2E-FIN, HO and E2E-BR2 — run seedOrgHierarchy and seedSecondBranch first.',
    );
  }

  const passwordHash = await bcrypt.hash('Password123!', 10);

  const upsertEmployee = async (
    email: string,
    data: Record<string, any>,
  ) => {
    const existing = await prisma.employee.findUnique({ where: { email } });
    if (existing) {
      return prisma.employee.update({ where: { id: existing.id }, data });
    }
    return prisma.employee.create({ data: { email, ...data } as any });
  };

  // ── The out-of-scope manager ──────────────────────────────────────────────
  const managerEmail = 'manager2@company.com';
  const opsHead = await upsertEmployee(managerEmail, {
    employeeCode: 'MGR002',
    fullName: 'Operations Manager',
    idCard: 'ID-MGR-002',
    position: 'Operations Manager',
    departmentId: ops.id,
    branchId: ho.id,
    startDate: new Date('2024-01-01'),
    baseSalary: 0,
    status: 'ACTIVE',
    dateOfBirth: new Date('1987-05-05'),
  });

  const opsUser = await prisma.user.upsert({
    where: { email: managerEmail },
    update: {
      passwordHash,
      role: 'MANAGER',
      isActive: true,
      isGlobalBranchAccess: false,
    },
    create: {
      email: managerEmail,
      passwordHash,
      role: 'MANAGER',
      employeeId: opsHead.id,
      isActive: true,
      isEmailVerified: true,
      isGlobalBranchAccess: false,
    },
  });
  await prisma.department.update({
    where: { id: ops.id },
    data: { managerId: opsHead.id },
  });
  await prisma.userBranchAccess.upsert({
    where: { userId_branchId: { userId: opsUser.id, branchId: ho.id } },
    update: {},
    create: { userId: opsUser.id, branchId: ho.id },
  });

  // ── Staff in the three states the People journeys need ────────────────────
  const contracted = await upsertEmployee('e2e.contracted@company.com', {
    employeeCode: 'E2E-CON1',
    fullName: 'Contracted Staff',
    idCard: 'ID-E2E-CON1',
    position: 'Operations Analyst',
    departmentId: ops.id,
    branchId: ho.id,
    startDate: new Date('2024-03-01'),
    baseSalary: 42000,
    status: 'ACTIVE',
    dateOfBirth: new Date('1995-03-03'),
  });

  await upsertEmployee('e2e.uncontracted@company.com', {
    employeeCode: 'E2E-NOCON',
    fullName: 'Uncontracted Staff',
    idCard: 'ID-E2E-NOCON',
    position: 'Operations Assistant',
    departmentId: ops.id,
    branchId: ho.id,
    startDate: new Date('2024-04-01'),
    baseSalary: 30000,
    status: 'ACTIVE',
    dateOfBirth: new Date('1996-04-04'),
  });

  // Already TERMINATED, so the hard-delete path (which requires TERMINATED plus
  // `allow_hard_delete_terminated`, already pinned true) is reachable without a
  // journey having to terminate one of the role accounts first.
  await upsertEmployee('e2e.terminated@company.com', {
    employeeCode: 'E2E-TERMED',
    fullName: 'Terminated Staff',
    idCard: 'ID-E2E-TERMED',
    position: 'Former Analyst',
    departmentId: ops.id,
    branchId: ho.id,
    startDate: new Date('2023-01-01'),
    endDate: new Date('2025-06-30'),
    baseSalary: 30000,
    status: 'TERMINATED',
    dateOfBirth: new Date('1990-06-06'),
  });

  // Staff in the SECOND branch, under Finance — the far side of every
  // cross-branch assertion.
  const finStaff = await upsertEmployee('e2e.finance@company.com', {
    employeeCode: 'E2E-FIN1',
    fullName: 'Finance Staff',
    idCard: 'ID-E2E-FIN1',
    position: 'Accountant',
    departmentId: fin.id,
    branchId: br2.id,
    startDate: new Date('2024-05-01'),
    baseSalary: 38000,
    status: 'ACTIVE',
    dateOfBirth: new Date('1994-07-07'),
  });

  // ── One live contract ─────────────────────────────────────────────────────
  const existingContract = await prisma.contract.findFirst({
    where: { employeeId: contracted.id, status: 'ACTIVE' },
  });
  if (!existingContract) {
    await prisma.contract.create({
      data: {
        employeeId: contracted.id,
        contractType: 'INDEFINITE',
        contractNumber: 'E2E-CONTRACT-1',
        startDate: new Date('2024-03-01'),
        salary: 42000,
        status: 'ACTIVE',
      },
    });
  }

  // ── Teams on both sides of the branch boundary ────────────────────────────
  // The pair is what makes the cross-branch Teams journey drivable without a
  // spec having to create a branch of its own.
  const opsTeam = await prisma.team.upsert({
    where: { code: 'E2E-OPS-TEAM-A' },
    update: { isActive: true },
    create: {
      code: 'E2E-OPS-TEAM-A',
      name: 'Operations Team A',
      departmentId: ops.id,
      teamLeadId: contracted.id,
      type: 'PERMANENT',
    },
  });
  const opsMember = await prisma.teamMember.findFirst({
    where: { teamId: opsTeam.id, employeeId: contracted.id },
  });
  if (!opsMember) {
    await prisma.teamMember.create({
      data: { teamId: opsTeam.id, employeeId: contracted.id, role: 'LEAD' },
    });
  }

  const finTeam = await prisma.team.upsert({
    where: { code: 'E2E-FIN-TEAM-A' },
    update: { isActive: true },
    create: {
      code: 'E2E-FIN-TEAM-A',
      name: 'Finance Team A',
      departmentId: fin.id,
      teamLeadId: finStaff.id,
      type: 'PERMANENT',
    },
  });
  const finMember = await prisma.teamMember.findFirst({
    where: { teamId: finTeam.id, employeeId: finStaff.id },
  });
  if (!finMember) {
    await prisma.teamMember.create({
      data: { teamId: finTeam.id, employeeId: finStaff.id, role: 'LEAD' },
    });
  }

  // ── Visas: one expiring inside the window, one already expired ────────────
  // Without both, the expiring-soon filter and the summary tiles have nothing
  // honest to count and every assertion about them is vacuously true.
  const inDays = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d;
  };
  const upsertVisa = async (
    employeeId: string,
    documentNumber: string,
    data: Record<string, any>,
  ) => {
    const existing = await prisma.employeeLegalDocument.findFirst({
      where: { documentNumber },
    });
    if (existing) {
      return prisma.employeeLegalDocument.update({
        where: { id: existing.id },
        data,
      });
    }
    return prisma.employeeLegalDocument.create({
      data: { employeeId, documentNumber, ...data } as any,
    });
  };

  await upsertVisa(contracted.id, 'E2E-VISA-EXPIRING', {
    category: 'VISA',
    documentType: 'Employment Visa',
    country: 'Oman',
    issueDate: new Date('2024-03-01'),
    expiryDate: inDays(20),
    status: 'ACTIVE',
    isCurrent: true,
  });

  await upsertVisa(finStaff.id, 'E2E-VISA-EXPIRED', {
    category: 'VISA',
    documentType: 'Employment Visa',
    country: 'Oman',
    issueDate: new Date('2023-01-01'),
    expiryDate: new Date('2025-01-01'),
    status: 'EXPIRED',
    isCurrent: true,
  });

  console.log(
    '🧑‍💼 People baseline: manager2 heads E2E-OPS; 4 staff, 1 contract, 2 teams, 2 visas',
  );
}


/**
 * The month every schedule browser case navigates to.
 *
 * FIXED rather than relative to today, deliberately. A roster seeded around
 * "now" changes shape depending on when the template is built — the 31st exists
 * in some months and not others, and the weekday a given date falls on moves —
 * so the T18 last-day-of-month regression would be asserting something
 * different on every run. May 2026 has 31 days, which is what that case needs.
 */
export const SCHEDULE_MONTH = { year: 2026, month: 5, days: 31 };

const scheduleDate = (day: number) =>
  new Date(
    Date.UTC(SCHEDULE_MONTH.year, SCHEDULE_MONTH.month - 1, day),
  );

/** `YYYY-MM-DDTHH:MM:00.000Z` on a day of the schedule month. */
const scheduleAt = (day: number, hhmm: string) =>
  new Date(
    `${SCHEDULE_MONTH.year}-${String(SCHEDULE_MONTH.month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hhmm}:00.000Z`,
  );

/**
 * Work schedules, and the people who own them, for the Time & Schedules browser
 * journeys.
 *
 * Five DEDICATED employees rather than schedules hung off the four role
 * accounts. That is not tidiness: `attendances.service.ts` branches three ways
 * on `FLEXIBLE` — flexible days always permit multiple sessions regardless of
 * `allow_multiple_checkin`, they suppress the late/early derivation, and they
 * take no lunch deduction. Attaching a flexible schedule to `employee1`, whom
 * `attendance.spec.ts` clocks in and out while asserting session counts and
 * state transitions, would change what those assertions MEAN without changing
 * what they say. New employees are invisible to them.
 *
 * `docs/TESTING.md` named flexible-shift required-hours arithmetic as a known
 * gap "because the baseline has no flexible-shift employee". This is that
 * employee.
 */
async function seedScheduleBaseline(): Promise<void> {
  const ho = await prisma.branch.findFirst({ where: { code: 'HO' } });
  const br2 = await prisma.branch.findFirst({ where: { code: 'E2E-BR2' } });
  const ops = await prisma.department.findFirst({ where: { code: 'E2E-OPS' } });
  if (!ho || !br2 || !ops) {
    throw new Error(
      'Schedule baseline needs HO, E2E-BR2 and E2E-OPS — run seedSecondBranch and seedOrgHierarchy first.',
    );
  }

  const upsertStaff = async (
    code: string,
    fullName: string,
    over: Record<string, any> = {},
  ) => {
    const email = `${code.toLowerCase()}@company.com`;
    const data = {
      employeeCode: code,
      fullName,
      dateOfBirth: new Date('1992-01-01'),
      idCard: `ID-${code}`,
      departmentId: ops.id,
      branchId: ho.id,
      position: 'Operations Associate',
      startDate: new Date('2022-01-01'),
      baseSalary: 45000,
      status: 'ACTIVE' as const,
      ...over,
    };
    const existing = await prisma.employee.findUnique({ where: { email } });
    if (existing) {
      return prisma.employee.update({ where: { id: existing.id }, data });
    }
    return prisma.employee.create({ data: { email, ...data } as any });
  };

  const flexible = await upsertStaff('E2E-SCHFLEX', 'Fiona Flexible');
  const rostered = await upsertStaff('E2E-SCHFULL', 'Rosa Rostered');
  const onLeave = await upsertStaff('E2E-SCHLEAVE', 'Liam Leave');
  const onOvertime = await upsertStaff('E2E-SCHOT', 'Otto Overtime');
  const branchTwo = await upsertStaff('E2E-SCHBR2', 'Basim Branch', {
    branchId: br2.id,
  });

  const staffIds = [
    flexible.id,
    rostered.id,
    onLeave.id,
    onOvertime.id,
    branchTwo.id,
  ];

  // Idempotent: the template is rebuilt from scratch, but the seed is also run
  // by hand against a live clone often enough that a second run must not
  // collide with the unique (employee_id, date, start_time) index.
  await prisma.workSchedule.deleteMany({
    where: { employeeId: { in: staffIds } },
  });
  await prisma.leaveRequest.deleteMany({
    where: { employeeId: { in: staffIds } },
  });
  await prisma.overtimeRequest.deleteMany({
    where: { employeeId: { in: staffIds } },
  });

  // ── A full month, INCLUDING the last day ──────────────────────────────────
  // The 31st is the point. A range built with `toISOString()` on a local
  // midnight loses it at any positive UTC offset, so the grid rendered a column
  // that was never fetched and a shift there was invisible.
  await prisma.workSchedule.createMany({
    data: Array.from({ length: SCHEDULE_MONTH.days }, (_, i) => ({
      employeeId: rostered.id,
      date: scheduleDate(i + 1),
      shiftType: 'FULL_DAY' as const,
      startTime: scheduleAt(i + 1, '09:00'),
      endTime: scheduleAt(i + 1, '18:00'),
      isWorkDay: true,
    })),
  });

  // ── One flexible day, so the required-hours arithmetic has a subject ──────
  await prisma.workSchedule.create({
    data: {
      employeeId: flexible.id,
      date: scheduleDate(4),
      shiftType: 'FLEXIBLE',
      startTime: null,
      endTime: null,
      requiredHours: 7.5,
      isWorkDay: true,
      notes: 'Flexible day — target hours, no fixed window',
    },
  });

  // ── A split day: two shifts, one date, no overlap ─────────────────────────
  // Legitimate, and the shape the (employee, date, start_time) constraint was
  // chosen to preserve. Seeded so the grid has one to render.
  await prisma.workSchedule.createMany({
    data: [
      {
        employeeId: flexible.id,
        date: scheduleDate(6),
        shiftType: 'CUSTOM' as const,
        startTime: scheduleAt(6, '06:00'),
        endTime: scheduleAt(6, '10:00'),
        isWorkDay: true,
      },
      {
        employeeId: flexible.id,
        date: scheduleDate(6),
        shiftType: 'CUSTOM' as const,
        startTime: scheduleAt(6, '14:00'),
        endTime: scheduleAt(6, '18:00'),
        isWorkDay: true,
      },
    ],
  });

  // ── The other two cell types the matrix renders ───────────────────────────
  await prisma.leaveRequest.create({
    data: {
      employeeId: onLeave.id,
      leaveType: 'ANNUAL',
      startDate: scheduleDate(11),
      endDate: scheduleDate(13),
      totalDays: 3,
      reason: 'Baseline approved leave for the schedule matrix',
      status: 'APPROVED',
    },
  });
  await prisma.overtimeRequest.create({
    data: {
      employeeId: onOvertime.id,
      date: scheduleDate(18),
      startTime: scheduleAt(18, '19:00'),
      endTime: scheduleAt(18, '21:00'),
      hours: 2,
      reason: 'Baseline approved overtime for the schedule matrix',
      status: 'APPROVED',
    },
  });

  // ── A branch-2 roster, for the branch-narrowing journey ───────────────────
  // E2E-BR2 is Asia/Muscat and keeps its own work week, which is what makes the
  // per-branch weekend shading assertable from the screen.
  await prisma.workSchedule.createMany({
    data: [20, 21, 22].map((day) => ({
      employeeId: branchTwo.id,
      date: scheduleDate(day),
      shiftType: 'FULL_DAY' as const,
      startTime: scheduleAt(day, '08:00'),
      endTime: scheduleAt(day, '17:00'),
      isWorkDay: true,
    })),
  });

  await prisma.branch.update({
    where: { id: br2.id },
    // Friday + Saturday. Distinct from the company default of '0,6' on purpose:
    // a branch resting the same days as the company would let a global-setting
    // fallback pass as if it were per-branch.
    data: { weeklyOffDays: '4,5' },
  });

  console.log(
    `📅 Schedule baseline ready — ${SCHEDULE_MONTH.days} rostered days, 1 flexible, 1 split day, leave + overtime, branch-2 roster`,
  );
}


/**
 * Everything the Finance screens need in order to render anything at all.
 *
 * The base seed ships no banks, no banking field schema, no budgets and no
 * per-diem destinations, so `/dashboard/banks`, `/dashboard/banks/migrate`,
 * `/dashboard/budgets` and the travel form all open onto an empty state and
 * cannot be driven past it. Every Finance journey would otherwise have to build
 * its own world over the API on each run — which is slow, and worse, means each
 * spec is really testing its own setup code.
 *
 * Deliberately modest: one bank, the two Omani field definitions, one ACTIVE
 * budget with a department line AND a company-wide fallback line, and two
 * destinations of which one is rated ZERO. That last one is not padding — a
 * Prisma `Decimal` is a truthy object, so a zero rate is the case that catches a
 * service writing `if (rate)` instead of `Number(rate) > 0` and raising a junk
 * 0.00 claim on every local trip.
 */
/**
 * Workplace baseline — Asset Register and Letter Requests.
 *
 * The browser suite must not have to create an asset before it can assign one.
 * Everything here is upserted on a natural key so a re-run is a no-op.
 *
 * What each row is FOR:
 *  - `E2E-AST-FREE` is assignable; `E2E-AST-HELD` is already out with EMP001,
 *    so the held/available split, the clearance gate and the delete-while-held
 *    refusal all have a subject on a fresh database.
 *  - the same pair exists in the second branch, which is what makes a
 *    branch-scoped read provably narrower than an unscoped one.
 *  - one PENDING and one ISSUED letter, so the HR queue is never empty and the
 *    verification endpoint always has a real serial to resolve.
 */
async function seedWorkplaceBaseline(): Promise<void> {
  const ho = await prisma.branch.findUnique({ where: { code: 'HO' } });
  if (!ho) {
    console.log('⚠️  No HO branch — skipping the workplace baseline');
    return;
  }
  const br2 = await prisma.branch.findUnique({ where: { code: 'E2E-BR2' } });

  // Asset categories are copied LibraryItem labels, not FKs — the register
  // refuses a category that is not in the library.
  for (const label of ['E2E Laptop', 'E2E Phone', 'E2E Vehicle']) {
    await prisma.libraryItem.upsert({
      where: { libraryType_label: { libraryType: 'ASSET_CATEGORY', label } },
      update: { isActive: true },
      create: { libraryType: 'ASSET_CATEGORY', label, isActive: true },
    });
  }

  const employees = await prisma.employee.findMany({
    where: { employeeCode: { in: ['ADM001', 'HRM001', 'EMP001', 'EMP002', 'MGR001'] } },
    select: { id: true, employeeCode: true },
  });
  const byCode = new Map(employees.map((e) => [e.employeeCode, e.id]));
  const emp1 = byCode.get('EMP001');
  const emp2 = byCode.get('EMP002');
  const mgr1 = byCode.get('MGR001');

  const adminUser = await prisma.user.findUnique({
    where: { email: 'admin@company.com' },
    select: { id: true },
  });

  // ── Assets ────────────────────────────────────────────────────────────────
  const assetSpecs = [
    { assetTag: 'E2E-AST-FREE', name: 'E2E Free Laptop', branchId: ho.id },
    { assetTag: 'E2E-AST-HELD', name: 'E2E Held Laptop', branchId: ho.id },
    ...(br2
      ? [
          { assetTag: 'E2E-AST-BR2-FREE', name: 'E2E BR2 Free Laptop', branchId: br2.id },
          { assetTag: 'E2E-AST-BR2-HELD', name: 'E2E BR2 Held Laptop', branchId: br2.id },
        ]
      : []),
  ];

  for (const spec of assetSpecs) {
    await prisma.assetItem.upsert({
      // R2 — asset_tag is unique PER BRANCH now, so the tag alone no longer
      // identifies a row.
      where: {
        branchId_assetTag: {
          branchId: spec.branchId,
          assetTag: spec.assetTag,
        },
      },
      update: { name: spec.name, branchId: spec.branchId },
      create: {
        assetTag: spec.assetTag,
        name: spec.name,
        category: 'E2E Laptop',
        branchId: spec.branchId,
        serialNumber: `SN-${spec.assetTag}`,
        status: 'AVAILABLE',
      },
    });
  }

  // Put the two HELD assets out to their holders. The partial unique index
  // `asset_assignments_one_open_per_asset` means a second open row is
  // impossible, so this is guarded on "is one already open?" rather than upsert.
  const heldPairs: Array<{
    tag: string;
    branchId: string;
    employeeId: string | undefined;
  }> = [
    { tag: 'E2E-AST-HELD', branchId: ho.id, employeeId: emp1 },
    ...(br2
      ? [{ tag: 'E2E-AST-BR2-HELD', branchId: br2.id, employeeId: emp2 }]
      : []),
  ];
  for (const { tag, branchId, employeeId } of heldPairs) {
    if (!employeeId || !adminUser) continue;
    const asset = await prisma.assetItem.findUnique({
      where: { branchId_assetTag: { branchId, assetTag: tag } },
    });
    if (!asset) continue;
    const open = await prisma.assetAssignment.findFirst({
      where: { assetId: asset.id, returnedAt: null },
    });
    if (open) continue;
    await prisma.assetAssignment.create({
      data: {
        assetId: asset.id,
        employeeId,
        assignedAt: new Date(),
        assignedById: adminUser.id,
        conditionOut: 'GOOD',
      },
    });
    await prisma.assetItem.update({
      where: { id: asset.id },
      data: { status: 'ASSIGNED' },
    });
  }

  // ── Letters ───────────────────────────────────────────────────────────────
  // The templates are ALSO upserted by `LettersService.onModuleInit`, but the
  // template database is built by this script with no Nest app running — so a
  // plain `e2e:db reset` used to leave `ess_e2e` with zero templates, and every
  // `POST /letters` answered `404 No active "SALARY_CERTIFICATE" template for
  // locale "en"` until someone restarted the backend. That is a harness lie of
  // the same family as an unmounted module: the failure names the letters
  // module rather than the reset that caused it. Seeding them here makes a
  // reset sufficient on its own. `update: {}` matches the service, so HR's
  // wording is never overwritten.
  for (const t of LETTER_TEMPLATE_DEFAULTS) {
    await prisma.letterTemplate.upsert({
      where: { key_locale: { key: t.key, locale: t.locale } },
      update: {},
      create: {
        key: t.key,
        name: t.name,
        locale: t.locale,
        bodyHtml: t.bodyHtml,
        requiresApproval: t.requiresApproval,
        isActive: true,
      },
    });
  }

  if (emp1) {
    const pending = await prisma.letterRequest.findFirst({
      where: { employeeId: emp1, templateKey: 'SALARY_CERTIFICATE', status: 'PENDING' },
    });
    if (!pending) {
      await prisma.letterRequest.create({
        data: {
          employeeId: emp1,
          templateKey: 'SALARY_CERTIFICATE',
          locale: 'en',
          purpose: 'E2E baseline pending request',
          status: 'PENDING',
        },
      });
    }

    // An ISSUED row with a real serial, so `/letters/verify/:serial` always
    // resolves on a fresh database. No PDF is attached: the file path is owned
    // by letters-grievance-vault.e2e-spec.ts, which renders one for real.
    await prisma.letterRequest.upsert({
      where: { serialNumber: 'E2E-BASELINE-0001' },
      update: {},
      create: {
        employeeId: emp1,
        templateKey: 'EXPERIENCE',
        locale: 'en',
        purpose: 'E2E baseline issued letter',
        status: 'ISSUED',
        serialNumber: 'E2E-BASELINE-0001',
        issuedAt: new Date(),
      },
    });
  }

  console.log('✅ Workplace baseline: assets and letters seeded.');
}

/**
 * Talent rows, so the hub's browser journey has fixed numbers to assert.
 *
 * The baseline seeded NO talent data at all, which meant `/dashboard/talent`
 * rendered honest zeros and a journey could only ever assert that the page did
 * not crash. Every row here is deterministic and idempotent: fixed dates, fixed
 * counts, upserted or guarded so a re-run does not double them.
 *
 * The appraisal run is deliberately `COMPLETED`, not `RUNNING`: a live backend
 * pointed at this database will claim a RUNNING row within seconds and drive it
 * somewhere else, which is exactly the kind of moving target a browser
 * assertion must not be pinned to.
 */
async function seedTalentBaseline(): Promise<void> {
  const ho = await prisma.branch.findUnique({ where: { code: 'HO' } });
  const hrUser = await prisma.user.findUnique({
    where: { email: 'hr@company.com' },
    select: { id: true },
  });
  const employees = await prisma.employee.findMany({
    where: { employeeCode: { in: ['EMP001', 'EMP002', 'MGR001'] } },
    select: { id: true, employeeCode: true, fullName: true },
  });
  if (!hrUser || employees.length < 2) {
    console.log('⚠️  No HR user or employees — skipping the talent baseline');
    return;
  }

  // ── Appraisal: one completed run, 3 of 4 employees done ───────────────────
  const RUN_LABEL = 'E2E Baseline H1';
  let run = await prisma.appraisalRun.findFirst({ where: { periodLabel: RUN_LABEL } });
  if (!run) {
    run = await prisma.appraisalRun.create({
      data: {
        branchId: ho?.id ?? null,
        status: 'COMPLETED',
        periodStart: new Date(Date.UTC(2026, 0, 1)),
        periodEnd: new Date(Date.UTC(2026, 5, 30)),
        periodLabel: RUN_LABEL,
        totalEmployees: 4,
        // 3/4 = 75%, a rate with no rounding ambiguity to assert against.
        completedEmployees: 3,
        createdById: hrUser.id,
        completedAt: new Date(Date.UTC(2026, 6, 1)),
      },
    });
    await prisma.appraisalResult.createMany({
      data: [
        ...employees.slice(0, 3).map((e, i) => ({
          runId: run!.id,
          employeeId: e.id,
          employeeCode: e.employeeCode,
          employeeName: e.fullName,
          status: 'COMPLETED',
          recommendation: ['PROMOTE', 'MAINTAIN', 'COACH'][i],
          rankOverall: i + 1,
        })),
        // The fourth is DEGRADED on purpose: the attention strip watches for
        // exactly this, and a run where everything succeeded proves nothing
        // about whether the card fires.
        {
          runId: run.id,
          employeeId: null,
          employeeCode: 'E2E-GONE',
          employeeName: 'E2E Departed Employee',
          status: 'DEGRADED',
          rankOverall: 4,
        },
      ] as never,
    });
  }

  // ── Conduct: two rewards, one action, both dated this month ───────────────
  const emp1 = employees[0];
  const emp2 = employees[1] ?? employees[0];
  const now = new Date();
  const thisMonth = (d: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d));
  // Never date into the future: the current month is partial, and a reward
  // dated the 5th on the 2nd would not be counted by the window it belongs to.
  const safeDay = (d: number) => thisMonth(Math.min(d, now.getUTCDate()));

  const REWARD_REASON = 'E2E baseline reward';
  if (!(await prisma.reward.findFirst({ where: { reason: REWARD_REASON } }))) {
    await prisma.reward.createMany({
      data: [
        {
          employeeId: emp1.id,
          reason: REWARD_REASON,
          amount: 500,
          rewardDate: safeDay(2),
          rewardType: 'BONUS',
          createdBy: hrUser.id,
        },
        {
          employeeId: emp2.id,
          reason: REWARD_REASON,
          amount: 250,
          rewardDate: safeDay(3),
          rewardType: 'CERTIFICATE',
          createdBy: hrUser.id,
        },
      ] as never,
    });
  }

  const DISCIPLINE_REASON = 'E2E baseline disciplinary action';
  if (!(await prisma.discipline.findFirst({ where: { reason: DISCIPLINE_REASON } }))) {
    await prisma.discipline.create({
      data: {
        employeeId: emp2.id,
        reason: DISCIPLINE_REASON,
        disciplineType: 'WARNING',
        amount: 0,
        disciplineDate: safeDay(4),
        createdBy: hrUser.id,
      },
    });
  }

  // ── Grievance: one open, and old enough to trip the aging threshold ───────
  const GRIEVANCE_SUBJECT = 'E2E baseline aged grievance';
  if (!(await prisma.grievance.findFirst({ where: { subject: GRIEVANCE_SUBJECT } }))) {
    await prisma.grievance.create({
      data: {
        employeeId: emp1.id,
        category: 'Workplace Environment',
        subject: GRIEVANCE_SUBJECT,
        description: 'Seeded so the aging card has something to age.',
        // INVESTIGATING specifically: the status the old `/grievances/stats`
        // dropped from its open count. If this stops being counted, the
        // three-way definition bug has come back.
        status: 'INVESTIGATING',
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      },
    });
  }

  console.log('🌱 Talent baseline: 1 completed appraisal run, 2 rewards, 1 action, 1 aged grievance');
}

async function seedFinanceBaseline(): Promise<void> {
  const ho = await prisma.branch.findUnique({ where: { code: 'HO' } });
  if (!ho) {
    console.log('⚠️  No HO branch — skipping the finance baseline');
    return;
  }

  // Banking countries drive which bank-detail field schemas an employee may
  // use. Without them the migrate screen shows "No banking countries set".
  await prisma.branch.update({
    where: { id: ho.id },
    data: { country: ho.country ?? 'OM', bankingCountries: ['OM'] },
  });
  await prisma.branch
    .update({
      where: { code: 'E2E-BR2' },
      data: { country: 'OM', bankingCountries: ['OM'] },
    })
    .catch(() => undefined);

  // Bank Muscat's real CBO code, so a generated IBAN passes the bank-code
  // cross-check the live path performs rather than failing for the wrong reason.
  await prisma.bank.upsert({
    where: { country_name: { country: 'OM', name: 'E2E Bank Muscat' } },
    update: { isActive: true, bankCode: '018' },
    create: {
      country: 'OM',
      name: 'E2E Bank Muscat',
      bankCode: '018',
      swift: 'BMUSOMRX',
      isActive: true,
    },
  });
  await prisma.bank.upsert({
    where: { country_name: { country: 'OM', name: 'E2E National Bank' } },
    update: { isActive: true, bankCode: '022' },
    create: {
      country: 'OM',
      name: 'E2E National Bank',
      bankCode: '022',
      isActive: true,
    },
  });

  for (const field of [
    {
      fieldKey: 'accountHolderName',
      label: 'Account Holder Name',
      validationType: 'NONE',
      required: true,
      displayOrder: 1,
    },
    {
      fieldKey: 'iban',
      label: 'IBAN',
      validationType: 'IBAN',
      required: true,
      displayOrder: 2,
    },
  ]) {
    await prisma.countryBankingField.upsert({
      where: { country_fieldKey: { country: 'OM', fieldKey: field.fieldKey } },
      update: { isActive: true },
      create: { country: 'OM', ...field },
    });
  }

  // Two per-diem destinations, one rated and one at zero.
  for (const dest of [
    { label: 'E2E Muscat', perDiemRate: 25 },
    { label: 'E2E Local (no per diem)', perDiemRate: 0 },
  ]) {
    await prisma.libraryItem.upsert({
      where: {
        libraryType_label: {
          libraryType: 'PER_DIEM_DESTINATION',
          label: dest.label,
        },
      },
      update: { isActive: true, perDiemRate: dest.perDiemRate },
      create: {
        libraryType: 'PER_DIEM_DESTINATION',
        label: dest.label,
        perDiemRate: dest.perDiemRate,
        isActive: true,
      },
    });
  }

  for (const label of ['Payroll', 'Overtime', 'Travel', 'Training']) {
    await prisma.libraryItem.upsert({
      where: { libraryType_label: { libraryType: 'BUDGET_CATEGORY', label } },
      update: { isActive: true },
      create: { libraryType: 'BUDGET_CATEGORY', label, isActive: true },
    });
  }

  const admin = await prisma.user.findUnique({
    where: { email: 'admin@company.com' },
    select: { id: true },
  });
  const hrd = await prisma.department.findUnique({ where: { code: 'HRD' } });
  const year = new Date().getFullYear();

  if (admin) {
    const budget = await prisma.budget.upsert({
      where: {
        branchId_fiscalYear_name: {
          branchId: ho.id,
          fiscalYear: year,
          name: `FY${year} Operating Budget`,
        },
      },
      update: { status: 'ACTIVE' },
      create: {
        name: `FY${year} Operating Budget`,
        fiscalYear: year,
        startDate: new Date(`${year}-01-01`),
        endDate: new Date(`${year}-12-31`),
        branchId: ho.id,
        currency: 'OMR',
        status: 'ACTIVE',
        createdById: admin.id,
      },
    });

    // A department line and the company-wide fallback, so the "department line
    // beats the fallback" resolution has both halves to choose between.
    //
    // Written with findFirst + create rather than upsert: `departmentId` is
    // nullable, and Prisma refuses null inside a compound-unique `where`, so the
    // fallback line cannot be upserted by its own key.
    for (const line of [
      { departmentId: hrd?.id ?? null, category: 'Travel', plannedAmount: 10000 },
      { departmentId: null, category: 'Travel', plannedAmount: 5000 },
    ]) {
      const existing = await prisma.budgetLine.findFirst({
        where: {
          budgetId: budget.id,
          departmentId: line.departmentId,
          category: line.category,
        },
        select: { id: true },
      });
      if (existing) {
        await prisma.budgetLine.update({
          where: { id: existing.id },
          data: { plannedAmount: line.plannedAmount },
        });
      } else {
        await prisma.budgetLine.create({
          data: { budgetId: budget.id, ...line },
        });
      }
    }
  }

  // One employee left with NO active bank detail, so the migration screen is
  // never empty. EMP002 has no user account, which makes it a safe subject.
  const migrationCandidate = await prisma.employee.findUnique({
    where: { employeeCode: 'EMP002' },
    select: { id: true },
  });
  if (migrationCandidate) {
    await prisma.employeeBankDetail.deleteMany({
      where: { employeeId: migrationCandidate.id },
    });
    await prisma.employeeProfile.upsert({
      where: { employeeId: migrationCandidate.id },
      update: { bankName: 'Legacy Bank plc' },
      create: {
        employeeId: migrationCandidate.id,
        bankName: 'Legacy Bank plc',
      },
    });
  }

  console.log('💰 Finance baseline ready (banks, fields, budget, destinations)');
}

async function main(): Promise<void> {
  assertTestDatabase();
  console.log('🌱 Seeding the browser-test baseline…');

  await pinSettings();
  await backdateFoundingEmployees();
  await payFoundingEmployees();
  await seedManager();
  await seedSupervisee();
  await seedSecondBranch();
  await seedOrgHierarchy();
  await seedPeopleBaseline();
  await seedScheduleBaseline();
  await seedFinanceBaseline();
  await seedWorkplaceBaseline();
  await seedTalentBaseline();

  console.log('✅ Baseline ready');
}

main()
  .catch((e) => {
    console.error('❌ Baseline seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
