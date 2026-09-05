import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ACCOUNTS, createTestApp, signIn, type Session } from './setup-app';

/**
 * The main dashboard aggregate against a real, seeded database.
 *
 * `dashboard.util.spec.ts` already proves the entitlement TABLE and the
 * arithmetic built on top of it. Nothing here repeats that. What this file
 * holds is the HTTP surface those pure functions are wired to: that the route
 * opens for everybody, that the JSON the wire actually carries matches the
 * table, and that a section a caller may not see is MISSING from the payload
 * rather than present and empty.
 *
 * Needs the test stack up: `npm run e2e:up` from the repo root, with
 * apps/backend/.env.test loaded.
 */

/** Every section the aggregate can emit. */
const ALL_SECTIONS = [
  'workforce',
  'attendance',
  'payroll',
  'approvals',
  'compliance',
] as const;

/**
 * What each role is entitled to — restated as literals on purpose.
 *
 * Importing `SECTIONS_BY_ROLE` here would make the spec agree with the service
 * by construction: a typo that dropped `compliance` from the HR row would edit
 * the expectation and the behaviour in one move, and nothing would go red.
 */
const EXPECTED_SECTIONS: Record<string, string[]> = {
  ADMIN: ['workforce', 'attendance', 'payroll', 'approvals', 'compliance'],
  HR_MANAGER: ['workforce', 'attendance', 'payroll', 'approvals', 'compliance'],
  PAYROLL_OFFICER: ['workforce', 'attendance', 'payroll', 'approvals'],
  MANAGER: ['workforce', 'attendance', 'approvals'],
  EMPLOYEE: [],
};

/** The keys the payload carries for EVERY caller, whatever their role. */
const ALWAYS_PRESENT = [
  'sections',
  'viewer',
  'today',
  'periodLabel',
  'currency',
  'me',
];

/**
 * The seed ships no MANAGER account, and the manager row of the entitlement
 * table is the one that differs from every other role, so the spec makes its
 * own account and puts it back on the way out.
 */
const MANAGER_EMAIL = 'manager.dashboard.e2e@peoplepay360.com';
const PASSWORD = 'Admin@123';

describe('Dashboard overview (e2e)', () => {
  let app: INestApplication;
  let admin: Session;
  let hr: Session;
  let payroll: Session;
  let manager: Session;
  let employee: Session;
  let managerUserId: string;

  /** Role to the session that speaks for it, so the tests read as the table. */
  let byRole: Record<string, Session>;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signIn(app, ACCOUNTS.admin);
    hr = await signIn(app, ACCOUNTS.hr);
    payroll = await signIn(app, ACCOUNTS.payroll);
    employee = await signIn(app, ACCOUNTS.employee);

    // Idempotent: a re-run finds the account the last one left behind, so 409
    // is the expected answer on every run but the first.
    await admin
      .auth(http().post('/auth/register'))
      .send({ email: MANAGER_EMAIL, password: PASSWORD, role: 'MANAGER' })
      .expect((res) => {
        expect([201, 409]).toContain(res.status);
      });

    const found = await admin
      .auth(http().get(`/users?search=${encodeURIComponent(MANAGER_EMAIL)}`))
      .expect(200);
    const row = found.body.data.find(
      (u: { email: string }) => u.email === MANAGER_EMAIL,
    );
    expect(row).toBeDefined();
    managerUserId = row.id;

    // The previous run deactivated it on the way out, and a soft-deleted
    // account cannot log in — so the role and the flag are re-asserted here
    // rather than assumed from the register call above.
    await admin
      .auth(http().patch(`/users/${managerUserId}`))
      .send({ role: 'MANAGER', isActive: true })
      .expect(200);

    manager = await signIn(app, MANAGER_EMAIL, PASSWORD);

    byRole = {
      ADMIN: admin,
      HR_MANAGER: hr,
      PAYROLL_OFFICER: payroll,
      MANAGER: manager,
      EMPLOYEE: employee,
    };
  });

  afterAll(async () => {
    if (managerUserId) {
      await admin.auth(http().delete(`/users/${managerUserId}`));
    }
    await app?.close();
  });

  describe('who may open it', () => {
    it('opens for all five roles, because the landing page belongs to everybody', async () => {
      for (const [role, session] of Object.entries(byRole)) {
        const res = await session.auth(http().get('/dashboard/overview'));
        // A 403 here is somebody having "tightened" the controller's @Roles.
        // Narrowing is the service's job; refusing the route refuses the whole
        // landing page to the people it was built for. The role rides in the
        // assertion so a failure names which one lost access.
        expect([role, res.status]).toEqual([role, 200]);
      }
    });

    it('refuses a caller carrying no token at all', async () => {
      const res = await http().get('/dashboard/overview').expect(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe('the entitlement boundary', () => {
    it('lists exactly the sections that role’s row of the table names', async () => {
      for (const [role, session] of Object.entries(byRole)) {
        const res = await session
          .auth(http().get('/dashboard/overview'))
          .expect(200);

        // Sorted: `sections` is a set, and reordering the resolver is not a
        // change in what the caller may see.
        expect([role, [...res.body.data.sections].sort()]).toEqual([
          role,
          [...EXPECTED_SECTIONS[role]].sort(),
        ]);
      }
    });

    it('omits a forbidden section entirely rather than sending it as zeroes', async () => {
      for (const [role, session] of Object.entries(byRole)) {
        const res = await session
          .auth(http().get('/dashboard/overview'))
          .expect(200);
        const body = res.body.data;
        const allowed = EXPECTED_SECTIONS[role];

        for (const section of ALL_SECTIONS) {
          if (allowed.includes(section)) {
            expect(body).toHaveProperty(section);
          } else {
            // THE assertion of this file, and the reason it is a key check
            // rather than a truthy one: `payroll: null` and no `payroll` key
            // are indistinguishable to `expect(body.payroll).toBeFalsy()`, and
            // only one of them is the contract. A payroll block of zeroes sent
            // to an employee tells them the company paid nobody this month.
            expect(body).not.toHaveProperty(section);
          }
        }
      }
    });

    it('answers about the caller for every role, and for an employee about nothing else', async () => {
      for (const [role, session] of Object.entries(byRole)) {
        const res = await session
          .auth(http().get('/dashboard/overview'))
          .expect(200);

        // `me` is in no row of the table: it answers about the caller and
        // nobody else, so it is never gated. An employee whose dashboard lost
        // `me` would open a page with nothing on it at all.
        //
        // Checked by KEYS, not by values: an unlinked login (the seeded admin
        // is one) legitimately answers `null` for every field, so a truthy
        // assertion here would pass just as happily on a missing block.
        expect([role, Object.keys(res.body.data.me ?? {}).sort()]).toEqual([
          role,
          [
            'employeeId',
            'latestPayslip',
            'leaveBalanceDays',
            'pendingOwnRequests',
            'todayStatus',
          ],
        ]);
      }

      const asEmployee = await employee
        .auth(http().get('/dashboard/overview'))
        .expect(200);

      // The whole of an employee's payload: the frame, and their own corner.
      // Any extra key here is a workforce-wide figure that has leaked to the
      // one reader entitled to none of them.
      expect(Object.keys(asEmployee.body.data).sort()).toEqual(
        [...ALWAYS_PRESENT].sort(),
      );
      expect(asEmployee.body.data.sections).toEqual([]);
    });
  });

  describe('the trend window', () => {
    it('answers for the two windows it offers, and for no query at all', async () => {
      await admin.auth(http().get('/dashboard/overview?months=6')).expect(200);
      await admin.auth(http().get('/dashboard/overview?months=12')).expect(200);
      await admin.auth(http().get('/dashboard/overview')).expect(200);
    });

    it('refuses a window it does not offer instead of quietly answering for another', async () => {
      for (const months of ['7', '0', 'abc']) {
        const res = await admin
          .auth(http().get(`/dashboard/overview?months=${months}`))
          .expect(400);

        // A page that silently answered for twelve months when it was asked
        // for seven has no way to tell the reader that it did, and the reader
        // has no way to find out.
        expect([months, JSON.stringify(res.body.message)]).toEqual([
          months,
          expect.stringMatching(/months must be 6 or 12/i),
        ]);
      }
    });
  });

  describe('the payload', () => {
    it('rides the one success envelope like every other endpoint', async () => {
      const res = await admin
        .auth(http().get('/dashboard/overview'))
        .expect(200);

      // Hand-rolling a different shape in this controller would break every
      // caller that reads `.data.data`.
      expect(res.body).toMatchObject({ success: true });
      expect(res.body.data).toEqual(expect.any(Object));
      expect(res.body.data.viewer).toMatchObject({ role: 'ADMIN' });
      // The server owns the label, so the browser does no calendar maths.
      expect(res.body.data.periodLabel).toEqual(expect.any(String));
      expect(res.body.data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(res.body.data.currency).toEqual(expect.any(String));
    });

    it('reports a null attendance rate, never a zero, when nobody was expected', async () => {
      const res = await admin
        .auth(http().get('/dashboard/overview'))
        .expect(200);
      const attendance = res.body.data.attendance;

      // Asserted as the invariant rather than by seeding a closed day: whether
      // today is a working day depends on the branch calendar, and a spec that
      // arranged an empty one would be testing its own fixture. A card printing
      // 0.0% for a day nobody was rostered has told the reader the workforce
      // failed to turn up, which is a different claim from "nobody was due in".
      expect(attendance.expected).toEqual(expect.any(Number));
      if (attendance.expected === 0) {
        expect(attendance.attendanceRate).toBeNull();
      } else {
        expect(attendance.attendanceRate).toEqual(expect.any(Number));
      }
    });

    it('names the window its expiry groups were gathered over', async () => {
      const res = await admin
        .auth(http().get('/dashboard/overview'))
        .expect(200);
      const compliance = res.body.data.compliance;

      // `horizonDays` is a configured setting, not a constant, so the reader
      // cannot infer it and the panel writes it into its own sentence —
      // "within 60 days". Shipped without it, the block still looks complete
      // while calling everything in it "expiring soon" against no period at
      // all, and the panel prints `within undefined days`.
      expect(compliance.horizonDays).toEqual(expect.any(Number));
      expect(compliance.horizonDays).toBeGreaterThan(0);

      // `count` is counted in the database and `items` is a capped sample, so
      // the sample can never exceed the total it is a sample OF — reading the
      // array's length as the answer is what shrinks a nineteen-person problem
      // to a five-person one.
      for (const key of ['documents', 'contracts', 'probation']) {
        const group = compliance[key];
        expect(group.count).toEqual(expect.any(Number));
        expect(group.items.length).toBeLessThanOrEqual(group.count);
      }
    });

    it('gives every approvals queue a portal route to resolve it on', async () => {
      const res = await admin
        .auth(http().get('/dashboard/overview'))
        .expect(200);
      const approvals = res.body.data.approvals;

      expect(Array.isArray(approvals.items)).toBe(true);
      for (const item of approvals.items) {
        // A queue card with no destination is a number the reader cannot act
        // on. Every href points inside the portal, never at an API path.
        expect(item.href).toEqual(expect.any(String));
        expect(item.href.startsWith('/dashboard/')).toBe(true);
        // An empty queue is dropped rather than drawn as a zero, so anything
        // that survived into `items` is real work waiting.
        expect(item.count).toBeGreaterThan(0);
      }

      // The total is what THIS reader was shown — the sum of the rows that
      // arrived, not a company-wide figure with hidden queues folded in.
      expect(approvals.total).toBe(
        approvals.items.reduce(
          (sum: number, item: { count: number }) => sum + item.count,
          0,
        ),
      );
    });
  });
});
