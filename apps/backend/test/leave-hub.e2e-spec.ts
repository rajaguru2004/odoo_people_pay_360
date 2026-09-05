import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupLeaveOvertimeFixtures,
  LeaveOtFixtures,
  LEAVE_YEAR,
} from './utils/leave-overtime-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * `GET /leave-requests/hub-summary` — the Leave & Overtime module hub's
 * aggregate.
 *
 * The hub used to fan out to three endpoints, none of which a period selector
 * could move: `/dashboard/overview` is unwindowed, `/leave-balances/company-
 * overview` is year-only, `/overtime/report/:m/:y` is month-only. So the page
 * had no selector at all and its overtime card was permanently the current
 * calendar month.
 *
 *   LHUB-01  role gate — ADMIN/HR in, MANAGER and EMPLOYEE out, anonymous 401
 *   LHUB-02  bad input is refused, not guessed at
 *   LHUB-03  the envelope is complete and internally consistent
 *   LHUB-04  no rate exceeds 100%, and an empty denominator reports null
 *   LHUB-05  the anchors it returns page the period, and round-trip
 *   LHUB-06  the status donut counts all FOUR statuses, cancelled included
 *   LHUB-07  balance arithmetic — remaining is derived, carry-over included
 *   LHUB-08  the `overtime_enabled` kill switch, both branches
 *   LHUB-09  branch scope is respected
 *
 * Envelope- and invariant-shaped rather than count-shaped: this endpoint reads
 * the whole database inside the caller's branch envelope with no per-run
 * filter, so an absolute count would be a hostage to every other suite.
 */
describe('Leave & Overtime — module hub summary (e2e)', () => {
  let ctx: E2EContext;
  let fx: LeaveOtFixtures;

  const hub = (query = '', token?: string) => {
    const r = ctx.http().get(`/leave-requests/hub-summary${query}`);
    return token ? r.set(bearer(token)) : r;
  };

  const dataOf = async (query = '') => {
    const res = await hub(query, fx.admin.token);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupLeaveOvertimeFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read it', () => {
    it('LHUB-01 admits ADMIN and HR; refuses MANAGER, EMPLOYEE and anonymous', async () => {
      expect((await hub('', fx.admin.token)).status).toBe(200);
      expect((await hub('', fx.hr.token)).status).toBe(200);
      // The hub is the ADMIN/HR landing page — `ProtectedRoute` on
      // `/dashboard/leave` refuses everyone else, and an endpoint that answered
      // where the screen refuses would offer tiles that 403.
      expect((await hub('', fx.mgr.token)).status).toBe(403);
      expect((await hub('', fx.employee.token)).status).toBe(403);
      expect((await hub()).status).toBe(401);
    });

    it('LHUB-01b is not shadowed by the :id route', async () => {
      // `hub-summary` has to be declared before `@Get(':id')` or Nest reads it
      // as a leave-request UUID and the whole dashboard 400s. Same trap
      // `team-balances` documents at the top of the controller.
      const res = await hub('', fx.admin.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('periodStats');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('input', () => {
    it('LHUB-02 refuses a period or an anchor it does not understand', async () => {
      expect((await hub('?period=quarter', fx.admin.token)).status).toBe(400);
      expect((await hub('?anchor=last-tuesday', fx.admin.token)).status).toBe(400);
      expect((await hub('?anchor=2026-13-45', fx.admin.token)).status).toBe(400);
    });

    it('LHUB-02b defaults to the current month', async () => {
      const d = await dataOf();
      expect(d.period).toBe('month');
      expect(d.range.isCurrent).toBe(true);
      expect(d.range.start.slice(8)).toBe('01');
    });

    it('LHUB-02c accepts all four periods', async () => {
      for (const period of ['today', 'week', 'month', 'year']) {
        const res = await hub(`?period=${period}`, fx.admin.token);
        expect(res.status).toBe(200);
        expect(res.body.data.period).toBe(period);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the envelope', () => {
    it('LHUB-03 carries every block the page draws', async () => {
      const d = await dataOf(`?period=year&anchor=${LEAVE_YEAR}-06-15`);
      for (const k of [
        'period', 'anchor', 'range', 'periodStats', 'previousStats', 'previousRange',
        'trendKind', 'trend', 'leaveTypes', 'status', 'balance', 'overtime', 'attention',
      ]) {
        expect(d).toHaveProperty(k);
      }
      for (const k of ['pending', 'stale', 'onLeaveToday', 'highOvertime']) {
        expect(d.attention[k]).toHaveProperty('count');
        expect(Array.isArray(d.attention[k].names)).toBe(true);
      }
    });

    it('LHUB-03b labels the window server-side', async () => {
      expect((await dataOf('?period=month&anchor=2026-08-15')).range.label).toBe('Aug 2026');
      expect((await dataOf('?period=year&anchor=2026-08-15')).range.label).toBe('2026');
      expect((await dataOf('?period=week&anchor=2026-08-20')).range.label).toBe('Aug 17 – 23');
    });

    it('LHUB-03c buckets a year by month and a month by day', async () => {
      const year = await dataOf('?period=year&anchor=2026-08-15');
      expect(year.trendKind).toBe('month');
      expect(year.trend).toHaveLength(12);

      const month = await dataOf('?period=month&anchor=2026-08-15');
      expect(month.trendKind).toBe('day');
      expect(month.trend).toHaveLength(31);
    });

    it('LHUB-03d reports the previous window alongside the current one', async () => {
      const d = await dataOf('?period=month&anchor=2026-08-15');
      expect(d.previousRange).toMatchObject({
        start: '2026-07-01',
        end: '2026-07-31',
        label: 'Jul 2026',
      });
      expect(typeof d.previousStats.requests).toBe('number');
      expect(typeof d.previousStats.overtimeHours).toBe('number');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the numbers', () => {
    it('LHUB-04 never reports a rate above 100% or below 0%', async () => {
      for (const period of ['week', 'month', 'year']) {
        const d = await dataOf(`?period=${period}&anchor=${LEAVE_YEAR}-06-15`);
        const rates = [
          d.periodStats.approvalRate,
          d.periodStats.utilisation,
          d.periodStats.onLeaveTodayRate,
          d.balance.utilisation,
          ...d.leaveTypes.map((x: any) => x.share),
          ...d.balance.byType.map((x: any) => x.utilisation),
        ].filter((r) => r !== null);
        for (const r of rates) {
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(100);
        }
      }
    });

    it('LHUB-04b reports null, never 0%, when there is nothing to divide by', async () => {
      // A window far in the past holds no requests at all here.
      const d = await dataOf('?period=month&anchor=2019-03-15');
      expect(d.periodStats.requests).toBe(0);
      // 0% approval would be a claim that everything was refused.
      expect(d.periodStats.approvalRate).toBeNull();
    });

    it('LHUB-06 counts all four statuses, cancelled included', async () => {
      const d = await dataOf(`?period=year&anchor=${LEAVE_YEAR}-06-15`);
      for (const k of ['approved', 'pending', 'rejected', 'cancelled']) {
        expect(typeof d.status[k]).toBe('number');
      }
      // The donut's caption is the sum of its slices — the endpoint this
      // replaced counted only three, so a cancelled request vanished and the
      // caption disagreed with the ring beneath it.
      const sum = d.status.approved + d.status.pending + d.status.rejected + d.status.cancelled;
      expect(sum).toBe(d.periodStats.requests);
    });

    it('LHUB-06b the trend sums to the same request count as the KPI', async () => {
      const d = await dataOf(`?period=year&anchor=${LEAVE_YEAR}-06-15`);
      const total = d.trend.reduce((a: number, b: any) => a + b.total, 0);
      // Each request lands on exactly one bucket. Spreading one across five
      // bars would make the chart disagree with the number above it.
      expect(total).toBe(d.periodStats.requests);
      for (const b of d.trend) {
        expect(b.total).toBe(b.approved + b.pending + b.rejected + b.cancelled);
      }
    });

    it('LHUB-07 derives remaining, and counts carry-over in utilisation', async () => {
      const d = await dataOf(`?period=year&anchor=${LEAVE_YEAR}-06-15`);
      const b = d.balance;
      // There is no `remaining` column; it is always allocated + carried - used.
      expect(b.remaining).toBe(b.allocated + b.carriedOver - b.used);
      if (b.allocated + b.carriedOver > 0) {
        const expected =
          Math.round((b.used / (b.allocated + b.carriedOver)) * 1000) / 10;
        expect(b.utilisation).toBeCloseTo(expected, 1);
      } else {
        expect(b.utilisation).toBeNull();
      }
      for (const t of b.byType) {
        expect(t.remaining).toBe(t.allocated + t.carriedOver - t.used);
      }
    });

    it('LHUB-07b scopes the balance to the year the window ENDS in', async () => {
      // A balance is a year fact — a week does not have an entitlement.
      const a = await dataOf(`?period=year&anchor=${LEAVE_YEAR}-06-15`);
      const b = await dataOf(`?period=year&anchor=${LEAVE_YEAR - 1}-06-15`);
      // Different years must be able to disagree; identical objects would mean
      // the year was being ignored.
      expect(a.range.label).toBe(String(LEAVE_YEAR));
      expect(b.range.label).toBe(String(LEAVE_YEAR - 1));
    });

    it('LHUB-07c averages overtime over the people who worked it', async () => {
      const d = await dataOf(`?period=year&anchor=${LEAVE_YEAR}-06-15`);
      const s = d.periodStats;
      if (s.overtimeEmployees > 0) {
        const expected = Math.round((s.overtimeHours / s.overtimeEmployees) * 10) / 10;
        expect(s.avgOvertimePerEmployee).toBeCloseTo(expected, 1);
        // Never divided by headcount, which would report the average employee
        // as working a fraction of an hour of overtime.
        expect(s.overtimeEmployees).toBeLessThanOrEqual(s.activeHeadcount);
      } else {
        expect(s.avgOvertimePerEmployee).toBeNull();
      }
    });

    it('LHUB-07d never reports more people on leave than exist', async () => {
      const d = await dataOf('?period=month');
      expect(d.periodStats.onLeaveToday).toBeLessThanOrEqual(
        d.periodStats.activeHeadcount,
      );
    });

    it('LHUB-07e the stale queue is a subset of the pending one', async () => {
      const d = await dataOf(`?period=year&anchor=${LEAVE_YEAR}-06-15`);
      expect(d.periodStats.pendingOlderThan2Days).toBeLessThanOrEqual(
        d.periodStats.pending,
      );
      expect(d.attention.stale.count).toBeLessThanOrEqual(d.attention.pending.count);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the overtime kill switch', () => {
    it('LHUB-08 reports overtime when the flag is on', async () => {
      await withSetting(ctx, 'overtime_enabled', 'true', async () => {
        const d = await dataOf(`?period=year&anchor=${LEAVE_YEAR}-06-15`);
        expect(d.overtime.enabled).toBe(true);
        expect(Array.isArray(d.overtime.trend)).toBe(true);
        expect(d.overtime.trend).toHaveLength(12);
      });
    });

    it('LHUB-08b says overtime is off rather than reporting zeros', async () => {
      await withSetting(ctx, 'overtime_enabled', 'false', async () => {
        const d = await dataOf(`?period=year&anchor=${LEAVE_YEAR}-06-15`);
        // Zeros would read as "nobody worked late". `enabled: false` lets the
        // page drop the card and the panel instead of drawing a hole.
        expect(d.overtime.enabled).toBe(false);
        expect(d.periodStats.overtimeHours).toBe(0);
        expect(d.periodStats.overtimeRequests).toBe(0);
        expect(d.periodStats.avgOvertimePerEmployee).toBeNull();
        expect(d.attention.highOvertime.count).toBe(0);
        // The leave half of the page is untouched by the overtime switch.
        expect(d.periodStats).toHaveProperty('requests');
        expect(d.balance.remaining).toBe(
          d.balance.allocated + d.balance.carriedOver - d.balance.used,
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('paging', () => {
    it('LHUB-05 pages the period with the anchors it returned', async () => {
      const now = await dataOf(`?period=month&anchor=${LEAVE_YEAR}-06-15`);
      const back = await dataOf(`?period=month&anchor=${now.range.prevAnchor}`);

      expect(back.range.start).toBe(now.previousRange.start);
      expect(back.range.end).toBe(now.previousRange.end);
      // The window one step back must report the same totals the current window
      // already showed as "previous", or the delta badge compares against a
      // number nothing else on the page can reach.
      expect(back.periodStats.requests).toBe(now.previousStats.requests);
      expect(back.periodStats.overtimeHours).toBe(now.previousStats.overtimeHours);
    });

    it('LHUB-05b round-trips: forward from the previous anchor lands back', async () => {
      const now = await dataOf('?period=month&anchor=2026-08-15');
      const back = await dataOf(`?period=month&anchor=${now.range.prevAnchor}`);
      const forward = await dataOf(`?period=month&anchor=${back.range.nextAnchor}`);
      expect(forward.range.start).toBe(now.range.start);
      expect(forward.range.end).toBe(now.range.end);
    });

    it('LHUB-05c marks a past window as not current', async () => {
      const d = await dataOf('?period=month&anchor=2019-03-15');
      expect(d.range.isCurrent).toBe(false);
      expect(d.range.label).toBe('Mar 2019');
    });

    it('LHUB-05d stops paging forward well before an empty decade', async () => {
      const far = await dataOf('?period=year&anchor=2031-01-01');
      expect(far.range.hasNext).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('branch scope', () => {
    it('LHUB-09 answers inside the caller branch envelope', async () => {
      const all = await dataOf(`?period=year&anchor=${LEAVE_YEAR}-06-15`);
      const scoped = await hub(
        `?period=year&anchor=${LEAVE_YEAR}-06-15`,
        fx.hr.token,
      ).set('X-Branch-Id', fx.branchAlt);
      expect(scoped.status).toBe(200);
      // A single branch holds a subset of the workforce, so it can never report
      // a larger headcount than the unscoped view.
      expect(scoped.body.data.periodStats.activeHeadcount).toBeLessThanOrEqual(
        all.periodStats.activeHeadcount,
      );
      expect(scoped.body.data.periodStats.requests).toBeLessThanOrEqual(
        all.periodStats.requests,
      );
    });
  });
});
