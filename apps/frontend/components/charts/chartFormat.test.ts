import { describe, expect, it } from 'vitest';
import { axisLabel, compactMoney, percentTick, shareOf } from './chartFormat';

describe('compactMoney', () => {
  it('abbreviates thousands and millions', () => {
    expect(compactMoney(1500)).toBe('1.5k');
    expect(compactMoney(24_000)).toBe('24k');
    expect(compactMoney(2_400_000)).toBe('2.4M');
    expect(compactMoney(24_000_000)).toBe('24M');
  });

  it('leaves small amounts whole', () => {
    expect(compactMoney(940)).toBe('940');
    expect(compactMoney(0)).toBe('0');
  });

  it('keeps the sign on a negative', () => {
    // The bridge has subtract steps; an axis that dropped the sign would put a
    // deduction above the line.
    expect(compactMoney(-1500)).toBe('-1.5k');
  });

  it('renders nothing for a non-finite value rather than "NaN"', () => {
    expect(compactMoney(Number.NaN)).toBe('');
    expect(compactMoney(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('shareOf', () => {
  it('is a percentage of the row to one decimal', () => {
    expect(shareOf(1, 4)).toBe(25);
    expect(shareOf(1, 3)).toBe(33.3);
  });

  it('is null, never zero, when the row is empty', () => {
    // A department with no attendance events did not have 0% attendance; it
    // had no days to measure. The caller prints an em dash.
    expect(shareOf(0, 0)).toBeNull();
    expect(shareOf(5, -1)).toBeNull();
  });
});

describe('percentTick', () => {
  it('rounds to whole numbers', () => {
    // 33.3% on an axis implies a precision an attendance denominator does not
    // have.
    expect(percentTick(33.33)).toBe('33%');
    expect(percentTick(100)).toBe('100%');
  });
});

describe('axisLabel', () => {
  it('leaves a short label alone', () => {
    expect(axisLabel('Finance')).toBe('Finance');
  });

  it('truncates a long one, because SVG text does not clip to a box', () => {
    const out = axisLabel('Research and Development', 14);
    // At most the cap, not exactly it: a trailing space is trimmed before the
    // ellipsis, because "Research and …" reads as a gap rather than a cut.
    expect(out.length).toBeLessThanOrEqual(14);
    expect(out).toBe('Research and…');
  });
});
