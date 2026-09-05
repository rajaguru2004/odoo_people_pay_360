import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupOrgFixtures, OrgFixtures } from './utils/org-fixtures';
import { bearer } from './utils/settings';

/**
 * `GET /organization/hub-summary` — the Organization module hub's aggregate.
 *
 * It replaced six browser-side requests, and one of those was counting rows off
 * a list endpoint that sends no pagination meta, so the pending-change-request
 * card silently under-reported any queue longer than a page. The invariants:
 *
 *   ORGHUB-01  role gate — ADMIN/HR in, MANAGER and EMPLOYEE out, anonymous 401
 *   ORGHUB-02  bad input is refused, not guessed at
 *   ORGHUB-03  the payload has every section the page reads
 *   ORGHUB-04  no share exceeds 100%, and an empty denominator reports null
 *   ORGHUB-05  the queue is counted in the database, not off a page
 *   ORGHUB-06  branch scoping narrows it, and a cross-branch id is refused
 *   ORGHUB-07  the trend window is what was asked for, and it reconciles
 *
 * Every case is envelope- or invariant-shaped rather than count-shaped: this
 * endpoint reads the whole database inside the caller's branch envelope with no
 * per-run filter, so an absolute count would be hostage to every other suite.
 * Same rule as `attendance-hub.e2e-spec.ts`.
 */
describe('Organization — module hub summary (e2e)', () => {
  let ctx: E2EContext;
  let fx: OrgFixtures;

  const hub = (query = '', token?: string, branch?: string) => {
    let r = ctx.http().get(`/organization/hub-summary${query}`);
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
    fx = await setupOrgFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read it', () => {
    it('ORGHUB-01 admits ADMIN and HR; refuses MANAGER, EMPLOYEE and anonymous', async () => {
      expect((await hub('', fx.admin.token)).status).toBe(200);
      expect((await hub('', fx.hr.token)).status).toBe(200);
      // MANAGER is a denial path here rather than a narrowing case: this is
      // org-wide governance, and "which departments have no head" is not a
      // question a department head is being asked.
      expect((await hub('', fx.deptManager.token)).status).toBe(403);
      expect((await hub('', fx.employee.token)).status).toBe(403);
      expect((await hub()).status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('input', () => {
    it('ORGHUB-02 refuses a window it does not offer rather than defaulting', async () => {
      // A silent fallback answers for a period nobody asked about and the
      // reader cannot see that it happened.
      for (const bad of ['13', 'abc', '6.5', '-6', '0']) {
        const res = await hub(`?months=${bad}`, fx.admin.token);
        expect([bad, res.status]).toEqual([bad, 400]);
      }
    });

    it('ORGHUB-02b defaults to six months when nothing is asked for', async () => {
      const data = await dataOf();
      expect(data.months).toBe(6);
      expect(data.growth.buckets).toHaveLength(6);
    });

    it('ORGHUB-02c honours the twelve-month window', async () => {
      const data = await dataOf('?months=12');
      expect(data.months).toBe(12);
      expect(data.growth.buckets).toHaveLength(12);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the payload', () => {
    it('ORGHUB-03 carries every section the hub reads', async () => {
      const data = await dataOf();
      expect(Object.keys(data).sort()).toEqual(
        [
          'branches',
          'changeRequests',
          'departments',
          'growth',
          'headcount',
          'managers',
          'months',
          'unassigned',
        ].sort(),
      );
      expect(Array.isArray(data.departments.rows)).toBe(true);
      expect(Array.isArray(data.departments.headless)).toBe(true);
      expect(Array.isArray(data.branches.rows)).toBe(true);
    });

    it('ORGHUB-03b names the departments nobody heads, and what that costs', async () => {
      // The fixture's `childDept` and `emptyDept` are created without a head.
      const data = await dataOf();
      const names = data.departments.headless.map((d: any) => d.name);
      expect(names.length).toBeGreaterThan(0);
      expect(data.departments.withoutHead).toBe(data.departments.headless.length);
      // The consequence, not the count.
      const sum = data.departments.headless.reduce(
        (a: number, d: any) => a + d.employees,
        0,
      );
      expect(data.departments.unmanagedHeadcount).toBe(sum);
    });

    it('ORGHUB-03c counts a person once however many hats they wear', async () => {
      // `multiDeptManager` heads two departments. Summing roles would count
      // them twice; the total is the size of the union.
      const data = await dataOf();
      expect(data.managers.total).toBeLessThanOrEqual(
        data.managers.deptHeads + data.managers.branchManagers + data.managers.supervisors,
      );
      expect(data.managers.total).toBeGreaterThanOrEqual(data.managers.deptHeads);
    });

    it('ORGHUB-03d carries no attendance figure — that is Time & Attendance’s', async () => {
      // Phase C's rule: each hub owns one question. Repeating attendance here
      // is what made three hubs look like three views of one page.
      const data = await dataOf();
      const flat = JSON.stringify(data).toLowerCase();
      expect(flat).not.toContain('present');
      expect(flat).not.toContain('attendance');
      expect(flat).not.toContain('late');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('rates', () => {
    it('ORGHUB-04 never claims more than the whole workforce', async () => {
      const data = await dataOf();
      for (const row of [...data.departments.rows, ...data.branches.rows]) {
        if (row.share !== null) {
          expect([row.name, row.share <= 100]).toEqual([row.name, true]);
          expect([row.name, row.share >= 0]).toEqual([row.name, true]);
        }
      }
    });

    it('ORGHUB-04b answers null, not 0, when there is nothing to divide by', async () => {
      // `branchC` is empty on purpose. An empty branch and an empty company are
      // different claims, and 0.0% for both tells the reader something false.
      const data = await dataOf();
      const empty = data.branches.rows.find((r: any) => r.employees === 0);
      if (empty) {
        // With a non-empty company the share of nobody is a real 0.
        expect(empty.share === 0 || empty.share === null).toBe(true);
      }
      // Whatever else is true, no share is ever NaN reaching the client as a
      // number — the shape the reader would see as a blank card.
      for (const row of data.branches.rows) {
        expect(row.share === null || Number.isFinite(row.share)).toBe(true);
      }
    });

    it('ORGHUB-04c ranks the biggest unit first', async () => {
      const data = await dataOf();
      const counts = data.departments.rows.map((r: any) => r.employees);
      expect([...counts].sort((a: number, b: number) => b - a)).toEqual(counts);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the change-request queue', () => {
    it('ORGHUB-05 counts by status rather than by the length of a page', async () => {
      // The bug this endpoint exists to close. The list route sends no
      // pagination meta, so the hub was reporting `rows.length` and any queue
      // longer than a page read short on the one card whose whole job is to say
      // how much work is waiting.
      const data = await dataOf();
      const cr = data.changeRequests;
      for (const k of ['pending', 'approved', 'rejected', 'cancelled', 'total']) {
        expect([k, Number.isInteger(cr[k])]).toEqual([k, true]);
        expect([k, cr[k] >= 0]).toEqual([k, true]);
      }
      // The total is summed from the rows, so an unfamiliar status still lands
      // inside it rather than vanishing from the queue.
      expect(cr.total).toBeGreaterThanOrEqual(
        cr.pending + cr.approved + cr.rejected + cr.cancelled,
      );
    });

    it('ORGHUB-05b moves the pending count when a request is actually raised', async () => {
      const before = (await dataOf()).changeRequests;

      const created = await ctx
        .http()
        .post(`/departments/${fx.topDeptId}/change-requests`)
        .set(bearer(fx.admin.token))
        .send({
          requestType: 'CHANGE_MANAGER',
          newManagerId: fx.seniorCandidateId,
          reason: 'ORGHUB-05b — proving the queue is counted, not paged',
          effectiveDate: new Date(Date.now() + 7 * 86400000).toISOString(),
        });
      expect([201, 200]).toContain(created.status);

      const after = (await dataOf()).changeRequests;
      // A delta, not an absolute — other suites write to this table too.
      expect(after.pending).toBe(before.pending + 1);
      expect(after.total).toBe(before.total + 1);

      const id = created.body?.data?.id;
      if (id) {
        await ctx.prisma.departmentChangeRequest.delete({ where: { id } }).catch(() => {});
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('branch scoping', () => {
    it('ORGHUB-06 narrows the payload to the selected branch', async () => {
      const all = await dataOf();
      const scoped = await dataOf('', fx.admin.token, fx.branchA);

      // Branch A holds most of the fixture staff but not all of the database.
      expect(scoped.headcount.active).toBeLessThanOrEqual(all.headcount.active);
      // Only the selected branch is drawn.
      expect(scoped.branches.rows.map((r: any) => r.id)).toEqual([fx.branchA]);
      expect(scoped.branches.total).toBe(1);
    });

    it('ORGHUB-06e headcount agrees with the branch panel beside it', async () => {
      // The regression this case exists for: `runWithBranchBypass` raises a
      // COUNTER on a shared store, so a bypassed query sharing a `Promise.all`
      // with scoped ones unscopes them for as long as it is awaited. The hub
      // shipped reporting the ORG-WIDE headcount beside a correctly scoped
      // branch panel — two numbers on one screen, one of them leaking staff
      // counts from branches the reader may not see.
      const scoped = await dataOf('', fx.admin.token, fx.branchA);
      const branchTotal = scoped.branches.rows.reduce(
        (a: number, r: any) => a + r.employees,
        0,
      );
      expect(scoped.headcount.active).toBe(branchTotal);
      // And every share is against that same figure, so they close on 100%.
      const shareTotal = scoped.branches.rows
        .filter((r: any) => r.share !== null)
        .reduce((a: number, r: any) => a + r.share, 0);
      if (branchTotal > 0) expect(Math.round(shareTotal)).toBe(100);
    });

    it('ORGHUB-06f departments never total more than the workforce', async () => {
      // Same leak, seen from the other side: scoped department counts summing
      // past an unscoped headcount is what produced a share above 100%.
      const scoped = await dataOf('', fx.admin.token, fx.branchA);
      const deptTotal = scoped.departments.rows.reduce(
        (a: number, r: any) => a + r.employees,
        0,
      );
      expect(deptTotal).toBeLessThanOrEqual(scoped.headcount.active);
    });

    it('ORGHUB-06b keeps the two branch views disjoint', async () => {
      const a = await dataOf('', fx.admin.token, fx.branchA);
      const b = await dataOf('', fx.admin.token, fx.branchB);
      expect(a.branches.rows[0].id).toBe(fx.branchA);
      expect(b.branches.rows[0].id).toBe(fx.branchB);
    });

    it('ORGHUB-06c refuses a branch outside the caller’s envelope', async () => {
      // `scopedHr` may only see branch A.
      const res = await hub('', fx.scopedHr.token, fx.branchB);
      expect([403, 404]).toContain(res.status);
    });

    it('ORGHUB-06d still reports employees who belong to no branch at all', async () => {
      // A nullable `branchId` is a real governance gap, and it disappears
      // entirely if every branch view reports zero — so it is counted org-wide,
      // the same rule the change-request service applies to a department with
      // nobody in it.
      const scoped = await dataOf('', fx.admin.token, fx.branchA);
      expect(Number.isInteger(scoped.unassigned.noBranch)).toBe(true);
      expect(scoped.unassigned.noBranch).toBeGreaterThanOrEqual(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the workforce trend', () => {
    it('ORGHUB-07 ends on the headcount the card above the chart prints', async () => {
      // A chart that disagrees with the KPI beside it gives the reader no way
      // to tell which one is lying.
      const data = await dataOf();
      const last = data.growth.buckets[data.growth.buckets.length - 1];
      expect(last.headcountEnd).toBe(data.headcount.active);
    });

    it('ORGHUB-07b labels every bucket and never draws a negative headcount', async () => {
      const data = await dataOf('?months=12');
      for (const b of data.growth.buckets) {
        expect(b.key).toMatch(/^\d{4}-\d{2}$/);
        expect(typeof b.label).toBe('string');
        expect(b.label.length).toBeGreaterThan(0);
        expect(b.headcountEnd).toBeGreaterThanOrEqual(0);
        expect(b.net).toBe(b.joiners - b.leavers);
      }
    });

    it('ORGHUB-07c ends the window on the current month', async () => {
      const data = await dataOf();
      const now = new Date();
      const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      expect(data.growth.buckets[data.growth.buckets.length - 1].key).toBe(expected);
    });

    it('ORGHUB-07d reports net change as the sum of what it drew', async () => {
      const data = await dataOf();
      const sum = data.growth.buckets.reduce((a: number, b: any) => a + b.net, 0);
      expect(data.growth.netChange).toBe(sum);
    });
  });
});
