import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupOrgFixtures, OrgFixtures } from './utils/org-fixtures';
import { bearer } from './utils/settings';

/**
 * `GET /talent/hub-summary` — the Talent module hub's aggregate.
 *
 * The hub it replaces counted rewards and disciplinary actions in the BROWSER,
 * over one page of each list, and rendered a panel telling the reader so. Both
 * tables carry a real business date; neither had an endpoint that could filter
 * on it. The invariants:
 *
 *   TALHUB-01  role gate — ADMIN/HR in, MANAGER and EMPLOYEE out, anonymous 401
 *   TALHUB-02  the payload has every section the page reads
 *   TALHUB-03  one definition of an open grievance, published in the payload
 *   TALHUB-04  training completion counts obligations, not requests
 *   TALHUB-05  appraisal completion is null — never 0% — when unknowable
 *   TALHUB-06  conduct is counted in the database, not off a page
 *   TALHUB-07  the trend is twelve labelled months and its lanes sum to the bar
 *
 * `OrgFixtures` is used for its four principals; every assertion is
 * invariant-shaped, so no talent rows need to exist for the suite to be
 * meaningful — which is just as well, since `seed-e2e-baseline.ts` seeds none.
 */
describe('Talent — module hub summary (e2e)', () => {
  let ctx: E2EContext;
  let fx: OrgFixtures;

  const hub = (token?: string, branch?: string) => {
    let r = ctx.http().get('/talent/hub-summary');
    if (token) r = r.set(bearer(token));
    if (branch) r = r.set('X-Branch-Id', branch);
    return r;
  };

  const dataOf = async (token?: string, branch?: string) => {
    const res = await hub(token ?? fx.admin.token, branch);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupOrgFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read it', () => {
    it('TALHUB-01 admits ADMIN and HR; refuses MANAGER, EMPLOYEE and anonymous', async () => {
      expect((await hub(fx.admin.token)).status).toBe(200);
      expect((await hub(fx.hr.token)).status).toBe(200);
      // MANAGER is a denial path and has to stay one: a grievance can be
      // confidential and can be raised AGAINST a manager, so an org-wide talent
      // payload is not something a line manager may hold.
      expect((await hub(fx.deptManager.token)).status).toBe(403);
      expect((await hub(fx.employee.token)).status).toBe(403);
      expect((await hub()).status).toBe(401);
    });

    it('TALHUB-01b matches the gate each underlying stats route carries', async () => {
      for (const route of ['/grievances/stats', '/training/stats', '/appraisal/stats']) {
        const res = await ctx.http().get(route).set(bearer(fx.deptManager.token));
        expect(res.status).toBe(403);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('shape', () => {
    it('TALHUB-02 carries every section the page reads', async () => {
      const data = await dataOf();
      expect(Object.keys(data).sort()).toEqual(
        ['appraisal', 'conduct', 'grievances', 'training', 'trend', 'trendKind', 'window'].sort(),
      );
      expect(data.trendKind).toBe('month');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('grievances', () => {
    it('TALHUB-03 publishes the one open definition, and it includes INVESTIGATING', async () => {
      const { grievances } = await dataOf();
      // Three definitions used to exist. `stats()` dropped INVESTIGATING — the
      // status a case spends the longest in — and the page counted four
      // statuses that have never existed in this schema.
      expect(grievances.openStatuses).toEqual(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING']);
      expect(grievances.agingDays).toBe(14);
    });

    it('TALHUB-03b agrees with /grievances/stats rather than re-deriving the count', async () => {
      const { grievances } = await dataOf();
      const stats = await ctx.http().get('/grievances/stats').set(bearer(fx.admin.token));
      expect(stats.status).toBe(200);
      expect(grievances.open).toBe(stats.body.data.open);
      expect(grievances.olderThanAgingDays).toBe(stats.body.data.olderThan14Days);
    });

    it('TALHUB-03c never counts more open than exist, and reports a null baseline honestly', async () => {
      const { grievances } = await dataOf();
      const total = (Object.values(grievances.byStatus) as any[]).reduce(
        (a: number, n: any) => a + n,
        0,
      );
      expect(grievances.open).toBeLessThanOrEqual(total);
      expect(grievances.unassignedOpen).toBeLessThanOrEqual(grievances.open);
      if (grievances.openAsOfPrev === null) expect(grievances.openDelta).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('training', () => {
    it('TALHUB-04 counts completion against nominations that became obligations', async () => {
      const { training } = await dataOf();
      const n = training.nominationsByStatus;
      const expected =
        (n.APPROVED ?? 0) + (n.ATTENDED ?? 0) + (n.NO_SHOW ?? 0);
      expect(training.obligations).toBe(expected);
      // PENDING, REJECTED and CANCELLED are excluded: declining a request is not
      // a failure to train, and putting them in the denominator would make a
      // selective programme look like a failing one.
      if (expected === 0) {
        expect(training.completionRate).toBeNull();
      } else {
        expect(training.completionRate).toBeGreaterThanOrEqual(0);
        expect(training.completionRate).toBeLessThanOrEqual(100);
      }
    });

    it('TALHUB-04b surfaces the two real expiry signals the module has', async () => {
      const { training } = await dataOf();
      // The only genuine expiry in the domain, already wired to the reminder
      // engine and on no dashboard until now.
      expect(training.certificatesExpiring60).toEqual(expect.any(Number));
      // Sessions past their end date with nominations still APPROVED — training
      // that happened and was never written down.
      expect(training.sessionsEndedUnrecorded).toEqual(expect.any(Number));
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('appraisal', () => {
    it('TALHUB-05 reports null completion, never 0%, when there is no run to measure', async () => {
      const { appraisal } = await dataOf();
      if (appraisal.referenceRun === null) {
        // No `AppraisalRun` is seeded anywhere in this repo, so this is the
        // branch a clean database takes. 0% would claim nobody has been
        // appraised; the truth is that nothing has been asked.
        expect(appraisal.completionRate).toBeNull();
        expect(appraisal.completionDelta).toBeNull();
        expect(appraisal.resultsByStatus).toEqual({});
      } else {
        expect(appraisal.referenceRun.totalEmployees).toEqual(expect.any(Number));
        if (appraisal.referenceRun.totalEmployees === 0) {
          // A PENDING run has not resolved its scope yet.
          expect(appraisal.completionRate).toBeNull();
        } else {
          expect(appraisal.completionRate).toBeGreaterThanOrEqual(0);
          expect(appraisal.completionRate).toBeLessThanOrEqual(100);
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('conduct', () => {
    it('TALHUB-06 counts rewards and disciplinary actions on the server', async () => {
      const { conduct } = await dataOf();
      for (const key of [
        'rewardsCount',
        'rewardsAmount',
        'disciplinesCount',
        'disciplinesAmount',
        'prevRewardsCount',
        'prevDisciplinesCount',
      ]) {
        expect(conduct[key]).toEqual(expect.any(Number));
        expect(conduct[key]).toBeGreaterThanOrEqual(0);
      }
    });

    it('TALHUB-07 draws twelve labelled months whose lanes sum to the bar', async () => {
      const { trend, window } = await dataOf();
      expect(trend).toHaveLength(12);
      expect(trend[trend.length - 1].key).toBe(window.key);
      for (const bucket of trend) {
        expect(bucket.key).toMatch(/^\d{4}-\d{2}$/);
        expect(bucket.segments.map((s: any) => s.key)).toEqual(['rewards', 'disciplines']);
        const lanes = bucket.segments.reduce((a: number, s: any) => a + s.value, 0);
        expect(lanes).toBe(bucket.value);
      }
    });

    it('TALHUB-07b agrees with the window it says it measured', async () => {
      const { window } = await dataOf();
      expect(new Date(window.previous.end).getTime()).toBe(new Date(window.start).getTime());
    });
  });
});
