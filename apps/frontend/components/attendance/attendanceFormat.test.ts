import { describe, expect, it } from 'vitest';
import {
  chartAxis,
  describeSample,
  formatHours,
  formatLateness,
  formatRate,
  formatTimeOfDay,
  pointsChange,
  statusLabel,
} from './attendanceFormat';

describe('statusLabel', () => {
  it('turns the enum into something a table can print', () => {
    expect(statusLabel('ON_LEAVE')).toBe('On leave');
    expect(statusLabel('HALF_DAY')).toBe('Half day');
    expect(statusLabel('LATE')).toBe('Late');
  });
});

describe('formatRate', () => {
  it('prints an em dash when nobody was expected', () => {
    // 0% would claim everybody failed to turn up; on a closed office that is a
    // different — and false — sentence.
    expect(formatRate(null)).toBe('—');
    expect(formatRate(undefined)).toBe('—');
  });

  it('keeps a real zero as a zero', () => {
    expect(formatRate(0)).toBe('0.0%');
  });

  it('prints a known rate to one place', () => {
    expect(formatRate(98.2413)).toBe('98.2%');
  });
});

describe('formatHours', () => {
  it('reads the Decimal string Prisma sends', () => {
    expect(formatHours('8.500')).toBe('8.5h');
  });

  it('says nothing rather than zero for a day with no hours recorded', () => {
    expect(formatHours(null)).toBe('—');
    expect(formatHours('')).toBe('—');
  });

  it('keeps a measured zero', () => {
    expect(formatHours(0)).toBe('0.0h');
  });
});

describe('formatLateness', () => {
  it('is silent for an arrival inside the grace window', () => {
    expect(formatLateness(0)).toBe('');
    expect(formatLateness(null)).toBe('');
  });

  it('reads in minutes below the hour and in both units above it', () => {
    expect(formatLateness(25)).toBe('25m late');
    expect(formatLateness(60)).toBe('1h late');
    expect(formatLateness(85)).toBe('1h 25m late');
  });
});

describe('formatTimeOfDay', () => {
  it('renders the instant in the zone it is asked for, not the runner’s', () => {
    // 04:55Z is 08:55 in Muscat. A test machine in another zone must not change
    // what the office saw on the clock.
    expect(formatTimeOfDay('2026-03-02T04:55:00.000Z', 'Asia/Muscat')).toBe('08:55');
    expect(formatTimeOfDay('2026-03-02T04:55:00.000Z', 'UTC')).toBe('04:55');
  });

  it('answers with an em dash for a punch that never happened', () => {
    expect(formatTimeOfDay(null)).toBe('—');
  });
});

describe('pointsChange', () => {
  it('is undefined when either side of the comparison is unknown', () => {
    expect(pointsChange(null, 40)).toBeUndefined();
    expect(pointsChange(44, null)).toBeUndefined();
  });

  it('measures in percentage points, not as a percentage of a percentage', () => {
    expect(pointsChange(44, 40)).toBe(4);
    expect(pointsChange(40, 44)).toBe(-4);
  });
});

describe('chartAxis', () => {
  it('keeps a small series off the floor of the panel', () => {
    // Six people against a 0–25 axis draws every bar in the bottom fifth.
    expect(chartAxis(6)).toEqual({ max: 10, ticks: ['0', '2', '4', '6', '8', '10'] });
  });

  it('clears the tallest bar', () => {
    expect(chartAxis(120).max).toBeGreaterThanOrEqual(120);
  });
});

describe('describeSample', () => {
  it('says how many are not named, because the list is a sample', () => {
    expect(describeSample(19, ['Aisha', 'Omar', 'Salim'])).toBe('Aisha, Omar, Salim and 16 more');
  });

  it('names them all when the sample IS the set', () => {
    expect(describeSample(2, ['Aisha', 'Omar'])).toBe('Aisha, Omar');
  });

  it('falls back to the count when no names came with it', () => {
    expect(describeSample(4, [])).toBe('4');
  });
});
