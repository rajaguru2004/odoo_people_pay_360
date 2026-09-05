import {
  dayKeysBetween,
  isoWeekdayOf,
  resolveCalendarDay,
} from './calendar-day.util';

/** Friday and Saturday, the Gulf working week. */
const GULF_WEEKEND = [5, 6];

describe('resolveCalendarDay', () => {
  it('reads a leave day as leave even when a shift is still rostered', () => {
    // A shift left on the roster for a day somebody is signed off is a
    // rostering mistake, not an instruction to turn up.
    const day = resolveCalendarDay({
      date: '2026-09-07',
      hasSchedule: true,
      onLeave: true,
      weeklyOffDays: GULF_WEEKEND,
    });
    expect(day.kind).toBe('leave');
    expect(day.isWorkingDay).toBe(false);
  });

  it('keeps somebody rostered on a public holiday as working', () => {
    const day = resolveCalendarDay({
      date: '2026-11-18',
      hasSchedule: true,
      onLeave: false,
      holidayName: 'National Day',
      weeklyOffDays: GULF_WEEKEND,
    });
    expect(day.kind).toBe('work');
    expect(day.isWorkingDay).toBe(true);
  });

  it('prints the holiday name rather than the word "holiday"', () => {
    const day = resolveCalendarDay({
      date: '2026-11-18',
      hasSchedule: false,
      onLeave: false,
      holidayName: 'National Day',
      weeklyOffDays: GULF_WEEKEND,
    });
    expect(day).toMatchObject({ kind: 'holiday', label: 'National Day' });
  });

  it('lets a holiday outrank the weekly off it lands on', () => {
    // 2026-09-04 is a Friday, a rest day in this week — the named holiday is
    // the more useful of the two facts.
    expect(isoWeekdayOf('2026-09-04')).toBe(5);
    const day = resolveCalendarDay({
      date: '2026-09-04',
      hasSchedule: false,
      onLeave: false,
      holidayName: 'Prophet’s Birthday',
      weeklyOffDays: GULF_WEEKEND,
    });
    expect(day.kind).toBe('holiday');
  });

  it('falls back to the branch weekly off', () => {
    const day = resolveCalendarDay({
      date: '2026-09-05',
      hasSchedule: false,
      onLeave: false,
      weeklyOffDays: GULF_WEEKEND,
    });
    expect(day).toMatchObject({
      kind: 'weekly-off',
      label: 'Weekly off',
      isWorkingDay: false,
    });
  });

  it('treats a plain working day with no roster row as open', () => {
    const day = resolveCalendarDay({
      date: '2026-09-08',
      hasSchedule: false,
      onLeave: false,
      weeklyOffDays: GULF_WEEKEND,
    });
    expect(day).toMatchObject({ kind: 'open', isWorkingDay: true });
  });

  it('honours a rostered row the roster itself marks as non-working', () => {
    const day = resolveCalendarDay({
      date: '2026-09-08',
      hasSchedule: true,
      isWorkDay: false,
      onLeave: false,
      weeklyOffDays: GULF_WEEKEND,
    });
    expect(day).toMatchObject({ kind: 'weekly-off', isWorkingDay: false });
  });

  it('reads a date-only key without a zone shift', () => {
    // Put through an instant parse, 2026-01-15 lands on the 14th anywhere west
    // of Greenwich — and a Thursday becomes a Wednesday.
    expect(isoWeekdayOf('2026-01-15')).toBe(4);
    expect(isoWeekdayOf('2026-01-15T00:00:00.000Z')).toBe(4);
  });
});

describe('dayKeysBetween', () => {
  it('includes both ends', () => {
    expect(dayKeysBetween('2026-09-01', '2026-09-04')).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
  });

  it('crosses a month boundary', () => {
    expect(dayKeysBetween('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
  });

  it('returns nothing for a reversed or unparseable range', () => {
    expect(dayKeysBetween('2026-09-04', '2026-09-01')).toEqual([]);
    expect(dayKeysBetween('not-a-date', '2026-09-01')).toEqual([]);
  });
});
