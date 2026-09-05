import { describe, expect, it } from 'vitest';
import { generateSparkPath } from './spark';

describe('generateSparkPath', () => {
  it('draws nothing for a series too short to have a shape', () => {
    // One reading is not a trend, and the caller renders no <svg> at all when
    // the path comes back empty.
    expect(generateSparkPath([], 64, 24)).toBe('');
    expect(generateSparkPath([7], 64, 24)).toBe('');
  });

  it('spans the full width, first point to last', () => {
    const d = generateSparkPath([1, 5, 3], 64, 24);
    expect(d.startsWith('M 0.0 ')).toBe(true);
    expect(d).toContain('L 64.0 ');
    expect(d.split('L')).toHaveLength(3); // one move, two lines
  });

  it('puts the high reading above the low one', () => {
    // SVG y grows downward, so a rising number must produce a SMALLER y.
    const [start, end] = yValues(generateSparkPath([1, 9], 64, 24));
    expect(end).toBeLessThan(start);
  });

  it('keeps every point inside the box', () => {
    const ys = yValues(generateSparkPath([0, 50, 100, 25], 64, 24));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(24);
    }
  });

  it('normalises to the series, not to zero', () => {
    // Two series with the same shape and different magnitudes draw the same
    // line: a 64px sparkline can show movement or scale, and movement is the
    // one a reader can actually judge at that size.
    expect(generateSparkPath([10, 20, 15], 64, 24)).toBe(generateSparkPath([100, 200, 150], 64, 24));
  });

  it('survives a series that never moves', () => {
    const d = generateSparkPath([4, 4, 4], 64, 24);
    expect(d).not.toContain('NaN');
    expect(new Set(yValues(d)).size).toBe(1);
  });
});

function yValues(d: string): number[] {
  return [...d.matchAll(/[ML] [\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
}
