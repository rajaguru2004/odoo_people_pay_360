import {
  DEFAULT_MATCH_THRESHOLD,
  bestMatch,
  confidenceFrom,
  euclideanDistance,
} from './face-match.util';

const WIDTH = 128;

/** A template that is `offset` away from the origin in exactly one dimension. */
function templateAt(offset: number): number[] {
  const descriptor = new Array<number>(WIDTH).fill(0);
  descriptor[0] = offset;
  return descriptor;
}

const ORIGIN = templateAt(0);

describe('euclideanDistance', () => {
  it('is zero for identical templates', () => {
    expect(euclideanDistance(ORIGIN, ORIGIN)).toBe(0);
  });

  it('is the straight-line distance across every dimension', () => {
    const a = new Array<number>(WIDTH).fill(0);
    const b = new Array<number>(WIDTH).fill(0);
    a[0] = 3;
    b[1] = 4;
    expect(euclideanDistance(a, b)).toBeCloseTo(5, 10);
  });
});

describe('confidenceFrom', () => {
  it('reports a perfect match as 100%', () => {
    expect(confidenceFrom(0)).toBe(100);
  });

  it('reports the threshold itself as 40%', () => {
    expect(confidenceFrom(DEFAULT_MATCH_THRESHOLD)).toBe(40);
  });

  it('clamps rather than reporting a negative percentage', () => {
    // Distances above 1 happen — two unrelated faces are routinely 1.2 apart.
    // "-23% confident" is a number a reader will try to interpret.
    expect(confidenceFrom(1.23)).toBe(0);
  });

  it('clamps a floating-point distance a hair below zero to 100%', () => {
    expect(confidenceFrom(-1e-9)).toBe(100);
  });
});

describe('bestMatch — the threshold', () => {
  it('accepts a candidate inside the threshold', () => {
    const outcome = bestMatch(ORIGIN, [
      { employeeId: 'near', descriptor: templateAt(0.4) },
    ]);

    expect(outcome.matched).toBe(true);
    expect(outcome.closest?.employeeId).toBe('near');
    expect(outcome.confidence).toBe(60);
  });

  it('refuses a candidate outside it', () => {
    const outcome = bestMatch(ORIGIN, [
      { employeeId: 'far', descriptor: templateAt(0.9) },
    ]);

    expect(outcome.matched).toBe(false);
    // The closest is still reported, because "nobody was nearer than 0.9" is
    // what tells an administrator to re-enrol somebody. What the API does with
    // it is a separate decision.
    expect(outcome.closest?.employeeId).toBe('far');
    expect(outcome.distance).toBeCloseTo(0.9, 10);
  });

  it('treats the threshold as exclusive, so a borderline probe is refused', () => {
    const outcome = bestMatch(ORIGIN, [
      { employeeId: 'edge', descriptor: templateAt(DEFAULT_MATCH_THRESHOLD) },
    ]);

    expect(outcome.matched).toBe(false);
  });

  it('honours a threshold an administrator has moved', () => {
    const candidates = [{ employeeId: 'edge', descriptor: templateAt(0.7) }];

    expect(bestMatch(ORIGIN, candidates, 0.5).matched).toBe(false);
    expect(bestMatch(ORIGIN, candidates, 0.8).matched).toBe(true);
  });

  it('picks the nearest when several are inside the threshold', () => {
    const outcome = bestMatch(ORIGIN, [
      { employeeId: 'close', descriptor: templateAt(0.5) },
      { employeeId: 'closer', descriptor: templateAt(0.1) },
      { employeeId: 'far', descriptor: templateAt(1.4) },
    ]);

    expect(outcome.matched).toBe(true);
    expect(outcome.closest?.employeeId).toBe('closer');
  });

  it('has nothing to say when nobody is enrolled', () => {
    const outcome = bestMatch(ORIGIN, []);

    expect(outcome).toMatchObject({
      matched: false,
      closest: null,
      distance: null,
      confidence: null,
    });
  });

  it('skips a stored template of the wrong width instead of scoring it NaN', () => {
    // A different width came from a different model. Compared element-wise it
    // reads undefined off the shorter array, and NaN loses every comparison —
    // so the candidate would be dropped anyway, silently. Skipping it says so.
    const outcome = bestMatch(ORIGIN, [
      { employeeId: 'wrong-model', descriptor: [0, 0, 0] },
      { employeeId: 'right-model', descriptor: templateAt(0.3) },
    ]);

    expect(outcome.closest?.employeeId).toBe('right-model');
    expect(outcome.matched).toBe(true);
  });
});
