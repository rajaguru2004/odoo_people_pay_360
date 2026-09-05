/**
 * FULL HR LIFECYCLE — one black-box suite that drives a RUNNING server through
 * (nearly) EVERY backend endpoint end to end, so a single green run is the
 * go/no-go quality gate before shipping. It is the living regression net: when a
 * new feature lands, add its endpoints here.
 *
 * Flow: onboarding → attendance (check-in/out + lunch) → corrections → leave
 * (requests + balances) → contract lifecycle → salary → overtime → reimbursement
 * → salary advance & loan (request + approval + payroll recovery across cycles)
 * → rewards/discipline → org (dept/branch/holiday/team) → calendar → projects &
 * tasks (statuses/sprints/labels/comments/attachments/timesheets/work-logs) →
 * payroll state machine (run → item edit → submit → approve → reject → lock →
 * finalize → revision → bulk-approve → payslip) → dashboards/exports/audit/etc.
 *
 *   API_BASE_URL   default http://localhost:${PORT|3001}
 *
 * Users/branch/workflow seeded + torn down via Prisma (same DB the server uses),
 * tagged with a unique runId — never touches real data. Run: npm run test:e2e:full
 *
 * ── Intentionally NOT exercised (with reason) — keep this list current ──
 *  • External side effects: POST /auth/register|verify-email|resend-verification|
 *    send-verification, POST /employees/:id/resend-welcome, POST /chatbot/chat
 *    (OpenRouter LLM), all mail-sending — need real SMTP/keys, non-deterministic.
 *  • Biometric: POST /face-recognition/register|check-in|check-out|lunch-*|test —
 *    require a real detectable face image + loaded face-api models. Capture-* are
 *    skipped too (they mutate attendance with dummy data).
 *  • File I/O infra: all /upload/* (avatar/contract/document/logo), multipart
 *    POST /employees/:id/avatar|documents, POST /task-attachments/upload/:taskId,
 *    leave/reimbursement attachment UPLOADS, /employees/import/preview|confirm —
 *    need disk/MinIO/S3 + xlsx fixtures. The URL-register attachment path IS covered.
 *  • Embeddings: POST/PUT/DELETE /knowledge + GET /knowledge/search — first call
 *    downloads a ~23MB local model; slow/flaky in CI. Read-only knowledge covered.
 *  • Global-state mutators: POST /system-settings, /system-settings/apply-preset,
 *    /library-items/seed, POST /sample-data/seed, POST /attendances/auto-mark-absent,
 *    /leave-balances/accrual/run, /leave-balances/set-default-allocation,
 *    /holidays/init-year/:year, POST /employees/recalculate-profiles,
 *    POST /system-settings/reset, DELETE /employees/:id/hard — corrupt shared state.
 */
import axios, { AxiosInstance } from 'axios';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const BASE_URL = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const PW = 'Passw0rd!';
const runId = `life${Date.now()}`;
const mail = (r: string) => `${r}-${runId}@life.local`;

const prisma = new PrismaClient();
const api: AxiosInstance = axios.create({ baseURL: BASE_URL, validateStatus: () => true, timeout: 20000 });
const H = (t: string, branchId?: string) => ({ headers: { Authorization: `Bearer ${t}`, ...(branchId ? { 'X-Branch-Id': branchId } : {}) } });
const S: any = { payrollIds: [] };

// Terse HTTP helpers — default to the global-admin token unless overridden.
const idOf = (res: any) => res?.data?.data?.id ?? res?.data?.id;
const G = (p: string, tok: string = S.adminToken, br?: string) => api.get(p, H(tok, br));
const P = (p: string, b: any = {}, tok: string = S.adminToken, br?: string) => api.post(p, b, H(tok, br));
const PT = (p: string, b: any = {}, tok: string = S.adminToken) => api.patch(p, b, H(tok));
const PU = (p: string, b: any = {}, tok: string = S.adminToken) => api.put(p, b, H(tok));
const D = (p: string, tok: string = S.adminToken) => api.delete(p, H(tok));

async function waitForServer(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try { const r = await api.get('/'); if (r.status < 500) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server at ${BASE_URL} unreachable`);
}

describe(`Full HR lifecycle @ ${BASE_URL}`, () => {
  beforeAll(async () => {
    await waitForServer();

    // Put the server in a deterministic state for the flows under test:
    // features on, geofence + face-only off so a plain check-in works.
    // Original values are captured and restored in afterAll (shared DB hygiene).
    const overrides: Record<string, string> = {
      overtime_enabled: 'true',
      reimbursement_enabled: 'true',
      geofencing_enabled: 'false',
      attendance_face_only: 'false',
      // Salary advance & loan: module on, admin can approve, deterministic limits
      // so the affordability + max-installment guards assert predictably.
      advance_loan_enabled: 'true',
      advance_loan_approver_roles: 'HR_MANAGER,ADMIN',
      advance_loan_max_installments: '12',
      advance_max_percent_of_salary: '100',
    };
    S.origSettings = {};
    for (const key of Object.keys(overrides)) {
      const existing = await prisma.systemSetting.findUnique({ where: { key } });
      S.origSettings[key] = existing ? existing.value : null; // null = row did not exist
      await prisma.systemSetting.upsert({ where: { key }, update: { value: overrides[key] }, create: { key, value: overrides[key] } });
    }

    // Department + branch (geofence off so check-in needs no coords).
    const dept = await prisma.department.create({ data: { code: `LIFE-DEP-${runId}`, name: `Life Dept ${runId}`, isActive: true } });
    S.deptId = dept.id;
    const branch = await prisma.branch.create({
      data: { code: `LIFE-BR-${runId}`, name: 'Life Branch', isActive: true, geofencingEnabled: false, officeStartTime: '09:00', officeEndTime: '18:00', timezone: 'Asia/Kolkata' },
    });
    S.branchId = branch.id;

    // Global admin.
    const hash = await bcrypt.hash(PW, 10);
    S.admin = await prisma.user.create({ data: { email: mail('admin'), passwordHash: hash, role: 'ADMIN', isActive: true, isGlobalBranchAccess: true } });
    const alogin = await api.post('/auth/login', { email: mail('admin'), password: PW });
    if (alogin.status !== 201) throw new Error(`admin login ${alogin.status}: ${JSON.stringify(alogin.data)}`);
    S.adminToken = alogin.data.data.accessToken;

    // HR manager (global branch access) — covers HR-only routes distinct from ADMIN.
    S.hr = await prisma.user.create({ data: { email: mail('hr'), passwordHash: hash, role: 'HR_MANAGER', isActive: true, isGlobalBranchAccess: true } });
    const hrlogin = await api.post('/auth/login', { email: mail('hr'), password: PW });
    S.hrToken = hrlogin.data.data.accessToken;

    // Onboard the primary employee over HTTP (also auto-creates its EMPLOYEE login).
    const onboard = await api.post('/employees', {
      fullName: 'Life Employee', email: mail('emp'), dateOfBirth: '1994-05-05', idCard: `ID-${runId}-E`,
      departmentId: dept.id, branchId: branch.id, position: 'Engineer', startDate: '2026-01-01', baseSalary: 60000,
    }, H(S.adminToken, branch.id));
    if (onboard.status !== 201) throw new Error(`onboard ${onboard.status}: ${JSON.stringify(onboard.data)}`);
    S.empId = onboard.data.data.id;
    const empUser = await prisma.user.update({ where: { email: mail('emp') }, data: { passwordHash: hash, isActive: true } });
    S.empUserId = empUser.id;
    const elogin = await api.post('/auth/login', { email: mail('emp'), password: PW });
    if (elogin.status !== 201) throw new Error(`emp login ${elogin.status}: ${JSON.stringify(elogin.data)}`);
    S.empToken = elogin.data.data.accessToken;

    // Manager bound to an employee in the dept + set as dept manager (dept-scoped role coverage).
    const mgrOnboard = await api.post('/employees', {
      fullName: 'Life Manager', email: mail('mgr'), dateOfBirth: '1988-03-03', idCard: `ID-${runId}-M`,
      departmentId: dept.id, branchId: branch.id, position: 'Manager', startDate: '2026-01-01', baseSalary: 90000,
    }, H(S.adminToken, branch.id));
    if (mgrOnboard.status !== 201) throw new Error(`mgr onboard ${mgrOnboard.status}: ${JSON.stringify(mgrOnboard.data)}`);
    S.mgrId = mgrOnboard.data.data.id;
    await prisma.user.update({ where: { email: mail('mgr') }, data: { passwordHash: hash, role: 'MANAGER', isActive: true } });
    await prisma.department.update({ where: { id: dept.id }, data: { managerId: S.mgrId } });
    const mgrlogin = await api.post('/auth/login', { email: mail('mgr'), password: PW });
    S.mgrToken = mgrlogin.data.data.accessToken;

    // A throwaway employee used only for admin-proxy attendance (no login needed).
    const attOnboard = await api.post('/employees', {
      fullName: 'Life Attend', email: mail('att'), dateOfBirth: '1996-06-06', idCard: `ID-${runId}-A`,
      departmentId: dept.id, branchId: branch.id, position: 'Analyst', startDate: '2026-01-01', baseSalary: 50000,
    }, H(S.adminToken, branch.id));
    S.attId = attOnboard.status === 201 ? attOnboard.data.data.id : undefined;

    // Dedicated employee for the salary-advance / loan payroll-recovery flow, kept
    // ISOLATED (its own payroll batch + months) so per-request deduction amounts
    // and balance transitions assert exactly. baseSalary 40000, no components, so
    // the advance affordability proxy is a known 40000.
    const alOnboard = await api.post('/employees', {
      fullName: 'Life AdvLoan', email: mail('al'), dateOfBirth: '1992-02-02', idCard: `ID-${runId}-AL`,
      departmentId: dept.id, branchId: branch.id, position: 'Analyst', startDate: '2026-01-01', baseSalary: 40000,
    }, H(S.adminToken, branch.id));
    if (alOnboard.status !== 201) throw new Error(`al onboard ${alOnboard.status}: ${JSON.stringify(alOnboard.data)}`);
    S.alEmpId = alOnboard.data.data.id;
    const alUser = await prisma.user.update({ where: { email: mail('al') }, data: { passwordHash: hash, isActive: true } });
    S.alEmpUserId = alUser.id;
    const allogin = await api.post('/auth/login', { email: mail('al'), password: PW });
    if (allogin.status !== 201) throw new Error(`al login ${allogin.status}: ${JSON.stringify(allogin.data)}`);
    S.alEmpToken = allogin.data.data.accessToken;

    // Dedicated PM workflow (kanban statuses) so project/status/sprint writes stay
    // isolated to THIS run and don't pollute the shared default workflow.
    const wf = await prisma.workflow.create({
      data: {
        name: `LIFE-WF-${runId}`, description: 'lifecycle test workflow',
        statuses: { create: [
          { name: 'To Do', color: '#64748B', category: 'TODO', position: 0, isDefault: true },
          { name: 'In Progress', color: '#00358F', category: 'IN_PROGRESS', position: 1 },
          { name: 'Done', color: '#16A34A', category: 'DONE', position: 2 },
        ] },
      },
    });
    S.workflowId = wf.id;
  }, 180000);

  afterAll(async () => {
    const q = async (fn: () => Promise<any>) => { try { await fn(); } catch { /* best-effort cleanup */ } };
    const empIds = [S.empId, S.mgrId, S.attId, S.alEmpId].filter(Boolean);
    const userIds = [S.admin?.id, S.empUserId, S.hr?.id, S.alEmpUserId].filter(Boolean);
    try {
      // Projects/tasks (task delete cascades comments/attachments/dependencies).
      if (S.projectId) {
        await q(() => prisma.workLog.deleteMany({ where: { employeeId: { in: empIds } } }));
        await q(() => prisma.timesheet.deleteMany({ where: { employeeId: { in: empIds } } }));
        await q(() => prisma.task.deleteMany({ where: { projectId: S.projectId } }));
        await q(() => prisma.sprint.deleteMany({ where: { projectId: S.projectId } }));
        await q(() => prisma.label.deleteMany({ where: { projectId: S.projectId } }));
        await q(() => prisma.projectMember.deleteMany({ where: { projectId: S.projectId } }));
        await q(() => prisma.projectRole.deleteMany({ where: { projectId: S.projectId } }));
        await q(() => prisma.project.deleteMany({ where: { id: S.projectId } }));
      }
      if (S.workflowId) {
        await q(() => prisma.projectTaskStatus.deleteMany({ where: { workflowId: S.workflowId } }));
        await q(() => prisma.workflow.deleteMany({ where: { id: S.workflowId } }));
      }
      // Teams, calendar, notifications, library.
      await q(() => prisma.teamMember.deleteMany({ where: { team: { code: { contains: runId } } } }));
      await q(() => prisma.team.deleteMany({ where: { code: { contains: runId } } }));
      await q(() => prisma.workSchedule.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.notification.deleteMany({ where: { userId: { in: userIds } } }));
      await q(() => prisma.libraryItem.deleteMany({ where: { label: { contains: runId } } }));
      // Benefits / requests keyed by employee.
      await q(() => prisma.reimbursementAttachment.deleteMany({ where: { reimbursement: { employeeId: { in: empIds } } } }));
      await q(() => prisma.reimbursement.deleteMany({ where: { employeeId: { in: empIds } } }));
      // Salary advance & loan (delete the deduction ledger before payroll items).
      await q(() => prisma.advanceLoanAttachment.deleteMany({ where: { request: { employeeId: { in: empIds } } } }));
      await q(() => prisma.advanceLoanDeduction.deleteMany({ where: { request: { employeeId: { in: empIds } } } }));
      await q(() => prisma.advanceLoanRequest.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.overtimeRequest.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.reward.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.discipline.deleteMany({ where: { employeeId: { in: empIds } } }));
      // Leave.
      await q(() => prisma.leaveAttachment.deleteMany({ where: { leaveRequest: { employeeId: { in: empIds } } } }));
      await q(() => prisma.leaveApproval.deleteMany({ where: { leaveRequest: { employeeId: { in: empIds } } } }));
      await q(() => prisma.leaveRequest.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.leaveAccrualHistory.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.leaveTypeBalance.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.leaveBalance.deleteMany({ where: { employeeId: { in: empIds } } }));
      // Attendance + face.
      await q(() => prisma.attendanceCorrection.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.attendance.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.faceDescriptor.deleteMany({ where: { employeeId: { in: empIds } } }));
      // Contracts + salary.
      await q(() => prisma.terminationRequest.deleteMany({ where: { contract: { employeeId: { in: empIds } } } }));
      await q(() => prisma.contractAppendix.deleteMany({ where: { contract: { employeeId: { in: empIds } } } }));
      await q(() => prisma.contract.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.salaryComponent.deleteMany({ where: { employeeId: { in: empIds } } }));
      // Payroll.
      await q(() => prisma.payrollItem.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.payroll.deleteMany({ where: { id: { in: S.payrollIds } } }));
      await q(() => prisma.payrollBatchMember.deleteMany({ where: { employeeId: { in: empIds } } }));
      await q(() => prisma.payrollBatch.deleteMany({ where: { name: { contains: runId } } }));
      await q(() => prisma.holiday.deleteMany({ where: { name: { contains: runId } } }));
      await q(() => prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }));
      // Null out manager FKs so the employee/department deletes don't trip.
      await q(() => prisma.department.updateMany({ where: { code: { contains: runId } }, data: { managerId: null } }));
      await q(() => prisma.branch.updateMany({ where: { code: { contains: runId } }, data: { managerId: null } }));
      await q(() => prisma.employee.deleteMany({ where: { OR: [{ employeeCode: { contains: runId } }, { email: { contains: runId } }] } }));
      await q(() => prisma.department.deleteMany({ where: { code: { contains: runId } } }));
      await q(() => prisma.branch.deleteMany({ where: { code: { contains: runId } } }));
      await q(() => prisma.user.deleteMany({ where: { email: { contains: runId } } }));
      // Restore any system settings we overrode.
      for (const [key, orig] of Object.entries(S.origSettings ?? {})) {
        if (orig === null) await q(() => prisma.systemSetting.deleteMany({ where: { key } }));
        else await q(() => prisma.systemSetting.update({ where: { key }, data: { value: orig as string } }));
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  // ── Health ──────────────────────────────────────────────────────────────────
  describe('Health', () => {
    it('root responds and favicon 204s', async () => {
      const root = await api.get('/');
      expect(root.status).toBeLessThan(500);
      const fav = await api.get('/favicon.ico');
      expect([200, 204]).toContain(fav.status);
    });
  });

  // ── Auth ──────────────────────────────────────────────────────────────────
  describe('Auth', () => {
    it('admin session resolves via /auth/me', async () => {
      const me = await G('/auth/me');
      expect(me.status).toBe(200);
      expect(me.data.data.role).toBe('ADMIN');
    });
    it('onboarded employee can log in and is linked to an employee', async () => {
      const me = await G('/auth/me', S.empToken);
      expect(me.status).toBe(200);
      expect(me.data.data.employee?.id).toBe(S.empId);
    });
    it('change-password works and the new password authenticates (on the HR account)', async () => {
      const NEW = 'Passw0rd!2';
      const chg = await PT('/auth/change-password', { oldPassword: PW, newPassword: NEW }, S.hrToken);
      expect(chg.status).toBe(200);
      const relogin = await api.post('/auth/login', { email: mail('hr'), password: NEW });
      expect(relogin.status).toBe(201);
      S.hrToken = relogin.data.data.accessToken; // keep the HR token valid for later blocks
    });
  });

  // ── Users (full CRUD on a throwaway user) ───────────────────────────────────
  describe('Users', () => {
    it('lists and reads users', async () => {
      const list = await G('/users?page=1&limit=10');
      expect(list.status).toBe(200);
      const one = await G(`/users/${S.empUserId}`);
      expect(one.status).toBe(200);
    });
    it('creates, updates, re-roles and deactivates a user', async () => {
      const create = await P('/users', { email: mail('u2'), password: PW, role: 'EMPLOYEE' });
      expect(create.status).toBe(201);
      const uid = idOf(create);
      S.throwUserId = uid;
      const upd = await PT(`/users/${uid}`, { isActive: true });
      expect(upd.status).toBe(200);
      const role = await PT(`/users/${uid}/role`, { role: 'MANAGER' });
      expect(role.status).toBe(200);
      const del = await D(`/users/${uid}`);
      expect(del.status).toBe(200);
    });
  });

  // ── Employees (reads + profile edits) ───────────────────────────────────────
  describe('Employees', () => {
    it('serves directory, list, statistics and derived stats', async () => {
      for (const p of [
        `/employees/directory?search=${runId}`,
        '/employees?page=1&limit=10',
        '/employees/statistics',
        '/employees/without-active-contract?limit=50',
        '/employees/top-performers?limit=5&period=month',
        `/employees/generate-code?departmentId=${S.deptId}`,
        '/employees/stats/profile-completion',
      ]) {
        const res = await G(p);
        expect(res.status).toBe(200);
      }
    });
    it('reads one employee, history, profile, documents and activities', async () => {
      for (const p of [
        `/employees/${S.empId}`,
        `/employees/${S.empId}/history`,
        `/employees/${S.empId}/profile`,
        `/employees/${S.empId}/documents`,
        `/employees/${S.empId}/activities?page=1&limit=20`,
        `/employees/${S.empId}/activities/stats`,
      ]) {
        const res = await G(p);
        expect(res.status).toBe(200);
      }
    });
    it('updates employee core fields and profile', async () => {
      const upd = await PT(`/employees/${S.empId}`, { position: 'Senior Engineer' });
      expect(upd.status).toBe(200);
      const prof = await PT(`/employees/${S.empId}/profile`, { nationality: 'Indian', maritalStatus: 'SINGLE' });
      expect(prof.status).toBe(200);
    });
    it('streams the xlsx import template', async () => {
      const res = await api.get('/employees/import/template', { headers: H(S.adminToken).headers, responseType: 'arraybuffer' });
      expect(res.status).toBe(200);
    });
    it('soft-deletes (terminates) a throwaway employee', async () => {
      // Dedicated throwaway (runId-tagged so afterAll sweeps it) → never perturbs the
      // primary/manager/AL employees the later payroll & benefit assertions depend on.
      const create = await P('/employees', {
        fullName: 'Life Throwaway', email: mail('del'), dateOfBirth: '1995-05-05', idCard: `ID-${runId}-DEL`,
        departmentId: S.deptId, branchId: S.branchId, position: 'Temp', startDate: '2026-01-01', baseSalary: 30000,
      }, S.adminToken, S.branchId);
      expect(create.status).toBe(201);
      const del = await D(`/employees/${idOf(create)}`);
      expect(del.status).toBe(200);
    });
  });

  // ── Branches (CRUD on a throwaway branch) ───────────────────────────────────
  describe('Branches', () => {
    it('lists, reads, creates, updates and soft-deletes a branch', async () => {
      const list = await G('/branches');
      expect(list.status).toBe(200);
      const read = await G(`/branches/${S.branchId}`);
      expect(read.status).toBe(200);
      const create = await P('/branches', { code: `LIFE-BR2-${runId}`, name: 'Life Branch 2' });
      expect(create.status).toBe(201);
      const id = idOf(create);
      const upd = await PT(`/branches/${id}`, { name: 'Life Branch 2b' });
      expect(upd.status).toBe(200);
      const del = await D(`/branches/${id}`);
      expect(del.status).toBe(200);
    });
  });

  // ── Departments (reads, change-request review, manager, CRUD) ───────────────
  describe('Departments', () => {
    it('serves tree, stats, hierarchy validation and reads', async () => {
      for (const p of [
        '/departments',
        '/departments/tree',
        '/departments/performance-stats',
        '/departments/validate/hierarchy',
        '/departments/change-requests',
        `/departments/${S.deptId}`,
        `/departments/${S.deptId}/performance`,
      ]) {
        const res = await G(p);
        expect(res.status).toBe(200);
      }
    });
    it('files a change-request and rejects it via review (no dept mutation)', async () => {
      const create = await P(`/departments/${S.deptId}/change-requests`, {
        requestType: 'CHANGE_MANAGER', newManagerId: S.empId, reason: 'Rotate ownership for the quarter',
      });
      expect(create.status).toBe(201);
      const reqId = idOf(create);
      const read = await G(`/departments/change-requests/${reqId}`);
      expect(read.status).toBe(200);
      const review = await PT(`/departments/change-requests/${reqId}/review`, { action: 'REJECT', reviewNote: 'Not this cycle' });
      expect(review.status).toBe(200);
    });
    it('reassigns the department manager', async () => {
      const res = await PT(`/departments/${S.deptId}/manager`, { managerId: S.mgrId });
      expect(res.status).toBe(200);
    });
    it('creates, updates and reads a department', async () => {
      const create = await P('/departments', { code: `LIFE-ORG-${runId}`, name: 'Ops' });
      expect(create.status).toBe(201);
      const id = idOf(create);
      S.orgDeptId = id;
      const upd = await PT(`/departments/${id}`, { name: 'Operations' });
      expect(upd.status).toBe(200);
      const get = await G(`/departments/${id}`);
      expect(get.data.data.name).toBe('Operations');
      const del = await D(`/departments/${id}`); // empty dept → soft delete ok
      expect(del.status).toBe(200);
    });
  });

  // ── Contract + salary ──────────────────────────────────────────────────────
  describe('Contract & salary', () => {
    it('creates an ACTIVE contract for the employee', async () => {
      const res = await P('/contracts', {
        employeeId: S.empId, contractType: 'FIXED_TERM', startDate: '2026-01-01', endDate: '2026-12-31', salary: 60000,
      });
      expect(res.status).toBe(201);
      expect(res.data.data.status).toBe('ACTIVE');
    });
    it('serves contract reads (list/expiring/statistics/by-employee)', async () => {
      for (const p of [
        '/contracts?page=1&limit=10',
        '/contracts/expiring?days=365',
        '/contracts/statistics',
        `/contracts/employee/${S.empId}`,
        '/contracts/termination-requests/pending',
      ]) {
        const res = await G(p);
        expect(res.status).toBe(200);
      }
    });
    it('drives a full contract lifecycle on the manager (patch → terminate-request → reject → renew → terminate)', async () => {
      const create = await P('/contracts', {
        employeeId: S.mgrId, contractType: 'FIXED_TERM', startDate: '2026-01-01', endDate: '2026-12-31', salary: 90000,
      });
      expect(create.status).toBe(201);
      const cid = idOf(create);
      expect((await G(`/contracts/${cid}`)).status).toBe(200);
      expect((await PT(`/contracts/${cid}`, { notes: 'reviewed' })).status).toBe(200);

      const tr = await P('/contracts/termination-requests', {
        contractId: cid, requestedBy: S.admin.id, terminationCategory: 'RESIGNATION',
        noticeDate: '2026-06-01', terminationDate: '2026-07-31', reason: 'Employee resigned',
      });
      expect(tr.status).toBe(201);
      const trId = idOf(tr);
      expect((await G(`/contracts/termination-requests/${trId}`)).status).toBe(200);
      expect((await G(`/contracts/${cid}/termination-requests`)).status).toBe(200);
      expect((await P(`/contracts/termination-requests/${trId}/reject`, { approverId: S.admin.id, reason: 'Retained' })).status).toBe(201);

      const renew = await P(`/contracts/${cid}/renew`, { newEndDate: '2027-12-31', newSalary: 95000 });
      expect(renew.status).toBe(201);
      const term = await P(`/contracts/${cid}/terminate`, { reason: 'End of engagement' });
      expect(term.status).toBe(201);
    });
    it('approves a termination request → contract transitions to TERMINATED', async () => {
      if (!S.attId) return; // isolated on the throwaway attendance employee (own contract)
      const create = await P('/contracts', {
        employeeId: S.attId, contractType: 'FIXED_TERM', startDate: '2026-01-01', endDate: '2026-12-31', salary: 50000,
      });
      expect(create.status).toBe(201);
      const cid = idOf(create);
      const tr = await P('/contracts/termination-requests', {
        contractId: cid, requestedBy: S.admin.id, terminationCategory: 'RESIGNATION',
        noticeDate: '2026-06-01', terminationDate: '2026-07-31', reason: 'Approved exit',
      });
      expect(tr.status).toBe(201);
      const approve = await P(`/contracts/termination-requests/${idOf(tr)}/approve`, { approverId: S.admin.id, comments: 'Cleared' });
      expect(approve.status).toBe(201);
      expect((approve.data?.data ?? approve.data).status).toBe('APPROVED');
      const contract = await G(`/contracts/${cid}`);
      expect(contract.data.data.status).toBe('TERMINATED'); // approval cascades to the contract
    });
    it('adds a BASIC salary component and drives component CRUD', async () => {
      const basic = await P('/salary-components', { employeeId: S.empId, componentType: 'BASIC', amount: 60000 });
      expect(basic.status).toBe(201);
      expect(basic.data.data.componentType).toBe('BASIC');

      const allow = await P('/salary-components', { employeeId: S.empId, componentType: 'ALLOWANCE', amount: 5000 });
      expect(allow.status).toBe(201);
      const acId = idOf(allow);
      expect((await G('/salary-components?page=1&limit=10')).status).toBe(200);
      expect((await G(`/salary-components/employee/${S.empId}`)).status).toBe(200);
      expect((await G(`/salary-components/${acId}`)).status).toBe(200);
      expect((await PT(`/salary-components/${acId}`, { amount: 5500 })).status).toBe(200);
      expect((await P(`/salary-components/${acId}/deactivate`)).status).toBe(201);
      expect((await D(`/salary-components/${acId}`)).status).toBe(200);
    });
  });

  // ── Attendance ──────────────────────────────────────────────────────────────
  describe('Attendance', () => {
    it('employee checks in (geofence off → no coords needed)', async () => {
      const res = await P('/attendances/check-in', {}, S.empToken);
      expect([200, 201]).toContain(res.status);
      expect(res.data.data.status).toBe('PRESENT');
      expect(res.data.data.branchId).toBe(S.branchId); // stamped with the employee's branch
      S.attnId = res.data.data.id;
    });
    it('employee checks out', async () => {
      const res = await P('/attendances/check-out', {}, S.empToken);
      expect([200, 201]).toContain(res.status);
      expect(res.data.data.checkOut).toBeTruthy();
    });
    it('manager runs a lunch cycle then checks out', async () => {
      expect([200, 201]).toContain((await P('/attendances/check-in', {}, S.mgrToken)).status);
      expect([200, 201]).toContain((await P('/attendances/lunch-check-out', {}, S.mgrToken)).status);
      const status = await G('/attendances/lunch-status', S.mgrToken);
      expect(status.status).toBe(200);
      expect([200, 201]).toContain((await P('/attendances/lunch-check-in', {}, S.mgrToken)).status);
      expect([200, 201]).toContain((await P('/attendances/check-out', {}, S.mgrToken)).status);
    });
    it('admin checks a throwaway employee in and out by id, and records a manual entry', async () => {
      if (!S.attId) return;
      expect([200, 201]).toContain((await P(`/attendances/check-in/${S.attId}`, {})).status);
      expect([200, 201]).toContain((await P(`/attendances/check-out/${S.attId}`, {})).status);
      const manual = await P('/attendances/manual', { employeeId: S.attId, date: '2026-07-03', checkIn: '09:05', checkOut: '18:02', status: 'PRESENT' });
      expect(manual.status).toBe(201);
    });
    it('employee sees their own month in /attendances/my', async () => {
      const res = await G('/attendances/my?month=7&year=2026', S.empToken);
      expect(res.status).toBe(200);
      expect(res.data.summary.presentDays).toBeGreaterThanOrEqual(1);
    });
    it('employee reads their own today record', async () => {
      const res = await G('/attendances/today', S.empToken); // self endpoint → resolves via the caller's employeeId
      expect(res.status).toBe(200);
    });
    it('serves the admin attendance read surface (list/report/stats/overview/validate)', async () => {
      for (const p of [
        '/attendances/today/all',
        `/attendances/employee/${S.empId}?month=7&year=2026`,
        '/attendances/report?month=7&year=2026',
        '/attendances/statistics?month=7&year=2026',
        '/attendances/absenteeism-stats',
        '/attendances/validate?month=7&year=2026',
        '/attendances/overview?period=today',
        `/attendances/list?period=custom&startDate=2026-07-07&endDate=2026-07-07&search=${runId}&limit=100`,
      ]) {
        const res = await G(p, S.adminToken, S.branchId);
        expect(res.status).toBe(200);
      }
      if (S.attnId) expect((await G(`/attendances/${S.attnId}`, S.adminToken, S.branchId)).status).toBe(200);
    });
  });

  // ── Attendance corrections ──────────────────────────────────────────────────
  describe('Attendance corrections', () => {
    it('employee files a correction (past date), admin approves it', async () => {
      const create = await P('/attendance-corrections', {
        date: '2026-07-06', requestedCheckIn: '2026-07-06T09:10:00', requestedCheckOut: '2026-07-06T18:05:00', reason: 'Forgot to check in',
      }, S.empToken);
      expect(create.status).toBe(201);
      expect(create.data.status).toBe('PENDING'); // raw entity (no envelope)
      const approve = await P(`/attendance-corrections/${create.data.id}/approve`, {});
      expect(approve.status).toBe(201);
      expect(approve.data.status).toBe('APPROVED');
    });
    it('serves correction reads (list/pending/my/usage/by-employee/by-id)', async () => {
      expect((await G('/attendance-corrections')).status).toBe(200);
      expect((await G('/attendance-corrections/pending')).status).toBe(200);
      expect((await G('/attendance-corrections/my-requests', S.empToken)).status).toBe(200);
      expect((await G('/attendance-corrections/my-usage', S.empToken)).status).toBe(200);
      expect((await G(`/attendance-corrections/employee/${S.empId}`)).status).toBe(200);
    });
    it('admin files a correction for the manager (bypasses limit) and rejects it', async () => {
      const create = await P(`/attendance-corrections/employee/${S.mgrId}`, {
        date: '2026-07-05', requestedCheckIn: '2026-07-05T09:00:00', reason: 'Missed punch',
      });
      expect(create.status).toBe(201);
      expect((await G(`/attendance-corrections/${create.data.id}`)).status).toBe(200);
      const reject = await P(`/attendance-corrections/${create.data.id}/reject`, { rejectedReason: 'No evidence' });
      expect(reject.status).toBe(201);
      expect(reject.data.status).toBe('REJECTED');
    });
    it('employee files then cancels a correction', async () => {
      const create = await P('/attendance-corrections', { date: '2026-07-04', requestedCheckIn: '2026-07-04T09:00:00', reason: 'Will cancel this' }, S.empToken);
      expect(create.status).toBe(201);
      const cancel = await D(`/attendance-corrections/${create.data.id}`, S.empToken);
      expect(cancel.status).toBe(200);
    });
  });

  // ── Leave ────────────────────────────────────────────────────────────────────
  describe('Leave', () => {
    it('auto-initialises a leave balance for the employee', async () => {
      const res = await G(`/leave-balances/employee/${S.empId}?year=2026`);
      expect(res.status).toBe(200);
      expect(res.data.data.annualLeave).toBeGreaterThan(0);
    });
    it('employee requests UNPAID leave, admin approves it', async () => {
      const create = await P('/leave-requests', {
        leaveType: 'UNPAID', startDate: '2026-07-20', endDate: '2026-07-21', reason: 'Personal',
      }, S.empToken);
      expect(create.status).toBe(201);
      expect(create.data.data.status).toBe('PENDING');
      const approve = await P(`/leave-requests/${create.data.data.id}/approve`, {});
      expect(approve.status).toBe(201);
      expect(approve.data.data.status).toBe('APPROVED');
    });
    it('employee requests then admin rejects; employee cancels a third request', async () => {
      const rej = await P('/leave-requests', { leaveType: 'ANNUAL', startDate: '2026-08-10', endDate: '2026-08-11', reason: 'Trip' }, S.empToken);
      expect(rej.status).toBe(201);
      expect((await P(`/leave-requests/${rej.data.data.id}/reject`, { rejectedReason: 'Blackout period' })).status).toBe(201);
      const can = await P('/leave-requests', { leaveType: 'ANNUAL', startDate: '2026-09-10', endDate: '2026-09-11', reason: 'To cancel' }, S.empToken);
      expect(can.status).toBe(201);
      expect((await D(`/leave-requests/${can.data.data.id}`, S.empToken)).status).toBe(200);
    });
    it('serves leave-request reads (list/pending/my/by-employee/by-id/team-balances)', async () => {
      const list = await G('/leave-requests?page=1&limit=10');
      expect(list.status).toBe(200);
      expect((await G('/leave-requests/pending')).status).toBe(200);
      expect((await G('/leave-requests/my-requests', S.empToken)).status).toBe(200);
      expect((await G(`/leave-requests/employee/${S.empId}`)).status).toBe(200);
      const one = await P('/leave-requests', { leaveType: 'UNPAID', startDate: '2026-11-03', endDate: '2026-11-03', reason: 'Read by id' }, S.empToken);
      expect((await G(`/leave-requests/${one.data.data.id}`, S.empToken)).status).toBe(200);
      const team = await G('/leave-requests/team-balances', S.mgrToken);
      expect(team.status).toBe(200);
    });
    it('serves leave-balance admin surface + per-employee accrual', async () => {
      for (const p of [
        '/leave-balances?year=2026',
        '/leave-balances/company-overview?year=2026',
        '/leave-balances/leave-types',
        '/leave-balances/accrual/history',
      ]) {
        expect((await G(p)).status).toBe(200);
      }
      expect((await P(`/leave-balances/employee/${S.mgrId}/init/2027`)).status).toBe(201);
      expect((await PT(`/leave-balances/employee/${S.mgrId}/year/2027`, { annualLeave: 15, sickLeave: 8 })).status).toBe(200);
      expect((await P(`/leave-balances/accrual/employee/${S.mgrId}`, { daysToAdd: 1, notes: 'monthly accrual' })).status).toBe(201);
      expect((await PT(`/leave-balances/${S.mgrId}/2027/ANNUAL`, { allocated: 16, carriedOver: 2 })).status).toBe(200);
    });
    it('lists (empty) attachments for a leave request', async () => {
      const lr = await P('/leave-requests', { leaveType: 'SICK', startDate: '2026-10-01', endDate: '2026-10-01', reason: 'Attachment holder' }, S.empToken);
      expect(lr.status).toBe(201);
      const list = await G(`/leave-requests/${lr.data.data.id}/attachments`, S.empToken);
      expect(list.status).toBe(200);
      await D(`/leave-requests/${lr.data.data.id}`, S.empToken); // clean the holder
    });
  });

  // ── Overtime (mostly raw entities) ───────────────────────────────────────────
  describe('Overtime', () => {
    it('admin files overtime for the employee and approves it', async () => {
      const create = await P(`/overtime/employee/${S.empId}`, {
        date: '2026-07-15', startTime: '2026-07-15T19:00:00', endTime: '2026-07-15T22:00:00', hours: 3, reason: 'Release night',
      });
      if (create.status !== 201) {
        console.warn(`  ⚠ overtime skipped (${create.status}): ${JSON.stringify(create.data?.message)}`);
        return;
      }
      expect(create.data.status).toBe('PENDING');
      const approve = await P(`/overtime/${create.data.id}/approve`, {});
      expect(approve.status).toBe(201);
      expect(approve.data.status).toBe('APPROVED');
    });
    it('admin files another and rejects it', async () => {
      const create = await P(`/overtime/employee/${S.mgrId}`, {
        date: '2026-07-16', startTime: '2026-07-16T19:00:00', endTime: '2026-07-16T21:00:00', hours: 2, reason: 'Support',
      });
      if (create.status !== 201) return;
      const reject = await P(`/overtime/${create.data.id}/reject`, { rejectedReason: 'Not pre-approved' });
      expect(reject.status).toBe(201);
      expect(reject.data.status).toBe('REJECTED');
    });
    it('employee files their OWN overtime (self-service) then cancels it', async () => {
      const create = await P('/overtime', {
        date: '2026-07-17', startTime: '2026-07-17T19:00:00', endTime: '2026-07-17T21:00:00', hours: 2, reason: 'Self logged',
      }, S.empToken);
      if (create.status !== 201) {
        console.warn(`  ⚠ self-overtime skipped (${create.status}): ${JSON.stringify(create.data?.message)}`);
        return;
      }
      expect(create.data.status).toBe('PENDING');
      const del = await D(`/overtime/${create.data.id}`, S.empToken); // owner-scoped cancel
      expect(del.status).toBe(200);
    });
    it('serves overtime reads (list/pending/my/by-employee/hours/report)', async () => {
      expect((await G('/overtime?page=1&limit=10')).status).toBe(200);
      expect((await G('/overtime/pending')).status).toBe(200);
      expect((await G('/overtime/my-requests', S.empToken)).status).toBe(200);
      expect((await G(`/overtime/employee/${S.empId}`)).status).toBe(200);
      expect((await G(`/overtime/employee/${S.empId}/hours/7/2026`)).status).toBe(200);
      expect((await G('/overtime/report/7/2026')).status).toBe(200);
    });
  });

  // ── Reimbursement (mostly raw entities) ──────────────────────────────────────
  describe('Reimbursement', () => {
    it('employee files a reimbursement, admin approves it', async () => {
      const create = await P('/reimbursements', {
        type: 'Travel', amount: 1250.5, expenseDate: '2026-07-01', description: 'Client visit cab',
      }, S.empToken);
      if (create.status !== 201) {
        console.warn(`  ⚠ reimbursement skipped (${create.status}): ${JSON.stringify(create.data?.message)}`);
        return;
      }
      expect(create.data.status).toBe('PENDING');
      const approve = await P(`/reimbursements/${create.data.id}/approve`, { remarks: 'ok' });
      expect(approve.status).toBe(201);
      expect(approve.data.status).toBe('APPROVED');
    });
    it('employee files another; admin rejects; employee cancels a third', async () => {
      const rej = await P('/reimbursements', { type: 'Food', amount: 300, expenseDate: '2026-07-02' }, S.empToken);
      if (rej.status !== 201) return;
      expect((await P(`/reimbursements/${rej.data.id}/reject`, { remarks: 'Missing receipt' })).status).toBe(201);
      const can = await P('/reimbursements', { type: 'Other', amount: 100, expenseDate: '2026-07-03' }, S.empToken);
      if (can.status === 201) expect((await D(`/reimbursements/${can.data.id}`, S.empToken)).status).toBe(200);
    });
    it('serves reimbursement reads (list/pending/my) and empty attachments', async () => {
      expect((await G('/reimbursements')).status).toBe(200);
      expect((await G('/reimbursements/pending')).status).toBe(200);
      const my = await G('/reimbursements/my-requests', S.empToken);
      expect(my.status).toBe(200);
      const first = Array.isArray(my.data) ? my.data[0] : my.data?.data?.[0];
      if (first?.id) {
        expect((await G(`/reimbursements/${first.id}`, S.empToken)).status).toBe(200);
        expect((await G(`/reimbursements/${first.id}/attachments`, S.empToken)).status).toBe(200);
      }
    });
  });

  // ── Rewards & discipline ─────────────────────────────────────────────────────
  describe('Rewards & discipline', () => {
    it('grants, lists and deletes a reward', async () => {
      const res = await P('/rewards', { employeeId: S.empId, reason: 'Great quarter', amount: 5000, rewardDate: '2026-07-01', rewardType: 'BONUS' });
      expect(res.status).toBe(201);
      const id = idOf(res);
      expect((await G('/rewards?page=1&limit=10')).status).toBe(200);
      expect((await G(`/rewards/employee/${S.empId}`)).status).toBe(200);
      expect((await D(`/rewards/${id}`)).status).toBe(200);
    });
    it('records, lists and deletes a discipline note', async () => {
      const res = await P('/disciplines', { employeeId: S.empId, reason: 'Late submission', disciplineType: 'WARNING', amount: 0, disciplineDate: '2026-07-02' });
      expect(res.status).toBe(201);
      expect(res.data.data.disciplineType).toBe('WARNING');
      const id = idOf(res);
      expect((await G('/disciplines?page=1&limit=10')).status).toBe(200);
      expect((await G(`/disciplines/employee/${S.empId}`)).status).toBe(200);
      expect((await D(`/disciplines/${id}`)).status).toBe(200);
    });
  });

  // ── Holidays & per-branch working week (feature) ─────────────────────────────
  // Isolated to year 2029 so holiday side effects never touch the 2026 payroll /
  // attendance flows in this run. Jan 1 2029 is a Monday (a working day under
  // every weekly-off config), so a holiday there reduces work days deterministically.
  //   Jan 2029: 31 days — Fridays 5,12,19,26 (4); Saturdays 6,13,20,27 (4);
  //             Sundays 7,14,21,28 (4).
  describe('Holidays & per-branch work-week', () => {
    const Y = 2029;
    const Y2 = 2030;
    const s: any = {};

    it('creates branches with distinct weekly-off days', async () => {
      const gulf = await P('/branches', { code: `LIFE-GULF-${runId}`.slice(0, 50), name: 'Gulf Branch', weeklyOffDays: '5,6' });
      expect(gulf.status).toBe(201);
      s.gulf = idOf(gulf);
      expect(gulf.data.data.weeklyOffDays).toBe('5,6');

      const std = await P('/branches', { code: `LIFE-STD-${runId}`.slice(0, 50), name: 'Std Branch', weeklyOffDays: '0' });
      expect(std.status).toBe(201);
      s.std = idOf(std);

      // Persisted + read back.
      expect((await G(`/branches/${s.gulf}`)).data.data.weeklyOffDays).toBe('5,6');
    });

    it('work-days differ by branch weekly-off', async () => {
      const gulf = (await G(`/holidays/work-days/1/${Y}?branchId=${s.gulf}`)).data.data;
      const std = (await G(`/holidays/work-days/1/${Y}?branchId=${s.std}`)).data.data;
      expect(gulf.totalDays).toBe(31);
      expect(gulf.weekends).toBe(8); // 4 Fri + 4 Sat
      expect(gulf.workDays).toBe(23);
      expect(std.weekends).toBe(4); // Sundays only
      expect(std.workDays).toBe(27);
      expect(gulf.workDays).toBeLessThan(std.workDays);
    });

    it('CRUD: company-wide + branch-specific, cross-scope same date allowed, duplicate rejected', async () => {
      const comp = await P('/holidays', { name: `NY ${runId}`, date: `${Y}-01-01` });
      expect(comp.status).toBe(201);
      expect(comp.data.data.branchId).toBeNull();
      expect(comp.data.data.year).toBe(Y); // derived from date
      s.compId = idOf(comp);

      // Same date, different scope (gulf branch) — allowed by the partial unique index.
      const gulfHol = await P('/holidays', { name: `NY-Gulf ${runId}`, date: `${Y}-01-01`, branchId: s.gulf });
      expect(gulfHol.status).toBe(201);
      s.gulfHolId = idOf(gulfHol);

      // Duplicate company-wide holiday on the same date → 409.
      expect((await P('/holidays', { name: `Dup ${runId}`, date: `${Y}-01-01` })).status).toBe(409);

      // Read one + partial update.
      expect((await G(`/holidays/${s.compId}`)).status).toBe(200);
      const upd = await PT(`/holidays/${s.compId}`, { description: 'New Year Day' });
      expect(upd.status).toBe(200);
      expect(upd.data.data.description).toBe('New Year Day');
    });

    it('holidays cut work-days; branch-specific applies to its branch only', async () => {
      // Company-wide NY (Jan 1, Mon) now subtracted for BOTH branches.
      const gulf = (await G(`/holidays/work-days/1/${Y}?branchId=${s.gulf}`)).data.data;
      const std = (await G(`/holidays/work-days/1/${Y}?branchId=${s.std}`)).data.data;
      expect(gulf.holidays).toBe(1);
      expect(std.holidays).toBe(1);
      expect(gulf.workDays).toBe(22); // 23 - 1
      expect(std.workDays).toBe(26); // 27 - 1

      // Branch-only holiday on Jan 8 (Mon) for gulf.
      const bh = await P('/holidays', { name: `GulfOnly ${runId}`, date: `${Y}-01-08`, branchId: s.gulf });
      expect(bh.status).toBe(201);
      const gulf2 = (await G(`/holidays/work-days/1/${Y}?branchId=${s.gulf}`)).data.data;
      const std2 = (await G(`/holidays/work-days/1/${Y}?branchId=${s.std}`)).data.data;
      expect(gulf2.workDays).toBe(21); // gulf sees its own extra holiday
      expect(std2.workDays).toBe(26); // std unaffected by a gulf-only holiday
    });

    it('list scoping: a branch sees company-wide + its own holidays only', async () => {
      const gulfNames = (await G(`/holidays?year=${Y}&branchId=${s.gulf}`)).data.data.map((h: any) => h.name);
      expect(gulfNames).toContain(`NY ${runId}`); // company-wide
      expect(gulfNames).toContain(`GulfOnly ${runId}`); // gulf-specific
      const stdNames = (await G(`/holidays?year=${Y}&branchId=${s.std}`)).data.data.map((h: any) => h.name);
      expect(stdNames).not.toContain(`GulfOnly ${runId}`);
    });

    it('copy-year rolls holidays into the next year with shifted dates', async () => {
      const res = await P('/holidays/copy-year', { fromYear: Y, toYear: Y2 });
      expect(res.status).toBe(201);
      expect(res.data.data.created).toBeGreaterThanOrEqual(2);
      const next = (await G(`/holidays?year=${Y2}`)).data.data;
      const nyNext = next.find((h: any) => h.name === `NY ${runId}` && !h.branchId);
      expect(nyNext).toBeTruthy();
      expect(String(nyNext.date).slice(0, 10)).toBe(`${Y2}-01-01`);
    });

    it('serves holidays via the /year/:year variant', async () => {
      const res = await G(`/holidays/year/${Y}`);
      expect(res.status).toBe(200);
      expect(res.data.data.some((h: any) => h.name === `NY ${runId}`)).toBe(true);
    });

    it('requires auth to list holidays (branch scoping needs a user context)', async () => {
      expect((await api.get('/holidays')).status).toBe(401);
    });

    it('deletes a holiday', async () => {
      expect((await D(`/holidays/${s.gulfHolId}`)).status).toBe(200);
      expect((await G(`/holidays/${s.gulfHolId}`)).status).toBe(404);
    });
  });

  // ── Teams ────────────────────────────────────────────────────────────────────
  describe('Teams', () => {
    it('creates a team, manages members, and tears it down', async () => {
      const create = await P('/teams', { name: `Life Team ${runId}`, code: `LIFE-TEAM-${runId}`.slice(0, 50), departmentId: S.deptId });
      expect(create.status).toBe(201);
      const teamId = idOf(create);
      expect((await G('/teams')).status).toBe(200);
      expect((await G(`/teams/${teamId}`)).status).toBe(200);
      expect((await PT(`/teams/${teamId}`, { description: 'updated' })).status).toBe(200);
      const add = await P(`/teams/${teamId}/members`, { employeeId: S.empId });
      expect(add.status).toBe(201);
      const memberId = idOf(add);
      expect((await G(`/teams/employee/${S.empId}`)).status).toBe(200);
      expect((await D(`/teams/${teamId}/members/${memberId}`)).status).toBe(200);
      expect((await D(`/teams/${teamId}`)).status).toBe(200);
    });
  });

  // ── Calendar / work schedules ────────────────────────────────────────────────
  describe('Calendar', () => {
    it('serves calendar reads and full schedule CRUD', async () => {
      expect((await G('/calendar/my-calendar?startDate=2026-07-01&endDate=2026-07-31', S.empToken)).status).toBe(200);
      expect((await G('/calendar/overview?startDate=2026-07-01&endDate=2026-07-31')).status).toBe(200);
      expect((await G('/calendar/stats?month=7&year=2026', S.empToken)).status).toBe(200);
      expect((await G(`/calendar/schedules/conflicts/check?employeeId=${S.empId}&startDate=2026-07-01&endDate=2026-07-31`)).status).toBe(200);

      const create = await P('/calendar/schedules', {
        employeeId: S.empId, date: '2026-07-10', shiftType: 'FULL_DAY', startTime: '2026-07-10T09:00:00Z', endTime: '2026-07-10T18:00:00Z',
      });
      expect(create.status).toBe(201);
      const id = idOf(create);
      expect((await G(`/calendar/schedules/${id}`)).status).toBe(200);
      expect((await PU(`/calendar/schedules/${id}`, { notes: 'adjusted' })).status).toBe(200);

      const bulk = await P('/calendar/schedules/bulk', {
        schedules: [{ employeeId: S.empId, date: '2026-07-11', shiftType: 'FULL_DAY', startTime: '2026-07-11T09:00:00Z', endTime: '2026-07-11T18:00:00Z' }],
      });
      expect(bulk.status).toBe(201);
      expect((await D(`/calendar/schedules/${id}`)).status).toBe(200);
    });
  });

  // ── Notifications ────────────────────────────────────────────────────────────
  describe('Notifications', () => {
    it('admin pushes notifications; employee reads, marks read and clears them', async () => {
      const n1 = await P('/notifications', { userId: S.empUserId, title: `Ping ${runId}`, message: 'First' });
      expect(n1.status).toBe(201);
      await P('/notifications', { userId: S.empUserId, title: `Ping2 ${runId}`, message: 'Second' });
      expect((await G('/notifications', S.empToken)).status).toBe(200);
      expect((await G('/notifications/unread-count', S.empToken)).status).toBe(200);
      expect((await P(`/notifications/${idOf(n1)}/read`, {}, S.empToken)).status).toBe(201);
      expect((await P('/notifications/read-all', {}, S.empToken)).status).toBe(201);
      expect((await D(`/notifications/${idOf(n1)}`, S.empToken)).status).toBe(200);
      expect((await D('/notifications', S.empToken)).status).toBe(200); // nuke caller's remaining
    });
  });

  // ── Projects, tasks & time tracking ──────────────────────────────────────────
  describe('Projects & tasks', () => {
    it('creates a project on the isolated workflow', async () => {
      const create = await P('/projects', { name: `LIFE-PROJ-${runId}`, workflowId: S.workflowId, memberIds: [S.empId] });
      if (create.status !== 201) {
        console.warn(`  ⚠ project suite skipped (${create.status}): ${JSON.stringify(create.data?.message)}`);
        return;
      }
      expect(create.status).toBe(201);
      S.projectId = idOf(create);
      S.projectSlug = create.data.data.slug;
    });
    it('serves project reads (stats/list/by-slug/charts/permissions/activity/members)', async () => {
      if (!S.projectId) return;
      for (const p of [
        '/projects/stats',
        '/projects?page=1&limit=10',
        `/projects/by-slug/${S.projectSlug}`,
        `/projects/${S.projectSlug}/charts`,
        `/projects/${S.projectId}`,
        `/projects/${S.projectId}/my-permissions`,
        `/projects/${S.projectId}/activity`,
        `/projects/${S.projectId}/members`,
      ]) {
        expect((await G(p)).status).toBe(200);
      }
    });
    it('manages project roles', async () => {
      if (!S.projectId) return;
      expect((await G('/project-roles/catalog')).status).toBe(200);
      expect((await G(`/projects/${S.projectId}/roles`)).status).toBe(200);
      const create = await P(`/projects/${S.projectId}/roles`, { name: `QA-${runId}`.slice(0, 50), permissions: ['TASK_EDIT'] });
      expect(create.status).toBe(201);
      const roleId = idOf(create);
      expect((await PT(`/projects/${S.projectId}/roles/${roleId}`, { description: 'quality' })).status).toBe(200);
      expect((await D(`/projects/${S.projectId}/roles/${roleId}`)).status).toBe(200);
    });
    it('manages project statuses (create/reorder/update/delete)', async () => {
      if (!S.projectId) return;
      const list = await G(`/project-statuses?projectId=${S.projectId}`);
      expect(list.status).toBe(200);
      S.statusIds = (list.data.data ?? []).map((s: any) => s.id);
      const create = await P('/project-statuses', { projectId: S.projectId, name: `Backlog-${runId}`.slice(0, 40) });
      expect(create.status).toBe(201);
      const newStatusId = idOf(create);
      const reorder = await PT('/project-statuses/reorder', { items: [{ id: newStatusId, position: 9 }] });
      expect(reorder.status).toBe(200);
      expect((await PT(`/project-statuses/${newStatusId}`, { color: '#111111' })).status).toBe(200);
      expect((await D(`/project-statuses/${newStatusId}`)).status).toBe(200); // no tasks → deletable
    });
    it('manages sprints (create/start/complete/delete)', async () => {
      if (!S.projectId) return;
      expect((await G(`/sprints?projectId=${S.projectId}`)).status).toBe(200);
      const create = await P('/sprints', { projectId: S.projectId, name: `Sprint 1 ${runId}` });
      expect(create.status).toBe(201);
      const sid = idOf(create);
      expect((await G(`/sprints/${sid}`)).status).toBe(200);
      expect((await PT(`/sprints/${sid}`, { goal: 'ship it' })).status).toBe(200);
      expect((await PT(`/sprints/${sid}/start`)).status).toBe(200);
      expect((await PT(`/sprints/${sid}/complete`)).status).toBe(200);
      expect((await D(`/sprints/${sid}`)).status).toBe(200);
    });
    it('manages labels', async () => {
      if (!S.projectId) return;
      const create = await P('/labels', { name: `bug-${runId}`.slice(0, 40), projectId: S.projectId });
      expect(create.status).toBe(201);
      const id = idOf(create);
      expect((await G(`/labels?projectId=${S.projectId}`)).status).toBe(200);
      expect((await PT(`/labels/${id}`, { color: '#ff0000' })).status).toBe(200);
      expect((await D(`/labels/${id}`)).status).toBe(200);
    });
    it('creates tasks and drives task operations', async () => {
      if (!S.projectId) return;
      const create = await P('/tasks', { title: `LIFE-TASK-${runId}`, projectId: S.projectId });
      expect(create.status).toBe(201);
      S.taskId = idOf(create);
      const create2 = await P('/tasks', { title: `LIFE-TASK2-${runId}`, projectId: S.projectId });
      S.taskId2 = idOf(create2);

      for (const p of [
        '/tasks/stats',
        '/tasks/my-tasks',
        '/tasks?page=1&limit=10',
        `/tasks/kanban?projectId=${S.projectId}`,
        `/tasks/${S.taskId}`,
        `/tasks/${S.taskId}/subtasks`,
        `/tasks/${S.taskId}/dependencies`,
      ]) {
        expect((await G(p)).status).toBe(200);
      }

      expect((await PT(`/tasks/${S.taskId}`, { description: 'edited' })).status).toBe(200);
      expect((await P(`/tasks/${S.taskId}/assign`, { assigneeId: S.empId })).status).toBe(201);
      expect((await P(`/tasks/${S.taskId}/status`, { status: 'IN_PROGRESS' })).status).toBe(201);
      const statuses = await G(`/project-statuses?projectId=${S.projectId}`);
      const moveTo = statuses.data.data?.[1]?.id ?? statuses.data.data?.[0]?.id;
      if (moveTo) expect((await P(`/tasks/${S.taskId}/move-status`, { statusId: moveTo })).status).toBe(201);
      expect((await P('/tasks/bulk-assign', { taskIds: [S.taskId], assigneeId: S.empId })).status).toBe(201);

      const sub = await P(`/tasks/${S.taskId}/subtasks`, { title: `subtask-${runId}`, projectId: S.projectId });
      expect(sub.status).toBe(201);
      if (S.taskId2) {
        const dep = await P(`/tasks/${S.taskId}/dependencies`, { blockingTaskId: S.taskId2, type: 'BLOCKS' });
        expect(dep.status).toBe(201);
        expect((await D(`/tasks/dependencies/${idOf(dep)}`)).status).toBe(200);
      }
      expect((await P(`/tasks/${S.taskId}/archive`, {})).status).toBe(201);
    });
    it('adds task comments and a URL-registered attachment', async () => {
      if (!S.taskId) return;
      const c = await P('/task-comments', { taskId: S.taskId, comment: `E2E comment ${runId}` }, S.empToken);
      expect(c.status).toBe(201);
      const cid = idOf(c);
      expect((await G(`/task-comments/task/${S.taskId}`, S.empToken)).status).toBe(200);
      expect((await PT(`/task-comments/${cid}`, { comment: 'edited comment' })).status).toBe(200);

      const att = await P('/task-attachments', { taskId: S.taskId, fileName: 'note.txt', fileUrl: 'https://example.com/note.txt' });
      expect(att.status).toBe(201);
      expect((await G(`/task-attachments/task/${S.taskId}`)).status).toBe(200);
      expect((await D(`/task-attachments/${idOf(att)}`)).status).toBe(200);
      expect((await D(`/task-comments/${cid}`, S.empToken)).status).toBe(200);
    });
    it('serves the task dashboards', async () => {
      expect((await G('/task-dashboard/employee', S.empToken)).status).toBe(200);
      expect((await G('/task-dashboard/manager', S.mgrToken)).status).toBe(200);
    });
    it('logs timesheets against a task (draft → submit → approve/reject)', async () => {
      if (!S.taskId) return;
      const t1 = await P('/timesheets', { taskId: S.taskId, workDate: '2026-07-06', hoursWorked: 7.5 }, S.empToken);
      expect(t1.status).toBe(201);
      const t1id = idOf(t1);
      expect((await G('/timesheets/my', S.empToken)).status).toBe(200);
      expect((await G('/timesheets/pending', S.mgrToken)).status).toBe(200);
      expect((await G('/timesheets/summary/daily?date=2026-07-06', S.empToken)).status).toBe(200);
      expect((await G('/timesheets/summary/weekly', S.empToken)).status).toBe(200);
      expect((await G('/timesheets/summary/monthly?year=2026&month=7', S.empToken)).status).toBe(200);
      expect((await G('/timesheets?page=1&limit=10')).status).toBe(200);
      expect((await G(`/timesheets/${t1id}`, S.empToken)).status).toBe(200);
      expect((await PT(`/timesheets/${t1id}`, { hoursWorked: 8 }, S.empToken)).status).toBe(200);
      expect((await P(`/timesheets/${t1id}/submit`, {}, S.empToken)).status).toBe(201);
      expect((await P(`/timesheets/${t1id}/approve`, { comment: 'ok' })).status).toBe(201);

      const t2 = await P('/timesheets', { taskId: S.taskId, workDate: '2026-07-05', hoursWorked: 4 }, S.empToken);
      const t2id = idOf(t2);
      await P(`/timesheets/${t2id}/submit`, {}, S.empToken);
      expect((await P(`/timesheets/${t2id}/reject`, { rejectionReason: 'wrong task' })).status).toBe(201);

      const t3 = await P('/timesheets', { taskId: S.taskId, workDate: '2026-07-04', hoursWorked: 2 }, S.empToken);
      expect((await D(`/timesheets/${idOf(t3)}`, S.empToken)).status).toBe(200); // delete a draft
    });
    it('records work logs and runs the timer lifecycle', async () => {
      if (!S.taskId) return;
      const w = await P('/work-logs', { taskId: S.taskId, startTime: '2026-07-06T09:00:00.000Z', endTime: '2026-07-06T11:30:00.000Z' }, S.empToken);
      expect(w.status).toBe(201);
      const wid = idOf(w);
      expect((await G('/work-logs/my', S.empToken)).status).toBe(200);
      expect((await G('/work-logs/timer/status', S.empToken)).status).toBe(200);
      expect((await G(`/work-logs/task/${S.taskId}`, S.empToken)).status).toBe(200);
      expect((await PT(`/work-logs/${wid}`, { notes: 'refined' }, S.empToken)).status).toBe(200);
      expect((await D(`/work-logs/${wid}`, S.empToken)).status).toBe(200);

      expect((await P('/work-logs/timer/start', { taskId: S.taskId }, S.empToken)).status).toBe(201);
      expect((await P('/work-logs/timer/pause', {}, S.empToken)).status).toBe(201);
      expect((await P('/work-logs/timer/resume', {}, S.empToken)).status).toBe(201);
      expect((await P('/work-logs/timer/stop', {}, S.empToken)).status).toBe(201);
    });
    it('hard-deletes a throwaway task', async () => {
      if (!S.projectId) return;
      const create = await P('/tasks', { title: `LIFE-TASKDEL-${runId}`, projectId: S.projectId });
      expect(create.status).toBe(201);
      expect((await D(`/tasks/${idOf(create)}`)).status).toBe(200); // distinct from archive
    });
    it('updates the project, manages a member, and archives/unarchives it', async () => {
      if (!S.projectId) return;
      expect((await PT(`/projects/${S.projectId}`, { description: 'edited project' })).status).toBe(200);

      const add = await P(`/projects/${S.projectId}/members`, { employeeId: S.mgrId, role: 'MEMBER' });
      expect(add.status).toBe(201);
      const memberId = add.data.data?.[0]?.id; // addMember returns { data: ProjectMember[] }
      if (memberId) {
        expect((await PT(`/projects/${S.projectId}/members/${memberId}`, { role: 'VIEWER' })).status).toBe(200);
        expect((await D(`/projects/${S.projectId}/members/${memberId}`)).status).toBe(200);
      }

      expect((await P(`/projects/${S.projectId}/archive`, {})).status).toBe(201);
      expect((await P(`/projects/${S.projectId}/unarchive`, {})).status).toBe(201);
    });
    it('deletes the project (soft) to close the suite', async () => {
      if (!S.projectId) return;
      expect((await D(`/projects/${S.projectId}`)).status).toBe(200);
    });
  });

  // ── Payroll (the settlement + full state machine) ────────────────────────────
  describe('Payroll', () => {
    it('runs payroll for the employee via a batch, edits an item, and produces one item', async () => {
      const batch = await P('/payroll-batches', { name: `LIFE-BATCH-${runId}`, employeeIds: [S.empId] });
      expect(batch.status).toBe(201);
      S.batchId = idOf(batch);

      const run = await P('/payrolls', { month: 7, year: 2026, batchId: S.batchId });
      expect(run.status).toBe(201);
      S.payrollId = idOf(run);
      S.payrollIds.push(S.payrollId);

      const detail = await G(`/payrolls/${S.payrollId}`);
      expect(detail.status).toBe(200);
      const items = detail.data.data.items ?? [];
      expect(items.length).toBe(1);
      expect(items[0].employeeId).toBe(S.empId);
      S.payrollItemId = items[0].id;

      const edit = await PT(`/payrolls/${S.payrollId}/items/${S.payrollItemId}`, { bonus: 1000 });
      expect(edit.status).toBe(200);
    });
    it('serves payroll reads (list) and submits → approves → locks the payroll', async () => {
      expect((await G('/payrolls?year=2026')).status).toBe(200);
      expect((await P(`/payrolls/${S.payrollId}/submit`, {})).status).toBe(201);
      expect((await P(`/payrolls/${S.payrollId}/approve`, { notes: 'ok' })).status).toBe(201);
      const lock = await P(`/payrolls/${S.payrollId}/lock`, {});
      expect(lock.status).toBe(201);
      expect(lock.data.data.status).toBe('LOCKED');
      expect((await G(`/payrolls/${S.payrollId}/history`)).status).toBe(200);
    });
    it('creates a revision from the locked payroll and deletes the draft', async () => {
      const rev = await P(`/payrolls/${S.payrollId}/create-revision`, { reason: 'correction' });
      expect(rev.status).toBe(201);
      const revId = idOf(rev);
      S.payrollIds.push(revId);
      expect((await D(`/payrolls/${revId}`)).status).toBe(200); // draft is deletable
    });
    it('runs a second payroll and rejects it, then deletes it', async () => {
      const run = await P('/payrolls', { month: 8, year: 2026, batchId: S.batchId });
      if (run.status !== 201) return;
      const pid = idOf(run);
      S.payrollIds.push(pid);
      await P(`/payrolls/${pid}/submit`, {});
      expect((await P(`/payrolls/${pid}/reject`, { reason: 'redo' })).status).toBe(201);
      expect((await D(`/payrolls/${pid}`)).status).toBe(200);
    });
    it('runs a third payroll, bulk-approves and finalizes it', async () => {
      const run = await P('/payrolls', { month: 9, year: 2026, batchId: S.batchId });
      if (run.status !== 201) return;
      const pid = idOf(run);
      S.payrollIds.push(pid);
      await P(`/payrolls/${pid}/submit`, {});
      expect((await P('/payrolls/bulk-approve', { payrollIds: [pid], notes: 'batch ok' })).status).toBe(201);
      expect((await P(`/payrolls/${pid}/finalize`, {})).status).toBe(201);
    });
    it('exercises payroll-batch management (list/read/patch/members/delete)', async () => {
      const b = await P('/payroll-batches', { name: `LIFE-BATCH2-${runId}`, employeeIds: [S.empId] });
      expect(b.status).toBe(201);
      const bid = idOf(b);
      expect((await G('/payroll-batches')).status).toBe(200);
      expect((await G(`/payroll-batches/${bid}`)).status).toBe(200);
      expect((await PT(`/payroll-batches/${bid}`, { description: 'desc' })).status).toBe(200);
      expect((await P(`/payroll-batches/${bid}/members`, { employeeIds: [S.mgrId] })).status).toBe(201);
      expect((await D(`/payroll-batches/${bid}/members/${S.mgrId}`)).status).toBe(200);
      expect((await D(`/payroll-batches/${bid}`)).status).toBe(200);
    });
    it('employee pulls their payslip and self-service payroll views', async () => {
      const res = await G(`/payrolls/payslip/${S.empId}/7/2026`);
      expect(res.status).toBe(200);
      expect(res.data.data.employeeId ?? res.data.data.employee?.id).toBeTruthy();
      const list = await G('/payrolls/my-payslips/list', S.empToken);
      expect(list.status).toBe(200);
      expect((await G('/payrolls/my-ytd-summary?year=2026', S.empToken)).status).toBe(200);
      const itemId = (list.data.data ?? [])[0]?.id;
      if (itemId) expect((await G(`/payrolls/my-payslips/${itemId}`, S.empToken)).status).toBe(200);
    });
  });

  // ── Salary advance & loan (request → approval → payroll recovery) ────────────
  describe('Salary advance & loan', () => {
    // Drive a dedicated payroll (own batch + month) for the isolated AL employee,
    // read the pre-lock item, then submit → approve → lock. Returns the item so
    // callers can assert the recovered amount for that cycle.
    const runLockPayroll = async (month: number) => {
      const run = await P('/payrolls', { month, year: 2026, batchId: S.alBatchId });
      expect(run.status).toBe(201);
      const pid = idOf(run);
      S.payrollIds.push(pid);
      const detail = await G(`/payrolls/${pid}`);
      const item = (detail.data.data.items ?? []).find((i: any) => i.employeeId === S.alEmpId);
      expect((await P(`/payrolls/${pid}/submit`, {})).status).toBe(201);
      expect((await P(`/payrolls/${pid}/approve`, { notes: 'ok' })).status).toBe(201);
      expect((await P(`/payrolls/${pid}/lock`, {})).status).toBe(201);
      return item;
    };

    it('employee files an advance and a loan; admin approves the loan (per-cycle amount derived)', async () => {
      const adv = await P('/advance-loans', { type: 'ADVANCE', amount: 8000, reason: 'Medical' }, S.alEmpToken);
      expect(adv.status).toBe(201);
      expect(adv.data.status).toBe('PENDING');
      S.alAdvanceId = adv.data.id;

      const loan = await P('/advance-loans', { type: 'LOAN', amount: 10000, reason: 'Home repair', installments: 2 }, S.alEmpToken);
      expect(loan.status).toBe(201);
      S.alLoanId = loan.data.id;

      // Approve ONLY the loan now (2 installments → 5000/cycle). The advance stays
      // PENDING so the first two cycles recover the loan alone (clean assertions).
      const ap = await P(`/advance-loans/${S.alLoanId}/approve`, { installments: 2, remarks: 'ok' });
      expect(ap.status).toBe(201);
      expect(ap.data.status).toBe('APPROVED');
      expect(Number(ap.data.installments)).toBe(2);
      expect(Number(ap.data.installmentAmount)).toBe(5000);
    });

    it('blocks an over-sized advance and an over-long loan at approval', async () => {
      // proxy = base 40000, cap 100% → 40000; 999999 exceeds it → approval blocked.
      const big = await P('/advance-loans', { type: 'ADVANCE', amount: 999999, reason: 'too big' }, S.alEmpToken);
      expect(big.status).toBe(201);
      expect((await P(`/advance-loans/${big.data.id}/approve`, {})).status).toBe(400);
      expect((await D(`/advance-loans/${big.data.id}`, S.alEmpToken)).status).toBe(200);

      // Loan installments above the configured maximum (12) are rejected.
      const long = await P('/advance-loans', { type: 'LOAN', amount: 12000, installments: 3 }, S.alEmpToken);
      expect(long.status).toBe(201);
      expect((await P(`/advance-loans/${long.data.id}/approve`, { installments: 999 })).status).toBe(400);
      expect((await D(`/advance-loans/${long.data.id}`, S.alEmpToken)).status).toBe(200);
    });

    it('rejects one request and lets the employee cancel another', async () => {
      const rej = await P('/advance-loans', { type: 'ADVANCE', amount: 5000 }, S.alEmpToken);
      expect((await P(`/advance-loans/${rej.data.id}/reject`, { remarks: 'Not eligible' })).status).toBe(201);
      const can = await P('/advance-loans', { type: 'ADVANCE', amount: 4000 }, S.alEmpToken);
      if (can.status === 201) expect((await D(`/advance-loans/${can.data.id}`, S.alEmpToken)).status).toBe(200);
    });

    it('serves advance/loan reads (list/pending/my/detail/attachments)', async () => {
      expect((await G('/advance-loans')).status).toBe(200);
      expect((await G('/advance-loans/pending')).status).toBe(200);
      const my = await G('/advance-loans/my-requests', S.alEmpToken);
      expect(my.status).toBe(200);
      expect((await G(`/advance-loans/${S.alLoanId}`, S.alEmpToken)).status).toBe(200);
      expect((await G(`/advance-loans/${S.alLoanId}/attachments`, S.alEmpToken)).status).toBe(200);
    });

    it('recovers the first loan installment in the next payroll and advances the balance on lock', async () => {
      const batch = await P('/payroll-batches', { name: `LIFE-ALBATCH-${runId}`, employeeIds: [S.alEmpId] });
      expect(batch.status).toBe(201);
      S.alBatchId = idOf(batch);

      const item = await runLockPayroll(10);
      expect(item).toBeTruthy();
      expect(Number(item.advanceLoanDeduction)).toBe(5000);

      // A ledger row was written for the installment and flipped PENDING → PAID on lock.
      const ledger = await prisma.advanceLoanDeduction.findMany({ where: { requestId: S.alLoanId } });
      expect(ledger.length).toBe(1);
      expect(ledger[0].status).toBe('PAID');

      const loan = await G(`/advance-loans/${S.alLoanId}`);
      expect(Number(loan.data.amountRepaid)).toBe(5000);
      expect(Number(loan.data.outstandingBalance)).toBe(5000);
      expect(loan.data.status).toBe('APPROVED'); // still active — one installment left
    });

    it('recovers the final installment and marks the loan COMPLETED', async () => {
      const item = await runLockPayroll(11);
      expect(Number(item.advanceLoanDeduction)).toBe(5000);

      const loan = await G(`/advance-loans/${S.alLoanId}`);
      expect(Number(loan.data.amountRepaid)).toBe(10000);
      expect(Number(loan.data.outstandingBalance)).toBe(0);
      expect(loan.data.status).toBe('COMPLETED');
      expect(loan.data.completedAt).toBeTruthy();
    });

    it('recovers an approved advance in full in one cycle and completes it', async () => {
      // Loan is done; approve the advance now so this cycle recovers only the advance.
      const ap = await P(`/advance-loans/${S.alAdvanceId}/approve`, { remarks: 'ok' });
      expect(ap.status).toBe(201);
      expect(Number(ap.data.installmentAmount)).toBe(8000);

      const item = await runLockPayroll(12);
      expect(Number(item.advanceLoanDeduction)).toBe(8000);

      const adv = await G(`/advance-loans/${S.alAdvanceId}`);
      expect(Number(adv.data.amountRepaid)).toBe(8000);
      expect(Number(adv.data.outstandingBalance)).toBe(0);
      expect(adv.data.status).toBe('COMPLETED');
    });

    it('never re-charges a completed advance/loan in a later payroll (double-charge guard)', async () => {
      // Both requests are COMPLETED, so a fresh cycle recovers nothing.
      const item = await runLockPayroll(1);
      expect(Number(item.advanceLoanDeduction)).toBe(0);
    });
  });

  // ── Face recognition (read-only surface) ─────────────────────────────────────
  describe('Face recognition', () => {
    it('serves status + descriptor reads (writes need real biometrics — skipped)', async () => {
      expect((await G('/face-recognition/status', S.empToken)).status).toBe(200);
      expect((await G('/face-recognition/descriptors/me', S.empToken)).status).toBe(200);
      expect((await G(`/face-recognition/descriptors/${S.empId}`)).status).toBe(200);
    });
  });

  // ── Platform reads: dashboard / audit / settings / library / knowledge / chatbot / upload ──
  describe('Platform surface', () => {
    it('serves the full dashboard read surface', async () => {
      for (const p of [
        '/dashboard/overview',
        '/dashboard/employee-stats',
        '/dashboard/attendance-summary?month=7&year=2026',
        '/dashboard/payroll-summary?year=2026',
        '/dashboard/alerts',
        '/dashboard/activities?limit=10',
        '/dashboard/turnover-stats?months=6',
        '/dashboard/today-snapshot',
        '/dashboard/contract-alerts?days=60',
        '/dashboard/contract-alerts/expiring?days=60',
      ]) {
        expect((await G(p)).status).toBe(200);
      }
    });
    it('serves audit logs (admin) and settings (public + admin)', async () => {
      expect((await G('/audit-logs?page=1&limit=20')).status).toBe(200);
      expect((await G('/audit-logs/resources')).status).toBe(200);
      expect((await api.get('/system-settings/public')).status).toBe(200); // no auth
      expect((await G('/system-settings')).status).toBe(200);
      expect((await G('/sample-data/status')).status).toBe(200); // read-only; seed is a skipped global mutator
    });
    it('drives library-item CRUD', async () => {
      const create = await P('/library-items', { libraryType: 'POSITION', label: `LIFE-LIB-${runId}` });
      expect(create.status).toBe(201);
      const id = idOf(create);
      expect((await G('/library-items?type=POSITION')).status).toBe(200);
      expect((await G(`/library-items/${id}`)).status).toBe(200);
      expect((await PT(`/library-items/${id}`, { sortOrder: 5 })).status).toBe(200);
      expect((await D(`/library-items/${id}`)).status).toBe(200);
    });
    it('serves knowledge reads and chatbot statics', async () => {
      expect((await G('/knowledge/categories')).status).toBe(200);
      expect((await G('/knowledge')).status).toBe(200);
      expect((await G('/chatbot/suggestions', S.empToken)).status).toBe(200);
      expect((await G('/chatbot/history', S.empToken)).status).toBe(200);
    });
    it('lists an employee\'s uploaded documents', async () => {
      const res = await G(`/upload/documents/${S.empId}`);
      expect(res.status).toBe(200);
    });
  });

  // ── Export (xlsx streams — assert status, not JSON body) ──────────────────────
  describe('Export', () => {
    it('streams employee / attendance / payroll / leave workbooks', async () => {
      const cfg = { headers: H(S.adminToken).headers, responseType: 'arraybuffer' as const };
      expect((await api.get('/export/employees', cfg)).status).toBe(200);
      expect((await api.get('/export/attendance/7/2026', cfg)).status).toBe(200);
      expect((await api.get(`/export/payroll/${S.payrollId}`, cfg)).status).toBe(200);
      expect((await api.get('/export/leave-requests', cfg)).status).toBe(200);
    });
  });
});
