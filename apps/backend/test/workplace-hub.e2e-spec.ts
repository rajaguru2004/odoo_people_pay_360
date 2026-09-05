import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupWorkplaceFixtures, WorkplaceFixtures } from './utils/workplace-fixtures';
import { bearer } from './utils/settings';

/**
 * `GET /workplace/hub-summary` — the Workplace module hub's aggregate.
 *
 * It replaced four browser-side requests and, more importantly, it stops the
 * page drawing a project mix bar that silently omits two of the five statuses
 * because `/projects/stats` returns only four of them. The invariants:
 *
 *   WPHUB-01  role gate — ADMIN/HR in, MANAGER and EMPLOYEE out, anonymous 401
 *   WPHUB-02  the payload has every section the page reads
 *   WPHUB-03  every AssetStatus and every ProjectStatus is present, zero-filled
 *   WPHUB-04  custody at a past date is a real count, not an estimate
 *   WPHUB-05  the letter desk is measured on issuedAt, and the reject side
 *             declares itself unmeasurable
 *   WPHUB-06  overdue projects travel with how many have no end date at all
 *   WPHUB-07  assets and letters narrow with the branch; projects do not, and
 *             the payload says so rather than letting the reader assume
 *
 * Cases are invariant-shaped, not count-shaped: the endpoint reads the whole
 * database inside the caller's envelope with no per-run filter.
 */
describe('Workplace — module hub summary (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;

  const hub = (token?: string, branch?: string) => {
    let r = ctx.http().get('/workplace/hub-summary');
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
    fx = await setupWorkplaceFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read it', () => {
    it('WPHUB-01 admits ADMIN and HR; refuses MANAGER, EMPLOYEE and anonymous', async () => {
      expect((await hub(fx.admin.token)).status).toBe(200);
      expect((await hub(fx.scopedHr.token)).status).toBe(200);
      expect((await hub(fx.manager.token)).status).toBe(403);
      expect((await hub(fx.employee.token)).status).toBe(403);
      expect((await hub()).status).toBe(401);
    });

    it('WPHUB-01b matches the gate the asset and letter aggregates carry', async () => {
      expect(
        (await ctx.http().get('/assets/summary').set(bearer(fx.manager.token))).status,
      ).toBe(403);
      expect(
        (await ctx.http().get('/letters/stats').set(bearer(fx.manager.token))).status,
      ).toBe(403);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('shape', () => {
    it('WPHUB-02 carries every section the page reads', async () => {
      const data = await dataOf();
      expect(Object.keys(data).sort()).toEqual(
        ['assets', 'clearances', 'letters', 'projects', 'trend', 'trendKind', 'window'].sort(),
      );
      expect(data.trendKind).toBe('month');
    });

    it('WPHUB-03 reports all five asset statuses, zero-filled', async () => {
      const { assets } = await dataOf();
      // LOST has no rows on any seeded database today. A missing key would make
      // the breakdown silently four-valued and the reader would never know.
      expect(Object.keys(assets.byStatus).sort()).toEqual(
        ['ASSIGNED', 'AVAILABLE', 'IN_REPAIR', 'LOST', 'RETIRED'].sort(),
      );
      const summed = (Object.values(assets.byStatus) as any[]).reduce((a: number, n: any) => a + n, 0);
      expect(summed).toBe(assets.total);
    });

    it('WPHUB-03b reports all five project statuses, including the two /projects/stats drops', async () => {
      const { projects } = await dataOf();
      expect(Object.keys(projects.byStatus)).toEqual([
        'PLANNING',
        'ACTIVE',
        'ON_HOLD',
        'COMPLETED',
        'CANCELLED',
      ]);
      const summed = (Object.values(projects.byStatus) as any[]).reduce(
        (a: number, n: any) => a + n,
        0,
      );
      expect(summed).toBe(projects.total);

      const stats = await ctx.http().get('/projects/stats').set(bearer(fx.admin.token));
      expect(stats.status).toBe(200);
      // The endpoint the old hub read has no PLANNING and no CANCELLED, which is
      // why its mix bar could not add up to the total beside it.
      expect(stats.body.data).not.toHaveProperty('planning');
      expect(stats.body.data).not.toHaveProperty('cancelled');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('assets', () => {
    it('WPHUB-04 counts custody at a past date rather than estimating it', async () => {
      const { assets } = await dataOf();
      expect(assets.heldAsOfPrev).toEqual(expect.any(Number));
      expect(assets.heldAsOfPrev).toBeGreaterThanOrEqual(0);
      // `AssetAssignment` is append-only, so this is a query and not a
      // reconstruction — it is always answerable, never null.
      expect(assets.heldDelta).toMatchObject({
        direction: expect.stringMatching(/^(up|down)$/),
      });
    });

    it('WPHUB-04b builds the attention composite from the three signals that exist', async () => {
      const { assets } = await dataOf();
      expect(assets.needingAttention).toBe(
        assets.byStatus.IN_REPAIR + assets.byStatus.LOST + assets.warrantyExpired,
      );
      // Deliberately NOT "overdue for return": `AssetAssignment` has no
      // `returnDueDate`, so that is not a question this schema can answer.
      expect(assets).not.toHaveProperty('overdueReturns');
    });

    it('WPHUB-04c never reports more held than assigned, nor unacknowledged than held', async () => {
      const { assets } = await dataOf();
      expect(assets.unacknowledged).toBeLessThanOrEqual(assets.held);
      expect(assets.held).toBeLessThanOrEqual(assets.total);
      expect(assets.valueAtRisk).toBeGreaterThanOrEqual(0);
    });

    it('WPHUB-04d surfaces the clearance worklist with names, not just a count', async () => {
      const { clearances } = await dataOf();
      // The fixture leaver still holds an asset.
      expect(clearances.outstandingCount).toBeGreaterThanOrEqual(1);
      expect(clearances.top.length).toBeLessThanOrEqual(8);
      expect(clearances.top[0]).toMatchObject({
        assetTag: expect.any(String),
        employeeName: expect.any(String),
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the letter desk', () => {
    it('WPHUB-05 measures issued volume on issuedAt, not on updatedAt', async () => {
      const { letters, window } = await dataOf();
      expect(letters.issuedInWindow).toEqual(expect.any(Number));
      const legacy = await ctx.http().get('/letters/stats').set(bearer(fx.admin.token));
      // `/letters/stats.issuedThisMonth` filters `updatedAt`, so an edit to an
      // already-issued letter re-counts it into the current month. The hub does
      // not inherit that; the two may legitimately disagree.
      expect(legacy.body.data.issuedThisMonth).toEqual(expect.any(Number));
      expect(window.key).toMatch(/^\d{4}-\d{2}$/);
    });

    it('WPHUB-05b declares the reject side unmeasurable instead of guessing', async () => {
      const { letters } = await dataOf();
      // `LetterRequest` has `rejectedReason` but no `rejectedAt`.
      expect(letters.rejectTurnaroundMeasurable).toBe(false);
      // Turnaround is a number or an admission, never a zero standing in for
      // "nothing has been issued yet".
      expect(
        letters.avgIssueTurnaroundDays === null ||
          typeof letters.avgIssueTurnaroundDays === 'number',
      ).toBe(true);
    });

    it('WPHUB-05c draws twelve labelled months whose backlog never goes negative', async () => {
      const { trend, window } = await dataOf();
      expect(trend).toHaveLength(12);
      expect(trend[trend.length - 1].key).toBe(window.key);
      for (const bucket of trend) {
        expect(bucket.segments.map((s: any) => s.key)).toEqual(['issued', 'outstanding']);
        for (const seg of bucket.segments) expect(seg.value).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('projects', () => {
    it('WPHUB-06 ships overdue alongside how many projects have no end date', async () => {
      const { projects } = await dataOf();
      expect(projects.overdue).toBeGreaterThanOrEqual(0);
      // Without this, "0 overdue" on a database where no project carries an end
      // date reads as full coverage rather than as no coverage.
      expect(projects.withoutEndDate).toEqual(expect.any(Number));
      const live =
        projects.byStatus.PLANNING + projects.byStatus.ACTIVE + projects.byStatus.ON_HOLD;
      expect(projects.overdue).toBeLessThanOrEqual(live);
      expect(projects.withoutEndDate).toBeLessThanOrEqual(live);
    });

    it('WPHUB-07 declares that project figures are not branch-scoped', async () => {
      const { projects } = await dataOf();
      expect(projects.projectsAreBranchScoped).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('branch scoping', () => {
    it('WPHUB-07b narrows assets and letters with the branch, and leaves projects alone', async () => {
      const all = await dataOf(fx.admin.token);
      const scoped = await dataOf(fx.admin.token, fx.branchA);

      expect(scoped.assets.total).toBeLessThanOrEqual(all.assets.total);
      const scopedLetters = (Object.values(scoped.letters.byStatus) as any[]).reduce(
        (a: number, n: any) => a + n,
        0,
      );
      const allLetters = (Object.values(all.letters.byStatus) as any[]).reduce(
        (a: number, n: any) => a + n,
        0,
      );
      expect(scopedLetters).toBeLessThanOrEqual(allLetters);

      // `Project` is absent from `branch-scope.map.ts` by design, so the
      // project figures are identical whatever branch is selected. This is the
      // asymmetry the payload flags and the panel prints.
      expect(scoped.projects.total).toBe(all.projects.total);
    });

    it('WPHUB-07c a branch-scoped HR user sees no more than the global admin', async () => {
      const global = await dataOf(fx.admin.token);
      const scoped = await dataOf(fx.scopedHr.token);
      expect(scoped.assets.total).toBeLessThanOrEqual(global.assets.total);
    });
  });
});
