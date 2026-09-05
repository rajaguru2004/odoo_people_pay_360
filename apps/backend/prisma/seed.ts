/**
 * Idempotent bootstrap seed.
 *
 * Runs on every container start (see docker-entrypoint.sh) and on demand with
 * `npm run db:seed`, so every statement here has to be safe to repeat. That
 * means upserts keyed on a natural unique column — never a bare `create` — and
 * it means the admin's `update` branch deliberately does NOT touch
 * passwordHash: re-running the seed must not silently reset a password
 * somebody changed in the app.
 *
 * It seeds three things, in this order because each depends on the last:
 *
 *   1. **Configuration** — the settings every module reads before it can do
 *      anything: the office window, the grace period, the alert horizons.
 *   2. **Structure** — company, branches, departments, the sign-in accounts.
 *   3. **Operating data** — employees, contracts, permits, teams, and a month
 *      of attendance behind them, so every screen has something true to draw
 *      rather than an empty state that cannot be told apart from a broken
 *      query.
 */
import {
  AttendanceSource,
  AttendanceStatus,
  ContractStatus,
  ContractType,
  DepartmentChangeType,
  EmployeeStatus,
  LegalDocumentCategory,
  LibraryType,
  OvertimeDayType,
  OvertimeType,
  PayrollRunStatus,
  PrismaClient,
  RequestStatus,
  SalaryComponentType,
  ShiftType,
  TeamMemberRole,
  TeamType,
  TerminationCategory,
  UserRole,
  WorkType,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
// The leave-type and employment-type pick lists come from the module that owns
// them rather than being restated here — see seedLeaveLibraries below.
import { seedLibraryDefaults } from '../src/library-items/library-defaults';
import { OVERTIME_SETTING_DEFAULTS } from '../src/overtime-policy/overtime-config';
import {
  calculatePayslip,
  isPayable,
} from '../src/payroll/payroll-calc.util';
import { eachDayKey, periodFor } from '../src/payroll/payroll-period.util';
import { resolvePaidDays } from '../src/payroll/payroll-attendance.util';
import { DateTime } from 'luxon';

const prisma = new PrismaClient();

const SEED_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@123';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Written as rows rather than left to the service's in-code defaults.
 *
 * The defaults exist so a database nobody has configured still renders; these
 * rows exist so the settings screen shows an administrator what the system is
 * actually doing, with every value present and editable, instead of a form full
 * of blanks that silently behave as something.
 */
const SETTINGS: Record<string, string> = {
  company_name: 'People Pay 360',
  company_short_name: 'PP360',
  primary_color: '#00358F',
  accent_color: '#f66600',
  default_currency: 'OMR',
  default_timezone: 'Asia/Muscat',

  organization_trend_months: '6',

  contract_expiry_alert_days: '60',
  probation_alert_days: '30',
  visa_expiry_alert_days: '30',
  default_notice_period_days: '30',
  default_annual_leave_days: '30',

  attendance_office_start: '08:00',
  attendance_office_end: '17:00',
  attendance_grace_minutes: '15',
  attendance_weekly_off_days: '5,6',
  attendance_half_day_threshold: '0.5',
  attendance_day_end: '20:00',
  attendance_geofence_default_radius_m: '150',
  face_recognition_min_quality: '0.6',

  // Leave and overtime. Written as rows rather than left to the module's own
  // in-code defaults so the settings screen shows an administrator every value
  // the overtime engine is actually using, instead of a form full of blanks
  // that silently behave as something.
  // Blank entries are skipped: an empty `overtime_sunday_late_rate` row means
  // "inherit the flat double rate", and writing it as an empty string would put
  // a blank field on the settings screen that reads as unconfigured.
  ...Object.fromEntries(
    Object.entries(OVERTIME_SETTING_DEFAULTS).filter(([, v]) => v !== ''),
  ),
};

async function seedSettings() {
  for (const [key, value] of Object.entries(SETTINGS)) {
    await prisma.systemSetting.upsert({
      where: { key },
      // Deliberately NOT overwriting a configured value on a re-run. The seed
      // establishes a starting point; it does not reset the administrator's
      // work every time the container restarts.
      update: {},
      create: { key, value },
    });
  }
  console.log(`  ✔ ${Object.keys(SETTINGS).length} system settings`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. STRUCTURE
// ─────────────────────────────────────────────────────────────────────────────

const BRANCHES = [
  {
    code: 'HQ',
    name: 'Head Office',
    city: 'Muscat',
    country: 'OM',
    addressLine: 'Building 12, Al Khuwair',
    phone: '+96824000000',
    email: 'hq@peoplepay360.com',
    crNumber: 'CR-1234567',
    timezone: 'Asia/Muscat',
    officeStartTime: '08:00',
    officeEndTime: '17:00',
    graceMinutes: 15,
    weeklyOffDays: [5, 6],
    latitude: 23.588,
    longitude: 58.3829,
    geofenceRadiusM: 150,
    geofencingEnabled: false,
  },
  {
    code: 'SOH',
    name: 'Sohar Plant',
    city: 'Sohar',
    country: 'OM',
    addressLine: 'Industrial Area, Gate 4',
    phone: '+96826000000',
    email: 'sohar@peoplepay360.com',
    crNumber: 'CR-7654321',
    timezone: 'Asia/Muscat',
    // A plant runs a longer day than the office, which is the whole reason
    // these columns are per-branch and nullable.
    officeStartTime: '07:00',
    officeEndTime: '16:00',
    graceMinutes: 10,
    weeklyOffDays: [5],
    latitude: 24.3417,
    longitude: 56.7094,
    geofenceRadiusM: 400,
    geofencingEnabled: false,
  },
];

/** Parent code → the departments nested under it. */
const DEPARTMENTS: Array<{
  code: string;
  name: string;
  description: string;
  branch: string;
  parent?: string;
}> = [
  { code: 'EXEC', name: 'Executive', description: 'Board and executive office', branch: 'HQ' },
  { code: 'ADMIN', name: 'Administration', description: 'Facilities, reception and general administration', branch: 'HQ', parent: 'EXEC' },
  { code: 'HR', name: 'Human Resources', description: 'Hiring, employee relations and payroll operations', branch: 'HQ', parent: 'EXEC' },
  { code: 'FIN', name: 'Finance', description: 'Accounting, treasury and reporting', branch: 'HQ', parent: 'EXEC' },
  { code: 'IT', name: 'Information Technology', description: 'Platforms, support and information security', branch: 'HQ', parent: 'EXEC' },
  { code: 'OPS', name: 'Operations', description: 'Production and plant operations', branch: 'SOH', parent: 'EXEC' },
  { code: 'MAINT', name: 'Maintenance', description: 'Mechanical and electrical maintenance', branch: 'SOH', parent: 'OPS' },
];

const SALARY_COMPONENTS = [
  { code: 'BASIC', name: 'Basic Salary', type: SalaryComponentType.EARNING, isGratuityBase: true, sequence: 10 },
  { code: 'HRA', name: 'Housing Allowance', type: SalaryComponentType.EARNING, isGratuityBase: false, sequence: 20 },
  { code: 'TRANSPORT', name: 'Transport Allowance', type: SalaryComponentType.EARNING, isGratuityBase: false, sequence: 30 },
  { code: 'OTHER_ALLOW', name: 'Other Allowances', type: SalaryComponentType.EARNING, isGratuityBase: false, sequence: 40 },
  { code: 'SOCIAL_SEC_EE', name: 'Social Security (Employee)', type: SalaryComponentType.DEDUCTION, isGratuityBase: false, sequence: 110 },
  { code: 'LOAN_REPAY', name: 'Loan Repayment', type: SalaryComponentType.DEDUCTION, isGratuityBase: false, sequence: 120 },
  { code: 'SOCIAL_SEC_ER', name: 'Social Security (Employer)', type: SalaryComponentType.EMPLOYER_CONTRIBUTION, isGratuityBase: false, sequence: 210 },
];

async function seedCompanyAndBranches() {
  const existing = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' } });
  const company =
    existing ??
    (await prisma.company.create({
      data: {
        name: 'People Pay 360',
        legalName: 'People Pay 360 LLC',
        timezone: 'Asia/Muscat',
        currency: 'OMR',
      },
    }));

  const branches: Record<string, string> = {};
  for (const b of BRANCHES) {
    const row = await prisma.branch.upsert({
      where: { code: b.code },
      update: { ...b, companyId: company.id },
      create: { ...b, companyId: company.id },
    });
    branches[b.code] = row.id;
  }

  console.log(`  ✔ company "${company.name}" + ${BRANCHES.length} branches`);
  return { company, branches };
}

async function seedDepartments(branches: Record<string, string>) {
  const ids: Record<string, string> = {};

  // Two passes: every row is created parentless first, then reparented. A single
  // pass would need the list to be topologically sorted by hand, and one
  // reordering later would break the seed with a foreign-key error.
  for (const d of DEPARTMENTS) {
    const row = await prisma.department.upsert({
      where: { code: d.code },
      update: { name: d.name, description: d.description, branchId: branches[d.branch] },
      create: { code: d.code, name: d.name, description: d.description, branchId: branches[d.branch] },
    });
    ids[d.code] = row.id;
  }
  for (const d of DEPARTMENTS) {
    if (!d.parent) continue;
    await prisma.department.update({
      where: { id: ids[d.code] },
      data: { parentId: ids[d.parent] },
    });
  }

  console.log(`  ✔ ${DEPARTMENTS.length} departments (nested)`);
  return ids;
}

async function seedSalaryComponents() {
  for (const c of SALARY_COMPONENTS) {
    await prisma.salaryComponent.upsert({
      where: { code: c.code },
      update: { name: c.name, type: c.type, isGratuityBase: c.isGratuityBase, sequence: c.sequence },
      create: c,
    });
  }
  console.log(`  ✔ ${SALARY_COMPONENTS.length} salary components`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. OPERATING DATA
// ─────────────────────────────────────────────────────────────────────────────

interface SeedPerson {
  code: string;
  firstName: string;
  lastName: string;
  position: string;
  department: string;
  branch: string;
  hireDate?: string;
  nationality: string;
  gender: string;
  dateOfBirth: string;
  /**
   * Days from today, used INSTEAD of `hireDate`.
   *
   * A few people have to be recent joiners — and one a future starter — or the
   * lifecycle cards on the People hub all read zero, and a reader cannot tell a
   * working card from a broken one. Relative because "this month" moves.
   */
  hireOffsetDays?: number;
  /** Days from today the fixed term ends, for a contract that should be visible
   *  in the expiry window. */
  contractEndOffsetDays?: number;
  /** Days from today probation ends. */
  probationOffsetDays?: number;
  /** Employee code of their line manager, resolved on a second pass. */
  manager?: string;
  supervisor?: string;
  salary: number;
  contractType: ContractType;
  status?: EmployeeStatus;
  /** Set to mint a sign-in account for this person. */
  account?: { email: string; role: UserRole };
}

const PEOPLE: SeedPerson[] = [
  { code: 'EMP-0001', firstName: 'Aisha', lastName: 'Al Balushi', position: 'Chief Executive Officer', department: 'EXEC', branch: 'HQ', hireDate: '2019-01-06', nationality: 'OM', gender: 'Female', dateOfBirth: '1981-04-12', salary: 4200, contractType: ContractType.PERMANENT },
  { code: 'EMP-0002', firstName: 'Khalid', lastName: 'Al Harthy', position: 'HR Director', department: 'HR', branch: 'HQ', hireDate: '2019-03-01', nationality: 'OM', gender: 'Male', dateOfBirth: '1984-09-22', manager: 'EMP-0001', salary: 2800, contractType: ContractType.PERMANENT, account: { email: 'hr@peoplepay360.com', role: UserRole.HR_MANAGER } },
  { code: 'EMP-0003', firstName: 'Maryam', lastName: 'Al Zadjali', position: 'Finance Manager', department: 'FIN', branch: 'HQ', hireDate: '2020-02-17', nationality: 'OM', gender: 'Female', dateOfBirth: '1987-11-03', manager: 'EMP-0001', salary: 2600, contractType: ContractType.PERMANENT },
  { code: 'EMP-0004', firstName: 'Rahul', lastName: 'Menon', position: 'Payroll Officer', department: 'FIN', branch: 'HQ', hireDate: '2021-06-14', nationality: 'IN', gender: 'Male', dateOfBirth: '1990-07-19', manager: 'EMP-0003', supervisor: 'EMP-0003', salary: 1200, contractType: ContractType.PERMANENT, account: { email: 'payroll@peoplepay360.com', role: UserRole.PAYROLL_OFFICER } },
  { code: 'EMP-0005', firstName: 'Fatma', lastName: 'Al Rashdi', position: 'HR Officer', department: 'HR', branch: 'HQ', hireDate: '2022-01-10', nationality: 'OM', gender: 'Female', dateOfBirth: '1994-02-28', manager: 'EMP-0002', supervisor: 'EMP-0002', salary: 950, contractType: ContractType.PERMANENT, account: { email: 'employee@peoplepay360.com', role: UserRole.EMPLOYEE } },
  { code: 'EMP-0006', firstName: 'Salim', lastName: 'Al Kindi', position: 'IT Manager', department: 'IT', branch: 'HQ', hireDate: '2020-09-01', nationality: 'OM', gender: 'Male', dateOfBirth: '1986-05-30', manager: 'EMP-0001', salary: 2400, contractType: ContractType.PERMANENT },
  { code: 'EMP-0007', firstName: 'Priya', lastName: 'Nair', position: 'Systems Engineer', department: 'IT', branch: 'HQ', hireDate: '2023-04-03', nationality: 'IN', gender: 'Female', dateOfBirth: '1995-12-08', manager: 'EMP-0006', supervisor: 'EMP-0006', salary: 1100, contractType: ContractType.FIXED_TERM, contractEndOffsetDays: 21 },
  { code: 'EMP-0008', firstName: 'Yusuf', lastName: 'Al Amri', position: 'Support Analyst', department: 'IT', branch: 'HQ', hireOffsetDays: -74, nationality: 'OM', gender: 'Male', dateOfBirth: '1998-03-16', manager: 'EMP-0006', supervisor: 'EMP-0006', salary: 780, contractType: ContractType.PROBATION, probationOffsetDays: 16 },
  { code: 'EMP-0009', firstName: 'Noora', lastName: 'Al Siyabi', position: 'Office Administrator', department: 'ADMIN', branch: 'HQ', hireDate: '2022-11-07', nationality: 'OM', gender: 'Female', dateOfBirth: '1993-06-21', manager: 'EMP-0002', salary: 720, contractType: ContractType.PERMANENT },
  { code: 'EMP-0010', firstName: 'Ahmed', lastName: 'Al Farsi', position: 'Operations Manager', department: 'OPS', branch: 'SOH', hireDate: '2019-08-12', nationality: 'OM', gender: 'Male', dateOfBirth: '1983-10-04', manager: 'EMP-0001', salary: 2700, contractType: ContractType.PERMANENT },
  { code: 'EMP-0011', firstName: 'Ravi', lastName: 'Kumar', position: 'Shift Supervisor', department: 'OPS', branch: 'SOH', hireDate: '2021-02-01', nationality: 'IN', gender: 'Male', dateOfBirth: '1989-01-25', manager: 'EMP-0010', supervisor: 'EMP-0010', salary: 980, contractType: ContractType.PERMANENT },
  { code: 'EMP-0012', firstName: 'Hassan', lastName: 'Al Hinai', position: 'Plant Operator', department: 'OPS', branch: 'SOH', hireDate: '2022-05-23', nationality: 'OM', gender: 'Male', dateOfBirth: '1996-08-11', manager: 'EMP-0011', supervisor: 'EMP-0011', salary: 640, contractType: ContractType.PERMANENT },
  { code: 'EMP-0013', firstName: 'Anil', lastName: 'Verma', position: 'Plant Operator', department: 'OPS', branch: 'SOH', hireDate: '2023-01-16', nationality: 'IN', gender: 'Male', dateOfBirth: '1997-04-09', manager: 'EMP-0011', supervisor: 'EMP-0011', salary: 620, contractType: ContractType.FIXED_TERM, contractEndOffsetDays: 52 },
  { code: 'EMP-0014', firstName: 'Said', lastName: 'Al Mahrouqi', position: 'Maintenance Lead', department: 'MAINT', branch: 'SOH', hireDate: '2020-11-30', nationality: 'OM', gender: 'Male', dateOfBirth: '1988-12-14', manager: 'EMP-0010', supervisor: 'EMP-0010', salary: 1050, contractType: ContractType.PERMANENT },
  { code: 'EMP-0015', firstName: 'Imran', lastName: 'Sheikh', position: 'Electrical Technician', department: 'MAINT', branch: 'SOH', hireDate: '2024-03-11', nationality: 'PK', gender: 'Male', dateOfBirth: '1999-09-02', manager: 'EMP-0014', supervisor: 'EMP-0014', salary: 600, contractType: ContractType.FIXED_TERM },
  { code: 'EMP-0016', firstName: 'Laila', lastName: 'Al Busaidi', position: 'Recruitment Specialist', department: 'HR', branch: 'HQ', hireOffsetDays: -11, nationality: 'OM', gender: 'Female', dateOfBirth: '1996-01-17', manager: 'EMP-0002', supervisor: 'EMP-0002', salary: 840, contractType: ContractType.PROBATION, probationOffsetDays: 79 },
  { code: 'EMP-0017', firstName: 'Omar', lastName: 'Al Lawati', position: 'Accountant', department: 'FIN', branch: 'HQ', hireDate: '2023-07-24', nationality: 'OM', gender: 'Male', dateOfBirth: '1994-05-06', manager: 'EMP-0003', supervisor: 'EMP-0003', salary: 890, contractType: ContractType.PERMANENT },
  { code: 'EMP-0018', firstName: 'Zainab', lastName: 'Al Habsi', position: 'Storekeeper', department: 'OPS', branch: 'SOH', hireDate: '2021-09-05', nationality: 'OM', gender: 'Female', dateOfBirth: '1992-02-19', manager: 'EMP-0010', salary: 610, contractType: ContractType.PERMANENT, status: EmployeeStatus.ON_LEAVE },
  { code: 'EMP-0021', firstName: 'Reem', lastName: 'Al Saadi', position: 'Financial Analyst', department: 'FIN', branch: 'HQ', hireOffsetDays: 12, nationality: 'OM', gender: 'Female', dateOfBirth: '1997-03-05', manager: 'EMP-0003', supervisor: 'EMP-0003', salary: 900, contractType: ContractType.PERMANENT },
  { code: 'EMP-0019', firstName: 'Deepak', lastName: 'Rao', position: 'Mechanical Technician', department: 'MAINT', branch: 'SOH', hireDate: '2022-03-14', nationality: 'IN', gender: 'Male', dateOfBirth: '1991-10-27', manager: 'EMP-0014', supervisor: 'EMP-0014', salary: 660, contractType: ContractType.PERMANENT },
  { code: 'EMP-0020', firstName: 'Huda', lastName: 'Al Riyami', position: 'Receptionist', department: 'ADMIN', branch: 'HQ', hireDate: '2020-06-08', nationality: 'OM', gender: 'Female', dateOfBirth: '1995-07-30', manager: 'EMP-0009', salary: 520, contractType: ContractType.PERMANENT, status: EmployeeStatus.TERMINATED },
];

/** Department code → the employee code of its head. */
const DEPARTMENT_HEADS: Record<string, string> = {
  EXEC: 'EMP-0001',
  HR: 'EMP-0002',
  FIN: 'EMP-0003',
  IT: 'EMP-0006',
  OPS: 'EMP-0010',
  MAINT: 'EMP-0014',
  // ADMIN is deliberately left headless. It is what the Organisation hub's
  // "departments with no head" card and its attention strip are for, and a
  // demo where every governance card reads zero cannot show that they work.
};

const BRANCH_MANAGERS: Record<string, string> = {
  HQ: 'EMP-0001',
  SOH: 'EMP-0010',
};

/** A person's start date, whether it was written absolutely or as an offset. */
function hireDateOf(p: SeedPerson): Date {
  return p.hireOffsetDays === undefined
    ? isoDate(p.hireDate as string)
    : daysFromToday(p.hireOffsetDays);
}

/** The zone every seeded wall clock is written in. Matches the company row. */
const COMPANY_ZONE = 'Asia/Muscat';

/**
 * An instant for a wall-clock time on a given day, in a named zone.
 *
 * `date` is a DATE column value — midnight UTC — so adding eight hours to it
 * produces 08:00 UTC, which is midday in Muscat. Every seeded punch then reads
 * four hours late on screen, and the whole workforce appears to stroll in
 * around noon. A shift starts at eight in the morning WHERE PEOPLE WORK, so the
 * wall clock has to be resolved in their zone and only then turned into an
 * instant.
 *
 * Via luxon rather than a fixed offset: Asia/Muscat happens not to observe DST,
 * but a fixed `-4` would be silently wrong the moment this seed is pointed at a
 * zone that does.
 */
function wallClockInstant(date: Date, minutesFromMidnight: number, zone: string): Date {
  return DateTime.fromISO(toDayKey(date), { zone })
    .plus({ minutes: minutesFromMidnight })
    .toJSDate();
}

/** The `YYYY-MM-DD` a DATE column value stands for, read at UTC. */
function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoDate(value: string | Date): Date {
  return typeof value === 'string' ? new Date(`${value}T00:00:00.000Z`) : value;
}

/** N days from today, at midnight UTC — the shape every DATE column wants. */
function daysFromToday(days: number): Date {
  const now = new Date();
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(utc + days * 86_400_000);
}

async function seedEmployees(
  branches: Record<string, string>,
  departments: Record<string, string>,
) {
  const ids: Record<string, string> = {};

  // Pass 1: the people, without their reporting lines. Manager and supervisor
  // both point at other employees, so nothing can be linked until every row
  // exists.
  for (const p of PEOPLE) {
    const row = await prisma.employee.upsert({
      where: { employeeCode: p.code },
      update: {
        firstName: p.firstName,
        lastName: p.lastName,
        position: p.position,
        hireDate: hireDateOf(p),
        departmentId: departments[p.department],
        branchId: branches[p.branch],
        status: p.status ?? EmployeeStatus.ACTIVE,
      },
      create: {
        employeeCode: p.code,
        firstName: p.firstName,
        lastName: p.lastName,
        workEmail: `${p.firstName}.${p.lastName}`.toLowerCase().replace(/\s+/g, '') + '@peoplepay360.com',
        phone: `+9689${String(1000000 + PEOPLE.indexOf(p)).slice(-7)}`,
        position: p.position,
        status: p.status ?? EmployeeStatus.ACTIVE,
        hireDate: hireDateOf(p),
        exitDate: p.status === EmployeeStatus.TERMINATED ? daysFromToday(-45) : null,
        dateOfBirth: isoDate(p.dateOfBirth),
        gender: p.gender,
        nationality: p.nationality,
        nationalId: `ID-${p.code.replace('EMP-', '')}`,
        departmentId: departments[p.department],
        branchId: branches[p.branch],
      },
    });
    ids[p.code] = row.id;
  }

  // Pass 2: reporting lines, department heads and branch managers.
  for (const p of PEOPLE) {
    await prisma.employee.update({
      where: { id: ids[p.code] },
      data: {
        managerId: p.manager ? ids[p.manager] : null,
        supervisorId: p.supervisor ? ids[p.supervisor] : null,
      },
    });
  }
  for (const [code, head] of Object.entries(DEPARTMENT_HEADS)) {
    await prisma.department.update({
      where: { id: departments[code] },
      data: { managerId: ids[head] },
    });
  }
  for (const [code, manager] of Object.entries(BRANCH_MANAGERS)) {
    await prisma.branch.update({
      where: { id: branches[code] },
      data: { managerId: ids[manager] },
    });
  }

  console.log(`  ✔ ${PEOPLE.length} employees, reporting lines and department heads`);
  return ids;
}

async function seedAccounts(employeeIds: Record<string, string>) {
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@peoplepay360.com').toLowerCase();
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);

  // The administrator has no employee record on purpose: they are an operator of
  // the system, not a member of the workforce, and giving them one would put
  // them in every headcount.
  await prisma.user.upsert({
    where: { email: adminEmail },
    // NOT passwordHash. See the note at the top of this file.
    update: { role: UserRole.ADMIN, isActive: true },
    create: { email: adminEmail, passwordHash, role: UserRole.ADMIN },
  });

  let minted = 1;
  for (const p of PEOPLE) {
    if (!p.account) continue;
    await prisma.user.upsert({
      where: { email: p.account.email },
      update: { role: p.account.role, isActive: true, employeeId: employeeIds[p.code] },
      create: {
        email: p.account.email,
        passwordHash,
        role: p.account.role,
        employeeId: employeeIds[p.code],
      },
    });
    minted += 1;
  }

  console.log(`  ✔ ${minted} sign-in accounts (password: ${SEED_PASSWORD})`);
  return adminEmail;
}

async function seedTeams(
  departments: Record<string, string>,
  employees: Record<string, string>,
) {
  const TEAMS = [
    { code: 'TEAM-PAYROLL', name: 'Payroll Operations', department: 'FIN', lead: 'EMP-0004', type: TeamType.PERMANENT, members: ['EMP-0004', 'EMP-0017', 'EMP-0003'] },
    { code: 'TEAM-PLATFORM', name: 'Platform Engineering', department: 'IT', lead: 'EMP-0007', type: TeamType.PERMANENT, members: ['EMP-0007', 'EMP-0008', 'EMP-0006'] },
    { code: 'TEAM-SHIFT-A', name: 'Shift A', department: 'OPS', lead: 'EMP-0011', type: TeamType.PERMANENT, members: ['EMP-0011', 'EMP-0012', 'EMP-0013'] },
    { code: 'TEAM-ONBOARD', name: 'Onboarding Programme', department: 'HR', lead: 'EMP-0005', type: TeamType.PROJECT, members: ['EMP-0005', 'EMP-0016', 'EMP-0002'] },
  ];

  for (const t of TEAMS) {
    const team = await prisma.team.upsert({
      where: { code: t.code },
      update: { name: t.name, departmentId: departments[t.department], teamLeadId: employees[t.lead], type: t.type },
      create: { code: t.code, name: t.name, departmentId: departments[t.department], teamLeadId: employees[t.lead], type: t.type },
    });

    for (const code of t.members) {
      await prisma.teamMember.upsert({
        where: { teamId_employeeId: { teamId: team.id, employeeId: employees[code] } },
        update: { isActive: true },
        create: {
          teamId: team.id,
          employeeId: employees[code],
          role: code === t.lead ? TeamMemberRole.LEAD : TeamMemberRole.MEMBER,
          // A lead splits their time; the team is not their whole week.
          allocation: code === t.lead ? 40 : 100,
        },
      });
    }
  }

  console.log(`  ✔ ${TEAMS.length} teams and their members`);
}

async function seedContracts(employees: Record<string, string>) {
  let created = 0;

  for (const p of PEOPLE) {
    const start = hireDateOf(p);
    // Keyed on the employee code alone, NOT on the start year. The year moves
    // for anyone whose hire date is expressed relative to today, and a moving
    // key makes the upsert insert a SECOND contract instead of updating the
    // first — leaving one employee holding two.
    const number = `CTR-${p.code.replace('EMP-', 'E')}`;
    const isFixed = p.contractType !== ContractType.PERMANENT;

    // Some terms land inside the expiry window and some well outside it, so the
    // People hub's "expiring soon" card has both a population and a remainder
    // to be a fraction OF. A demo where every deadline card reads zero cannot
    // show the reader that the card works.
    const index = PEOPLE.indexOf(p);
    const endDate = isFixed
      ? daysFromToday(p.contractEndOffsetDays ?? 120 + index * 23)
      : null;
    const probationEnd =
      p.contractType === ContractType.PROBATION
        ? daysFromToday(p.probationOffsetDays ?? 45 + index * 4)
        : null;

    await prisma.contract.upsert({
      where: { contractNumber: number },
      // The dates ARE refreshed on a re-run, unlike the admin password above.
      // These are demo fixtures positioned relative to today — a term seeded to
      // expire in three weeks has to still expire in three weeks when the seed
      // runs again months later, or the expiry cards quietly go empty and stop
      // demonstrating the thing they exist to show.
      update: {
        startDate: start,
        endDate,
        probationEndDate: probationEnd,
        status: p.status === EmployeeStatus.TERMINATED ? ContractStatus.TERMINATED : ContractStatus.ACTIVE,
      },
      create: {
        employeeId: employees[p.code],
        contractNumber: number,
        contractType: p.contractType,
        workType: WorkType.FULL_TIME,
        status: p.status === EmployeeStatus.TERMINATED ? ContractStatus.TERMINATED : ContractStatus.ACTIVE,
        startDate: start,
        endDate,
        probationEndDate: probationEnd,
        workHoursPerWeek: 45,
        salary: p.salary,
        currency: 'OMR',
        noticePeriodDays: 30,
        annualLeaveDays: 30,
        terms: 'Standard terms of employment apply.',
      },
    });
    created += 1;
  }

  console.log(`  ✔ ${created} contracts`);
}

async function seedLegalDocuments(employees: Record<string, string>) {
  // Only the expatriate workforce carries a residence permit — a national does
  // not need one, and issuing every employee a visa would make the expiry
  // report meaningless.
  const EXPATS = PEOPLE.filter((p) => p.nationality !== 'OM' && p.status !== EmployeeStatus.TERMINATED);
  let created = 0;
  let refreshed = 0;

  for (const p of EXPATS) {
    const index = EXPATS.indexOf(p);
    const existing = await prisma.employeeLegalDocument.findFirst({
      where: { employeeId: employees[p.code], category: LegalDocumentCategory.VISA, isCurrent: true },
    });
    if (existing) {
      // Re-position the expiry rather than skipping. Same reasoning as the
      // contracts above: a window fixed at seed time is meaningless a month
      // later, and the permit cards would report an empty runway.
      await prisma.employeeLegalDocument.update({
        where: { id: existing.id },
        data: {
          issueDate: daysFromToday(-700 + index * 30),
          expiryDate: daysFromToday(12 + index * 55),
        },
      });
      refreshed += 1;
      continue;
    }

    await prisma.employeeLegalDocument.create({
      data: {
        employeeId: employees[p.code],
        category: LegalDocumentCategory.VISA,
        documentNumber: `VISA-OM-${p.code.replace('EMP-', '')}`,
        documentType: 'Employment Residence Card',
        country: 'Oman',
        nationality: p.nationality,
        issueDate: daysFromToday(-700 + index * 30),
        // Two of these land inside the 30-day alert window and the rest outside
        // it, so the permit cards have something to say without every row being
        // an emergency.
        expiryDate: daysFromToday(12 + index * 55),
        issuingAuthority: 'Royal Oman Police',
        placeOfIssue: 'Muscat',
        sponsor: 'People Pay 360 LLC',
      },
    });
    created += 1;
  }

  console.log(`  ✔ ${created} work permits created, ${refreshed} re-dated`);
}

async function seedHolidays(branches: Record<string, string>) {
  const year = new Date().getUTCFullYear();
  const HOLIDAYS = [
    { name: "New Year's Day", date: `${year}-01-01`, branch: null },
    { name: 'Renaissance Day', date: `${year}-07-23`, branch: null },
    { name: 'National Day', date: `${year}-11-18`, branch: null },
    { name: 'National Day Holiday', date: `${year}-11-19`, branch: null },
    // A plant shutdown is one branch's non-working day and nobody else's. It is
    // the case the nullable branchId exists for.
    { name: 'Plant Shutdown', date: `${year}-08-05`, branch: 'SOH' },
  ];

  for (const h of HOLIDAYS) {
    const branchId = h.branch ? branches[h.branch] : null;
    const existing = await prisma.holiday.findFirst({
      where: { date: isoDate(h.date), branchId },
    });
    if (existing) continue;
    await prisma.holiday.create({
      data: { name: h.name, date: isoDate(h.date), year, branchId },
    });
  }

  console.log(`  ✔ ${HOLIDAYS.length} holidays`);
}

/**
 * Thirty days of attendance for everyone still employed.
 *
 * Deterministic, not random: the same seed run twice produces the same board,
 * so a screenshot in a bug report can be reproduced and an e2e assertion about
 * a rate does not go flaky overnight. The variation comes from the employee's
 * index and the day's ordinal, which is enough to give every status a
 * population without ever giving two runs different data.
 */
/** Three months, so the seeded payroll runs have a processed period behind them. */
const ATTENDANCE_DAYS_BACK = 100;

async function seedAttendance(
  employees: Record<string, string>,
  branches: Record<string, string>,
) {
  const workforce = PEOPLE.filter((p) => p.status !== EmployeeStatus.TERMINATED);
  const rows: Array<{
    employeeId: string;
    branchId: string;
    date: Date;
    checkIn: Date | null;
    checkOut: Date | null;
    status: AttendanceStatus;
    isLate: boolean;
    lateMinutes: number;
    workHours: number | null;
  }> = [];

  // Reaches back three months rather than one. Payroll runs are seeded for the
  // two previous periods, and a period with no attendance behind it is exactly
  // the case the pre-flight calls a BLOCKER — a seeded run built on one would
  // pay a full month against a month nobody recorded.
  for (let back = ATTENDANCE_DAYS_BACK; back >= 1; back -= 1) {
    const date = daysFromToday(-back);
    const weekday = date.getUTCDay(); // 0 = Sunday
    // Friday and Saturday are the weekly rest in the seeded calendar.
    const isWeekend = weekday === 5 || weekday === 6;

    for (const p of workforce) {
      const index = workforce.indexOf(p);
      const employeeId = employees[p.code];
      const branchId = branches[p.branch];

      if (isWeekend) {
        rows.push({ employeeId, branchId, date, checkIn: null, checkOut: null, status: AttendanceStatus.WEEKEND, isLate: false, lateMinutes: 0, workHours: null });
        continue;
      }
      if (p.status === EmployeeStatus.ON_LEAVE) {
        rows.push({ employeeId, branchId, date, checkIn: null, checkOut: null, status: AttendanceStatus.ON_LEAVE, isLate: false, lateMinutes: 0, workHours: null });
        continue;
      }

      const seed = (index * 7 + back * 13) % 100;
      const startHour = p.branch === 'SOH' ? 7 : 8;

      if (seed < 5) {
        rows.push({ employeeId, branchId, date, checkIn: null, checkOut: null, status: AttendanceStatus.ABSENT, isLate: false, lateMinutes: 0, workHours: null });
        continue;
      }

      const lateBy = seed < 20 ? 20 + (seed % 25) : 0;
      const checkIn = wallClockInstant(date, startHour * 60 + lateBy, COMPANY_ZONE);
      const workedMinutes = seed < 10 ? 240 : 480 + (seed % 40);
      const checkOut = new Date(checkIn.getTime() + workedMinutes * 60_000);

      rows.push({
        employeeId,
        branchId,
        date,
        checkIn,
        checkOut,
        status:
          workedMinutes < 300
            ? AttendanceStatus.HALF_DAY
            : lateBy > 15
              ? AttendanceStatus.LATE
              : AttendanceStatus.PRESENT,
        isLate: lateBy > 15,
        lateMinutes: lateBy > 15 ? lateBy : 0,
        workHours: Number((workedMinutes / 60).toFixed(2)),
      });
    }
  }

  for (const r of rows) {
    await prisma.attendance.upsert({
      where: { employeeId_date: { employeeId: r.employeeId, date: r.date } },
      update: {},
      create: {
        employeeId: r.employeeId,
        branchId: r.branchId,
        date: r.date,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        status: r.status,
        source: AttendanceSource.ESS,
        isLate: r.isLate,
        lateMinutes: r.lateMinutes,
        workHours: r.workHours,
        expectedHours: 8,
      },
    });
  }

  console.log(`  ✔ ${rows.length} attendance records over ${ATTENDANCE_DAYS_BACK} days`);
}

async function seedCorrections(employees: Record<string, string>) {
  const REQUESTS = [
    { employee: 'EMP-0008', daysBack: 4, reason: 'The office badge reader did not register my arrival; I was at my desk from 08:05.' },
    { employee: 'EMP-0012', daysBack: 6, reason: 'I was called to the plant floor before clocking in and forgot to check in afterwards.' },
    { employee: 'EMP-0016', daysBack: 2, reason: 'I left for an external interview panel and did not check out.' },
  ];

  for (const r of REQUESTS) {
    const employeeId = employees[r.employee];
    const date = daysFromToday(-r.daysBack);

    const existing = await prisma.attendanceCorrection.findFirst({
      where: { employeeId, date },
    });
    if (existing) continue;

    const attendance = await prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId, date } },
    });

    await prisma.attendanceCorrection.create({
      data: {
        employeeId,
        attendanceId: attendance?.id ?? null,
        date,
        // The snapshot is the point of the record: it keeps showing what the
        // clock said at the moment somebody disputed it.
        originalCheckIn: attendance?.checkIn ?? null,
        originalCheckOut: attendance?.checkOut ?? null,
        // 08:05 and 17:00 as the employee experiences them, not as UTC.
        requestedCheckIn: wallClockInstant(date, 8 * 60 + 5, COMPANY_ZONE),
        requestedCheckOut: wallClockInstant(date, 17 * 60, COMPANY_ZONE),
        reason: r.reason,
        status: RequestStatus.PENDING,
      },
    });
  }

  console.log(`  ✔ ${REQUESTS.length} pending attendance corrections`);
}

/** ISO weekday of a date-only value, 1 = Monday … 7 = Sunday. */
function isoWeekdayOf(date: Date): number {
  return ((date.getUTCDay() + 6) % 7) + 1;
}

/**
 * Two working weeks of roster, shaped so every panel on the Schedules hub has
 * something true to draw.
 *
 * Only people who DEVIATE from their branch calendar get a row. A row per
 * employee per day for everyone else would be headcount × 365 rows a year saying
 * nothing the branch calendar does not already say — which is also why roughly
 * half the workforce is deliberately left unrostered: "who has no shift" is the
 * number the module exists to surface, and a seed where everybody is covered
 * cannot show that the card works.
 *
 * Sohar rests Friday only (ISO 5); Head Office rests Friday and Saturday.
 */
async function seedWorkSchedules(employees: Record<string, string>) {
  /** The fortnight the demo opens on, starting today. */
  const HORIZON = 14;

  interface RosterPattern {
    code: string;
    shiftType: ShiftType;
    startTime: string | null;
    endTime: string | null;
    requiredHours: number | null;
    notes: string;
    /** ISO weekdays the pattern lands on. Empty means every day in the horizon. */
    weekdays?: number[];
  }

  const PATTERNS: RosterPattern[] = [
    // The plant's night rotation — the case the whole table exists for.
    { code: 'EMP-0012', shiftType: ShiftType.NIGHT, startTime: '20:00', endTime: '04:00', requiredHours: 8, notes: 'Night rotation' },
    { code: 'EMP-0013', shiftType: ShiftType.NIGHT, startTime: '20:00', endTime: '04:00', requiredHours: 8, notes: 'Night rotation' },
    // Maintenance covers the plant in two halves, so the shift-mix panel has
    // more than one bar and the hourly curve has a shape rather than a block.
    { code: 'EMP-0014', shiftType: ShiftType.MORNING, startTime: '06:00', endTime: '14:00', requiredHours: 8, notes: 'Maintenance early' },
    { code: 'EMP-0019', shiftType: ShiftType.AFTERNOON, startTime: '14:00', endTime: '22:00', requiredHours: 8, notes: 'Maintenance late' },
    // Four long days rather than five, which is why `weekdays` exists.
    { code: 'EMP-0015', shiftType: ShiftType.MORNING, startTime: '06:00', endTime: '16:00', requiredHours: 10, notes: 'Compressed week', weekdays: [1, 2, 3, 4] },
    // A flexible row has no window to place on an hour axis. One of them is
    // enough for the staffing curve to report what it is leaving out instead of
    // quietly under-drawing the morning.
    { code: 'EMP-0007', shiftType: ShiftType.FLEXIBLE, startTime: null, endTime: null, requiredHours: 7, notes: 'Flexible hours', weekdays: [1, 2, 3, 4, 7] },
  ];

  let created = 0;

  const upsert = async (
    code: string,
    date: Date,
    data: Omit<RosterPattern, 'code' | 'weekdays'>,
  ) => {
    const employeeId = employees[code];
    if (!employeeId) return;
    await prisma.workSchedule.upsert({
      where: { employeeId_date: { employeeId, date } },
      update: {},
      create: {
        employeeId,
        date,
        shiftType: data.shiftType,
        startTime: data.startTime,
        endTime: data.endTime,
        requiredHours: data.requiredHours,
        notes: data.notes,
      },
    });
    created += 1;
  };

  for (const pattern of PATTERNS) {
    for (let ahead = 0; ahead < HORIZON; ahead += 1) {
      const date = daysFromToday(ahead);
      if (pattern.weekdays && !pattern.weekdays.includes(isoWeekdayOf(date))) {
        continue;
      }
      await upsert(pattern.code, date, pattern);
    }
  }

  // A shift on the branch's own weekly off. Not a mistake in the seed — it is
  // the conflict the roster is perfectly happy to contain and the reason the
  // module sweeps a window rather than trusting the write path. Relative to
  // today so it is always inside the week the hub opens on.
  for (let ahead = 0; ahead < HORIZON; ahead += 1) {
    const date = daysFromToday(ahead);
    if (isoWeekdayOf(date) !== 5) continue;
    await upsert('EMP-0011', date, {
      shiftType: ShiftType.FULL_DAY,
      startTime: '07:00',
      endTime: '16:00',
      requiredHours: 9,
      notes: 'Weekend cover — rostered on the branch weekly off',
    });
    break;
  }

  // The same thing against a public holiday. The holiday calendar is fixed to
  // real dates, so this is only visible once the reader pages to it — which is
  // the honest behaviour: a conflict on a date is reported on that date.
  const upcomingHoliday = await prisma.holiday.findFirst({
    where: { date: { gte: daysFromToday(0) } },
    orderBy: { date: 'asc' },
    select: { date: true, name: true },
  });
  if (upcomingHoliday) {
    await upsert('EMP-0010', upcomingHoliday.date, {
      shiftType: ShiftType.FULL_DAY,
      startTime: '08:00',
      endTime: '13:00',
      requiredHours: 5,
      notes: `Skeleton cover on ${upcomingHoliday.name}`,
    });
  }

  console.log(`  ✔ ${created} rostered shifts`);
}

async function seedChangeRequests(
  departments: Record<string, string>,
  employees: Record<string, string>,
  adminEmail: string,
) {
  const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!admin) return;

  const existing = await prisma.departmentChangeRequest.count();
  if (existing > 0) {
    console.log('  ✔ department change requests already present');
    return;
  }

  await prisma.departmentChangeRequest.create({
    data: {
      departmentId: departments.ADMIN,
      changeType: DepartmentChangeType.MANAGER,
      // ADMIN is the headless department, so this request is the fix for the
      // gap the Organisation hub reports.
      oldManagerId: null,
      newManagerId: employees['EMP-0009'],
      reason:
        'Administration has had no department head since the last reorganisation, so nothing routed by department has an approver.',
      effectiveDate: daysFromToday(14),
      requestedById: admin.id,
      status: RequestStatus.PENDING,
    },
  });

  await prisma.departmentChangeRequest.create({
    data: {
      departmentId: departments.MAINT,
      changeType: DepartmentChangeType.PARENT,
      oldParentId: departments.OPS,
      newParentId: departments.EXEC,
      reason:
        'Maintenance is being separated from Operations so plant downtime is reported independently of production.',
      effectiveDate: daysFromToday(30),
      requestedById: admin.id,
      status: RequestStatus.PENDING,
    },
  });

  console.log('  ✔ 2 pending department change requests');
}


/**
 * One termination awaiting a decision.
 *
 * The People hub counts open terminations and the queue screen lists them; with
 * none seeded both read zero and a reviewer cannot tell a working queue from a
 * broken one. Deliberately left PENDING — the employee record stays ACTIVE,
 * which is the invariant worth being able to see.
 */
async function seedTerminationRequest(
  employees: Record<string, string>,
  adminEmail: string,
) {
  const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!admin) return;

  const existing = await prisma.terminationRequest.count();
  if (existing > 0) {
    console.log('  ✔ termination request already present');
    return;
  }

  const contract = await prisma.contract.findFirst({
    where: { employeeId: employees['EMP-0013'], status: ContractStatus.ACTIVE },
  });
  if (!contract) return;

  await prisma.terminationRequest.create({
    data: {
      contractId: contract.id,
      category: TerminationCategory.END_OF_CONTRACT,
      noticeDate: daysFromToday(-4),
      terminationDate: daysFromToday(26),
      reason:
        'The fixed term ends and the plant headcount plan for next quarter does not renew it.',
      noticeServed: true,
      requestedById: admin.id,
      status: RequestStatus.PENDING,
    },
  });

  console.log('  ✔ 1 termination awaiting approval');
}


// ─────────────────────────────────────────────────────────────────────────────
// 4. LEAVE & OVERTIME
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The pick lists leave depends on.
 *
 * Delegated to the module's own defaults file rather than restated here. Two
 * lists that are meant to agree and are written twice do not agree for long, and
 * the one that drifts is always the seed.
 */
async function seedLeaveLibraries() {
  await seedLibraryDefaults(prisma);
  const count = await prisma.libraryItem.count();
  console.log(`  ✔ ${count} library items (leave types, employment types)`);
}

/**
 * A company default policy, plus one targeted at daily-wage staff.
 *
 * The default mirrors the global settings, which is what makes the policy engine
 * a no-op until somebody writes a targeted policy. The daily-wage one exists
 * because the two rules worth demonstrating — `IGNORE` holidays and a flat
 * eligibility gate — cannot be shown with a single policy on the screen.
 */
async function seedOvertimePolicies() {
  const globalRules = {
    eligible: true,
    holidayBehavior: 'STANDARD',
    lateThreshold: '22:00',
    regularRate: 1.25,
    lateRate: 1.5,
    doubleOtEnabled: true,
    doubleRate: 2,
    doubleOtAllowAnytime: true,
    sunday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
    holiday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
    shiftEndTime: '17:00',
    dayEndBoundary: null,
    foodAllowanceEnabled: true,
    foodAllowanceAmount: 3,
    foodAllowanceThreshold: '22:00',
    doubleFoodAllowanceAnyTime: false,
    maxHoursPerDay: 4,
    maxHoursPerDoubleDay: 12,
    maxHoursPerMonth: 30,
    maxHoursPerYear: 200,
  };

  await prisma.overtimePolicy.upsert({
    where: { name: 'Company Default' },
    // Empty: the service seeds this on boot too, and overwriting it here would
    // revert an administrator's edit every time the container restarts.
    update: {},
    create: {
      name: 'Company Default',
      description:
        'Mirrors the global overtime settings. Every employee not covered by an override or an employment-type policy resolves to this.',
      isActive: true,
      isDefault: true,
      schemaVersion: 1,
      rules: globalRules,
    },
  });

  await prisma.overtimePolicy.upsert({
    where: { name: 'Daily Wage OT' },
    update: {},
    create: {
      name: 'Daily Wage OT',
      description:
        'Daily-wage staff are already paid per day worked, so a public holiday is an ordinary day rather than a premium tier.',
      isActive: true,
      isDefault: false,
      employmentType: 'Daily Wage',
      schemaVersion: 1,
      rules: {
        ...globalRules,
        holidayBehavior: 'IGNORE',
        regularRate: 1.5,
        lateRate: 1.75,
        maxHoursPerDay: 5,
      },
    },
  });

  console.log('  ✔ 2 overtime policies (Company Default, Daily Wage OT)');
}

/** Employment types, so the middle tier of the policy chain resolves for somebody. */
async function seedEmploymentTypes(employees: Record<string, string>) {
  const ASSIGNMENTS: Record<string, string> = {
    'EMP-0012': 'Daily Wage',
    'EMP-0013': 'Daily Wage',
    'EMP-0015': 'Daily Wage',
  };
  for (const [code, type] of Object.entries(ASSIGNMENTS)) {
    await prisma.employee.update({
      where: { id: employees[code] },
      data: { employmentType: type },
    });
  }
  console.log(`  ✔ ${Object.keys(ASSIGNMENTS).length} employees on Daily Wage`);
}

/**
 * A year of entitlement for everybody still employed.
 *
 * Allocations only. `used` is set by the approved leave seeded below, so the two
 * cannot disagree: the balance a screen shows is arrived at the same way the
 * application arrives at it.
 */
async function seedLeaveBalances(employees: Record<string, string>) {
  const year = new Date().getUTCFullYear();
  const types = await prisma.libraryItem.findMany({
    where: {
      libraryType: LibraryType.LEAVE_TYPE,
      isActive: true,
      affectsBalance: true,
    },
  });

  let rows = 0;
  for (const person of PEOPLE) {
    if (person.status === EmployeeStatus.TERMINATED) continue;
    const employeeId = employees[person.code];
    const gender = person.gender.toUpperCase();

    const annual = types.find((t) => t.label === 'Annual Leave');
    const sick = types.find((t) => t.label === 'Sick Leave');

    await prisma.leaveBalance.upsert({
      where: { employeeId_year: { employeeId, year } },
      update: {},
      create: {
        employeeId,
        year,
        annualLeave: annual?.defaultDays ?? 30,
        sickLeave: sick?.defaultDays ?? 30,
        // A handful of people carry days in, so the balances screen has a
        // non-zero column to draw and the "remaining" sum is not simply the
        // allocation.
        carriedOver: person.code === 'EMP-0011' ? 5 : 0,
      },
    });

    for (const type of types) {
      // A gender-restricted type is not allocated to somebody who can never take
      // it: 98 days of maternity on a male employee inflates every company total
      // with leave nobody can use.
      if (
        type.genderRestriction &&
        type.genderRestriction.toUpperCase() !== gender
      ) {
        continue;
      }
      await prisma.leaveTypeBalance.upsert({
        where: {
          employeeId_year_leaveTypeKey: {
            employeeId,
            year,
            leaveTypeKey: type.label,
          },
        },
        update: {},
        create: {
          employeeId,
          year,
          leaveTypeKey: type.label,
          allocated: type.defaultDays ?? 0,
          carriedOver:
            person.code === 'EMP-0011' && type.label === 'Annual Leave' ? 5 : 0,
        },
      });
      rows += 1;
    }
  }

  console.log(`  ✔ leave balances for ${year} (${rows} type rows)`);
}

/**
 * Leave in every state the queue can be in, including one absence happening now.
 *
 * Deliberately covers all four statuses. A demo where every request is pending
 * cannot show that the status filter works, and a hub whose donut has one slice
 * cannot show that its four slices sum to the caption above them.
 *
 * Approved rows deduct their own days and write their own ON_LEAVE attendance,
 * exactly as the approval endpoint would — a seeded approval that skipped either
 * would leave the balances screen and the attendance board contradicting the
 * leave list.
 */
async function seedLeaveRequests(
  employees: Record<string, string>,
  branches: Record<string, string>,
  adminUserId: string,
) {
  const year = new Date().getUTCFullYear();

  interface SeedLeave {
    employee: string;
    branch: string;
    leaveType: string;
    /** Days from today. Negative is past, positive is future. */
    from: number;
    to: number;
    status: RequestStatus;
    reason: string;
    note?: string;
  }

  const REQUESTS: SeedLeave[] = [
    // Happening right now, so the hub's "on leave today" card has a name in it.
    {
      employee: 'EMP-0018',
      branch: 'SOH',
      leaveType: 'Annual Leave',
      from: -2,
      to: 3,
      status: RequestStatus.APPROVED,
      reason: 'Family wedding in Salalah.',
      note: 'Approved. Storekeeping covered by Hassan.',
    },
    // Waiting on somebody. This is the row the approval walkthrough uses.
    {
      employee: 'EMP-0005',
      branch: 'HQ',
      leaveType: 'Annual Leave',
      from: 12,
      to: 16,
      status: RequestStatus.PENDING,
      reason: 'Annual holiday — flights already booked.',
    },
    {
      employee: 'EMP-0012',
      branch: 'SOH',
      leaveType: 'Sick Leave',
      from: -6,
      to: -5,
      status: RequestStatus.APPROVED,
      reason: 'Doctor signed me off for two days.',
    },
    {
      employee: 'EMP-0007',
      branch: 'HQ',
      leaveType: 'Annual Leave',
      from: 20,
      to: 27,
      status: RequestStatus.PENDING,
      reason: 'Visiting family overseas.',
    },
    {
      employee: 'EMP-0013',
      branch: 'SOH',
      leaveType: 'Annual Leave',
      from: 5,
      to: 9,
      status: RequestStatus.REJECTED,
      reason: 'Two weeks off over the shutdown.',
      note: 'Two operators are already off that week. Please re-file for the following one.',
    },
    {
      employee: 'EMP-0009',
      branch: 'HQ',
      leaveType: 'Unpaid Leave',
      from: 30,
      to: 32,
      status: RequestStatus.CANCELLED,
      reason: 'Personal matter — no longer needed.',
    },
    {
      employee: 'EMP-0016',
      branch: 'HQ',
      leaveType: 'Bereavement Leave',
      from: -14,
      to: -12,
      status: RequestStatus.APPROVED,
      reason: 'Family bereavement.',
    },
  ];

  let created = 0;
  for (const r of REQUESTS) {
    const employeeId = employees[r.employee];
    const startDate = daysFromToday(r.from);
    const endDate = daysFromToday(r.to);

    const existing = await prisma.leaveRequest.findFirst({
      where: { employeeId, startDate },
    });
    if (existing) continue;

    const workingDates = workingDatesFor(
      startDate,
      endDate,
      r.branch,
      await holidayKeys(),
    );
    // A request whose every day is already a rest day would be refused by the
    // application, so the seed must not create one either.
    if (workingDates.length === 0) continue;

    const decided = r.status !== RequestStatus.PENDING;
    await prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveType: r.leaveType,
        startDate,
        endDate,
        totalDays: workingDates.length,
        reason: r.reason,
        status: r.status,
        approverId: decided ? adminUserId : null,
        approvedAt: decided ? daysFromToday(r.from - 2) : null,
        rejectedReason: r.note ?? null,
      },
    });
    created += 1;

    if (r.status !== RequestStatus.APPROVED) continue;

    // Spend the balance, exactly as approving it would.
    const type = await prisma.libraryItem.findFirst({
      where: { libraryType: LibraryType.LEAVE_TYPE, label: r.leaveType },
    });
    if (type?.affectsBalance) {
      const balance = await prisma.leaveTypeBalance.findUnique({
        where: {
          employeeId_year_leaveTypeKey: {
            employeeId,
            year,
            leaveTypeKey: r.leaveType,
          },
        },
      });
      if (balance) {
        await prisma.leaveTypeBalance.update({
          where: { id: balance.id },
          data: { used: balance.used + workingDates.length },
        });
      }
      if (r.leaveType === 'Annual Leave' || r.leaveType === 'Sick Leave') {
        const headline = await prisma.leaveBalance.findUnique({
          where: { employeeId_year: { employeeId, year } },
        });
        if (headline) {
          await prisma.leaveBalance.update({
            where: { id: headline.id },
            data:
              r.leaveType === 'Annual Leave'
                ? { usedAnnual: headline.usedAnnual + workingDates.length }
                : { usedSick: headline.usedSick + workingDates.length },
          });
        }
      }
    }

    // And write the attendance. `skipDuplicates` because the attendance seed has
    // already filled the last thirty days: a day somebody actually clocked keeps
    // its own record, which is the same rule the approval endpoint follows.
    await prisma.attendance.createMany({
      data: workingDates.map((date) => ({
        employeeId,
        date,
        branchId: branches[r.branch],
        status: AttendanceStatus.ON_LEAVE,
        source: AttendanceSource.SYSTEM,
        workHours: 0,
        notes: `Approved ${r.leaveType}`,
      })),
      skipDuplicates: true,
    });
  }

  console.log(`  ✔ ${created} leave requests (approved, pending, rejected, cancelled)`);
}

/**
 * Overtime across the tiers that pay it.
 *
 * Every window starts after 17:00, because overtime that begins inside the
 * working day would be refused by the application — a seed that creates rows the
 * app would reject is a seed that hides a broken rule.
 *
 * The split figures are the ones the engine produces for a 22:00 late threshold:
 * a 17:30–23:00 shift is 4.5h regular plus 1h late, not 5.5h at one rate.
 */
async function seedOvertimeRequests(
  employees: Record<string, string>,
  adminUserId: string,
) {
  interface SeedOvertime {
    employee: string;
    daysBack: number;
    startHour: number;
    startMinute: number;
    endHour: number;
    status: RequestStatus;
    reason: string;
  }

  const REQUESTS: SeedOvertime[] = [
    { employee: 'EMP-0011', daysBack: 3, startHour: 17, startMinute: 30, endHour: 23, status: RequestStatus.APPROVED, reason: 'Line 3 changeover ran past the shift.' },
    { employee: 'EMP-0012', daysBack: 4, startHour: 18, startMinute: 0, endHour: 21, status: RequestStatus.APPROVED, reason: 'Covered a late delivery inspection.' },
    { employee: 'EMP-0014', daysBack: 2, startHour: 17, startMinute: 30, endHour: 20, status: RequestStatus.PENDING, reason: 'Pump seal replacement could not wait until morning.' },
    { employee: 'EMP-0015', daysBack: 1, startHour: 19, startMinute: 0, endHour: 23, status: RequestStatus.PENDING, reason: 'Switchgear fault on the night line.' },
    { employee: 'EMP-0007', daysBack: 6, startHour: 18, startMinute: 0, endHour: 22, status: RequestStatus.APPROVED, reason: 'Production database migration window.' },
    { employee: 'EMP-0019', daysBack: 8, startHour: 17, startMinute: 30, endHour: 19, status: RequestStatus.REJECTED, reason: 'Stayed to finish paperwork.' },
  ];

  let created = 0;
  for (const r of REQUESTS) {
    const employeeId = employees[r.employee];
    const date = daysFromToday(-r.daysBack);

    const existing = await prisma.overtimeRequest.findUnique({
      where: { employeeId_date: { employeeId, date } },
    });
    if (existing) continue;

    // Wall clock tagged UTC, which is how the engine reads these back.
    const startTime = new Date(
      date.getTime() + r.startHour * 3_600_000 + r.startMinute * 60_000,
    );
    const endTime = new Date(date.getTime() + r.endHour * 3_600_000);
    const totalHours =
      (endTime.getTime() - startTime.getTime()) / 3_600_000;

    // The 22:00 split, computed the same way the engine computes it.
    const lateBoundary = new Date(date.getTime() + 22 * 3_600_000);
    const regularHours =
      Math.max(
        0,
        Math.min(endTime.getTime(), lateBoundary.getTime()) -
          startTime.getTime(),
      ) / 3_600_000;
    const lateHours = totalHours - regularHours;
    const decided = r.status !== RequestStatus.PENDING;

    await prisma.overtimeRequest.create({
      data: {
        employeeId,
        date,
        startTime,
        endTime,
        hours: round2(totalHours),
        regularHours: round2(regularHours),
        lateHours: round2(lateHours),
        dayType: OvertimeDayType.WEEKDAY,
        otType: lateHours > 0 ? OvertimeType.LATE : OvertimeType.REGULAR,
        // Granted only when the window actually ran past the food threshold,
        // which is the rule the engine applies.
        foodAllowance: lateHours > 0 ? 3 : 0,
        reason: r.reason,
        status: r.status,
        approverId: decided ? adminUserId : null,
        approvedAt: decided ? new Date(date.getTime() + 26 * 3_600_000) : null,
        rejectedReason:
          r.status === RequestStatus.REJECTED
            ? 'Paperwork is part of the working day, not overtime.'
            : null,
      },
    });
    created += 1;
  }

  console.log(`  ✔ ${created} overtime requests across the tiers`);
}

// ── Seed-local calendar helpers ─────────────────────────────────────────────
//
// The application answers these through WorkingDaysService, which needs a Nest
// container. The seed reproduces the same two rules — the branch weekly rest and
// the holiday table — so the days it writes match the days the app would price.

/** Head Office rests Friday and Saturday; Sohar rests Friday only. */
const SEED_WEEKLY_OFF: Record<string, number[]> = { HQ: [5, 6], SOH: [5] };

let holidayKeyCache: Set<string> | null = null;

async function holidayKeys(): Promise<Set<string>> {
  if (holidayKeyCache) return holidayKeyCache;
  const rows = await prisma.holiday.findMany({ select: { date: true } });
  holidayKeyCache = new Set(rows.map((h) => h.date.toISOString().slice(0, 10)));
  return holidayKeyCache;
}

function workingDatesFor(
  start: Date,
  end: Date,
  branchCode: string,
  holidays: Set<string>,
): Date[] {
  const off = SEED_WEEKLY_OFF[branchCode] ?? [5, 6];
  const dates: Date[] = [];
  for (
    let cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    const key = cursor.toISOString().slice(0, 10);
    if (!off.includes(isoWeekdayOf(cursor)) && !holidays.has(key)) {
      dates.push(new Date(cursor));
    }
  }
  return dates;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The administrator's user id, which is who seeded decisions are attributed to.
 *
 * A decided request with a null approver reads as "decided by nobody", and the
 * detail screen has a blank where the reviewer's name belongs.
 */
async function adminUserIdFor(adminEmail: string): Promise<string> {
  const admin = await prisma.user.findUnique({
    where: { email: adminEmail },
    select: { id: true },
  });
  if (!admin) throw new Error(`Seed could not find the admin account ${adminEmail}`);
  return admin.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. PAYROLL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The employee left deliberately without a salary structure.
 *
 * The pre-flight and the hub's attention strip both exist to name somebody the
 * run cannot safely pay, and a demo where every card reads zero cannot show the
 * reader that the card works. EMP-0021 is the newest hire, which is also the
 * realistic case — a structure nobody has got round to creating yet.
 */
const EMPLOYEE_WITHOUT_STRUCTURE = 'EMP-0021';

/**
 * How a contract salary is split into structure lines.
 *
 * The percentages are how the seed DERIVES the amounts, once, at seed time.
 * They are not a runtime rule: every `SalaryStructureLine.amount` is an
 * absolute figure, which is what the calculator reads and what HRM's live
 * engine does too.
 */
const STRUCTURE_SPLIT: Array<{
  code: string;
  /** Share of the contract salary, or of BASIC where `ofBasic` is set. */
  share: number;
  ofBasic?: boolean;
}> = [
  { code: 'BASIC', share: 0.6 },
  { code: 'HRA', share: 0.25 },
  { code: 'TRANSPORT', share: 0.1 },
  { code: 'OTHER_ALLOW', share: 0.05 },
  { code: 'SOCIAL_SEC_EE', share: 0.07, ofBasic: true },
  { code: 'SOCIAL_SEC_ER', share: 0.105, ofBasic: true },
];

const money = (value: number) => Math.round(value * 1000) / 1000;

async function seedSalaryStructures(employees: Record<string, string>) {
  const components = await prisma.salaryComponent.findMany({
    where: { code: { in: STRUCTURE_SPLIT.map((l) => l.code) } },
    select: { id: true, code: true, type: true, sequence: true },
  });
  const byCode = new Map(components.map((c) => [c.code, c]));

  const workforce = PEOPLE.filter(
    (p) => p.status !== EmployeeStatus.TERMINATED && p.code !== EMPLOYEE_WITHOUT_STRUCTURE,
  );
  let created = 0;

  for (const p of workforce) {
    const employeeId = employees[p.code];
    const basic = money(p.salary * 0.6);
    const lines = STRUCTURE_SPLIT.map((line) => {
      const component = byCode.get(line.code);
      if (!component) return null;
      return {
        componentId: component.id,
        amount: money((line.ofBasic ? basic : p.salary) * line.share),
      };
    }).filter((l): l is { componentId: string; amount: number } => l !== null);

    // Upserted on the employee, the natural unique key: SalaryStructure.employeeId
    // is @unique, so a re-run updates the one structure rather than inserting a
    // second the constraint would then refuse.
    const structure = await prisma.salaryStructure.upsert({
      where: { employeeId },
      update: { currency: 'OMR', effectiveFrom: hireDateOf(p) },
      create: { employeeId, currency: 'OMR', effectiveFrom: hireDateOf(p) },
    });

    // The whole line set is replaced, exactly as PATCH does, so a changed split
    // in this file does not leave a stale line behind.
    await prisma.salaryStructureLine.deleteMany({
      where: { structureId: structure.id },
    });
    await prisma.salaryStructureLine.createMany({
      data: lines.map((l) => ({ structureId: structure.id, ...l })),
    });
    created += 1;
  }

  console.log(
    `  ✔ ${created} salary structures (${EMPLOYEE_WITHOUT_STRUCTURE} left without one on purpose)`,
  );
}

/** The first day of the month `back` months before this one, in UTC. */
function monthStart(back: number): { month: number; year: number } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

/**
 * Three runs, so every screen has a population: one PAID, one APPROVED and one
 * CALCULATED still waiting for a decision.
 *
 * The amounts come from the REAL calculator, run against the seeded attendance
 * and the seeded structures. Hand-written figures here would drift from what
 * the app computes the first time the calculator changed, and the demo would
 * start disagreeing with the thing it is demonstrating.
 */
async function seedPayrollRuns(employees: Record<string, string>) {
  const RUNS = [
    { back: 2, status: PayrollRunStatus.PAID },
    { back: 1, status: PayrollRunStatus.APPROVED },
    { back: 0, status: PayrollRunStatus.CALCULATED },
  ];

  const structures = await prisma.salaryStructure.findMany({
    include: { lines: { include: { component: true } } },
  });
  const structureByEmployee = new Map(structures.map((s) => [s.employeeId, s]));

  // The seeded calendar rests on Friday and Saturday, matching seedAttendance.
  const isWorkingDay = (dayKey: string) => {
    const weekday = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
    return weekday !== 5 && weekday !== 6;
  };

  let runCount = 0;
  let slipCount = 0;

  for (const spec of RUNS) {
    const { month, year } = monthStart(spec.back);
    const period = periodFor(month, year);
    const from = new Date(`${period.periodStart}T00:00:00.000Z`);
    const to = new Date(`${period.periodEnd}T00:00:00.000Z`);
    const workingDays = eachDayKey(period.periodStart, period.periodEnd).filter(
      isWorkingDay,
    );

    const attendance = await prisma.attendance.findMany({
      where: { date: { gte: from, lte: to } },
      select: { employeeId: true, date: true, status: true },
    });
    const byEmployee = new Map<string, Array<{ dayKey: string; status: AttendanceStatus }>>();
    for (const row of attendance) {
      const key = row.date.toISOString().slice(0, 10);
      const bucket = byEmployee.get(row.employeeId) ?? [];
      bucket.push({ dayKey: key, status: row.status });
      byEmployee.set(row.employeeId, bucket);
    }

    const run = await prisma.payrollRun.upsert({
      where: { periodStart_periodEnd: { periodStart: from, periodEnd: to } },
      update: { status: spec.status },
      create: {
        periodStart: from,
        periodEnd: to,
        status: spec.status,
        currency: 'OMR',
      },
    });

    const payslips: Array<{
      employeeId: string;
      result: ReturnType<typeof calculatePayslip>;
    }> = [];

    for (const p of PEOPLE) {
      if (p.status === EmployeeStatus.TERMINATED) continue;
      const employeeId = employees[p.code];
      const structure = structureByEmployee.get(employeeId);
      if (!structure) continue;

      const lines = structure.lines.map((l) => ({
        code: l.component.code,
        label: l.component.name,
        type: l.component.type as 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION',
        amount: Number(l.amount),
        sequence: l.component.sequence,
        componentId: l.component.id,
      }));
      if (!isPayable(lines)) continue;

      const { workDays, paidDays } = resolvePaidDays(
        workingDays,
        byEmployee.get(employeeId) ?? [],
      );
      payslips.push({
        employeeId,
        result: calculatePayslip({ lines, workDays, paidDays }),
      });
    }

    const sequenceBase = `PS-${period.periodStart.slice(0, 7)}`;
    for (const [index, slip] of payslips.entries()) {
      const payslipNumber = `${sequenceBase}-${String(index + 1).padStart(4, '0')}`;
      const row = await prisma.payslip.upsert({
        where: {
          payrollRunId_employeeId: { payrollRunId: run.id, employeeId: slip.employeeId },
        },
        update: {
          payslipNumber,
          workDays: slip.result.workDays,
          paidDays: slip.result.paidDays,
          lopDays: slip.result.lopDays,
          grossPay: slip.result.grossPay,
          totalDeductions: slip.result.totalDeductions,
          netPay: slip.result.netPay,
          totalEmployerCost: slip.result.totalEmployerCost,
        },
        create: {
          payrollRunId: run.id,
          employeeId: slip.employeeId,
          payslipNumber,
          workDays: slip.result.workDays,
          paidDays: slip.result.paidDays,
          lopDays: slip.result.lopDays,
          grossPay: slip.result.grossPay,
          totalDeductions: slip.result.totalDeductions,
          netPay: slip.result.netPay,
          totalEmployerCost: slip.result.totalEmployerCost,
        },
      });

      // The lines are replaced rather than upserted one by one: a payslip's
      // lines are one snapshot, and a half-updated set would not sum to the
      // totals beside it.
      await prisma.payslipLine.deleteMany({ where: { payslipId: row.id } });
      await prisma.payslipLine.createMany({
        data: slip.result.lines.map((l) => ({
          payslipId: row.id,
          componentId: l.componentId,
          code: l.code,
          label: l.label,
          type: l.type as SalaryComponentType,
          amount: l.amount,
          sequence: l.sequence,
        })),
      });
      slipCount += 1;
    }

    const totalGross = money(payslips.reduce((a, p) => a + p.result.grossPay, 0));
    const totalNet = money(payslips.reduce((a, p) => a + p.result.netPay, 0));

    await prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        totalGross,
        totalNet,
        employeeCount: payslips.length,
        calculatedAt: daysFromToday(-(spec.back * 30 + 1)),
        approvedAt:
          spec.status === PayrollRunStatus.APPROVED || spec.status === PayrollRunStatus.PAID
            ? daysFromToday(-(spec.back * 30))
            : null,
        paidAt: spec.status === PayrollRunStatus.PAID ? daysFromToday(-(spec.back * 30 - 2)) : null,
      },
    });
    runCount += 1;
  }

  console.log(`  ✔ ${runCount} payroll runs, ${slipCount} payslips (real calculator)`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Seeding People Pay 360...');

  await seedSettings();
  const { branches } = await seedCompanyAndBranches();
  const departments = await seedDepartments(branches);
  await seedSalaryComponents();

  const employees = await seedEmployees(branches, departments);
  const adminEmail = await seedAccounts(employees);

  await seedTeams(departments, employees);
  await seedContracts(employees);
  await seedTerminationRequest(employees, adminEmail);
  await seedLegalDocuments(employees);

  await seedHolidays(branches);
  await seedWorkSchedules(employees);
  await seedAttendance(employees, branches);
  await seedCorrections(employees);
  await seedChangeRequests(departments, employees, adminEmail);

  await seedLeaveLibraries();
  await seedOvertimePolicies();
  await seedEmploymentTypes(employees);
  await seedLeaveBalances(employees);
  const adminUserId = await adminUserIdFor(adminEmail);
  await seedLeaveRequests(employees, branches, adminUserId);
  await seedOvertimeRequests(employees, adminUserId);

  // A structure follows a contract, and a run follows both.
  await seedSalaryStructures(employees);
  await seedPayrollRuns(employees);

  console.log('✅ Seed complete.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
