import * as bcrypt from 'bcrypt';
import { E2EContext } from './e2e-app';

const PASSWORD = 'Passw0rd!';

export interface UserHandle {
  userId: string;
  employeeId?: string;
  email: string;
  token: string;
}

export interface Fixtures {
  runId: string;
  password: string;
  deptId: string;
  branchA: string;
  branchB: string;
  branchAcode: string;
  branchBcode: string;
  globalAdmin: UserHandle;
  scopedHr: UserHandle;
  plainEmployee: UserHandle;
  empAId: string; // employee in branch A
  empBId: string; // employee in branch B
  cleanup: () => Promise<void>;
}

async function login(ctx: E2EContext, email: string): Promise<string> {
  const res = await ctx.http().post('/auth/login').send({ email, password: PASSWORD });
  if (!res.body?.data?.accessToken) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken;
}

/**
 * Creates an isolated multi-branch fixture set (two branches, three users of
 * different scopes, two employees) tagged with a unique runId so teardown can
 * bulk-delete without touching production data.
 */
export async function setupFixtures(ctx: E2EContext): Promise<Fixtures> {
  const { prisma } = ctx;
  const runId = `e2e${Date.now()}`;
  const hash = await bcrypt.hash(PASSWORD, 10);

  const dept = await prisma.department.create({
    data: { code: `E2E-DEP-${runId}`, name: `E2E Dept ${runId}`, isActive: true },
  });

  const branchAcode = `E2E-A-${runId}`;
  const branchBcode = `E2E-B-${runId}`;
  const branchA = await prisma.branch.create({
    data: {
      code: branchAcode,
      name: 'E2E Branch A',
      isActive: true,
      timezone: 'Asia/Kolkata',
      officeStartTime: '09:00',
      officeEndTime: '18:00',
      geofencingEnabled: true,
      latitude: 12.9716,
      longitude: 77.5946,
      geofenceRadiusM: 150,
    },
  });
  const branchB = await prisma.branch.create({
    data: {
      code: branchBcode,
      name: 'E2E Branch B',
      isActive: true,
      timezone: 'America/New_York',
      officeStartTime: '08:00',
      officeEndTime: '16:00',
      geofencingEnabled: false,
      latitude: 40.7128,
      longitude: -74.006,
      geofenceRadiusM: 500,
    },
  });

  // Employees (one per branch) created directly (no request context => not scoped).
  const empA = await prisma.employee.create({
    data: {
      employeeCode: `EMP-${runId}-A`,
      fullName: 'Alice BranchA',
      dateOfBirth: new Date('1995-01-01'),
      idCard: `ID-${runId}-A`,
      email: `alice-${runId}@test.local`,
      departmentId: dept.id,
      branchId: branchA.id,
      position: 'Engineer',
      startDate: new Date('2026-01-01'),
      baseSalary: 50000,
      status: 'ACTIVE',
    },
  });
  const empB = await prisma.employee.create({
    data: {
      employeeCode: `EMP-${runId}-B`,
      fullName: 'Bob BranchB',
      dateOfBirth: new Date('1994-02-02'),
      idCard: `ID-${runId}-B`,
      email: `bob-${runId}@test.local`,
      departmentId: dept.id,
      branchId: branchB.id,
      position: 'Engineer',
      startDate: new Date('2026-01-01'),
      baseSalary: 60000,
      status: 'ACTIVE',
    },
  });

  // Attendance rows (branchId stamped) so attendance scoping is verifiable.
  await prisma.attendance.create({
    data: { employeeId: empA.id, branchId: branchA.id, date: new Date('2026-07-06'), status: 'PRESENT' },
  });
  await prisma.attendance.create({
    data: { employeeId: empB.id, branchId: branchB.id, date: new Date('2026-07-06'), status: 'PRESENT' },
  });

  // HR employee for the scoped user (home branch A).
  const hrEmp = await prisma.employee.create({
    data: {
      employeeCode: `EMP-${runId}-HR`,
      fullName: 'Hank HR',
      dateOfBirth: new Date('1990-03-03'),
      idCard: `ID-${runId}-HR`,
      email: `hr-${runId}@test.local`,
      departmentId: dept.id,
      branchId: branchA.id,
      position: 'HR',
      startDate: new Date('2026-01-01'),
      baseSalary: 70000,
      status: 'ACTIVE',
    },
  });

  // Users of three scopes.
  const globalAdminUser = await prisma.user.create({
    data: {
      email: `admin-${runId}@test.local`,
      passwordHash: hash,
      role: 'ADMIN',
      isActive: true,
      isGlobalBranchAccess: true,
    },
  });
  const scopedHrUser = await prisma.user.create({
    data: {
      email: `hr-${runId}@test.local`,
      passwordHash: hash,
      role: 'HR_MANAGER',
      isActive: true,
      isGlobalBranchAccess: false,
      employeeId: hrEmp.id,
      branchAccess: { create: [{ branchId: branchA.id }] }, // scoped to branch A only
    },
  });
  const plainEmpUser = await prisma.user.create({
    data: {
      email: `emp-${runId}@test.local`,
      passwordHash: hash,
      role: 'EMPLOYEE',
      isActive: true,
      isGlobalBranchAccess: false,
      employeeId: empA.id,
    },
  });

  const userIds = [globalAdminUser.id, scopedHrUser.id, plainEmpUser.id];

  const fixtures: Fixtures = {
    runId,
    password: PASSWORD,
    deptId: dept.id,
    branchA: branchA.id,
    branchB: branchB.id,
    branchAcode,
    branchBcode,
    empAId: empA.id,
    empBId: empB.id,
    globalAdmin: {
      userId: globalAdminUser.id,
      email: globalAdminUser.email,
      token: await login(ctx, globalAdminUser.email),
    },
    scopedHr: {
      userId: scopedHrUser.id,
      employeeId: hrEmp.id,
      email: scopedHrUser.email,
      token: await login(ctx, scopedHrUser.email),
    },
    plainEmployee: {
      userId: plainEmpUser.id,
      employeeId: empA.id,
      email: plainEmpUser.email,
      token: await login(ctx, plainEmpUser.email),
    },
    cleanup: async () => {
      // Order respects FKs (employees before branches; users first to release refs).
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.attendance.deleteMany({
        where: { employee: { employeeCode: { contains: runId } } },
      });
      await prisma.user.deleteMany({ where: { email: { contains: runId } } });

      // Loans/advances are onDelete: RESTRICT on the employee — loan history has
      // to outlive the person for statutory audit — so a test employee who was
      // given a loan can no longer be deleted while it exists. Clear the loan
      // graph explicitly, children first. Skipping this leaves the shared
      // database littered with half-deleted fixtures.
      const employeeWhere = {
        OR: [
          { employeeCode: { contains: runId } },
          { email: { contains: runId } },
        ],
      };
      const loanWhere = { request: { employee: employeeWhere } };

      // Onboarded employees have auto-generated codes but a runId-tagged email.
      await prisma.employee.deleteMany({ where: employeeWhere });
      await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
      await prisma.department.deleteMany({ where: { code: { contains: runId } } });
    },
  };
  return fixtures;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
