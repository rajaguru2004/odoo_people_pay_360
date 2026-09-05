import * as bcrypt from 'bcrypt';
import { E2EContext } from './e2e-app';

/**
 * The People module's fixture set: two branches, four departments of the shapes
 * the rules care about, employees of every state a People rule branches on, and
 * the seven actors the role matrix needs.
 *
 * A NEW file rather than an extension of `org-fixtures.ts`, deliberately.
 * `org-fixtures.ts` is shaped by the department hierarchy — a five-department
 * tree, tenure-boundary manager candidates, and a pending leave + overtime pair
 * that exist purely so a change request's impact numbers are exact. People needs
 * none of it and would pay for all of it on every spec. More decisively, its
 * `cleanup()` is a hand-ordered FK teardown; People adds eight more tables that
 * must go before an employee can, and folding them in would mean every
 * Organization spec pays for, and can be broken by, a People FK edge.
 *
 * What IS shared: `bearer` and the settings snapshot helpers, which live in
 * `./settings` and are imported by both.
 *
 * Everything is tagged with a unique `runId` so `cleanup()` can bulk-delete
 * without touching a shared database's real rows.
 */

const PASSWORD = 'Passw0rd!';

export interface PeopleUser {
  userId: string;
  employeeId?: string;
  email: string;
  token: string;
}

export interface PeopleFixtures {
  runId: string;
  password: string;

  /** Branch holding almost every fixture row. */
  branchA: string;
  branchAcode: string;
  /** A second branch. Every "404, no existence leak" assertion points here. */
  branchB: string;
  branchBcode: string;

  /** Top-level, staffed, headed by `manager`. */
  mainDeptId: string;
  mainDeptCode: string;
  /**
   * A CHILD of `mainDept`. Staff may be filed here directly — the employee
   * service gates only on `isActive` — so this is the row that proves a
   * sub-department is a usable home for an employee, in and out.
   */
  teamDeptId: string;
  teamDeptCode: string;
  /** Top-level, in branch B, headed by `foreignManager`. Cross-scope target. */
  foreignDeptId: string;
  foreignDeptCode: string;
  /** Top-level, isActive false — the "cannot assign to inactive" target. */
  inactiveDeptId: string;
  inactiveDeptCode: string;

  /** Three ACTIVE employees of `mainDept`. `activeStaff[0]` backs `employee`. */
  activeStaff: string[];
  /** ACTIVE, in `foreignDept` / branch B. */
  staffBranchBId: string;
  /** TERMINATED and otherwise clean — the hard-delete happy path. */
  terminatedStaffId: string;
  /** TERMINATED, holds an AdvanceLoanRequest — hard delete must refuse. */
  staffWithLoanId: string;
  /** ACTIVE, holds an unreturned AssetAssignment — clearance must refuse. */
  staffWithOpenAssetId: string;
  /** ACTIVE with one ACTIVE contract — the "already has a contract" target. */
  contractedStaffId: string;
  /** The ACTIVE contract belonging to `contractedStaff`. */
  activeContractId: string;
  /** ACTIVE, no contract — `/without-active-contract` and the create path. */
  uncontractedStaffId: string;
  /** ACTIVE, `salaryType: 'DAILY'` — the ~26x overpay guard. */
  dailyWageStaffId: string;
  /** ACTIVE, holds one current VISA. */
  visaHolderId: string;
  /** The current VISA belonging to `visaHolder`. */
  currentVisaId: string;

  /** Org team under `mainDept`, one member. */
  mainTeamId: string;
  mainTeamCode: string;
  /** Org team under `foreignDept` (branch B) — the row that makes P1 assertable. */
  foreignTeamId: string;
  foreignTeamCode: string;
  /**
   * A `type: 'SUPERVISION'` team — the same table the org Teams API reads.
   * `TeamsService.findAll` filters these out, but `findOne`/`update`/`delete`/
   * `addMember` do not, so this row is what proves whether the org door can
   * reach through into approval routing.
   */
  supervisionTeamId: string;

  /** An unreturned asset assignment held by `staffWithOpenAsset`. */
  openAssignmentId: string;
  assetItemId: string;

  /** Global ADMIN. */
  admin: PeopleUser;
  /** HR_MANAGER, global branch access. */
  hr: PeopleUser;
  /** HR_MANAGER scoped to branch A only — every off-grant case uses this. */
  scopedHr: PeopleUser;
  /** MANAGER heading `mainDept`. */
  manager: PeopleUser;
  /** MANAGER heading `foreignDept`. */
  foreignManager: PeopleUser;
  /** Plain EMPLOYEE, linked to `activeStaff[0]`. */
  employee: PeopleUser;
  /** A second plain EMPLOYEE, linked to `activeStaff[1]` — "EMP other". */
  otherEmployee: PeopleUser;

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
const daysFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};
const yearsAgo = (n: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d;
};

export async function setupPeopleFixtures(
  ctx: E2EContext,
): Promise<PeopleFixtures> {
  const { prisma } = ctx;
  const runId = `ppl${Date.now()}`;
  const hash = await bcrypt.hash(PASSWORD, 10);

  // ── Branches ──────────────────────────────────────────────────────────────
  const branchAcode = `PPL-A-${runId}`;
  const branchBcode = `PPL-B-${runId}`;
  const branchA = await prisma.branch.create({
    data: {
      code: branchAcode,
      name: 'People Branch A',
      isActive: true,
      timezone: 'Asia/Kolkata',
      officeStartTime: '09:00',
      officeEndTime: '18:00',
    },
  });
  const branchB = await prisma.branch.create({
    data: { code: branchBcode, name: 'People Branch B', isActive: true },
  });

  // ── Departments ───────────────────────────────────────────────────────────
  const mainDeptCode = `PPL-MAIN-${runId}`;
  const teamDeptCode = `PPL-TEAM-${runId}`;
  const foreignDeptCode = `PPL-FOREIGN-${runId}`;
  const inactiveDeptCode = `PPL-INACTIVE-${runId}`;

  const mainDept = await prisma.department.create({
    data: { code: mainDeptCode, name: 'People Main', isActive: true },
  });
  const teamDept = await prisma.department.create({
    data: {
      code: teamDeptCode,
      name: 'People Team (child)',
      isActive: true,
      parentId: mainDept.id,
    },
  });
  const foreignDept = await prisma.department.create({
    data: { code: foreignDeptCode, name: 'People Foreign', isActive: true },
  });
  const inactiveDept = await prisma.department.create({
    data: { code: inactiveDeptCode, name: 'People Inactive', isActive: false },
  });

  // ── Employees ─────────────────────────────────────────────────────────────
  let seq = 0;
  const mkEmployee = (suffix: string, over: Record<string, unknown> = {}) => ({
    employeeCode: `PEM-${runId}-${suffix}`,
    fullName: `People ${suffix}`,
    dateOfBirth: new Date('1992-01-01'),
    idCard: `PID-${runId}-${suffix}`,
    email: `${suffix.toLowerCase()}-${runId}@test.local`,
    departmentId: mainDept.id,
    branchId: branchA.id,
    position: 'Engineer',
    startDate: monthsAgo(36),
    baseSalary: 50000,
    status: 'ACTIVE',
    ...over,
  });
  const createEmployee = (suffix: string, over: Record<string, unknown> = {}) =>
    prisma.employee.create({ data: mkEmployee(`${suffix}${seq++}`, over) as any });

  const staff1 = await createEmployee('STAFF');
  const staff2 = await createEmployee('STAFF');
  const staff3 = await createEmployee('STAFF');
  const staffBranchB = await createEmployee('BBSTAFF', {
    branchId: branchB.id,
    departmentId: foreignDept.id,
  });
  const terminatedStaff = await createEmployee('TERMED', {
    status: 'TERMINATED',
    endDate: monthsAgo(1),
  });
  const staffWithLoan = await createEmployee('LOANED', {
    status: 'TERMINATED',
    endDate: monthsAgo(1),
  });
  const staffWithOpenAsset = await createEmployee('ASSETED');
  const contractedStaff = await createEmployee('CONTRACTED');
  const uncontractedStaff = await createEmployee('UNCONTRACTED');
  const dailyWageStaff = await createEmployee('DAILY', {
    salaryType: 'DAILY',
    baseSalary: 1000,
  });
  const visaHolder = await createEmployee('VISA');

  // Heads. `manager` heads mainDept; `foreignManager` heads foreignDept, which
  // is what makes "MANAGER out of scope" a real actor and not a synthetic one.
  const headEmp = await createEmployee('HEAD', { position: 'Head of Main' });
  const foreignHeadEmp = await createEmployee('FHEAD', {
    departmentId: foreignDept.id,
    branchId: branchB.id,
    position: 'Head of Foreign',
  });
  const hrEmp = await createEmployee('HREMP');
  const scopedHrEmp = await createEmployee('SCOPEDHR');

  await prisma.department.update({
    where: { id: mainDept.id },
    data: { managerId: headEmp.id },
  });
  await prisma.department.update({
    where: { id: foreignDept.id },
    data: { managerId: foreignHeadEmp.id },
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

  const adminUser = await mkUser('PADMIN', 'ADMIN');
  const hrUser = await mkUser('PHR', 'HR_MANAGER', { employeeId: hrEmp.id });
  const scopedHrUser = await mkUser('PSHR', 'HR_MANAGER', {
    employeeId: scopedHrEmp.id,
    isGlobalBranchAccess: false,
    branchAccess: { create: [{ branchId: branchA.id }] },
  });
  const managerUser = await mkUser('PMGR', 'MANAGER', {
    employeeId: headEmp.id,
  });
  const foreignManagerUser = await mkUser('PFMGR', 'MANAGER', {
    employeeId: foreignHeadEmp.id,
  });
  const employeeUser = await mkUser('PEMP', 'EMPLOYEE', {
    employeeId: staff1.id,
    isGlobalBranchAccess: false,
  });
  const otherEmployeeUser = await mkUser('POEMP', 'EMPLOYEE', {
    employeeId: staff2.id,
    isGlobalBranchAccess: false,
  });

  // ── Contracts ─────────────────────────────────────────────────────────────
  const activeContract = await prisma.contract.create({
    data: {
      employeeId: contractedStaff.id,
      contractType: 'INDEFINITE',
      contractNumber: `PCON-${runId}-1`,
      startDate: monthsAgo(12),
      salary: 50000,
      status: 'ACTIVE',
    },
  });

  // ── Teams ─────────────────────────────────────────────────────────────────
  const mainTeamCode = `PTEAM-${runId}-M`;
  const foreignTeamCode = `PTEAM-${runId}-F`;
  const mainTeam = await prisma.team.create({
    data: {
      name: 'People Main Team',
      code: mainTeamCode,
      departmentId: mainDept.id,
      teamLeadId: staff1.id,
      type: 'PERMANENT',
      members: { create: [{ employeeId: staff1.id, role: 'LEAD' }] },
    },
  });
  const foreignTeam = await prisma.team.create({
    data: {
      name: 'People Foreign Team',
      code: foreignTeamCode,
      departmentId: foreignDept.id,
      type: 'PERMANENT',
    },
  });
  // A supervision team: the same `teams` table the org Teams API reads by id.
  const supervisionTeam = await prisma.team.create({
    data: {
      name: 'People Supervision Team',
      code: `SUP-${runId}`,
      departmentId: mainDept.id,
      teamLeadId: headEmp.id,
      type: 'SUPERVISION',
      members: { create: [{ employeeId: staff3.id, role: 'MEMBER' }] },
    },
  });
  await prisma.employee.update({
    where: { id: staff3.id },
    data: { supervisorId: headEmp.id },
  });

  // ── Visa ──────────────────────────────────────────────────────────────────
  const currentVisa = await prisma.employeeLegalDocument.create({
    data: {
      employeeId: visaHolder.id,
      category: 'VISA',
      documentNumber: `PVISA-${runId}`,
      documentType: 'Employment Visa',
      country: 'Oman',
      issueDate: monthsAgo(12),
      expiryDate: daysFromNow(20),
      status: 'ACTIVE',
      isCurrent: true,
    },
  });

  // ── Clearance blockers ────────────────────────────────────────────────────
  const assetItem = await prisma.assetItem.create({
    data: {
      assetTag: `PASSET-${runId}`,
      category: 'Laptop',
      name: 'People Fixture Laptop',
      branchId: branchA.id,
      status: 'ASSIGNED',
    },
  });
  const openAssignment = await prisma.assetAssignment.create({
    data: {
      assetId: assetItem.id,
      employeeId: staffWithOpenAsset.id,
      assignedAt: monthsAgo(2),
      assignedById: adminUser.id,
      returnedAt: null,
    },
  });

  const userEmails = [
    adminUser.email,
    hrUser.email,
    scopedHrUser.email,
    managerUser.email,
    foreignManagerUser.email,
    employeeUser.email,
    otherEmployeeUser.email,
  ];

  const fixtures: PeopleFixtures = {
    runId,
    password: PASSWORD,

    branchA: branchA.id,
    branchAcode,
    branchB: branchB.id,
    branchBcode,

    mainDeptId: mainDept.id,
    mainDeptCode,
    teamDeptId: teamDept.id,
    teamDeptCode,
    foreignDeptId: foreignDept.id,
    foreignDeptCode,
    inactiveDeptId: inactiveDept.id,
    inactiveDeptCode,

    activeStaff: [staff1.id, staff2.id, staff3.id],
    staffBranchBId: staffBranchB.id,
    terminatedStaffId: terminatedStaff.id,
    staffWithLoanId: staffWithLoan.id,
    staffWithOpenAssetId: staffWithOpenAsset.id,
    contractedStaffId: contractedStaff.id,
    activeContractId: activeContract.id,
    uncontractedStaffId: uncontractedStaff.id,
    dailyWageStaffId: dailyWageStaff.id,
    visaHolderId: visaHolder.id,
    currentVisaId: currentVisa.id,

    mainTeamId: mainTeam.id,
    mainTeamCode,
    foreignTeamId: foreignTeam.id,
    foreignTeamCode,
    supervisionTeamId: supervisionTeam.id,

    openAssignmentId: openAssignment.id,
    assetItemId: assetItem.id,

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
    foreignManager: {
      userId: foreignManagerUser.id,
      employeeId: foreignHeadEmp.id,
      email: foreignManagerUser.email,
      token: await login(ctx, foreignManagerUser.email),
    },
    employee: {
      userId: employeeUser.id,
      employeeId: staff1.id,
      email: employeeUser.email,
      token: await login(ctx, employeeUser.email),
    },
    otherEmployee: {
      userId: otherEmployeeUser.id,
      employeeId: staff2.id,
      email: otherEmployeeUser.email,
      token: await login(ctx, otherEmployeeUser.email),
    },

    cleanup: async () => {
      // FK-ordered, and the order is load-bearing in three places:
      //   AdvanceLoanRequest.employee is RESTRICT (statutory retention), so a
      //     loan has to go before its employee or teardown fails outright.
      //   TerminationRequest.requester and ContractAppendix.creator are RESTRICT
      //     on User, so every row a fixture user authored goes before the user.
      //   Department.manager is SetNull, but a department a TEST created may
      //     point at a fixture employee, so headships are detached explicitly.
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

      // Visa: attachments before documents, and the renewal chain is self-
      // referential with SetNull, so a plain deleteMany is safe.
      await prisma.legalDocumentAttachment.deleteMany({
        where: { legalDocument: { employeeId: { in: empIds } } },
      });
      await prisma.employeeLegalDocument.deleteMany({
        where: { employeeId: { in: empIds } },
      });

      // Contracts: termination requests and appendices both hang off a contract
      // AND pin a user, so they go before both.
      await prisma.terminationRequest.deleteMany({
        where: { contract: { employeeId: { in: empIds } } },
      });
      await prisma.terminationRequest.deleteMany({
        where: { requester: { email: { contains: runId } } },
      });
      await prisma.contractAppendix.deleteMany({
        where: { contract: { employeeId: { in: empIds } } },
      });
      await prisma.contractAppendix.deleteMany({
        where: { creator: { email: { contains: runId } } },
      });
      await prisma.contract.deleteMany({
        where: { employeeId: { in: empIds } },
      });

      // Teams. Members first even though the FK cascades — the team rows are
      // matched by code, and a test-created team under a fixture department
      // would not be.
      await prisma.teamMember.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.teamMember.deleteMany({
        where: { team: { department: { code: { contains: runId } } } },
      });
      await prisma.team.deleteMany({
        where: {
          OR: [
            { code: { contains: runId } },
            { department: { code: { contains: runId } } },
          ],
        },
      });

      await prisma.employeeDocument.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.employeeHistory.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.employeeActivity.deleteMany({
        where: { employeeId: { in: empIds } },
      });

      // Assets and loans. AdvanceLoanRequest is RESTRICT, so this is not
      // optional cleanup — skipping it fails the employee delete below.
      await prisma.assetAssignment.deleteMany({
        where: { employeeId: { in: empIds } },
      });
      await prisma.assetItem.deleteMany({
        where: { assetTag: { contains: runId } },
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
      // Supervisor edges are SetNull, but detaching first keeps the intent
      // obvious and survives a test that pointed a real employee at a fixture.
      await prisma.employee.updateMany({
        where: { supervisorId: { in: empIds } },
        data: { supervisorId: null },
      });
      await prisma.employee.deleteMany({ where: empWhere });

      await prisma.department.deleteMany({
        where: { code: { contains: runId }, parentId: { not: null } },
      });
      await prisma.department.deleteMany({
        where: { code: { contains: runId } },
      });
      await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
    },
  };

  return fixtures;
}
