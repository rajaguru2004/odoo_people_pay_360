import { describe, expect, it } from 'vitest';
import {
  daysUntilDate,
  expiryLabel,
  expiryTone,
  isExpiringWithin,
} from './contractExpiry';

/** A fixed "today" so the assertions describe arithmetic, not the clock. */
const today = new Date(Date.UTC(2026, 0, 15));

describe('daysUntilDate', () => {
  it('counts whole days forward and backward from today', () => {
    expect(daysUntilDate('2026-01-15', today)).toBe(0);
    expect(daysUntilDate('2026-01-25', today)).toBe(10);
    expect(daysUntilDate('2026-01-05', today)).toBe(-10);
  });

  it('does not zone-shift a date-only value', () => {
    // The one defect this function exists to prevent: `2026-01-15` put through
    // an instant parse is midnight UTC, which is the 14th anywhere west of
    // Greenwich — a whole day of runway invented or lost by where the reader is.
    const westOfGreenwich = new Date('2026-01-15T03:00:00.000Z');
    expect(daysUntilDate('2026-01-15', westOfGreenwich)).toBe(0);
  });

  it('ignores the time part of a full ISO timestamp', () => {
    expect(daysUntilDate('2026-02-01T23:30:00.000Z', today)).toBe(17);
  });

  it('answers null rather than a number it cannot justify', () => {
    expect(daysUntilDate(null, today)).toBeNull();
    expect(daysUntilDate(undefined, today)).toBeNull();
    expect(daysUntilDate('', today)).toBeNull();
    expect(daysUntilDate('not-a-date', today)).toBeNull();
  });
});

describe('expiryTone', () => {
  it('escalates as the date approaches', () => {
    expect(expiryTone(90)).toBe('neutral');
    expect(expiryTone(30)).toBe('warning');
    expect(expiryTone(8)).toBe('warning');
    expect(expiryTone(7)).toBe('error');
    expect(expiryTone(0)).toBe('error');
    expect(expiryTone(-3)).toBe('error');
  });

  it('takes the window from the caller, because the server owns it', () => {
    expect(expiryTone(45, 30)).toBe('neutral');
    expect(expiryTone(45, 60)).toBe('warning');
  });

  it('stays neutral for an unknown figure rather than reporting all clear', () => {
    expect(expiryTone(null)).toBe('neutral');
    expect(expiryTone(undefined)).toBe('neutral');
  });
});

describe('expiryLabel', () => {
  it('says what happened rather than printing a signed number', () => {
    expect(expiryLabel(-1)).toBe('Expired 1 day ago');
    expect(expiryLabel(-4)).toBe('Expired 4 days ago');
    expect(expiryLabel(0)).toBe('Expires today');
    expect(expiryLabel(1)).toBe('1 day left');
    expect(expiryLabel(12)).toBe('12 days left');
  });

  it('prints an em dash for a term that has no end', () => {
    expect(expiryLabel(null)).toBe('—');
  });
});

describe('isExpiringWithin', () => {
  it('covers the window ahead and nothing behind it', () => {
    expect(isExpiringWithin(30)).toBe(true);
    expect(isExpiringWithin(0)).toBe(true);
    expect(isExpiringWithin(31)).toBe(false);
    // Already lapsed is a different problem with a different fix, so it is not
    // folded into the "renew this soon" bucket.
    expect(isExpiringWithin(-1)).toBe(false);
    expect(isExpiringWithin(null)).toBe(false);
  });
});
