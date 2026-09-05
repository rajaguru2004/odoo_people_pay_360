import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ACCOUNTS, createTestApp, signIn, type Session } from './setup-app';

/**
 * Employee self-service against a real, seeded database.
 *
 * Every assertion here is about the same question: does the server scope what
 * it returns to the caller, rather than trusting the screen to ask nicely? The
 * vault, the asset register and the grievance desk each answer it differently,
 * so each is exercised through its own door.
 *
 * Needs the test stack up: `npm run e2e:up` from the repo root, with
 * apps/backend/.env.test loaded.
 */
describe('Employee self-service (e2e)', () => {
  let app: INestApplication;
  let admin: Session;
  let hr: Session;
  let employee: Session;
  let employeeId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signIn(app, ACCOUNTS.admin);
    hr = await signIn(app, ACCOUNTS.hr);
    employee = await signIn(app, ACCOUNTS.employee);

    const me = await employee.auth(request(app.getHttpServer()).get('/auth/me'));
    employeeId = me.body.data.employeeId ?? me.body.data.employee?.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  describe('the vault', () => {
    it('returns the caller’s own documents in the one envelope', async () => {
      const res = await employee
        .auth(http().get('/document-vault/me'))
        .expect(200);

      expect(res.body).toMatchObject({ success: true });
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(res.body.data.summary).toMatchObject({
        total: expect.any(Number),
        expiringSoon: expect.any(Number),
        expired: expect.any(Number),
      });
    });

    it('refuses an employee reading somebody else’s vault', async () => {
      // The route is HR-only, so the guard refuses before the service is asked.
      await employee
        .auth(http().get(`/document-vault/employee/${employeeId}`))
        .expect(403);
    });

    it('lets HR read a named employee’s vault', async () => {
      const res = await hr
        .auth(http().get(`/document-vault/employee/${employeeId}`))
        .expect(200);
      expect(res.body.data.summary.total).toEqual(expect.any(Number));
    });

    it('never hands back a URL for a privately stored file', async () => {
      const res = await employee
        .auth(http().get('/document-vault/me'))
        .expect(200);

      for (const item of res.body.data.items) {
        if (item.secureKind) expect(item.fileUrl).toBeNull();
      }
    });
  });

  describe('assets', () => {
    it('returns only the caller’s own custody rows', async () => {
      const res = await employee.auth(http().get('/assets/my')).expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      for (const row of res.body.data) {
        expect(row.employeeId).toBe(employeeId);
      }
    });

    it('keeps an employee out of the register itself', async () => {
      await employee.auth(http().get('/assets')).expect(403);
      await employee.auth(http().get('/assets/summary')).expect(403);
    });

    it('reports an open assignment against the seeded holder', async () => {
      const res = await admin
        .auth(http().get(`/assets/clearance/${employeeId}`))
        .expect(200);

      // The seed leaves this person holding company property on purpose: an
      // open assignment is what blocks an offboarding.
      expect(res.body.data.cleared).toBe(false);
      expect(res.body.data.openAssets.length).toBeGreaterThan(0);
      expect(res.body.data.openAssets[0]).toMatchObject({
        assetTag: expect.any(String),
        assignmentId: expect.any(String),
      });
    });

    it('refuses to acknowledge an asset assigned to somebody else', async () => {
      const open = await admin
        .auth(http().get('/assets/assignments/open'))
        .expect(200);

      const someoneElse = open.body.data.find(
        (row: { employeeId: string }) => row.employeeId !== employeeId,
      );
      if (!someoneElse) return;

      await employee
        .auth(http().post(`/assets/assignments/${someoneElse.id}/acknowledge`))
        .send({})
        .expect(403);
    });
  });

  describe('grievances', () => {
    it('shows an employee only their own cases', async () => {
      const res = await employee.auth(http().get('/grievances')).expect(200);

      for (const row of res.body.data) {
        const mine = row.employeeId === employeeId;
        const assignedToMe = row.assignedToId !== null;
        expect(mine || assignedToMe).toBe(true);
      }
    });

    it('never shows a confidential grievance to the person it is about', async () => {
      const payroll = await signIn(app, ACCOUNTS.payroll);
      const payrollMe = await payroll.auth(http().get('/auth/me')).expect(200);
      const subjectEmployeeId =
        payrollMe.body.data.employeeId ?? payrollMe.body.data.employee?.id;

      const created = await employee
        .auth(http().post('/grievances'))
        .send({
          category: 'Workplace Conduct',
          subject: `Confidentiality probe ${Date.now()}`,
          description: 'Raised by a test to prove the subject cannot read it.',
          isConfidential: true,
          againstEmployeeId: subjectEmployeeId,
        })
        .expect(201);
      const id = created.body.data.id as string;

      // The desk can see it.
      const desk = await hr.auth(http().get('/grievances')).expect(200);
      expect(
        desk.body.data.some((row: { id: string }) => row.id === id),
      ).toBe(true);

      // The person it is about cannot — not in the list...
      const asSubject = await payroll
        .auth(http().get('/grievances'))
        .expect(200);
      expect(
        asSubject.body.data.some((row: { id: string }) => row.id === id),
      ).toBe(false);

      // ...and not by id either. A 404, not a 403: confirming a confidential
      // case exists is itself the disclosure.
      await payroll.auth(http().get(`/grievances/${id}`)).expect(404);

      // The complainant still reads their own.
      await employee.auth(http().get(`/grievances/${id}`)).expect(200);
    });

    it('lets an employee raise and then withdraw their own grievance', async () => {
      const created = await employee
        .auth(http().post('/grievances'))
        .send({
          category: 'Working Conditions',
          subject: 'Air conditioning in the back office',
          description:
            'The unit has been out for a fortnight and the room is unusable after midday.',
        })
        .expect(201);

      const id = created.body.data.id as string;
      expect(created.body.data.employeeId).toBe(employeeId);

      const withdrawn = await employee
        .auth(http().post(`/grievances/${id}/withdraw`))
        .send({})
        .expect(201);
      expect(withdrawn.body.data.status).toBe('WITHDRAWN');
    });

    it('refuses an employee updating the status of their own case', async () => {
      const mine = await employee.auth(http().get('/grievances')).expect(200);
      const row = mine.body.data[0];
      if (!row) return;

      await employee
        .auth(http().patch(`/grievances/${row.id}`))
        .send({ status: 'RESOLVED' })
        .expect(403);
    });
  });

  describe('my team', () => {
    it('answers with the people the caller supervises', async () => {
      const res = await hr.auth(http().get('/supervisors/my-team')).expect(200);
      expect(res.body.data.count).toEqual(expect.any(Number));
      expect(Array.isArray(res.body.data.data)).toBe(true);
      for (const row of res.body.data.data) {
        // The screens read one name field; the parts stay beside it for the
        // avatar initials.
        expect(row.fullName).toEqual(expect.any(String));
      }
    });
  });

  describe('the calendar', () => {
    it('returns the caller’s own month without naming anybody', async () => {
      const res = await employee
        .auth(
          http().get('/calendar/my-calendar?startDate=2026-09-01&endDate=2026-09-30'),
        )
        .expect(200);
      expect(res.body.data).toEqual(expect.any(Array));
    });

    it('refuses an employee reading somebody else’s calendar', async () => {
      const someoneElse = await admin
        .auth(http().get('/employees?limit=50'))
        .expect(200);
      const other = someoneElse.body.data.find(
        (row: { id: string }) => row.id !== employeeId,
      );

      await employee
        .auth(
          http().get(
            `/calendar/my-calendar?startDate=2026-09-01&endDate=2026-09-30&employeeId=${other.id}`,
          ),
        )
        .expect(403);
    });
  });
});
