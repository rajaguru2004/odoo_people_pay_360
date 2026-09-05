import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ACCOUNTS, createTestApp, signIn, type Session } from './setup-app';

/**
 * NOTE ON ISOLATION
 *
 * These specs write to the e2e database and some of what they write is
 * HISTORY that the application deliberately does not delete — an approved
 * change request, a renewed permit. Re-running them accumulates that history,
 * which is correct behaviour and harmless, but it means no assertion here or
 * in the browser suite may depend on a whole-table count.
 *
 * Start from a clean slate with `npm run e2e:db reset` (which drops the
 * container) rather than `npm run e2e:up` (which only re-seeds a database that
 * is already running).
 */

/**
 * The Organisation module against a real, seeded database.
 *
 * Needs the test stack up: `npm run e2e:up` from the repo root, with
 * apps/backend/.env.test loaded.
 */
describe('Organisation (e2e)', () => {
  let app: INestApplication;
  let admin: Session;
  let employee: Session;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signIn(app, ACCOUNTS.admin);
    employee = await signIn(app, ACCOUNTS.employee);
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  describe('branches', () => {
    it('lists the seeded branches with their occupancy counts', async () => {
      const res = await admin.auth(http().get('/branches')).expect(200);
      expect(res.body.success).toBe(true);

      const hq = res.body.data.find((b: { code: string }) => b.code === 'HQ');
      expect(hq).toBeDefined();
      expect(hq._count.employees).toBeGreaterThan(0);
    });

    it('refuses a duplicate branch code', async () => {
      const res = await admin
        .auth(http().post('/branches'))
        .send({ code: 'HQ', name: 'Another Head Office' })
        .expect(409);
      expect(res.body.message).toMatch(/already in use/i);
    });

    it('refuses to switch geofencing on without a centre to measure from', async () => {
      const res = await admin
        .auth(http().post('/branches'))
        .send({
          code: `GEO-${Date.now()}`,
          name: 'Fenceless',
          geofencingEnabled: true,
        })
        .expect(400);
      expect(res.body.message).toMatch(/latitude|longitude|radius/i);
    });

    it('rejects an unknown field rather than dropping it silently', () =>
      admin
        .auth(http().post('/branches'))
        .send({ code: `X-${Date.now()}`, name: 'X', notAColumn: 'oops' })
        .expect(400));

    it('is closed to an employee for writes', () =>
      employee
        .auth(http().post('/branches'))
        .send({ code: `E-${Date.now()}`, name: 'Employee Branch' })
        .expect(403));
  });

  describe('departments', () => {
    it('serves the hierarchy as a tree rather than a flat list', async () => {
      const res = await admin.auth(http().get('/departments/tree')).expect(200);

      // `tree` must not be parsed as an id — a flat 400 here is the route
      // ordering having regressed, not the data.
      expect(Array.isArray(res.body.data)).toBe(true);
      const withChildren = res.body.data.filter(
        (n: { children: unknown[] }) => n.children.length > 0,
      );
      expect(withChildren.length).toBeGreaterThan(0);
    });

    it('reports the governance statistics the hub is built on', async () => {
      const res = await admin
        .auth(http().get('/departments/statistics'))
        .expect(200);

      expect(res.body.data).toMatchObject({
        total: expect.any(Number),
        withoutHead: expect.any(Number),
        maxDepth: expect.any(Number),
      });
      expect(Array.isArray(res.body.data.spanOfControl)).toBe(true);
    });

    it('refuses to delete a department that still has people in it', async () => {
      const list = await admin.auth(http().get('/departments')).expect(200);
      const occupied = list.body.data.find(
        (d: { _count: { employees: number } }) => d._count.employees > 0,
      );

      const res = await admin
        .auth(http().delete(`/departments/${occupied.id}`))
        .expect(400);
      expect(res.body.message).toMatch(/reassign/i);
    });

    it('refuses a parent that would close a cycle', async () => {
      const tree = await admin
        .auth(http().get('/departments/tree'))
        .expect(200);
      const root = tree.body.data[0];
      const child = root.children?.[0];
      expect(child).toBeDefined();

      // Making the root a child of its own descendant is the cycle the org
      // chart walk cannot survive.
      const res = await admin
        .auth(http().patch(`/departments/${root.id}`))
        .send({ parentId: child.id })
        .expect(400);
      expect(res.body.message).toMatch(/below this department|itself/i);
    });
  });

  describe('change requests', () => {
    it('lists the queue with pagination meta rather than a bare array', async () => {
      const res = await admin
        .auth(http().get('/departments/change-requests'))
        .expect(200);

      // The hub counts this queue from the database, not from a page length —
      // `meta.total` is what makes that possible.
      expect(res.body.meta).toMatchObject({ total: expect.any(Number) });
    });

    it('snapshots the current value when a request is raised, and applies it on approval', async () => {
      const departments = await admin
        .auth(http().get('/departments'))
        .expect(200);
      const target =
        departments.body.data.find(
          (d: { _count: { employees: number } }) => d._count.employees === 0,
        ) ?? departments.body.data[0];

      const originalName = target.name;
      const proposed = `${originalName} (renamed)`;

      const created = await admin
        .auth(http().post('/departments/change-requests'))
        .send({
          departmentId: target.id,
          changeType: 'RENAME',
          newName: proposed,
          reason: 'Exercising the review flow from end to end in a test.',
          effectiveDate: '2030-01-01',
        })
        .expect(201);

      expect(created.body.data.oldName).toBe(originalName);
      const id = created.body.data.id;

      await admin
        .auth(http().patch(`/departments/change-requests/${id}/review`))
        .send({ action: 'APPROVE' })
        .expect(200);

      const after = await admin
        .auth(http().get(`/departments/${target.id}`))
        .expect(200);
      expect(after.body.data.name).toBe(proposed);

      // Reviewing again must be refused, not quietly ignored: a second approval
      // would re-apply a change against values that have already moved.
      await admin
        .auth(http().patch(`/departments/change-requests/${id}/review`))
        .send({ action: 'REJECT' })
        .expect(400);

      await admin
        .auth(http().patch(`/departments/${target.id}`))
        .send({ name: originalName })
        .expect(200);
    });

    it('refuses a RENAME request that carries no new name', () =>
      admin
        .auth(http().post('/departments/change-requests'))
        .send({
          departmentId: '00000000-0000-0000-0000-000000000000',
          changeType: 'RENAME',
          reason: 'A reason long enough to pass validation.',
          effectiveDate: '2030-01-01',
        })
        .expect((res) => {
          expect([400, 404]).toContain(res.status);
        }));
  });

  describe('hub summary', () => {
    it('answers with every governance figure the hub draws', async () => {
      const res = await admin
        .auth(http().get('/organization/hub-summary?months=6'))
        .expect(200);

      const d = res.body.data;
      expect(d.months).toBe(6);
      expect(d.headcount.total).toBe(d.headcount.active + d.headcount.inactive);
      expect(d.growth.buckets).toHaveLength(6);
      expect(d.branches.rows.length).toBeGreaterThan(0);
    });

    it('counts managers as a union, never as a sum of the three roles', async () => {
      const res = await admin
        .auth(http().get('/organization/hub-summary'))
        .expect(200);

      const m = res.body.data.managers;
      // One person can head a department, run a branch and carry direct
      // reports. Summing would report them three times.
      expect(m.total).toBeLessThanOrEqual(
        m.deptHeads + m.branchManagers + m.supervisors,
      );
      expect(m.total).toBeGreaterThanOrEqual(
        Math.max(m.deptHeads, m.branchManagers, m.supervisors),
      );
    });

    it('refuses a window it does not offer instead of silently answering for another', async () => {
      const res = await admin
        .auth(http().get('/organization/hub-summary?months=7'))
        .expect(400);
      expect(res.body.message).toMatch(/6|12/);
    });

    it('is closed to an employee', () =>
      employee.auth(http().get('/organization/hub-summary')).expect(403));
  });
});
