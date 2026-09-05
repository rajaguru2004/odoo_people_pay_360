import * as bcrypt from 'bcrypt';
import { LibraryType } from '@prisma/client';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import {
  readApprovalSwitch,
  restoreApprovalSwitch,
} from './utils/approval-switch';

/**
 * Cross-cutting edge cases for the HR suite, over and above the per-feature
 * suites.
 *
 * Two classes of thing live here:
 *
 *  1. **Master data actually reaches the dropdown.** Every `LibraryType` backs a
 *     select somewhere. An unseeded master, or one the fetch signature cannot
 *     ask for, renders as a bare placeholder — the form looks broken with no
 *     hint that the fix is in Settings ▸ Library. That shipped once; this makes
 *     it a test failure instead.
 *
 *  2. **Boundaries the happy path never touches** — cross-branch, cross-tenant,
 *     hostile input, and states a careless refactor would quietly allow.
 */
describe('HR suite edge cases (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `edge${Date.now()}`;

  /**
   * Both suites drive travel through the LEGACY auto-approve path, which only
   * runs when no configured chain governs TRAVEL. An admin can turn chains on
   * from Settings, so pin the switch rather than inheriting the environment's.
   */
  let originalSwitch: string | null = null;

  let branchA: string;
  let branchB: string;
  let deptId: string;
  let adminToken: string;
  let scopedHrToken: string;
  let empToken: string;
  let empAId: string;
  let empBId: string;
  let adminUserId: string;

  const day = (n: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d;
  };
  const iso = (n: number) => day(n).toISOString().slice(0, 10);

  async function makeEmployee(branchId: string, code: string, role = 'EMPLOYEE') {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const email = `${code.toLowerCase()}-${runId}@test.local`;
    const employee = await ctx.prisma.employee.create({
      data: {
        employeeCode: `${code}-${runId}`,
        fullName: `Edge ${code}`,
        email,
        idCard: `ID-${code}-${runId}`,
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
        role,
        employeeId: employee.id,
        isActive: true,
        branchAccess: { create: [{ branchId }] },
      },
    });
    return { id: employee.id, email };
  }

  async function login(email: string) {
    const res = await ctx.http().post('/auth/login').send({ email, password: PASSWORD });
    return res.body.data.accessToken;
  }

  beforeAll(async () => {
    ctx = await bootE2EApp();
    const { prisma } = ctx;
    originalSwitch = await readApprovalSwitch(prisma);
    await prisma.systemSetting.upsert({
      where: { key: 'supervisor_approval_enabled' },
      update: { value: 'false' },
      create: { key: 'supervisor_approval_enabled', value: 'false' },
    });
    const hash = await bcrypt.hash(PASSWORD, 10);

    branchA = (
      await prisma.branch.create({
        data: { code: `EDG-A-${runId}`, name: 'Edge A', isActive: true },
      })
    ).id;
    branchB = (
      await prisma.branch.create({
        data: { code: `EDG-B-${runId}`, name: 'Edge B', isActive: true },
      })
    ).id;
    deptId = (
      await prisma.department.create({
        data: { code: `EDG-D-${runId}`, name: `Edge Dept ${runId}`, isActive: true },
      })
    ).id;

    adminUserId = (
      await prisma.user.create({
        data: {
          email: `admin-${runId}@test.local`,
          passwordHash: hash,
          role: 'ADMIN',
          isActive: true,
          isGlobalBranchAccess: true,
        },
      })
    ).id;
    // HR scoped to branch A only — the caller that must never see branch B.
    await prisma.user.create({
      data: {
        email: `hr-${runId}@test.local`,
        passwordHash: hash,
        role: 'HR_MANAGER',
        isActive: true,
        isGlobalBranchAccess: false,
        branchAccess: { create: [{ branchId: branchA }] },
      },
    });

    const a = await makeEmployee(branchA, 'EA');
    const b = await makeEmployee(branchB, 'EB');
    empAId = a.id;
    empBId = b.id;

    adminToken = await login(`admin-${runId}@test.local`);
    scopedHrToken = await login(`hr-${runId}@test.local`);
    empToken = await login(a.email);
    expect(adminToken).toBeTruthy();
  });

  afterAll(async () => {
    const { prisma } = ctx;
    for (const branchId of [branchA, branchB]) {
      await prisma.grievanceEvent.deleteMany({
        where: { grievance: { employee: { branchId } } },
      });
      await prisma.grievance.deleteMany({ where: { employee: { branchId } } });
      await prisma.letterRequest.deleteMany({ where: { employee: { branchId } } });
      await prisma.employeeDocument.deleteMany({ where: { employee: { branchId } } });
      await prisma.assetAssignment.deleteMany({ where: { asset: { branchId } } });
      await prisma.assetItem.deleteMany({ where: { branchId } });
    }
    await prisma.user.deleteMany({
      where: { email: { endsWith: `${runId}@test.local` } },
    });
    await prisma.employee.deleteMany({ where: { branchId: { in: [branchA, branchB] } } });
    await prisma.department.deleteMany({ where: { id: deptId } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchA, branchB] } } });
    await restoreApprovalSwitch(prisma, originalSwitch);
    await ctx.app.close();
  });

  // ── Masters actually reach the dropdowns ───────────────────────────────────

  describe('master data reaches every dropdown', () => {
    const ALL_TYPES = Object.values(LibraryType) as LibraryType[];

    it.each(ALL_TYPES)('GET /library-items?type=%s returns options', async (type) => {
      const res = await ctx
        .http()
        .get(`/library-items?type=${type}&activeOnly=true`)
        .set(bearer(adminToken))
        .expect(200);

      const rows = res.body.data ?? res.body;
      // Empty here is exactly the reported bug: the select renders with only its
      // placeholder and the form cannot be submitted.
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(typeof row.label).toBe('string');
        expect(row.label.trim()).not.toBe('');
      }
    });

    it('per-diem destinations carry the rate the travel form needs', async () => {
      const res = await ctx
        .http()
        .get('/library-items?type=PER_DIEM_DESTINATION&activeOnly=true')
        .set(bearer(adminToken))
        .expect(200);

      const rows = res.body.data ?? res.body;
      // Without a rate an approved trip spawns no per-diem claim at all.
      expect(rows.some((r: any) => Number(r.perDiemRate) > 0)).toBe(true);
    });

    it('an employee can read the masters their own forms depend on', async () => {
      // ESS raises travel and grievances, so a 403 here would break those forms.
      for (const type of ['PER_DIEM_DESTINATION', 'GRIEVANCE_CATEGORY']) {
        const res = await ctx
          .http()
          .get(`/library-items?type=${type}&activeOnly=true`)
          .set(bearer(empToken))
          .expect(200);
        expect((res.body.data ?? res.body).length).toBeGreaterThan(0);
      }
    });

    it('rejects a per-diem rate on a library type that does not use it', async () => {
      // A rate on a Position would be read by nothing and mislead whoever set it.
      await ctx
        .http()
        .post('/library-items')
        .set(bearer(adminToken))
        .send({
          libraryType: 'POSITION',
          label: `Edge Position ${runId}`,
          perDiemRate: 50,
        })
        .expect(400);
    });

    it('accepts a per-diem rate on a destination, and reads it back', async () => {
      const label = `Edge Destination ${runId}`;
      const created = await ctx
        .http()
        .post('/library-items')
        .set(bearer(adminToken))
        .send({
          libraryType: 'PER_DIEM_DESTINATION',
          label,
          perDiemRate: 42.5,
        })
        .expect(201);

      expect(Number(created.body.perDiemRate ?? created.body.data?.perDiemRate)).toBe(42.5);
      await ctx.prisma.libraryItem.deleteMany({
        where: { libraryType: 'PER_DIEM_DESTINATION', label },
      });
    });
  });

  // ── Assets ─────────────────────────────────────────────────────────────────

  describe('assets', () => {
    it('refuses to assign an asset across a branch boundary', async () => {
      const asset = await ctx.prisma.assetItem.create({
        data: {
          assetTag: `EDG-X-${runId}`,
          category: 'Laptop',
          name: 'Branch A laptop',
          branchId: branchA,
          status: 'AVAILABLE',
        },
      });

      // Branch-A HR cannot reach a branch-B employee. assertInBranch answers
      // 404, not 403 — confirming the employee exists is itself a leak.
      const res = await ctx
        .http()
        .post('/assets/assignments')
        .set(bearer(scopedHrToken))
        .set('X-Branch-Id', branchA)
        .send({ assetId: asset.id, employeeId: empBId });
      expect([404, 403]).toContain(res.status);

      const open = await ctx.prisma.assetAssignment.count({
        where: { assetId: asset.id, returnedAt: null },
      });
      expect(open).toBe(0);
    });

    it('refuses to delete an asset somebody is holding', async () => {
      const asset = await ctx.prisma.assetItem.create({
        data: {
          assetTag: `EDG-HELD-${runId}`,
          category: 'Laptop',
          name: 'Held',
          branchId: branchA,
          status: 'AVAILABLE',
        },
      });
      await ctx
        .http()
        .post('/assets/assignments')
        .set(bearer(adminToken))
        .send({ assetId: asset.id, employeeId: empAId })
        .expect(201);

      // Deleting cascades the assignment, silently clearing a clearance
      // obligation.
      await ctx
        .http()
        .delete(`/assets/${asset.id}`)
        .set(bearer(adminToken))
        .expect(400);
    });

    it('a damaged item does not silently re-enter the assignable pool', async () => {
      const open = await ctx.prisma.assetAssignment.findFirst({
        where: { employeeId: empAId, returnedAt: null },
      });
      await ctx
        .http()
        .post(`/assets/assignments/${open!.id}/return`)
        .set(bearer(adminToken))
        .send({ conditionIn: 'Cracked screen', assetStatus: 'IN_REPAIR' })
        .expect(201);

      const asset = await ctx.prisma.assetItem.findUnique({
        where: { id: open!.assetId },
      });
      expect(asset?.status).toBe('IN_REPAIR');

      // And it cannot be handed out while it is in repair.
      await ctx
        .http()
        .post('/assets/assignments')
        .set(bearer(adminToken))
        .send({ assetId: open!.assetId, employeeId: empAId })
        .expect(400);
    });

    it('rejects a return dated before the assignment', async () => {
      const asset = await ctx.prisma.assetItem.create({
        data: {
          assetTag: `EDG-DT-${runId}`,
          category: 'Laptop',
          name: 'Date check',
          branchId: branchA,
          status: 'AVAILABLE',
        },
      });
      const assigned = await ctx
        .http()
        .post('/assets/assignments')
        .set(bearer(adminToken))
        .send({ assetId: asset.id, employeeId: empAId, assignedAt: iso(-5) })
        .expect(201);

      await ctx
        .http()
        .post(`/assets/assignments/${assigned.body.data.id}/return`)
        .set(bearer(adminToken))
        .send({ returnedAt: iso(-30) })
        .expect(400);
    });

    it('cannot return the same assignment twice', async () => {
      const open = await ctx.prisma.assetAssignment.findFirst({
        where: { employeeId: empAId, returnedAt: null },
      });
      await ctx
        .http()
        .post(`/assets/assignments/${open!.id}/return`)
        .set(bearer(adminToken))
        .send({})
        .expect(201);
      await ctx
        .http()
        .post(`/assets/assignments/${open!.id}/return`)
        .set(bearer(adminToken))
        .send({})
        .expect(400);
    });
  });

  // ── Grievances ─────────────────────────────────────────────────────────────

  describe('grievances', () => {
    it('the subject cannot see it even when they are the ADMIN', async () => {
      // The strongest form of the rule: role does not override being the subject.
      const adminEmployee = await ctx.prisma.employee.create({
        data: {
          employeeCode: `EDG-ADMEMP-${runId}`,
          fullName: 'Edge Admin Employee',
          email: `admemp-${runId}@test.local`,
          idCard: `ID-ADMEMP-${runId}`,
          dateOfBirth: new Date('1990-01-01'),
          startDate: new Date('2020-01-01'),
          departmentId: deptId,
          position: 'Head',
          branchId: branchA,
          baseSalary: 3000,
          status: 'ACTIVE',
        },
      });
      await ctx.prisma.user.update({
        where: { id: adminUserId },
        data: { employeeId: adminEmployee.id },
      });
      // Re-login so the JWT principal carries the new employeeId.
      const refreshedAdmin = await login(`admin-${runId}@test.local`);

      const raised = await ctx
        .http()
        .post('/grievances')
        .set(bearer(empToken))
        .send({
          category: 'Management Practice',
          subject: 'About the admin',
          description: 'Details.',
          againstEmployeeId: adminEmployee.id,
        })
        .expect(201);

      // A second case that names nobody — the ordinary shape of a grievance,
      // and the one the exclusion must not touch.
      const unnamed = await ctx
        .http()
        .post('/grievances')
        .set(bearer(empToken))
        .send({
          category: 'Other',
          subject: 'About nobody in particular',
          description: 'Details.',
        })
        .expect(201);

      await ctx
        .http()
        .get(`/grievances/${raised.body.data.id}`)
        .set(bearer(refreshedAdmin))
        .expect(404);

      const list = await ctx
        .http()
        .get('/grievances')
        .set(bearer(refreshedAdmin))
        .expect(200);
      const listed = list.body.data.map((g: any) => g.id);
      expect(listed).not.toContain(raised.body.data.id);
      // ...but the exclusion must stop there. Written as
      // `NOT: { againstEmployeeId }` it compiled to
      // `NOT (against_employee_id = $1)`, which is NULL rather than TRUE for a
      // case that names nobody, so HR's whole list came back empty. This half
      // of the assertion is what nothing checked.
      expect(listed).toContain(unnamed.body.data.id);

      await ctx.prisma.user.update({
        where: { id: adminUserId },
        data: { employeeId: null },
      });
    });

    it('cannot be withdrawn once HR is investigating', async () => {
      const raised = await ctx
        .http()
        .post('/grievances')
        .set(bearer(empToken))
        .send({ category: 'Other', subject: 'In progress', description: 'x' })
        .expect(201);

      await ctx
        .http()
        .patch(`/grievances/${raised.body.data.id}`)
        .set(bearer(adminToken))
        .send({ status: 'INVESTIGATING' })
        .expect(200);

      // Withdrawing mid-investigation would destroy an in-flight HR case.
      await ctx
        .http()
        .post(`/grievances/${raised.body.data.id}/withdraw`)
        .set(bearer(empToken))
        .expect(400);
    });

    it('rejects an unknown status rather than storing it', async () => {
      const raised = await ctx
        .http()
        .post('/grievances')
        .set(bearer(empToken))
        .send({ category: 'Other', subject: 'Status check', description: 'x' })
        .expect(201);

      await ctx
        .http()
        .patch(`/grievances/${raised.body.data.id}`)
        .set(bearer(adminToken))
        .send({ status: 'BANANA' })
        .expect(400);
    });
  });

  // ── Document vault ─────────────────────────────────────────────────────────

  describe('document vault', () => {
    it('excludes the avatar — a profile picture is not a document', async () => {
      await ctx.prisma.employeeDocument.create({
        data: {
          employeeId: empAId,
          documentType: 'AVATAR',
          fileName: 'avatar.png',
          fileUrl: '/uploads/avatars/avatar.png',
          mimeType: 'image/png',
        },
      });

      const res = await ctx
        .http()
        .get('/document-vault/me')
        .set(bearer(empToken))
        .expect(200);

      expect(
        res.body.data.items.some((i: any) => i.category === 'AVATAR'),
      ).toBe(false);
    });

    it('counts an expired document separately from one expiring soon', async () => {
      await ctx.prisma.employeeDocument.createMany({
        data: [
          {
            employeeId: empAId,
            documentType: 'Certificate',
            fileName: 'lapsed.pdf',
            fileUrl: '/uploads/documents/lapsed.pdf',
            expiryDate: day(-10),
          },
          {
            employeeId: empAId,
            documentType: 'Certificate',
            fileName: 'soon.pdf',
            fileUrl: '/uploads/documents/soon.pdf',
            expiryDate: day(30),
          },
        ],
      });

      const res = await ctx
        .http()
        .get('/document-vault/me')
        .set(bearer(empToken))
        .expect(200);

      expect(res.body.data.summary.expired).toBeGreaterThan(0);
      expect(res.body.data.summary.expiringSoon).toBeGreaterThan(0);
    });

    it('never serves a private file to a non-owner, whatever the id', async () => {
      const doc = await ctx.prisma.employeeDocument.create({
        data: {
          employeeId: empBId, // branch B — not the caller
          documentType: 'Letter',
          fileName: 'private.pdf',
          fileUrl: 'private://letters/private.pdf',
          privateRef: 'private://letters/private.pdf',
          isSystemGenerated: true,
        },
      });

      const res = await ctx
        .http()
        .get(`/secure-files/employee-document/${doc.id}`)
        .set(bearer(empToken));
      // 403 (not mine) or 404 (out of branch) — never the bytes.
      expect([403, 404]).toContain(res.status);
    });

    it('404s a well-formed id that does not exist', async () => {
      await ctx
        .http()
        .get('/secure-files/employee-document/00000000-0000-0000-0000-000000000000')
        .set(bearer(adminToken))
        .expect(404);
    });
  });
});
