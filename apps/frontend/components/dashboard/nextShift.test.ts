import { describe, expect, it } from 'vitest';
import { nextShift } from './nextShift';
import type { EmployeeCalendar, ScheduleEvent } from '@/types/schedules';

function event(partial: Partial<ScheduleEvent> & { date: string }): ScheduleEvent {
  return {
    id: `e-${partial.date}`,
    title: 'Weekly off',
    type: 'weekly-off',
    shiftType: null,
    startTime: null,
    endTime: null,
    hours: null,
    allDay: true,
    isWorkDay: false,
    notes: null,
    ...partial,
  };
}

function calendar(events: ScheduleEvent[], endDate = '2026-10-05'): EmployeeCalendar {
  return {
    employee: null,
    range: { startDate: '2026-09-05', endDate },
    calendar: {
      zone: 'Asia/Muscat',
      officeStart: '08:00',
      officeEnd: '17:00',
      weeklyOffDays: [5, 6],
    },
    events,
  };
}

describe('nextShift', () => {
  it('falls through to the branch hours on a day the roster says nothing about', () => {
    // Most of the workforce never appears in `events` at all: the endpoint sends
    // exceptions, and an ordinary Monday is not one.
    const shift = nextShift(calendar([]), '2026-09-07');

    expect(shift).toEqual({
      date: '2026-09-07',
      startTime: '08:00',
      endTime: '17:00',
      title: 'Standard hours',
      rostered: false,
    });
  });

  it('walks past the days an all-day marker has closed', () => {
    const shift = nextShift(
      calendar([
        event({ date: '2026-09-05' }),
        event({ date: '2026-09-06' }),
        event({ date: '2026-09-07', title: 'National Day', type: 'holiday' }),
      ]),
      '2026-09-05',
    );

    expect(shift?.date).toBe('2026-09-08');
  });

  it('prefers the roster row over the branch default', () => {
    const shift = nextShift(
      calendar([
        event({
          date: '2026-09-07',
          title: 'Night shift',
          type: 'shift',
          shiftType: 'NIGHT',
          startTime: '22:00',
          endTime: '06:00',
          allDay: false,
          isWorkDay: true,
        }),
      ]),
      '2026-09-07',
    );

    expect(shift).toMatchObject({ startTime: '22:00', endTime: '06:00', rostered: true });
  });

  it('reports nothing rather than guessing past the window the server answered for', () => {
    // Every day in range is closed, so the only honest answer is "not from here".
    const closed = ['2026-09-05', '2026-09-06', '2026-09-07'].map((date) => event({ date }));

    expect(nextShift(calendar(closed, '2026-09-07'), '2026-09-05')).toBeNull();
  });

  it('has nothing to say without a calendar at all', () => {
    expect(nextShift(undefined, '2026-09-05')).toBeNull();
  });
});
