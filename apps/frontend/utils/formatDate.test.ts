import { describe, expect, it } from 'vitest';
import { formatDate, formatDateOnly, formatDateTime } from './formatDate';

describe('formatDate', () => {
  it('renders an instant in the requested zone', () => {
    // 2026-03-01T21:00Z is already the 2nd in Muscat (UTC+4).
    expect(formatDate('2026-03-01T21:00:00Z', 'Asia/Muscat')).toBe('02/03/2026');
  });

  it('renders the same instant differently in another zone', () => {
    expect(formatDate('2026-03-01T21:00:00Z', 'UTC')).toBe('01/03/2026');
  });

  it('returns an em dash for missing or unparseable input', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('includes the time in the requested zone', () => {
    expect(formatDateTime('2026-03-01T21:00:00Z', 'Asia/Muscat')).toBe('02/03/2026 01:00');
  });
});

describe('formatDateOnly', () => {
  it('does NOT shift a date-only value across a zone boundary', () => {
    // The bug this guards: parsing as an instant makes this midnight UTC, which
    // is the 14th anywhere west of Greenwich.
    expect(formatDateOnly('2026-01-15')).toBe('15/01/2026');
  });

  it('ignores a time component the API may have appended', () => {
    expect(formatDateOnly('2026-01-15T00:00:00.000Z')).toBe('15/01/2026');
  });
});
