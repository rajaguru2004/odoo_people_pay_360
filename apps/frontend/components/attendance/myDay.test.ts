import { describe, expect, it } from 'vitest';
import {
  elapsedLabel,
  monthRange,
  punchAction,
  punchState,
  todayKey,
} from './myDay';
import type { Attendance, AttendanceStatus } from '@/types/attendance';

function record(over: Partial<Attendance> = {}): Attendance {
  return {
    id: 'a1',
    employeeId: 'e1',
    date: '2026-09-05',
    checkIn: null,
    checkOut: null,
    status: 'PRESENT',
    source: 'ESS',
    isLate: false,
    isEarlyLeave: false,
    lateMinutes: 0,
    createdAt: '2026-09-05T04:00:00.000Z',
    updatedAt: '2026-09-05T04:00:00.000Z',
    ...over,
  };
}

describe('punchState', () => {
  it('has nobody started when there is no row at all', () => {
    expect(punchState(null)).toBe('NOT_STARTED');
    expect(punchState(undefined)).toBe('NOT_STARTED');
  });

  it('is working between the two punches', () => {
    expect(punchState(record({ checkIn: '2026-09-05T04:00:00.000Z' }))).toBe(
      'WORKING',
    );
  });

  it('is done once the day is closed', () => {
    expect(
      punchState(
        record({
          checkIn: '2026-09-05T04:00:00.000Z',
          checkOut: '2026-09-05T13:00:00.000Z',
        }),
      ),
    ).toBe('DONE');
  });

  it.each<AttendanceStatus>(['WEEKEND', 'HOLIDAY', 'ON_LEAVE'])(
    'treats %s as a day off rather than a missing punch',
    (status) => {
      // Offering a check-in button here invites a punch on a day nobody was
      // expected, which the reports then have to explain.
      expect(punchState(record({ status }))).toBe('OFF');
    },
  );

  it('is not started on a row that exists but carries no punch', () => {
    // A row marked ABSENT before the day has closed is still a day somebody can
    // arrive on.
    expect(punchState(record({ status: 'ABSENT' }))).toBe('NOT_STARTED');
  });
});

describe('punchAction', () => {
  it('offers exactly one action, or none', () => {
    expect(punchAction('NOT_STARTED')).toEqual({
      action: 'CHECK_IN',
      label: 'Check in',
    });
    expect(punchAction('WORKING')).toEqual({
      action: 'CHECK_OUT',
      label: 'Check out',
    });
    expect(punchAction('DONE')).toBeNull();
    expect(punchAction('OFF')).toBeNull();
  });
});

describe('elapsedLabel', () => {
  it('reads hours and minutes', () => {
    expect(
      elapsedLabel('2026-09-05T04:00:00.000Z', new Date('2026-09-05T06:14:30.000Z')),
    ).toBe('2h 14m');
  });

  it('drops the hours below an hour', () => {
    expect(
      elapsedLabel('2026-09-05T04:00:00.000Z', new Date('2026-09-05T04:07:00.000Z')),
    ).toBe('7m');
  });

  it('refuses to print a negative duration', () => {
    // A clock correction while somebody was checked in would otherwise show
    // "-1h 0m", which reads as a bug rather than as an unknown.
    expect(
      elapsedLabel('2026-09-05T06:00:00.000Z', new Date('2026-09-05T05:00:00.000Z')),
    ).toBe('—');
  });

  it('is an em dash with nothing to measure from', () => {
    expect(elapsedLabel(null)).toBe('—');
    expect(elapsedLabel('not-a-date')).toBe('—');
  });
});

describe('monthRange', () => {
  it('covers the whole month', () => {
    expect(monthRange({ month: 9, year: 2026 })).toEqual({
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });
  });

  it('gets February right in a leap year', () => {
    expect(monthRange({ month: 2, year: 2028 }).endDate).toBe('2028-02-29');
  });
});

describe('todayKey', () => {
  it('reads the day in the company zone, not the browser one', () => {
    // 21:30 UTC is already tomorrow in Muscat. A screen keyed on the browser's
    // day would ask for the wrong date for anybody working an evening shift.
    expect(todayKey('Asia/Muscat', new Date('2026-09-05T21:30:00.000Z'))).toBe(
      '2026-09-06',
    );
  });
});
