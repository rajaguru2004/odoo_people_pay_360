/**
 * BLACK-BOX live cycle — drives a RUNNING server over HTTP (no in-process boot),
 * so it exercises the real main.ts bootstrap, every module, and the true
 * middleware/interceptor/Prisma pipeline exactly as production runs it.
 *
 *   API_BASE_URL   target server (default http://localhost:${PORT|3001})
 *
 * Fixtures (users/branches) are seeded + torn down via Prisma against the SAME
 * database the server uses; everything else is pure HTTP. Tagged with a unique
 * runId — never touches real data.
 *
 * Run:  npm run test:e2e:live         (server must be up)
 */
import axios, { AxiosInstance } from 'axios';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const BASE_URL =
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const PASSWORD = 'Passw0rd!';
const runId = `live${Date.now()}`;
const email = (r: string) => `${r}-${runId}@test.local`;

const prisma = new PrismaClient();
const api: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true, // never throw — we assert on status
  timeout: 15000,
});
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const bodyStr = (r: any) => JSON.stringify(r.data);

async function waitForServer(retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await api.get('/');
      if (res.status >= 200 && res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server at ${BASE_URL} did not become reachable`);
}

// Shared cycle state.
const S: any = {};

describe(`Live cycle @ ${BASE_URL}`, () => {
  beforeAll(async () => {
    await waitForServer();

    // Seed: department + global admin (Prisma).
    const dept = await prisma.department.create({
      data: { code: `LIVE-DEP-${runId}`, name: `Live Dept ${runId}`, isActive: true },
    });
    S.deptId = dept.id;
    const hash = await bcrypt.hash(PASSWORD, 10);
    S.admin = await prisma.user.create({
      data: {
        email: email('admin'),
        passwordHash: hash,
        role: 'ADMIN',
        isActive: true,
        isGlobalBranchAccess: true,
      },
    });

    // Admin login over HTTP.
    const login = await api.post('/auth/login', { email: email('admin'), password: PASSWORD });
    if (login.status !== 201) {
      throw new Error(`admin login failed: ${login.status} ${bodyStr(login)}`);
    }
    S.adminToken = login.data.data.accessToken;

    // Create two branches over HTTP (exercises live POST /branches + response shape).
    const mkBranch = async (code: string, name: string, geo: boolean) => {
      const res = await api.post(
        '/branches',
        { code, name, geofencingEnabled: geo, latitude: geo ? 12.97 : undefined, longitude: geo ? 77.59 : undefined, geofenceRadiusM: 150, officeStartTime: '09:00', officeEndTime: '18:00' },
        { headers: auth(S.adminToken) },
      );
      if (res.status !== 201 || !res.data?.data?.id) {
        throw new Error(`branch create failed: ${res.status} ${bodyStr(res)}`);
      }
      return res.data.data.id;
    };
    S.branchA = await mkBranch(`LIVE-A-${runId}`, 'Live A', true);
    S.branchB = await mkBranch(`LIVE-B-${runId}`, 'Live B', false);

    // Seed scoped HR (access branch A only) + its employee, and a branch-B employee.
    const hrEmp = await prisma.employee.create({
      data: {
        employeeCode: `EMP-${runId}-HR`, fullName: 'Live HR', dateOfBirth: new Date('1990-01-01'),
        idCard: `ID-${runId}-HR`, email: email('hremp'), departmentId: dept.id, branchId: S.branchA,
        position: 'HR', startDate: new Date('2026-01-01'), baseSalary: 70000, status: 'ACTIVE',
      },
    });
    S.hr = await prisma.user.create({
      data: {
        email: email('hr'), passwordHash: hash, role: 'HR_MANAGER', isActive: true,
        isGlobalBranchAccess: false, employeeId: hrEmp.id,
        branchAccess: { create: [{ branchId: S.branchA }] },
      },
    });
    const empB = await prisma.employee.create({
      data: {
        employeeCode: `EMP-${runId}-B`, fullName: 'Live BobB', dateOfBirth: new Date('1992-02-02'),
        idCard: `ID-${runId}-B`, email: email('bob'), departmentId: dept.id, branchId: S.branchB,
        position: 'Eng', startDate: new Date('2026-01-01'), baseSalary: 50000, status: 'ACTIVE',
      },
    });
    S.empBId = empB.id;
    await prisma.attendance.create({ data: { employeeId: empB.id, branchId: S.branchB, date: new Date('2026-07-06'), status: 'PRESENT' } });

    const hrLogin = await api.post('/auth/login', { email: email('hr'), password: PASSWORD });
    S.hrToken = hrLogin.data.data.accessToken;
  }, 60000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { userId: { in: [S.admin?.id, S.hr?.id].filter(Boolean) } } });
    await prisma.attendance.deleteMany({ where: { employee: { OR: [{ employeeCode: { contains: runId } }, { email: { contains: runId } }] } } });
    await prisma.user.deleteMany({ where: { email: { contains: runId } } });
    await prisma.employee.deleteMany({ where: { OR: [{ employeeCode: { contains: runId } }, { email: { contains: runId } }] } });
    await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
    await prisma.department.deleteMany({ where: { code: { contains: runId } } });
    await prisma.$disconnect();
  });

  it('1 · server is healthy and admin session carries the branch envelope', async () => {
    const me = await api.get('/auth/me', { headers: auth(S.adminToken) });
    expect(me.status).toBe(200);
    expect(me.data.data.isGlobalBranchAccess).toBe(true);
  });

  it('2 · branch list returns the { success, data } envelope with both branches', async () => {
    const res = await api.get('/branches', { headers: auth(S.adminToken) });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data)).toBe(true);
    expect(bodyStr(res)).toContain(`LIVE-A-${runId}`);
    expect(bodyStr(res)).toContain(`LIVE-B-${runId}`);
  });

  it('3 · onboarding stamps the active branch (no branchId in body)', async () => {
    const res = await api.post(
      '/employees',
      {
        fullName: 'Live HireA', email: email('hirea'), dateOfBirth: '1996-03-03',
        idCard: `ID-${runId}-HA`, departmentId: S.deptId, position: 'Analyst',
        startDate: '2026-06-01', baseSalary: 40000,
      },
      { headers: { ...auth(S.adminToken), 'X-Branch-Id': S.branchA } },
    );
    expect(res.status).toBe(201);
    S.hireAId = res.data.data.id;
    // visible under A, hidden under B
    const a = await api.get(`/employees/${S.hireAId}`, { headers: { ...auth(S.adminToken), 'X-Branch-Id': S.branchA } });
    const b = await api.get(`/employees/${S.hireAId}`, { headers: { ...auth(S.adminToken), 'X-Branch-Id': S.branchB } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(404);
  });

  it('4 · onboarding into a second branch does NOT collide on employee_code', async () => {
    const res = await api.post(
      '/employees',
      {
        fullName: 'Live HireB', email: email('hireb'), dateOfBirth: '1996-04-04',
        idCard: `ID-${runId}-HB`, departmentId: S.deptId, branchId: S.branchB,
        position: 'Analyst', startDate: '2026-06-01', baseSalary: 40000,
      },
      { headers: auth(S.adminToken) },
    );
    expect(res.status).toBe(201); // regression guard for the cross-branch code-gen 500
  });

  it('5 · employee list is scoped by X-Branch-Id', async () => {
    const q = `/employees?search=EMP-${runId}&limit=50`;
    const onA = await api.get(q, { headers: { ...auth(S.adminToken), 'X-Branch-Id': S.branchA } });
    const onB = await api.get(q, { headers: { ...auth(S.adminToken), 'X-Branch-Id': S.branchB } });
    expect(bodyStr(onA)).not.toContain(`EMP-${runId}-B`);
    expect(bodyStr(onB)).toContain(`EMP-${runId}-B`);
  });

  it('6 · object-level IDOR: cross-branch GET :id → 404, in-branch → 200', async () => {
    const cross = await api.get(`/employees/${S.empBId}`, { headers: { ...auth(S.adminToken), 'X-Branch-Id': S.branchA } });
    const inb = await api.get(`/employees/${S.empBId}`, { headers: { ...auth(S.adminToken), 'X-Branch-Id': S.branchB } });
    expect(cross.status).toBe(404);
    expect(inb.status).toBe(200);
  });

  it('7 · scoped HR is pinned to branch A and cannot see B', async () => {
    const list = await api.get(`/employees?search=EMP-${runId}&limit=50`, { headers: auth(S.hrToken) });
    expect(list.status).toBe(200);
    expect(bodyStr(list)).not.toContain(`EMP-${runId}-B`);
  });

  it('8 · scoped HR requesting a foreign branch → 403 + ACCESS_DENIED audit row', async () => {
    const res = await api.get(`/employees?search=EMP-${runId}`, { headers: { ...auth(S.hrToken), 'X-Branch-Id': S.branchB } });
    expect(res.status).toBe(403);
    let count = 0;
    for (let i = 0; i < 15; i++) {
      count = await prisma.auditLog.count({ where: { userId: S.hr.id, action: 'ACCESS_DENIED' } });
      if (count > 0) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(count).toBeGreaterThan(0);
  });

  it('9 · attendance list is branch-scoped', async () => {
    const q = `/attendances/list?period=custom&startDate=2026-07-06&endDate=2026-07-06&search=EMP-${runId}&limit=100`;
    const onA = await api.get(q, { headers: { ...auth(S.adminToken), 'X-Branch-Id': S.branchA } });
    expect(onA.status).toBe(200);
    expect(bodyStr(onA)).not.toContain(`EMP-${runId}-B`);
  });

  it('10 · lifecycle close: a branch with employees cannot be deleted (400)', async () => {
    const res = await api.delete(`/branches/${S.branchA}`, { headers: auth(S.adminToken) });
    expect(res.status).toBe(400);
  });
});
