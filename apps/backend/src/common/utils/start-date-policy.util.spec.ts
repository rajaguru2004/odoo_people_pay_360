import {
  DEFAULT_START_DATE_POLICY,
  MIN_EMPLOYMENT_AGE_YEARS,
  StartDatePolicy,
  checkEmploymentStartDate,
  parseDateOnlyUTC,
} from './start-date-policy.util';

// Frozen "today" so every boundary below is exact.
const NOW = new Date(Date.UTC(2026, 7, 11)); // 2026-08-11

const policy = (over: Partial<StartDatePolicy> = {}): StartDatePolicy => ({
  ...DEFAULT_START_DATE_POLICY,
  ...over,
});

const check = (
  startDate: string | Date | null | undefined,
  over: Partial<StartDatePolicy> = {},
  dateOfBirth?: string | Date | null,
  now: Date = NOW,
) =>
  checkEmploymentStartDate({
    startDate,
    dateOfBirth,
    policy: policy(over),
    now,
  });

/** UTC day offset from the frozen NOW, as YYYY-MM-DD. */
const daysFromNow = (days: number) => {
  const d = new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
};

describe('checkEmploymentStartDate', () => {
  describe('backdating (the point of the feature)', () => {
    it('accepts a start date 3 years ago under the default policy', () => {
      expect(check('2023-08-11').ok).toBe(true);
    });

    it('accepts a start date 5 years ago under the default policy', () => {
      expect(check('2021-08-11').ok).toBe(true);
    });

    it('accepts a previous-year start date typical of late onboarding', () => {
      expect(check('2019-03-04').ok).toBe(true);
    });

    it.each([[null], [0]])(
      'treats maxPastDays=%p as unrestricted',
      (maxPastDays) => {
        expect(check('1971-01-01', { maxPastDays }).ok).toBe(true);
      },
    );
  });

  describe('past bound when configured', () => {
    it('accepts a date exactly maxPastDays ago (inclusive)', () => {
      const res = check(daysFromNow(-365), { maxPastDays: 365 });
      expect(res.ok).toBe(true);
    });

    it('rejects one day beyond maxPastDays', () => {
      const res = check(daysFromNow(-366), { maxPastDays: 365 });
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.code).toBe('START_DATE_TOO_FAR_PAST');
    });

    it('rejects 5 years ago once a 365-day window is configured', () => {
      const res = check('2021-08-11', { maxPastDays: 365 });
      expect(res.ok === false && res.code).toBe('START_DATE_TOO_FAR_PAST');
    });
  });

  describe('leap days', () => {
    it('keeps 2024-02-29 exactly, with no Feb-28 / Mar-1 drift', () => {
      const res = check('2024-02-29');
      expect(res.ok).toBe(true);
      expect(res.ok && res.date.toISOString()).toBe(
        '2024-02-29T00:00:00.000Z',
      );
    });

    it('counts a leap-spanning window in days, not calendar years', () => {
      // 2024-02-29 -> 2026-08-11 is 894 days.
      expect(check('2024-02-29', { maxPastDays: 894 }).ok).toBe(true);
      expect(check('2024-02-29', { maxPastDays: 893 }).ok).toBe(false);
    });

    it('rejects 2025-02-29, which does not exist', () => {
      const res = check('2025-02-29');
      expect(res.ok === false && res.code).toBe('START_DATE_INVALID');
    });
  });

  describe('timezone independence', () => {
    // Guards the old local-vs-UTC mix: the boundary must not shift by a day
    // depending on where the server happens to run.
    const originalTz = process.env.TZ;
    afterEach(() => {
      process.env.TZ = originalTz;
    });

    it.each(['Pacific/Kiritimati', 'Pacific/Niue', 'UTC'])(
      'gives the same verdict under TZ=%s',
      (tz) => {
        process.env.TZ = tz;
        expect(check(daysFromNow(-365), { maxPastDays: 365 }).ok).toBe(true);
        expect(check(daysFromNow(-366), { maxPastDays: 365 }).ok).toBe(false);
        expect(check(daysFromNow(180)).ok).toBe(true);
        expect(check(daysFromNow(181)).ok).toBe(false);
      },
    );
  });

  describe('future bound', () => {
    it('accepts a date exactly at the future cap', () => {
      expect(check(daysFromNow(180)).ok).toBe(true);
    });

    it('rejects one day past the future cap', () => {
      const res = check(daysFromNow(181));
      expect(res.ok === false && res.code).toBe('START_DATE_TOO_FAR_FUTURE');
    });

    it('rejects a far-future typo', () => {
      const res = check('2099-01-01');
      expect(res.ok === false && res.code).toBe('START_DATE_TOO_FAR_FUTURE');
    });

    it('counts the cap in days, so month-end cannot overflow', () => {
      // The old `new Date(y, m + 6, d)` turned Aug 31 + 6 months into Mar 3.
      const aug31 = new Date(Date.UTC(2026, 7, 31));
      expect(
        check('2027-02-27', { maxFutureDays: 180 }, undefined, aug31).ok,
      ).toBe(true);
      expect(
        check('2027-03-03', { maxFutureDays: 180 }, undefined, aug31).ok,
      ).toBe(false);
    });

    it('allows today but not tomorrow when maxFutureDays is 0', () => {
      expect(check(daysFromNow(0), { maxFutureDays: 0 }).ok).toBe(true);
      expect(check(daysFromNow(1), { maxFutureDays: 0 }).ok).toBe(false);
    });
  });

  describe('floor', () => {
    it('rejects a date below the floor', () => {
      const res = check('1969-12-31');
      expect(res.ok === false && res.code).toBe('START_DATE_BELOW_FLOOR');
    });

    it('rejects an absurd year typed into the date field', () => {
      const res = check('0202-05-01');
      expect(res.ok === false && res.code).toBe('START_DATE_BELOW_FLOOR');
    });
  });

  describe('birth and minimum age', () => {
    const dob = '1999-04-02';

    it('rejects a start date before the date of birth', () => {
      const res = check('1998-01-01', {}, dob);
      expect(res.ok === false && res.code).toBe('START_DATE_BEFORE_BIRTH');
    });

    it('rejects a start date before the 18th birthday', () => {
      const res = check('2015-06-01', {}, dob);
      expect(res.ok === false && res.code).toBe('START_DATE_BEFORE_MIN_AGE');
    });

    it('accepts a start date on the 18th birthday', () => {
      expect(check('2017-04-02', {}, dob).ok).toBe(true);
    });

    it('rejects the day before the 18th birthday', () => {
      const res = check('2017-04-01', {}, dob);
      expect(res.ok === false && res.code).toBe('START_DATE_BEFORE_MIN_AGE');
    });

    it('skips the birth and age rules when no DOB is supplied', () => {
      expect(check('2010-01-01').ok).toBe(true);
    });

    it('uses the shared minimum-age constant', () => {
      expect(DEFAULT_START_DATE_POLICY.minAgeYears).toBe(
        MIN_EMPLOYMENT_AGE_YEARS,
      );
    });
  });

  describe('malformed input', () => {
    it.each([
      [''],
      ['   '],
      ['not-a-date'],
      ['2026-13-45'],
      ['31/12/2025'],
      [null],
      [undefined],
    ])('rejects %p without throwing', (value) => {
      const res = check(value as any);
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.code).toBe('START_DATE_INVALID');
    });

    it('accepts a Date object and normalises it to UTC midnight', () => {
      const res = check(new Date(Date.UTC(2024, 0, 15)));
      expect(res.ok).toBe(true);
      expect(res.ok && res.date.toISOString()).toBe(
        '2024-01-15T00:00:00.000Z',
      );
    });
  });
});

describe('parseDateOnlyUTC', () => {
  it('strips the time component', () => {
    expect(parseDateOnlyUTC('2026-03-04T17:45:00.000Z')?.toISOString()).toBe(
      '2026-03-04T00:00:00.000Z',
    );
  });

  it('returns null for junk instead of throwing', () => {
    expect(parseDateOnlyUTC('nope')).toBeNull();
    expect(parseDateOnlyUTC(new Date('nope'))).toBeNull();
    expect(parseDateOnlyUTC(null)).toBeNull();
  });
});
