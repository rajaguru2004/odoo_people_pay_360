import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupFixtures, Fixtures, bearer } from './utils/fixtures';
import { SystemSettingsService } from '../src/system-settings/system-settings.service';

/**
 * End-to-end verification of the multi-branch engine against the real dev DB.
 * Proves: auth envelope, branch CRUD + RBAC, whole-system data scoping,
 * cross-branch 403 (selector cannot widen), object-level IDOR 404, onboarding
 * into a branch, attendance scoping, per-branch geofence config, audit trail,
 * and enforcement-mode toggling.
 */
describe('Multi-branch (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.data)) return d.data;
    if (Array.isArray(d?.records)) return d.records;
    if (Array.isArray(d?.items)) return d.items;
    return [];
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Auth envelope', () => {
    it('global admin login exposes isGlobalBranchAccess', async () => {
      const res = await ctx.http().post('/auth/login').send({ email: fx.globalAdmin.email, password: fx.password });
      expect(res.status).toBe(201);
      expect(res.body.data.user.isGlobalBranchAccess).toBe(true);
    });

    it('scoped HR login exposes envelope (home branch + grants), not global', async () => {
      const res = await ctx.http().post('/auth/login').send({ email: fx.scopedHr.email, password: fx.password });
      expect(res.status).toBe(201);
      expect(res.body.data.user.isGlobalBranchAccess).toBe(false);
      expect(res.body.data.user.homeBranchId).toBe(fx.branchA);
      const ids = (res.body.data.user.accessibleBranches ?? []).map((b: any) => b.id);
      expect(ids).toContain(fx.branchA);
      expect(ids).not.toContain(fx.branchB);
    });

    it('rejects unauthenticated access to a protected route', async () => {
      const res = await ctx.http().get('/branches');
      expect(res.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Branch CRUD + RBAC', () => {
    let createdBranchId: string;

    it('global admin lists branches (incl. fixtures)', async () => {
      const res = await ctx.http().get('/branches').set(bearer(fx.globalAdmin.token));
      expect(res.status).toBe(200);
      expect(body(res)).toContain(fx.branchAcode);
      expect(body(res)).toContain(fx.branchBcode);
    });

    it('creates a branch, rejects duplicate code (409)', async () => {
      const code = `E2E-C-${fx.runId}`;
      const create = await ctx.http().post('/branches').set(bearer(fx.globalAdmin.token))
        .send({ code, name: 'E2E Branch C' });
      expect(create.status).toBe(201);
      createdBranchId = create.body.data.id;

      const dup = await ctx.http().post('/branches').set(bearer(fx.globalAdmin.token))
        .send({ code, name: 'dup' });
      expect(dup.status).toBe(409);
    });

    it('updates and soft-deletes a branch', async () => {
      const upd = await ctx.http().patch(`/branches/${createdBranchId}`).set(bearer(fx.globalAdmin.token))
        .send({ name: 'E2E Branch C (renamed)', geofenceRadiusM: 250 });
      expect(upd.status).toBe(200);

      const del = await ctx.http().delete(`/branches/${createdBranchId}`).set(bearer(fx.globalAdmin.token));
      expect(del.status).toBe(200);

      const list = await ctx.http().get('/branches').set(bearer(fx.globalAdmin.token));
      expect(body(list)).not.toContain('E2E Branch C (renamed)'); // inactive filtered out
    });

    it('refuses to delete a branch that still has employees (400)', async () => {
      const del = await ctx.http().delete(`/branches/${fx.branchA}`).set(bearer(fx.globalAdmin.token));
      expect(del.status).toBe(400);
    });

    it('enforces RBAC: EMPLOYEE cannot create a branch (403)', async () => {
      const res = await ctx.http().post('/branches').set(bearer(fx.plainEmployee.token))
        .send({ code: `E2E-X-${fx.runId}`, name: 'nope' });
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Employee list scoping', () => {
    const q = () => `/employees?search=EMP-${fx.runId}&limit=50`;

    it('global admin + X-Branch-Id=A sees only branch-A employees', async () => {
      const res = await ctx.http().get(q()).set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA);
      expect(res.status).toBe(200);
      expect(body(res)).toContain(`EMP-${fx.runId}-A`);
      expect(body(res)).not.toContain(`EMP-${fx.runId}-B`);
    });

    it('global admin + X-Branch-Id=B sees only branch-B employees', async () => {
      const res = await ctx.http().get(q()).set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchB);
      expect(body(res)).toContain(`EMP-${fx.runId}-B`);
      expect(body(res)).not.toContain(`EMP-${fx.runId}-A`);
    });

    it('global admin without header (All Branches) sees both', async () => {
      const res = await ctx.http().get(q()).set(bearer(fx.globalAdmin.token));
      expect(body(res)).toContain(`EMP-${fx.runId}-A`);
      expect(body(res)).toContain(`EMP-${fx.runId}-B`);
    });

    it('scoped HR sees only its own branch (A), never B', async () => {
      const res = await ctx.http().get(q()).set(bearer(fx.scopedHr.token));
      expect(res.status).toBe(200);
      expect(body(res)).toContain(`EMP-${fx.runId}-A`);
      expect(body(res)).not.toContain(`EMP-${fx.runId}-B`);
    });

    it('scoped HR requesting a foreign branch is rejected (403)', async () => {
      const res = await ctx.http().get(q()).set(bearer(fx.scopedHr.token)).set('X-Branch-Id', fx.branchB);
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Object-level IDOR', () => {
    it('cross-branch findOne returns 404 (no existence leak) for global admin scoped to A', async () => {
      const res = await ctx.http().get(`/employees/${fx.empBId}`)
        .set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA);
      expect(res.status).toBe(404);
    });

    it('same record is visible when scoped to its branch (B)', async () => {
      const res = await ctx.http().get(`/employees/${fx.empBId}`)
        .set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchB);
      expect(res.status).toBe(200);
    });

    it('scoped HR cannot read a branch-B employee by id (404)', async () => {
      const res = await ctx.http().get(`/employees/${fx.empBId}`).set(bearer(fx.scopedHr.token));
      expect(res.status).toBe(404);
    });

    it('scoped HR can read a branch-A employee by id (200)', async () => {
      const res = await ctx.http().get(`/employees/${fx.empAId}`).set(bearer(fx.scopedHr.token));
      expect(res.status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Onboarding into a branch', () => {
    const mkPayload = (suffix: string, branchId?: string) => ({
      fullName: `Onboarded ${suffix}`,
      email: `onboard-${suffix}-${fx.runId}@test.local`,
      dateOfBirth: '1996-05-05',
      idCard: `ID-${fx.runId}-ON${suffix}`,
      departmentId: fx.deptId,
      ...(branchId ? { branchId } : {}),
      position: 'Analyst',
      startDate: '2026-06-01',
      baseSalary: 40000,
    });

    it('stamps the active branch when no branchId is supplied', async () => {
      const create = await ctx.http().post('/employees')
        .set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA)
        .send(mkPayload('NOBR'));
      expect(create.status).toBe(201);
      const id = create.body.data.id;
      // Visible under A, hidden under B.
      const underA = await ctx.http().get(`/employees/${id}`).set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA);
      const underB = await ctx.http().get(`/employees/${id}`).set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchB);
      expect(underA.status).toBe(200);
      expect(underB.status).toBe(404);
    });

    it('honours an explicit in-scope branchId', async () => {
      const create = await ctx.http().post('/employees')
        .set(bearer(fx.globalAdmin.token)).send(mkPayload('EXPB', fx.branchB));
      expect(create.status).toBe(201);
      const id = create.body.data.id;
      const underB = await ctx.http().get(`/employees/${id}`).set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchB);
      expect(underB.status).toBe(200);
    });

    it('scoped HR cannot onboard into a foreign branch (403)', async () => {
      // Assigning into a branch is a write the caller explicitly targets, so the
      // guard returns 403 (assertBranchAssignable) rather than the read-path 404
      // used to hide existence — see branch-scope.util.ts.
      const res = await ctx.http().post('/employees')
        .set(bearer(fx.scopedHr.token)).send(mkPayload('FOR', fx.branchB));
      expect(res.status).toBe(403);
    });

    it('scoped HR can onboard into its own branch (201)', async () => {
      const res = await ctx.http().post('/employees')
        .set(bearer(fx.scopedHr.token)).send(mkPayload('OWN', fx.branchA));
      expect(res.status).toBe(201);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Attendance scoping (relation via employee.branchId denormalized)', () => {
    const q = () => `/attendances/list?period=custom&startDate=2026-07-06&endDate=2026-07-06&search=EMP-${fx.runId}&limit=100`;

    it('global admin scoped to A sees A attendance, not B', async () => {
      const res = await ctx.http().get(q()).set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA);
      expect(res.status).toBe(200);
      expect(body(res)).toContain(`EMP-${fx.runId}-A`);
      expect(body(res)).not.toContain(`EMP-${fx.runId}-B`);
    });

    it('scoped HR sees only branch-A attendance', async () => {
      const res = await ctx.http().get(q()).set(bearer(fx.scopedHr.token));
      expect(res.status).toBe(200);
      expect(body(res)).not.toContain(`EMP-${fx.runId}-B`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Per-branch config de-globalization', () => {
    it('resolves geofence policy per branch with global fallback', async () => {
      const settings = ctx.app.get(SystemSettingsService);
      const polA = await settings.getGeofencingPolicy(fx.branchA);
      expect(polA.enabled).toBe(true);
      expect(polA.radiusMeters).toBe(150);
      expect(Math.round((polA.officeLat ?? 0) as number)).toBe(13);

      const polB = await settings.getGeofencingPolicy(fx.branchB);
      expect(polB.enabled).toBe(false);

      // No branch => global policy resolves without throwing.
      const polGlobal = await settings.getGeofencingPolicy(undefined);
      expect(polGlobal).toHaveProperty('radiusMeters');
    });

    it('resolves office hours per branch', async () => {
      const settings = ctx.app.get(SystemSettingsService);
      const hoursA = await settings.getOfficeHours(fx.branchA);
      expect(hoursA).toEqual({ start: '09:00', end: '18:00' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Audit trail', () => {
    it('records ACCESS_DENIED rows for cross-branch attempts', async () => {
      // Trigger a fresh denial.
      await ctx.http().get(`/employees?search=EMP-${fx.runId}`).set(bearer(fx.scopedHr.token)).set('X-Branch-Id', fx.branchB);
      // Denials are written best-effort/async; poll briefly.
      let count = 0;
      for (let i = 0; i < 10; i++) {
        count = await ctx.prisma.auditLog.count({
          where: { userId: fx.scopedHr.userId, action: 'ACCESS_DENIED' },
        });
        if (count > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(count).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Advance & Loans scoping (relation rule)', () => {
    let loanAId: string;
    let loanBId: string;

    beforeAll(async () => {
      const la = await ctx.prisma.advanceLoanRequest.create({
        data: { employeeId: fx.empAId, type: 'ADVANCE', amount: 1000, reason: `LOAN-${fx.runId}-A` },
      });
      const lb = await ctx.prisma.advanceLoanRequest.create({
        data: { employeeId: fx.empBId, type: 'ADVANCE', amount: 2000, reason: `LOAN-${fx.runId}-B` },
      });
      loanAId = la.id;
      loanBId = lb.id;
    });

    // The advance-loans list returns a raw array (no response envelope).
    const loanIds = (res: any): string[] =>
      (Array.isArray(res.body) ? res.body : rowsOf(res)).map((r: any) => r.id);

    it('global admin scoped to A lists only branch-A loans', async () => {
      const res = await ctx.http().get('/advance-loans').set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA);
      expect(res.status).toBe(200);
      const ids = loanIds(res);
      expect(ids).toContain(loanAId);
      expect(ids).not.toContain(loanBId);
    });

    it('scoped to B lists only branch-B loans', async () => {
      const res = await ctx.http().get('/advance-loans').set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchB);
      const ids = loanIds(res);
      expect(ids).toContain(loanBId);
      expect(ids).not.toContain(loanAId);
    });

    it('cross-branch findOne returns 404 (IDOR guard)', async () => {
      const res = await ctx.http().get(`/advance-loans/${loanBId}`).set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA);
      expect(res.status).toBe(404);
    });

    it('scoped HR (A) cannot read a branch-B loan by id (404)', async () => {
      const res = await ctx.http().get(`/advance-loans/${loanBId}`).set(bearer(fx.scopedHr.token));
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Contract Terminations scoping (contract→employee path rule)', () => {
    let termBId: string;
    let contractBId: string;

    beforeAll(async () => {
      const contractB = await ctx.prisma.contract.create({
        data: {
          employeeId: fx.empBId,
          contractType: 'PERMANENT',
          contractNumber: `E2E-CT-${fx.runId}-B`,
          startDate: new Date('2026-01-01'),
          salary: 60000,
          status: 'ACTIVE',
        },
      });
      contractBId = contractB.id;
      const termB = await ctx.prisma.terminationRequest.create({
        data: {
          contractId: contractB.id,
          requestedBy: fx.globalAdmin.userId,
          terminationCategory: 'RESIGNATION',
          noticeDate: new Date('2026-07-01'),
          terminationDate: new Date('2026-07-31'),
          reason: `TERM-${fx.runId}-B`,
          status: 'PENDING_APPROVAL',
        },
      });
      termBId = termB.id;
    });

    // termination_requests.requested_by → User is onDelete: Restrict, so remove
    // this row before the fixture teardown deletes the requesting user.
    afterAll(async () => {
      await ctx.prisma.terminationRequest.deleteMany({ where: { id: termBId } });
      await ctx.prisma.contract.deleteMany({ where: { id: contractBId } });
    });

    it('pending list scoped to A excludes the branch-B termination', async () => {
      const res = await ctx.http().get('/contracts/termination-requests/pending').set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA);
      expect(res.status).toBe(200);
      expect(body(res)).not.toContain(`TERM-${fx.runId}-B`);
    });

    it('pending list scoped to B includes it', async () => {
      const res = await ctx.http().get('/contracts/termination-requests/pending').set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchB);
      expect(body(res)).toContain(`TERM-${fx.runId}-B`);
    });

    it('cross-branch termination detail returns 404 (IDOR guard)', async () => {
      const res = await ctx.http().get(`/contracts/termination-requests/${termBId}`).set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA);
      expect(res.status).toBe(404);
    });

    it('history list scoped to A excludes a branch-B resolved termination', async () => {
      await ctx.prisma.terminationRequest.update({
        where: { id: termBId },
        data: { status: 'REJECTED', approverId: fx.globalAdmin.userId, approvedAt: new Date(), rejectionReason: 'e2e' },
      });
      const res = await ctx.http().get('/contracts/termination-requests/history').set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA);
      expect(res.status).toBe(200);
      expect(body(res)).not.toContain(`TERM-${fx.runId}-B`);
    });

    it('history list scoped to B includes it', async () => {
      const res = await ctx.http().get('/contracts/termination-requests/history').set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchB);
      expect(body(res)).toContain(`TERM-${fx.runId}-B`);
    });

    it('real approve endpoint: approved-this-month reflects it via the history list', async () => {
      // Exercise the actual controller/service path (not a direct Prisma write) —
      // creates a fresh pending request, approves it via HTTP, then confirms the
      // history endpoint (which the "Approved This Month" stat is computed from)
      // reflects it as APPROVED with an approvedAt in the current month.
      const contractA = await ctx.prisma.contract.create({
        data: {
          employeeId: fx.empAId,
          contractType: 'PERMANENT',
          contractNumber: `E2E-CT-${fx.runId}-A2`,
          startDate: new Date('2026-01-01'),
          salary: 55000,
          status: 'ACTIVE',
        },
      });
      const termA = await ctx.prisma.terminationRequest.create({
        data: {
          contractId: contractA.id,
          requestedBy: fx.globalAdmin.userId,
          terminationCategory: 'RESIGNATION',
          noticeDate: new Date('2026-07-01'),
          terminationDate: new Date('2026-07-31'),
          reason: `TERM-${fx.runId}-A2`,
          status: 'PENDING_APPROVAL',
        },
      });

      try {
        const approveRes = await ctx
          .http()
          .post(`/contracts/termination-requests/${termA.id}/approve`)
          .set(bearer(fx.globalAdmin.token))
          .set('X-Branch-Id', fx.branchA)
          .send({ approverId: fx.globalAdmin.userId, comments: 'e2e approve' });
        expect(approveRes.status).toBe(201);

        const historyRes = await ctx
          .http()
          .get('/contracts/termination-requests/history')
          .set(bearer(fx.globalAdmin.token))
          .set('X-Branch-Id', fx.branchA);
        expect(historyRes.status).toBe(200);
        const rows = rowsOf(historyRes);
        const row = rows.find((r: any) => r.reason === `TERM-${fx.runId}-A2`);
        expect(row).toBeDefined();
        expect(row.status).toBe('APPROVED');
        expect(row.approvedAt).toBeTruthy();
        const approvedAt = new Date(row.approvedAt);
        const now = new Date();
        expect(approvedAt.getUTCMonth()).toBe(now.getUTCMonth());
        expect(approvedAt.getUTCFullYear()).toBe(now.getUTCFullYear());
      } finally {
        await ctx.prisma.terminationRequest.deleteMany({ where: { id: termA.id } });
        await ctx.prisma.contract.deleteMany({ where: { id: contractA.id } });
        // approveTermination side-effects flip the employee to INACTIVE — restore
        // it since fx.empAId is a shared fixture used by later tests in this file.
        await ctx.prisma.employee.update({
          where: { id: fx.empAId },
          data: { status: 'ACTIVE', endDate: null },
        });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Departments filter-to-branch', () => {
    // The fixture department has employees in BOTH branches (empA + empB), so a
    // branch-scoped employee count must be strictly smaller than the all-branches
    // count, and never larger.
    const deptOf = (res: any) => rowsOf(res).find((d) => d.id === fx.deptId);

    it('scopes per-department employee counts to the selected branch', async () => {
      const all = await ctx.http().get('/departments').set(bearer(fx.globalAdmin.token));
      const a = await ctx.http().get('/departments').set(bearer(fx.globalAdmin.token)).set('X-Branch-Id', fx.branchA);
      expect(all.status).toBe(200);
      const allCount = deptOf(all)?._count?.employees;
      const aCount = deptOf(a)?._count?.employees;
      expect(typeof allCount).toBe('number');
      expect(typeof aCount).toBe('number');
      expect(aCount).toBeGreaterThanOrEqual(1); // empA is in branch A
      expect(aCount).toBeLessThan(allCount); // empB (branch B) is excluded
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Enforcement mode toggle', () => {
    it('BRANCH_ENFORCEMENT=off disables scoping and denials', async () => {
      const prev = process.env.BRANCH_ENFORCEMENT;
      process.env.BRANCH_ENFORCEMENT = 'off';
      try {
        // Foreign header no longer 403s...
        const res = await ctx.http().get(`/employees?search=EMP-${fx.runId}&limit=50`)
          .set(bearer(fx.scopedHr.token)).set('X-Branch-Id', fx.branchB);
        expect(res.status).toBe(200);
        // ...and scoping is off, so a scoped HR now sees branch-B data too.
        expect(body(res)).toContain(`EMP-${fx.runId}-B`);
      } finally {
        process.env.BRANCH_ENFORCEMENT = prev;
      }
    });
  });
});
