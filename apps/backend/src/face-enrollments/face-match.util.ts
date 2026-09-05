/**
 * The arithmetic behind a face match, kept apart from the database.
 *
 * A verification is a distance and a threshold and nothing else, so it is
 * testable without a Prisma client — and keeping it here means the one place
 * that decides whether two templates are the same person cannot quietly acquire
 * a second implementation somewhere in a service.
 */

/**
 * The distance below which two templates are treated as the same face.
 *
 * Squared-error distance between 128-float embeddings, so this is a ratio and
 * not a percentage: 0.6 is the value the recogniser these templates come from
 * is calibrated against. Raising it accepts more impostors, lowering it turns
 * away more genuine faces — which is why it is a system setting rather than a
 * constant, and why the default lives here beside the maths it belongs to.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.6;

/** Straight-line distance between two embeddings of equal width. */
export function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Distance expressed as the percentage a person reads on screen.
 *
 * Clamped at both ends on purpose. A distance above 1 is possible and would
 * otherwise report a negative confidence, which reads as a number rather than
 * as "no resemblance at all"; and a floating-point distance a hair below zero
 * must not become 101%.
 */
export function confidenceFrom(distance: number): number {
  const percent = Math.round((1 - distance) * 100);
  return Math.min(100, Math.max(0, percent));
}

export interface CandidateTemplate {
  employeeId: string;
  descriptor: number[];
}

export interface MatchOutcome<T extends CandidateTemplate> {
  /** Whether the closest candidate cleared the threshold. */
  matched: boolean;
  /** The closest candidate, matched or not — null when there were none. */
  closest: T | null;
  distance: number | null;
  confidence: number | null;
  threshold: number;
}

/**
 * The nearest enrolment to a probe, and whether it is near enough.
 *
 * The closest candidate is returned even when it fails, because "nobody was
 * within 0.83" is the sentence that tells an administrator to re-enrol somebody
 * — while a bare `false` sends them looking for a broken camera. The CALLER
 * decides what of that reaches the browser; a rejected match must never name
 * the person it nearly was.
 */
export function bestMatch<T extends CandidateTemplate>(
  probe: number[],
  candidates: T[],
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): MatchOutcome<T> {
  let closest: T | null = null;
  let closestDistance = Infinity;

  for (const candidate of candidates) {
    // A stored template of a different width came from a different model and
    // cannot be compared: the loop would read undefined off the shorter array
    // and produce NaN, which loses every comparison and silently drops the
    // candidate. Skipping it explicitly says so.
    if (candidate.descriptor.length !== probe.length) continue;

    const distance = euclideanDistance(probe, candidate.descriptor);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = candidate;
    }
  }

  if (!closest) {
    return {
      matched: false,
      closest: null,
      distance: null,
      confidence: null,
      threshold,
    };
  }

  return {
    matched: closestDistance < threshold,
    closest,
    distance: closestDistance,
    confidence: confidenceFrom(closestDistance),
    threshold,
  };
}
