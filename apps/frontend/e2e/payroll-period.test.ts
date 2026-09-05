import { describe, it, expect } from 'vitest';
import {
  PAYROLL_EDGE_YEARS,
  PAYROLL_EDGE_PAST_YEARS,
  pastEdgePeriod,
  periodKey,
  periodAt,
  edgePeriod,
  dateIn,
  lastDayOf,
  type Period,
} from './payroll-period';

/**
 * The period arithmetic the `payroll-edge-*` specs address their runs with.
 *
 * This is layer 0 on purpose. Every rule here is a property of a pure function,
 * and `docs/TESTING.md` is explicit that putting such a rule in a browser test
 * makes the suite slow without making it stronger. The cases that matter are the
 * ones a spec would otherwise discover as a mystery collision six months later:
 * the year wrap, the band boundary, and February.
 */

const P = (month: number, year: number): Period => ({ month, year });

describe('periodKey', () => {
  it('orders two periods in the same year', () => {
    expect(periodKey(P(3, 2044))).toBeLessThan(periodKey(P(4, 2044)));
  });

  it('orders December before the following January', () => {
    expect(periodKey(P(12, 2044))).toBeLessThan(periodKey(P(1, 2045)));
  });

  it('is the same formula the server uses to order periods', () => {
    // The server orders a period as `year * 12 + month`. If this drifts, a
    // teardown sorted by it stops being "newest period first" and unlock 409s.
    expect(periodKey(P(7, 2044))).toBe(2044 * 12 + 7);
  });
});

describe('periodAt', () => {
  it('an offset of zero is the period itself', () => {
    expect(periodAt(P(5, 2044), 0)).toEqual(P(5, 2044));
  });

  it('steps forward within a year', () => {
    expect(periodAt(P(5, 2044), 3)).toEqual(P(8, 2044));
  });

  it('wraps December into January of the next year', () => {
    expect(periodAt(P(12, 2044), 1)).toEqual(P(1, 2045));
  });

  it('wraps a whole year', () => {
    expect(periodAt(P(1, 2044), 13)).toEqual(P(2, 2045));
  });

  it('steps backwards across a year boundary', () => {
    // Arrears sweeps look BACK from the current run, so a negative offset is not
    // a hypothetical: `edgePeriod(n)` minus two periods must not land in month 0
    // or month -1, which is what a naive modulo produces.
    expect(periodAt(P(1, 2045), -1)).toEqual(P(12, 2044));
    expect(periodAt(P(2, 2045), -3)).toEqual(P(11, 2044));
  });

  it('round-trips: forward n then back n is where it started', () => {
    for (const n of [1, 5, 12, 13, 25]) {
      expect(periodAt(periodAt(P(6, 2044), n), -n)).toEqual(P(6, 2044));
    }
  });
});

describe('edgePeriod', () => {
  it('index 0 is January of the first year in the band', () => {
    expect(edgePeriod(0)).toEqual(P(1, PAYROLL_EDGE_YEARS.first));
  });

  it('index 12 is January of the second year', () => {
    expect(edgePeriod(12)).toEqual(P(1, PAYROLL_EDGE_YEARS.first + 1));
  });

  it('the last valid index is December of the last year', () => {
    const span = (PAYROLL_EDGE_YEARS.last - PAYROLL_EDGE_YEARS.first + 1) * 12;
    expect(edgePeriod(span - 1)).toEqual(P(12, PAYROLL_EDGE_YEARS.last));
  });

  it('every index in the band is distinct — two specs cannot silently share a month', () => {
    const span = (PAYROLL_EDGE_YEARS.last - PAYROLL_EDGE_YEARS.first + 1) * 12;
    const keys = new Set(Array.from({ length: span }, (_, i) => periodKey(edgePeriod(i))));
    expect(keys.size).toBe(span);
  });

  it('every index in the band stays inside the band', () => {
    const span = (PAYROLL_EDGE_YEARS.last - PAYROLL_EDGE_YEARS.first + 1) * 12;
    for (let i = 0; i < span; i++) {
      const p = edgePeriod(i);
      expect(p.year).toBeGreaterThanOrEqual(PAYROLL_EDGE_YEARS.first);
      expect(p.year).toBeLessThanOrEqual(PAYROLL_EDGE_YEARS.last);
      expect(p.month).toBeGreaterThanOrEqual(1);
      expect(p.month).toBeLessThanOrEqual(12);
    }
  });

  it('REFUSES to wrap past the band rather than colliding with another family', () => {
    const span = (PAYROLL_EDGE_YEARS.last - PAYROLL_EDGE_YEARS.first + 1) * 12;
    // Silently returning 2047 here is the F35 collision all over again, so the
    // refusal is the behaviour under test — and it must say what to do instead.
    expect(() => edgePeriod(span)).toThrow(/outside the payroll-edge band/i);
    expect(() => edgePeriod(span)).toThrow(/branch register/i);
    expect(() => edgePeriod(-1)).toThrow(/outside the payroll-edge band/i);
  });

  it('refuses a non-integer index instead of producing a fractional month', () => {
    expect(() => edgePeriod(1.5)).toThrow(/outside the payroll-edge band/i);
  });
});

describe('dateIn', () => {
  it('zero-pads the month and the day', () => {
    expect(dateIn(P(3, 2044), 1)).toBe('2044-03-01');
  });

  it('leaves two-digit values alone', () => {
    expect(dateIn(P(11, 2044), 25)).toBe('2044-11-25');
  });
});

describe('lastDayOf', () => {
  it('knows the 31-day months', () => {
    expect(lastDayOf(P(1, 2044))).toBe(31);
    expect(lastDayOf(P(12, 2044))).toBe(31);
  });

  it('knows the 30-day months', () => {
    expect(lastDayOf(P(4, 2044))).toBe(30);
    expect(lastDayOf(P(11, 2044))).toBe(30);
  });

  it('February in a leap year has 29 days', () => {
    // 2044 IS a leap year, and it is the first year of this family's band — so
    // "a joiner on the final day of the period" in Feb 2044 is the 29th, and a
    // spec that hard-coded 28 would silently test the wrong boundary.
    expect(lastDayOf(P(2, 2044))).toBe(29);
  });

  it('February in a common year has 28 days', () => {
    expect(lastDayOf(P(2, 2045))).toBe(28);
    expect(lastDayOf(P(2, 2046))).toBe(28);
  });

  it('is computed in UTC, so the runner’s zone cannot move it', () => {
    // The Playwright config pins the browser to UTC and the webServer to TZ=UTC
    // for exactly this class of bug. A local-time Date here would put the last
    // day of a month one day out west of Greenwich.
    expect(lastDayOf(P(2, 2044))).toBe(29);
    expect(dateIn(P(2, 2044), lastDayOf(P(2, 2044)))).toBe('2044-02-29');
  });
});

describe('pastEdgePeriod — the second band', () => {
  it('index 0 is January of the first past year', () => {
    expect(pastEdgePeriod(0)).toEqual(P(1, PAYROLL_EDGE_PAST_YEARS.first));
  });

  it('the last valid index is December of the last past year', () => {
    const span = (PAYROLL_EDGE_PAST_YEARS.last - PAYROLL_EDGE_PAST_YEARS.first + 1) * 12;
    expect(pastEdgePeriod(span - 1)).toEqual(P(12, PAYROLL_EDGE_PAST_YEARS.last));
  });

  it('refuses to wrap past its band, naming the band', () => {
    const span = (PAYROLL_EDGE_PAST_YEARS.last - PAYROLL_EDGE_PAST_YEARS.first + 1) * 12;
    expect(() => pastEdgePeriod(span)).toThrow(/outside the payroll-edge PAST band/i);
    expect(() => pastEdgePeriod(-1)).toThrow(/outside the payroll-edge PAST band/i);
  });

  it('the past band really is in the past, and the main band really is not', () => {
    // The whole reason two bands exist. `attendance-corrections.service.ts:74`
    // refuses any correction dated after today, so a case that files one must
    // run here; everything else prefers the far-future band, where no other
    // spec family's payroll run can reach its employees.
    expect(PAYROLL_EDGE_PAST_YEARS.last).toBeLessThan(2026);
    expect(PAYROLL_EDGE_YEARS.first).toBeGreaterThan(2026);
  });

  it('starts after makeEmployee’s default startDate, so an employee exists to pay', () => {
    // `makeEmployee` defaults `startDate: '2020-01-01'`. A period before that is
    // a period the employee had not joined for, which pays nothing and would
    // make a "no effect" assertion pass for the wrong reason.
    expect(PAYROLL_EDGE_PAST_YEARS.first).toBeGreaterThan(2020);
  });

  it('the two bands cannot overlap', () => {
    const future = new Set(
      Array.from({ length: (PAYROLL_EDGE_YEARS.last - PAYROLL_EDGE_YEARS.first + 1) * 12 },
        (_, i) => periodKey(edgePeriod(i))));
    const past = Array.from(
      { length: (PAYROLL_EDGE_PAST_YEARS.last - PAYROLL_EDGE_PAST_YEARS.first + 1) * 12 },
      (_, i) => periodKey(pastEdgePeriod(i)));
    expect(past.some((k) => future.has(k))).toBe(false);
  });
});
