import * as bcrypt from 'bcrypt';
import { E2EContext } from './e2e-app';

/**
 * The Finance module's own fixture set: reimbursements, travel, advances &
 * loans, loan reports, budgets and bank migration.
 *
 * Deliberately separate from `utils/fixtures.ts` and `utils/org-fixtures.ts`.
 * Finance needs three things neither of those provides:
 *
 *  1. **Employees shaped for the eligibility engine.** Ten of the rules under
 *     test are expressed as "this employee cannot" — inactive, resigned, too
 *     new, already at the active-loan ceiling. A fixture set with one healthy
 *     employee can only ever exercise the happy path.
 *  2. **Reference data the modules cannot run without.** A travel request with
 *     no `PER_DIEM_DESTINATION` spawns no claim; a budget with no
 *     `BUDGET_CATEGORY` has nothing to plan against; the bank screens are inert
 *     without a `Bank` and a `CountryBankingField` schema. None of this is in
 *     the base seed.
 *  3. **A foreign branch that actually holds finance rows.** Every scoping case
 *     needs a subject the caller must NOT see. `branchB` here is populated, not
 *     decorative.
 *
 * Authorization in Finance is TWO gates — the `@Roles()` decorator and a CSV
 * role list in `system_settings` read at runtime. `financeRoleUsers` below gives
 * one principal per interesting position in that matrix, so a case can prove
 * which gate refused.
 *
 * Everything is tagged with a unique `runId` so `cleanup()` can bulk-delete
 * without touching a shared database's real rows.
 */

const PASSWORD = 'Passw0rd!';

/** ISO-2 used for every banking fixture. Matches the Oman-first product bias. */
export const FIN_COUNTRY = 'OM';

/** A destination WITH a rate — approving a trip here must spawn a per-diem claim. */
export const RATED_DESTINATION = 'E2E Muscat';
/**
 * A destination with rate 0. `Decimal(0)` is a truthy object, so a service that
 * writes `if (rate)` instead of `Number(rate) > 0` spawns a zero-value claim
 * here. That is the case this fixture exists for.
 */
export const ZERO_RATE_DESTINATION = 'E2E Zero Rate';

export interface FinanceUser {
  userId: string;
  employeeId?: string;
  email: string;
  token: string;
}

export interface FinanceFixtures {
  runId: string;
  password: string;

  /** Branch holding most fixtures. The scoped HR can see this one. */
  branchA: string;
  branchAcode: string;
  /** Foreign branch. Populated — every scoping case needs a real subject here. */
  branchB: string;
  branchBcode: string;

  /** Department the finance manager heads, in branch A. */
  finDeptId: string;
  finDeptCode: string;
  /** A department the finance manager does NOT head. */
  otherDeptId: string;
  otherDeptCode: string;

  // --- Employees, one per eligibility shape -------------------------------
  /** ACTIVE, long tenure, salaried. The subject of every happy path. */
  earnerId: string;
  /** ACTIVE, started 2 months ago — trips the MIN_SERVICE rule. */
  newJoinerId: string;
  /** status INACTIVE — trips EMPLOYEE_ACTIVE. */
  inactiveId: string;
  /** ACTIVE with an endDate in the past — trips NOT_AFTER_RESIGNATION. */
  resignedId: string;
  /** In branch B. The subject a branch-A caller must never reach. */
  foreignId: string;
  /** In `otherDept`, branch A. The subject a department manager must not decide. */
  otherDeptEmployeeId: string;

  // --- Principals ---------------------------------------------------------
  /** ADMIN, global branch access. */
  admin: FinanceUser;
  /** HR_MANAGER, global branch access — the unscoped approver. */
  hrGlobal: FinanceUser;
  /** HR_MANAGER scoped to branch A only. Proves branch isolation. */
  hrScoped: FinanceUser;
  /** MANAGER heading `finDept`. In the approver settings only when a case says so. */
  manager: FinanceUser;
  /** MANAGER heading `otherDept` — the out-of-scope approver. */
  foreignManager: FinanceUser;
  /** EMPLOYEE, linked to `earner`. The requester. */
  employee: FinanceUser;
  /** EMPLOYEE in branch B, linked to `foreign`. */
  foreignEmployee: FinanceUser;
  /**
   * EMPLOYEE whose user id goes in `advance_loan_auditor_user_ids` — read-all,
   * write-nothing. The only role in Finance granted by user id rather than role.
   */
  auditor: FinanceUser;

  // --- Reference data -----------------------------------------------------
  /** Active bank in `FIN_COUNTRY`, with a bankCode so IBANs can be built. */
  bankId: string;
  bankCode: string;
  /** A second, INACTIVE bank — selecting it must be refused. */
  inactiveBankId: string;
  /** Bank in a country branch A does NOT allow. */
  foreignCountryBankId: string;
  /** `CountryBankingField` ids for `FIN_COUNTRY`, in display order. */
  bankFieldIds: string[];

  /** ACTIVE budget on branch A for the current fiscal year. */
  budgetId: string;
  /** Line scoped to `finDept`, category Travel. */
  budgetDeptLineId: string;
  /** Line with departmentId null — the company-wide fallback. */
  budgetFallbackLineId: string;

  /** `PER_DIEM_DESTINATION` library ids. */
  ratedDestinationId: string;
  zeroRateDestinationId: string;

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

/** Months before today, as a Date. Keeps tenure fixtures readable. */
function monthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function setupFinanceFixtures(
  ctx: E2EContext,
): Promise<FinanceFixtures> {
  const { prisma } = ctx;
  const runId = `fin${Date.now()}`;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const fiscalYear = new Date().getFullYear();

  // --- Branches -----------------------------------------------------------
  const branchAcode = `E2E-FIN-A-${runId}`;
  const branchBcode = `E2E-FIN-B-${runId}`;
  const branchA = await prisma.branch.create({
    data: {
      code: branchAcode,
      name: 'E2E Finance Branch A',
      isActive: true,
      country: FIN_COUNTRY,
      timezone: 'Asia/Muscat',
      bankingCountries: [FIN_COUNTRY],
    },
  });
  const branchB = await prisma.branch.create({
    data: {
      code: branchBcode,
      name: 'E2E Finance Branch B',
      isActive: true,
      country: FIN_COUNTRY,
      timezone: 'Asia/Muscat',
      bankingCountries: [FIN_COUNTRY],
    },
  });

  // --- Departments --------------------------------------------------------
  const finDeptCode = `E2E-FIN-D1-${runId}`;
  const otherDeptCode = `E2E-FIN-D2-${runId}`;
  const finDept = await prisma.department.create({
    data: { code: finDeptCode, name: `E2E Finance Dept ${runId}`, isActive: true },
  });
  const otherDept = await prisma.department.create({
    data: { code: otherDeptCode, name: `E2E Other Dept ${runId}`, isActive: true },
  });

  // --- Employees ----------------------------------------------------------
  const mkEmployee = (
    tag: string,
    over: Record<string, unknown> = {},
  ) =>
    prisma.employee.create({
      data: {
        employeeCode: `EMP-${runId}-${tag}`,
        fullName: `E2E ${tag}`,
        dateOfBirth: new Date('1990-01-01'),
        idCard: `ID-${runId}-${tag}`,
        email: `${tag.toLowerCase()}-${runId}@test.local`,
        departmentId: finDept.id,
        branchId: branchA.id,
        position: 'Engineer',
        startDate: monthsAgo(36),
        baseSalary: 1000,
        status: 'ACTIVE',
        ...over,
      },
    });

  const earner = await mkEmployee('EARNER');
  const newJoiner = await mkEmployee('NEWJOINER', { startDate: monthsAgo(2) });
  const inactive = await mkEmployee('INACTIVE', { status: 'INACTIVE' });
  const resigned = await mkEmployee('RESIGNED', {
    endDate: monthsAgo(1),
  });
  const foreign = await mkEmployee('FOREIGN', { branchId: branchB.id });
  const otherDeptEmployee = await mkEmployee('OTHERDEPT', {
    departmentId: otherDept.id,
  });
  const hrEmp = await mkEmployee('HREMP');
  const managerEmp = await mkEmployee('MGR');
  const foreignManagerEmp = await mkEmployee('FMGR', {
    departmentId: otherDept.id,
  });
  const auditorEmp = await mkEmployee('AUDITOR');

  await prisma.department.update({
    where: { id: finDept.id },
    data: { managerId: managerEmp.id },
  });
  await prisma.department.update({
    where: { id: otherDept.id },
    data: { managerId: foreignManagerEmp.id },
  });

  // --- Users --------------------------------------------------------------
  const mkUser = (
    tag: string,
    role: string,
    over: Record<string, unknown> = {},
  ) =>
    prisma.user.create({
      data: {
        email: `${tag}-${runId}@test.local`,
        passwordHash: hash,
        role,
        isActive: true,
        isGlobalBranchAccess: false,
        ...over,
      },
    });

  const adminUser = await mkUser('finadmin', 'ADMIN', {
    isGlobalBranchAccess: true,
  });
  const hrGlobalUser = await mkUser('finhrg', 'HR_MANAGER', {
    isGlobalBranchAccess: true,
  });
  const hrScopedUser = await mkUser('finhrs', 'HR_MANAGER', {
    employeeId: hrEmp.id,
    branchAccess: { create: [{ branchId: branchA.id }] },
  });
  const managerUser = await mkUser('finmgr', 'MANAGER', {
    employeeId: managerEmp.id,
    branchAccess: { create: [{ branchId: branchA.id }] },
  });
  const foreignManagerUser = await mkUser('finfmgr', 'MANAGER', {
    employeeId: foreignManagerEmp.id,
    branchAccess: { create: [{ branchId: branchA.id }] },
  });
  const employeeUser = await mkUser('finemp', 'EMPLOYEE', {
    employeeId: earner.id,
  });
  const foreignEmployeeUser = await mkUser('finfemp', 'EMPLOYEE', {
    employeeId: foreign.id,
    branchAccess: { create: [{ branchId: branchB.id }] },
  });
  const auditorUser = await mkUser('finaud', 'EMPLOYEE', {
    employeeId: auditorEmp.id,
  });

  const userIds = [
    adminUser.id,
    hrGlobalUser.id,
    hrScopedUser.id,
    managerUser.id,
    foreignManagerUser.id,
    employeeUser.id,
    foreignEmployeeUser.id,
    auditorUser.id,
  ];

  // --- Banking reference data --------------------------------------------
  // Bank Muscat's real CBO code. Used so a generated IBAN passes the
  // bank-code cross-check the live path performs — a made-up code would fail
  // validation for the wrong reason.
  const bankCode = '018';
  const bank = await prisma.bank.create({
    data: {
      country: FIN_COUNTRY,
      name: `E2E Bank ${runId}`,
      bankCode,
      swift: 'BMUSOMRX',
      isActive: true,
    },
  });
  const inactiveBank = await prisma.bank.create({
    data: {
      country: FIN_COUNTRY,
      name: `E2E Inactive Bank ${runId}`,
      bankCode: '046',
      isActive: false,
    },
  });
  const foreignCountryBank = await prisma.bank.create({
    data: {
      country: 'AE',
      name: `E2E Foreign Bank ${runId}`,
      bankCode: '033',
      isActive: true,
    },
  });

  // The country field schema is global (not branch-scoped) and shared with the
  // rest of the suite, so only create rows that do not already exist.
  const bankFieldIds: string[] = [];
  const fieldSpecs = [
    {
      fieldKey: 'iban',
      label: 'IBAN',
      validationType: 'IBAN',
      required: true,
      displayOrder: 1,
    },
    {
      fieldKey: 'accountName',
      label: 'Account name',
      validationType: 'NONE',
      required: false,
      displayOrder: 2,
    },
  ];
  for (const spec of fieldSpecs) {
    const row = await prisma.countryBankingField.upsert({
      where: {
        country_fieldKey: { country: FIN_COUNTRY, fieldKey: spec.fieldKey },
      },
      create: { country: FIN_COUNTRY, ...spec },
      update: { isActive: true },
    });
    bankFieldIds.push(row.id);
  }

  // --- Library reference data --------------------------------------------
  // `LibraryItem` is unique on (libraryType, label) and is a SHARED list — the
  // base seed already ships budget categories, and a second suite may have run
  // first. Upsert rather than create, or the fixture is a coin toss.
  const upsertLibraryItem = (
    libraryType: 'PER_DIEM_DESTINATION' | 'BUDGET_CATEGORY',
    label: string,
    extra: Record<string, unknown> = {},
  ) =>
    prisma.libraryItem.upsert({
      where: { libraryType_label: { libraryType, label } },
      update: { isActive: true, ...extra },
      create: { libraryType, label, isActive: true, ...extra },
    });

  const ratedDestination = await upsertLibraryItem(
    'PER_DIEM_DESTINATION',
    RATED_DESTINATION,
    { perDiemRate: 25 },
  );
  const zeroRateDestination = await upsertLibraryItem(
    'PER_DIEM_DESTINATION',
    ZERO_RATE_DESTINATION,
    { perDiemRate: 0 },
  );
  for (const label of ['Travel', 'Training', 'Payroll', 'Overtime']) {
    await upsertLibraryItem('BUDGET_CATEGORY', label);
  }

  // --- Budget -------------------------------------------------------------
  const budget = await prisma.budget.create({
    data: {
      name: `E2E Budget ${runId}`,
      fiscalYear,
      startDate: new Date(`${fiscalYear}-01-01`),
      endDate: new Date(`${fiscalYear}-12-31`),
      branchId: branchA.id,
      currency: 'OMR',
      status: 'ACTIVE',
      createdById: adminUser.id,
    },
  });
  const budgetDeptLine = await prisma.budgetLine.create({
    data: {
      budgetId: budget.id,
      departmentId: finDept.id,
      category: 'Travel',
      plannedAmount: 10000,
    },
  });
  const budgetFallbackLine = await prisma.budgetLine.create({
    data: {
      budgetId: budget.id,
      departmentId: null,
      category: 'Travel',
      plannedAmount: 5000,
    },
  });

  const employeeWhere = {
    OR: [
      { employeeCode: { contains: runId } },
      { email: { contains: runId } },
    ],
  };

  return {
    runId,
    password: PASSWORD,
    branchA: branchA.id,
    branchAcode,
    branchB: branchB.id,
    branchBcode,
    finDeptId: finDept.id,
    finDeptCode,
    otherDeptId: otherDept.id,
    otherDeptCode,

    earnerId: earner.id,
    newJoinerId: newJoiner.id,
    inactiveId: inactive.id,
    resignedId: resigned.id,
    foreignId: foreign.id,
    otherDeptEmployeeId: otherDeptEmployee.id,

    admin: {
      userId: adminUser.id,
      email: adminUser.email,
      token: await login(ctx, adminUser.email),
    },
    hrGlobal: {
      userId: hrGlobalUser.id,
      email: hrGlobalUser.email,
      token: await login(ctx, hrGlobalUser.email),
    },
    hrScoped: {
      userId: hrScopedUser.id,
      employeeId: hrEmp.id,
      email: hrScopedUser.email,
      token: await login(ctx, hrScopedUser.email),
    },
    manager: {
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
      employeeId: earner.id,
      email: employeeUser.email,
      token: await login(ctx, employeeUser.email),
    },
    foreignEmployee: {
      userId: foreignEmployeeUser.id,
      employeeId: foreign.id,
      email: foreignEmployeeUser.email,
      token: await login(ctx, foreignEmployeeUser.email),
    },
    auditor: {
      userId: auditorUser.id,
      employeeId: auditorEmp.id,
      email: auditorUser.email,
      token: await login(ctx, auditorUser.email),
    },

    bankId: bank.id,
    bankCode,
    inactiveBankId: inactiveBank.id,
    foreignCountryBankId: foreignCountryBank.id,
    bankFieldIds,

    budgetId: budget.id,
    budgetDeptLineId: budgetDeptLine.id,
    budgetFallbackLineId: budgetFallbackLine.id,

    ratedDestinationId: ratedDestination.id,
    zeroRateDestinationId: zeroRateDestination.id,

    /**
     * FK-ordered teardown. Order is not cosmetic: loans are `onDelete: Restrict`
     * on the employee (loan history has to outlive the person for statutory
     * audit), so the whole loan graph must go before any employee can.
     */
    cleanup: async () => {
      const loanWhere = { request: { employee: employeeWhere } };

      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });

      // Budgets: commitments -> lines -> budget.
      await prisma.budgetCommitment.deleteMany({
        where: { line: { budget: { branchId: { in: [branchA.id, branchB.id] } } } },
      });
      await prisma.budgetLine.deleteMany({
        where: { budget: { branchId: { in: [branchA.id, branchB.id] } } },
      });
      await prisma.budget.deleteMany({
        where: { branchId: { in: [branchA.id, branchB.id] } },
      });

      // Travel: itineraries -> requests. Requests hold advanceLoanId, which is
      // SetNull, so they can go before the loan graph.
      await prisma.travelItinerary.deleteMany({
        where: { travel: { employee: employeeWhere } },
      });
      await prisma.travelRequest.deleteMany({
        where: { employee: employeeWhere },
      });

      // Reimbursements: attachments -> claims.
      await prisma.reimbursementAttachment.deleteMany({
        where: { reimbursement: { employee: employeeWhere } },
      });
      await prisma.reimbursement.deleteMany({
        where: { employee: employeeWhere },
      });

      // Banking: requests and details before the banks they point at.
      await prisma.bankChangeRequest.deleteMany({
        where: { employee: employeeWhere },
      });
      await prisma.employeeBankDetail.deleteMany({
        where: { employee: employeeWhere },
      });
      await prisma.bank.deleteMany({ where: { name: { contains: runId } } });

      // Approval trails are polymorphic with no FK to the domain row, so they
      // are never cascaded — clear them by run tag or they accumulate forever.
      await prisma.requestApproval.deleteMany({
        where: { resolvedApproverId: { in: userIds } },
      });

      // Loans, children first.
      await prisma.advanceLoanNotificationLog.deleteMany({ where: loanWhere });
      await prisma.loanTransaction.deleteMany({ where: loanWhere });
      await prisma.loanRateChange.deleteMany({ where: loanWhere });
      await prisma.advanceLoanDeduction.deleteMany({ where: loanWhere });
      await prisma.advanceLoanAttachment.deleteMany({ where: loanWhere });
      await prisma.loanSchedule.deleteMany({ where: loanWhere });
      await prisma.advanceLoanRequest.deleteMany({
        where: { employee: employeeWhere },
      });
      await prisma.loanSettlement.deleteMany({
        where: { employee: employeeWhere },
      });

      await prisma.libraryItem.deleteMany({
        where: {
          libraryType: 'PER_DIEM_DESTINATION',
          label: { in: [RATED_DESTINATION, ZERO_RATE_DESTINATION] },
        },
      });

      // Payrolls are branch-scoped and block a branch delete. A suite that
      // opens one to exercise the bank edit-lock must not leave the branch
      // undeletable — and `afterEach` in that suite cannot be relied on when an
      // assertion throws first.
      const branchIds = [branchA.id, branchB.id];
      await prisma.payrollItem.deleteMany({
        where: { payroll: { branchId: { in: branchIds } } },
      });
      await prisma.payroll.deleteMany({ where: { branchId: { in: branchIds } } });

      await prisma.user.deleteMany({ where: { email: { contains: runId } } });
      // Departments hold a managerId FK to an employee, so clear it first.
      await prisma.department.updateMany({
        where: { code: { contains: runId } },
        data: { managerId: null },
      });
      await prisma.employee.deleteMany({ where: employeeWhere });
      await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
      await prisma.department.deleteMany({
        where: { code: { contains: runId } },
      });
    },
  };
}
