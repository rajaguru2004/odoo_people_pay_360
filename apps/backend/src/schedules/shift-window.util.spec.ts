import {
  addToHourlyTally,
  coverageRate,
  formatWallClock12h,
  hourLabel,
  median,
  resolveWindow,
  shiftHours,
  windowsConflict,
} from './shift-window.util';

const fixed = (startTime: string | null, endTime: string | null) => ({
  shiftType: 'FULL_DAY' as const,
  startTime,
  endTime,
});

describe('resolveWindow', () => {
  it('places an ordinary daytime shift on the dial', () => {
    expect(resolveWindow(fixed('09:00', '17:00'))).toEqual({
      startMinutes: 540,
      durationMinutes: 480,
      crossesMidnight: false,
    });
  });

  it('reads an end before the start as a midnight crossing, not a negative', () => {
    const window = resolveWindow({
      shiftType: 'NIGHT',
      startTime: '22:00',
      endTime: '06:00',
    });
    expect(window).toEqual({
      startMinutes: 1320,
      durationMinutes: 480,
      crossesMidnight: true,
    });
  });

  it('treats equal clocks as a zero-length window, not 24 hours', () => {
    expect(resolveWindow(fixed('08:00', '08:00'))).toEqual({
      startMinutes: 480,
      durationMinutes: 0,
      crossesMidnight: false,
    });
  });

  it('has nothing to place for a flexible shift', () => {
    expect(
      resolveWindow({
        shiftType: 'FLEXIBLE',
        startTime: '09:00',
        endTime: '17:00',
      }),
    ).toBeNull();
  });

  it('has nothing to place when half the window is missing', () => {
    expect(resolveWindow(fixed('09:00', null))).toBeNull();
    expect(resolveWindow(fixed(null, '17:00'))).toBeNull();
  });

  it('refuses a value that is not a wall clock', () => {
    expect(resolveWindow(fixed('9am', '17:00'))).toBeNull();
    expect(resolveWindow(fixed('25:00', '17:00'))).toBeNull();
  });
});

describe('shiftHours', () => {
  it('measures a fixed window from its own clocks', () => {
    expect(
      shiftHours({ ...fixed('09:00', '17:30'), requiredHours: null }),
    ).toBe(8.5);
  });

  it('measures a night shift across midnight', () => {
    expect(
      shiftHours({
        shiftType: 'NIGHT',
        startTime: '22:00',
        endTime: '06:00',
        requiredHours: null,
      }),
    ).toBe(8);
  });

  it('takes a flexible shift at its stated hours, ignoring any clocks', () => {
    expect(
      shiftHours({
        shiftType: 'FLEXIBLE',
        startTime: '09:00',
        endTime: '23:00',
        requiredHours: 6,
      }),
    ).toBe(6);
  });

  it('falls back to requiredHours when the window cannot be read', () => {
    expect(shiftHours({ ...fixed('09:00', null), requiredHours: 7.5 })).toBe(
      7.5,
    );
  });

  it('is zero rather than null when nothing at all is known', () => {
    expect(shiftHours({ ...fixed(null, null), requiredHours: null })).toBe(0);
  });
});

describe('windowsConflict', () => {
  it('collides when two windows genuinely overlap', () => {
    expect(
      windowsConflict(fixed('09:00', '17:00'), fixed('16:00', '20:00')),
    ).toBe(true);
  });

  it('does not collide when one ends exactly where the next starts', () => {
    expect(
      windowsConflict(fixed('09:00', '13:00'), fixed('13:00', '17:00')),
    ).toBe(false);
  });

  it('does not collide when the windows are far apart', () => {
    expect(
      windowsConflict(fixed('06:00', '10:00'), fixed('14:00', '18:00')),
    ).toBe(false);
  });

  it('collides with a flexible shift in both directions', () => {
    const flexible = {
      shiftType: 'FLEXIBLE' as const,
      startTime: null,
      endTime: null,
    };
    expect(windowsConflict(flexible, fixed('09:00', '17:00'))).toBe(true);
    expect(windowsConflict(fixed('09:00', '17:00'), flexible)).toBe(true);
  });

  it('sees a night shift colliding with an early morning one', () => {
    const night = {
      shiftType: 'NIGHT' as const,
      startTime: '22:00',
      endTime: '06:00',
    };
    expect(windowsConflict(night, fixed('05:00', '09:00'))).toBe(true);
  });

  it('leaves a night shift and a mid-morning one alone', () => {
    const night = {
      shiftType: 'NIGHT' as const,
      startTime: '22:00',
      endTime: '06:00',
    };
    expect(windowsConflict(night, fixed('09:00', '17:00'))).toBe(false);
  });

  it('cannot prove a collision when a window is unreadable', () => {
    expect(windowsConflict(fixed('09:00', null), fixed('09:00', '17:00'))).toBe(
      false,
    );
  });

  it('does not collide with a zero-length window', () => {
    expect(
      windowsConflict(fixed('09:00', '09:00'), fixed('09:00', '17:00')),
    ).toBe(false);
  });
});

describe('addToHourlyTally', () => {
  it('fills every hour a daytime shift covers', () => {
    const hours = new Array<number>(24).fill(0);
    expect(addToHourlyTally(fixed('09:00', '12:00'), hours)).toBe(true);
    expect(hours[8]).toBe(0);
    expect(hours.slice(9, 12)).toEqual([1, 1, 1]);
    expect(hours[12]).toBe(0);
  });

  it('counts a night shift on both sides of midnight', () => {
    const hours = new Array<number>(24).fill(0);
    addToHourlyTally(
      { shiftType: 'NIGHT', startTime: '22:00', endTime: '02:00' },
      hours,
    );
    expect(hours[22]).toBe(1);
    expect(hours[23]).toBe(1);
    expect(hours[0]).toBe(1);
    expect(hours[1]).toBe(1);
    expect(hours[2]).toBe(0);
  });

  it('rounds a partial hour up rather than reporting an empty hour', () => {
    const hours = new Array<number>(24).fill(0);
    addToHourlyTally(fixed('09:00', '11:30'), hours);
    expect(hours.slice(9, 12)).toEqual([1, 1, 1]);
  });

  it('reports a flexible shift as unplaceable rather than dropping it silently', () => {
    const hours = new Array<number>(24).fill(0);
    expect(
      addToHourlyTally(
        { shiftType: 'FLEXIBLE', startTime: null, endTime: null },
        hours,
      ),
    ).toBe(false);
    expect(hours.every((h) => h === 0)).toBe(true);
  });
});

describe('coverageRate', () => {
  it('reports the plain rate when the calendar expected more than turned up', () => {
    expect(coverageRate(8, 10)).toBe(80);
  });

  it('never exceeds 100% when more are rostered than expected', () => {
    // A branch that rests Saturday still has people legitimately rostered on it.
    expect(coverageRate(3, 2)).toBe(100);
  });

  it('is unknown rather than nought when nobody was expected', () => {
    expect(coverageRate(0, 0)).toBeNull();
  });
});

describe('median', () => {
  it('takes the middle of an odd-length window', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middles of an even-length window', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('is zero for an empty window', () => {
    expect(median([])).toBe(0);
  });
});

describe('labels', () => {
  it('names midnight and noon rather than printing a zero', () => {
    expect(hourLabel(0)).toBe('12 AM');
    expect(hourLabel(12)).toBe('12 PM');
    expect(hourLabel(13)).toBe('1 PM');
  });

  it('renders a wall clock the way a roster reads it', () => {
    expect(formatWallClock12h('08:00')).toBe('8:00 AM');
    expect(formatWallClock12h('00:30')).toBe('12:30 AM');
    expect(formatWallClock12h('22:15')).toBe('10:15 PM');
  });

  it('is empty for anything that is not a wall clock', () => {
    expect(formatWallClock12h(null)).toBe('');
    expect(formatWallClock12h('half eight')).toBe('');
  });
});
