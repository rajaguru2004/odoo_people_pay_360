import * as bcrypt from 'bcrypt';
import { E2EContext } from './e2e-app';

/**
 * The Organization module's own fixture set: branches, a real department
 * hierarchy, manager candidates of every eligibility shape, and the pending
 * approvals a change request's impact analysis counts.
 *
 * Deliberately separate from `utils/fixtures.ts` — that set exists to prove
 * branch ISOLATION and its two departments are incidental. These specs need the
 * opposite: one branch is enough, but the department tree, the tenure boundary
 * and the multi-department manager all have to be real, because every rule under
 * test is expressed in terms of them.
 *
 * Everything is tagged with a unique `runId` so `cleanup()` can bulk-delete
 * without touching a shared database's real rows.
 */

const PASSWORD = 'Passw0rd!';

export interface OrgUser {
  userId: string;
  employeeId?: string;
  email: string;
  token: string;
}

export interface OrgFixtures {
  runId: string;
  password: string;

  /** Branch holding every fixture employee. */
  branchA: string;
  branchAcode: string;
  /** A second branch, for scoping assertions. Holds one employee. */
  branchB: string;
  branchBcode: string;
  /** Empty on purpose: the only branch a delete test may remove. */
  branchC: string;
  branchCcode: string;

  /** Top-level department, 2 employees, one child, headed by `deptManager`. */
  topDeptId: string;
  topDeptCode: string;
  /** Child of `topDept`. No employees. */
  childDeptId: string;
  childDeptCode: string;
  /** Top-level, no employees, no children — the deletable one. */
  emptyDeptId: string;
  emptyDeptCode: string;
  /** A second top-level department, headed by `multiDeptManager`. */
  secondDeptId: string;
  secondDeptCode: string;
  /** Third top-level department, so "manager heads two" has somewhere to go. */
  thirdDeptId: string;
  thirdDeptCode: string;

  /** Employees of `topDept`. */
  staffAId: string;
  staffBId: string;
  /** Employee of `topDept`, in branch B — proves per-branch narrowing. */
  staffBranchBId: string;
  /** ACTIVE, started 3 years ago: eligible for headship on every path. */
  seniorCandidateId: string;
  /** ACTIVE, started 2 months ago: fails the minimum-tenure rule. */
  juniorCandidateId: string;
  /** INACTIVE: fails the ACTIVE rule. */
  inactiveCandidateId: string;
  /** Employee of `secondDept` — the eligible head for a child of `secondDept`. */
  secondDeptStaffId: string;

  /** Global ADMIN. */
  admin: OrgUser;
  /** HR_MANAGER, global branch access. */
  hr: OrgUser;
  /** HR_MANAGER scoped to branch A only. */
  scopedHr: OrgUser;
  /** MANAGER heading `topDept`. */
  deptManager: OrgUser;
  /** MANAGER heading `secondDept` AND `thirdDept`. */
  multiDeptManager: OrgUser;
  /** Plain EMPLOYEE in `topDept`. */
  employee: OrgUser;
  /** EMPLOYEE user attached to `seniorCandidate` — promoted on approval. */
  seniorCandidateUser: OrgUser;

  /** PENDING leave + overtime under `topDept`, for the impact analysis. */
  pendingLeaveId: string;
  pendingOvertimeId: string;

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

export async function setupOrgFixtures(ctx: E2EContext): Promise<OrgFixtures> {
  const { prisma } = ctx;
  const runId = `org${Date.now()}`;
  const hash = await bcrypt.hash(PASSWORD, 10);

  // ── Branches ──────────────────────────────────────────────────────────────
  const branchAcode = `ORG-A-${runId}`;
  const branchBcode = `ORG-B-${runId}`;
  const branchCcode = `ORG-C-${runId}`;
  const branchA = await prisma.branch.create({
    data: {
      code: branchAcode,
      name: 'Org Branch A',
      isActive: true,
      timezone: 'Asia/Kolkata',
      officeStartTime: '09:00',
      officeEndTime: '18:00',
    },
  });
  const branchB = await prisma.branch.create({
    data: { code: branchBcode, name: 'Org Branch B', isActive: true },
  });
  const branchC = await prisma.branch.create({
    data: { code: branchCcode, name: 'Org Branch C (empty)', isActive: true },
  });

  // ── Departments ───────────────────────────────────────────────────────────
  const topDeptCode = `ORG-TOP-${runId}`;
  const childDeptCode = `ORG-CHILD-${runId}`;
  const emptyDeptCode = `ORG-EMPTY-${runId}`;
  const secondDeptCode = `ORG-SECOND-${runId}`;
  const thirdDeptCode = `ORG-THIRD-${runId}`;

  const topDept = await prisma.department.create({
    data: { code: topDeptCode, name: 'Org Top', isActive: true },
  });
  const childDept = await prisma.department.create({
    data: {
      code: childDeptCode,
      name: 'Org Child',
      isActive: true,
      parentId: topDept.id,
    },
  });
  const emptyDept = await prisma.department.create({
    data: { code: emptyDeptCode, name: 'Org Empty', isActive: true },
  });
  const secondDept = await prisma.department.create({
    data: { code: secondDeptCode, name: 'Org Second', isActive: true },
  });
  const thirdDept = await prisma.department.create({
    data: { code: thirdDeptCode, name: 'Org Third', isActive: true },
  });

  // ── Employees ─────────────────────────────────────────────────────────────
  const mkEmployee = (
    suffix: string,
    over: Record<string, unknown> = {},
  ): any => ({
    employeeCode: `EMP-${runId}-${suffix}`,
    fullName: `Org ${suffix}`,
    dateOfBirth: new Date('1992-01-01'),
    idCard: `ID-${runId}-${suffix}`,
    email: `${suffix.toLowerCase()}-${runId}@test.local`,
    departmentId: topDept.id,
    branchId: branchA.id,
    position: 'Engineer',
    startDate: monthsAgo(36),
    baseSalary: 50000,
    status: 'ACTIVE',
    ...over,
  });

  const staffA = await prisma.employee.create({ data: mkEmployee('STAFFA') });
  const staffB = await prisma.employee.create({ data: mkEmployee('STAFFB') });
  const staffBranchB = await prisma.employee.create({
    data: mkEmployee('STAFFBB', { branchId: branchB.id }),
  });
  const seniorCandidate = await prisma.employee.create({
    data: mkEmployee('SENIOR', { position: 'Senior Engineer' }),
  });
  const juniorCandidate = await prisma.employee.create({
    data: mkEmployee('JUNIOR', { startDate: monthsAgo(2) }),
  });
  const inactiveCandidate = await prisma.employee.create({
    data: mkEmployee('INACTIVE', { status: 'INACTIVE' }),
  });
  const secondDeptStaff = await prisma.employee.create({
    data: mkEmployee('SECSTAFF', { departmentId: secondDept.id }),
  });
  const headEmp = await prisma.employee.create({
    data: mkEmployee('HEAD', { position: 'Head of Org Top' }),
  });
  const multiHeadEmp = await prisma.employee.create({
    data: mkEmployee('MULTIHEAD', { departmentId: secondDept.id }),
  });
  const hrEmp = await prisma.employee.create({ data: mkEmployee('HREMP') });
  const scopedHrEmp = await prisma.employee.create({
    data: mkEmployee('SCOPEDHR'),
  });

  // Headships. `deptManager` heads one department; `multiDeptManager` heads two,
  // which is what makes the demote-on-approval rule testable in both directions.
  await prisma.department.update({
    where: { id: topDept.id },
    data: { managerId: headEmp.id },
  });
  await prisma.department.update({
    where: { id: secondDept.id },
    data: { managerId: multiHeadEmp.id },
  });
  await prisma.department.update({
    where: { id: thirdDept.id },
    data: { managerId: multiHeadEmp.id },
  });

  // ── Users ─────────────────────────────────────────────────────────────────
  const mkUser = async (
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

  const adminUser = await mkUser('ADMIN', 'ADMIN');
  const hrUser = await mkUser('HR', 'HR_MANAGER', { employeeId: hrEmp.id });
  const scopedHrUser = await mkUser('SHR', 'HR_MANAGER', {
    employeeId: scopedHrEmp.id,
    isGlobalBranchAccess: false,
    branchAccess: { create: [{ branchId: branchA.id }] },
  });
  const managerUser = await mkUser('MGR', 'MANAGER', {
    employeeId: headEmp.id,
  });
  const multiManagerUser = await mkUser('MULTIMGR', 'MANAGER', {
    employeeId: multiHeadEmp.id,
  });
  const employeeUser = await mkUser('EMP', 'EMPLOYEE', {
    employeeId: staffA.id,
    isGlobalBranchAccess: false,
  });
  const seniorUser = await mkUser('SENIORU', 'EMPLOYEE', {
    employeeId: seniorCandidate.id,
    isGlobalBranchAccess: false,
  });

  // ── Pending approvals, so impact analysis has real numbers ────────────────
  const pendingLeave = await prisma.leaveRequest.create({
    data: {
      employeeId: staffA.id,
      leaveType: 'UNPAID',
      startDate: new Date('2026-09-01'),
      endDate: new Date('2026-09-02'),
      totalDays: 2,
      reason: `org fixture pending leave ${runId}`,
      status: 'PENDING',
    },
  });
  const pendingOvertime = await prisma.overtimeRequest.create({
    data: {
      employeeId: staffB.id,
      date: new Date('2026-09-01'),
      startTime: new Date('2026-09-01T19:00:00.000Z'),
      endTime: new Date('2026-09-01T21:00:00.000Z'),
      hours: 2,
      reason: `org fixture pending overtime ${runId}`,
      status: 'PENDING',
    },
  });

  const userEmails = [
    adminUser.email,
    hrUser.email,
    scopedHrUser.email,
    managerUser.email,
    multiManagerUser.email,
    employeeUser.email,
    seniorUser.email,
  ];

  const fixtures: OrgFixtures = {
    runId,
    password: PASSWORD,

    branchA: branchA.id,
    branchAcode,
    branchB: branchB.id,
    branchBcode,
    branchC: branchC.id,
    branchCcode,

    topDeptId: topDept.id,
    topDeptCode,
    childDeptId: childDept.id,
    childDeptCode,
    emptyDeptId: emptyDept.id,
    emptyDeptCode,
    secondDeptId: secondDept.id,
    secondDeptCode,
    thirdDeptId: thirdDept.id,
    thirdDeptCode,

    staffAId: staffA.id,
    staffBId: staffB.id,
    staffBranchBId: staffBranchB.id,
    seniorCandidateId: seniorCandidate.id,
    juniorCandidateId: juniorCandidate.id,
    inactiveCandidateId: inactiveCandidate.id,
    secondDeptStaffId: secondDeptStaff.id,

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
      employeeId: headEmp.id,
      email: managerUser.email,
      token: await login(ctx, managerUser.email),
    },
    multiDeptManager: {
      userId: multiManagerUser.id,
      employeeId: multiHeadEmp.id,
      email: multiManagerUser.email,
      token: await login(ctx, multiManagerUser.email),
    },
    employee: {
      userId: employeeUser.id,
      employeeId: staffA.id,
      email: employeeUser.email,
      token: await login(ctx, employeeUser.email),
    },
    seniorCandidateUser: {
      userId: seniorUser.id,
      employeeId: seniorCandidate.id,
      email: seniorUser.email,
      token: await login(ctx, seniorUser.email),
    },

    pendingLeaveId: pendingLeave.id,
    pendingOvertimeId: pendingOvertime.id,

    cleanup: async () => {
      // FK-ordered. The two Restrict edges are what dictate this order:
      // DepartmentHistory.user and DepartmentChangeRequest.requester both
      // RESTRICT, so every row a fixture user authored has to go before the
      // user does — otherwise teardown fails and the next run inherits the
      // leftovers.
      const deptWhere = { department: { code: { contains: runId } } };
      const empWhere = {
        OR: [
          { employeeCode: { contains: runId } },
          { email: { contains: runId } },
        ],
      };

      await prisma.managerTransition.deleteMany({ where: deptWhere });
      await prisma.departmentHistory.deleteMany({ where: deptWhere });
      await prisma.departmentChangeRequest.deleteMany({ where: deptWhere });
      // Requests raised against a department this run did not create (the
      // baseline seed's) but authored by a fixture user would otherwise pin the
      // user in place.
      await prisma.departmentChangeRequest.deleteMany({
        where: { requester: { email: { contains: runId } } },
      });
      await prisma.departmentHistory.deleteMany({
        where: { user: { email: { contains: runId } } },
      });

      await prisma.leaveRequest.deleteMany({ where: { employee: empWhere } });
      await prisma.overtimeRequest.deleteMany({
        where: { employee: empWhere },
      });
      await prisma.attendance.deleteMany({ where: { employee: empWhere } });
      await prisma.auditLog.deleteMany({
        where: { user: { email: { in: userEmails } } },
      });

      await prisma.user.deleteMany({
        where: { email: { contains: runId } },
      });

      // Detach headships first: Department.manager is SetNull, but a department
      // created BY a test (not by this fixture) may still point at a fixture
      // employee, and those rows are deleted after the employees.
      await prisma.department.updateMany({
        where: { manager: empWhere },
        data: { managerId: null },
      });
      await prisma.employee.deleteMany({ where: empWhere });

      // Children before parents — the hierarchy FK is SetNull, but deleting in
      // this order keeps the intent obvious.
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

/**
 * `bearer` and the settings snapshot/restore helpers moved to `./settings` when
 * People became a second consumer — they are harness, not Organization fixtures.
 * Re-exported here so every existing import keeps working unchanged.
 */
export {
  bearer,
  readSetting,
  writeSetting,
  restoreSetting,
  withSetting,
  withSettings,
} from './settings';
export type { SettingSnapshot } from './settings';
