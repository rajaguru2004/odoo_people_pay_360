/**
 * Face enrolment, and the one thing this module refuses to do.
 *
 * A descriptor is biometric material. It travels in exactly one direction — up,
 * once, at enrolment — and nothing here returns it to a render path: the capture
 * hands the caller a sample to POST, and the API's own responses never carry it
 * back. There is no formatter for a descriptor in this file on purpose, so a
 * later screen cannot reach for one.
 */

/** face-api.js emits a fixed-width embedding; the server refuses another width. */
export const DESCRIPTOR_LENGTH = 128;

/**
 * The floor a usable template has to clear.
 *
 * Mirrors `face_recognition_min_quality` in system settings, which only an
 * administrator may read — an HR manager on this screen gets this value instead
 * of a 403, and both are 0.6 unless an administrator has moved it.
 */
export const MIN_ENROLMENT_QUALITY = 0.6;

export interface FaceSample {
  /** Exactly {@link DESCRIPTOR_LENGTH} finite floats. POST it; never print it. */
  descriptor: number[];
  /** The detector's confidence in the face it found, 0–1. */
  quality: number;
}

/**
 * The recogniser that turns a video frame into a template.
 *
 * The model lives with the attendance terminal rather than in this portal — it
 * is tens of megabytes, and a template computed by a different model than the
 * one doing the matching enrols a face that can never be recognised. The
 * terminal bundle installs an implementation on the window; where it is absent
 * this screen says so and declines to enrol, because a fabricated 128 floats
 * would be a record that looks correct and matches nobody.
 */
export interface FaceRecogniser {
  describe(source: HTMLVideoElement | HTMLCanvasElement): Promise<FaceSample | null>;
}

export function getFaceRecogniser(): FaceRecogniser | undefined {
  return (globalThis as { faceRecogniser?: FaceRecogniser }).faceRecogniser;
}

/** A sample the API would reject, caught before it is sent. */
export function isUsableSample(sample: FaceSample): boolean {
  return (
    sample.descriptor.length === DESCRIPTOR_LENGTH &&
    sample.descriptor.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    sample.quality >= 0 &&
    sample.quality <= 1
  );
}

/**
 * How to talk about an enrolment's quality.
 *
 * Below the minimum the figure itself is not the useful sentence — "0.41" tells
 * an HR manager nothing they can act on, while "weak, re-enrol" does. Above it
 * the percentage is worth showing, because the difference between a 72% and a
 * 95% template is the difference between occasional and reliable matching.
 */
export function describeQuality(
  quality: number,
  minimum: number = MIN_ENROLMENT_QUALITY,
): { weak: boolean; label: string } {
  const weak = quality < minimum;
  return {
    weak,
    label: weak
      ? `Weak — below the ${Math.round(minimum * 100)}% minimum`
      : `${Math.round(quality * 100)}%`,
  };
}
