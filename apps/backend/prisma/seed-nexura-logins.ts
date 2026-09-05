/**
 * Seed the five @nexura.com logins (one universal admin + four Muscat-branch
 * roles) and enough per-person data that no module page renders empty for them.
 *
 * Why this exists rather than a re-run of `prisma:seed:sample` / `demo-fill`:
 * those two are written for a database they own. `seedSampleExtras` deletes
 * every Muscat-scoped holiday and rewires supervisors on employees it did not
 * create, and `seedDemoFill` filters on `@sample.hrms.local` so it would skip
 * these people anyway. This script is ADDITIVE — it inserts rows for the seven
 * employees it creates and touches exactly two pre-existing things, both
 * deliberate and both reported at the end:
 *
 *   1. `departments.manager_id` for Operations (SMP-OPS) is repointed at the
 *      new department-manager login. The column holds one manager, so whoever
 *      held it is displaced; the previous value is written to DepartmentHistory
 *      and ManagerTransition and printed with the SQL to put it back.
 *   2. `payrolls.total_amount` for the existing Muscat runs is recomputed after
 *      the new payroll items land, so the stored total still equals the sum of
 *      its items.
 *
 * Idempotent: everything this script owns is keyed by the `NX-` code prefix or
 * the `@nexura.com` domain and is cleared before being rewritten, so a re-run
 * converges instead of duplicating.
 *
 * Run:  npx ts-node --transpile-only prisma/seed-nexura-logins.ts
 *       DRY_RUN=1 …   rehearse inside a transaction that is rolled back
 */

import { PrismaClient, Prisma, TimesheetStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

/** Every model call goes through this, so DRY_RUN can hand `main` a tx client. */
type Db = Omit<PrismaClient, `$${string}`>;

const prisma = new PrismaClient();

const NX = 'NX-';
const NEXURA_DOMAIN = '@nexura.com';
const PASSWORD = process.env.NEXURA_PASSWORD ?? 'Password123!';
const DRY_RUN = process.env.DRY_RUN === '1';

/** Deterministic, so a re-run produces the same demo. */
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
let rng = mulberry32(20260825);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];

const dU = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const atTime = (d: Date, h: number, min = 0) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min, 0));
const TODAY = (() => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
})();
const day = (n: number) =>
  new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate() + n));
/** Oman rests Friday/Saturday. getUTCDay(): 5 = Fri, 6 = Sat. */
const isWeekend = (d: Date) => d.getUTCDay() === 5 || d.getUTCDay() === 6;
const dec = (n: number | string) => new Prisma.Decimal(n);

type Person = {
  key: string;
  code: string;
  name: string;
  email: string;
  login: null | { email: string; role: string; global?: boolean };
  dept: 'OPS' | 'HR';
  position: string;
  salary: number;
  gender: 'MALE' | 'FEMALE';
  dob: Date;
  start: Date;
  /** `key` of this person's supervisor. */
  reportsTo: string | null;
};

const PEOPLE: Person[] = [
  {
    key: 'admin',
    code: `${NX}EMP-001`,
    name: 'Moza Al Amri',
    email: `dileeparavind${NEXURA_DOMAIN}`,
    login: { email: `dileeparavind${NEXURA_DOMAIN}`, role: 'ADMIN', global: true },
    dept: 'OPS',
    position: 'Head of HR Systems',
    salary: 2400,
    gender: 'FEMALE',
    dob: dU(1988, 4, 12),
    start: dU(2021, 3, 1),
    reportsTo: null,
  },
  {
    key: 'hr',
    code: `${NX}EMP-002`,
    name: 'Salim Al Hinai',
    email: `hr.muscat${NEXURA_DOMAIN}`,
    login: { email: `hr.muscat${NEXURA_DOMAIN}`, role: 'HR_MANAGER' },
    dept: 'HR',
    position: 'HR Manager — Muscat',
    salary: 1850,
    gender: 'MALE',
    dob: dU(1990, 8, 5),
    start: dU(2022, 1, 10),
    reportsTo: 'admin',
  },
  {
    key: 'manager',
    code: `${NX}EMP-003`,
    name: 'Nasser Al Kindi',
    email: `manager.muscat${NEXURA_DOMAIN}`,
    login: { email: `manager.muscat${NEXURA_DOMAIN}`, role: 'MANAGER' },
    dept: 'OPS',
    position: 'Operations Manager',
    salary: 1650,
    gender: 'MALE',
    dob: dU(1987, 11, 22),
    start: dU(2021, 9, 6),
    reportsTo: 'admin',
  },
  {
    key: 'supervisor',
    code: `${NX}EMP-004`,
    name: 'Huda Al Balushi',
    email: `supervisor.muscat${NEXURA_DOMAIN}`,
    login: { email: `supervisor.muscat${NEXURA_DOMAIN}`, role: 'EMPLOYEE' },
    dept: 'OPS',
    position: 'Operations Supervisor',
    salary: 980,
    gender: 'FEMALE',
    dob: dU(1993, 2, 17),
    start: dU(2023, 4, 3),
    reportsTo: 'manager',
  },
  {
    key: 'employee',
    code: `${NX}EMP-005`,
    name: 'Yaqoob Al Saadi',
    email: `employee.muscat${NEXURA_DOMAIN}`,
    login: { email: `employee.muscat${NEXURA_DOMAIN}`, role: 'EMPLOYEE' },
    dept: 'OPS',
    position: 'Operations Associate',
    salary: 620,
    gender: 'MALE',
    dob: dU(1996, 6, 30),
    start: dU(2024, 2, 12),
    reportsTo: 'supervisor',
  },
  // Two reports without logins, so the supervisor's team and the manager's
  // department are not a list of one.
  {
    key: 'report1',
    code: `${NX}EMP-006`,
    name: 'Amal Al Rawahi',
    email: `amal.alrawahi${NEXURA_DOMAIN}`,
    login: null,
    dept: 'OPS',
    position: 'Logistics Coordinator',
    salary: 540,
    gender: 'FEMALE',
    dob: dU(1997, 9, 8),
    start: dU(2024, 7, 1),
    reportsTo: 'supervisor',
  },
  {
    key: 'report2',
    code: `${NX}EMP-007`,
    name: 'Talal Al Farsi',
    email: `talal.alfarsi${NEXURA_DOMAIN}`,
    login: null,
    dept: 'OPS',
    position: 'Warehouse Assistant',
    salary: 460,
    gender: 'MALE',
    dob: dU(1999, 12, 2),
    start: dU(2025, 1, 20),
    reportsTo: 'supervisor',
  },
];

/** Matches the LEAVE_TYPE library labels already in the database. */
const LEAVE_TYPES = [
  { key: 'Annual Leave', quota: 12 },
  { key: 'Sick Leave', quota: 30 },
  { key: 'Bereavement Leave', quota: 5 },
  { key: 'Unpaid Leave', quota: 0 },
] as const;

async function main(db: Db): Promise<void> {
  rng = mulberry32(20260825);
  console.log(`Seeding ${NEXURA_DOMAIN} logins into ${maskUrl(process.env.DATABASE_URL)}`);
  if (DRY_RUN) console.log('DRY_RUN=1 — everything below is rolled back at the end.\n');

  // ── Bind to what already exists. Fail loudly rather than inventing rows. ──
  const branch = await db.branch.findUnique({ where: { code: 'SMP-MCT' } });
  if (!branch) throw new Error('Muscat branch (SMP-MCT) not found.');
  const deptOps = await db.department.findUnique({ where: { code: 'SMP-OPS' } });
  const deptHr = await db.department.findUnique({ where: { code: 'SMP-HR' } });
  if (!deptOps || !deptHr) throw new Error('SMP-OPS / SMP-HR departments not found.');
  const otPolicy = await db.overtimePolicy.findFirst({
    where: { name: 'SMP-Oman Standard OT' },
    select: { id: true },
  });
  const muscatSessions = await db.trainingSession.findMany({
    where: { branchId: branch.id },
    select: { id: true, status: true },
    orderBy: { startDate: 'asc' },
  });
  const payrolls = await db.payroll.findMany({
    where: { branchId: branch.id },
    select: { id: true, month: true, year: true },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });

  const deptIdFor = (p: Person) => (p.dept === 'HR' ? deptHr.id : deptOps.id);

  await clearPreviousRun(db);

  // ── 1. Employees ────────────────────────────────────────────────────────
  const empId: Record<string, string> = {};
  for (const p of PEOPLE) {
    const e = await db.employee.create({
      data: {
        employeeCode: p.code,
        fullName: p.name,
        dateOfBirth: p.dob,
        gender: p.gender,
        idCard: p.code.replace('EMP', 'ID'),
        email: p.email,
        phone: `+968-9${p.code.slice(-3)}-1000`,
        phoneCountryCode: 'OM',
        address: 'Al Khuwair, Muscat, Oman',
        departmentId: deptIdFor(p),
        branchId: branch.id,
        position: p.position,
        startDate: p.start,
        status: 'ACTIVE',
        baseSalary: dec(p.salary),
        salaryType: 'MONTHLY',
        timezone: 'Asia/Muscat',
        overtimePolicyId: otPolicy?.id ?? null,
        hasCompleteProfile: true,
        profileLastUpdated: day(-3),
      },
      select: { id: true },
    });
    empId[p.key] = e.id;
  }
  // Supervisor links, once every id exists.
  for (const p of PEOPLE) {
    if (!p.reportsTo) continue;
    await db.employee.update({
      where: { id: empId[p.key] },
      data: { supervisorId: empId[p.reportsTo] },
    });
  }
  console.log(`  - ${PEOPLE.length} employees created in ${branch.name}`);

  // ── 2. Logins ───────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const userId: Record<string, string> = {};
  for (const p of PEOPLE) {
    if (!p.login) continue;
    const u = await db.user.create({
      data: {
        email: p.login.email,
        passwordHash,
        role: p.login.role,
        employeeId: empId[p.key],
        isActive: true,
        isEmailVerified: true,
        emailVerifiedAt: day(-30),
        isGlobalBranchAccess: p.login.global === true,
      },
      select: { id: true },
    });
    userId[p.key] = u.id;
    // The admin is universal, so an explicit branch grant would be noise; the
    // other four are pinned to Muscat.
    if (!p.login.global) {
      await db.userBranchAccess.create({ data: { userId: u.id, branchId: branch.id } });
    }
  }
  console.log(`  - ${Object.keys(userId).length} logins created`);

  const hrUserId = userId['hr'];
  const adminUserId = userId['admin'];

  // ── 3. Operations gets the new manager ──────────────────────────────────
  const displacedManagerId = deptOps.managerId;
  await db.department.update({
    where: { id: deptOps.id },
    data: { managerId: empId['manager'] },
  });
  await db.departmentHistory.create({
    data: {
      departmentId: deptOps.id,
      changeType: 'MANAGER_CHANGED',
      // `oldValue` is `Json?`, and Prisma will not take a bare `null` for a
      // nullable JSON column — it needs to be told WHICH null. `Prisma.DbNull`
      // is a SQL NULL, which is what "the department had no manager before
      // this" means. `Prisma.JsonNull` would store the JSON literal `null`, a
      // different value that reads back as "the old manager was, explicitly,
      // nothing".
      oldValue: displacedManagerId ?? Prisma.DbNull,
      newValue: empId['manager'],
      changeReason: MANAGER_CHANGE_REASON,
      changedBy: adminUserId,
    },
  });
  await db.managerTransition.create({
    data: {
      departmentId: deptOps.id,
      oldManagerId: displacedManagerId ?? null,
      newManagerId: empId['manager'],
      targetEndDate: day(14),
      status: 'IN_PROGRESS',
      startDate: TODAY,
      notes: 'Handover to the seeded Muscat operations manager.',
    },
  });

  // ── 4. Per-person records ───────────────────────────────────────────────
  for (const p of PEOPLE) {
    const id = empId[p.key];
    const approverUserId = (p.reportsTo && userId[p.reportsTo]) || hrUserId;

    await db.employeeProfile.create({
      data: {
        employeeId: id,
        placeOfBirth: 'Muscat',
        nationality: 'Omani',
        nationalityCode: 'OM',
        nationalityClass: 'LOCAL',
        maritalStatus: p.salary > 900 ? 'MARRIED' : 'SINGLE',
        numberOfChildren: p.salary > 900 ? 2 : 0,
        permanentAddress: 'Al Khuwair, Muscat, Sultanate of Oman',
        passportNumber: `OM${p.code.slice(-3)}4471`,
        passportExpiry: day(540),
        emergencyContactName: 'Next of kin',
        emergencyContactRelationship: 'Sibling',
        emergencyContactPhone: `+968-9${p.code.slice(-3)}-2000`,
        highestEducation: 'BACHELOR',
        major: 'Business Administration',
        university: 'Sultan Qaboos University',
        graduationYear: p.dob.getUTCFullYear() + 22,
        profileCompletionPercentage: 100,
        lastProfileUpdate: day(-3),
      },
    });

    await db.contract.create({
      data: {
        employeeId: id,
        contractNumber: `${NX}CTR-${p.code.slice(-3)}`,
        contractType: p.salary > 900 ? 'INDEFINITE' : 'FIXED_TERM',
        workType: 'FULL_TIME',
        workHoursPerWeek: 45,
        startDate: p.start,
        endDate: p.salary > 900 ? null : day(400),
        salary: dec(p.salary),
        status: 'ACTIVE',
        terms: 'Oman Labour Law — 45h week, 30 days annual leave accrual basis.',
      },
    });

    // Salary structure — the breakdown the payroll pages read.
    await db.salaryComponent.createMany({
      data: [
        { employeeId: id, componentType: 'BASIC', amount: dec(p.salary * 0.6), effectiveDate: p.start, isActive: true },
        { employeeId: id, componentType: 'HOUSING', amount: dec(p.salary * 0.25), effectiveDate: p.start, isActive: true },
        { employeeId: id, componentType: 'TRANSPORT', amount: dec(p.salary * 0.15), effectiveDate: p.start, isActive: true },
      ],
    });

    // ── Attendance + roster, 70 days back and 21 forward ──
    const attendance: Prisma.AttendanceCreateManyInput[] = [];
    const schedules: Prisma.WorkScheduleCreateManyInput[] = [];
    for (let d = -70; d <= 21; d++) {
      const date = day(d);
      const weekend = isWeekend(date);
      schedules.push({
        employeeId: id,
        date,
        shiftType: weekend ? 'FLEXIBLE' : 'FULL_DAY',
        startTime: atTime(date, 4, 0), // 08:00 Asia/Muscat
        endTime: atTime(date, 13, 0), // 17:00 Asia/Muscat
        isWorkDay: !weekend,
      });
      if (weekend || d > 0) continue;
      const roll = rng();
      const status = roll > 0.94 ? 'ABSENT' : roll > 0.9 ? 'LEAVE' : 'PRESENT';
      if (status !== 'PRESENT') {
        attendance.push({ employeeId: id, date, status, branchId: branch.id });
        continue;
      }
      const late = rng() > 0.85;
      const checkIn = atTime(date, 4, late ? 25 : 0);
      const checkOut = atTime(date, 13, rng() > 0.8 ? 40 : 5);
      attendance.push({
        employeeId: id,
        date,
        status,
        branchId: branch.id,
        checkIn,
        checkOut,
        isLate: late,
        isLateCheckout: checkOut.getUTCMinutes() > 30,
        workHours: dec(((checkOut.getTime() - checkIn.getTime()) / 3_600_000).toFixed(2)),
        source: 'AUTO',
      });
    }
    await db.attendance.createMany({ data: attendance });
    await db.workSchedule.createMany({ data: schedules });

    // ── Leave: balances, accrual trail, and requests in every state ──
    const year = TODAY.getUTCFullYear();
    await db.leaveBalance.create({
      data: { employeeId: id, year, annualLeave: 12, sickLeave: 30, usedAnnual: 4, usedSick: 1, carriedOver: 2 },
    });
    for (const lt of LEAVE_TYPES) {
      await db.leaveTypeBalance.create({
        data: {
          employeeId: id,
          year,
          leaveTypeKey: lt.key,
          allocated: lt.quota,
          used: lt.key === 'Annual Leave' ? 4 : lt.key === 'Sick Leave' ? 1 : 0,
          carriedOver: lt.key === 'Annual Leave' ? 2 : 0,
          carriedFromYear: lt.key === 'Annual Leave' ? year - 1 : null,
        },
      });
    }
    for (let m = 1; m <= 6; m++) {
      await db.leaveAccrualHistory.create({
        data: {
          employeeId: id,
          year,
          month: m,
          daysAdded: 1,
          balanceBefore: m,
          balanceAfter: m + 1,
          accrualType: 'MONTHLY',
          notes: 'Monthly annual-leave accrual.',
        },
      });
    }

    const leaves = [
      { type: 'Annual Leave', from: -45, days: 3, status: 'APPROVED', reason: 'Family trip to Salalah.' },
      { type: 'Sick Leave', from: -18, days: 1, status: 'APPROVED', reason: 'Fever — clinic note attached.' },
      { type: 'Annual Leave', from: 12, days: 4, status: 'PENDING', reason: 'Eid break with family.' },
      { type: 'Unpaid Leave', from: -60, days: 2, status: 'REJECTED', reason: 'Personal errand.' },
    ];
    for (const l of leaves) {
      const decided = l.status !== 'PENDING';
      const lr = await db.leaveRequest.create({
        data: {
          employeeId: id,
          leaveType: l.type,
          startDate: day(l.from),
          endDate: day(l.from + l.days - 1),
          totalDays: l.days,
          reason: l.reason,
          status: l.status,
          approverId: decided ? approverUserId : null,
          approvedAt: l.status === 'APPROVED' ? day(l.from - 2) : null,
          rejectedReason: l.status === 'REJECTED' ? 'Coverage not available that week.' : null,
          createdAt: day(l.from - 5),
        },
        select: { id: true },
      });
      // Tier 1 = the line supervisor, tier 2 = HR, matching the sample workflows.
      await db.leaveApproval.create({
        data: {
          leaveRequestId: lr.id,
          approverId: approverUserId,
          tier: 1,
          status: decided ? (l.status === 'REJECTED' ? 'REJECTED' : 'APPROVED') : 'PENDING',
          comment: decided ? 'Reviewed by line supervisor.' : null,
          decidedAt: decided ? day(l.from - 3) : null,
        },
      });
      await db.leaveApproval.create({
        data: {
          leaveRequestId: lr.id,
          approverId: hrUserId,
          tier: 2,
          status: l.status === 'APPROVED' ? 'APPROVED' : l.status === 'REJECTED' ? 'REJECTED' : 'PENDING',
          comment: decided ? 'Reviewed by HR.' : null,
          decidedAt: decided ? day(l.from - 2) : null,
        },
      });
    }

    // ── Overtime ──
    for (const ot of [
      { d: -20, h: 3, status: 'APPROVED', type: 'REGULAR' },
      { d: -9, h: 2, status: 'APPROVED', type: 'LATE' },
      { d: -2, h: 4, status: 'PENDING', type: 'REGULAR' },
    ]) {
      const date = day(ot.d);
      await db.overtimeRequest.create({
        data: {
          employeeId: id,
          date,
          startTime: atTime(date, 13, 30),
          endTime: atTime(date, 13 + ot.h, 30),
          hours: dec(ot.h),
          regularHours: dec(ot.type === 'REGULAR' ? ot.h : 0),
          lateHours: dec(ot.type === 'LATE' ? ot.h : 0),
          dayType: 'WEEKDAY',
          otType: ot.type,
          reason: 'Month-end stock count at the Muscat depot.',
          status: ot.status,
          overtimePolicyId: otPolicy?.id ?? null,
          approverId: ot.status === 'APPROVED' ? approverUserId : null,
          approvedAt: ot.status === 'APPROVED' ? day(ot.d + 1) : null,
          createdAt: day(ot.d - 1),
        },
      });
    }

    // ── Expense claims ──
    for (const r of [
      { t: 'Travel', a: 85, d: -35, s: 'PAID' },
      { t: 'Medical', a: 42, d: -14, s: 'APPROVED' },
      { t: 'Office Supplies', a: 23, d: -4, s: 'PENDING' },
    ]) {
    }

    // ── Documents and visa ──
    for (const doc of ['Passport', 'National ID', 'Employment Contract']) {
      const slug = doc.replace(/\s+/g, '-').toLowerCase();
      await db.employeeDocument.create({
        data: {
          employeeId: id,
          documentType: doc,
          fileName: `${p.code}-${slug}.pdf`,
          fileUrl: `seed://nexura/${p.code}/${slug}.pdf`,
          mimeType: 'application/pdf',
          fileSize: 182_400,
          description: `${doc} on file for ${p.name}.`,
          issueDate: day(-800),
          expiryDate: doc === 'Employment Contract' ? null : day(700),
          uploadedBy: hrUserId,
          uploadedAt: day(-30),
        },
      });
    }
    await db.employeeLegalDocument.create({
      data: {
        employeeId: id,
        category: 'VISA',
        documentType: 'Employment Visa',
        documentNumber: `OMV-${p.code.slice(-3)}-2026`,
        // `country` is a display name here (existing rows say "Oman"); the
        // adjacent `nationality` column is the ISO-3166 alpha-2 code.
        country: 'Oman',
        nationality: 'OM',
        issuingAuthority: 'Royal Oman Police — Directorate General of Passports',
        placeOfIssue: 'Muscat',
        sponsor: 'Nexura Muscat Branch',
        issueDate: day(-500),
        expiryDate: day(220),
        status: 'ACTIVE',
        isCurrent: true,
        createdById: hrUserId,
      },
    });

    // ── Assets: new tags, so no existing asset changes hands ──
    const asset = await db.assetItem.create({
      data: {
        assetTag: `${NX}AST-${p.code.slice(-3)}`,
        name: pick(['Dell Latitude 5550', 'HP EliteBook 840', 'Corporate SIM — Omantel', 'Site access badge']),
        category: 'IT Equipment',
        branchId: branch.id,
        status: 'ASSIGNED',
        purchaseDate: day(-400),
        purchaseCost: dec(320),
      },
      select: { id: true },
    });
    await db.assetAssignment.create({
      data: {
        assetId: asset.id,
        employeeId: id,
        assignedAt: day(-120),
        assignedById: hrUserId,
        conditionOut: 'New',
        acknowledgedAt: day(-119),
        acknowledgedNote: 'Received in good condition.',
      },
    });

    // ── Travel, training, letters ──
    for (const [i, s] of muscatSessions.slice(0, 2).entries()) {
      const attended = s.status === 'COMPLETED';
      await db.trainingNomination.create({
        data: {
          sessionId: s.id,
          employeeId: id,
          nominatedById: hrUserId,
          source: 'MANUAL',
          justification: 'Mandatory branch training.',
          cost: dec(45),
          status: attended ? 'ATTENDED' : i === 0 ? 'APPROVED' : 'PENDING',
          approverId: attended || i === 0 ? hrUserId : null,
          approvedAt: attended || i === 0 ? day(-40) : null,
          attendedAt: attended ? day(-7) : null,
          score: attended ? 82 : null,
          passed: attended ? true : null,
        },
      });
    }
    await db.letterRequest.create({
      data: {
        employeeId: id,
        templateKey: 'SALARY_CERTIFICATE',
        locale: 'en',
        purpose: 'Bank loan application',
        addressedTo: 'Bank Muscat',
        status: 'ISSUED',
        serialNumber: `${NX}LTR-${p.code.slice(-3)}-01`,
        issuedById: hrUserId,
        issuedAt: day(-21),
        createdAt: day(-25),
      },
    });
    await db.letterRequest.create({
      data: {
        employeeId: id,
        templateKey: 'NOC',
        locale: 'en',
        purpose: 'Personal vehicle registration',
        addressedTo: 'Royal Oman Police',
        status: 'PENDING',
        createdAt: day(-3),
      },
    });

    // ── Timesheets and activity trail ──
    const timesheets: { d: number; h: number; s: TimesheetStatus }[] = [
      { d: -12, h: 8, s: TimesheetStatus.APPROVED },
      { d: -5, h: 7.5, s: TimesheetStatus.SUBMITTED },
      { d: -1, h: 8, s: TimesheetStatus.DRAFT },
    ];
    for (const t of timesheets) {
      await db.timesheet.create({
        data: {
          employeeId: id,
          workDate: day(t.d),
          hoursWorked: dec(t.h),
          description: 'Muscat depot operations.',
          status: t.s,
          submittedAt: t.s === TimesheetStatus.DRAFT ? null : day(t.d + 1),
          approvedAt: t.s === TimesheetStatus.APPROVED ? day(t.d + 2) : null,
          approvedBy: t.s === TimesheetStatus.APPROVED ? userId['manager'] : null,
        },
      });
    }
    await db.employeeActivity.createMany({
      data: [
        { employeeId: id, activityType: 'profile_update', action: 'updated', description: 'Profile completed.', performedBy: hrUserId },
        { employeeId: id, activityType: 'leave_request', action: 'created', description: 'Annual leave requested.', performedBy: hrUserId },
      ],
    });
  }
  console.log(
    '  - Profiles, contracts, banking, salary structure, attendance, roster, leave, overtime,\n' +
      '    claims, documents, visas, assets, travel, training, letters and timesheets written',
  );

  // A couple of grievances, a correction and recognition records — enough that
  // the approver-facing queues are not empty, without one per person.
  await db.grievance.create({
    data: {
      employeeId: empId['employee'],
      category: 'Workplace Safety',
      subject: 'Depot lighting is out on the night shift',
      description:
        'The rear loading bay light has been out for two weeks; night stock counts are unsafe.',
      status: 'INVESTIGATING',
      assignedToId: hrUserId,
      createdAt: day(-11),
    },
  });
  await db.grievance.create({
    data: {
      employeeId: empId['report1'],
      category: 'Facilities',
      subject: 'Air conditioning in the coordinator room',
      description: 'Unit stops cooling after midday.',
      status: 'RESOLVED',
      assignedToId: hrUserId,
      resolution: 'Maintenance replaced the compressor.',
      resolvedAt: day(-6),
      createdAt: day(-24),
    },
  });
  await db.attendanceCorrection.create({
    data: {
      employeeId: empId['employee'],
      date: day(-6),
      reason: 'Badge reader failed at the depot gate; arrived 08:00.',
      requestedCheckIn: atTime(day(-6), 4, 0),
      requestedCheckOut: atTime(day(-6), 13, 0),
      status: 'PENDING',
      createdAt: day(-5),
    },
  });
  await db.reward.create({
    data: {
      employeeId: empId['supervisor'],
      rewardType: 'RECOGNITION',
      reason: 'Zero-incident quarter across the Muscat depot.',
      amount: dec(150),
      rewardDate: day(-30),
      createdBy: hrUserId,
    },
  });
  await db.discipline.create({
    data: {
      employeeId: empId['report2'],
      disciplineType: 'VERBAL_WARNING',
      reason: 'Repeated late arrival in July.',
      disciplineDate: day(-40),
      createdBy: hrUserId,
    },
  });

  // ── 6. Payslips in the existing Muscat runs ─────────────────────────────
  for (const run of payrolls) {
    for (const p of PEOPLE) {
      const allowances = p.salary * 0.4;
      const otPay = Math.round(rng() * 30 * 100) / 100;
      const net = p.salary + allowances + otPay;
      await db.payrollItem.create({
        data: {
          payrollId: run.id,
          employeeId: empId[p.key],
          baseSalary: dec(p.salary),
          workDays: 22,
          actualWorkDays: dec(21),
          allowances: dec(allowances),
          overtimeHours: dec(2),
          overtimePay: dec(otPay),
          netSalary: dec(net.toFixed(2)),
          notes: 'Seeded payslip (seed-nexura-logins).',
        },
      });
    }
    // Keep the stored total equal to the sum of its items.
    const agg = await db.payrollItem.aggregate({
      where: { payrollId: run.id },
      _sum: { netSalary: true },
    });
    await db.payroll.update({
      where: { id: run.id },
      data: { totalAmount: agg._sum.netSalary ?? dec(0) },
    });
  }
  console.log(`  - Payslips added to ${payrolls.length} Muscat payroll run(s); run totals recomputed`);

  // Gratuity accrual on the most recent run, so the gratuity pages show a figure.
  const latestRun = payrolls[payrolls.length - 1];
  if (latestRun) {
    for (const p of PEOPLE) {
      const serviceYears = (TODAY.getTime() - p.start.getTime()) / (365.25 * 24 * 3_600_000);
      const basis = p.salary * 0.6;
      const daysAccrued = serviceYears * 15;
    }
    console.log('  - Gratuity accruals written');
  }

  // ── 7. Notifications ────────────────────────────────────────────────────
  for (const key of Object.keys(userId)) {
    await db.notification.createMany({
      data: [
        {
          userId: userId[key],
          type: 'INFO',
          title: 'Welcome to the Muscat branch workspace',
          message: 'Your account is active. Complete your profile to finish onboarding.',
          isRead: false,
        },
        {
          userId: userId[key],
          type: 'APPROVAL_REQUESTED',
          title: 'Leave request awaiting your review',
          message: 'A leave request in Operations is pending a decision.',
          link: '/dashboard/leaves/pending',
          isRead: false,
        },
        {
          userId: userId[key],
          type: 'VISA_EXPIRING',
          title: 'Visa expiring in 220 days',
          message: 'An employment visa in your branch is approaching renewal.',
          link: '/dashboard/employees',
          isRead: true,
          readAt: day(-2),
        },
      ],
    });
  }
  console.log('  - Notifications written');

  console.log(`\nSeed complete. Logins (password: ${PASSWORD})`);
  for (const p of PEOPLE) {
    if (!p.login) continue;
    const scope = p.login.global ? '[all branches]' : '[Muscat]';
    console.log(`   ${p.login.role.padEnd(11)} ${p.login.email.padEnd(30)} ${p.name.padEnd(18)} ${scope}`);
  }
  if (displacedManagerId) {
    console.log('\n   NOTE: Operations (SMP-OPS) manager was repointed at the new manager login.');
    console.log(`   Previous manager employee id: ${displacedManagerId}`);
    console.log(`   Undo: UPDATE departments SET manager_id='${displacedManagerId}' WHERE code='SMP-OPS';`);
  }
}

const MANAGER_CHANGE_REASON = 'Muscat role logins seeded (seed-nexura-logins).';

/** Remove anything a previous run of THIS script created, and nothing else. */
async function clearPreviousRun(db: Db): Promise<void> {
  const existing = await db.employee.findMany({
    where: { employeeCode: { startsWith: NX } },
    select: { id: true },
  });
  const ids = existing.map((e) => e.id);
  if (!ids.length) return;
  const of = { employeeId: { in: ids } };
  console.log(`  - Clearing ${ids.length} employee(s) from a previous run…`);

  await db.leaveApproval.deleteMany({ where: { leaveRequest: { employeeId: { in: ids } } } });
  await db.payrollItem.deleteMany({ where: of });
  await db.assetAssignment.deleteMany({ where: of });
  await db.assetItem.deleteMany({ where: { assetTag: { startsWith: NX } } });
  await db.trainingNomination.deleteMany({ where: of });
  await db.timesheet.deleteMany({ where: of });
  await db.workSchedule.deleteMany({ where: of });
  await db.attendanceCorrection.deleteMany({ where: of });
  await db.attendance.deleteMany({ where: of });
  await db.leaveAccrualHistory.deleteMany({ where: of });
  await db.leaveRequest.deleteMany({ where: of });
  await db.leaveTypeBalance.deleteMany({ where: of });
  await db.leaveBalance.deleteMany({ where: of });
  await db.overtimeRequest.deleteMany({ where: of });
  await db.employeeDocument.deleteMany({ where: of });
  await db.employeeLegalDocument.deleteMany({ where: of });
  await db.letterRequest.deleteMany({ where: of });
  await db.grievance.deleteMany({ where: of });
  await db.grievance.deleteMany({ where: { againstEmployeeId: { in: ids } } });
  await db.reward.deleteMany({ where: of });
  await db.discipline.deleteMany({ where: of });
  await db.salaryComponent.deleteMany({ where: of });
  await db.employeeActivity.deleteMany({ where: of });
  await db.employeeHistory.deleteMany({ where: of });
  await db.contract.deleteMany({ where: of });
  await db.employeeProfile.deleteMany({ where: of });
  await db.notification.deleteMany({ where: { user: { email: { endsWith: NEXURA_DOMAIN } } } });
  await db.userBranchAccess.deleteMany({ where: { user: { email: { endsWith: NEXURA_DOMAIN } } } });
  await db.managerTransition.deleteMany({ where: { newManagerId: { in: ids } } });
  await db.departmentHistory.deleteMany({ where: { changeReason: MANAGER_CHANGE_REASON } });
  // Every FK pointing at these employees must let go before the rows can die.
  await db.department.updateMany({ where: { managerId: { in: ids } }, data: { managerId: null } });
  await db.branch.updateMany({ where: { managerId: { in: ids } }, data: { managerId: null } });
  await db.employee.updateMany({ where: { supervisorId: { in: ids } }, data: { supervisorId: null } });
  await db.user.deleteMany({ where: { email: { endsWith: NEXURA_DOMAIN } } });
  await db.employee.deleteMany({ where: { id: { in: ids } } });
}

function maskUrl(url?: string): string {
  return (url ?? '(unset)').replace(/(:\/\/[^:]+:)[^@]+@/, '$1****@');
}

// DRY_RUN runs the whole thing inside one interactive transaction and then
// throws, so Postgres rolls it back — a real rehearsal against the real
// database rather than a guess about what would have happened.
const ROLLBACK = Symbol('rollback');

// The real run is wrapped too, not just the rehearsal: a failure halfway
// through would otherwise leave a half-built employee on a production
// database, which is worse than not running at all.
async function run(): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await main(tx as unknown as Db);
        if (DRY_RUN) throw ROLLBACK;
      },
      { timeout: 900_000, maxWait: 60_000 },
    );
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    console.log('\nDRY_RUN — transaction rolled back, database unchanged.');
  }
}

run()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
