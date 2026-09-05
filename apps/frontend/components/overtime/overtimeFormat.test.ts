import { describe, expect, it } from 'vitest';
import {
  buildOvertimeWindow,
  formatOvertimeHours,
  formatWallClockRange,
  formatWallClockTime,
  otTypeLabel,
  overtimeStatusLabel,
} from './overtimeFormat';

describe('the clock face of an overtime timestamp', () => {
  it('reads back the hour that was entered, not the viewer’s local one', () => {
    // Stored tz-naive and tagged Z. Read in a local zone instead, an 17:00
    // claim filed in Muscat would render as 13:00 in London — one row saying
    // two different things about when somebody worked.
    expect(formatWallClockTime('2026-08-18T17:30:00.000Z')).toBe('17:30');
    expect(formatWallClockTime('2026-08-18T22:00:00.000Z')).toBe('22:00');
  });

  it('gives an em dash for a missing or unparseable value', () => {
    expect(formatWallClockTime(undefined)).toBe('—');
    expect(formatWallClockTime('not a time')).toBe('—');
    expect(formatWallClockRange('2026-08-18T17:30:00.000Z', undefined)).toBe('—');
  });

  it('renders a window as one range', () => {
    expect(
      formatWallClockRange('2026-08-18T18:00:00.000Z', '2026-08-18T21:00:00.000Z'),
    ).toBe('18:00 – 21:00');
  });
});

describe('the worked window', () => {
  it('measures an ordinary same-day shift', () => {
    const window = buildOvertimeWindow('2026-09-01', '18:00', '21:30');
    expect(window.hours).toBe(3.5);
    expect(window.startIso).toBe('2026-09-01T18:00:00Z');
    expect(window.endIso).toBe('2026-09-01T21:30:00Z');
  });

  it('rolls the end forward a day when the shift crosses midnight', () => {
    // 22:00 → 02:00 is four hours of night work, not an invalid range.
    const window = buildOvertimeWindow('2026-09-01', '22:00', '02:00');
    expect(window.hours).toBe(4);
    expect(window.endIso).toBe('2026-09-02T02:00:00Z');
  });

  it('tags the instants without converting them', () => {
    // What was typed is what the server stores and what reads back.
    const window = buildOvertimeWindow('2026-01-15', '08:00', '09:00');
    expect(formatWallClockTime(window.startIso)).toBe('08:00');
    expect(formatWallClockTime(window.endIso)).toBe('09:00');
  });

  it('returns nothing measurable for an unparseable day', () => {
    expect(buildOvertimeWindow('', '18:00', '21:00').hours).toBe(0);
  });
});

describe('the shared vocabulary', () => {
  it('drops a trailing zero so hours read as a shift, not a measurement', () => {
    expect(formatOvertimeHours(3)).toBe('3h');
    expect(formatOvertimeHours('4.50')).toBe('4.5h');
    expect(formatOvertimeHours(null)).toBe('—');
  });

  it('stops shouting the enums', () => {
    expect(overtimeStatusLabel('PENDING')).toBe('Pending');
    expect(otTypeLabel('DOUBLE_LATE')).toBe('Double late OT');
  });

  it('reads an absent type as REGULAR, which is what the server defaults it to', () => {
    expect(otTypeLabel(undefined)).toBe('Regular');
  });
});
