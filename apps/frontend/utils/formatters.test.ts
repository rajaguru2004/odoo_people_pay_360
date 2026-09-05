import { describe, expect, it } from 'vitest';
import { formatCurrency, formatNumber, formatPercent, fullName, initials } from './formatters';

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
