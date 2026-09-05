import { describe, expect, it } from 'vitest';
import { axisFor, csvCell } from './chartAxis';

describe('axisFor', () => {
  it('rounds up to a round ceiling rather than to the peak itself', () => {
    // A chart topping out at 47 wants a 50 axis in steps of 10, not a 47 axis
    // in steps of 9.4.
    const axis = axisFor(47);
    expect(axis.max).toBe(50);
    expect(axis.ticks).toEqual(['0', '10', '20', '30', '40', '50']);
  });

  it('keeps the tallest bar inside the plot', () => {
    for (const peak of [1, 3, 7, 12, 19, 64, 233, 1001]) {
      expect(axisFor(peak).max).toBeGreaterThanOrEqual(peak);
    }
  });

  it('only ever puts gridlines on 1, 2 or 5 and their powers of ten', () => {
    const stepOf = (peak: number) => {
      const ticks = axisFor(peak).ticks.map(Number);
      return ticks[1] - ticks[0];
    };
    for (const peak of [4, 9, 23, 47, 120, 780]) {
      const step = stepOf(peak);
      const magnitude = 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 5, 10]).toContain(Math.round(step / magnitude));
    }
  });

  it('returns ticks ascending, which is what BarOverviewChart consumes', () => {
    // The chart reverses the array itself to draw top-down — its own default is
    // ['0' … '60'], lowest first. Returning display order here reversed it
    // twice and put 0 at the top of the plot on two hubs.
    const ticks = axisFor(20).ticks.map(Number);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThan(ticks[0]);
  });

  it('survives a peak of zero, which is an empty window not a broken one', () => {
    const axis = axisFor(0);
    expect(axis.max).toBeGreaterThan(0);
    expect(axis.ticks.length).toBeGreaterThan(1);
  });

  it('survives a peak that is not a finite number', () => {
    expect(axisFor(Number.NaN).max).toBeGreaterThan(0);
    expect(axisFor(-5).max).toBeGreaterThan(0);
  });

  it('does not print two identical labels on a sub-unit axis', () => {
    const ticks = axisFor(2, 5).ticks;
    expect(new Set(ticks).size).toBe(ticks.length);
  });
});

describe('csvCell', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvCell('Muscat')).toBe('Muscat');
    expect(csvCell(42)).toBe('42');
  });

  it('quotes a value carrying a comma, a quote or a newline', () => {
    expect(csvCell('Ops, Sohar')).toBe('"Ops, Sohar"');
    expect(csvCell('He said "no"')).toBe('"He said ""no"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('renders a missing value as empty rather than as "null"', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});
