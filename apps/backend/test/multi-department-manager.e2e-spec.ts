import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';

/**
 * End-to-end proof that ONE manager can head MORE THAN ONE department and gains
 * real managerial authority across every department they manage.
 *
 * All fixtures share a single branch and the manager has global branch access,
 * so branch-scoping is neutralised and the ONLY thing under test is
 * department-scoping. The manager heads dept A (home) and dept B, but NOT dept C.
 */
describe('Multi-department manager (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `mdm${Date.now()}`;
  const managerEmail = `mgr-${runId}@test.local`;
  const adminEmail = `admin-${runId}@test.local`;

  let deptAId: string;
  let deptBId: string;
  let deptCId: string;
  let empAId: string;
  let empBId: string;
  let empCId: string;
  let managerEmpId: string;

  let adminToken: string;
  let managerToken: string;

  beforeAll(async () => {
    ctx = await bootE2EApp();
    const { prisma } = ctx;
    const hash = await bcrypt.hash(PASSWORD, 10);

    const branch = await prisma.branch.create({
      data: {
        code: `MDM-BR-${runId}`,
        name: 'MDM Branch',
        isActive: true,
        timezone: 'Asia/Kolkata',
        officeStartTime: '09:00',
        officeEndTime: '18:00',
      },
    });

    const mkDept = (suffix: string) =>
      prisma.department.create({
        data: {
          code: `MDM-${suffix}-${runId}`,
          name: `MDM Dept ${suffix} ${runId}`,
          isActive: true,
        },
      });
    const [deptA, deptB, deptC] = await Promise.all([
      mkDept('A'),
      mkDept('B'),
      mkDept('C'),
    ]);
    deptAId = deptA.id;
    deptBId = deptB.id;
    deptCId = deptC.id;

    const mkEmp = (suffix: string, departmentId: string) =>
      prisma.employee.create({
        data: {
          employeeCode: `MDM-${runId}-${suffix}`,
          fullName: `MDM ${suffix}`,
          dateOfBirth: new Date('1990-01-01'),
          idCard: `MDM-ID-${runId}-${suffix}`,
          email: `mdm-${suffix}-${runId}@test.local`,
          departmentId,
          branchId: branch.id,
          position: 'Engineer',
          startDate: new Date('2015-01-01'),
          baseSalary: 50000,
          status: 'ACTIVE',
        },
      });
    const [empA, empB, empC, managerEmp] = await Promise.all([
      mkEmp('A', deptA.id),
      mkEmp('B', deptB.id),
      mkEmp('C', deptC.id),
      mkEmp('MGR', deptA.id), // the manager belongs to (home) dept A
    ]);
    empAId = empA.id;
    empBId = empB.id;
    empCId = empC.id;
    managerEmpId = managerEmp.id;

    // Precondition: the manager already heads their home department A.
    await prisma.department.update({
      where: { id: deptA.id },
      data: { managerId: managerEmp.id },
    });

    // Admin (global) performs the assignment; manager (global branch access so
    // only dept-scoping matters) exercises the authority.
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: hash,
        role: 'ADMIN',
        isActive: true,
        isGlobalBranchAccess: true,
      },
    });
    await prisma.user.create({
      data: {
        email: managerEmail,
        passwordHash: hash,
        role: 'MANAGER',
        isActive: true,
        isGlobalBranchAccess: true,
        employeeId: managerEmp.id,
      },
    });

    const login = async (email: string) =>
      (
        await ctx.http().post('/auth/login').send({ email, password: PASSWORD })
      ).body?.data?.accessToken as string;
    adminToken = await login(adminEmail);
    managerToken = await login(managerEmail);
  });

  afterAll(async () => {
    const { prisma } = ctx;
    // Employees delete null-outs Department.managerId (FK onDelete: SetNull).
    await prisma.attendance.deleteMany({
      where: { employee: { employeeCode: { contains: runId } } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: runId } } });
    await prisma.employee.deleteMany({
      where: { employeeCode: { contains: runId } },
    });
    await prisma.department.deleteMany({ where: { code: { contains: runId } } });
    await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
    await ctx.app.close();
  });

  it('ADMIN can assign a manager to a SECOND department (the old block is gone)', async () => {
    const res = await ctx
      .http()
      .patch(`/departments/${deptBId}/manager`)
      .set(bearer(adminToken))
      .send({ managerId: managerEmpId });

    expect(res.status).toBe(200);
    expect(res.body?.data?.managerId).toBe(managerEmpId);
  });

  it('the manager now heads both A and B in the DB', async () => {
    const managed = await ctx.prisma.department.findMany({
      where: { managerId: managerEmpId, isActive: true },
      select: { id: true },
    });
    const ids = managed.map((d) => d.id).sort();
    expect(ids).toEqual([deptAId, deptBId].sort());
  });

  it('GET /employees returns staff from BOTH managed departments, excludes the unmanaged one', async () => {
    const res = await ctx
      .http()
      .get('/employees?limit=100')
      .set(bearer(managerToken));

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain(empAId); // home dept A
    expect(body).toContain(empBId); // second managed dept B
    expect(body).not.toContain(empCId); // dept C is not managed
  });

  it('GET /departments/:id — 200 for each managed dept, 403 for the unmanaged dept', async () => {
    const a = await ctx
      .http()
      .get(`/departments/${deptAId}`)
      .set(bearer(managerToken));
    const b = await ctx
      .http()
      .get(`/departments/${deptBId}`)
      .set(bearer(managerToken));
    const c = await ctx
      .http()
      .get(`/departments/${deptCId}`)
      .set(bearer(managerToken));

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(403);
  });

  it('the manager can act on employees in BOTH managed departments but is denied in the unmanaged one', async () => {
    // GET /attendances/employee/:id is guarded by isDeptInManagerScope.
    const home = await ctx
      .http()
      .get(`/attendances/employee/${empAId}`)
      .set(bearer(managerToken));
    const second = await ctx
      .http()
      .get(`/attendances/employee/${empBId}`)
      .set(bearer(managerToken));
    const unmanaged = await ctx
      .http()
      .get(`/attendances/employee/${empCId}`)
      .set(bearer(managerToken));

    expect(home.status).toBe(200); // dept A (home)
    expect(second.status).toBe(200); // dept B (also managed) — the whole point
    expect(unmanaged.status).toBe(403); // dept C (not managed) stays blocked
  });
});
