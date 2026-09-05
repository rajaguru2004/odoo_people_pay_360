import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupScheduleFixtures, ScheduleFixtures } from './utils/schedule-fixtures';
import { bearer } from './utils/settings';

/**
 * `GET /calendar/hub-summary` — the Schedules module hub's aggregate.
 *
 * The hub used to ask `/calendar/coverage-stats` for a hard-coded Monday–Sunday
 * window and had no period selector at all. This endpoint owns the window, the
 * window before it, and every panel on the page, so the invariants below are
 * the ones the whole dashboard rests on:
 *
 *   SHUB-01  role gate — ADMIN/HR in, MANAGER and EMPLOYEE out, anonymous 401
 *   SHUB-02  bad input is refused, not guessed at
 *   SHUB-03  the envelope is complete and internally consistent
 *   SHUB-04  no rate ever exceeds 100%, and an empty denominator reports null
 *   SHUB-05  the anchors it returns page the period, and round-trip
 *   SHUB-06  a closed day expects nobody rather than reading 100% unassigned
 *   SHUB-07  the panels agree with the totals above them
 *   SHUB-08  branch scope is respected
 *
 * Every case is envelope- or invariant-shaped rather than count-shaped: this
 * endpoint reads the whole database inside the caller's branch envelope with no
 * per-run filter, so an absolute count would be a hostage to every other suite.
 * Same rule as `attendance-hub.e2e-spec.ts`.
 */
describe('Schedules — module hub summary (e2e)', () => {
  let ctx: E2EContext;
  let fx: ScheduleFixtures;

  const hub = (query = '', token?: string) => {
    const r = ctx.http().get(`/calendar/hub-summary${query}`);
    return token ? r.set(bearer(token)) : r;
  };

  const dataOf = async (query = '') => {
    const res = await hub(query, fx.admin.token);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupScheduleFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read it', () => {
    it('SHUB-01 admits ADMIN and HR; refuses MANAGER, EMPLOYEE and anonymous', async () => {
      expect((await hub('', fx.admin.token)).status).toBe(200);
      expect((await hub('', fx.hr.token)).status).toBe(200);
      // Deliberately narrower than the attendance hub, which admits MANAGER.
      // Schedules is an ADMIN/HR module end to end — `navConfig.ts:151-165`,
      // `permissions.ts:150-156` and `/calendar/coverage-stats` all agree, and
      // a hub that answered where the screens behind it refuse would offer
      // tiles that 403.
      expect((await hub('', fx.manager.token)).status).toBe(403);
      expect((await hub('', fx.employee.token)).status).toBe(403);
      expect((await hub()).status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('input', () => {
    it('SHUB-02 refuses a period or an anchor it does not understand', async () => {
      expect((await hub('?period=quarter', fx.admin.token)).status).toBe(400);
      expect((await hub('?anchor=last-tuesday', fx.admin.token)).status).toBe(400);
      // `Date.UTC` would roll this to 2027-02-14 and answer confidently for a
      // period nobody asked about.
      expect((await hub('?anchor=2026-13-45', fx.admin.token)).status).toBe(400);
      expect((await hub('?anchor=2026-02-30', fx.admin.token)).status).toBe(400);
    });

    it('SHUB-02b defaults to the current week when nothing is asked for', async () => {
      const d = await dataOf();
      expect(d.period).toBe('week');
      expect(d.range.isCurrent).toBe(true);
      // Monday-first, seven days.
      const start = new Date(`${d.range.start}T00:00:00Z`);
      const end = new Date(`${d.range.end}T00:00:00Z`);
      expect(start.getUTCDay()).toBe(1);
      expect((end.getTime() - start.getTime()) / 86_400_000).toBe(6);
    });

    it('SHUB-02c accepts all four periods', async () => {
      for (const period of ['today', 'week', 'month', 'year']) {
        const res = await hub(`?period=${period}`, fx.admin.token);
        expect(res.status).toBe(200);
        expect(res.body.data.period).toBe(period);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the envelope', () => {
    it('SHUB-03 carries every block the page draws', async () => {
      const d = await dataOf('?period=week');
      for (const k of [
        'period', 'anchor', 'range', 'periodStats', 'previousStats', 'previousRange',
        'trendKind', 'trend', 'shiftMix', 'status', 'staffCoverage', 'departments',
        'attention', 'holidays', 'weeklyOffDays',
      ]) {
        expect(d).toHaveProperty(k);
      }
      expect(d.attention).toHaveProperty('thinnestDay');
      expect(d.staffCoverage.hours).toHaveLength(24);
    });

    it('SHUB-03b labels the window server-side, so the client guesses nothing', async () => {
      // What "this week" means depends on the branch working week; a client
      // that assumed Monday would disagree with the numbers beside it.
      expect((await dataOf('?period=month&anchor=2026-08-15')).range.label).toBe('Aug 2026');
      expect((await dataOf('?period=year&anchor=2026-08-15')).range.label).toBe('2026');
      expect((await dataOf('?period=week&anchor=2026-08-20')).range.label).toBe('Aug 17 – 23');
    });

    it('SHUB-03c buckets a year by month and a week by day', async () => {
      const year = await dataOf('?period=year&anchor=2026-08-15');
      expect(year.trendKind).toBe('month');
      expect(year.trend).toHaveLength(12);
      expect(year.trend[7].key).toBe('2026-08');

      const week = await dataOf('?period=week&anchor=2026-08-20');
      expect(week.trendKind).toBe('day');
      expect(week.trend).toHaveLength(7);
    });

    it('SHUB-03d reports the previous window alongside the current one', async () => {
      const d = await dataOf('?period=month&anchor=2026-08-15');
      expect(d.previousRange).toMatchObject({
        start: '2026-07-01',
        end: '2026-07-31',
        label: 'Jul 2026',
      });
      // Every "vs last month" badge on the page divides these two.
      expect(typeof d.previousStats.activeHeadcount).toBe('number');
      expect(typeof d.previousStats.scheduledEmployees).toBe('number');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the numbers', () => {
    it('SHUB-04 never reports a rate above 100% or below 0%', async () => {
      for (const period of ['week', 'month', 'year']) {
        const d = await dataOf(`?period=${period}`);
        const rates = [
          d.periodStats.coverageRate,
          ...d.trend.map((b: any) => b.coverageRate),
          ...d.shiftMix.map((s: any) => s.share),
          ...d.departments.map((x: any) => x.rate),
        ].filter((r) => r !== null);
        for (const r of rates) {
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(100);
        }
      }
    });

    it('SHUB-04b reports null, never 0%, when there is nothing to divide by', async () => {
      const d = await dataOf('?period=week');
      for (const b of d.trend) {
        // A closed day expects nobody. 0% would claim everybody failed to be
        // rostered on a day the branch was shut.
        if (b.expected === 0) expect(b.coverageRate).toBeNull();
      }
      for (const dept of d.departments) {
        if (dept.headcount === 0) {
          expect(dept.rate).toBeNull();
          expect(dept.hasData).toBe(false);
        }
      }
    });

    it('SHUB-04c never reports more people scheduled than there are', async () => {
      const d = await dataOf('?period=month');
      expect(d.periodStats.scheduledEmployees).toBeLessThanOrEqual(
        d.periodStats.activeHeadcount,
      );
      expect(d.periodStats.unscheduled).toBeGreaterThanOrEqual(0);
      expect(
        d.periodStats.scheduledEmployees + d.periodStats.unscheduled,
      ).toBe(d.periodStats.activeHeadcount);
    });

    it('SHUB-06 expects nobody on a day the branch calendar is closed', async () => {
      const d = await dataOf('?period=week');
      const closed = d.trend.filter((b: any) => b.expected === 0);
      for (const b of closed) {
        // Never a negative or invented unassigned block: people rostered on a
        // closed day are a CONFLICT, counted separately.
        expect(b.unassigned).toBe(0);
      }
    });

    it('SHUB-06b never draws a negative unassigned block', async () => {
      for (const period of ['week', 'month', 'year']) {
        const d = await dataOf(`?period=${period}`);
        for (const b of d.trend) expect(b.unassigned).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the panels agree with the totals', () => {
    it('SHUB-07 the conflict total is the sum of its three kinds', async () => {
      const c = (await dataOf('?period=month')).periodStats.conflicts;
      expect(c.total).toBe(c.onHoliday + c.onWeeklyOff + c.overlaps);
    });

    it('SHUB-07b the donut never counts more people than exist', async () => {
      const d = await dataOf('?period=month');
      const s = d.status;
      expect(s.unassigned).toBe(d.periodStats.unscheduled);
      // Conflicted people are taken OUT of `assigned`, so the slices never
      // double-count somebody and the caption is a number the reader can trust.
      expect(s.assigned).toBeLessThanOrEqual(d.periodStats.scheduledEmployees);
      expect(s.assigned).toBeGreaterThanOrEqual(0);
    });

    it('SHUB-07c the shift mix names only shift types that exist', async () => {
      const d = await dataOf('?period=month');
      const known = ['MORNING', 'AFTERNOON', 'FULL_DAY', 'NIGHT', 'CUSTOM', 'FLEXIBLE'];
      for (const s of d.shiftMix) {
        // There is no EVENING in `ShiftType`; a hub that invented one would put
        // a label on a bar nothing can ever fill.
        expect(known).toContain(s.type);
        expect(s.employees).toBeGreaterThan(0);
      }
    });

    it('SHUB-07d the hourly curve reports what it left out', async () => {
      const d = await dataOf('?period=week');
      expect(typeof d.staffCoverage.flexibleExcluded).toBe('number');
      expect(d.staffCoverage.flexibleExcluded).toBeGreaterThanOrEqual(0);
      expect(d.staffCoverage.activeBaseline).toBe(d.periodStats.activeHeadcount);
      for (const h of d.staffCoverage.hours) {
        expect(h.onShift).toBeGreaterThanOrEqual(0);
      }
    });

    it('SHUB-07e coverage gaps never exceed the working days they are counted from', async () => {
      const d = await dataOf('?period=month');
      expect(d.periodStats.coverageGaps).toBeLessThanOrEqual(d.periodStats.workingDays);
      // Under three working days there is no meaningful middle to be below.
      const week = await dataOf('?period=today');
      expect(week.periodStats.coverageGaps).toBe(0);
    });

    it('SHUB-07f the thinnest day is a working day inside the window', async () => {
      const d = await dataOf('?period=month&anchor=2026-08-15');
      if (d.attention.thinnestDay) {
        expect(d.attention.thinnestDay.date >= d.range.start).toBe(true);
        expect(d.attention.thinnestDay.date <= d.range.end).toBe(true);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('paging', () => {
    it('SHUB-05 pages the period with the anchors it returned', async () => {
      const now = await dataOf('?period=month&anchor=2026-08-15');
      const back = await dataOf(`?period=month&anchor=${now.range.prevAnchor}`);

      expect(back.range.start).toBe(now.previousRange.start);
      expect(back.range.end).toBe(now.previousRange.end);
      expect(back.range.label).toBe(now.previousRange.label);
      // The window one step back must report the same totals the current window
      // already showed as "previous", or the delta badge is comparing against a
      // number nothing else on the page can reach.
      expect(back.periodStats.scheduledEmployees).toBe(now.previousStats.scheduledEmployees);
      expect(back.periodStats.activeHeadcount).toBe(now.previousStats.activeHeadcount);
    });

    it('SHUB-05b round-trips: forward from the previous anchor lands back', async () => {
      const now = await dataOf('?period=week&anchor=2026-08-20');
      const back = await dataOf(`?period=week&anchor=${now.range.prevAnchor}`);
      const forward = await dataOf(`?period=week&anchor=${back.range.nextAnchor}`);
      expect(forward.range.start).toBe(now.range.start);
      expect(forward.range.end).toBe(now.range.end);
    });

    it('SHUB-05c marks a past window as not current', async () => {
      const d = await dataOf('?period=month&anchor=2020-03-15');
      expect(d.range.isCurrent).toBe(false);
      expect(d.range.label).toBe('Mar 2020');
    });

    it('SHUB-05d lets the reader page forward, because a roster is a plan', async () => {
      // Unlike attendance, which can never look past today, "is next week
      // covered" is the question this module exists for.
      const d = await dataOf('?period=week');
      expect(d.range.hasNext).toBe(true);
      const next = await dataOf(`?period=week&anchor=${d.range.nextAnchor}`);
      expect(next.range.start > d.range.start).toBe(true);
    });

    it('SHUB-05e stops paging forward well before an empty decade', async () => {
      const far = await dataOf('?period=year&anchor=2030-01-01');
      expect(far.range.hasNext).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('branch scope', () => {
    it('SHUB-08 answers inside the caller branch envelope', async () => {
      const all = await dataOf('?period=month');
      const scoped = await hub('?period=month', fx.admin.token).set(
        'X-Branch-Id',
        fx.branchB,
      );
      expect(scoped.status).toBe(200);
      // Branch B holds a strict subset of the workforce, so its headcount can
      // never exceed the unscoped one. An equality assertion would be a hostage
      // to whatever else the database holds.
      expect(scoped.body.data.periodStats.activeHeadcount).toBeLessThanOrEqual(
        all.periodStats.activeHeadcount,
      );
    });

    it('SHUB-08b reports the weekly-off calendar of the branch being viewed', async () => {
      // Branch A rests Sat+Sun, branch B rests Thu+Fri. A hub that read a
      // company-wide setting would shade the wrong days for one of them.
      const a = await hub('?period=week', fx.admin.token).set('X-Branch-Id', fx.branchA);
      const b = await hub('?period=week', fx.admin.token).set('X-Branch-Id', fx.branchB);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.data.weeklyOffDays.sort()).toEqual([0, 6]);
      expect(b.body.data.weeklyOffDays.sort()).toEqual([4, 5]);
    });
  });
});
