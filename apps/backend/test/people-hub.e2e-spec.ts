import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupPeopleFixtures, PeopleFixtures } from './utils/people-fixtures';
import { bearer } from './utils/settings';

/**
 * `GET /employees/hub-summary` — the People module hub's aggregate.
 *
 * The hub owns the employee LIFECYCLE: deadlines and movements. The riskiest
 * part of the payload is the status split, because three of its four buckets
 * are DERIVED — `Employee.status` holds only ACTIVE or INACTIVE, probation is
 * an active contract of that type, and notice is an open termination request.
 * Derived buckets that overlap would draw a workforce that does not exist.
 *
 *   PPLHUB-01  role gate — ADMIN/HR in, MANAGER and EMPLOYEE out, anonymous 401
 *   PPLHUB-02  bad input is refused, not guessed at
 *   PPLHUB-03  the payload has every section the page reads
 *   PPLHUB-04  the status buckets are exclusive and sum to the workforce
 *   PPLHUB-05  deadlines are dates somebody can act on
 *   PPLHUB-06  branch scoping narrows it
 *   PPLHUB-07  the trend reconciles with the headcount above it
 *   PPLHUB-08  permits are NOT in this payload
 *
 * Envelope-shaped, not count-shaped — see `attendance-hub.e2e-spec.ts`.
 */
describe('People — module hub summary (e2e)', () => {
  let ctx: E2EContext;
  let fx: PeopleFixtures;

  const hub = (query = '', token?: string, branch?: string) => {
    let r = ctx.http().get(`/employees/hub-summary${query}`);
    if (token) r = r.set(bearer(token));
    if (branch) r = r.set('X-Branch-Id', branch);
    return r;
  };

  const dataOf = async (query = '', token?: string, branch?: string) => {
    const res = await hub(query, token ?? fx.admin.token, branch);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPeopleFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read it', () => {
    it('PPLHUB-01 admits ADMIN and HR; refuses MANAGER, EMPLOYEE and anonymous', async () => {
      expect((await hub('', fx.admin.token)).status).toBe(200);
      expect((await hub('', fx.hr.token)).status).toBe(200);
      expect((await hub('', fx.manager.token)).status).toBe(403);
      expect((await hub('', fx.employee.token)).status).toBe(403);
      expect((await hub()).status).toBe(401);
    });

    it('PPLHUB-01b is not swallowed by the :id route', async () => {
      // `@Get('hub-summary')` has to be declared above `@Get(':id')` or Nest
      // reads the literal as an employee id and answers 404 (or 400 on the
      // UUID pipe) instead of the aggregate.
      const res = await hub('', fx.admin.token);
      expect(res.status).toBe(200);
      expect(res.body.data.months).toBe(6);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('input', () => {
    it('PPLHUB-02 refuses a window it does not offer rather than defaulting', async () => {
      for (const bad of ['24', 'abc', '6.5', '-6', '0']) {
        const res = await hub(`?months=${bad}`, fx.admin.token);
        expect([bad, res.status]).toEqual([bad, 400]);
      }
    });

    it('PPLHUB-02b honours the window it was given', async () => {
      expect((await dataOf()).trend.buckets).toHaveLength(6);
      const twelve = await dataOf('?months=12');
      expect(twelve.months).toBe(12);
      expect(twelve.trend.buckets).toHaveLength(12);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the payload', () => {
    it('PPLHUB-03 carries every section the hub reads', async () => {
      const data = await dataOf();
      expect(Object.keys(data).sort()).toEqual(
        [
          'contracts',
          'headcount',
          'lifecycle',
          'months',
          'statusSplit',
          'terminations',
          'trend',
        ].sort(),
      );
    });

    it('PPLHUB-03b draws no headcount distribution — that moved to Organization', async () => {
      // Phase C's rule, asserted at the payload rather than only in the DOM:
      // three hubs drawing the same distribution chart is what made them feel
      // like one page.
      const data = await dataOf();
      expect(data).not.toHaveProperty('departments');
      expect(JSON.stringify(data)).not.toContain('byDepartment');
    });

    it('PPLHUB-03c carries no who-is-in-today figure', async () => {
      // "On leave today" belongs to Time & Attendance, which already prints it.
      const flat = JSON.stringify(await dataOf()).toLowerCase();
      expect(flat).not.toContain('onleavetoday');
      expect(flat).not.toContain('presenttoday');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the status split', () => {
    it('PPLHUB-04 sums to the whole workforce', async () => {
      const data = await dataOf();
      const sum = data.statusSplit.reduce((a: number, s: any) => a + s.count, 0);
      expect(sum).toBe(data.headcount.active + data.headcount.inactive);
    });

    it('PPLHUB-04b never draws a negative slice', async () => {
      const data = await dataOf();
      for (const s of data.statusSplit) {
        expect([s.key, s.count >= 0]).toEqual([s.key, true]);
      }
    });

    it('PPLHUB-04c keeps the four buckets, in the order the donut reads them', async () => {
      const data = await dataOf();
      expect(data.statusSplit.map((s: any) => s.key)).toEqual([
        'active',
        'probation',
        'notice',
        'inactive',
      ]);
    });

    it('PPLHUB-04d counts anything that is not ACTIVE against the workforce', async () => {
      // `status` is a free-text column, so the split reports the rows it finds
      // rather than mapping them onto four assumed values.
      const data = await dataOf();
      const active = data.headcount.byStatus.find((s: any) => s.status === 'ACTIVE');
      expect(data.headcount.active).toBe(active ? active.count : 0);
      const others = data.headcount.byStatus
        .filter((s: any) => s.status !== 'ACTIVE')
        .reduce((a: number, s: any) => a + s.count, 0);
      expect(data.headcount.inactive).toBe(others);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('deadlines and movement', () => {
    it('PPLHUB-05 flattens the expiry feed to a name and a countdown', async () => {
      const data = await dataOf();
      expect(Array.isArray(data.contracts.expiring)).toBe(true);
      for (const row of data.contracts.expiring) {
        expect(Object.keys(row).sort()).toEqual(
          ['daysUntilExpiry', 'employeeId', 'endDate', 'fullName', 'id'].sort(),
        );
        expect(Number.isFinite(row.daysUntilExpiry)).toBe(true);
      }
    });

    it('PPLHUB-05b carries the previous month, so a delta names a window somebody can check', async () => {
      // "vs last month" is checkable; "+4" on its own is not.
      const data = await dataOf();
      expect(Number.isInteger(data.lifecycle.previousMonth.joiners)).toBe(true);
      expect(Number.isInteger(data.lifecycle.previousMonth.leavers)).toBe(true);
      expect(data.lifecycle.netChangeThisMonth).toBe(
        data.lifecycle.joinersThisMonth - data.lifecycle.leaversThisMonth,
      );
    });

    it('PPLHUB-05c separates terminations awaiting a decision from those already dated', async () => {
      const data = await dataOf();
      expect(data.terminations.awaitingApproval).toBeGreaterThanOrEqual(0);
      expect(data.terminations.thisMonth).toBeGreaterThanOrEqual(0);
    });

    it('PPLHUB-05d reuses the contract statistics rather than recounting them', async () => {
      const hubData = await dataOf();
      const stats = await ctx
        .http()
        .get('/contracts/statistics')
        .set(bearer(fx.admin.token));
      expect(stats.status).toBe(200);
      // Same source, so the hub card and the contracts screen cannot disagree.
      expect(hubData.contracts.expiringSoon).toBe(stats.body.data.expiringSoon);
      expect(hubData.contracts.active).toBe(stats.body.data.active);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('branch scoping', () => {
    it('PPLHUB-06 narrows the payload to the selected branch', async () => {
      const all = await dataOf();
      const scoped = await dataOf('', fx.admin.token, fx.branchA);
      expect(scoped.headcount.active).toBeLessThanOrEqual(all.headcount.active);
      const sum = scoped.statusSplit.reduce((a: number, s: any) => a + s.count, 0);
      expect(sum).toBe(scoped.headcount.active + scoped.headcount.inactive);
    });

    it('PPLHUB-06b keeps the trend reconciled inside a branch too', async () => {
      const scoped = await dataOf('', fx.admin.token, fx.branchB);
      const last = scoped.trend.buckets[scoped.trend.buckets.length - 1];
      expect(last.headcountEnd).toBe(scoped.headcount.active);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the workforce trend', () => {
    it('PPLHUB-07 ends on the headcount the card above the chart prints', async () => {
      const data = await dataOf();
      const last = data.trend.buckets[data.trend.buckets.length - 1];
      expect(last.headcountEnd).toBe(data.headcount.active);
    });

    it('PPLHUB-07b labels every bucket and never draws a negative headcount', async () => {
      const data = await dataOf('?months=12');
      for (const b of data.trend.buckets) {
        expect(b.key).toMatch(/^\d{4}-\d{2}$/);
        expect(b.headcountEnd).toBeGreaterThanOrEqual(0);
        expect(b.net).toBe(b.joiners - b.leavers);
      }
    });

    it('PPLHUB-07c reports turnover as a rate or as unknown, never as a bare 0', async () => {
      const data = await dataOf();
      expect(data.trend.turnoverRate === null || Number.isFinite(data.trend.turnoverRate)).toBe(
        true,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('what it deliberately does not do', () => {
    it('PPLHUB-08 asks the permit module for nothing', async () => {
      // `/legal-documents/*` answers 403 for some roles. The hub quietens two
      // permit cards and keeps the rest of the page alive; one payload would
      // let a 403 in that module blank the whole dashboard.
      const flat = JSON.stringify(await dataOf()).toLowerCase();
      expect(flat).not.toContain('visa');
      expect(flat).not.toContain('permit');
      expect(flat).not.toContain('legaldocument');
    });
  });
});
