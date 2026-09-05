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
 * The People module against a real, seeded database.
 *
 * Needs the test stack up: `npm run e2e:up` from the repo root, with
 * apps/backend/.env.test loaded.
 */
describe('People (e2e)', () => {
  let app: INestApplication;
  let admin: Session;
  let hr: Session;
  let employee: Session;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signIn(app, ACCOUNTS.admin);
    hr = await signIn(app, ACCOUNTS.hr);
    employee = await signIn(app, ACCOUNTS.employee);
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  describe('employee directory', () => {
    it('paginates rather than returning the whole table', async () => {
      const res = await admin
        .auth(http().get('/employees?limit=5'))
        .expect(200);

      expect(res.body.data).toHaveLength(5);
      expect(res.body.meta).toMatchObject({
        limit: 5,
        total: expect.any(Number),
        totalPages: expect.any(Number),
      });
    });

    it('clamps an absurd page size instead of honouring it', async () => {
      const res = await admin
        .auth(http().get('/employees?limit=100000'))
        .expect(200);
      expect(res.body.meta.limit).toBeLessThanOrEqual(200);
    });

    it('searches across code, name and work email', async () => {
      const res = await admin
        .auth(http().get('/employees?search=Aisha'))
        .expect(200);

      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].firstName).toBe('Aisha');
    });

    it('returns an empty page, not an error, for a search that matches nothing', async () => {
      const res = await admin
        .auth(http().get('/employees?search=zzz-no-such-person'))
        .expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });

    it('refuses a reporting line that closes a cycle', async () => {
      const list = await admin
        .auth(http().get('/employees?limit=50'))
        .expect(200);

      const withManager = list.body.data.find(
        (e: { manager: unknown }) => e.manager,
      );
      expect(withManager).toBeDefined();

      // Making somebody their own manager's manager is the cycle every
      // org-chart and approval-chain walk cannot survive.
      const res = await admin
        .auth(http().patch(`/employees/${withManager.manager.id}`))
        .send({ managerId: withManager.id })
        .expect(400);
      expect(res.body.message).toMatch(/report/i);
    });

    it('refuses an employee reporting to themselves', async () => {
      const list = await admin
        .auth(http().get('/employees?limit=1'))
        .expect(200);
      const one = list.body.data[0];

      await admin
        .auth(http().patch(`/employees/${one.id}`))
        .send({ managerId: one.id })
        .expect(400);
    });
  });

  describe('teams', () => {
    it('lists the seeded teams with their roster counts', async () => {
      const res = await admin.auth(http().get('/teams')).expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]._count.members).toBeGreaterThan(0);
    });

    it('reactivates an existing member instead of duplicating them', async () => {
      const teams = await admin.auth(http().get('/teams')).expect(200);
      const team = teams.body.data[0];

      const before = await admin
        .auth(http().get(`/teams/${team.id}`))
        .expect(200);
      const existing = before.body.data.members[0];
      const countBefore = before.body.data.members.length;

      await admin
        .auth(http().post(`/teams/${team.id}/members`))
        .send({ employeeId: existing.employeeId })
        .expect((res) => {
          expect([200, 201]).toContain(res.status);
        });

      const after = await admin
        .auth(http().get(`/teams/${team.id}`))
        .expect(200);

      // A duplicate row would double-count this person in every roster figure
      // the module reports.
      expect(after.body.data.members).toHaveLength(countBefore);
    });

    it('refuses a duplicate team code', async () => {
      const teams = await admin.auth(http().get('/teams')).expect(200);
      const existing = teams.body.data[0];

      await admin
        .auth(http().post('/teams'))
        .send({
          code: existing.code,
          name: 'Clashing team',
          departmentId: existing.departmentId,
        })
        .expect(409);
    });
  });

  describe('contracts', () => {
    it('lists contracts with their employee attached', async () => {
      const res = await admin
        .auth(http().get('/contracts?limit=5'))
        .expect(200);
      expect(res.body.meta.total).toBeGreaterThan(0);
      expect(res.body.data[0].employee).toBeDefined();
    });

    it('reports the expiry runway with a signed day count', async () => {
      const res = await admin
        .auth(http().get('/contracts/expiring?days=365'))
        .expect(200);

      // `expiring` must not be parsed as an id — a 400 here is the route
      // ordering having regressed.
      expect(Array.isArray(res.body.data)).toBe(true);
      for (const row of res.body.data) {
        expect(typeof row.daysUntilExpiry).toBe('number');
      }
    });

    it('refuses a term that ends before it starts', async () => {
      const employees = await admin
        .auth(http().get('/employees?limit=1'))
        .expect(200);

      await admin
        .auth(http().post('/contracts'))
        .send({
          employeeId: employees.body.data[0].id,
          contractType: 'FIXED_TERM',
          startDate: '2027-06-01',
          endDate: '2027-01-01',
          salary: 1000,
        })
        .expect(400);
    });

    it('is closed to an employee for writes', async () => {
      const employees = await admin
        .auth(http().get('/employees?limit=1'))
        .expect(200);

      await employee
        .auth(http().post('/contracts'))
        .send({
          employeeId: employees.body.data[0].id,
          contractType: 'PERMANENT',
          startDate: '2027-01-01',
          salary: 1000,
        })
        .expect(403);
    });
  });

  describe('terminations', () => {
    it('lists the queue with pagination meta', async () => {
      const res = await admin
        .auth(http().get('/contracts/terminations'))
        .expect(200);
      expect(res.body.meta).toMatchObject({ total: expect.any(Number) });
    });

    it('does not touch the employee record while the request is only pending', async () => {
      const contracts = await admin
        .auth(http().get('/contracts?status=ACTIVE&limit=50'))
        .expect(200);

      const contract = contracts.body.data.find(
        (c: { employee?: { status: string } }) =>
          c.employee?.status === 'ACTIVE',
      );
      expect(contract).toBeDefined();

      const created = await admin
        .auth(http().post('/contracts/terminations'))
        .send({
          contractId: contract.id,
          category: 'RESIGNATION',
          noticeDate: '2030-01-01',
          terminationDate: '2030-02-01',
          reason: 'Exercising the termination flow from end to end in a test.',
        })
        .expect(201);

      // Employment ends on APPROVAL and at no other moment. A pending request
      // that already flipped the employee would strand somebody as terminated
      // if it were later rejected.
      const after = await admin
        .auth(http().get(`/employees/${contract.employeeId}`))
        .expect(200);
      expect(after.body.data.status).toBe('ACTIVE');

      await admin
        .auth(
          http().patch(
            `/contracts/terminations/${created.body.data.id}/review`,
          ),
        )
        .send({ action: 'REJECT', reviewNote: 'Reverting the test fixture.' })
        .expect(200);
    });

    it('refuses a second pending request for the same contract', async () => {
      const contracts = await admin
        .auth(http().get('/contracts?status=ACTIVE&limit=1'))
        .expect(200);
      const contract = contracts.body.data[0];

      const payload = {
        contractId: contract.id,
        category: 'RESIGNATION' as const,
        noticeDate: '2030-03-01',
        terminationDate: '2030-04-01',
        reason:
          'First request, raised so the second one has something to clash with.',
      };

      const first = await admin
        .auth(http().post('/contracts/terminations'))
        .send(payload)
        .expect(201);

      await admin
        .auth(http().post('/contracts/terminations'))
        .send(payload)
        .expect(409);

      await admin
        .auth(
          http().patch(`/contracts/terminations/${first.body.data.id}/review`),
        )
        .send({ action: 'REJECT', reviewNote: 'Reverting the test fixture.' })
        .expect(200);
    });
  });

  describe('work permits', () => {
    it('summarises the permit population with the alert window it used', async () => {
      const res = await hr
        .auth(http().get('/legal-documents/summary'))
        .expect(200);

      expect(res.body.data).toMatchObject({
        active: expect.any(Number),
        expiringSoon: expect.any(Number),
        alertDays: expect.any(Number),
      });
    });

    it('derives the expiry countdown rather than storing it', async () => {
      const res = await hr
        .auth(http().get('/legal-documents?limit=50'))
        .expect(200);

      for (const row of res.body.data) {
        expect(typeof row.daysUntilExpiry).toBe('number');
        expect(typeof row.isExpiringSoon).toBe('boolean');
      }
    });

    it('renews into a chain instead of overwriting the lapsed record', async () => {
      const list = await hr
        .auth(http().get('/legal-documents?limit=1'))
        .expect(200);
      const original = list.body.data[0];
      expect(original).toBeDefined();

      const renewed = await hr
        .auth(http().post(`/legal-documents/${original.id}/renew`))
        .send({
          documentNumber: `${original.documentNumber}-R`,
          issueDate: '2030-01-01',
          expiryDate: '2032-01-01',
        })
        .expect(201);

      expect(renewed.body.data.renewedFromId).toBe(original.id);
      expect(renewed.body.data.isCurrent).toBe(true);

      // The superseded record survives as history — an auditor asks when a
      // permit actually lapsed, about a date already in the past.
      const previous = await hr
        .auth(http().get(`/legal-documents/${original.id}`))
        .expect(200);
      expect(previous.body.data.status).toBe('RENEWED');
      expect(previous.body.data.isCurrent).toBe(false);
    });
  });

  describe('hub summary', () => {
    it('answers with every lifecycle figure the hub draws', async () => {
      const res = await admin
        .auth(http().get('/employees/hub-summary?months=6'))
        .expect(200);

      const d = res.body.data;
      expect(d.months).toBe(6);
      expect(d.trend.buckets).toHaveLength(6);
      expect(Array.isArray(d.statusSplit)).toBe(true);
      expect(Array.isArray(d.contracts.expiring)).toBe(true);
    });

    it('splits status into buckets that sum to the workforce', async () => {
      const res = await admin
        .auth(http().get('/employees/hub-summary'))
        .expect(200);

      const d = res.body.data;
      const split = d.statusSplit.reduce(
        (sum: number, s: { count: number }) => sum + s.count,
        0,
      );
      expect(split).toBe(d.headcount.active + d.headcount.inactive);
    });

    it('refuses a window it does not offer', () =>
      admin.auth(http().get('/employees/hub-summary?months=9')).expect(400));

    it('is closed to an employee', () =>
      employee.auth(http().get('/employees/hub-summary')).expect(403));
  });
});
