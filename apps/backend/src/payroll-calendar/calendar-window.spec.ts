import {
  defaultWindow,
  generateYear,
  isWithinPeriod,
  latenessOf,
  windowFor,
} from './calendar-window';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const at = (s: string) => new Date(s);

describe('payroll calendar window', () => {
  describe('with no calendar configured', () => {
    it('is exactly the calendar month the engine already computes', () => {
      // `payrolls.service.ts` computes this inline in six places. If the two
      // ever disagree, money moves.
      const w = defaultWindow(6, 2044);
      expect(w.periodStart).toEqual(new Date(Date.UTC(2044, 5, 1)));
      expect(w.periodEnd).toEqual(new Date(Date.UTC(2044, 6, 0)));
    });

    it('handles February in a leap year', () => {
      expect(defaultWindow(2, 2044).periodEnd.getUTCDate()).toBe(29);
      expect(defaultWindow(2, 2043).periodEnd.getUTCDate()).toBe(28);
    });

    it('reports no cut-off rather than a permissive one', () => {
      const w = windowFor(6, 2044, null);
      expect(w.fromCalendar).toBe(false);
      expect(w.cutOffDate).toBeNull();
      expect(w.enforceCutOff).toBe(false);
    });
  });

  describe('with a calendar', () => {
    const period = {
      month: 6,
      periodStart: d('2044-05-26'),
      periodEnd: d('2044-06-25'),
      cutOffDate: d('2044-06-20'),
      paymentDate: d('2044-06-30'),
      enforceCutOff: false,
    };

    it('uses the configured window, which need not be the calendar month', () => {
      // A 26th-to-25th period is a real payroll period, and being able to
      // express it is the point of the table.
      const w = windowFor(6, 2044, period);
      expect(w.periodStart).toEqual(d('2044-05-26'));
      expect(w.periodEnd).toEqual(d('2044-06-25'));
      expect(w.fromCalendar).toBe(true);
    });

    it('knows what is inside the period', () => {
      const w = windowFor(6, 2044, period);
      expect(isWithinPeriod(d('2044-06-01'), w)).toBe(true);
      expect(isWithinPeriod(d('2044-05-26'), w)).toBe(true);
      expect(isWithinPeriod(d('2044-06-25'), w)).toBe(true);
      expect(isWithinPeriod(d('2044-05-25'), w)).toBe(false);
      expect(isWithinPeriod(d('2044-06-26'), w)).toBe(false);
    });
  });

  describe('lateness', () => {
    const w = windowFor(6, 2044, {
      month: 6,
      periodStart: d('2044-06-01'),
      periodEnd: d('2044-06-30'),
      cutOffDate: d('2044-06-20'),
      paymentDate: d('2044-06-30'),
      enforceCutOff: false,
    });

    it('is on time before the cut-off', () => {
      expect(latenessOf(at('2044-06-19T10:00:00Z'), w)).toBe('ON_TIME');
    });

    it('treats the cut-off DAY as inclusive', () => {
      // Otherwise the date means "the day before the deadline", which is not how
      // anybody reads "cut-off: the 20th".
      expect(latenessOf(at('2044-06-20T23:59:00Z'), w)).toBe('ON_TIME');
    });

    it('is late the next day', () => {
      expect(latenessOf(at('2044-06-21T00:00:01Z'), w)).toBe('LATE');
    });

    it('says NO_CUTOFF rather than ON_TIME when none is configured', () => {
      // A caller must not mistake "we do not track this" for "we checked and it
      // was fine".
      const none = windowFor(6, 2044, null);
      expect(latenessOf(at('2044-06-21T00:00:00Z'), none)).toBe('NO_CUTOFF');
    });

    it('says NO_CUTOFF for an input with no recorded time', () => {
      expect(latenessOf(null, w)).toBe('NO_CUTOFF');
      expect(latenessOf(undefined, w)).toBe('NO_CUTOFF');
    });
  });

  describe('generating a year', () => {
    const year = generateYear(2044, { cutOffDay: 25, paymentDay: 28 });

    it('produces twelve periods', () => {
      expect(year).toHaveLength(12);
      expect(year.map((p) => p.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('clamps a day past the end of a short month', () => {
      const feb = generateYear(2043, { cutOffDay: 31, paymentDay: 31 })[1];
      expect(feb.cutOffDate.getUTCDate()).toBe(28);
    });

    it('satisfies every database constraint it will be checked against', () => {
      // periodEnd >= periodStart, cutOff >= periodStart, payment >= periodEnd.
      // A calendar that cannot be saved is worse than one that is approximate.
      for (const p of generateYear(2044, { cutOffDay: 5, paymentDay: 3 })) {
        expect(p.periodEnd.getTime()).toBeGreaterThanOrEqual(p.periodStart.getTime());
        expect(p.cutOffDate.getTime()).toBeGreaterThanOrEqual(p.periodStart.getTime());
        expect(p.paymentDate.getTime()).toBeGreaterThanOrEqual(p.periodEnd.getTime());
      }
    });

    it('leaves enforcement off unless asked', () => {
      expect(year.every((p) => p.enforceCutOff === false)).toBe(true);
      expect(
        generateYear(2044, { cutOffDay: 25, paymentDay: 28, enforceCutOff: true })
          .every((p) => p.enforceCutOff),
      ).toBe(true);
    });
  });
});
