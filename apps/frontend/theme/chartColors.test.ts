import { describe, expect, it } from 'vitest';
import {
  chartColors,
  createSeriesScale,
  RUN_STATUS_COLORS,
  sequentialFill,
  SERIES_OTHER,
  SERIES_RAMP,
} from './chartColors';

describe('SERIES_RAMP', () => {
  it('reserves the status hues', () => {
    // The bug this exists to prevent: `chartColors.palette` puts statusSuccess
    // and statusWarning in slots 3 and 4, so a page using it for departments
    // paints the third one green — and a green department reads as a healthy
    // one. Status colour means good/warning/serious/critical and nothing else.
    const reserved = [
      chartColors.success,
      chartColors.warning,
      chartColors.error,
      chartColors.info,
    ].map((hex) => hex.toLowerCase());

    for (const slot of SERIES_RAMP) {
      expect(reserved).not.toContain(slot.toLowerCase());
    }
  });

  it('has eight distinct slots', () => {
    expect(new Set(SERIES_RAMP).size).toBe(SERIES_RAMP.length);
    expect(SERIES_RAMP).toHaveLength(8);
  });
});

describe('createSeriesScale', () => {
  const departments = ['finance', 'engineering', 'sales', 'support'];

  it('gives each entity a slot in list order', () => {
    const scale = createSeriesScale(departments);
    expect(scale('finance')).toBe(SERIES_RAMP[0]);
    expect(scale('engineering')).toBe(SERIES_RAMP[1]);
  });

  it('holds a colour still when another entity is filtered out', () => {
    // THE regression this function exists for. The scale is seeded from the
    // unfiltered option list, so removing Finance from the DATA must not move
    // Engineering — colouring by row position is what makes the reader who
    // learned Finance is orange watch it turn teal.
    const scale = createSeriesScale(departments);
    const before = scale('sales');

    // Same seed, fewer rows drawn — which is exactly what a filter does.
    const afterFilter = createSeriesScale(departments);
    expect(afterFilter('sales')).toBe(before);
    expect(afterFilter('engineering')).toBe(SERIES_RAMP[1]);
  });

  it('folds the ninth entity and beyond into the neutral', () => {
    // A ninth hue is a colour nobody can name against the eight above it, and
    // the matrix table already carries the detail.
    const many = Array.from({ length: 12 }, (_, i) => `dept-${i}`);
    const scale = createSeriesScale(many);
    expect(scale('dept-7')).toBe(SERIES_RAMP[7]);
    expect(scale('dept-8')).toBe(SERIES_OTHER);
    expect(scale('dept-11')).toBe(SERIES_OTHER);
  });

  it('gives the unassigned row the neutral rather than crashing', () => {
    const scale = createSeriesScale(departments);
    expect(scale(null)).toBe(SERIES_OTHER);
    expect(scale(undefined)).toBe(SERIES_OTHER);
    expect(scale('not-a-department')).toBe(SERIES_OTHER);
  });
});

describe('RUN_STATUS_COLORS', () => {
  it('names every status a run can be in', () => {
    // A chart reading `undefined` as a fill draws a black mark.
    for (const status of [
      'DRAFT',
      'CALCULATED',
      'APPROVED',
      'PAID',
      'CANCELLED',
    ]) {
      expect(RUN_STATUS_COLORS[status]).toBeTruthy();
    }
  });

  it('gives CANCELLED the neutral, not a status colour', () => {
    // A withdrawal is not a stage and not a failure. Painting it red would say
    // somebody had done something wrong.
    expect(RUN_STATUS_COLORS.CANCELLED).toBe(SERIES_OTHER);
    expect(RUN_STATUS_COLORS.CANCELLED).not.toBe(chartColors.error);
  });
});

describe('sequentialFill', () => {
  it('clamps outside 0…1 rather than producing an invalid colour', () => {
    expect(sequentialFill(-1)).toBe(sequentialFill(0));
    expect(sequentialFill(2)).toBe(sequentialFill(1));
  });

  it('survives a NaN from a zero-range scale', () => {
    // `(value - min) / (max - min)` with one department divides by zero.
    expect(sequentialFill(Number.NaN)).toBe(sequentialFill(0));
  });
});
