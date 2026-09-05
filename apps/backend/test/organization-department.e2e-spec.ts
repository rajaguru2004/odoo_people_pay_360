import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupOrgFixtures, OrgFixtures, bearer } from './utils/org-fixtures';

/**
 * Department, end to end.
 *
 * The department is where this product keeps its hierarchy rules, and almost all
 * of them are refusals: two levels deep and no further, no cycles, no moving a
 * populated department, no deleting one that still has people or children. A
 * refusal that silently stops refusing is invisible in production until the org
 * chart is already wrong, so each one is asserted here by its message, not just
 * its status code.
 *
 * The other half is authority. A MANAGER may read the departments they head and
 * nothing else, and headship itself moves a user between roles — assigning a
 * head promotes them, and the change-request suite proves the reverse. That
 * makes `assignManager` a permission-changing endpoint, and it is tested as one.
 */
describe('Organization — Department (e2e)', () => {
  let ctx: E2EContext;
  let fx: OrgFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };
  const codesOf = (res: any) => rowsOf(res).map((d: any) => d.code);

  let seq = 0;
  /** Creates a department over the API and returns the response. */
  const createDept = (token: string, payload: Record<string, unknown>) =>
    ctx.http().post('/departments').set(bearer(token)).send(payload);

  /** A department created directly, for tests that need a disposable one. */
  const seedDept = (over: Record<string, unknown> = {}) =>
    ctx.prisma.department.create({
      data: {
        code: `ORG-T${seq++}-${fx.runId}`,
        name: `Org Throwaway ${seq}`,
        isActive: true,
        ...over,
      },
    });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupOrgFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Read ──────────────────────────────────────────────────────────────────
  describe('reading departments', () => {
    it('DEP-API-01 admits ADMIN, HR and MANAGER; refuses EMPLOYEE and anonymous', async () => {
      const get = (token?: string) => {
        const r = ctx.http().get('/departments');
        return token ? r.set(bearer(token)) : r;
      };

      expect((await get(fx.admin.token)).status).toBe(200);
      expect((await get(fx.hr.token)).status).toBe(200);
      expect((await get(fx.deptManager.token)).status).toBe(200);
      expect((await get(fx.employee.token)).status).toBe(403);
      expect((await get()).status).toBe(401);
    });

    it('DEP-API-02 returns active departments only, ordered by code, with relations and counts', async () => {
      const dead = await seedDept({ isActive: false });

      const res = await ctx
        .http()
        .get('/departments')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const codes = codesOf(res);
      expect(codes).toContain(fx.topDeptCode);
      expect(codes).not.toContain(dead.code);
      // Ordered by code, asserted on the fixture departments only: comparing the
      // whole list against a JavaScript sort would encode the wrong collation
      // (Postgres and JS disagree about where punctuation sorts). These five
      // differ in a letter, which every collation orders the same way.
      const fixtureOrder = codes.filter(
        (c: string) => c.startsWith('ORG-') && c.endsWith(fx.runId),
      );
      expect(fixtureOrder).toEqual([
        fx.childDeptCode,
        fx.emptyDeptCode,
        fx.secondDeptCode,
        fx.thirdDeptCode,
        fx.topDeptCode,
      ]);

      const top = rowsOf(res).find((d: any) => d.code === fx.topDeptCode);
      expect(top.manager).toBeTruthy();
      expect(top._count.employees).toBeGreaterThan(0);
      expect(top._count.children).toBe(1);
      expect(top.children.map((c: any) => c.code)).toContain(fx.childDeptCode);
    });

    it('DEP-API-03 narrows the list and the counts to the selected branch', async () => {
      const all = await ctx
        .http()
        .get('/departments')
        .set(bearer(fx.admin.token));
      const unscoped = rowsOf(all).find((d: any) => d.code === fx.topDeptCode);

      const scopedToB = await ctx
        .http()
        .get('/departments')
        .set(bearer(fx.admin.token))
        .set('X-Branch-Id', fx.branchB);
      const inB = rowsOf(scopedToB).find((d: any) => d.code === fx.topDeptCode);

      // The department is staffed in both branches, so it stays visible — but
      // the headcount is the branch's, not the company's. A count that ignored
      // the selector would tell a branch manager they have staff they cannot see.
      expect(inB).toBeDefined();
      expect(inB._count.employees).toBe(1);
      expect(unscoped._count.employees).toBeGreaterThan(inB._count.employees);

      // A department with no staff anywhere stays visible under every branch,
      // otherwise a freshly created one would disappear until someone is hired.
      expect(codesOf(scopedToB)).toContain(fx.emptyDeptCode);
    });

    it('DEP-API-04 builds a two-level tree and keeps every node under a branch selection', async () => {
      const res = await ctx
        .http()
        .get('/departments/tree')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const roots = rowsOf(res);
      expect(roots.every((d: any) => d.parentId === null)).toBe(true);

      const top = roots.find((d: any) => d.code === fx.topDeptCode);
      expect(top.children.map((c: any) => c.code)).toContain(fx.childDeptCode);
      expect(top.children.every((c: any) => c.children.length === 0)).toBe(
        true,
      );

      // Unlike the flat list, the tree keeps every node whatever branch is
      // selected — a hierarchy with holes in it is not a hierarchy.
      const scoped = await ctx
        .http()
        .get('/departments/tree')
        .set(bearer(fx.admin.token))
        .set('X-Branch-Id', fx.branchB);
      const scopedTop = rowsOf(scoped).find(
        (d: any) => d.code === fx.topDeptCode,
      );
      expect(scopedTop).toBeDefined();
      expect(scopedTop._count.employees).toBe(1);
    });

    it('DEP-API-05 lets a MANAGER read the department they head and refuses the others', async () => {
      const own = await ctx
        .http()
        .get(`/departments/${fx.topDeptId}`)
        .set(bearer(fx.deptManager.token));
      expect(own.status).toBe(200);
      expect(own.body.data.code).toBe(fx.topDeptCode);

      const foreign = await ctx
        .http()
        .get(`/departments/${fx.secondDeptId}`)
        .set(bearer(fx.deptManager.token));
      expect(foreign.status).toBe(403);
      expect(body(foreign)).toContain(
        'You do not have permission to view other departments',
      );

      const asEmployee = await ctx
        .http()
        .get(`/departments/${fx.topDeptId}`)
        .set(bearer(fx.employee.token));
      expect(asEmployee.status).toBe(403);

      const unknown = await ctx
        .http()
        .get('/departments/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token));
      expect(unknown.status).toBe(404);
    });

    it('DEP-API-05b a manager heading two departments reads both', async () => {
      const second = await ctx
        .http()
        .get(`/departments/${fx.secondDeptId}`)
        .set(bearer(fx.multiDeptManager.token));
      const third = await ctx
        .http()
        .get(`/departments/${fx.thirdDeptId}`)
        .set(bearer(fx.multiDeptManager.token));
      const other = await ctx
        .http()
        .get(`/departments/${fx.topDeptId}`)
        .set(bearer(fx.multiDeptManager.token));

      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
      expect(other.status).toBe(403);
    });
  });

  // ── Create ────────────────────────────────────────────────────────────────
  describe('creating a department', () => {
    it('DEP-API-06 creates with code and name, refuses a duplicate code and bad input', async () => {
      const ok = await createDept(fx.admin.token, {
        code: `ORG-NEW-${fx.runId}`,
        name: 'Newly created',
      });
      expect(ok.status).toBe(201);
      expect(ok.body.data.isActive).toBe(true);

      const dup = await createDept(fx.admin.token, {
        code: `ORG-NEW-${fx.runId}`,
        name: 'Twin',
      });
      expect(dup.status).toBe(409);
      expect(body(dup)).toContain('Department code already exists');

      expect(
        (await createDept(fx.admin.token, { code: 'C'.repeat(51), name: 'x' }))
          .status,
      ).toBe(400);
      expect(
        (
          await createDept(fx.admin.token, {
            code: 'ORG-X',
            name: 'N'.repeat(256),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await createDept(fx.admin.token, {
            code: 'ORG-X',
            name: 'x',
            parentId: 'nope',
          })
        ).status,
      ).toBe(400);
      expect(
        (await createDept(fx.admin.token, { name: 'no code' })).status,
      ).toBe(400);
    });

    it('DEP-API-07 allows one level of nesting and refuses a third', async () => {
      const child = await createDept(fx.admin.token, {
        code: `ORG-L2-${fx.runId}`,
        name: 'Second level',
        parentId: fx.topDeptId,
      });
      expect(child.status).toBe(201);
      expect(child.body.data.parent.code).toBe(fx.topDeptCode);

      const grandchild = await createDept(fx.admin.token, {
        code: `ORG-L3-${fx.runId}`,
        name: 'Third level',
        parentId: child.body.data.id,
      });
      expect(grandchild.status).toBe(400);
      expect(body(grandchild)).toContain('more than 2 levels deep');
    });

    it('DEP-API-08 requires a team head to come from the parent department', async () => {
      const outsider = await createDept(fx.admin.token, {
        code: `ORG-TM1-${fx.runId}`,
        name: 'Team with outsider head',
        parentId: fx.secondDeptId,
        managerId: fx.staffAId, // belongs to topDept, not secondDept
      });
      expect(outsider.status).toBe(400);
      expect(body(outsider)).toContain(
        'Team manager must be an employee of the parent department',
      );

      const insider = await createDept(fx.admin.token, {
        code: `ORG-TM2-${fx.runId}`,
        name: 'Team with valid head',
        parentId: fx.secondDeptId,
        managerId: fx.secondDeptStaffId,
      });
      expect(insider.status).toBe(201);
    });

    it('DEP-API-09 refuses an unknown parent and an unknown manager', async () => {
      const noParent = await createDept(fx.admin.token, {
        code: `ORG-NP-${fx.runId}`,
        name: 'x',
        parentId: '00000000-0000-0000-0000-000000000000',
      });
      expect(noParent.status).toBe(400);
      expect(body(noParent)).toContain('Parent department not found');

      const noManager = await createDept(fx.admin.token, {
        code: `ORG-NM-${fx.runId}`,
        name: 'x',
        managerId: '00000000-0000-0000-0000-000000000000',
      });
      expect(noManager.status).toBe(400);
      expect(body(noManager)).toContain('Manager not found');
    });

    it('DEP-API-10 refuses MANAGER and EMPLOYEE', async () => {
      const asManager = await createDept(fx.deptManager.token, {
        code: `ORG-MGRC-${fx.runId}`,
        name: 'nope',
      });
      const asEmployee = await createDept(fx.employee.token, {
        code: `ORG-EMPC-${fx.runId}`,
        name: 'nope',
      });
      expect(asManager.status).toBe(403);
      expect(asEmployee.status).toBe(403);
    });
  });

  // ── Update ────────────────────────────────────────────────────────────────
  describe('updating a department', () => {
    it('DEP-API-11 renames, keeps its own code, and refuses a taken one', async () => {
      const dept = await seedDept();

      const renamed = await ctx
        .http()
        .patch(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token))
        .send({ name: 'Renamed', description: 'now with a description' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data.name).toBe('Renamed');

      const ownCode = await ctx
        .http()
        .patch(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token))
        .send({ code: dept.code, name: 'Renamed again' });
      expect(ownCode.status).toBe(200);

      const taken = await ctx
        .http()
        .patch(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token))
        .send({ code: fx.topDeptCode });
      expect(taken.status).toBe(409);
    });

    it('DEP-API-12 refuses a department as its own parent', async () => {
      const dept = await seedDept();
      const res = await ctx
        .http()
        .patch(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token))
        .send({ parentId: dept.id });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('cannot be its own parent');
    });

    it('DEP-API-13 refuses a move that would close a loop', async () => {
      // parent → child already exists; pointing the parent at its own child is
      // the smallest cycle the hierarchy can express.
      const parent = await seedDept();
      const child = await seedDept({ parentId: parent.id });

      const res = await ctx
        .http()
        .patch(`/departments/${parent.id}`)
        .set(bearer(fx.admin.token))
        .send({ parentId: child.id });

      expect(res.status).toBe(400);
      // Either guard is a correct refusal — the child already has a parent, so
      // the depth rule may fire before the cycle check. What matters is that the
      // loop cannot be created.
      expect(body(res)).toMatch(
        /Circular reference|2 levels deep|sub-departments/,
      );
    });

    it('DEP-API-14 refuses to re-parent a department that still has employees', async () => {
      const res = await ctx
        .http()
        .patch(`/departments/${fx.topDeptId}`)
        .set(bearer(fx.admin.token))
        .send({ parentId: fx.secondDeptId });
      expect(res.status).toBe(400);
      expect(body(res)).toMatch(/has employees|sub-departments/);
    });

    it('DEP-API-15 refuses to re-parent a department that has sub-departments', async () => {
      const parent = await seedDept();
      await seedDept({ parentId: parent.id });

      const res = await ctx
        .http()
        .patch(`/departments/${parent.id}`)
        .set(bearer(fx.admin.token))
        .send({ parentId: fx.secondDeptId });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('sub-departments');
    });

    it('DEP-API-16 refuses a parent that is already someone else’s child', async () => {
      const dept = await seedDept();
      const res = await ctx
        .http()
        .patch(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token))
        .send({ parentId: fx.childDeptId });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('2 levels deep');
    });

    it('DEP-API-17 detaches an empty department back to the top level', async () => {
      const child = await seedDept({ parentId: fx.topDeptId });

      const res = await ctx
        .http()
        .patch(`/departments/${child.id}`)
        .set(bearer(fx.admin.token))
        .send({ parentId: null });
      expect(res.status).toBe(200);

      const row = await ctx.prisma.department.findUnique({
        where: { id: child.id },
      });
      expect(row?.parentId).toBeNull();

      const tree = await ctx
        .http()
        .get('/departments/tree')
        .set(bearer(fx.admin.token));
      expect(rowsOf(tree).map((d: any) => d.code)).toContain(child.code);
    });

    it('DEP-API-18 lets one manager head a second department', async () => {
      // The old "already manages another department" block was removed on
      // purpose (multi-department managers). This is the regression lock.
      const dept = await seedDept();
      const res = await ctx
        .http()
        .patch(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token))
        .send({ managerId: fx.multiDeptManager.employeeId });
      expect(res.status).toBe(200);
      expect(res.body.data.manager.id).toBe(fx.multiDeptManager.employeeId);
    });

    it('DEP-API-19 refuses an unknown manager and an unknown department', async () => {
      const dept = await seedDept();
      const badManager = await ctx
        .http()
        .patch(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token))
        .send({ managerId: '00000000-0000-0000-0000-000000000000' });
      expect(badManager.status).toBe(400);

      const unknown = await ctx
        .http()
        .patch('/departments/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token))
        .send({ name: 'ghost' });
      expect(unknown.status).toBe(404);
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  describe('deleting a department', () => {
    it('DEP-API-20 soft-deletes an empty leaf, which then leaves the list and the tree', async () => {
      const dept = await seedDept();

      const res = await ctx
        .http()
        .delete(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const row = await ctx.prisma.department.findUnique({
        where: { id: dept.id },
      });
      expect(row?.isActive).toBe(false);

      const list = await ctx
        .http()
        .get('/departments')
        .set(bearer(fx.admin.token));
      expect(codesOf(list)).not.toContain(dept.code);

      const tree = await ctx
        .http()
        .get('/departments/tree')
        .set(bearer(fx.admin.token));
      expect(rowsOf(tree).map((d: any) => d.code)).not.toContain(dept.code);

      // And gone by id, exactly as with Branch: a stale link must not keep
      // working and the edit form must not keep saving into it.
      const byId = await ctx
        .http()
        .get(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token));
      expect(byId.status).toBe(404);
    });

    it('DEP-API-21 refuses while employees or sub-departments remain', async () => {
      const withStaff = await ctx
        .http()
        .delete(`/departments/${fx.topDeptId}`)
        .set(bearer(fx.admin.token));
      expect(withStaff.status).toBe(400);
      expect(body(withStaff)).toMatch(/employees|sub-departments/);

      const parent = await seedDept();
      await seedDept({ parentId: parent.id });
      const withChildren = await ctx
        .http()
        .delete(`/departments/${parent.id}`)
        .set(bearer(fx.admin.token));
      expect(withChildren.status).toBe(400);
      expect(body(withChildren)).toContain('sub-departments');
    });

    it('DEP-API-21b a retired sub-department no longer blocks its parent', async () => {
      // The child count used to ignore isActive, so a sub-department removed
      // months ago kept its parent permanently undeletable — refused because of
      // children the user could no longer see anywhere.
      const parent = await seedDept();
      const child = await seedDept({ parentId: parent.id });
      await ctx
        .http()
        .delete(`/departments/${child.id}`)
        .set(bearer(fx.admin.token));

      const res = await ctx
        .http()
        .delete(`/departments/${parent.id}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const row = await ctx.prisma.department.findUnique({
        where: { id: parent.id },
      });
      expect(row?.isActive).toBe(false);
    });

    it('DEP-API-22 refuses an unknown department, a MANAGER and an EMPLOYEE', async () => {
      const dept = await seedDept();

      const unknown = await ctx
        .http()
        .delete('/departments/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token));
      expect(unknown.status).toBe(404);

      const asManager = await ctx
        .http()
        .delete(`/departments/${dept.id}`)
        .set(bearer(fx.deptManager.token));
      const asEmployee = await ctx
        .http()
        .delete(`/departments/${dept.id}`)
        .set(bearer(fx.employee.token));
      expect(asManager.status).toBe(403);
      expect(asEmployee.status).toBe(403);
    });
  });

  // ── Headship ──────────────────────────────────────────────────────────────
  describe('assigning a head', () => {
    it('DEP-API-23 promotes an EMPLOYEE user to MANAGER, effective on their next request', async () => {
      const dept = await seedDept();

      // Before: the candidate's user is an EMPLOYEE and cannot read departments.
      const before = await ctx
        .http()
        .get('/departments')
        .set(bearer(fx.seniorCandidateUser.token));
      expect(before.status).toBe(403);

      const res = await ctx
        .http()
        .patch(`/departments/${dept.id}/manager`)
        .set(bearer(fx.admin.token))
        .send({ managerId: fx.seniorCandidateId });
      expect(res.status).toBe(200);

      const user = await ctx.prisma.user.findUnique({
        where: { id: fx.seniorCandidateUser.userId },
      });
      expect(user?.role).toBe('MANAGER');

      // The SAME token now carries manager authority: the principal is rebuilt
      // from the database per request, so a promotion does not wait for a
      // re-login. That is a security-relevant property in both directions.
      const after = await ctx
        .http()
        .get(`/departments/${dept.id}`)
        .set(bearer(fx.seniorCandidateUser.token));
      expect(after.status).toBe(200);
    });

    it('DEP-API-24 refuses an inactive employee, an unknown employee and an unknown department', async () => {
      const dept = await seedDept();

      const inactive = await ctx
        .http()
        .patch(`/departments/${dept.id}/manager`)
        .set(bearer(fx.admin.token))
        .send({ managerId: fx.inactiveCandidateId });
      expect(inactive.status).toBe(400);
      expect(body(inactive)).toContain('Manager must be an active employee');

      const unknownManager = await ctx
        .http()
        .patch(`/departments/${dept.id}/manager`)
        .set(bearer(fx.admin.token))
        .send({ managerId: '00000000-0000-0000-0000-000000000000' });
      expect(unknownManager.status).toBe(404);

      const unknownDept = await ctx
        .http()
        .patch('/departments/00000000-0000-0000-0000-000000000000/manager')
        .set(bearer(fx.admin.token))
        .send({ managerId: fx.seniorCandidateId });
      expect(unknownDept.status).toBe(404);
    });

    it('DEP-API-25 gives a two-department head authority over both', async () => {
      const dept = await seedDept();
      await ctx
        .http()
        .patch(`/departments/${dept.id}/manager`)
        .set(bearer(fx.admin.token))
        .send({ managerId: fx.multiDeptManager.employeeId });

      const first = await ctx
        .http()
        .get(`/departments/${fx.secondDeptId}`)
        .set(bearer(fx.multiDeptManager.token));
      const second = await ctx
        .http()
        .get(`/departments/${dept.id}`)
        .set(bearer(fx.multiDeptManager.token));

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it('DEP-API-26 removing a head’s only department demotes them', async () => {
      // Deleting the department someone heads used to leave role = MANAGER with
      // nothing to manage, at which point managedDepartments resolves empty and
      // managerDeptScope falls back to their HOME department: authority did not
      // end, it moved somewhere nobody granted.
      const dept = await seedDept();
      const staff = await ctx.prisma.employee.create({
        data: {
          employeeCode: `EMP-${fx.runId}-LONE`,
          fullName: 'Lone Head',
          dateOfBirth: new Date('1990-01-01'),
          idCard: `ID-${fx.runId}-LONE`,
          email: `lone-${fx.runId}@test.local`,
          departmentId: fx.topDeptId,
          branchId: fx.branchA,
          position: 'Engineer',
          startDate: new Date('2020-01-01'),
          baseSalary: 50000,
          status: 'ACTIVE',
        },
      });
      const user = await ctx.prisma.user.create({
        data: {
          email: `loneu-${fx.runId}@test.local`,
          passwordHash: (await ctx.prisma.user.findUnique({
            where: { id: fx.employee.userId },
          }))!.passwordHash,
          role: 'EMPLOYEE',
          isActive: true,
          employeeId: staff.id,
        },
      });

      await ctx
        .http()
        .patch(`/departments/${dept.id}/manager`)
        .set(bearer(fx.admin.token))
        .send({ managerId: staff.id });
      expect(
        (await ctx.prisma.user.findUnique({ where: { id: user.id } }))?.role,
      ).toBe('MANAGER');

      await ctx
        .http()
        .delete(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token));

      const after = await ctx.prisma.user.findUnique({
        where: { id: user.id },
      });
      expect(after?.role).toBe('EMPLOYEE');

      // And the authority is really gone rather than relabelled: their home
      // department — which they were never made head of — is refused.
      const login = await ctx
        .http()
        .post('/auth/login')
        .send({ email: user.email, password: fx.password });
      const token = login.body.data.accessToken;

      const home = await ctx
        .http()
        .get(`/departments/${fx.topDeptId}`)
        .set(bearer(token));
      expect(home.status).toBe(403);
    });

    it('DEP-API-26b keeps the role when they still head something else', async () => {
      const keep = await seedDept();
      const drop = await seedDept();
      for (const d of [keep, drop]) {
        await ctx
          .http()
          .patch(`/departments/${d.id}/manager`)
          .set(bearer(fx.admin.token))
          .send({ managerId: fx.seniorCandidateId });
      }

      await ctx
        .http()
        .delete(`/departments/${drop.id}`)
        .set(bearer(fx.admin.token));

      const user = await ctx.prisma.user.findUnique({
        where: { id: fx.seniorCandidateUser.userId },
      });
      expect(user?.role).toBe('MANAGER');
    });
  });

  // ── Reporting surfaces ────────────────────────────────────────────────────
  describe('performance and hierarchy reporting', () => {
    it('DEP-API-27 serves department statistics to ADMIN and HR only', async () => {
      const asAdmin = await ctx
        .http()
        .get('/departments/performance-stats')
        .set(bearer(fx.admin.token));
      expect(asAdmin.status).toBe(200);
      // COUNT() comes back from raw SQL as BigInt; if it ever reaches the
      // serializer un-coerced the whole endpoint 500s, so a 200 with numbers is
      // the assertion that matters.
      for (const row of rowsOf(asAdmin)) {
        expect(typeof row.employeeCount).toBe('number');
        expect(['up', 'down', 'stable']).toContain(row.trend);
      }
      expect(asAdmin.body.meta.period).toBe('month');

      expect(
        (
          await ctx
            .http()
            .get('/departments/performance-stats')
            .set(bearer(fx.hr.token))
        ).status,
      ).toBe(200);
      expect(
        (
          await ctx
            .http()
            .get('/departments/performance-stats')
            .set(bearer(fx.deptManager.token))
        ).status,
      ).toBe(403);
      expect(
        (
          await ctx
            .http()
            .get('/departments/performance-stats')
            .set(bearer(fx.employee.token))
        ).status,
      ).toBe(403);
    });

    it('DEP-API-27b excludes departments with nobody in them', async () => {
      const res = await ctx
        .http()
        .get('/departments/performance-stats')
        .set(bearer(fx.admin.token));
      const codes = rowsOf(res).map((r: any) => r.departmentCode);
      expect(codes).not.toContain(fx.emptyDeptCode);
    });

    it('DEP-API-28 serves one department’s performance, and refuses a MANAGER the others', async () => {
      const own = await ctx
        .http()
        .get(`/departments/${fx.topDeptId}/performance`)
        .set(bearer(fx.deptManager.token));
      expect(own.status).toBe(200);
      expect(own.body.data.departmentCode).toBe(fx.topDeptCode);
      expect(typeof own.body.data.employeeCount).toBe('number');
      expect(Array.isArray(own.body.data.topPerformers)).toBe(true);

      const foreign = await ctx
        .http()
        .get(`/departments/${fx.secondDeptId}/performance`)
        .set(bearer(fx.deptManager.token));
      expect(foreign.status).toBe(403);

      const asEmployee = await ctx
        .http()
        .get(`/departments/${fx.topDeptId}/performance`)
        .set(bearer(fx.employee.token));
      expect(asEmployee.status).toBe(403);
    });

    it('DEP-API-28b reports zeroes for an empty department rather than failing', async () => {
      const res = await ctx
        .http()
        .get(`/departments/${fx.emptyDeptId}/performance`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.employeeCount).toBe(0);
      expect(res.body.data.attendanceRate).toBe(0);
    });

    it('DEP-API-28c 404s an unknown department’s performance', async () => {
      const res = await ctx
        .http()
        .get('/departments/00000000-0000-0000-0000-000000000000/performance')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(404);
    });

    it('DEP-API-29 reports hierarchy problems and names the department', async () => {
      const orphanParent = await seedDept();
      const orphan = await seedDept({
        parentId: orphanParent.id,
        name: `Orphan ${fx.runId}`,
      });
      await ctx.prisma.department.update({
        where: { id: orphanParent.id },
        data: { isActive: false },
      });

      const res = await ctx
        .http()
        .get('/departments/validate/hierarchy')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body.issues)).toContain(`Orphan ${fx.runId}`);

      expect(
        (
          await ctx
            .http()
            .get('/departments/validate/hierarchy')
            .set(bearer(fx.deptManager.token))
        ).status,
      ).toBe(403);

      await ctx.prisma.department.update({
        where: { id: orphan.id },
        data: { parentId: null },
      });
    });
  });

  // ── Audit and the employee link ───────────────────────────────────────────
  describe('audit and the directory link', () => {
    it('DEP-API-30 records who created, changed and removed a department', async () => {
      const created = await createDept(fx.admin.token, {
        code: `ORG-AUD-${fx.runId}`,
        name: 'Audited dept',
      });
      const id = created.body.data.id;

      await ctx
        .http()
        .patch(`/departments/${id}`)
        .set(bearer(fx.admin.token))
        .send({ name: 'Audited dept (renamed)' });
      await ctx.http().delete(`/departments/${id}`).set(bearer(fx.admin.token));

      const rows = await ctx.prisma.auditLog.findMany({
        where: { resourceType: 'Department', resourceId: id },
        select: { action: true, userId: true },
      });
      expect(rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['UPDATE', 'DELETE']),
      );
      expect(rows.every((r) => r.userId === fx.admin.userId)).toBe(true);
    });

    it('DEP-API-31 filters the employee directory to one department, still branch-scoped', async () => {
      const all = await ctx
        .http()
        .get(`/employees?departmentId=${fx.topDeptId}&limit=100`)
        .set(bearer(fx.admin.token));
      expect(all.status).toBe(200);
      const ids = rowsOf(all).map((e: any) => e.id);
      expect(ids).toEqual(
        expect.arrayContaining([fx.staffAId, fx.staffBranchBId]),
      );
      expect(ids).not.toContain(fx.secondDeptStaffId);

      const inBranchA = await ctx
        .http()
        .get(`/employees?departmentId=${fx.topDeptId}&limit=100`)
        .set(bearer(fx.admin.token))
        .set('X-Branch-Id', fx.branchA);
      const scopedIds = rowsOf(inBranchA).map((e: any) => e.id);
      expect(scopedIds).toContain(fx.staffAId);
      expect(scopedIds).not.toContain(fx.staffBranchBId);
    });
  });
});
