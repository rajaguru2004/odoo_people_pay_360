import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupAttendanceFixtures,
  AttendanceFixtures,
  pinCompanyTzToMidMorning,
} from './utils/attendance-fixtures';
import { bearer } from './utils/settings';

/**
 * `GET /attendances/hub-summary` — the Time & Attendance module hub's aggregate.
 *
 * It replaced four browser-side requests and a page of hard-coded numbers, and
 * it is the only endpoint that decides what "expected" means, so the invariants
 * below are the ones the whole dashboard rests on:
 *
 *   HUB-01  role gate — ADMIN/HR/MANAGER in, EMPLOYEE out, anonymous 401
 *   HUB-02  bad input is refused, not guessed at
 *   HUB-03  today is today whatever the period says
 *   HUB-04  nothing after today is ever aggregated
 *   HUB-05  no rate ever exceeds 100%, and an empty denominator reports null
 *   HUB-06  the anchors it returns page the period, and round-trip
 *
 * Every case is envelope- or invariant-shaped rather than count-shaped: this
 * endpoint reads the whole database inside the caller's branch envelope with no
 * per-run filter, so an absolute count would be a hostage to every other suite.
 * Same rule as `attendance-admin.e2e-spec.ts` §6.9.
 */
describe('Attendance — module hub summary (e2e)', () => {
  let ctx: E2EContext;
  let fx: AttendanceFixtures;
  let restoreTz: () => Promise<void>;

  const hub = (query = '', token?: string) => {
    const r = ctx.http().get(`/attendances/hub-summary${query}`);
    return token ? r.set(bearer(token)) : r;
  };

  const dataOf = async (query = '') => {
    const res = await hub(query, fx.admin.token);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupAttendanceFixtures(ctx);
    restoreTz = await pinCompanyTzToMidMorning(ctx);
  }, 120000);

  afterAll(async () => {
    if (restoreTz) await restoreTz();
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may read it', () => {
    it('HUB-01 admits ADMIN, HR and MANAGER; refuses EMPLOYEE and anonymous', async () => {
      expect((await hub('', fx.admin.token)).status).toBe(200);
      expect((await hub('', fx.hr.token)).status).toBe(200);
      // A manager gets it, narrowed to their departments — the hub is the
      // landing page for their own module too.
      expect((await hub('', fx.mgr.token)).status).toBe(200);
      expect((await hub('', fx.employee.token)).status).toBe(403);
      expect((await hub()).status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('input', () => {
    it('HUB-02 refuses a period or an anchor it does not understand', async () => {
      expect((await hub('?period=quarter', fx.admin.token)).status).toBe(400);
      expect((await hub('?anchor=last-tuesday', fx.admin.token)).status).toBe(400);
      expect((await hub('?anchor=2026-13-45', fx.admin.token)).status).toBe(400);
    });

    it('HUB-02b defaults to today when nothing is asked for', async () => {
      const data = await dataOf();
      // The question an HR manager opens this page with is "who is in", not
      // "how did August go".
      expect(data.period).toBe('today');
      expect(data.range.start).toBe(data.range.end);
      expect(data.range.start).toBe(data.today.date);
      expect(data.range.isCurrent).toBe(true);
      // Never a future period, so there is nothing to page forward into.
      expect(data.range.hasNext).toBe(false);
    });

    it.each(['today', 'week', 'month', 'year'])(
      'HUB-02c answers %s with a labelled range and both anchors',
      async (period) => {
        const data = await dataOf(`?period=${period}`);
        expect(data.period).toBe(period);
        expect(typeof data.range.label).toBe('string');
        expect(data.range.label.length).toBeGreaterThan(0);
        expect(data.range.prevAnchor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(data.range.nextAnchor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(data.range.start <= data.range.end).toBe(true);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the invariants the dashboard rests on', () => {
    it('HUB-03 reports the same today whatever period is asked for', async () => {
      const [day, week, month, year] = await Promise.all([
        dataOf('?period=today'),
        dataOf('?period=week'),
        dataOf('?period=month'),
        dataOf('?period=year'),
      ]);

      // The three panels at the foot of the page are about right now — who is
      // still clocked in, when people arrived — so `today` rides along in every
      // response whatever the selector says.
      expect(week.today.date).toBe(month.today.date);
      expect(month.today.date).toBe(year.today.date);
      expect(week.today.present).toBe(year.today.present);
      expect(week.today.expected).toBe(year.today.expected);
      expect(week.today.avgWorkHours).toBe(year.today.avgWorkHours);

      // `period=today` makes periodStats agree with that snapshot exactly.
      expect(day.periodStats.present).toBe(day.today.present);
      expect(day.periodStats.late).toBe(day.today.late);
      expect(day.periodStats.expected).toBe(day.today.expected);
      expect(day.periodStats.daysCounted).toBe(1);

      // ...while the longer windows are free to differ. `daysCounted` is days
      // in every period; `bucketCount` is bars, which for a year is months and
      // for a day is hours.
      expect(year.periodStats.daysCounted).toBeGreaterThanOrEqual(
        month.periodStats.daysCounted,
      );
      expect(month.periodStats.bucketCount).toBe(month.periodStats.daysCounted);
      expect(year.periodStats.bucketCount).toBeLessThanOrEqual(12);
      expect(day.periodStats.bucketCount).toBe(16); // 6 AM .. 9 PM
      expect(day.trendKind).toBe('hour');
      expect(week.trendKind).toBe('day');
      expect(year.trendKind).toBe('month');
    });

    it('HUB-03c carries the window before this one, on the same terms', async () => {
      for (const period of ['today', 'week', 'month', 'year']) {
        const data = await dataOf(`?period=${period}`);
        const prevWindow = await dataOf(
          `?period=${period}&anchor=${data.range.prevAnchor}`,
        );

        expect(data.previousRange.label).toBe(prevWindow.range.label);
        expect(data.previousRange.start).toBe(prevWindow.range.start);
        // Same numbers whether you page to it or read it inline — otherwise
        // every "vs last week" on the page would be comparing against
        // something the reader cannot navigate to and check.
        expect(data.previousStats.present).toBe(prevWindow.periodStats.present);
        expect(data.previousStats.expected).toBe(prevWindow.periodStats.expected);
        expect(data.previousStats.attendanceRate).toBe(
          prevWindow.periodStats.attendanceRate,
        );
      }
    });

    it('HUB-03b yesterday is the day before today, and settled', async () => {
      const data = await dataOf();
      const today = new Date(`${data.today.date}T00:00:00Z`);
      const expected = new Date(today.getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(data.yesterday.date).toBe(expected);
    });

    it('HUB-04 never aggregates a day that has not happened', async () => {
      for (const period of ['today', 'week', 'month', 'year']) {
        const data = await dataOf(`?period=${period}`);
        if (data.trendKind === 'hour') continue; // hour keys are not date keys
        for (const bucket of data.trend) {
          // Day buckets are date keys, month buckets are YYYY-MM; both sort
          // lexicographically against a today key trimmed to the same length.
          const cutoff = data.today.date.slice(0, bucket.key.length);
          expect(bucket.key <= cutoff).toBe(true);
        }
        if (data.range.through) {
          expect(data.range.through <= data.today.date).toBe(true);
        }
      }
    });

    it('HUB-05 never reports a rate above 100%, in any period', async () => {
      // The defect: expectation came from the branch calendar alone, so a
      // holiday people actually worked produced 106% attendance.
      for (const period of ['today', 'week', 'month', 'year']) {
        const data = await dataOf(`?period=${period}`);
        const rates = [
          data.today.presentRate,
          data.today.absentRate,
          data.today.onTimeRate,
          data.periodStats.attendanceRate,
          data.periodStats.absentRate,
          data.previousStats.attendanceRate,
          data.previousStats.absentRate,
          ...data.trend.map((b: any) => b.attendanceRate),
          ...data.departments.map((d: any) => d.rate),
        ].filter((r) => r !== null && r !== undefined);

        for (const r of rates) {
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(100);
        }
      }
    });

    it('HUB-05b reports null, never 0%, when there is nothing to divide by', async () => {
      const data = await dataOf();
      for (const bucket of data.trend) {
        if (bucket.expected === 0) {
          expect(bucket.attendanceRate).toBeNull();
        }
      }
      for (const dept of data.departments) {
        if (dept.expected === 0) expect(dept.rate).toBeNull();
        // A department with no records at all is flagged as such rather than
        // sitting at a confident 0%.
        expect(typeof dept.hasData).toBe('boolean');
      }
    });

    it('HUB-05c never counts more people present than were expected', async () => {
      for (const period of ['today', 'week', 'month', 'year']) {
        const data = await dataOf(`?period=${period}`);
        // An hour expects nobody in particular, so the identity below does not
        // apply to it — an hourly bar is sized by arrivals, not expectation.
        if (data.trendKind === 'hour') continue;
        for (const b of data.trend) {
          expect(b.present + b.onLeave).toBeLessThanOrEqual(b.expected);
          expect(b.late).toBeLessThanOrEqual(b.present);
          expect(b.onTime).toBe(Math.max(0, b.present - b.late));
          expect(b.absent).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('paging', () => {
    it('HUB-06d the same arrows step a day back on Today', async () => {
      const current = await dataOf('?period=today');
      const previous = await dataOf(`?period=today&anchor=${current.range.prevAnchor}`);

      const expectedPrev = new Date(
        new Date(`${current.range.start}T00:00:00Z`).getTime() - 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      expect(previous.range.start).toBe(expectedPrev);
      expect(previous.range.isCurrent).toBe(false);
      expect(previous.range.hasNext).toBe(true);
      // Yesterday has closed, so it reports absences the open day cannot.
      expect(previous.periodStats.daysCounted).toBe(1);
    });

    it('HUB-06 the anchors it returns move the window, and round-trip', async () => {
      const current = await dataOf('?period=month');
      const previous = await dataOf(`?period=month&anchor=${current.range.prevAnchor}`);

      expect(previous.range.start < current.range.start).toBe(true);
      expect(previous.range.isCurrent).toBe(false);
      // Off the current period, forward is available again.
      expect(previous.range.hasNext).toBe(true);

      const back = await dataOf(`?period=month&anchor=${previous.range.nextAnchor}`);
      expect(back.range.label).toBe(current.range.label);
      expect(back.range.start).toBe(current.range.start);
    });

    it('HUB-06b a period entirely in the future aggregates nothing', async () => {
      const current = await dataOf('?period=year');
      const nextYear = Number(current.range.start.slice(0, 4)) + 1;
      const data = await dataOf(`?period=year&anchor=${nextYear}-06-15`);

      expect(data.range.through).toBeNull();
      expect(data.trend).toEqual([]);
      expect(data.periodStats.expected).toBe(0);
      expect(data.periodStats.attendanceRate).toBeNull();
      // But today is still today, because the KPI cards never move.
      expect(data.today.date).toBe(current.today.date);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the panels', () => {
    it('HUB-07 carries an arrival bucket for every hour of the working window', async () => {
      const data = await dataOf();
      expect(data.arrivalPattern).toHaveLength(16); // 6 AM .. 9 PM
      expect(data.arrivalPattern[0]).toMatchObject({ hour: 6, label: '6 AM' });
      expect(data.arrivalPattern[15]).toMatchObject({ hour: 21, label: '9 PM' });
      for (const slot of data.arrivalPattern) {
        expect(slot.onTime).toBeGreaterThanOrEqual(0);
        expect(slot.late).toBeGreaterThanOrEqual(0);
      }
    });

    it('HUB-08 says whether the shift figures came from a roster or the calendar', async () => {
      for (const period of ['today', 'week', 'month']) {
        const data = await dataOf(`?period=${period}`);
        expect(['roster', 'calendar']).toContain(data.shifts.source);
        expect(data.shifts.scheduled).toBeGreaterThanOrEqual(0);
        // Window-scoped like everything else: a panel left on today while the
        // cards moved to August is the same lie in a quieter place.
        expect(data.shifts.checkedIn).toBe(data.periodStats.present);
        expect(data.shifts.late).toBe(data.periodStats.late);
        expect(data.shifts.yetToCheckIn).toBeGreaterThanOrEqual(0);
      }
    });

    it('HUB-08b every panel reads the selected window', async () => {
      const day = await dataOf('?period=today');
      const year = await dataOf('?period=year');

      // The arrival curve accumulates across the window, so a year can only
      // have MORE arrivals in it than the single day inside it.
      const total = (d: any) =>
        d.arrivalPattern.reduce((a: number, h: any) => a + h.onTime + h.late, 0);
      expect(total(year)).toBeGreaterThanOrEqual(total(day));
      expect(year.shifts.checkedIn).toBeGreaterThanOrEqual(day.shifts.checkedIn);
      expect(year.attention.late.count).toBeGreaterThanOrEqual(day.attention.late.count);
    });

    it('HUB-08c a window with no open day reports nobody unheard-from', async () => {
      // "Nobody heard from" is a statement about a day still running. Once it
      // closes those people are simply absent, and the absent item says so —
      // reporting both would double-count the same missing person.
      const current = await dataOf('?period=today');
      const past = await dataOf(`?period=today&anchor=${current.range.prevAnchor}`);

      expect(past.range.isCurrent).toBe(false);
      expect(past.attention.notCheckedIn.count).toBe(0);
      expect(past.attention.notCheckedIn.names).toEqual([]);
    });

    it('HUB-09 names the people behind each action item', async () => {
      const data = await dataOf();
      for (const bucket of ['notCheckedIn', 'notCheckedOut', 'overScheduledHours', 'late']) {
        const item = data.attention[bucket];
        expect(typeof item.count).toBe('number');
        expect(Array.isArray(item.names)).toBe(true);
        // A count without names sends the reader off to find the list; the
        // list is capped so a year-long window cannot return the whole company.
        expect(item.names.length).toBeLessThanOrEqual(12);
        expect(item.names.length).toBeLessThanOrEqual(item.count);
      }
      expect(typeof data.attention.pendingCorrections).toBe('number');

      // The cap holds at year scale too, where the counts can be large.
      const year = await dataOf('?period=year');
      for (const bucket of ['notCheckedOut', 'overScheduledHours', 'late']) {
        expect(year.attention[bucket].names.length).toBeLessThanOrEqual(12);
      }
    });

    it('HUB-09b keeps the correction queue live whatever the period says', async () => {
      // A queue is what is waiting NOW. It is the one figure on the page that
      // deliberately does not follow the selector.
      const [day, month, year] = await Promise.all([
        dataOf('?period=today'),
        dataOf('?period=month'),
        dataOf('?period=year'),
      ]);
      expect(month.attention.pendingCorrections).toBe(day.attention.pendingCorrections);
      expect(year.attention.pendingCorrections).toBe(day.attention.pendingCorrections);
    });

    it('HUB-10 ranks departments worst-first, with the silent ones last', async () => {
      const data = await dataOf();
      const reporting = data.departments.filter((d: any) => d.hasData);
      const silent = data.departments.filter((d: any) => !d.hasData);

      // Everything that reports sorts before everything that does not.
      const firstSilent = data.departments.findIndex((d: any) => !d.hasData);
      if (firstSilent !== -1) {
        expect(data.departments.slice(firstSilent).every((d: any) => !d.hasData)).toBe(
          true,
        );
      }
      expect(reporting.length + silent.length).toBe(data.departments.length);

      // Ascending attendance rate among those that report.
      const rates = reporting.map((d: any) => d.rate ?? 101);
      expect([...rates].sort((a, b) => a - b)).toEqual(rates);
    });
  });
});
