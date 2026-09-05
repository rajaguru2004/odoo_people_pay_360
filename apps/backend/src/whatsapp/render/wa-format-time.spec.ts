import { fmtDate, fmtTime } from './wa-format';

/**
 * Attendance instants are stored in UTC, so every clock face shown to an
 * employee is a conversion. Rendering one without a zone is not a cosmetic
 * slip: a 20:26 check-in in Chennai reads back as 14:56, and one made after
 * 05:30 UTC reads as the wrong DAY.
 */

const EVENING_IST = '2026-08-08T14:56:00.000Z'; // 20:26 in Asia/Kolkata

describe('channel time rendering', () => {
  it('renders a check-in in the employee zone, not UTC', () => {
    expect(fmtTime(EVENING_IST, 'Asia/Kolkata')).toBe('20:26');
    expect(fmtTime(EVENING_IST, 'UTC')).toBe('14:56');
  });

  it('rolls the date over with the zone', () => {
    // 23:40 UTC is already the next morning in Kolkata.
    const lateUtc = '2026-08-08T23:40:00.000Z';
    expect(fmtDate(lateUtc, 'Asia/Kolkata')).toBe('09 Aug 2026');
    expect(fmtDate(lateUtc, 'UTC')).toBe('08 Aug 2026');
  });

  it('rolls backwards for zones behind UTC', () => {
    const earlyUtc = '2026-08-08T02:00:00.000Z';
    expect(fmtDate(earlyUtc, 'America/New_York')).toBe('07 Aug 2026');
    expect(fmtTime(earlyUtc, 'America/New_York')).toBe('22:00');
  });

  it('renders midnight as 00:00, never 24:00', () => {
    // Some ICU builds render hour12:false midnight as "24" — hourCycle h23
    // is what keeps this honest.
    expect(fmtTime('2026-08-08T18:30:00.000Z', 'Asia/Kolkata')).toBe('00:00');
  });

  it('keeps UTC when no zone is supplied', () => {
    // Existing call sites that have no employee to resolve a zone from must
    // keep behaving exactly as before.
    expect(fmtTime(EVENING_IST)).toBe('14:56');
    expect(fmtDate(EVENING_IST)).toBe('08 Aug 2026');
  });

  it('falls back rather than throwing on a bad zone', () => {
    expect(() => fmtTime(EVENING_IST, 'Not/AZone')).not.toThrow();
  });

  it('still handles empty and unparseable values', () => {
    expect(fmtTime(null, 'Asia/Kolkata')).toBe('');
    expect(fmtDate(undefined, 'Asia/Kolkata')).toBe('');
    expect(fmtTime('not a date', 'Asia/Kolkata')).toBe('not a date');
  });

  it('accepts a Date as readily as a string', () => {
    expect(fmtTime(new Date(EVENING_IST), 'Asia/Kolkata')).toBe('20:26');
  });
});
