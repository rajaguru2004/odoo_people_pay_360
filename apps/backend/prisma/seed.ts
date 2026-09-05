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
  ApprovalMode,
  ApprovalRequestType,
  ApproverType,
  AssetStatus,
  AttendanceSource,
  AttendanceStatus,
  ContractStatus,
  ContractType,
  DepartmentChangeType,
  EmployeeStatus,
  LegalDocumentCategory,
  LibraryType,
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
import { DateTime } from 'luxon';
import { seedLibraryDefaults } from '../src/library-items/library-defaults';
import { LETTER_TEMPLATE_DEFAULTS } from '../src/letters/letter-defaults';

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
  face_recognition_match_threshold: '0.6',
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
  {
    code: 'EXEC',
    name: 'Executive',
    description: 'Board and executive office',
    branch: 'HQ',
  },
  {
    code: 'ADMIN',
    name: 'Administration',
    description: 'Facilities, reception and general administration',
    branch: 'HQ',
    parent: 'EXEC',
  },
  {
    code: 'HR',
    name: 'Human Resources',
    description: 'Hiring, employee relations and payroll operations',
    branch: 'HQ',
    parent: 'EXEC',
  },
  {
    code: 'FIN',
    name: 'Finance',
    description: 'Accounting, treasury and reporting',
    branch: 'HQ',
    parent: 'EXEC',
  },
  {
    code: 'IT',
    name: 'Information Technology',
    description: 'Platforms, support and information security',
    branch: 'HQ',
    parent: 'EXEC',
  },
  {
    code: 'OPS',
    name: 'Operations',
    description: 'Production and plant operations',
    branch: 'SOH',
    parent: 'EXEC',
  },
  {
    code: 'MAINT',
    name: 'Maintenance',
    description: 'Mechanical and electrical maintenance',
    branch: 'SOH',
    parent: 'OPS',
  },
];

const SALARY_COMPONENTS = [
  {
    code: 'BASIC',
    name: 'Basic Salary',
    type: SalaryComponentType.EARNING,
    isGratuityBase: true,
    sequence: 10,
  },
  {
    code: 'HRA',
    name: 'Housing Allowance',
    type: SalaryComponentType.EARNING,
    isGratuityBase: false,
    sequence: 20,
  },
  {
    code: 'TRANSPORT',
    name: 'Transport Allowance',
    type: SalaryComponentType.EARNING,
    isGratuityBase: false,
    sequence: 30,
  },
  {
    code: 'OTHER_ALLOW',
    name: 'Other Allowances',
    type: SalaryComponentType.EARNING,
    isGratuityBase: false,
    sequence: 40,
  },
  {
    code: 'SOCIAL_SEC_EE',
    name: 'Social Security (Employee)',
    type: SalaryComponentType.DEDUCTION,
    isGratuityBase: false,
    sequence: 110,
  },
  {
    code: 'LOAN_REPAY',
    name: 'Loan Repayment',
    type: SalaryComponentType.DEDUCTION,
    isGratuityBase: false,
    sequence: 120,
  },
  {
    code: 'SOCIAL_SEC_ER',
    name: 'Social Security (Employer)',
    type: SalaryComponentType.EMPLOYER_CONTRIBUTION,
    isGratuityBase: false,
    sequence: 210,
  },
];

async function seedCompanyAndBranches() {
  const existing = await prisma.company.findFirst({
    orderBy: { createdAt: 'asc' },
  });
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
      update: {
        name: d.name,
        description: d.description,
        branchId: branches[d.branch],
      },
      create: {
        code: d.code,
        name: d.name,
        description: d.description,
        branchId: branches[d.branch],
      },
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
      update: {
        name: c.name,
        type: c.type,
        isGratuityBase: c.isGratuityBase,
        sequence: c.sequence,
      },
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
  /**
   * An EMPLOYMENT_TYPE library label. It is the MIDDLE tier of the overtime
   * policy chain, so leaving it unset is not "no overtime" — it falls through
   * to the company default.
   */
  employmentType?: string;
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
  {
    code: 'EMP-0001',
    firstName: 'Aisha',
    lastName: 'Al Balushi',
    position: 'Chief Executive Officer',
    department: 'EXEC',
    branch: 'HQ',
    hireDate: '2019-01-06',
    nationality: 'OM',
    gender: 'Female',
    dateOfBirth: '1981-04-12',
    salary: 4200,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0002',
    firstName: 'Khalid',
    lastName: 'Al Harthy',
    position: 'HR Director',
    department: 'HR',
    branch: 'HQ',
    hireDate: '2019-03-01',
    nationality: 'OM',
    gender: 'Male',
    dateOfBirth: '1984-09-22',
    manager: 'EMP-0001',
    salary: 2800,
    contractType: ContractType.PERMANENT,
    account: { email: 'hr@peoplepay360.com', role: UserRole.HR_MANAGER },
  },
  {
    code: 'EMP-0003',
    firstName: 'Maryam',
    lastName: 'Al Zadjali',
    position: 'Finance Manager',
    department: 'FIN',
    branch: 'HQ',
    hireDate: '2020-02-17',
    nationality: 'OM',
    gender: 'Female',
    dateOfBirth: '1987-11-03',
    manager: 'EMP-0001',
    salary: 2600,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0004',
    firstName: 'Rahul',
    lastName: 'Menon',
    position: 'Payroll Officer',
    department: 'FIN',
    branch: 'HQ',
    hireDate: '2021-06-14',
    nationality: 'IN',
    gender: 'Male',
    dateOfBirth: '1990-07-19',
    manager: 'EMP-0003',
    supervisor: 'EMP-0003',
    salary: 1200,
    contractType: ContractType.PERMANENT,
    account: {
      email: 'payroll@peoplepay360.com',
      role: UserRole.PAYROLL_OFFICER,
    },
  },
  {
    code: 'EMP-0005',
    firstName: 'Fatma',
    lastName: 'Al Rashdi',
    position: 'HR Officer',
    department: 'HR',
    branch: 'HQ',
    hireDate: '2022-01-10',
    nationality: 'OM',
    gender: 'Female',
    dateOfBirth: '1994-02-28',
    manager: 'EMP-0002',
    supervisor: 'EMP-0002',
    salary: 950,
    contractType: ContractType.PERMANENT,
    account: { email: 'employee@peoplepay360.com', role: UserRole.EMPLOYEE },
  },
  {
    code: 'EMP-0006',
    firstName: 'Salim',
    lastName: 'Al Kindi',
    position: 'IT Manager',
    department: 'IT',
    branch: 'HQ',
    hireDate: '2020-09-01',
    nationality: 'OM',
    gender: 'Male',
    dateOfBirth: '1986-05-30',
    manager: 'EMP-0001',
    salary: 2400,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0007',
    firstName: 'Priya',
    lastName: 'Nair',
    position: 'Systems Engineer',
    department: 'IT',
    branch: 'HQ',
    hireDate: '2023-04-03',
    nationality: 'IN',
    gender: 'Female',
    dateOfBirth: '1995-12-08',
    manager: 'EMP-0006',
    supervisor: 'EMP-0006',
    salary: 1100,
    contractType: ContractType.FIXED_TERM,
    contractEndOffsetDays: 21,
  },
  {
    code: 'EMP-0008',
    firstName: 'Yusuf',
    lastName: 'Al Amri',
    position: 'Support Analyst',
    department: 'IT',
    branch: 'HQ',
    hireOffsetDays: -74,
    nationality: 'OM',
    gender: 'Male',
    dateOfBirth: '1998-03-16',
    manager: 'EMP-0006',
    supervisor: 'EMP-0006',
    salary: 780,
    contractType: ContractType.PROBATION,
    probationOffsetDays: 16,
  },
  {
    code: 'EMP-0009',
    firstName: 'Noora',
    lastName: 'Al Siyabi',
    position: 'Office Administrator',
    department: 'ADMIN',
    branch: 'HQ',
    hireDate: '2022-11-07',
    nationality: 'OM',
    gender: 'Female',
    dateOfBirth: '1993-06-21',
    manager: 'EMP-0002',
    salary: 720,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0010',
    firstName: 'Ahmed',
    lastName: 'Al Farsi',
    position: 'Operations Manager',
    department: 'OPS',
    branch: 'SOH',
    hireDate: '2019-08-12',
    nationality: 'OM',
    gender: 'Male',
    dateOfBirth: '1983-10-04',
    manager: 'EMP-0001',
    salary: 2700,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0011',
    firstName: 'Ravi',
    lastName: 'Kumar',
    position: 'Shift Supervisor',
    department: 'OPS',
    branch: 'SOH',
    hireDate: '2021-02-01',
    nationality: 'IN',
    gender: 'Male',
    dateOfBirth: '1989-01-25',
    manager: 'EMP-0010',
    supervisor: 'EMP-0010',
    salary: 980,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0012',
    firstName: 'Hassan',
    lastName: 'Al Hinai',
    position: 'Plant Operator',
    department: 'OPS',
    branch: 'SOH',
    hireDate: '2022-05-23',
    nationality: 'OM',
    gender: 'Male',
    dateOfBirth: '1996-08-11',
    manager: 'EMP-0011',
    supervisor: 'EMP-0011',
    employmentType: 'Daily Wage',
    salary: 640,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0013',
    firstName: 'Anil',
    lastName: 'Verma',
    position: 'Plant Operator',
    department: 'OPS',
    branch: 'SOH',
    hireDate: '2023-01-16',
    nationality: 'IN',
    gender: 'Male',
    dateOfBirth: '1997-04-09',
    manager: 'EMP-0011',
    supervisor: 'EMP-0011',
    employmentType: 'Daily Wage',
    salary: 620,
    contractType: ContractType.FIXED_TERM,
    contractEndOffsetDays: 52,
  },
  {
    code: 'EMP-0014',
    firstName: 'Said',
    lastName: 'Al Mahrouqi',
    position: 'Maintenance Lead',
    department: 'MAINT',
    branch: 'SOH',
    hireDate: '2020-11-30',
    nationality: 'OM',
    gender: 'Male',
    dateOfBirth: '1988-12-14',
    manager: 'EMP-0010',
    supervisor: 'EMP-0010',
    salary: 1050,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0015',
    firstName: 'Imran',
    lastName: 'Sheikh',
    position: 'Electrical Technician',
    department: 'MAINT',
    branch: 'SOH',
    hireDate: '2024-03-11',
    nationality: 'PK',
    gender: 'Male',
    dateOfBirth: '1999-09-02',
    manager: 'EMP-0014',
    supervisor: 'EMP-0014',
    salary: 600,
    contractType: ContractType.FIXED_TERM,
  },
  {
    code: 'EMP-0016',
    firstName: 'Laila',
    lastName: 'Al Busaidi',
    position: 'Recruitment Specialist',
    department: 'HR',
    branch: 'HQ',
    hireOffsetDays: -11,
    nationality: 'OM',
    gender: 'Female',
    dateOfBirth: '1996-01-17',
    manager: 'EMP-0002',
    supervisor: 'EMP-0002',
    salary: 840,
    contractType: ContractType.PROBATION,
    probationOffsetDays: 79,
  },
  {
    code: 'EMP-0017',
    firstName: 'Omar',
    lastName: 'Al Lawati',
    position: 'Accountant',
    department: 'FIN',
    branch: 'HQ',
    hireDate: '2023-07-24',
    nationality: 'OM',
    gender: 'Male',
    dateOfBirth: '1994-05-06',
    manager: 'EMP-0003',
    supervisor: 'EMP-0003',
    salary: 890,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0018',
    firstName: 'Zainab',
    lastName: 'Al Habsi',
    position: 'Storekeeper',
    department: 'OPS',
    branch: 'SOH',
    hireDate: '2021-09-05',
    nationality: 'OM',
    gender: 'Female',
    dateOfBirth: '1992-02-19',
    manager: 'EMP-0010',
    salary: 610,
    contractType: ContractType.PERMANENT,
    status: EmployeeStatus.ON_LEAVE,
  },
  {
    code: 'EMP-0021',
    firstName: 'Reem',
    lastName: 'Al Saadi',
    position: 'Financial Analyst',
    department: 'FIN',
    branch: 'HQ',
    hireOffsetDays: 12,
    nationality: 'OM',
    gender: 'Female',
    dateOfBirth: '1997-03-05',
    manager: 'EMP-0003',
    supervisor: 'EMP-0003',
    salary: 900,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0019',
    firstName: 'Deepak',
    lastName: 'Rao',
    position: 'Mechanical Technician',
    department: 'MAINT',
    branch: 'SOH',
    hireDate: '2022-03-14',
    nationality: 'IN',
    gender: 'Male',
    dateOfBirth: '1991-10-27',
    manager: 'EMP-0014',
    supervisor: 'EMP-0014',
    salary: 660,
    contractType: ContractType.PERMANENT,
  },
  {
    code: 'EMP-0020',
    firstName: 'Huda',
    lastName: 'Al Riyami',
    position: 'Receptionist',
    department: 'ADMIN',
    branch: 'HQ',
    hireDate: '2020-06-08',
    nationality: 'OM',
    gender: 'Female',
    dateOfBirth: '1995-07-30',
    manager: 'EMP-0009',
    salary: 520,
    contractType: ContractType.PERMANENT,
    status: EmployeeStatus.TERMINATED,
  },
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
function wallClockInstant(
  date: Date,
  minutesFromMidnight: number,
  zone: string,
): Date {
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
  const utc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
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
        workEmail:
          `${p.firstName}.${p.lastName}`.toLowerCase().replace(/\s+/g, '') +
          '@peoplepay360.com',
        phone: `+9689${String(1000000 + PEOPLE.indexOf(p)).slice(-7)}`,
        position: p.position,
        status: p.status ?? EmployeeStatus.ACTIVE,
        hireDate: hireDateOf(p),
        exitDate:
          p.status === EmployeeStatus.TERMINATED ? daysFromToday(-45) : null,
        dateOfBirth: isoDate(p.dateOfBirth),
        gender: p.gender,
        nationality: p.nationality,
        nationalId: `ID-${p.code.replace('EMP-', '')}`,
        departmentId: departments[p.department],
        branchId: branches[p.branch],
        employmentType: p.employmentType ?? null,
      },
    });
    ids[p.code] = row.id;
  }

  // Deliberately NOT in the `update` branch above: employment type decides
  // which overtime policy governs someone's pay, and this seed runs on every
  // container start. Filling it only where it is still unset leaves an
  // administrator's choice alone, while a database bootstrapped before the
  // column existed still ends up with a value.
  for (const p of PEOPLE) {
    if (!p.employmentType) continue;
    await prisma.employee.updateMany({
      where: { employeeCode: p.code, employmentType: null },
      data: { employmentType: p.employmentType },
    });
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

  console.log(
    `  ✔ ${PEOPLE.length} employees, reporting lines and department heads`,
  );
  return ids;
}

async function seedAccounts(employeeIds: Record<string, string>) {
  const adminEmail = (
    process.env.SEED_ADMIN_EMAIL || 'admin@peoplepay360.com'
  ).toLowerCase();
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
      update: {
        role: p.account.role,
        isActive: true,
        employeeId: employeeIds[p.code],
      },
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
    {
      code: 'TEAM-PAYROLL',
      name: 'Payroll Operations',
      department: 'FIN',
      lead: 'EMP-0004',
      type: TeamType.PERMANENT,
      members: ['EMP-0004', 'EMP-0017', 'EMP-0003'],
    },
    {
      code: 'TEAM-PLATFORM',
      name: 'Platform Engineering',
      department: 'IT',
      lead: 'EMP-0007',
      type: TeamType.PERMANENT,
      members: ['EMP-0007', 'EMP-0008', 'EMP-0006'],
    },
    {
      code: 'TEAM-SHIFT-A',
      name: 'Shift A',
      department: 'OPS',
      lead: 'EMP-0011',
      type: TeamType.PERMANENT,
      members: ['EMP-0011', 'EMP-0012', 'EMP-0013'],
    },
    {
      code: 'TEAM-ONBOARD',
      name: 'Onboarding Programme',
      department: 'HR',
      lead: 'EMP-0005',
      type: TeamType.PROJECT,
      members: ['EMP-0005', 'EMP-0016', 'EMP-0002'],
    },
  ];

  for (const t of TEAMS) {
    const team = await prisma.team.upsert({
      where: { code: t.code },
      update: {
        name: t.name,
        departmentId: departments[t.department],
        teamLeadId: employees[t.lead],
        type: t.type,
      },
      create: {
        code: t.code,
        name: t.name,
        departmentId: departments[t.department],
        teamLeadId: employees[t.lead],
        type: t.type,
      },
    });

    for (const code of t.members) {
      await prisma.teamMember.upsert({
        where: {
          teamId_employeeId: { teamId: team.id, employeeId: employees[code] },
        },
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
        status:
          p.status === EmployeeStatus.TERMINATED
            ? ContractStatus.TERMINATED
            : ContractStatus.ACTIVE,
      },
      create: {
        employeeId: employees[p.code],
        contractNumber: number,
        contractType: p.contractType,
        workType: WorkType.FULL_TIME,
        status:
          p.status === EmployeeStatus.TERMINATED
            ? ContractStatus.TERMINATED
            : ContractStatus.ACTIVE,
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
  const EXPATS = PEOPLE.filter(
    (p) => p.nationality !== 'OM' && p.status !== EmployeeStatus.TERMINATED,
  );
  let created = 0;
  let refreshed = 0;

  for (const p of EXPATS) {
    const index = EXPATS.indexOf(p);
    const existing = await prisma.employeeLegalDocument.findFirst({
      where: {
        employeeId: employees[p.code],
        category: LegalDocumentCategory.VISA,
        isCurrent: true,
      },
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
async function seedAttendance(
  employees: Record<string, string>,
  branches: Record<string, string>,
) {
  const workforce = PEOPLE.filter(
    (p) => p.status !== EmployeeStatus.TERMINATED,
  );
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

  for (let back = 30; back >= 1; back -= 1) {
    const date = daysFromToday(-back);
    const weekday = date.getUTCDay(); // 0 = Sunday
    // Friday and Saturday are the weekly rest in the seeded calendar.
    const isWeekend = weekday === 5 || weekday === 6;

    for (const p of workforce) {
      const index = workforce.indexOf(p);
      const employeeId = employees[p.code];
      const branchId = branches[p.branch];

      if (isWeekend) {
        rows.push({
          employeeId,
          branchId,
          date,
          checkIn: null,
          checkOut: null,
          status: AttendanceStatus.WEEKEND,
          isLate: false,
          lateMinutes: 0,
          workHours: null,
        });
        continue;
      }
      if (p.status === EmployeeStatus.ON_LEAVE) {
        rows.push({
          employeeId,
          branchId,
          date,
          checkIn: null,
          checkOut: null,
          status: AttendanceStatus.ON_LEAVE,
          isLate: false,
          lateMinutes: 0,
          workHours: null,
        });
        continue;
      }

      const seed = (index * 7 + back * 13) % 100;
      const startHour = p.branch === 'SOH' ? 7 : 8;

      if (seed < 5) {
        rows.push({
          employeeId,
          branchId,
          date,
          checkIn: null,
          checkOut: null,
          status: AttendanceStatus.ABSENT,
          isLate: false,
          lateMinutes: 0,
          workHours: null,
        });
        continue;
      }

      const lateBy = seed < 20 ? 20 + (seed % 25) : 0;
      const checkIn = wallClockInstant(
        date,
        startHour * 60 + lateBy,
        COMPANY_ZONE,
      );
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

  console.log(`  ✔ ${rows.length} attendance records over 30 days`);
}

async function seedCorrections(employees: Record<string, string>) {
  const REQUESTS = [
    {
      employee: 'EMP-0008',
      daysBack: 4,
      reason:
        'The office badge reader did not register my arrival; I was at my desk from 08:05.',
    },
    {
      employee: 'EMP-0012',
      daysBack: 6,
      reason:
        'I was called to the plant floor before clocking in and forgot to check in afterwards.',
    },
    {
      employee: 'EMP-0016',
      daysBack: 2,
      reason: 'I left for an external interview panel and did not check out.',
    },
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
    {
      code: 'EMP-0012',
      shiftType: ShiftType.NIGHT,
      startTime: '20:00',
      endTime: '04:00',
      requiredHours: 8,
      notes: 'Night rotation',
    },
    {
      code: 'EMP-0013',
      shiftType: ShiftType.NIGHT,
      startTime: '20:00',
      endTime: '04:00',
      requiredHours: 8,
      notes: 'Night rotation',
    },
    // Maintenance covers the plant in two halves, so the shift-mix panel has
    // more than one bar and the hourly curve has a shape rather than a block.
    {
      code: 'EMP-0014',
      shiftType: ShiftType.MORNING,
      startTime: '06:00',
      endTime: '14:00',
      requiredHours: 8,
      notes: 'Maintenance early',
    },
    {
      code: 'EMP-0019',
      shiftType: ShiftType.AFTERNOON,
      startTime: '14:00',
      endTime: '22:00',
      requiredHours: 8,
      notes: 'Maintenance late',
    },
    // Four long days rather than five, which is why `weekdays` exists.
    {
      code: 'EMP-0015',
      shiftType: ShiftType.MORNING,
      startTime: '06:00',
      endTime: '16:00',
      requiredHours: 10,
      notes: 'Compressed week',
      weekdays: [1, 2, 3, 4],
    },
    // A flexible row has no window to place on an hour axis. One of them is
    // enough for the staffing curve to report what it is leaving out instead of
    // quietly under-drawing the morning.
    {
      code: 'EMP-0007',
      shiftType: ShiftType.FLEXIBLE,
      startTime: null,
      endTime: null,
      requiredHours: 7,
      notes: 'Flexible hours',
      weekdays: [1, 2, 3, 4, 7],
    },
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
// 4. PAY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a contracted salary is split across components.
 *
 * Fractions of the whole rather than absolute figures, so one table works for a
 * plant operator on 620 and a chief executive on 4,200. BASIC carries most of
 * it because it is the gratuity and social-insurance base — a structure that
 * hides the bulk of pay in allowances is the classic way to understate both,
 * and a demo that showed it would be teaching the wrong shape.
 */
const STRUCTURE_SPLIT: Array<{ code: string; share: number }> = [
  { code: 'BASIC', share: 0.6 },
  { code: 'HRA', share: 0.25 },
  { code: 'TRANSPORT', share: 0.1 },
  // Takes the rounding remainder, so the lines always sum to the contract.
  { code: 'OTHER_ALLOW', share: 0.05 },
];

/** Oman's social-insurance split, applied to BASIC. */
const SOCIAL_SECURITY_EMPLOYEE_RATE = 0.07;
const SOCIAL_SECURITY_EMPLOYER_RATE = 0.115;

/** Money is thousandths here — see the Decimal(18, 3) columns. */
function money(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The first day of the month N months before the current one, at midnight UTC. */
function monthStart(monthsAgo: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1),
  );
}

/** The last day of the month a period starts in. */
function monthEnd(start: Date): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
}

/**
 * The earning and deduction lines one person's pay is made of.
 *
 * Shared by the salary structure and by every payslip, so a payslip always adds
 * up to the structure behind it. A demo where the two disagree is a demo of a
 * bug.
 */
function payLinesFor(salary: number) {
  const earnings = STRUCTURE_SPLIT.map(({ code, share }, index) => {
    const isLast = index === STRUCTURE_SPLIT.length - 1;
    const amount = isLast
      ? money(
          salary -
            STRUCTURE_SPLIT.slice(0, -1).reduce(
              (sum, part) => sum + money(salary * part.share),
              0,
            ),
        )
      : money(salary * share);
    return { code, amount };
  });

  const basic = earnings.find((line) => line.code === 'BASIC')?.amount ?? 0;

  return {
    earnings,
    deductions: [
      {
        code: 'SOCIAL_SEC_EE',
        amount: money(basic * SOCIAL_SECURITY_EMPLOYEE_RATE),
      },
    ],
    employerContributions: [
      {
        code: 'SOCIAL_SEC_ER',
        amount: money(basic * SOCIAL_SECURITY_EMPLOYER_RATE),
      },
    ],
  };
}

async function seedSalaryStructures(employees: Record<string, string>) {
  const components = await prisma.salaryComponent.findMany({
    select: { id: true, code: true },
  });
  const componentId = Object.fromEntries(components.map((c) => [c.code, c.id]));

  let written = 0;
  for (const p of PEOPLE) {
    // Somebody who has left keeps their historical payslips and stops having a
    // standing structure: there is no future pay to define.
    if (p.status === EmployeeStatus.TERMINATED) continue;

    const employeeId = employees[p.code];
    const lines = payLinesFor(p.salary);
    const all = [
      ...lines.earnings,
      ...lines.deductions,
      ...lines.employerContributions,
    ];

    const structure = await prisma.salaryStructure.upsert({
      where: { employeeId },
      update: { currency: 'OMR', effectiveFrom: hireDateOf(p) },
      create: { employeeId, currency: 'OMR', effectiveFrom: hireDateOf(p) },
      select: { id: true },
    });

    for (const line of all) {
      await prisma.salaryStructureLine.upsert({
        where: {
          structureId_componentId: {
            structureId: structure.id,
            componentId: componentId[line.code],
          },
        },
        update: { amount: line.amount },
        create: {
          structureId: structure.id,
          componentId: componentId[line.code],
          amount: line.amount,
        },
      });
    }
    written += 1;
  }

  console.log(`  ✔ ${written} salary structures`);
}

/**
 * Three months of payroll, one of them still open.
 *
 * The statuses are the point. The oldest run is PAID, so it counts toward
 * year-to-date earnings; the middle one is APPROVED, so it is a payslip an
 * employee can open but money that has not moved yet; and the current month is
 * DRAFT, so it must not appear on a self-service screen at all. A seed where
 * every run had the same status would let a broken visibility rule pass
 * unnoticed.
 */
const PAYROLL_PERIODS: Array<{ monthsAgo: number; status: PayrollRunStatus }> =
  [
    { monthsAgo: 2, status: PayrollRunStatus.PAID },
    { monthsAgo: 1, status: PayrollRunStatus.APPROVED },
    { monthsAgo: 0, status: PayrollRunStatus.DRAFT },
  ];

async function seedPayrollRuns(employees: Record<string, string>) {
  const components = await prisma.salaryComponent.findMany({
    select: { id: true, code: true, name: true, type: true, sequence: true },
  });
  const byCode = Object.fromEntries(components.map((c) => [c.code, c]));

  let runs = 0;
  let payslips = 0;

  for (const period of PAYROLL_PERIODS) {
    const periodStart = monthStart(period.monthsAgo);
    const periodEnd = monthEnd(periodStart);

    // Whoever was on the books by the end of the period. Somebody hired
    // afterwards has nothing to be paid for, and a payslip for a month they had
    // not started would be a figure nobody could explain.
    const paid = PEOPLE.filter(
      (p) =>
        p.status !== EmployeeStatus.TERMINATED &&
        hireDateOf(p).getTime() <= periodEnd.getTime(),
    );

    const totals = paid.reduce(
      (acc, p) => {
        const lines = payLinesFor(p.salary);
        const gross = lines.earnings.reduce((sum, l) => sum + l.amount, 0);
        const deductions = lines.deductions.reduce(
          (sum, l) => sum + l.amount,
          0,
        );
        acc.gross += gross;
        acc.net += gross - deductions;
        return acc;
      },
      { gross: 0, net: 0 },
    );

    const run = await prisma.payrollRun.upsert({
      where: { periodStart_periodEnd: { periodStart, periodEnd } },
      update: {
        status: period.status,
        totalGross: money(totals.gross),
        totalNet: money(totals.net),
        approvedAt: period.status === PayrollRunStatus.DRAFT ? null : periodEnd,
      },
      create: {
        periodStart,
        periodEnd,
        status: period.status,
        currency: 'OMR',
        totalGross: money(totals.gross),
        totalNet: money(totals.net),
        approvedAt: period.status === PayrollRunStatus.DRAFT ? null : periodEnd,
      },
      select: { id: true },
    });
    runs += 1;

    for (const p of paid) {
      const lines = payLinesFor(p.salary);
      const gross = money(lines.earnings.reduce((sum, l) => sum + l.amount, 0));
      const deductions = money(
        lines.deductions.reduce((sum, l) => sum + l.amount, 0),
      );

      const payslip = await prisma.payslip.upsert({
        where: {
          payrollRunId_employeeId: {
            payrollRunId: run.id,
            employeeId: employees[p.code],
          },
        },
        update: {
          grossPay: gross,
          totalDeductions: deductions,
          netPay: money(gross - deductions),
        },
        create: {
          payrollRunId: run.id,
          employeeId: employees[p.code],
          grossPay: gross,
          totalDeductions: deductions,
          netPay: money(gross - deductions),
        },
        select: { id: true },
      });

      // A payslip line has no natural unique column to upsert on — its identity
      // is "the third line of this payslip", which is a position rather than a
      // key. Replacing the set wholesale is what keeps a re-run idempotent
      // instead of appending a second copy of every line.
      await prisma.payslipLine.deleteMany({ where: { payslipId: payslip.id } });
      await prisma.payslipLine.createMany({
        data: [
          ...lines.earnings,
          ...lines.deductions,
          ...lines.employerContributions,
        ].map((line) => ({
          payslipId: payslip.id,
          componentId: byCode[line.code].id,
          // Denormalised on purpose — see the note on PayslipLine.label. A
          // payslip has to keep reading correctly after a component is renamed.
          label: byCode[line.code].name,
          type: byCode[line.code].type,
          amount: line.amount,
          sequence: byCode[line.code].sequence,
        })),
      });
      payslips += 1;
    }
  }

  console.log(`  ✔ ${runs} payroll runs, ${payslips} payslips with lines`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. EMPLOYEE SELF-SERVICE — LEAVE, OVERTIME AND THE APPROVAL CHAINS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The chains that govern each request type.
 *
 * Two steps rather than one, because a single step cannot show the thing the
 * engine exists for: a request that has been approved once and is still not
 * finished. `supervisor_approval_enabled` is written alongside them — the
 * engine reads that switch before it looks for a workflow at all, so seeding
 * chains without it produces a configuration that appears set up and governs
 * nothing.
 */
const APPROVAL_CHAINS: Array<{
  requestType: ApprovalRequestType;
  name: string;
  steps: ApproverType[];
}> = [
  {
    requestType: ApprovalRequestType.LEAVE,
    name: 'Leave — supervisor then HR',
    steps: [ApproverType.SUPERVISOR, ApproverType.HR_MANAGER],
  },
  {
    requestType: ApprovalRequestType.OVERTIME,
    name: 'Overtime — supervisor then HR',
    steps: [ApproverType.SUPERVISOR, ApproverType.HR_MANAGER],
  },
  {
    requestType: ApprovalRequestType.TRAINING,
    name: 'Training — department head then HR',
    steps: [ApproverType.MANAGER, ApproverType.HR_MANAGER],
  },
];

async function seedApprovalWorkflows() {
  await prisma.systemSetting.upsert({
    where: { key: 'supervisor_approval_enabled' },
    update: {},
    create: { key: 'supervisor_approval_enabled', value: 'true' },
  });

  for (const chain of APPROVAL_CHAINS) {
    const existing = await prisma.approvalWorkflow.findFirst({
      where: { requestType: chain.requestType, isActive: true },
    });
    if (existing) continue;

    await prisma.approvalWorkflow.create({
      data: {
        requestType: chain.requestType,
        name: chain.name,
        mode: ApprovalMode.SEQUENTIAL,
        isActive: true,
        steps: {
          create: chain.steps.map((approverType, index) => ({
            stepOrder: index + 1,
            approverType,
          })),
        },
      },
    });
  }

  console.log(`  ✔ ${APPROVAL_CHAINS.length} approval workflows`);
}

/**
 * Materialise the trail for one seeded request, by the same rules the engine
 * applies at runtime.
 *
 * A step whose approver cannot be resolved to a sign-in account is SKIPPED
 * rather than left ACTIVE: an ACTIVE row nobody can act on is a request stuck
 * for ever, and the seeded workforce deliberately has only a few accounts.
 * The supervisor step also SNAPSHOTS whoever it resolved to, which is the whole
 * point of the column — the person who owed the decision when it opened keeps
 * owing it after a reporting line moves.
 */
async function materialiseApprovalTrail(
  requestType: ApprovalRequestType,
  requestId: string,
  requesterEmployeeId: string,
) {
  const workflow = await prisma.approvalWorkflow.findFirst({
    where: { requestType, isActive: true },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });
  if (!workflow) return;

  const requester = await prisma.employee.findUnique({
    where: { id: requesterEmployeeId },
    select: {
      user: { select: { id: true } },
      supervisor: { select: { user: { select: { id: true } } } },
      department: {
        select: { manager: { select: { user: { select: { id: true } } } } },
      },
    },
  });
  const requesterUserId = requester?.user?.id ?? null;

  const approversFor = async (
    approverType: ApproverType,
  ): Promise<string[]> => {
    if (approverType === ApproverType.SUPERVISOR) {
      const id = requester?.supervisor?.user?.id;
      return id ? [id] : [];
    }
    if (approverType === ApproverType.MANAGER) {
      const id = requester?.department?.manager?.user?.id;
      return id ? [id] : [];
    }
    const users = await prisma.user.findMany({
      where: { role: approverType, isActive: true },
      select: { id: true },
    });
    return users.map((u) => u.id);
  };

  let opened = false;
  for (const step of workflow.steps) {
    const approvers = (await approversFor(step.approverType)).filter(
      (id) => id !== requesterUserId,
    );

    if (approvers.length === 0) {
      await prisma.requestApproval.create({
        data: {
          requestType,
          requestId,
          stepOrder: step.stepOrder,
          approverType: step.approverType,
          status: 'SKIPPED',
          decidedAt: new Date(),
          comment: 'Auto-skipped: no eligible approver, or self-approval',
        },
      });
      continue;
    }

    await prisma.requestApproval.create({
      data: {
        requestType,
        requestId,
        stepOrder: step.stepOrder,
        approverType: step.approverType,
        status: opened ? 'PENDING' : 'ACTIVE',
        resolvedApproverId:
          !opened && step.approverType === ApproverType.SUPERVISOR
            ? approvers[0]
            : null,
      },
    });
    opened = true;
  }
}

/** The leave year the seeded balances and requests belong to. */
function seedLeaveYear(): number {
  return new Date().getUTCFullYear();
}

/**
 * A balance row per employee per active leave type, for the current year.
 *
 * The two statutory columns and the per-type buckets are written together and
 * kept in step: a payslip reads `usedAnnual` while the balances screen reads
 * the Annual Leave bucket, and a seed where those disagree looks like a bug in
 * whichever one the reader happens to open.
 */
async function seedLeaveBalances(employees: Record<string, string>) {
  const year = seedLeaveYear();
  const leaveTypes = await prisma.libraryItem.findMany({
    where: {
      libraryType: LibraryType.LEAVE_TYPE,
      isActive: true,
      affectsBalance: true,
    },
  });

  let created = 0;
  for (const person of PEOPLE) {
    const employeeId = employees[person.code];
    if (!employeeId) continue;

    const annual = leaveTypes.find((t) => t.label === 'Annual Leave');
    const sick = leaveTypes.find((t) => t.label === 'Sick Leave');

    await prisma.leaveBalance.upsert({
      where: { employeeId_year: { employeeId, year } },
      update: {},
      create: {
        employeeId,
        year,
        annualLeave: annual?.defaultDays ?? 12,
        sickLeave: sick?.defaultDays ?? 30,
        // A little carry-over on the longer-serving staff, so the "remaining"
        // column is not simply "allocated" everywhere and the arithmetic is
        // visibly doing something.
        carriedOver: person.hireDate && person.hireDate < '2021-01-01' ? 4 : 0,
      },
    });

    const gender = (person.gender || '').toUpperCase();
    for (const type of leaveTypes) {
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
        },
      });
    }
    created += 1;
  }

  console.log(`  ✔ ${created} leave balances for ${year}`);
}

/**
 * Accrual history for the year so far.
 *
 * Written period by period rather than as one lump, because that is what the
 * table means and what the screens read: a reader asking "where did thirty days
 * come from" gets twelve answers, not one. The allocation is left exactly as
 * `seedLeaveBalances` set it — the history explains the entitlement rather than
 * adding to it, so seeding both a full allocation and its accrual would show
 * every employee twice the leave they have.
 */
async function seedLeaveAccrualHistory(employees: Record<string, string>) {
  const year = seedLeaveYear();
  const annual = await prisma.libraryItem.findFirst({
    where: {
      libraryType: LibraryType.LEAVE_TYPE,
      label: 'Annual Leave',
      isActive: true,
    },
    select: { defaultDays: true },
  });
  const perPeriod =
    Math.round((((annual?.defaultDays ?? 12) / 12) + Number.EPSILON) * 100) / 100;

  // Every month up to and including the current one, in the company clock.
  const monthsSoFar = DateTime.now().setZone(COMPANY_ZONE).month;

  let created = 0;
  for (const person of PEOPLE) {
    const employeeId = employees[person.code];
    if (!employeeId) continue;

    for (let month = 1; month <= monthsSoFar; month += 1) {
      const periodStart = new Date(
        `${year}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`,
      );
      // An employee only accrues from the month they started.
      if (periodStart < hireDateOf(person)) continue;

      const existing = await prisma.leaveAccrualHistory.findUnique({
        where: {
          employeeId_periodStart_leaveTypeKey: {
            employeeId,
            periodStart,
            leaveTypeKey: 'Annual Leave',
          },
        },
      });
      if (existing) continue;

      await prisma.leaveAccrualHistory.create({
        data: {
          employeeId,
          periodStart,
          leaveTypeKey: 'Annual Leave',
          days: perPeriod,
          year,
          note: `Monthly accrual for ${year}-${String(month).padStart(2, '0')}`,
        },
      });
      created += 1;
    }
  }

  console.log(`  ✔ ${created} leave accrual periods for ${year}`);
}

/**
 * A few requests across every status.
 *
 * All four are represented deliberately: a list filtered to PENDING and a list
 * filtered to CANCELLED must be visibly different, and a screen that only ever
 * sees one status cannot show that its filter works. The PENDING ones get a
 * live approval trail so the approver's inbox has something in it.
 */
const LEAVE_REQUESTS: Array<{
  employee: string;
  leaveType: string;
  startOffsetDays: number;
  days: number;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  rejectedReason?: string;
}> = [
  {
    employee: 'EMP-0005',
    leaveType: 'Annual Leave',
    startOffsetDays: 21,
    days: 3,
    reason: 'Family wedding in Nizwa.',
    status: 'PENDING',
  },
  {
    employee: 'EMP-0011',
    leaveType: 'Annual Leave',
    startOffsetDays: 14,
    days: 5,
    reason: 'Annual holiday with the family.',
    status: 'PENDING',
  },
  {
    employee: 'EMP-0012',
    leaveType: 'Sick Leave',
    startOffsetDays: -12,
    days: 2,
    reason: 'Flu, with a medical certificate to follow.',
    status: 'APPROVED',
  },
  {
    employee: 'EMP-0017',
    leaveType: 'Annual Leave',
    startOffsetDays: -30,
    days: 4,
    reason: 'Trip home.',
    status: 'APPROVED',
  },
  {
    employee: 'EMP-0016',
    leaveType: 'Annual Leave',
    startOffsetDays: 4,
    days: 6,
    reason: 'Personal travel.',
    status: 'REJECTED',
    rejectedReason:
      'Still inside the probation period; please re-apply after confirmation.',
  },
  {
    employee: 'EMP-0007',
    leaveType: 'Annual Leave',
    startOffsetDays: 40,
    days: 2,
    reason: 'Long weekend.',
    status: 'CANCELLED',
  },
];

async function seedLeaveRequests(employees: Record<string, string>) {
  const year = seedLeaveYear();
  const hrUser = await prisma.user.findFirst({
    where: { role: UserRole.HR_MANAGER, isActive: true },
    select: { id: true },
  });

  let created = 0;
  for (const request of LEAVE_REQUESTS) {
    const employeeId = employees[request.employee];
    if (!employeeId) continue;

    const startDate = daysFromToday(request.startOffsetDays);
    const endDate = daysFromToday(request.startOffsetDays + request.days - 1);

    const existing = await prisma.leaveRequest.findFirst({
      where: { employeeId, startDate },
    });
    if (existing) continue;

    const decided =
      request.status === 'APPROVED' || request.status === 'REJECTED';
    const row = await prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveType: request.leaveType,
        startDate,
        endDate,
        totalDays: request.days,
        reason: request.reason,
        status: request.status,
        approverId: decided ? (hrUser?.id ?? null) : null,
        approvedAt: decided ? daysFromToday(request.startOffsetDays - 2) : null,
        rejectedReason: request.rejectedReason ?? null,
      },
    });

    if (request.status === 'PENDING') {
      await materialiseApprovalTrail(
        ApprovalRequestType.LEAVE,
        row.id,
        employeeId,
      );
    }

    // An approved request has been PAID FOR. Leaving the balance untouched
    // would show a year of approved leave against a full entitlement, which is
    // the one thing the balances screen exists to contradict.
    if (request.status === 'APPROVED') {
      await prisma.leaveTypeBalance.updateMany({
        where: { employeeId, year, leaveTypeKey: request.leaveType },
        data: { used: { increment: request.days } },
      });
      await prisma.leaveBalance.updateMany({
        where: { employeeId, year },
        data:
          request.leaveType === 'Sick Leave'
            ? { usedSick: { increment: request.days } }
            : { usedAnnual: { increment: request.days } },
      });
    }

    created += 1;
  }

  console.log(`  ✔ ${created} leave requests across four statuses`);
}

/**
 * The company-wide overtime rate card.
 *
 * Marked `isDefault` and scoped to no employment type, so it is the bottom of
 * the resolution chain: an employee with no override and an employment type
 * nothing is written for still resolves to a complete, valid policy rather than
 * to nothing.
 */
const DEFAULT_OVERTIME_POLICY_NAME = 'Company default';

const DEFAULT_OVERTIME_RULES = {
  eligible: true,
  holidayBehavior: 'STANDARD',
  lateThreshold: '22:00',
  regularRate: 1.5,
  lateRate: 1.5,
  doubleOtEnabled: true,
  doubleRate: 2,
  doubleOtAllowAnytime: true,
  sunday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  holiday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  shiftEndTime: '17:00',
  dayEndBoundary: null,
  foodAllowanceEnabled: true,
  foodAllowanceAmount: 1.5,
  foodAllowanceThreshold: '20:00',
  doubleFoodAllowanceAnyTime: false,
  maxHoursPerDay: 4,
  maxHoursPerDoubleDay: 12,
  maxHoursPerMonth: 30,
  maxHoursPerYear: 200,
};

/**
 * The middle tier of the chain, so it is exercised and not merely configurable.
 *
 * Daily-wage staff are paid overtime on a different multiplier from salaried
 * ones, which is the whole reason the tier exists. Its rates are deliberately
 * UNLIKE the company default's: if every tier produced the same number, a
 * resolver that silently fell through to the default would look correct.
 */
const DAILY_WAGE_OVERTIME_POLICY_NAME = 'Daily wage';

const DAILY_WAGE_OVERTIME_RULES = {
  ...DEFAULT_OVERTIME_RULES,
  regularRate: 1.25,
  lateRate: 1.75,
  doubleRate: 2.5,
  sunday: { regularRate: 2.5, lateRate: 2.5, lateThreshold: '22:00' },
  holiday: { regularRate: 2.5, lateRate: 2.5, lateThreshold: '22:00' },
  foodAllowanceAmount: 2,
  maxHoursPerDay: 6,
};

async function seedOvertimePolicy(): Promise<string | null> {
  const policy = await prisma.overtimePolicy.upsert({
    where: { name: DEFAULT_OVERTIME_POLICY_NAME },
    // Empty on purpose: the rate card is what an administrator tunes, and the
    // seed runs on every container start.
    update: {},
    create: {
      name: DEFAULT_OVERTIME_POLICY_NAME,
      description:
        'Applies to anyone with no employee override and no employment-type policy.',
      isActive: true,
      isDefault: true,
      employmentType: null,
      schemaVersion: 1,
      rules: DEFAULT_OVERTIME_RULES,
    },
  });

  await prisma.overtimePolicy.upsert({
    where: { name: DAILY_WAGE_OVERTIME_POLICY_NAME },
    update: {},
    create: {
      name: DAILY_WAGE_OVERTIME_POLICY_NAME,
      description:
        'Governs anyone whose employment type is Daily Wage, unless they carry an override of their own.',
      isActive: true,
      isDefault: false,
      // The label, matched against the employee's own employment type. It is
      // what puts this policy above the company default in the chain.
      employmentType: 'Daily Wage',
      schemaVersion: 1,
      rules: DAILY_WAGE_OVERTIME_RULES,
    },
  });

  console.log('  ✔ 2 overtime policies (company default + daily wage)');
  return policy.id;
}

/**
 * A pending and an approved overtime request.
 *
 * Start and end are written as wall clock tagged UTC, which is how the column
 * is read back: an entered 17:00 must come out of the database as 17:00 for
 * every reader, whatever zone the server happens to run in.
 */
const OVERTIME_REQUESTS: Array<{
  employee: string;
  dayOffset: number;
  startHour: number;
  endHour: number;
  reason: string;
  status: 'PENDING' | 'APPROVED';
}> = [
  {
    employee: 'EMP-0012',
    dayOffset: -3,
    startHour: 17,
    endHour: 20,
    reason: 'Covering the evening shift while the line was recommissioned.',
    status: 'PENDING',
  },
  {
    employee: 'EMP-0015',
    dayOffset: -9,
    startHour: 17,
    endHour: 19,
    reason: 'Emergency repair to the compressor.',
    status: 'APPROVED',
  },
];

async function seedOvertimeRequests(
  employees: Record<string, string>,
  policyId: string | null,
) {
  const hrUser = await prisma.user.findFirst({
    where: { role: UserRole.HR_MANAGER, isActive: true },
    select: { id: true },
  });

  let created = 0;
  for (const request of OVERTIME_REQUESTS) {
    const employeeId = employees[request.employee];
    if (!employeeId) continue;

    const date = daysFromToday(request.dayOffset);
    const existing = await prisma.overtimeRequest.findFirst({
      where: { employeeId, date },
    });
    if (existing) continue;

    const dayKey = toDayKey(date);
    const hours = request.endHour - request.startHour;
    const approved = request.status === 'APPROVED';

    const row = await prisma.overtimeRequest.create({
      data: {
        employeeId,
        date,
        startTime: new Date(
          `${dayKey}T${String(request.startHour).padStart(2, '0')}:00:00.000Z`,
        ),
        endTime: new Date(
          `${dayKey}T${String(request.endHour).padStart(2, '0')}:00:00.000Z`,
        ),
        hours,
        // The whole window sits before the 22:00 late threshold, so it is all
        // paid at the weekday regular tier.
        regularHours: hours,
        lateHours: 0,
        doubleHours: 0,
        dayType: 'WEEKDAY',
        otType: 'REGULAR',
        reason: request.reason,
        status: request.status,
        approverId: approved ? (hrUser?.id ?? null) : null,
        approvedAt: approved ? daysFromToday(request.dayOffset + 1) : null,
        // The policy that classified these hours is snapshotted on approval, so
        // pay is calculated against the rules that were in force at the time
        // rather than against whatever the rate card says today.
        overtimePolicyId: approved ? policyId : null,
      },
    });

    if (request.status === 'PENDING') {
      await materialiseApprovalTrail(
        ApprovalRequestType.OVERTIME,
        row.id,
        employeeId,
      );
    }

    created += 1;
  }

  console.log(`  ✔ ${created} overtime requests`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. EMPLOYEE SELF-SERVICE — MY RECORDS AND MY TEAM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The asset register.
 *
 * One row is deliberately left OUT and unreturned. An open assignment is what
 * blocks an offboarding, and a demo where every asset is on the shelf cannot
 * show that the clearance gate works at all.
 */
const ASSETS: Array<{
  assetTag: string;
  category: string;
  name: string;
  serialNumber?: string;
  branch: string;
  status: AssetStatus;
  purchaseCost?: number;
  warrantyOffsetDays?: number;
}> = [
  {
    assetTag: 'LT-0042',
    category: 'Laptop',
    name: 'Dell Latitude 5540',
    serialNumber: 'DL5540-8891',
    branch: 'HQ',
    status: AssetStatus.AVAILABLE,
    purchaseCost: 520.75,
    warrantyOffsetDays: 400,
  },
  {
    assetTag: 'LT-0043',
    category: 'Laptop',
    name: 'Dell Latitude 5540',
    serialNumber: 'DL5540-8892',
    branch: 'HQ',
    status: AssetStatus.AVAILABLE,
    purchaseCost: 520.75,
    warrantyOffsetDays: 44,
  },
  {
    assetTag: 'MB-0007',
    category: 'Mobile Phone',
    name: 'Samsung Galaxy A55',
    serialNumber: 'SGA55-3310',
    branch: 'HQ',
    status: AssetStatus.AVAILABLE,
    purchaseCost: 138.5,
  },
  {
    assetTag: 'AC-0115',
    category: 'Access Card',
    name: 'HQ access card',
    branch: 'HQ',
    status: AssetStatus.AVAILABLE,
    purchaseCost: 3.25,
  },
  {
    assetTag: 'VH-0002',
    category: 'Vehicle',
    name: 'Toyota Hilux',
    serialNumber: 'MROFR22G0P0123456',
    branch: 'SOH',
    status: AssetStatus.IN_REPAIR,
    purchaseCost: 9850,
  },
  {
    assetTag: 'TL-0031',
    category: 'Tool',
    name: 'Torque wrench set',
    branch: 'SOH',
    status: AssetStatus.AVAILABLE,
    purchaseCost: 96.4,
  },
];

/** Who is holding what. `returnedAt` null is an OPEN custody. */
const ASSET_ASSIGNMENTS: Array<{
  assetTag: string;
  employee: string;
  assignedOffsetDays: number;
  conditionOut: string;
  acknowledged: boolean;
  returnedOffsetDays?: number;
  conditionIn?: string;
}> = [
  // Still out, and acknowledged: the ordinary state of a working laptop.
  {
    assetTag: 'LT-0042',
    employee: 'EMP-0005',
    assignedOffsetDays: -212,
    conditionOut: 'New',
    acknowledged: true,
  },
  // Still out and NOT acknowledged, so the "awaiting your confirmation" banner
  // on My Assets has something to draw.
  {
    assetTag: 'MB-0007',
    employee: 'EMP-0005',
    assignedOffsetDays: -9,
    conditionOut: 'New',
    acknowledged: false,
  },
  // Held by somebody else, so the register is not a one-person screen.
  {
    assetTag: 'AC-0115',
    employee: 'EMP-0007',
    assignedOffsetDays: -140,
    conditionOut: 'New',
    acknowledged: true,
  },
  // Closed: previously held, handed back. My Assets shows it under "previously
  // held" and the register shows the asset back on the shelf.
  {
    assetTag: 'LT-0043',
    employee: 'EMP-0005',
    assignedOffsetDays: -520,
    conditionOut: 'New',
    acknowledged: true,
    returnedOffsetDays: -215,
    conditionIn: 'Good',
  },
];

async function seedAssets(
  branches: Record<string, string>,
  employees: Record<string, string>,
  adminEmail: string,
) {
  const admin = await prisma.user.findUnique({
    where: { email: adminEmail },
    select: { id: true },
  });
  if (!admin) return;

  const assetIds: Record<string, string> = {};
  for (const asset of ASSETS) {
    const branchId = branches[asset.branch];
    if (!branchId) continue;
    const row = await prisma.assetItem.upsert({
      where: { branchId_assetTag: { branchId, assetTag: asset.assetTag } },
      update: {
        category: asset.category,
        name: asset.name,
        serialNumber: asset.serialNumber ?? null,
      },
      create: {
        assetTag: asset.assetTag,
        category: asset.category,
        name: asset.name,
        serialNumber: asset.serialNumber ?? null,
        branchId,
        status: asset.status,
        purchaseDate: daysFromToday(-600),
        purchaseCost: asset.purchaseCost ?? null,
        warrantyExpiry:
          asset.warrantyOffsetDays === undefined
            ? null
            : daysFromToday(asset.warrantyOffsetDays),
      },
    });
    assetIds[asset.assetTag] = row.id;
  }

  for (const assignment of ASSET_ASSIGNMENTS) {
    const assetId = assetIds[assignment.assetTag];
    const employeeId = employees[assignment.employee];
    if (!assetId || !employeeId) continue;

    // No natural unique key on a custody row — the same asset legitimately goes
    // out to the same person twice — so the idempotency key is the pair plus
    // the date it went out.
    const assignedAt = daysFromToday(assignment.assignedOffsetDays);
    const existing = await prisma.assetAssignment.findFirst({
      where: { assetId, employeeId, assignedAt },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.assetAssignment.create({
      data: {
        assetId,
        employeeId,
        assignedAt,
        assignedById: admin.id,
        conditionOut: assignment.conditionOut,
        acknowledgedAt: assignment.acknowledged
          ? daysFromToday(assignment.assignedOffsetDays + 1)
          : null,
        acknowledgedNote: assignment.acknowledged
          ? 'Received in good order'
          : null,
        returnedAt:
          assignment.returnedOffsetDays === undefined
            ? null
            : daysFromToday(assignment.returnedOffsetDays),
        conditionIn: assignment.conditionIn ?? null,
        returnReceivedById:
          assignment.returnedOffsetDays === undefined ? null : admin.id,
      },
    });

    // The status has to agree with the custody, or clearance and the register
    // tell two different stories about the same laptop.
    if (assignment.returnedOffsetDays === undefined) {
      await prisma.assetItem.update({
        where: { id: assetId },
        data: { status: AssetStatus.ASSIGNED },
      });
    }
  }

  const held = await prisma.assetAssignment.count({
    where: { returnedAt: null },
  });
  console.log(`  ✔ ${ASSETS.length} assets, ${held} currently out`);
}

/** One course, one scheduled session, and nominations at three stages. */
async function seedTraining(
  branches: Record<string, string>,
  employees: Record<string, string>,
  adminEmail: string,
) {
  const admin = await prisma.user.findUnique({
    where: { email: adminEmail },
    select: { id: true },
  });
  if (!admin) return;

  const course = await prisma.course.upsert({
    where: { code: 'SEC-101' },
    update: {},
    create: {
      code: 'SEC-101',
      title: 'Information Security Awareness',
      category: 'Compliance',
      provider: 'Muscat Training Institute',
      description:
        'The annual refresher every member of staff has to hold a current certificate for.',
      durationHours: 6,
      defaultCost: 45,
      // Twelve months, so the certificate below expires inside the window My
      // Training warns about rather than never.
      certValidMonths: 12,
    },
  });

  const startDate = daysFromToday(18);
  const existingSession = await prisma.trainingSession.findFirst({
    where: { courseId: course.id, startDate },
    select: { id: true },
  });
  const session =
    existingSession ??
    (await prisma.trainingSession.create({
      data: {
        courseId: course.id,
        branchId: branches['HQ'] ?? null,
        startDate,
        endDate: daysFromToday(19),
        location: 'HQ training room',
        trainer: 'Muscat Training Institute',
        seats: 12,
        costPerSeat: 45,
        status: 'SCHEDULED',
      },
    }));

  const nominations: Array<{
    employee: string;
    status: string;
    justification: string;
  }> = [
    {
      employee: 'EMP-0005',
      status: 'PENDING',
      justification: 'Annual refresher is due',
    },
    {
      employee: 'EMP-0007',
      status: 'APPROVED',
      justification: 'Handles customer data daily',
    },
    {
      employee: 'EMP-0004',
      status: 'APPROVED',
      justification: 'Payroll data access',
    },
  ];

  for (const nomination of nominations) {
    const employeeId = employees[nomination.employee];
    if (!employeeId) continue;
    await prisma.trainingNomination.upsert({
      where: {
        sessionId_employeeId: { sessionId: session.id, employeeId },
      },
      update: {},
      create: {
        sessionId: session.id,
        employeeId,
        nominatedById: admin.id,
        justification: nomination.justification,
        cost: 45,
        status: nomination.status,
        ...(nomination.status === 'APPROVED' && {
          approverId: admin.id,
          approvedAt: daysFromToday(-2),
        }),
      },
    });
  }

  // A completed course from last year, so the vault has a certificate in it and
  // My Training has an expiry to warn about.
  const pastStart = daysFromToday(-300);
  const pastSession =
    (await prisma.trainingSession.findFirst({
      where: { courseId: course.id, startDate: pastStart },
      select: { id: true },
    })) ??
    (await prisma.trainingSession.create({
      data: {
        courseId: course.id,
        branchId: branches['HQ'] ?? null,
        startDate: pastStart,
        endDate: daysFromToday(-299),
        location: 'HQ training room',
        trainer: 'Muscat Training Institute',
        seats: 12,
        costPerSeat: 40,
        status: 'COMPLETED',
      },
    }));

  const attendee = employees['EMP-0005'];
  if (attendee) {
    await prisma.trainingNomination.upsert({
      where: {
        sessionId_employeeId: {
          sessionId: pastSession.id,
          employeeId: attendee,
        },
      },
      update: {},
      create: {
        sessionId: pastSession.id,
        employeeId: attendee,
        nominatedById: admin.id,
        justification: 'Annual refresher',
        cost: 40,
        status: 'ATTENDED',
        approverId: admin.id,
        approvedAt: daysFromToday(-310),
        attendedAt: daysFromToday(-299),
        score: 88,
        passed: true,
        certificateUrl: '/uploads/certificates/sec-101-emp-0005.pdf',
        // Inside 90 days, so the "expiring soon" banner has something true.
        certificateExpiry: daysFromToday(65),
      },
    });
  }

  console.log('  ✔ 1 course, 2 sessions, 4 nominations');
}

/** One open grievance, with the trail that goes with it. */
async function seedGrievances(employees: Record<string, string>) {
  const complainant = employees['EMP-0012'];
  const subject = employees['EMP-0011'];
  if (!complainant) return;

  const hrUser = await prisma.user.findFirst({
    where: { role: UserRole.HR_MANAGER },
    select: { id: true },
  });

  const subjectLine = 'Shift roster changed without notice';
  const existing = await prisma.grievance.findFirst({
    where: { employeeId: complainant, subject: subjectLine },
    select: { id: true },
  });
  if (existing) return;

  await prisma.grievance.create({
    data: {
      employeeId: complainant,
      category: 'Working Conditions',
      subject: subjectLine,
      description:
        'My shift was moved to nights three weeks running with a day’s notice each time. ' +
        'I have asked twice for the roster to be published a week ahead.',
      // Confidential AND about a named person, so the visibility rule has a row
      // it actually applies to: the supervisor it names must never see it.
      isConfidential: true,
      againstEmployeeId: subject ?? null,
      status: 'ACKNOWLEDGED',
      assignedToId: hrUser?.id ?? null,
      events: {
        create: [
          {
            type: 'STATUS_CHANGE',
            toStatus: 'OPEN',
            note: 'Grievance raised',
            createdAt: daysFromToday(-6),
          },
          {
            type: 'STATUS_CHANGE',
            fromStatus: 'OPEN',
            toStatus: 'ACKNOWLEDGED',
            note: 'Received. We will speak to you this week.',
            actorUserId: hrUser?.id ?? null,
            createdAt: daysFromToday(-4),
          },
          {
            type: 'NOTE',
            note: 'Pulled the last six weeks of roster changes for this shift.',
            isInternal: true,
            actorUserId: hrUser?.id ?? null,
            createdAt: daysFromToday(-3),
          },
        ],
      },
    },
  });

  console.log('  ✔ 1 open grievance');
}

/**
 * The letters an employee can ask for, and one request at each stage.
 *
 * The templates come from the same defaults the API seeds on boot, so a freshly
 * seeded database has a usable "request a letter" form before anybody starts
 * the backend.
 */
async function seedLetters(
  employees: Record<string, string>,
  adminEmail: string,
) {
  for (const template of LETTER_TEMPLATE_DEFAULTS) {
    await prisma.letterTemplate.upsert({
      where: { key_locale: { key: template.key, locale: template.locale } },
      // Empty on purpose: re-seeding must not overwrite wording somebody edited.
      update: {},
      create: {
        key: template.key,
        name: template.name,
        locale: template.locale,
        bodyHtml: template.bodyHtml,
        requiresApproval: template.requiresApproval,
        isActive: true,
      },
    });
  }

  const requester = employees['EMP-0005'];
  if (!requester) return;

  const admin = await prisma.user.findUnique({
    where: { email: adminEmail },
    select: { id: true },
  });

  const pending = await prisma.letterRequest.findFirst({
    where: { employeeId: requester, templateKey: 'SALARY_CERTIFICATE' },
    select: { id: true },
  });
  if (!pending) {
    await prisma.letterRequest.create({
      data: {
        employeeId: requester,
        templateKey: 'SALARY_CERTIFICATE',
        locale: 'en',
        purpose: 'a personal loan application',
        addressedTo: 'Bank Muscat',
        status: 'PENDING',
      },
    });
  }

  const rejected = await prisma.letterRequest.findFirst({
    where: { employeeId: requester, templateKey: 'EMBASSY' },
    select: { id: true },
  });
  if (!rejected) {
    await prisma.letterRequest.create({
      data: {
        employeeId: requester,
        templateKey: 'EMBASSY',
        locale: 'en',
        purpose: 'a family holiday',
        addressedTo: 'Embassy of France',
        status: 'REJECTED',
        rejectedReason:
          'Please re-submit with the travel dates — the embassy will not accept an open letter.',
        issuedById: admin?.id ?? null,
      },
    });
  }

  console.log(
    `  ✔ ${LETTER_TEMPLATE_DEFAULTS.length} letter templates, 2 requests`,
  );
}

/**
 * A couple of documents in one employee's vault.
 *
 * Uploads, rather than anything system-generated: an issued letter writes its
 * own vault entry, and inventing one here would leave a document in the vault
 * that no letter request points at.
 */
const VAULT_DOCUMENTS: Array<{
  employee: string;
  documentType: string;
  fileName: string;
  fileUrl: string;
  description: string;
  issueOffsetDays: number;
  expiryOffsetDays?: number;
}> = [
  {
    employee: 'EMP-0005',
    documentType: 'Resume/CV',
    fileName: 'Fatma Al Rashdi — CV.pdf',
    fileUrl: '/uploads/documents/emp-0005-cv.pdf',
    description: 'Submitted at hire',
    issueOffsetDays: -1300,
  },
  {
    employee: 'EMP-0005',
    documentType: 'Degree',
    fileName: 'BSc Human Resource Management.pdf',
    fileUrl: '/uploads/documents/emp-0005-degree.pdf',
    description: 'Sultan Qaboos University',
    issueOffsetDays: -2400,
  },
  {
    employee: 'EMP-0007',
    documentType: 'Certificate',
    fileName: 'First aid at work.pdf',
    fileUrl: '/uploads/documents/emp-0007-first-aid.pdf',
    description: 'Renewal falls inside the vault’s 90-day warning window',
    issueOffsetDays: -700,
    expiryOffsetDays: 55,
  },
];

async function seedVaultDocuments(employees: Record<string, string>) {
  for (const doc of VAULT_DOCUMENTS) {
    const employeeId = employees[doc.employee];
    if (!employeeId) continue;

    // `EmployeeDocument` has no natural unique key — the same person may upload
    // two files of the same type — so the file name stands in for one.
    const existing = await prisma.employeeDocument.findFirst({
      where: { employeeId, fileName: doc.fileName },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.employeeDocument.create({
      data: {
        employeeId,
        documentType: doc.documentType,
        fileName: doc.fileName,
        fileUrl: doc.fileUrl,
        mimeType: 'application/pdf',
        description: doc.description,
        issueDate: daysFromToday(doc.issueOffsetDays),
        expiryDate:
          doc.expiryOffsetDays === undefined
            ? null
            : daysFromToday(doc.expiryOffsetDays),
      },
    });
  }

  console.log(`  ✔ ${VAULT_DOCUMENTS.length} vault documents`);
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

  await seedSalaryStructures(employees);
  await seedPayrollRuns(employees);

  await seedLibraryDefaults(prisma);
  await seedApprovalWorkflows();
  await seedLeaveBalances(employees);
  await seedLeaveAccrualHistory(employees);
  await seedLeaveRequests(employees);
  const overtimePolicyId = await seedOvertimePolicy();
  await seedOvertimeRequests(employees, overtimePolicyId);

  await seedAssets(branches, employees, adminEmail);
  await seedTraining(branches, employees, adminEmail);
  await seedGrievances(employees);
  await seedLetters(employees, adminEmail);
  await seedVaultDocuments(employees);

  console.log('✅ Seed complete.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
