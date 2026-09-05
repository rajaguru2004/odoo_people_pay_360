import { describe, expect, it } from 'vitest';
import {
  DESCRIPTOR_LENGTH,
  MIN_ENROLMENT_QUALITY,
  describeQuality,
  isUsableSample,
} from './faceCapture';

const descriptor = Array.from({ length: DESCRIPTOR_LENGTH }, (_, i) => i / 100);

describe('describeQuality', () => {
  it('names a weak template instead of printing a number nobody can act on', () => {
    const { weak, label } = describeQuality(0.41);
    expect(weak).toBe(true);
    expect(label).toBe('Weak — below the 60% minimum');
  });

  it('prints the figure once the template clears the minimum', () => {
    expect(describeQuality(0.82)).toEqual({ weak: false, label: '82%' });
  });

  it('treats exactly the minimum as good enough', () => {
    expect(describeQuality(MIN_ENROLMENT_QUALITY).weak).toBe(false);
  });

  it('reads the minimum it is given rather than the built-in default', () => {
    expect(describeQuality(0.7, 0.9).weak).toBe(true);
    expect(describeQuality(0.7, 0.5).weak).toBe(false);
  });
});

describe('isUsableSample', () => {
  it('accepts a full-width, finite descriptor', () => {
    expect(isUsableSample({ descriptor, quality: 0.8 })).toBe(true);
  });

  it('refuses a descriptor of the wrong width before the server has to', () => {
    expect(isUsableSample({ descriptor: descriptor.slice(0, 64), quality: 0.8 })).toBe(false);
  });

  it('refuses a descriptor carrying anything that is not a finite number', () => {
    const broken = [...descriptor];
    broken[7] = Number.NaN;
    expect(isUsableSample({ descriptor: broken, quality: 0.8 })).toBe(false);
  });

  it('refuses a confidence outside 0–1', () => {
    expect(isUsableSample({ descriptor, quality: 1.4 })).toBe(false);
  });
});
