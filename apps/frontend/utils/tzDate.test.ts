import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildUTCFromLocal,
  formatDateInTZ,
  formatInTZ,
  formatTimeInTZ,
  getBusinessTZ,
  getDisplayTZ,
  nowInTZ,
  todayStr,
  toLocalDateStr,
  toLocalTimeStr,
  utcOffsetLabel,
} from './tzDate';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';

/**
 * Timezone display, which is where "the timestamp is right but the day is
 * wrong" bugs live.
 *
 * Instants are stored UTC. What the employee sees must be rendered in *their*
 * zone, and what an admin report shows must be rendered in the *company's* —
 * two different answers from the same instant. Getting the date-only boundary
 * wrong moves an attendance record to the neighbouring day, which changes the
 * month it is paid in.
 *
 * These tests always pass an explicit `tz` where the assertion is about the
 * conversion, and drive the stores only where the assertion is about the
 * fallback chain. Nothing here depends on the machine's local zone.
 */

const brandingSnapshot = useBrandingStore.getState().branding;

function setUser(partial: Record<string, unknown> | null) {
  useAuthStore.setState({ user: partial as never, isAuthenticated: !!partial });
}

function setSystemTZ(tz: string) {
  useBrandingStore.setState({ branding: { ...brandingSnapshot, system_timezone: tz } });
}

beforeEach(() => {
  setUser(null);
  setSystemTZ('Asia/Kolkata');
});

afterEach(() => {
  useBrandingStore.setState({ branding: brandingSnapshot });
  setUser(null);
});

describe('getDisplayTZ — the personal fallback chain', () => {
  it('prefers the user’s own timezone', () => {
    setSystemTZ('Asia/Kolkata');
    setUser({ timezone: 'Asia/Muscat' });
    expect(getDisplayTZ()).toBe('Asia/Muscat');
  });

  it('reads the timezone off the nested employee when the top level lacks it', () => {
    setUser({ employee: { timezone: 'Europe/London' } });
    expect(getDisplayTZ()).toBe('Europe/London');
  });

  it('falls back to the company timezone when the user has none', () => {
    setSystemTZ('Asia/Muscat');
    setUser({ timezone: null });
    expect(getDisplayTZ()).toBe('Asia/Muscat');
  });

  it('falls back to Asia/Kolkata when nothing is configured', () => {
    setSystemTZ('');
    setUser(null);
    expect(getDisplayTZ()).toBe('Asia/Kolkata');
  });

  it('rejects an invalid zone rather than rendering every time as "—"', () => {
    // A hand-edited or migrated bad value must degrade to a working default,
    // not poison every timestamp on the screen.
    setUser({ timezone: 'Mars/Olympus_Mons' });
    expect(getDisplayTZ()).toBe('Asia/Kolkata');
  });
});

describe('getBusinessTZ — never personal', () => {
  it('ignores the user’s timezone entirely', () => {
    // The distinction that matters: an admin in London reading an attendance
    // report must see the office’s hours, not their own.
    setSystemTZ('Asia/Kolkata');
    setUser({ timezone: 'Europe/London' });
    expect(getBusinessTZ()).toBe('Asia/Kolkata');
    expect(getDisplayTZ()).toBe('Europe/London');
  });

  it('falls back to Asia/Kolkata for an absent or invalid company zone', () => {
    setSystemTZ('');
    expect(getBusinessTZ()).toBe('Asia/Kolkata');
    setSystemTZ('Not/AZone');
    expect(getBusinessTZ()).toBe('Asia/Kolkata');
  });
});

describe('formatInTZ', () => {
  const instant = '2026-03-09T18:30:00.000Z';

  it('renders the same instant differently per zone', () => {
    expect(formatInTZ(instant, 'HH:mm', 'UTC')).toBe('18:30');
    expect(formatInTZ(instant, 'HH:mm', 'Asia/Kolkata')).toBe('00:00');
    expect(formatInTZ(instant, 'HH:mm', 'Asia/Muscat')).toBe('22:30');
  });

  it('rolls the DATE forward when the zone pushes past midnight', () => {
    // The costly case: 18:30 UTC is already the 10th in Kolkata. An attendance
    // row rendered on the wrong day lands in the wrong payroll month.
    expect(formatInTZ(instant, 'yyyy-MM-dd', 'UTC')).toBe('2026-03-09');
    expect(formatInTZ(instant, 'yyyy-MM-dd', 'Asia/Kolkata')).toBe('2026-03-10');
  });

  it('rolls the date backward for a western zone', () => {
    expect(formatInTZ('2026-03-09T02:00:00.000Z', 'yyyy-MM-dd', 'America/New_York')).toBe('2026-03-08');
  });

  it('accepts a Date as well as a string, treating it as the same instant', () => {
    expect(formatInTZ(new Date(instant), 'HH:mm', 'UTC')).toBe(formatInTZ(instant, 'HH:mm', 'UTC'));
  });

  it('returns an em dash for empty input rather than "Invalid DateTime"', () => {
    for (const value of [null, undefined, '']) {
      expect(formatInTZ(value, 'HH:mm', 'UTC')).toBe('—');
    }
  });

  it('returns an em dash for an unparseable string', () => {
    expect(formatInTZ('not-a-date', 'HH:mm', 'UTC')).toBe('—');
  });

  it('returns an em dash for an invalid zone instead of throwing', () => {
    expect(formatInTZ('2026-03-09T18:30:00.000Z', 'HH:mm', 'Mars/Olympus_Mons')).toBe('—');
  });

  it('uses the display TZ when none is passed', () => {
    setUser({ timezone: 'Asia/Muscat' });
    expect(formatInTZ(instant, 'HH:mm')).toBe('22:30');
  });
});

describe('formatTimeInTZ / formatDateInTZ', () => {
  const instant = '2026-03-09T18:30:00.000Z';

  it('formatTimeInTZ is HH:mm', () => {
    expect(formatTimeInTZ(instant, 'UTC')).toBe('18:30');
  });

  it('formatDateInTZ is dd MMM yyyy', () => {
    expect(formatDateInTZ(instant, 'UTC')).toBe('09 Mar 2026');
  });

  it('both degrade to an em dash on empty input', () => {
    expect(formatTimeInTZ(null, 'UTC')).toBe('—');
    expect(formatDateInTZ(null, 'UTC')).toBe('—');
  });
});

describe('toLocalDateStr — the date-only boundary', () => {
  it('returns the calendar date as seen in the target zone', () => {
    expect(toLocalDateStr('2026-03-09T18:30:00.000Z', 'UTC')).toBe('2026-03-09');
    expect(toLocalDateStr('2026-03-09T18:30:00.000Z', 'Asia/Kolkata')).toBe('2026-03-10');
    expect(toLocalDateStr('2026-03-09T02:00:00.000Z', 'America/New_York')).toBe('2026-03-08');
  });

  it('returns an EMPTY string, not an em dash, for missing input', () => {
    // Different contract from the formatters on purpose: this value feeds date
    // inputs and query strings, where '—' would be sent to the API.
    for (const value of [null, undefined, '']) {
      expect(toLocalDateStr(value, 'UTC')).toBe('');
    }
  });

  it('returns an empty string for an unparseable date or bad zone', () => {
    expect(toLocalDateStr('nonsense', 'UTC')).toBe('');
    expect(toLocalDateStr('2026-03-09T18:30:00.000Z', 'Mars/Olympus_Mons')).toBe('');
  });

  it('agrees with formatInTZ on the same instant and zone', () => {
    const instants = ['2026-03-09T18:30:00.000Z', '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.000Z'];
    for (const instant of instants) {
      for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
        expect(toLocalDateStr(instant, zone)).toBe(formatInTZ(instant, 'yyyy-MM-dd', zone));
      }
    }
  });
});

describe('daylight saving', () => {
  it('applies the correct offset either side of a DST transition', () => {
    // New York moved to EDT on 8 March 2026. Same wall-clock hour, different
    // UTC offset — a fixed-offset shortcut would get one of these wrong.
    expect(formatInTZ('2026-03-07T17:00:00.000Z', 'HH:mm', 'America/New_York')).toBe('12:00');
    expect(formatInTZ('2026-03-09T17:00:00.000Z', 'HH:mm', 'America/New_York')).toBe('13:00');
  });

  it('is unaffected in a zone with no DST', () => {
    expect(formatInTZ('2026-03-07T12:00:00.000Z', 'HH:mm', 'Asia/Kolkata')).toBe('17:30');
    expect(formatInTZ('2026-07-07T12:00:00.000Z', 'HH:mm', 'Asia/Kolkata')).toBe('17:30');
  });
});

describe('utcOffsetLabel', () => {
  it('omits the minutes on a whole-hour offset', () => {
    expect(utcOffsetLabel('UTC')).toBe('UTC+0');
    expect(utcOffsetLabel('Asia/Muscat')).toBe('UTC+4');
  });

  it('includes zero-padded minutes on a half-hour offset', () => {
    expect(utcOffsetLabel('Asia/Kolkata')).toBe('UTC+5:30');
  });

  it('renders a negative offset with a minus sign', () => {
    expect(utcOffsetLabel('America/New_York')).toMatch(/^UTC-[45]$/);
  });

  it('echoes the input for an invalid zone rather than throwing', () => {
    expect(utcOffsetLabel('Mars/Olympus_Mons')).toBe('Mars/Olympus_Mons');
  });
});

describe('nowInTZ / todayStr', () => {
  it('nowInTZ reports the requested zone', () => {
    expect(nowInTZ('Asia/Muscat').zoneName).toBe('Asia/Muscat');
  });

  it('todayStr is a plain ISO date', () => {
    expect(todayStr('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('todayStr can differ by a day between zones', () => {
    // Not asserting *which* — that depends on when the suite runs. Asserting
    // only that both are well-formed and at most a day apart.
    const kolkata = todayStr('Asia/Kolkata');
    const honolulu = todayStr('Pacific/Honolulu');
    expect(kolkata).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(honolulu).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const diffDays = Math.abs(
      (Date.parse(`${kolkata}T00:00:00Z`) - Date.parse(`${honolulu}T00:00:00Z`)) / 86_400_000,
    );
    expect(diffDays).toBeLessThanOrEqual(1);
  });
});

describe('buildUTCFromLocal — company wall clock → stored instant', () => {
  /**
   * The bug this exists to prevent: an admin in Asia/Kolkata scheduling an
   * 08:00 shift for an Asia/Singapore company. `new Date('...T08:00')` resolved
   * the wall clock in the BROWSER zone and stored 02:30Z — a 10:30 SGT shift
   * whose reminder email fired at 08:00 IST.
   */
  it('resolves the wall clock in the company zone, not the browser zone', () => {
    setSystemTZ('Asia/Singapore');
    expect(buildUTCFromLocal('2026-06-11', '08:00')).toBe('2026-06-11T00:00:00.000Z');
  });

  it('follows the company timezone setting when it changes', () => {
    setSystemTZ('Asia/Kolkata');
    expect(buildUTCFromLocal('2026-06-11', '08:00')).toBe('2026-06-11T02:30:00.000Z');
  });

  it('accepts an explicit zone override', () => {
    setSystemTZ('Asia/Kolkata');
    expect(buildUTCFromLocal('2026-06-11', '08:00', 'Asia/Singapore')).toBe(
      '2026-06-11T00:00:00.000Z',
    );
  });

  it('round-trips through toLocalTimeStr', () => {
    setSystemTZ('Asia/Singapore');
    const iso = buildUTCFromLocal('2026-06-11', '19:30');
    expect(toLocalTimeStr(iso)).toBe('19:30');
  });

  it('toLocalTimeStr returns an empty string for a missing instant', () => {
    expect(toLocalTimeStr(null)).toBe('');
  });
});
