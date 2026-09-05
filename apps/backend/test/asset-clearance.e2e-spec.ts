import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';

/**
 * Offboarding asset clearance, end to end against the real DB.
 *
 * The point of the asset register is that a leaver cannot be completed while
 * they still hold company property. There are THREE paths that end an
 * employment, and a control guarding two of three is not a control:
 *   1. TerminationRequestService.approveTermination  (approval workflow)
 *   2. ContractsService.terminate                    (direct, no workflow)
 *   3. EmployeesService.delete                       (soft delete)
 *
 * Also proves: the DB-level one-open-holder guarantee, the audited HR override,
 * and that returning the asset unblocks the exit.
 */
describe('Asset clearance & offboarding (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `asset${Date.now()}`;

  const emails = {
    admin: `admin-${runId}@test.local`,
    holderA: `holdera-${runId}@test.local`,
    holderB: `holderb-${runId}@test.local`,
    holderC: `holderc-${runId}@test.local`,
    clean: `clean-${runId}@test.local`,
  };

  let branchId: string;
  let deptId: string;
  let adminToken: string;
  let adminUserId: string;

  // One employee per offboarding path, so each test gets a fresh leaver.
  let empA: string;
  let empB: string;
  let empC: string;
  let empClean: string;
  let contractA: string;
  let contractB: string;

  let laptopId: string;
  let phoneId: string;
  let simId: string;

  async function makeEmployee(email: string, code: string) {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const employee = await ctx.prisma.employee.create({
      data: {
        employeeCode: code,
        fullName: `Holder ${code}`,
        email,
        idCard: `ID-${code}`,
        dateOfBirth: new Date('1990-01-01'),
        startDate: new Date('2020-01-01'),
        departmentId: deptId,
        position: 'Engineer',
        branchId,
        baseSalary: 1000,
        status: 'ACTIVE',
      },
    });
    await ctx.prisma.user.create({
      data: {
        email,
        passwordHash: hash,
        role: 'EMPLOYEE',
        employeeId: employee.id,
        isActive: true,
        isGlobalBranchAccess: false,
        branchAccess: { create: [{ branchId }] },
      },
    });
    return employee.id;
  }

  async function makeAsset(tag: string, name: string) {
    const asset = await ctx.prisma.assetItem.create({
      data: { assetTag: tag, category: 'Laptop', name, branchId, status: 'AVAILABLE' },
    });
    return asset.id;
  }

  async function makeContract(employeeId: string, number: string) {
    const c = await ctx.prisma.contract.create({
      data: {
        employeeId,
        contractType: 'INDEFINITE',
        contractNumber: number,
        startDate: new Date('2020-01-01'),
        salary: 1000,
        workType: 'FULL_TIME',
        workHoursPerWeek: 40,
        status: 'ACTIVE',
      },
    });
    return c.id;
  }

  beforeAll(async () => {
    ctx = await bootE2EApp();
    const { prisma } = ctx;
    const hash = await bcrypt.hash(PASSWORD, 10);

    const branch = await prisma.branch.create({
      data: { code: `AST-BR-${runId}`, name: 'Asset E2E Branch', isActive: true },
    });
    branchId = branch.id;

    const dept = await prisma.department.create({
      data: { code: `AST-DEP-${runId}`, name: `Asset Dept ${runId}`, isActive: true },
    });
    deptId = dept.id;

    const adminUser = await prisma.user.create({
      data: {
        email: emails.admin,
        passwordHash: hash,
        role: 'ADMIN',
        isActive: true,
        // Without this, every findUnique-backed read fails the fail-closed
        // branch guard with a 404 rather than a 403 (no existence leak).
        isGlobalBranchAccess: true,
      },
    });
    adminUserId = adminUser.id;

    empA = await makeEmployee(emails.holderA, `AST-A-${runId}`);
    empB = await makeEmployee(emails.holderB, `AST-B-${runId}`);
    empC = await makeEmployee(emails.holderC, `AST-C-${runId}`);
    empClean = await makeEmployee(emails.clean, `AST-D-${runId}`);

    contractA = await makeContract(empA, `AST-CT-A-${runId}`);
    contractB = await makeContract(empB, `AST-CT-B-${runId}`);

    laptopId = await makeAsset(`AST-LT-${runId}`, 'Dell Latitude');
    phoneId = await makeAsset(`AST-PH-${runId}`, 'iPhone 15');
    simId = await makeAsset(`AST-SM-${runId}`, 'Company SIM');

    const login = await ctx
      .http()
      .post('/auth/login')
      .send({ email: emails.admin, password: PASSWORD });
    adminToken = login.body.data.accessToken;
    expect(adminToken).toBeTruthy();
  });

  afterAll(async () => {
    const { prisma } = ctx;
    // FK-safe order.
    await prisma.assetAssignment.deleteMany({
      where: { asset: { branchId } },
    });
    await prisma.assetItem.deleteMany({ where: { branchId } });
    await prisma.terminationRequest.deleteMany({
      where: { contract: { employee: { branchId } } },
    });
    await prisma.contract.deleteMany({ where: { employee: { branchId } } });
    await prisma.auditLog.deleteMany({
      where: { resourceId: { in: [empA, empB, empC, empClean] } },
    });
    await prisma.user.deleteMany({ where: { email: { endsWith: `${runId}@test.local` } } });
    await prisma.employee.deleteMany({ where: { branchId } });
    await prisma.department.deleteMany({ where: { id: deptId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await ctx.app.close();
  });

  // ── Assignment lifecycle ───────────────────────────────────────────────────

  describe('assignment', () => {
    it('assigns an asset and flips it to ASSIGNED', async () => {
      const res = await ctx
        .http()
        .post('/assets/assignments')
        .set(bearer(adminToken))
        .send({ assetId: laptopId, employeeId: empA, conditionOut: 'New' })
        .expect(201);

      expect(res.body.success).toBe(true);
      const asset = await ctx.prisma.assetItem.findUnique({ where: { id: laptopId } });
      expect(asset?.status).toBe('ASSIGNED');
    });

    it('refuses to hand the same asset to a second employee', async () => {
      const res = await ctx
        .http()
        .post('/assets/assignments')
        .set(bearer(adminToken))
        .send({ assetId: laptopId, employeeId: empB });

      // Guarded by the partial unique index on (asset_id) WHERE returned_at IS NULL,
      // so a lost race cannot produce two people owing the same item.
      expect([409, 400]).toContain(res.status);
    });

    it('refuses to assign to a non-ACTIVE employee', async () => {
      await ctx.prisma.employee.update({
        where: { id: empClean },
        data: { status: 'INACTIVE' },
      });
      const res = await ctx
        .http()
        .post('/assets/assignments')
        .set(bearer(adminToken))
        .send({ assetId: phoneId, employeeId: empClean })
        .expect(400);
      expect(res.body.message).toMatch(/INACTIVE/);

      await ctx.prisma.employee.update({
        where: { id: empClean },
        data: { status: 'ACTIVE' },
      });
    });
  });

  // ── The clearance gate on all three offboarding paths ──────────────────────

  describe('clearance gate', () => {
    it('reports what an employee still holds', async () => {
      const res = await ctx
        .http()
        .get(`/assets/clearance/${empA}`)
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.data.cleared).toBe(false);
      expect(res.body.data.openAssets).toHaveLength(1);
      expect(res.body.data.openAssets[0].assetTag).toBe(`AST-LT-${runId}`);
    });

    it('reports a clean employee as cleared', async () => {
      const res = await ctx
        .http()
        .get(`/assets/clearance/${empClean}`)
        .set(bearer(adminToken))
        .expect(200);
      expect(res.body.data.cleared).toBe(true);
    });

    it('PATH 1: blocks approveTermination while an asset is held', async () => {
      const request = await ctx.prisma.terminationRequest.create({
        data: {
          contractId: contractA,
          requestedBy: adminUserId,
          terminationCategory: 'RESIGNATION',
          noticeDate: new Date(),
          terminationDate: new Date(),
          reason: 'Resigned',
          status: 'PENDING_APPROVAL',
        },
      });

      const res = await ctx
        .http()
        .post(`/contracts/termination-requests/${request.id}/approve`)
        .set(bearer(adminToken))
        .send({ approverId: adminUserId, comments: 'ok' })
        .expect(400);

      expect(res.body.message).toMatch(/still has/i);
      expect(res.body.message).toContain(`AST-LT-${runId}`);

      // Nothing was mutated — the gate runs before the transaction.
      const employee = await ctx.prisma.employee.findUnique({ where: { id: empA } });
      const contract = await ctx.prisma.contract.findUnique({ where: { id: contractA } });
      const req = await ctx.prisma.terminationRequest.findUnique({
        where: { id: request.id },
      });
      expect(employee?.status).toBe('ACTIVE');
      expect(contract?.status).toBe('ACTIVE');
      expect(req?.status).toBe('PENDING_APPROVAL');
    });

    it('PATH 2: blocks the direct contract terminate endpoint', async () => {
      await ctx
        .http()
        .post('/assets/assignments')
        .set(bearer(adminToken))
        .send({ assetId: phoneId, employeeId: empB })
        .expect(201);

      const res = await ctx
        .http()
        .post(`/contracts/${contractB}/terminate`)
        .set(bearer(adminToken))
        .send({ reason: 'Performance' })
        .expect(400);

      expect(res.body.message).toMatch(/still has/i);

      const employee = await ctx.prisma.employee.findUnique({ where: { id: empB } });
      expect(employee?.status).toBe('ACTIVE');
    });

    it('PATH 3: blocks the employee soft-delete endpoint', async () => {
      await ctx
        .http()
        .post('/assets/assignments')
        .set(bearer(adminToken))
        .send({ assetId: simId, employeeId: empC })
        .expect(201);

      const res = await ctx
        .http()
        .delete(`/employees/${empC}`)
        .set(bearer(adminToken))
        .expect(400);

      expect(res.body.message).toMatch(/still has/i);

      const employee = await ctx.prisma.employee.findUnique({ where: { id: empC } });
      expect(employee?.status).toBe('ACTIVE');
    });

    it('lets the exit through once the asset is returned', async () => {
      const open = await ctx.prisma.assetAssignment.findFirst({
        where: { employeeId: empB, returnedAt: null },
      });
      expect(open).toBeTruthy();

      await ctx
        .http()
        .post(`/assets/assignments/${open!.id}/return`)
        .set(bearer(adminToken))
        .send({ conditionIn: 'Good' })
        .expect(201);

      const asset = await ctx.prisma.assetItem.findUnique({ where: { id: phoneId } });
      expect(asset?.status).toBe('AVAILABLE');

      await ctx
        .http()
        .post(`/contracts/${contractB}/terminate`)
        .set(bearer(adminToken))
        .send({ reason: 'Performance' })
        .expect(201);

      const employee = await ctx.prisma.employee.findUnique({ where: { id: empB } });
      const contract = await ctx.prisma.contract.findUnique({ where: { id: contractB } });
      expect(employee?.status).toBe('INACTIVE');
      expect(contract?.status).toBe('TERMINATED');
    });

    it('an ADMIN override proceeds and is audited', async () => {
      const res = await ctx
        .http()
        .delete(`/employees/${empC}?clearanceOverrideReason=SIM+written+off`)
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.success).toBe(true);

      const employee = await ctx.prisma.employee.findUnique({ where: { id: empC } });
      // R72 (fixed): the soft-delete exit records `INACTIVE`, the same value the
      // two contract-side offboarding paths write. It used to write
      // `TERMINATED`, splitting the leaver population across two statuses.
      expect(employee?.status).toBe('INACTIVE');

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'CLEARANCE_OVERRIDDEN', resourceId: empC },
      });
      expect(audit).toBeTruthy();
    });

    it('surfaces assets still held by inactive leavers', async () => {
      const res = await ctx
        .http()
        .get('/assets/clearance/reports/outstanding')
        .set(bearer(adminToken))
        .expect(200);

      // empC left via override while still holding the SIM.
      const rows = res.body.data.filter((r: any) => r.employee.id === empC);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  // ── ESS ────────────────────────────────────────────────────────────────────

  describe('employee self-service', () => {
    it('lets the holder acknowledge receipt, once', async () => {
      const login = await ctx
        .http()
        .post('/auth/login')
        .send({ email: emails.holderA, password: PASSWORD });
      const token = login.body.data.accessToken;

      const mine = await ctx
        .http()
        .get('/assets/my?openOnly=true')
        .set(bearer(token))
        .expect(200);
      expect(mine.body.data).toHaveLength(1);
      const assignmentId = mine.body.data[0].id;
      expect(mine.body.data[0].acknowledgedAt).toBeNull();

      await ctx
        .http()
        .post(`/assets/assignments/${assignmentId}/acknowledge`)
        .set(bearer(token))
        .send({ note: 'Received in good condition' })
        .expect(201);

      const row = await ctx.prisma.assetAssignment.findUnique({
        where: { id: assignmentId },
      });
      expect(row?.acknowledgedAt).toBeTruthy();

      // Second acknowledgement is rejected — the receipt is a one-time act.
      await ctx
        .http()
        .post(`/assets/assignments/${assignmentId}/acknowledge`)
        .set(bearer(token))
        .send({})
        .expect(400);
    });

    it('refuses to let one employee acknowledge another employee\'s asset', async () => {
      const login = await ctx
        .http()
        .post('/auth/login')
        .send({ email: emails.clean, password: PASSWORD });
      const token = login.body.data.accessToken;

      const open = await ctx.prisma.assetAssignment.findFirst({
        where: { employeeId: empA, returnedAt: null },
      });

      await ctx
        .http()
        .post(`/assets/assignments/${open!.id}/acknowledge`)
        .set(bearer(token))
        .send({})
        .expect(403);
    });
  });
});
