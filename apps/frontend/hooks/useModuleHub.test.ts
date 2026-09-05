import { describe, expect, it } from 'vitest';
import { ageInDays, toDelta } from './useModuleHub';

/**
 * The two pure helpers behind every module hub card.
 *
 * `toDelta` is the one that matters: three hub figures have no history to
 * reconstruct a baseline from — `AssetItem.status` and `ProjectStatus` have no
 * history table, and `LetterRequest` carries no `rejectedAt` — so the server
 * sends `null` and the card must draw NO badge. A `0%` badge would say the
 * number held steady, which is a different claim from "we cannot tell".
 */
describe('toDelta', () => {
  const label = 'vs Jul 2026';

  it('draws no badge when the server could not establish a baseline', () => {
    expect(toDelta(null, 'up', label)).toBeUndefined();
    expect(toDelta(undefined, 'up', label)).toBeUndefined();
  });

  it('draws no badge for a change of exactly nothing', () => {
    // "Unchanged" is what the absence of a badge already says; an arrow
    // pointing at 0% is a decoration that invites a second look for no reason.
    expect(toDelta({ value: 0, direction: 'up', absolute: 0 }, 'up', label)).toBeUndefined();
  });

  it('carries the direction the server decided, not the sign of the percentage', () => {
    const delta = toDelta({ value: -4.5, direction: 'down', absolute: -4500 }, 'down', label);
    expect(delta).toMatchObject({ direction: 'down', goodDirection: 'down', label });
  });

  it('prints the absolute change when a formatter is given', () => {
    // For money, "up ₹6,500" is the sentence the reader was going to work out
    // from a percentage anyway.
    const delta = toDelta(
      { value: 54.2, direction: 'up', absolute: 6500 },
      'down',
      label,
      (abs) => `INR ${abs}`,
    );
    expect(delta?.display).toBe('INR 6500');
  });

  it('formats a percentage when no formatter is given, always positive', () => {
    const delta = toDelta({ value: -12.34, direction: 'down', absolute: -3 }, 'down', label);
    // The arrow carries the sign; repeating it in the text reads as a double
    // negative.
    expect(delta?.display).toBe('12.3%');
  });

  it('still draws a badge when the baseline was zero and only the absolute is usable', () => {
    // A percentage off zero is not a number, so the server sends `value: 0`
    // with a real `absolute`. That is NOT the same as no change.
    const delta = toDelta({ value: 0, direction: 'up', absolute: 4 }, 'up', label, String);
    expect(delta).toMatchObject({ value: 0, direction: 'up', display: '4' });
  });
});

describe('ageInDays', () => {
  it('is 0 when there is nothing to age', () => {
    expect(ageInDays(null)).toBe(0);
    expect(ageInDays(undefined)).toBe(0);
  });

  it('counts whole days elapsed', () => {
    const threeDaysAgo = new Date(Date.now() - 3.5 * 86400000).toISOString();
    expect(ageInDays(threeDaysAgo)).toBe(3);
  });

  it('never reports a negative age for a future timestamp', () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    expect(ageInDays(tomorrow)).toBe(0);
  });
});
