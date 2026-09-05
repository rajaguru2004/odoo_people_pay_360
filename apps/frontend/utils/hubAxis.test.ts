import { describe, expect, it } from 'vitest';
import { compactNumber, niceAxis, ratePct, sharePct } from './hubAxis';

/**
 * The chart axis the three module hubs share.
 *
 * The Time hub's local `axisFor` walks a hardcoded ladder that stops at 5000,
 * which is fine for counting people and useless for a money axis where one
 * month can be six figures. These cases pin the two properties that matter:
 * the axis always CLEARS the tallest bar, and it never towers so far above it
 * that every bar becomes a sliver.
 */
describe('niceAxis', () => {
  it('clears the tallest bar', () => {
    for (const max of [1, 7, 23, 99, 1234, 18500, 962_400, 4_000_000]) {
      expect(niceAxis(max).max).toBeGreaterThanOrEqual(max);
    }
  });

  it('does not tower over the tallest bar', () => {
    // Twice the tallest bar means every bar sits in the bottom half and the
    // shape of the series stops being readable.
    for (const max of [7, 23, 99, 1234, 18500, 962_400]) {
      expect(niceAxis(max).max).toBeLessThan(max * 2.5);
    }
  });

  it('always returns six ticks starting at zero', () => {
    const { ticks } = niceAxis(18500);
    expect(ticks).toHaveLength(6);
    expect(ticks[0]).toBe(0);
    expect(ticks[5]).toBe(niceAxis(18500).max);
  });

  it('gives an empty series a readable axis rather than dividing by zero', () => {
    expect(niceAxis(0)).toEqual({ max: 5, ticks: [0, 1, 2, 3, 4, 5] });
    expect(niceAxis(Number.NaN).max).toBe(5);
  });
});

describe('compactNumber', () => {
  it('keeps small numbers whole', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(900)).toBe('900');
  });

  it('abbreviates thousands and millions without a trailing zero', () => {
    // `45k` reads better than `45.0k`, and six-figure tick labels push the plot
    // area sideways until the bars have nowhere to live.
    expect(compactNumber(45_000)).toBe('45k');
    expect(compactNumber(18_500)).toBe('18.5k');
    expect(compactNumber(1_200_000)).toBe('1.2M');
  });
});

describe('ratePct', () => {
  it('renders an em dash for an unknown rate, never 0%', () => {
    // `null` from the server means the denominator was zero. The rate is
    // unknown, not zero, and it has to stay visibly unknown to the pixel.
    expect(ratePct(null)).toBe('—');
    expect(ratePct(undefined)).toBe('—');
  });

  it('renders a known rate to one decimal', () => {
    expect(ratePct(0)).toBe('0.0%');
    expect(ratePct(75)).toBe('75.0%');
  });
});

describe('sharePct', () => {
  it('is 0 when there is nothing to divide by', () => {
    expect(sharePct(4, 0)).toBe(0);
  });

  it('clamps to a meter track', () => {
    expect(sharePct(-1, 10)).toBe(0);
    expect(sharePct(11, 10)).toBe(100);
    expect(sharePct(5, 10)).toBe(50);
  });
});
