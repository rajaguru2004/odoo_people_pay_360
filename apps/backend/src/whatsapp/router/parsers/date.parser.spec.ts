import { DateTime } from 'luxon';
import { parseDateWord } from './date.parser';

/** Fixed "now" so relative words are deterministic: Sat 08 Aug 2026. */
const NOW = DateTime.fromISO('2026-08-08T10:00:00Z', { zone: 'utc' }) as DateTime<true>;

describe('parseDateWord', () => {
  it.each([
    ['2026-09-01', '2026-09-01'],
    ['01/09/2026', '2026-09-01'],
    ['1/9/2026', '2026-09-01'],
    ['01-09-2026', '2026-09-01'],
  ])('reads the explicit format %p', (input, expected) => {
    expect(parseDateWord(input, NOW)).toBe(expected);
  });

  it.each([
    ['today', '2026-08-08'],
    ['tomorrow', '2026-08-09'],
    ['day after tomorrow', '2026-08-10'],
  ])('reads %p', (input, expected) => {
    expect(parseDateWord(input, NOW)).toBe(expected);
  });

  it('reads "next <weekday>"', () => {
    // 08 Aug 2026 is a Saturday.
    expect(parseDateWord('next monday', NOW)).toBe('2026-08-10');
    expect(parseDateWord('next friday', NOW)).toBe('2026-08-14');
  });

  it('assumes the NEXT occurrence for a day/month with no year', () => {
    // "01/09" in August means this September...
    expect(parseDateWord('01/09', NOW)).toBe('2026-09-01');
    // ...and a date already past means next year, not a request in the past.
    expect(parseDateWord('01/07', NOW)).toBe('2027-07-01');
  });

  it('rejects a date far outside any plausible request', () => {
    // Guards the classic typo: 2062 instead of 2026.
    expect(parseDateWord('2062-09-01', NOW)).toBeNull();
    expect(parseDateWord('1999-01-01', NOW)).toBeNull();
  });

  it.each(['', '   ', 'sometime', 'next week', '32/13/2026', 'yes', null, undefined])(
    'returns null for %p rather than guessing',
    (input) => {
      // A mis-read date silently books the wrong leave.
      expect(parseDateWord(input as any, NOW)).toBeNull();
    },
  );

  it('is case- and whitespace-insensitive', () => {
    expect(parseDateWord('  ToMoRRoW ', NOW)).toBe('2026-08-09');
  });
});
