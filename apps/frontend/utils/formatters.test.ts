import { describe, expect, it } from 'vitest';
import {
  compactFigureText,
  formatCurrency,
  formatCurrencyCompact,
  formatNumber,
  formatPercent,
  fullName,
  initials,
} from './formatters';

describe('formatCurrency', () => {
  it('renders OMR with three decimals — these are thousandths, not hundredths', () => {
    expect(formatCurrency(125.5, 'OMR')).toContain('125.500');
  });

  it('renders a two-decimal currency with two', () => {
    expect(formatCurrency(125.5, 'AED')).toContain('125.50');
  });

  it('keeps trailing zeros so an exact amount still reconciles', () => {
    expect(formatCurrency(1200, 'OMR')).toContain('1,200.000');
  });

  it('accepts the string Prisma Decimal serialises to', () => {
    expect(formatCurrency('99.250', 'OMR')).toContain('99.250');
  });

  it('falls back to two decimals for a currency it has never seen', () => {
    expect(formatCurrency(10, 'XYZ' as string)).toMatch(/10\.00/);
  });

  it('renders an em dash rather than NaN for missing input', () => {
    expect(formatCurrency(null)).toBe('—');
    expect(formatCurrency(undefined)).toBe('—');
    expect(formatCurrency('not a number')).toBe('—');
  });
});

describe('formatNumber / formatPercent', () => {
  it('groups thousands', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('renders a percentage to one decimal by default', () => {
    expect(formatPercent(12.345)).toBe('12.3%');
  });
});

describe('fullName / initials', () => {
  it('joins the parts', () => {
    expect(fullName({ firstName: 'Aisha', lastName: 'Al Balushi' })).toBe('Aisha Al Balushi');
  });

  it('tolerates a missing half', () => {
    expect(fullName({ firstName: 'Aisha', lastName: null })).toBe('Aisha');
  });

  it('returns an em dash for no person at all', () => {
    expect(fullName(null)).toBe('—');
  });

  it('builds two-letter initials', () => {
    expect(initials({ firstName: 'Aisha', lastName: 'Al Balushi' })).toBe('AA');
  });

  it('falls back to ? when there is nothing to initial', () => {
    expect(initials({ firstName: '', lastName: '' })).toBe('?');
  });
});

/**
 * `Intl` separates the currency code from the amount with a NON-BREAKING space,
 * so the code can never be orphaned on its own line. Normalise it here rather
 * than asserting the literal, which is invisible in a diff and in a failure
 * message reads as an identical string that is not equal.
 */
const plain = (s: string) => s.replace(/ /g, ' ');

describe('formatCurrencyCompact', () => {
  it('shortens a long figure to a magnitude suffix', () => {
    expect(plain(formatCurrencyCompact(23567.125, 'OMR'))).toBe('OMR 23.6K');
    expect(plain(formatCurrencyCompact(1240000, 'OMR'))).toBe('OMR 1.2M');
  });

  it('leaves anything under a thousand to formatCurrency, decimals and all', () => {
    // The currency still owns the precision: OMR is thousandths, and only the
    // MAGNITUDE is what abbreviating gives up.
    expect(formatCurrencyCompact(125.5, 'OMR')).toBe(formatCurrency(125.5, 'OMR'));
    expect(formatCurrencyCompact(125.5, 'OMR')).toContain('125.500');
    expect(formatCurrencyCompact(125.5, 'AED')).toContain('125.50');
  });

  it('keeps the sign on a negative', () => {
    expect(formatCurrencyCompact(-1234567, 'OMR')).toContain('-');
    expect(formatCurrencyCompact(-1234567, 'OMR')).toContain('1.2M');
  });

  it('renders an em dash rather than NaN for missing input', () => {
    expect(formatCurrencyCompact(null)).toBe('—');
    expect(formatCurrencyCompact(undefined)).toBe('—');
    expect(formatCurrencyCompact('not a number')).toBe('—');
  });

  it('accepts the string Prisma Decimal serialises to', () => {
    expect(plain(formatCurrencyCompact('23567.125', 'OMR'))).toBe('OMR 23.6K');
  });
});

describe('compactFigureText', () => {
  it('rewrites only the number inside an already-formatted figure', () => {
    expect(compactFigureText('OMR 23,567.125')).toBe('OMR 23.6K');
    expect(plain(compactFigureText(formatCurrency(23567.125, 'OMR')))).toBe('OMR 23.6K');
    expect(compactFigureText('1,234,567')).toBe('1.2M');
  });

  it('keeps a leading minus outside the currency code where the formatter put it', () => {
    expect(compactFigureText('-OMR 1,234,567.000')).toBe('-OMR 1.2M');
    expect(compactFigureText('-1,234,567')).toBe('-1.2M');
  });

  it('leaves a figure under a thousand alone rather than rounding across it', () => {
    // "OMR 9,999.999" -> "OMR 10K" would round past a magnitude the reader is
    // looking at; a long line is the lesser harm.
    expect(compactFigureText('OMR 999.500')).toBe('OMR 999.500');
    expect(compactFigureText('42')).toBe('42');
  });

  it('leaves a YEAR alone — a period label is not a magnitude', () => {
    // Hub cards carry "August 2026" and run references in the same slot as
    // money, and a bare 2026 is over the compaction floor. Without the
    // formatted-quantity guard the card renames the period to "Jun 2K".
    expect(compactFigureText('Jun 2026')).toBe('Jun 2026');
    expect(compactFigureText('August 2026')).toBe('August 2026');
    expect(compactFigureText('2026')).toBe('2026');
    expect(compactFigureText('Run 2026-08 · 41 payslips')).toBe('Run 2026-08 · 41 payslips');
  });

  it('still compacts anything a formatter has grouped or pointed', () => {
    expect(compactFigureText('OMR 23,567.125')).toBe('OMR 23.6K');
    expect(compactFigureText('1234567.5')).toBe('1.2M');
  });

  it('leaves a string with no number in it untouched', () => {
    expect(compactFigureText('—')).toBe('—');
    expect(compactFigureText('Not reported')).toBe('Not reported');
  });
});
