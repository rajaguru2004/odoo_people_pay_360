import {
  buildWorkforceTrend,
  monthKey,
  monthLabel,
  trendMonthKeys,
  trendWindowEnd,
  trendWindowStart,
} from './workforce-trend.util';

/** A fixed "now" so a test never depends on the month it is run in. */
const NOW = new Date('2026-09-05T09:30:00.000Z');

/** Midnight UTC, the way Prisma hands back a `@db.Date` column. */
const dateOnly = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('month keys and labels', () => {
  it('reads a date-only value in UTC', () => {
    expect(monthKey(dateOnly('2026-01-01'))).toBe('2026-01');
    expect(monthKey(dateOnly('2026-12-31'))).toBe('2026-12');
  });

  it('renders the label the browser is not allowed to compute', () => {
    expect(monthLabel('2026-08')).toBe('Aug 2026');
    expect(monthLabel('2025-01')).toBe('Jan 2025');
  });

  it('ends the window on the current month', () => {
    expect(trendMonthKeys(6, NOW)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
  });

  it('rolls back across a year boundary', () => {
    expect(trendMonthKeys(12, NOW)[0]).toBe('2025-10');
    expect(trendMonthKeys(12, NOW)).toHaveLength(12);
  });

  it('bounds the query at the first of the opening month, exclusive of next', () => {
    expect(trendWindowStart(6, NOW).toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
    expect(trendWindowEnd(NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('buildWorkforceTrend — buckets', () => {
  it('produces one bucket per month, labelled and in order', () => {
    const trend = buildWorkforceTrend({
      months: 6,
      hireDates: [],
      exitDates: [],
      currentHeadcount: 0,
      now: NOW,
    });

    expect(trend.buckets).toHaveLength(6);
    expect(trend.buckets.map((b) => b.key)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    expect(trend.buckets[0].label).toBe('Apr 2026');
    expect(trend.buckets[5].label).toBe('Sep 2026');
  });

  it('counts joiners and leavers into their own month', () => {
    const trend = buildWorkforceTrend({
      months: 3,
      hireDates: [
        dateOnly('2026-09-01'),
        dateOnly('2026-09-28'),
        dateOnly('2026-08-15'),
      ],
      exitDates: [dateOnly('2026-08-31'), dateOnly('2026-08-02')],
      currentHeadcount: 10,
      now: NOW,
    });

    expect(trend.buckets.map((b) => [b.joiners, b.leavers, b.net])).toEqual([
      [0, 0, 0],
      [1, 2, -1],
      [2, 0, 2],
    ]);
  });

  it('ignores a date that falls outside the window', () => {
    const trend = buildWorkforceTrend({
      months: 3,
      hireDates: [dateOnly('2024-05-10'), dateOnly('2026-09-10')],
      exitDates: [],
      currentHeadcount: 4,
      now: NOW,
    });

    expect(trend.buckets.reduce((n, b) => n + b.joiners, 0)).toBe(1);
  });
});

describe('buildWorkforceTrend — the backwards walk', () => {
  it('anchors the last bucket to today and undoes each net going back', () => {
    const trend = buildWorkforceTrend({
      months: 3,
      hireDates: [dateOnly('2026-09-04'), dateOnly('2026-09-05')],
      exitDates: [dateOnly('2026-08-20')],
      currentHeadcount: 20,
      now: NOW,
    });

    // September closes at today's 20; undoing its two hires puts August at 18,
    // and undoing August's single leaver puts July one higher again.
    expect(trend.buckets.map((b) => b.headcountEnd)).toEqual([19, 18, 20]);
  });

  it('reports null rather than clamping when the walk would go negative', () => {
    const trend = buildWorkforceTrend({
      months: 3,
      hireDates: [
        dateOnly('2026-09-01'),
        dateOnly('2026-09-02'),
        dateOnly('2026-09-03'),
        dateOnly('2026-09-04'),
        dateOnly('2026-09-05'),
      ],
      exitDates: [],
      currentHeadcount: 1,
      now: NOW,
    });

    expect(trend.buckets.map((b) => b.headcountEnd)).toEqual([null, null, 1]);
  });

  it('sums net movement across the whole window', () => {
    const trend = buildWorkforceTrend({
      months: 3,
      hireDates: [dateOnly('2026-07-01'), dateOnly('2026-09-01')],
      exitDates: [dateOnly('2026-08-01')],
      currentHeadcount: 6,
      now: NOW,
    });

    expect(trend.netChange).toBe(1);
  });
});

describe('buildWorkforceTrend — growthPct', () => {
  it('measures the window against the headcount it opened with', () => {
    const trend = buildWorkforceTrend({
      months: 2,
      hireDates: [dateOnly('2026-08-10'), dateOnly('2026-09-10')],
      exitDates: [],
      currentHeadcount: 12,
      now: NOW,
    });

    // Opened at 10, closed at 12.
    expect(trend.growthPct).toBe(20);
  });

  it('is null when the first bucket has no headcount to walk back from', () => {
    const trend = buildWorkforceTrend({
      months: 3,
      hireDates: [
        dateOnly('2026-09-01'),
        dateOnly('2026-09-02'),
        dateOnly('2026-09-03'),
      ],
      exitDates: [],
      currentHeadcount: 1,
      now: NOW,
    });

    expect(trend.buckets[0].headcountEnd).toBeNull();
    expect(trend.growthPct).toBeNull();
  });

  it('is null, not zero, when the window opened with nobody', () => {
    const trend = buildWorkforceTrend({
      months: 2,
      hireDates: [
        dateOnly('2026-09-01'),
        dateOnly('2026-09-02'),
        dateOnly('2026-09-03'),
      ],
      exitDates: [],
      currentHeadcount: 3,
      now: NOW,
    });

    expect(trend.buckets[0].headcountEnd).toBe(0);
    expect(trend.netChange).toBe(3);
    expect(trend.growthPct).toBeNull();
  });

  it('reports a real zero when the organisation genuinely did not move', () => {
    const trend = buildWorkforceTrend({
      months: 3,
      hireDates: [dateOnly('2026-08-01')],
      exitDates: [dateOnly('2026-09-01')],
      currentHeadcount: 10,
      now: NOW,
    });

    expect(trend.growthPct).toBe(0);
  });
});
