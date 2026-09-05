import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ACCOUNTS, createTestApp, signIn, type Session } from './setup-app';

/**
 * NOTE ON ISOLATION
 *
 * These specs raise real requests against the e2e database, and a leave request
 * is history the application deliberately does not delete — a cancelled one
 * stays. Re-running accumulates that history, which is correct and harmless,
 * but it means no assertion here may depend on a whole-table count.
 *
 * Start from a clean slate with `npm run e2e:db reset` rather than
 * `npm run e2e:up`, which only re-seeds a database that is already running.
 */

/**
 * Leave, overtime and the approval engine against a real, seeded database.
 *
 * Needs the test stack up: `npm run e2e:up` from the repo root, with
 * apps/backend/.env.test loaded.
 */
describe('Leave, overtime and approvals (e2e)', () => {
  let app: INestApplication;
  let admin: Session;
  let hr: Session;
  let payroll: Session;
  let employee: Session;

  /** The employee account's own record, resolved once from its own profile. */
  let employeeId: string;
  /** Somebody the employee account is definitely not. */
  let otherEmployeeId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signIn(app, ACCOUNTS.admin);
    hr = await signIn(app, ACCOUNTS.hr);
    payroll = await signIn(app, ACCOUNTS.payroll);
    employee = await signIn(app, ACCOUNTS.employee);

    const me = await employee.auth(
      request(app.getHttpServer()).get('/auth/me'),
    );
    employeeId = me.body.data.employeeId as string;

    const list = await admin.auth(
      request(app.getHttpServer()).get('/employees?limit=50'),
    );
    otherEmployeeId = (list.body.data as { id: string }[]).find(
      (row) => row.id !== employeeId,
    )!.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  /** A date far enough ahead to clear every seeded request and the notice rule. */
  const futureDay = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  describe('an employee sees only their own requests', () => {
    it('serves my-requests scoped to the caller, whatever the seed holds', async () => {
      const res = await employee
        .auth(http().get('/leave-requests/my-requests'))
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      for (const row of res.body.data) {
        expect(row.employeeId).toBe(employeeId);
      }
    });

    it('refuses an employee the company-wide list', async () => {
      await employee.auth(http().get('/leave-requests')).expect(403);
    });

    it('refuses an employee a colleague history', async () => {
      await employee
        .auth(http().get(`/leave-requests/employee/${otherEmployeeId}`))
        .expect(403);
    });

    it('refuses an employee a colleague balance', async () => {
      await employee
        .auth(http().get(`/leave-balances/employee/${otherEmployeeId}`))
        .expect(403);
    });

    it('serves an employee their own balance', async () => {
      const res = await employee
        .auth(http().get(`/leave-balances/employee/${employeeId}`))
        .expect(200);

      expect(res.body.data.employeeId).toBe(employeeId);
      // Named rather than inferred from which buckets happen to exist.
      expect(res.body.data).toHaveProperty('gender');
      expect(res.body.data.remainingAnnual).toBe(
        res.body.data.annualLeave +
          res.body.data.carriedOver -
          res.body.data.usedAnnual,
      );
      expect(Array.isArray(res.body.data.leaveTypeBalances)).toBe(true);
    });

    it('refuses an employee the whole balances grid', async () => {
      await employee.auth(http().get('/leave-balances')).expect(403);
    });
  });

  describe('raising a request', () => {
    it('refuses to file against a colleague', async () => {
      await employee
        .auth(http().post('/leave-requests'))
        .send({
          employeeId: otherEmployeeId,
          leaveType: 'Annual Leave',
          startDate: futureDay(120),
          endDate: futureDay(121),
          reason: 'Filed against somebody else',
        })
        .expect(403);
    });

    it('refuses an unlisted field rather than dropping it', async () => {
      // ValidationPipe runs whitelist + forbidNonWhitelisted, so a renamed
      // property fails loudly at the boundary instead of writing a row with the
      // old value missing.
      await employee
        .auth(http().post('/leave-requests'))
        .send({
          leaveType: 'Annual Leave',
          startDate: futureDay(130),
          endDate: futureDay(131),
          reason: 'With a stray field',
          totalDays: 99,
        })
        .expect(400);
    });

    it('refuses an end date before the start', async () => {
      await employee
        .auth(http().post('/leave-requests'))
        .send({
          leaveType: 'Annual Leave',
          startDate: futureDay(140),
          endDate: futureDay(138),
          reason: 'Backwards',
        })
        .expect(400);
    });

    it('charges only the working days in the range and opens a chain', async () => {
      const created = await employee
        .auth(http().post('/leave-requests'))
        .send({
          leaveType: 'Annual Leave',
          startDate: futureDay(150),
          endDate: futureDay(154),
          reason: 'Family visit',
        })
        .expect(201);

      const row = created.body.data;
      expect(row.status).toBe('PENDING');
      expect(row.employeeId).toBe(employeeId);
      // Five calendar days, of which the branch calendar counts fewer.
      expect(row.totalDays).toBeGreaterThan(0);
      expect(row.totalDays).toBeLessThanOrEqual(5);
      // The employee record stores the parts; the API emits the joined name.
      expect(row.employee.fullName).toEqual(expect.any(String));

      const trail = await employee
        .auth(http().get(`/approval-workflows/trail/LEAVE/${row.id}`))
        .expect(200);
      expect(trail.body.data.engaged).toBe(true);
      expect(trail.body.data.steps.length).toBeGreaterThan(0);

      await employee
        .auth(http().delete(`/leave-requests/${row.id}`))
        .expect(200);
    });

    it('refuses a second request overlapping a live one', async () => {
      const first = await employee
        .auth(http().post('/leave-requests'))
        .send({
          leaveType: 'Annual Leave',
          startDate: futureDay(200),
          endDate: futureDay(203),
          reason: 'First',
        })
        .expect(201);

      await employee
        .auth(http().post('/leave-requests'))
        .send({
          leaveType: 'Annual Leave',
          startDate: futureDay(202),
          endDate: futureDay(205),
          reason: 'Overlapping',
        })
        .expect(400);

      await employee
        .auth(http().delete(`/leave-requests/${first.body.data.id}`))
        .expect(200);
    });
  });

  describe('an employee cannot approve their own request', () => {
    let requestId: string;

    beforeAll(async () => {
      const created = await employee
        .auth(http().post('/leave-requests'))
        .send({
          leaveType: 'Annual Leave',
          startDate: futureDay(300),
          endDate: futureDay(302),
          reason: 'Self-approval attempt',
        })
        .expect(201);
      requestId = created.body.data.id;
    });

    afterAll(async () => {
      await admin.auth(http().delete(`/leave-requests/${requestId}`));
    });

    it('refuses the requester their own approval', async () => {
      await employee
        .auth(http().post(`/leave-requests/${requestId}/approve`))
        .send({ comment: 'Approving myself' })
        .expect(403);
    });

    it('refuses the requester their own rejection', async () => {
      await employee
        .auth(http().post(`/leave-requests/${requestId}/reject`))
        .send({ rejectedReason: 'Rejecting myself' })
        .expect(403);
    });

    it('leaves the request pending after both refusals', async () => {
      const res = await employee
        .auth(http().get(`/leave-requests/${requestId}`))
        .expect(200);
      expect(res.body.data.status).toBe('PENDING');
    });

    it('refuses a payroll officer, who is nowhere in the chain', async () => {
      await payroll
        .auth(http().post(`/leave-requests/${requestId}/approve`))
        .send({})
        .expect(403);
    });

    it('lets the employee withdraw it instead', async () => {
      const res = await employee
        .auth(http().delete(`/leave-requests/${requestId}`))
        .expect(200);
      expect(res.body.data.status).toBe('CANCELLED');

      // The live trail is closed with it, so no approver can finalise a
      // request that has been withdrawn.
      const trail = await admin
        .auth(http().get(`/approval-workflows/trail/LEAVE/${requestId}`))
        .expect(200);
      for (const step of trail.body.data.steps) {
        expect(['SKIPPED', 'APPROVED', 'REJECTED']).toContain(step.status);
      }
      expect(trail.body.data.activeStep).toBeNull();
    });

    it('refuses to decide a request that has been withdrawn', async () => {
      await hr
        .auth(http().post(`/leave-requests/${requestId}/approve`))
        .send({})
        .expect(400);
    });
  });

  describe('attachments', () => {
    let requestId: string;

    beforeAll(async () => {
      const created = await employee
        .auth(http().post('/leave-requests'))
        .send({
          leaveType: 'Annual Leave',
          startDate: futureDay(400),
          endDate: futureDay(401),
          reason: 'With a certificate to follow',
        })
        .expect(201);
      requestId = created.body.data.id;
    });

    afterAll(async () => {
      await employee.auth(http().delete(`/leave-requests/${requestId}`));
    });

    it('serves the owner an empty list rather than an error', async () => {
      const res = await employee
        .auth(http().get(`/leave-requests/${requestId}/attachments`))
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('refuses a colleague the list — these are medical certificates', async () => {
      await payroll
        .auth(http().get(`/leave-requests/${requestId}/attachments`))
        .expect(403);
    });

    it('refuses an upload with no file', async () => {
      await employee
        .auth(http().post(`/leave-requests/${requestId}/attachments`))
        .expect(400);
    });
  });

  describe('leave accrual', () => {
    it('refuses an employee the accrual history', async () => {
      await employee.auth(http().get('/leave-balances/accrual/history')).expect(403);
    });

    it('serves HR the seeded periods with their fractional days', async () => {
      const res = await hr
        .auth(http().get('/leave-balances/accrual/history?year=2026'))
        .expect(200);

      expect(res.body.data.length).toBeGreaterThan(0);
      for (const row of res.body.data) {
        expect(typeof row.days).toBe('number');
        expect(row.periodStart).toMatch(/^\d{4}-\d{2}-01/);
        expect(row.employee.fullName).toEqual(expect.any(String));
      }
    });

    it('refuses a month filter with no year beside it', async () => {
      await hr
        .auth(http().get('/leave-balances/accrual/history?month=3'))
        .expect(400);
    });

    it('credits nothing on a second run in the same period', async () => {
      const first = await hr
        .auth(http().post('/leave-balances/accrual/run'))
        .send({})
        .expect(201);

      const second = await hr
        .auth(http().post('/leave-balances/accrual/run'))
        .send({})
        .expect(201);

      // The unique index on (employee, period, leave type) is the guard, so the
      // second pass reports every employee as already credited and writes
      // nothing — which is what makes the cron safe to fire every hour.
      expect(second.body.data.credited).toBe(0);
      expect(second.body.data.alreadyCredited).toBe(
        first.body.data.credited + first.body.data.alreadyCredited,
      );
      expect(second.body.data.periodStart).toMatch(/^\d{4}-\d{2}-01$/);
    });

    it('leaves the balance unchanged across that second run', async () => {
      const before = await employee
        .auth(http().get(`/leave-balances/employee/${employeeId}`))
        .expect(200);

      await hr.auth(http().post('/leave-balances/accrual/run')).send({}).expect(201);

      const after = await employee
        .auth(http().get(`/leave-balances/employee/${employeeId}`))
        .expect(200);

      expect(after.body.data.annualLeave).toBe(before.body.data.annualLeave);
    });
  });

  describe('the approval inbox', () => {
    it('tells an employee whether they are an approver at all', async () => {
      const res = await employee
        .auth(http().get('/approval-workflows/can-approve'))
        .expect(200);

      expect(res.body.data).toEqual({
        isApprover: expect.any(Boolean),
        pending: expect.any(Number),
      });
    });

    it('hydrates each inbox card with its request and employee', async () => {
      const res = await hr
        .auth(http().get('/approval-workflows/inbox'))
        .expect(200);

      for (const item of res.body.data) {
        expect(['LEAVE', 'OVERTIME', 'TRAINING']).toContain(item.requestType);
        expect(item.request).toBeDefined();
        expect(item.request.employee.fullName).toEqual(expect.any(String));
      }
    });

    it('serves the decided history keyed on who decided it', async () => {
      const res = await hr
        .auth(http().get('/approval-workflows/history?limit=10'))
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      for (const item of res.body.data) {
        expect(['APPROVED', 'REJECTED']).toContain(item.decision);
      }
    });

    it('refuses an employee the chain configuration', async () => {
      await employee.auth(http().get('/approval-workflows')).expect(403);
      await employee.auth(http().get('/approval-workflows/kinds')).expect(403);
    });

    it('rejects an unknown request type on the trail route', async () => {
      await hr
        .auth(
          http().get(
            '/approval-workflows/trail/NONSENSE/00000000-0000-0000-0000-000000000000',
          ),
        )
        .expect(400);
    });
  });

  describe('overtime', () => {
    it('serves an employee only their own overtime', async () => {
      const res = await employee
        .auth(http().get('/overtime/my-requests'))
        .expect(200);

      const rows = (res.body.data?.data ?? res.body.data) as {
        employeeId: string;
      }[];
      for (const row of rows) {
        expect(row.employeeId).toBe(employeeId);
      }
    });

    it('refuses an employee the company-wide overtime list', async () => {
      await employee.auth(http().get('/overtime')).expect(403);
    });
  });

  describe('leave types and the HR views', () => {
    it('offers the active leave types to anybody who can file', async () => {
      const res = await employee
        .auth(http().get('/leave-balances/leave-types'))
        .expect(200);

      const labels = (res.body.data as { label: string }[]).map((t) => t.label);
      expect(labels).toContain('Annual Leave');
      expect(labels).toContain('Sick Leave');
    });

    it('pages the company-wide list for HR', async () => {
      const res = await hr
        .auth(http().get('/leave-requests?limit=5'))
        .expect(200);

      expect(res.body.meta).toMatchObject({
        page: 1,
        limit: 5,
        total: expect.any(Number),
      });
      expect(res.body.data.length).toBeLessThanOrEqual(5);
    });

    it('filters the company-wide list by status', async () => {
      const res = await hr
        .auth(http().get('/leave-requests?status=APPROVED&limit=50'))
        .expect(200);

      for (const row of res.body.data) {
        expect(row.status).toBe('APPROVED');
      }
    });

    it('serves the company overview with its per-type totals', async () => {
      const res = await hr
        .auth(http().get('/leave-balances/company-overview'))
        .expect(200);

      expect(res.body.data.requestStats).toMatchObject({
        pending: expect.any(Number),
        approved: expect.any(Number),
        rejected: expect.any(Number),
        total: expect.any(Number),
      });
      for (const type of res.body.data.leaveTypes) {
        expect(type.totalRemaining).toBe(
          type.totalAllocated + type.totalCarriedOver - type.totalUsed,
        );
      }
    });
  });
});
