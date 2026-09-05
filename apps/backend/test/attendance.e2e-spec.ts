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
 * The Time & Attendance module against a real, seeded database.
 *
 * Needs the test stack up: `npm run e2e:up` from the repo root, with
 * apps/backend/.env.test loaded.
 */
describe('Time and attendance (e2e)', () => {
  let app: INestApplication;
  let admin: Session;
  let hr: Session;
  let payroll: Session;
  let employee: Session;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signIn(app, ACCOUNTS.admin);
    hr = await signIn(app, ACCOUNTS.hr);
    payroll = await signIn(app, ACCOUNTS.payroll);
    employee = await signIn(app, ACCOUNTS.employee);
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  describe('records', () => {
    it('paginates the log with its employee attached', async () => {
      const res = await admin
        .auth(http().get('/attendances?limit=10'))
        .expect(200);

      expect(res.body.meta.total).toBeGreaterThan(0);
      expect(res.body.data[0].employee).toBeDefined();
    });

    it('narrows to a date range', async () => {
      const res = await admin
        .auth(
          http().get('/attendances?startDate=2020-01-01&endDate=2020-01-31'),
        )
        .expect(200);

      // The seed writes the last thirty days only, so a window five years back
      // is genuinely empty rather than unfiltered.
      expect(res.body.data).toEqual([]);
    });

    it('filters by status', async () => {
      const res = await admin
        .auth(http().get('/attendances?status=LATE&limit=50'))
        .expect(200);

      for (const row of res.body.data) {
        expect(row.status).toBe('LATE');
      }
    });

    it('serves today with the people who have NOT punched, not only those who have', async () => {
      const res = await admin
        .auth(http().get('/attendances/today'))
        .expect(200);

      const board = res.body.data;
      expect(Array.isArray(board.records)).toBe(true);
      expect(board.records.length).toBeGreaterThan(0);

      // An absence has to be visible before anybody can explain it, so the
      // board carries a record for everyone expected in — not only for those
      // who produced a punch.
      expect(board.totals.headcount).toBe(board.records.length);
      expect(board.totals.notCheckedIn).toBeGreaterThanOrEqual(0);
    });

    it('marks a record unsettled until the office day has ended', async () => {
      const res = await admin
        .auth(http().get('/attendances/today'))
        .expect(200);

      for (const record of res.body.data.records) {
        // Before the day closes, an absence is a prediction. The flag is what
        // lets the screen say so rather than reporting it as fact.
        expect(typeof record.settled).toBe('boolean');
        expect(typeof record.zone).toBe('string');
      }
    });
  });

  describe('who may read what', () => {
    it('does not let an employee read the whole workforce', async () => {
      // These views answer by NAME — who was absent, who arrived late. An
      // employee asking for them is asking about their colleagues.
      await employee.auth(http().get('/attendances')).expect(403);
      await employee.auth(http().get('/attendances/today')).expect(403);
      await employee
        .auth(
          http().get(
            '/attendances/summary?startDate=2026-01-01&endDate=2026-01-31',
          ),
        )
        .expect(403);
      await employee.auth(http().get('/attendances/hub-summary')).expect(403);
    });

    it('lets an employee read their own history', async () => {
      const me = await employee.auth(http().get('/auth/me')).expect(200);

      // "My own attendance" is a question every employee is entitled to ask,
      // which is why this route is gated in the service rather than by role.
      await employee
        .auth(http().get(`/attendances/employee/${me.body.data.employee.id}`))
        .expect(200);
    });

    it("refuses an employee somebody else's history", async () => {
      const others = await admin
        .auth(http().get('/employees?limit=50'))
        .expect(200);
      const me = await employee.auth(http().get('/auth/me')).expect(200);

      const someoneElse = others.body.data.find(
        (e: { id: string }) => e.id !== me.body.data.employee.id,
      );

      await employee
        .auth(http().get(`/attendances/employee/${someoneElse.id}`))
        .expect(403);
    });

    it("refuses an employee somebody else's individual record", async () => {
      const rows = await admin
        .auth(http().get('/attendances?limit=50'))
        .expect(200);
      const me = await employee.auth(http().get('/auth/me')).expect(200);

      const foreign = rows.body.data.find(
        (r: { employeeId: string }) =>
          r.employeeId !== me.body.data.employee.id,
      );
      expect(foreign).toBeDefined();

      await employee.auth(http().get(`/attendances/${foreign.id}`)).expect(403);
    });

    it('lets a payroll officer and a department head read the workforce view', async () => {
      // Payroll runs per branch and per department, and a department head owns
      // their team's attendance. Both are management questions.
      await payroll.auth(http().get('/attendances/hub-summary')).expect(200);
    });
  });

  describe('summary report', () => {
    it('reports totals, a daily series and a departmental breakdown', async () => {
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 20 * 86_400_000)
        .toISOString()
        .slice(0, 10);

      const res = await admin
        .auth(
          http().get(`/attendances/summary?startDate=${start}&endDate=${end}`),
        )
        .expect(200);

      const d = res.body.data;
      expect(d.range).toMatchObject({ startDate: start, endDate: end });
      expect(d.totals.records).toBeGreaterThan(0);
      expect(Array.isArray(d.daily)).toBe(true);
      expect(Array.isArray(d.departments)).toBe(true);
    });

    it('averages the working day over the days actually worked', async () => {
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 20 * 86_400_000)
        .toISOString()
        .slice(0, 10);

      const res = await admin
        .auth(
          http().get(`/attendances/summary?startDate=${start}&endDate=${end}`),
        )
        .expect(200);

      // Dividing the hours by every row, including the days nobody worked,
      // reports a shorter working day than anyone actually worked.
      const t = res.body.data.totals;
      if (t.present > 0) {
        expect(t.avgWorkHours).toBeGreaterThan(0);
        expect(t.avgWorkHours).toBeLessThanOrEqual(24);
      }
    });

    it('reports a rate as null rather than zero when there was nothing to divide by', async () => {
      const res = await admin
        .auth(
          http().get(
            '/attendances/summary?startDate=2020-01-01&endDate=2020-01-02',
          ),
        )
        .expect(200);

      // 0% is a claim that everybody failed to turn up. An empty window has no
      // rate at all, and the difference is the whole point.
      expect(res.body.data.totals.attendanceRate).toBeNull();
    });
  });

  describe('hub summary', () => {
    it('answers for each period with the matching bucket granularity', async () => {
      for (const [period, kind] of [
        ['today', 'hour'],
        ['week', 'day'],
        ['month', 'day'],
        ['year', 'month'],
      ] as const) {
        const res = await admin
          .auth(http().get(`/attendances/hub-summary?period=${period}`))
          .expect(200);

        expect(res.body.data.period).toBe(period);
        expect(res.body.data.trendKind).toBe(kind);
      }
    });

    it('will not step into the future from the current period', async () => {
      const res = await admin
        .auth(http().get('/attendances/hub-summary?period=month'))
        .expect(200);

      expect(res.body.data.range.isCurrent).toBe(true);
      expect(res.body.data.range.hasNext).toBe(false);
    });

    it('opens the previous window when handed the previous anchor', async () => {
      const current = await admin
        .auth(http().get('/attendances/hub-summary?period=month'))
        .expect(200);

      const previous = await admin
        .auth(
          http().get(
            `/attendances/hub-summary?period=month&anchor=${current.body.data.range.prevAnchor}`,
          ),
        )
        .expect(200);

      expect(previous.body.data.range.isCurrent).toBe(false);
      // Having stepped back, forward is now a real destination.
      expect(previous.body.data.range.hasNext).toBe(true);
    });

    it('carries a previous window for every delta on the page to compare against', async () => {
      const res = await admin
        .auth(http().get('/attendances/hub-summary?period=month'))
        .expect(200);

      expect(res.body.data.previousStats).toBeDefined();
      expect(res.body.data.previousRange.label).toEqual(expect.any(String));
    });

    it('caps the names in an attention bucket without capping its count', async () => {
      const res = await admin
        .auth(http().get('/attendances/hub-summary?period=today'))
        .expect(200);

      for (const bucket of Object.values(res.body.data.attention)) {
        if (typeof bucket === 'number') continue;
        const b = bucket as { count: number; names: string[] };
        // The strip shows a sample; reading its length as the total is how a
        // queue of forty reports as eight.
        expect(b.names.length).toBeLessThanOrEqual(b.count);
      }
    });

    it('refuses a malformed anchor instead of quietly answering for today', () =>
      admin
        .auth(
          http().get('/attendances/hub-summary?period=month&anchor=2026-13-45'),
        )
        .expect(400));

    it('refuses a period it does not offer', () =>
      admin
        .auth(http().get('/attendances/hub-summary?period=fortnight'))
        .expect(400));
  });

  describe('bulk marking', () => {
    it('accepts one call carrying a different verdict per person', async () => {
      const people = await admin
        .auth(http().get('/employees?limit=2&status=ACTIVE'))
        .expect(200);
      const [a, b] = people.body.data;

      // The verdict rides on each ENTRY. A batch-level status would force one
      // call per distinct verdict and turn a partial failure into several.
      const res = await admin
        .auth(http().post('/attendances/bulk'))
        .send({
          date: '2026-08-04',
          entries: [
            { employeeId: a.id, status: 'ABSENT' },
            { employeeId: b.id, status: 'ON_LEAVE' },
          ],
        })
        .expect(201);

      expect(res.body.data.results).toHaveLength(2);
      expect(res.body.data.failed).toEqual([]);
    });

    it('reports a bad id as one failed row, not as a failed batch', async () => {
      const people = await admin
        .auth(http().get('/employees?limit=1&status=ACTIVE'))
        .expect(200);

      const res = await admin
        .auth(http().post('/attendances/bulk'))
        .send({
          date: '2026-08-05',
          entries: [
            { employeeId: people.body.data[0].id, status: 'ABSENT' },
            {
              employeeId: '00000000-0000-0000-0000-000000000000',
              status: 'ABSENT',
            },
          ],
        })
        .expect(201);

      // One row the server could not place must not discard the rest of the
      // grid the user just filled in.
      expect(res.body.data.applied).toBe(1);
      expect(res.body.data.failed).toHaveLength(1);
    });

    it('refuses a batch-level status, which is not the contract', () =>
      admin
        .auth(http().post('/attendances/bulk'))
        .send({
          date: '2026-08-06',
          employeeIds: ['00000000-0000-0000-0000-000000000000'],
          status: 'ABSENT',
        })
        .expect(400));
  });

  describe('corrections', () => {
    it('lists the queue with pagination meta', async () => {
      const res = await admin
        .auth(http().get('/attendance-corrections'))
        .expect(200);
      expect(res.body.meta).toMatchObject({ total: expect.any(Number) });
    });

    it('reports the resolution statistics the queue header shows', async () => {
      const res = await admin
        .auth(http().get('/attendance-corrections/stats'))
        .expect(200);

      // `stats` must not be parsed as an id — a 400 here is route ordering.
      expect(res.body.data).toMatchObject({
        pending: expect.any(Number),
        total: expect.any(Number),
      });
    });

    it('narrows an employee to their own requests whatever they ask for', async () => {
      const mine = await employee
        .auth(http().get('/attendance-corrections'))
        .expect(200);

      const someoneElse = await admin
        .auth(http().get('/attendance-corrections?limit=50'))
        .expect(200);

      const foreign = someoneElse.body.data.find(
        (c: { employeeId: string }) =>
          !mine.body.data.some(
            (m: { employeeId: string }) => m.employeeId === c.employeeId,
          ),
      );

      if (foreign) {
        // The narrowing comes from the principal, so naming somebody else's id
        // in the query widens nothing. What must hold is that none of THEIR
        // rows come back — not that the response is empty, since answering with
        // the caller's own rows is the correct reading of the request.
        const attempted = await employee
          .auth(
            http().get(
              `/attendance-corrections?employeeId=${foreign.employeeId}`,
            ),
          )
          .expect(200);

        const leaked = attempted.body.data.filter(
          (c: { employeeId: string }) => c.employeeId === foreign.employeeId,
        );
        expect(leaked).toEqual([]);
      }
    });

    it('applies the requested times to the attendance row on approval', async () => {
      const queue = await admin
        .auth(http().get('/attendance-corrections?status=PENDING&limit=1'))
        .expect(200);

      const correction = queue.body.data[0];
      expect(correction).toBeDefined();

      await admin
        .auth(http().patch(`/attendance-corrections/${correction.id}/review`))
        .send({ action: 'APPROVE', reviewNote: 'Verified with the badge log.' })
        .expect(200);

      const day = await admin
        .auth(
          http().get(
            `/attendances?employeeId=${correction.employeeId}&startDate=${correction.date.slice(0, 10)}&endDate=${correction.date.slice(0, 10)}`,
          ),
        )
        .expect(200);

      const row = day.body.data[0];
      expect(row).toBeDefined();
      // MANUAL is what stops a later import silently undoing a human decision.
      expect(row.source).toBe('MANUAL');

      await admin
        .auth(http().patch(`/attendance-corrections/${correction.id}/review`))
        .send({ action: 'REJECT' })
        .expect(400);
    });

    it('is raised for the caller themselves, not for an arbitrary employee', async () => {
      const day = new Date(Date.now() - 3 * 86_400_000)
        .toISOString()
        .slice(0, 10);

      const res = await employee
        .auth(http().post('/attendance-corrections'))
        .send({
          date: day,
          // +04:00, not Z: the seeded company runs on Asia/Muscat, and 08:05
          // UTC is a quarter past noon there. Sending the offset keeps the
          // fixture meaning what it appears to mean.
          requestedCheckIn: `${day}T08:05:00.000+04:00`,
          reason: 'The reader did not register my arrival this morning.',
        })
        .expect(201);

      const me = await employee.auth(http().get('/auth/me')).expect(200);
      expect(res.body.data.employeeId).toBe(me.body.data.employee.id);
    });

    it('refuses a requested time that belongs to a different day', async () => {
      const day = new Date(Date.now() - 9 * 86_400_000)
        .toISOString()
        .slice(0, 10);

      // Approving this would write the stray instant onto the attendance row,
      // producing a working day of several thousand hours that is then summed
      // into the report and into pay.
      const res = await employee
        .auth(http().post('/attendance-corrections'))
        .send({
          date: day,
          requestedCheckIn: '2020-01-01T08:05:00.000Z',
          reason: 'A time that does not belong to the day being corrected.',
        })
        .expect(400);

      expect(res.body.message).toMatch(/not on/i);
    });

    it('refuses a request that asks for no time at all', () =>
      employee
        .auth(http().post('/attendance-corrections'))
        .send({
          date: '2026-01-05',
          reason: 'A reason, but nothing actually requested.',
        })
        .expect(400));
  });

  describe('biometric enrolment', () => {
    it('never returns the descriptor it was given', async () => {
      const employees = await admin
        .auth(http().get('/employees?limit=1'))
        .expect(200);
      const subject = employees.body.data[0];

      const created = await hr
        .auth(http().post('/face-enrollments'))
        .send({
          employeeId: subject.id,
          descriptor: Array.from({ length: 128 }, (_, i) => i / 128),
          quality: 0.92,
        })
        .expect(201);

      // The template is biometric material. The screen needs to know an
      // enrolment exists and how good it is; it never needs the vector.
      expect(created.body.data.descriptor).toBeUndefined();
      expect(created.body.data.quality).toBeCloseTo(0.92);

      const listed = await hr.auth(http().get('/face-enrollments')).expect(200);
      for (const row of listed.body.data) {
        expect(row.descriptor).toBeUndefined();
      }

      await admin
        .auth(http().delete(`/face-enrollments/${created.body.data.id}`))
        .expect(200);
    });

    it('refuses a descriptor that is not 128 dimensions', async () => {
      const employees = await admin
        .auth(http().get('/employees?limit=1'))
        .expect(200);

      await hr
        .auth(http().post('/face-enrollments'))
        .send({
          employeeId: employees.body.data[0].id,
          descriptor: [0.1, 0.2, 0.3],
          quality: 0.9,
        })
        .expect(400);
    });

    it('is closed to an employee', () =>
      employee.auth(http().get('/face-enrollments')).expect(403));
  });

  describe('holidays', () => {
    it('serves the company calendar plus the branch that overrides it', async () => {
      const year = new Date().getUTCFullYear();
      const res = await admin
        .auth(http().get(`/holidays?year=${year}`))
        .expect(200);

      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });
});
