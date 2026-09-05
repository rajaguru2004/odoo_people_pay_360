import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ACCOUNTS, createTestApp, signIn, type Session } from './setup-app';

/**
 * Pay, profile and biometrics against a real, seeded database.
 *
 * Needs the test stack up: `npm run e2e:up` from the repo root, then
 * `npm run test:api`.
 *
 * Two things are being proved here and they are worth naming, because both are
 * the kind of rule a later refactor can quietly relax:
 *
 *   1. A payslip belongs to exactly one person. An employee reads their own and
 *      is refused anybody else's — the check that makes "my pay" a private
 *      question rather than a directory lookup.
 *   2. A face descriptor never crosses the wire. It is biometric material, and
 *      once it has been sent to a browser it has left the building for good.
 *      The assertion is written against the WHOLE response body of every
 *      biometric endpoint rather than against a named field, so a new field
 *      carrying one cannot slip past.
 */
describe('My pay and biometrics (e2e)', () => {
  let app: INestApplication;
  let admin: Session;
  let hr: Session;
  let payroll: Session;
  let employee: Session;

  /** The employee behind `employee@peoplepay360.com`. */
  let selfId: string;
  /** Somebody else entirely. */
  let colleagueId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signIn(app, ACCOUNTS.admin);
    hr = await signIn(app, ACCOUNTS.hr);
    payroll = await signIn(app, ACCOUNTS.payroll);
    employee = await signIn(app, ACCOUNTS.employee);

    const me = await employee.auth(http().get('/auth/me')).expect(200);
    selfId = me.body.data.employeeId ?? me.body.data.employee?.id;

    const others = await admin
      .auth(http().get('/employees?limit=50'))
      .expect(200);
    colleagueId = others.body.data.find(
      (e: { id: string }) => e.id !== selfId,
    ).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  // ── My payslips ───────────────────────────────────────────────────────────

  describe('my payslips', () => {
    it('serves the signed-in employee their own payslips', async () => {
      const res = await employee
        .auth(http().get('/payrolls/my-payslips/list'))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const slip of res.body.data) {
        expect(slip.employeeId).toBe(selfId);
        expect(slip).toMatchObject({
          month: expect.any(Number),
          year: expect.any(Number),
          currency: expect.any(String),
        });
      }
    });

    it('never shows a run that has not been published', async () => {
      const res = await employee
        .auth(http().get('/payrolls/my-payslips/list'))
        .expect(200);

      // The seed leaves the current month as a DRAFT run on purpose: it is a
      // figure the payroll office is still working on, and it would move again.
      const statuses: string[] = res.body.data.map(
        (s: { status: string }) => s.status,
      );
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses).not.toContain('DRAFT');
      expect(statuses).not.toContain('CALCULATED');
      expect(statuses).not.toContain('CANCELLED');
    });

    it('opens one of their own payslips with its breakdown', async () => {
      const list = await employee
        .auth(http().get('/payrolls/my-payslips/list'))
        .expect(200);

      const res = await employee
        .auth(http().get(`/payrolls/my-payslips/${list.body.data[0].id}`))
        .expect(200);

      const slip = res.body.data;
      expect(slip.employee.fullName).toEqual(expect.any(String));
      expect(slip.lines.length).toBeGreaterThan(0);
      expect(slip.lines[0]).toMatchObject({
        label: expect.any(String),
        type: expect.any(String),
      });
      expect(slip.totals).toMatchObject({
        earnings: expect.any(Number),
        deductions: expect.any(Number),
        net: expect.any(Number),
      });
    });

    it("answers 404 for a colleague's payslip id rather than confirming it exists", async () => {
      const { month, year } = lastPaidMonth();
      const theirs = await admin
        .auth(http().get(`/payrolls/payslip/${colleagueId}/${month}/${year}`))
        .expect(200);

      await employee
        .auth(http().get(`/payrolls/my-payslips/${theirs.body.data.id}`))
        .expect(404);
    });

    it('lets an employee read their own payslip for a period', async () => {
      const { month, year } = lastPaidMonth();

      const res = await employee
        .auth(http().get(`/payrolls/payslip/${selfId}/${month}/${year}`))
        .expect(200);

      expect(res.body.data.employeeId).toBe(selfId);
      expect(res.body.data).toMatchObject({ month, year });
    });

    it("refuses an employee reading a colleague's payslip", async () => {
      const { month, year } = lastPaidMonth();

      const res = await employee
        .auth(http().get(`/payrolls/payslip/${colleagueId}/${month}/${year}`))
        .expect(403);

      expect(res.body).toMatchObject({ success: false, statusCode: 403 });
    });

    it.each([
      ['an administrator', () => admin],
      ['an HR manager', () => hr],
      ['a payroll officer', () => payroll],
    ])('lets %s read anybody', async (_label, session) => {
      const { month, year } = lastPaidMonth();

      await session()
        .auth(http().get(`/payrolls/payslip/${colleagueId}/${month}/${year}`))
        .expect(200);
    });

    it('sums year to date from paid runs only', async () => {
      const { year } = lastPaidMonth();

      const res = await employee
        .auth(http().get(`/payrolls/my-ytd-summary?year=${year}`))
        .expect(200);

      expect(res.body.data).toMatchObject({
        year,
        employeeId: selfId,
        totalGross: expect.any(Number),
        totalNet: expect.any(Number),
        monthlyBreakdown: expect.any(Array),
      });
      // Net never exceeds gross. A sign error in the deduction total is the
      // failure this catches, and it is the one nobody notices by reading.
      expect(res.body.data.totalNet).toBeLessThanOrEqual(
        res.body.data.totalGross,
      );
    });

    it('serves the salary structure to its owner and to nobody else', async () => {
      const mine = await employee
        .auth(http().get(`/payrolls/salary-structure/${selfId}`))
        .expect(200);
      expect(mine.body.data.lines.length).toBeGreaterThan(0);

      await employee
        .auth(http().get(`/payrolls/salary-structure/${colleagueId}`))
        .expect(403);
    });
  });

  // ── My profile ────────────────────────────────────────────────────────────

  describe('my profile', () => {
    it('serves an employee their own record with a completion figure', async () => {
      const res = await employee
        .auth(http().get(`/employees/${selfId}/profile`))
        .expect(200);

      expect(res.body.data).toMatchObject({
        id: selfId,
        fullName: expect.any(String),
        profileCompletionPercentage: expect.any(Number),
        missingFields: expect.any(Array),
      });
    });

    it("refuses an employee opening a colleague's profile", async () => {
      await employee
        .auth(http().get(`/employees/${colleagueId}/profile`))
        .expect(403);
    });

    it('lets a person maintain their own contact details', async () => {
      const res = await employee
        .auth(http().patch(`/employees/${selfId}/profile`))
        .send({ phone: '+968 9555 0101', address: 'Al Khuwair, Muscat' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        phone: '+968 9555 0101',
        address: 'Al Khuwair, Muscat',
      });
    });

    it('refuses a field HR owns rather than silently dropping it', async () => {
      // `forbidNonWhitelisted` is what makes this a 400. Without it a rejected
      // field would be quietly ignored and the caller would believe it landed.
      await employee
        .auth(http().patch(`/employees/${selfId}/profile`))
        .send({ position: 'Chief Executive Officer' })
        .expect(400);

      await employee
        .auth(http().patch(`/employees/${selfId}/profile`))
        .send({ nationalId: 'FORGED-0001' })
        .expect(400);
    });

    it("refuses writing to a colleague's profile", async () => {
      await employee
        .auth(http().patch(`/employees/${colleagueId}/profile`))
        .send({ phone: '+968 0000 0000' })
        .expect(403);
    });
  });

  // ── Biometric verification ────────────────────────────────────────────────

  describe('biometric verification', () => {
    /** A probe of the right width. It matches nobody, which is the point. */
    const probe = () => new Array<number>(128).fill(0.5);

    it("tells an employee whether they are enrolled, and nothing about anyone else's", async () => {
      const res = await employee
        .auth(http().get('/face-enrollments/status'))
        .expect(200);

      expect(res.body.data).toMatchObject({
        employeeId: selfId,
        isRegistered: expect.any(Boolean),
        totalRegistered: expect.any(Number),
        threshold: expect.any(Number),
      });
      expect(JSON.stringify(res.body)).not.toContain('descriptor');
    });

    it('verifies a probe and reports the threshold it applied', async () => {
      const res = await employee
        .auth(http().post('/face-enrollments/verify'))
        .send({ descriptor: probe() })
        .expect(201);

      expect(res.body.data).toMatchObject({
        matched: expect.any(Boolean),
        threshold: expect.any(Number),
        candidates: expect.any(Number),
      });
    });

    it('refuses a probe of the wrong width', async () => {
      await employee
        .auth(http().post('/face-enrollments/verify'))
        .send({ descriptor: [0.1, 0.2, 0.3] })
        .expect(400);
    });

    it('refuses a probe carrying something that is not a number', async () => {
      const bad = probe();
      (bad as unknown[])[7] = 'not-a-number';

      await employee
        .auth(http().post('/face-enrollments/verify'))
        .send({ descriptor: bad })
        .expect(400);
    });

    it('never carries a descriptor on ANY biometric response', async () => {
      const bodies = await Promise.all([
        admin.auth(http().get('/face-enrollments')).expect(200),
        employee.auth(http().get('/face-enrollments/status')).expect(200),
        employee
          .auth(http().post('/face-enrollments/verify'))
          .send({ descriptor: probe() })
          .expect(201),
        admin
          .auth(http().get(`/face-enrollments/employee/${selfId}`))
          .expect(200),
      ]);

      for (const res of bodies) {
        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain('descriptor');
        // Belt and braces: a renamed field would slip past the check above, and
        // a 128-float array is unmistakable whatever it is called.
        expect(raw).not.toMatch(/\[(-?\d+\.\d+,){100,}/);
      }
    });
  });

  // ── My attendance ─────────────────────────────────────────────────────────

  describe('my attendance', () => {
    it('lets an employee read their own history', async () => {
      const res = await employee
        .auth(http().get(`/attendances/employee/${selfId}`))
        .expect(200);

      expect(res.body.success).toBe(true);
      // The endpoint answers the whole question the self-service screen asks,
      // so the totals travel with the rows rather than being counted again on
      // the client, where they would disagree with the report screens.
      expect(res.body.data).toMatchObject({
        range: { startDate: expect.any(String), endDate: expect.any(String) },
        summary: { present: expect.any(Number) },
        records: expect.any(Array),
      });
    });

    it("refuses an employee reading a colleague's", async () => {
      await employee
        .auth(http().get(`/attendances/employee/${colleagueId}`))
        .expect(403);
    });
  });
});

/**
 * The month the seed's oldest published run covers.
 *
 * Derived rather than hard-coded: the seed positions its runs relative to today
 * so the demo data never goes stale, which means a fixed month here would start
 * failing on the first of some future month.
 */
function lastPaidMonth(): { month: number; year: number } {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1),
  );
  return { month: start.getUTCMonth() + 1, year: start.getUTCFullYear() };
}
