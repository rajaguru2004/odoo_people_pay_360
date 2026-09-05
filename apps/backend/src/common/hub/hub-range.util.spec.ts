import { BadRequestException } from '@nestjs/common';
import {
  addDays,
  assertPeriod,
  bucketOf,
  eachDay,
  key,
  parseDateKey,
  rate,
  resolveRange,
  startOfWeek,
  trendKindFor,
} from './hub-range.util';

/**
 * The date arithmetic three module hubs now share.
 *
 * It used to live inside the attendance hub, where its 20-case spec covered it
 * through the aggregate. Pulled out, it needs pinning directly — the whole
 * reason for extracting it is that Schedules and Leave would otherwise each
 * grow their own answer to "what is the week before March 1st", and two panels
 * on one page reporting different windows is a lie the reader cannot see.
 *
 * Everything is UTC. The browser and the server are both pinned to UTC in the
 * e2e harness precisely because local-midnight arithmetic drops the 31st.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('hub-range.util', () => {
  describe('parseDateKey', () => {
    it('accepts a real date and returns UTC midnight', () => {
      const parsed = parseDateKey('2026-08-23');
      expect(parsed.toISOString()).toBe('2026-08-23T00:00:00.000Z');
    });

    it('refuses a date that Date.UTC would silently roll over', () => {
      // Month 13 is next January and day 45 a fortnight later, so this would
      // quietly become 2027-02-14 and the hub would answer confidently for a
      // period nobody asked about. The round-trip is the check.
      expect(() => parseDateKey('2026-13-45')).toThrow(BadRequestException);
    });

    it('refuses a day the month does not have', () => {
      expect(() => parseDateKey('2026-02-30')).toThrow(BadRequestException);
    });

    it('refuses anything that is not YYYY-MM-DD', () => {
      expect(() => parseDateKey('last-tuesday')).toThrow(BadRequestException);
      expect(() => parseDateKey('23/08/2026')).toThrow(BadRequestException);
    });
  });

  describe('assertPeriod', () => {
    it('accepts the four the hubs offer', () => {
      for (const p of ['today', 'week', 'month', 'year']) {
        expect(() => assertPeriod(p)).not.toThrow();
      }
    });

    it('refuses a period it does not understand rather than guessing', () => {
      expect(() => assertPeriod('quarter')).toThrow(BadRequestException);
      expect(() => assertPeriod('quarter')).toThrow(/today\|week\|month\|year/);
    });
  });

  describe('rate', () => {
    it('is null when there was nothing to divide by, never 0%', () => {
      // 0% is a claim that everybody failed; "unknown" is the truth.
      expect(rate(0, 0)).toBeNull();
      expect(rate(5, 0)).toBeNull();
    });

    it('rounds to one decimal place', () => {
      expect(rate(1, 3)).toBe(33.3);
      expect(rate(14, 20)).toBe(70);
    });
  });

  describe('startOfWeek', () => {
    it('is Monday-first, so the selector reads "Aug 17 – Aug 23"', () => {
      // 2026-08-23 is a Sunday; its week began on Monday the 17th.
      expect(key(startOfWeek(d('2026-08-23')))).toBe('2026-08-17');
      expect(key(startOfWeek(d('2026-08-17')))).toBe('2026-08-17');
    });
  });

  describe('addDays', () => {
    it('crosses a month boundary without local-time drift', () => {
      expect(key(addDays(d('2026-08-31'), 1))).toBe('2026-09-01');
      expect(key(addDays(d('2026-03-01'), -1))).toBe('2026-02-28');
    });
  });

  describe('resolveRange', () => {
    it('makes a day its own window and steps a day either side', () => {
      const r = resolveRange('today', d('2026-08-23'));
      expect([key(r.start), key(r.end)]).toEqual(['2026-08-23', '2026-08-23']);
      expect(key(r.prevAnchor)).toBe('2026-08-22');
      expect(key(r.nextAnchor)).toBe('2026-08-24');
      expect(r.label).toBe('Aug 23');
    });

    it('snaps a week to Monday–Sunday whatever day the anchor is', () => {
      const r = resolveRange('week', d('2026-08-20'));
      expect([key(r.start), key(r.end)]).toEqual(['2026-08-17', '2026-08-23']);
      expect(key(r.prevAnchor)).toBe('2026-08-10');
      expect(key(r.nextAnchor)).toBe('2026-08-24');
      expect(r.label).toBe('Aug 17 – 23');
    });

    it('names both months when a week straddles one', () => {
      const r = resolveRange('week', d('2026-09-01'));
      expect([key(r.start), key(r.end)]).toEqual(['2026-08-31', '2026-09-06']);
      expect(r.label).toBe('Aug 31 – Sep 6');
    });

    it('steps a month back to the month, not to "30 days ago"', () => {
      // The whole reason the server owns this: February is not 30 days, and a
      // client doing the arithmetic disagrees with the numbers beside it.
      const r = resolveRange('month', d('2026-03-15'));
      expect([key(r.start), key(r.end)]).toEqual(['2026-03-01', '2026-03-31']);
      expect(key(r.prevAnchor)).toBe('2026-02-01');
      expect(key(r.nextAnchor)).toBe('2026-04-01');
      expect(r.label).toBe('Mar 2026');
    });

    it('ends February on the 28th of a common year and the 29th of a leap year', () => {
      expect(key(resolveRange('month', d('2026-02-10')).end)).toBe('2026-02-28');
      expect(key(resolveRange('month', d('2028-02-10')).end)).toBe('2028-02-29');
    });

    it('makes a year January to December and pages by whole years', () => {
      const r = resolveRange('year', d('2026-08-23'));
      expect([key(r.start), key(r.end)]).toEqual(['2026-01-01', '2026-12-31']);
      expect(key(r.prevAnchor)).toBe('2025-01-01');
      expect(key(r.nextAnchor)).toBe('2027-01-01');
      expect(r.label).toBe('2026');
    });
  });

  describe('trendKindFor', () => {
    it('draws hours for a day, months for a year, days for everything between', () => {
      expect(trendKindFor('today')).toBe('hour');
      expect(trendKindFor('week')).toBe('day');
      expect(trendKindFor('month')).toBe('day');
      expect(trendKindFor('year')).toBe('month');
    });
  });

  describe('bucketOf', () => {
    it('collapses a year into months and keeps the day everywhere else', () => {
      expect(bucketOf('year', d('2026-08-23'))).toEqual({ key: '2026-08', label: 'Aug' });
      expect(bucketOf('month', d('2026-08-23'))).toEqual({ key: '2026-08-23', label: 'Aug 23' });
      expect(bucketOf('week', d('2026-08-03'))).toEqual({ key: '2026-08-03', label: 'Aug 3' });
    });
  });

  describe('eachDay', () => {
    it('is inclusive at both ends', () => {
      const days = eachDay(d('2026-08-17'), d('2026-08-23')).map(key);
      expect(days).toHaveLength(7);
      expect(days[0]).toBe('2026-08-17');
      expect(days[6]).toBe('2026-08-23');
    });

    it('returns the single day when start and end are the same', () => {
      expect(eachDay(d('2026-08-23'), d('2026-08-23')).map(key)).toEqual(['2026-08-23']);
    });

    it('returns nothing when the window is inverted, rather than looping forever', () => {
      expect(eachDay(d('2026-08-23'), d('2026-08-17'))).toEqual([]);
    });
  });
});
