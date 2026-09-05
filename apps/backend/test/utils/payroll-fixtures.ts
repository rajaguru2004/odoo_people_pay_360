import * as bcrypt from 'bcrypt';
import { E2EContext } from './e2e-app';

/**
 * The Payroll module's own fixture set.
 *
 * Deliberately separate from `utils/fixtures.ts` (which exists to prove branch
 * ISOLATION) and from `org-fixtures.ts` (which needs a department tree). Payroll
 * needs a third shape again: employees of every PAY BASIS, a period that already
 * has attendance captured, a branch whose banking country is not the default, and
 * an employee who is still on the legacy free-text bank record so the Bank Master
 * migration has something to migrate.
 *
 * Three facts drive most of what is built here:
 *
 *  1. **A payroll run is per-branch.** `POST /payrolls` refuses unless one
 *     concrete branch is selected, so every spec sends `x-branch-id` and the
 *     fixture must give it more than one branch to get wrong.
 *  2. **A run refuses a period with no attendance captured** — zero rows would
 *     otherwise read as "absent all month" and LOP would wipe every salary. So
 *     attendance for the target period is a prerequisite, not scaffolding.
 *  3. **`Employee.baseSalary` is a PER-DAY rate when `salaryType = 'DAILY'`.**
 *     Both bases must be present in one run, or the daily-wage seam is untested.
 *
 * Everything is tagged with a unique `runId` so `cleanup()` can bulk-delete
 * without touching a shared database's real rows. The two exceptions are called
 * out at `cleanup()`: `CountryBankingField` rows for real countries are SHARED
 * with `bank-change` / `banking-config` and are upserted, never
 * deleted.
 */

const PASSWORD = 'Passw0rd!';

/** A country code no shipped seed uses, for field-config CRUD that must not
 *  disturb the shared IN/OM schemas. ISO-3166 reserves the `X*` range. */
export const SANDBOX_COUNTRY = 'XB';

/** A genuinely valid Oman IBAN (23 chars, bank code "018"). */
export const VALID_OM_IBAN = 'OM810180000001299123456';
/** Same shape, wrong length — fails the mod-97 length rule for OM. */
export const INVALID_OM_IBAN = 'OM8101800000012991234';

export interface PayrollUser {
  userId: string;
  employeeId?: string;
  email: string;
  token: string;
}

export interface Period {
  month: number;
  year: number;
}

export interface PayrollFixtures {
  runId: string;
  password: string;

  /** Primary branch. India, `bankingCountries: ['IN']`. Holds most employees. */
  branchA: string;
  branchAcode: string;
  /** Second branch, for scoping assertions. Holds `branchBEmpId`. */
  branchB: string;
  branchBcode: string;
  /** Oman branch: `country: 'OM'`, `bankingCountries: ['OM']`. */
  branchOm: string;
  branchOmCode: string;

  /** Department the payroll staff belong to, headed by `deptManager`. */
  deptId: string;
  deptCode: string;
  /** A department `deptManager` does NOT head — the manager-scope negative. */
  foreignDeptId: string;
  foreignDeptCode: string;

  /** MONTHLY earner in branch A with a BASIC + an allowance component. */
  monthlyEmpId: string;
  /** A second MONTHLY earner, so "one employee" is never the only shape. */
  secondMonthlyEmpId: string;
  /** DAILY-wage earner in branch A — `baseSalary` is a per-DAY rate. */
  dailyEmpId: string;
  /** ACTIVE, in branch A, with NO bank detail — the payability blocker. */
  noBankEmpId: string;
  /** ACTIVE, legacy `EmployeeProfile.bankName`, no active detail — migratable. */
  migrationCandidateId: string;
  /** INACTIVE: never picked up by a run. */
  terminatedEmpId: string;
  /** In `foreignDept`, branch A — outside the manager's scope. */
  foreignDeptEmpId: string;
  /** The only employee in branch B. */
  branchBEmpId: string;
  /** The only employee in the Oman branch, with an active OM bank detail. */
  omEmpId: string;

  /** Global ADMIN. */
  admin: PayrollUser;
  /** HR_MANAGER, global branch access. */
  hr: PayrollUser;
  /** HR_MANAGER scoped to branch A only. */
  scopedHr: PayrollUser;
  /** MANAGER heading `dept`. */
  deptManager: PayrollUser;
  /** MANAGER heading `foreignDept`. */
  foreignManager: PayrollUser;
  /** Plain EMPLOYEE — the user behind `monthlyEmpId`. */
  employee: PayrollUser;
  /** role=EMPLOYEE, but `dailyEmp` and `monthlyEmp` report to them. Approval
   *  authority here is a data-driven assignment, not an RBAC grant. */
  supervisor: PayrollUser;

  /** Bank Master row for IN, active. */
  bankInId: string;
  /** Bank Master row for OM, active, bankCode "018" (matches VALID_OM_IBAN). */
  bankOmId: string;
  /** Bank Master row for IN, INACTIVE — refusal cases. */
  bankInactiveId: string;

  /** EMPLOYMENT_TYPE library label with `payBasis: 'DAILY'`. */
  dailyEmploymentType: string;

  /** The period every branch already has attendance for. */
  period: Period;
  /** `period` shifted by n months — for a second, third… run. */
  periodAt: (offset: number) => Period;

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

/**
 * Every day of `period` that is not a Sunday, as UTC dates. Payroll reads
 * attendance with `date` between the UTC first and last of the month, so the
 * rows have to be built in UTC too — a local-midnight `new Date(y, m, d)` lands
 * on the previous day at positive offsets and silently drops the 1st.
 */
export function workingDatesIn(period: Period): Date[] {
  const out: Date[] = [];
  const last = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  for (let day = 1; day <= last; day++) {
    const d = new Date(Date.UTC(period.year, period.month - 1, day));
    if (d.getUTCDay() !== 0) out.push(d);
  }
  return out;
}

/**
 * Marks `employeeIds` PRESENT for every non-Sunday of `period`.
 *
 * Idempotent (`skipDuplicates` against `unique_employee_date`), so a spec that
 * needs a second period can call this again without unpicking what setup did.
 * Uses the Prisma client directly rather than the attendance API: the API applies
 * geofences, grace windows and day-boundary routing, none of which payroll cares
 * about, and all of which would make the fixture fragile.
 */
export async function seedAttendance(
  prisma: any,
  employeeIds: string[],
  branchId: string,
  period: Period,
  status = 'PRESENT',
): Promise<number> {
  const dates = workingDatesIn(period);
  const rows = employeeIds.flatMap((employeeId) =>
    dates.map((date) => ({ employeeId, branchId, date, status })),
  );
  const res = await prisma.attendance.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return res.count;
}

export async function setupPayrollFixtures(
  ctx: E2EContext,
): Promise<PayrollFixtures> {
  const { prisma } = ctx;
  const runId = `pay${Date.now()}`;
  const hash = await bcrypt.hash(PASSWORD, 10);

  // Far enough out that no seeded, demo or sibling-suite payroll can collide,
  // and far enough from `daily-wage-overtime`'s 11/2029 to stay independent.
  const period: Period = { month: 6, year: 2032 };
  const periodAt = (offset: number): Period => {
    const zero = (period.year * 12 + (period.month - 1)) + offset;
    return { month: (zero % 12) + 1, year: Math.floor(zero / 12) };
  };

  // ── Branches ──────────────────────────────────────────────────────────────
  const branchAcode = `PAY-A-${runId}`;
  const branchBcode = `PAY-B-${runId}`;
  const branchOmCode = `PAY-OM-${runId}`;

  const branchA = await prisma.branch.create({
    data: {
      code: branchAcode,
      name: 'Payroll Branch A',
      isActive: true,
      country: 'IN',
      bankingCountries: ['IN'],
      timezone: 'Asia/Kolkata',
      officeStartTime: '09:00',
      officeEndTime: '18:00',
      // Sunday only, so the number of work days in the period is deterministic
      // and independent of the global calendar_weekly_holidays setting.
      weeklyOffDays: '0',
    },
  });
  const branchB = await prisma.branch.create({
    data: {
      code: branchBcode,
      name: 'Payroll Branch B',
      isActive: true,
      country: 'IN',
      bankingCountries: ['IN'],
      timezone: 'Asia/Kolkata',
      weeklyOffDays: '0',
    },
  });
  const branchOm = await prisma.branch.create({
    data: {
      code: branchOmCode,
      name: 'Payroll Branch Muscat',
      isActive: true,
      country: 'OM',
      bankingCountries: ['OM'],
      timezone: 'Asia/Muscat',
      // Oman works Sun–Thu: Friday (5) and Saturday (6) are the weekly off.
      weeklyOffDays: '5,6',
    },
  });

  // ── Departments ───────────────────────────────────────────────────────────
  const deptCode = `PAY-D-${runId}`;
  const foreignDeptCode = `PAY-FD-${runId}`;
  const dept = await prisma.department.create({
    data: { code: deptCode, name: `Payroll Dept ${runId}`, isActive: true },
  });
  const foreignDept = await prisma.department.create({
    data: {
      code: foreignDeptCode,
      name: `Payroll Foreign Dept ${runId}`,
      isActive: true,
    },
  });

  // ── Employment types ──────────────────────────────────────────────────────
  // EMPLOYMENT_TYPE rows are global, not branch-scoped, so they are tagged and
  // removed in cleanup — a run that leaves one behind pollutes every later run.
  const dailyEmploymentType = `Payroll Daily ${runId}`;
  await prisma.libraryItem.create({
    data: {
      libraryType: 'EMPLOYMENT_TYPE',
      label: dailyEmploymentType,
      payBasis: 'DAILY',
      isActive: true,
    },
  });

  // ── Employees ─────────────────────────────────────────────────────────────
  const mkEmployee = (suffix: string, over: Record<string, any> = {}): any => ({
    employeeCode: `PAY-${runId}-${suffix}`,
    fullName: `Payroll ${suffix}`,
    dateOfBirth: new Date('1992-01-01'),
    idCard: `PAY-ID-${runId}-${suffix}`,
    email: `${suffix.toLowerCase()}-${runId}@test.local`,
    departmentId: dept.id,
    branchId: branchA.id,
    position: 'Engineer',
    startDate: new Date('2020-01-01'),
    baseSalary: 60000,
    salaryType: 'MONTHLY',
    status: 'ACTIVE',
    ...over,
  });

  const monthlyEmp = await prisma.employee.create({
    data: mkEmployee('MONTHLY'),
  });
  const secondMonthlyEmp = await prisma.employee.create({
    data: mkEmployee('MONTHLY2', { baseSalary: 45000 }),
  });
  const dailyEmp = await prisma.employee.create({
    data: mkEmployee('DAILY', {
      // A per-DAY rate, not a monthly amount. 800/day.
      baseSalary: 800,
      salaryType: 'DAILY',
      employmentType: dailyEmploymentType,
      position: 'Site Worker',
    }),
  });
  const noBankEmp = await prisma.employee.create({
    data: mkEmployee('NOBANK', { baseSalary: 30000 }),
  });
  const migrationCandidate = await prisma.employee.create({
    data: mkEmployee('MIGRATE', { baseSalary: 35000 }),
  });
  const terminatedEmp = await prisma.employee.create({
    data: mkEmployee('TERMINATED', { status: 'INACTIVE' }),
  });
  const foreignDeptEmp = await prisma.employee.create({
    data: mkEmployee('FOREIGNDEPT', { departmentId: foreignDept.id }),
  });
  const branchBEmp = await prisma.employee.create({
    data: mkEmployee('BRANCHB', { branchId: branchB.id, baseSalary: 55000 }),
  });
  const omEmp = await prisma.employee.create({
    data: mkEmployee('OMAN', { branchId: branchOm.id, baseSalary: 900 }),
  });

  // Staff behind the privileged users. They are employees too, so a run that
  // covers "everyone in branch A" covers them — which is realistic, and keeps
  // the item count honest.
  const hrEmp = await prisma.employee.create({
    data: mkEmployee('HR', { position: 'HR Manager' }),
  });
  const scopedHrEmp = await prisma.employee.create({
    data: mkEmployee('SHR', { position: 'HR Officer' }),
  });
  const managerEmp = await prisma.employee.create({
    data: mkEmployee('MGR', { position: 'Head of Payroll Dept' }),
  });
  const foreignManagerEmp = await prisma.employee.create({
    data: mkEmployee('FMGR', {
      departmentId: foreignDept.id,
      position: 'Head of Foreign Dept',
    }),
  });
  const supervisorEmp = await prisma.employee.create({
    data: mkEmployee('SUP', { position: 'Supervisor' }),
  });

  await prisma.department.update({
    where: { id: dept.id },
    data: { managerId: managerEmp.id },
  });
  await prisma.department.update({
    where: { id: foreignDept.id },
    data: { managerId: foreignManagerEmp.id },
  });

  // The SUPERVISOR step of a BANK_CHANGE chain resolves through this edge.
  await prisma.employee.updateMany({
    where: { id: { in: [monthlyEmp.id, dailyEmp.id, migrationCandidate.id] } },
    data: { supervisorId: supervisorEmp.id },
  });

  // The legacy free-text bank record the Bank Master migration exists to replace.
  await prisma.employeeProfile.create({
    data: {
      employeeId: migrationCandidate.id,
      bankName: 'Legacy State Bank',
      bankBranch: 'Legacy Branch',
      bankAccountNumber: '000111222333',
      bankAccountHolderName: `Payroll MIGRATE`,
    },
  });

  // ── Salary components ─────────────────────────────────────────────────────
  // BASIC is the only code the engine treats as the basic part of the contracted
  // rate; anything else sums as an allowance. One of each, so both paths are live.
  await prisma.salaryComponent.createMany({
    data: [
      {
        employeeId: monthlyEmp.id,
        componentType: 'BASIC',
        amount: 30000,
        effectiveDate: new Date('2020-01-01'),
        isActive: true,
      },
      {
        employeeId: monthlyEmp.id,
        componentType: 'HOUSING',
        amount: 8000,
        effectiveDate: new Date('2020-01-01'),
        isActive: true,
      },
      {
        employeeId: secondMonthlyEmp.id,
        componentType: 'BASIC',
        amount: 22000,
        effectiveDate: new Date('2020-01-01'),
        isActive: true,
      },
    ],
  });

  // ── Attendance for the target period ──────────────────────────────────────
  // Without this every run 400s: "Attendance for M/Y has not been processed yet."
  const branchAEmployeeIds = [
    monthlyEmp.id,
    secondMonthlyEmp.id,
    dailyEmp.id,
    noBankEmp.id,
    migrationCandidate.id,
    foreignDeptEmp.id,
    hrEmp.id,
    scopedHrEmp.id,
    managerEmp.id,
    foreignManagerEmp.id,
    supervisorEmp.id,
  ];
  await seedAttendance(prisma, branchAEmployeeIds, branchA.id, period);
  await seedAttendance(prisma, [branchBEmp.id], branchB.id, period);
  await seedAttendance(prisma, [omEmp.id], branchOm.id, period);

  // ── Bank Master + banking field schemas ───────────────────────────────────
  const bankIn = await prisma.bank.create({
    data: {
      country: 'IN',
      name: `Payroll Test Bank IN ${runId}`,
      bankCode: 'PTB',
      swift: 'PTBIINBB',
      isActive: true,
    },
  });
  const bankOm = await prisma.bank.create({
    data: {
      country: 'OM',
      // bankCode 018 is the code embedded in VALID_OM_IBAN positions 5-7, so the
      // IBAN cross-check in validateBankingData passes against this row.
      name: `Payroll Test Bank OM ${runId}`,
      bankCode: '018',
      swift: 'PTBOOMRX',
      isActive: true,
    },
  });
  const bankInactive = await prisma.bank.create({
    data: {
      country: 'IN',
      name: `Payroll Retired Bank ${runId}`,
      bankCode: 'PRB',
      isActive: false,
    },
  });

  // Shared with bank-change / banking-config: UPSERTED, never created
  // outright, and never deleted in cleanup. A suite that owns these rows would
  // break every sibling that assumes they exist.
  const upsertField = (
    country: string,
    fieldKey: string,
    data: {
      label: string;
      validationType: string;
      required: boolean;
      displayOrder: number;
      isSensitive: boolean;
    },
  ) =>
    prisma.countryBankingField.upsert({
      where: { country_fieldKey: { country, fieldKey } },
      update: {},
      create: { country, fieldKey, ...data },
    });

  await upsertField('OM', 'accountHolderName', {
    label: 'Account Holder Name',
    validationType: 'NONE',
    required: true,
    displayOrder: 1,
    isSensitive: false,
  });
  await upsertField('OM', 'iban', {
    label: 'IBAN',
    validationType: 'IBAN',
    required: true,
    displayOrder: 2,
    isSensitive: true,
  });
  await upsertField('IN', 'accountHolderName', {
    label: 'Account Holder Name',
    validationType: 'NONE',
    required: true,
    displayOrder: 1,
    isSensitive: false,
  });
  await upsertField('IN', 'accountNumber', {
    label: 'Account Number',
    validationType: 'NUMBER',
    required: true,
    displayOrder: 2,
    isSensitive: true,
  });
  await upsertField('IN', 'ifsc', {
    label: 'IFSC',
    validationType: 'IFSC',
    required: true,
    displayOrder: 3,
    isSensitive: false,
  });

  // The Oman employee starts with a bank detail already in place, so the freeze
  // guard has a payable employee to work with from the first case.
  await prisma.employeeBankDetail.create({
    data: {
      employeeId: omEmp.id,
      bankId: bankOm.id,
      branchId: branchOm.id,
      data: {
        accountHolderName: 'Payroll OMAN',
        iban: VALID_OM_IBAN,
      },
      iban: VALID_OM_IBAN,
      accountHolderName: 'Payroll OMAN',
      isActive: true,
      source: 'MIGRATION',
    },
  });

  // ── Users ─────────────────────────────────────────────────────────────────
  const mkUser = (
    suffix: string,
    role: string,
    over: Record<string, any> = {},
  ) =>
    prisma.user.create({
      data: {
        email: `u-${suffix.toLowerCase()}-${runId}@test.local`,
        passwordHash: hash,
        role,
        isActive: true,
        isGlobalBranchAccess: true,
        ...over,
      },
    });

  const adminUser = await mkUser('ADMIN', 'ADMIN');
  const hrUser = await mkUser('HR', 'HR_MANAGER', { employeeId: hrEmp.id });
  const scopedHrUser = await mkUser('SHR', 'HR_MANAGER', {
    employeeId: scopedHrEmp.id,
    isGlobalBranchAccess: false,
    branchAccess: { create: [{ branchId: branchA.id }] },
  });
  const managerUser = await mkUser('MGR', 'MANAGER', {
    employeeId: managerEmp.id,
  });
  const foreignManagerUser = await mkUser('FMGR', 'MANAGER', {
    employeeId: foreignManagerEmp.id,
  });
  const employeeUser = await mkUser('EMP', 'EMPLOYEE', {
    employeeId: monthlyEmp.id,
    isGlobalBranchAccess: false,
  });
  const supervisorUser = await mkUser('SUP', 'EMPLOYEE', {
    employeeId: supervisorEmp.id,
    isGlobalBranchAccess: false,
  });

  const fixtures: PayrollFixtures = {
    runId,
    password: PASSWORD,

    branchA: branchA.id,
    branchAcode,
    branchB: branchB.id,
    branchBcode,
    branchOm: branchOm.id,
    branchOmCode,

    deptId: dept.id,
    deptCode,
    foreignDeptId: foreignDept.id,
    foreignDeptCode,

    monthlyEmpId: monthlyEmp.id,
    secondMonthlyEmpId: secondMonthlyEmp.id,
    dailyEmpId: dailyEmp.id,
    noBankEmpId: noBankEmp.id,
    migrationCandidateId: migrationCandidate.id,
    terminatedEmpId: terminatedEmp.id,
    foreignDeptEmpId: foreignDeptEmp.id,
    branchBEmpId: branchBEmp.id,
    omEmpId: omEmp.id,

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
    deptManager: {
      userId: managerUser.id,
      employeeId: managerEmp.id,
      email: managerUser.email,
      token: await login(ctx, managerUser.email),
    },
    foreignManager: {
      userId: foreignManagerUser.id,
      employeeId: foreignManagerEmp.id,
      email: foreignManagerUser.email,
      token: await login(ctx, foreignManagerUser.email),
    },
    employee: {
      userId: employeeUser.id,
      employeeId: monthlyEmp.id,
      email: employeeUser.email,
      token: await login(ctx, employeeUser.email),
    },
    supervisor: {
      userId: supervisorUser.id,
      employeeId: supervisorEmp.id,
      email: supervisorUser.email,
      token: await login(ctx, supervisorUser.email),
    },

    bankInId: bankIn.id,
    bankOmId: bankOm.id,
    bankInactiveId: bankInactive.id,

    dailyEmploymentType,

    period,
    periodAt,

    cleanup: async () => {
      // FK-ordered, children first. One edge dictates most of this:
      // RequestApproval has NO foreign key to the request it describes, so
      // approval trails have to be removed by requestId explicitly or they
      // outlive everything.
      const empWhere = {
        OR: [
          { employeeCode: { contains: runId } },
          { email: { contains: runId } },
        ],
      };
      const employeeIds = (
        await prisma.employee.findMany({
          where: empWhere,
          select: { id: true },
        })
      ).map((e: { id: string }) => e.id);
      const empIn = { employeeId: { in: employeeIds } };
      const branchIds = [branchA.id, branchB.id, branchOm.id];

      // Approval trails for every bank-change request this run raised.
      const bankChangeIds = (
        await prisma.bankChangeRequest.findMany({
          where: empIn,
          select: { id: true },
        })
      ).map((r: { id: string }) => r.id);
      if (bankChangeIds.length) {
        await prisma.requestApproval.deleteMany({
          where: { requestId: { in: bankChangeIds } },
        });
      }
      await prisma.bankChangeRequest.deleteMany({ where: empIn });
      await prisma.employeeBankDetail.deleteMany({ where: empIn });
      await prisma.bank.deleteMany({ where: { name: { contains: runId } } });
      // CountryBankingField for real countries is SHARED — only the sandbox
      // country's rows belong to this run.
      await prisma.countryBankingField.deleteMany({
        where: { country: SANDBOX_COUNTRY },
      });

      // Payroll: items -> payrolls -> batch members -> batches.
      await prisma.payrollItem.deleteMany({ where: empIn });
      await prisma.payroll.deleteMany({
        where: { branchId: { in: branchIds } },
      });
      await prisma.payrollBatchMember.deleteMany({ where: empIn });
      await prisma.payrollBatch.deleteMany({
        where: { branchId: { in: branchIds } },
      });

      await prisma.salaryComponent.deleteMany({ where: empIn });
      await prisma.leaveRequest.deleteMany({ where: empIn });
      await prisma.overtimeRequest.deleteMany({ where: empIn });
      await prisma.attendance.deleteMany({ where: empIn });
      await prisma.employeeHistory.deleteMany({ where: empIn });
      await prisma.employeeProfile.deleteMany({ where: empIn });

      await prisma.auditLog.deleteMany({
        where: { user: { email: { contains: runId } } },
      });
      await prisma.user.deleteMany({ where: { email: { contains: runId } } });

      // Detach headships before the employees go — Department.manager is SetNull,
      // but being explicit keeps the order's intent readable.
      await prisma.department.updateMany({
        where: { manager: empWhere },
        data: { managerId: null },
      });
      await prisma.employee.deleteMany({ where: empWhere });

      await prisma.libraryItem.deleteMany({
        where: { label: { contains: runId } },
      });
      await prisma.holiday.deleteMany({
        where: { branchId: { in: branchIds } },
      });
      await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
      await prisma.department.deleteMany({
        where: { code: { contains: runId } },
      });
    },
  };

  return fixtures;
}

export { bearer } from './settings';
