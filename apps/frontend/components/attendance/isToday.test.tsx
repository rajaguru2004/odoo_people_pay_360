import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { todayStr } from '@/utils/tzDate';

/**
 * Finding F19 — "today" resolved in the wrong timezone.
 *
 * Six attendance sites used to answer the question "which day is it?" with
 *
 *     new Date().toISOString().split('T')[0]
 *
 * which takes a real INSTANT and reads its UTC calendar date. That is only the
 * user's day when the user is on UTC. At any positive offset it is yesterday
 * for the whole window between local midnight and the offset — 00:00–05:29 at
 * Asia/Kolkata — so for five and a half hours out of every twenty-four:
 *
 *   - the overview's default date range started and ended a day early, and
 *   - the four `isToday` comparisons said "not today" about today, quietly
 *     switching the stat tiles and the live feed into their historical mode.
 *
 * It survived because `e2e/playwright.config.ts` pins `timezoneId: 'UTC'`,
 * where the bug cannot occur — no browser test could ever have seen it. This
 * file is deliberately the opposite: it FAKES THE CLOCK to sit inside the
 * broken window, so it fails against the old expression and passes against
 * `todayStr()`, which resolves the display timezone.
 *
 * The assertions are on the helper rather than on a rendered screen on purpose.
 * The rule under test is "which string does the app call today", and that is a
 * pure question — rendering four components to ask it would be slower and would
 * couple the regression to their markup.
 */

/** The old, broken expression, kept verbatim so the contrast is explicit. */
const utcDateOfNow = () => new Date().toISOString().split('T')[0];

describe('F19 — "today" is the user’s day, not the UTC day', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /**
   * 02:00 in a UTC+5:30 zone is 20:30 UTC on the PREVIOUS day — the exact
   * window the bug lived in.
   */
  it('inside the broken window, the UTC date is a day behind the local date', () => {
    // 2026-08-16T02:00 at +05:30 === 2026-08-15T20:30Z
    vi.setSystemTime(new Date('2026-08-15T20:30:00.000Z'));

    expect(utcDateOfNow()).toBe('2026-08-15');
    // The helper the screens now use, asked for the same moment in the zone the
    // user is actually in.
    expect(todayStr('Asia/Kolkata')).toBe('2026-08-16');
    // Which is the whole point: the two disagree, and the old code took the
    // wrong one.
    expect(todayStr('Asia/Kolkata')).not.toBe(utcDateOfNow());
  });

  it('outside the window the two agree, which is why it hid for 18 hours a day', () => {
    // 14:00 at +05:30 === 08:30Z — same calendar day either way.
    vi.setSystemTime(new Date('2026-08-16T08:30:00.000Z'));

    expect(utcDateOfNow()).toBe('2026-08-16');
    expect(todayStr('Asia/Kolkata')).toBe('2026-08-16');
  });

  /** Negative offsets break in the mirror-image window: late evening local. */
  it('a negative offset is wrong late in the local evening', () => {
    // 2026-08-15T21:00 at -05:00 === 2026-08-16T02:00Z
    vi.setSystemTime(new Date('2026-08-16T02:00:00.000Z'));

    expect(utcDateOfNow()).toBe('2026-08-16');
    expect(todayStr('America/New_York')).toBe('2026-08-15');
    expect(todayStr('America/New_York')).not.toBe(utcDateOfNow());
  });

  it('on UTC itself the two never disagree — which is why the browser suite could not catch it', () => {
    for (const instant of [
      '2026-08-16T00:01:00.000Z',
      '2026-08-16T12:00:00.000Z',
      '2026-08-16T23:59:00.000Z',
    ]) {
      vi.setSystemTime(new Date(instant));
      expect(todayStr('UTC')).toBe(utcDateOfNow());
    }
  });
});
