/**
 * Salary component codes.
 *
 * These used to be a closed nine-value enum, and the frontend mapped every
 * unrecognised library label onto `OTHER`. An admin who added HRA and DA got two
 * rows both stored and displayed as "Other", so a real salary breakup could not
 * be configured at all. The set is open now.
 *
 * What has to stay true: the nine SHIPPED labels keep their historical codes, or
 * a database that already has them grows a second code for the same concept and
 * every report that groups on component_type splits in half.
 */
import { describe, it, expect } from 'vitest';
import {
  toComponentCode,
  componentLabel,
  formatComponentTypeLabel,
  optionsFromLibrary,
  COMPONENT_CODE_PATTERN,
} from './salaryComponentUtils';

describe('toComponentCode — the shipped labels keep their codes', () => {
  // Straight from library-defaults.ts. A change here is a data-migration event,
  // not a refactor.
  it.each([
    ['Basic Salary', 'BASIC'],
    ['Allowances', 'ALLOWANCE'],
    ['Lunch Allowance', 'LUNCH'],
    ['Gasoline Allowance', 'TRANSPORT'],
    ['Telephone Allowance', 'PHONE'],
    ['Housing Allowance', 'HOUSING'],
    ['Position Allowance', 'POSITION'],
    ['Bonus', 'BONUS'],
    ['Other', 'OTHER'],
  ])('%s -> %s', (label, code) => {
    expect(toComponentCode(label)).toBe(code);
  });
});

describe('toComponentCode — admin-defined labels keep their identity', () => {
  it('no longer collapses an unknown label to OTHER', () => {
    // The entire reason this change exists.
    expect(toComponentCode('HRA')).toBe('HRA');
    expect(toComponentCode('DA')).toBe('DA');
    expect(toComponentCode('Site Allowance')).toBe('SITE_ALLOWANCE');
  });

  it('produces a code the backend DTO will accept', () => {
    for (const label of ['HRA', 'Site Allowance', 'Night Shift Premium']) {
      expect(toComponentCode(label)).toMatch(COMPONENT_CODE_PATTERN);
    }
  });

  it('prefixes rather than rejects a label starting with a digit', () => {
    // '13th Month Pay' slugifies to 13TH_MONTH_PAY, which fails the leading
    // letter rule. Rejecting it would make a legitimate label unsaveable.
    const code = toComponentCode('13th Month Pay');
    expect(code).toMatch(COMPONENT_CODE_PATTERN);
    expect(code.startsWith('C_')).toBe(true);
  });

  it('stays within the 50-character column', () => {
    const code = toComponentCode('A'.repeat(80));
    expect(code.length).toBeLessThanOrEqual(50);
    expect(code).toMatch(COMPONENT_CODE_PATTERN);
  });

  it('falls back to OTHER only for an genuinely empty label', () => {
    expect(toComponentCode('')).toBe('OTHER');
    expect(toComponentCode('   ')).toBe('OTHER');
    expect(toComponentCode('---')).toBe('OTHER');
  });

  it('is idempotent on an already-stored code', () => {
    // Round-tripping a value read back from the database must not mutate it.
    for (const code of ['HRA', 'BASIC', 'SITE_ALLOWANCE', 'PAYROLL_CONFIG']) {
      expect(toComponentCode(code)).toBe(code);
    }
  });

  it('does not let two shipped labels collide onto one code', () => {
    const labels = [
      'Basic Salary',
      'Allowances',
      'Lunch Allowance',
      'Gasoline Allowance',
      'Telephone Allowance',
      'Housing Allowance',
      'Position Allowance',
      'Bonus',
      'Other',
    ];
    const codes = labels.map(toComponentCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('formatComponentTypeLabel', () => {
  it('keeps short acronyms upper-cased', () => {
    // 'Hra' would read as a typo rather than a term of art.
    expect(formatComponentTypeLabel('HRA')).toBe('HRA');
    expect(formatComponentTypeLabel('DA')).toBe('DA');
  });

  it('prettifies a multi-word slug', () => {
    expect(formatComponentTypeLabel('SITE_ALLOWANCE')).toBe('Site Allowance');
  });
});

describe('componentLabel', () => {
  const options = [
    { value: 'HRA', label: 'House Rent Allowance' },
    { value: 'BASIC', label: 'Basic Salary' },
  ];

  it('prefers the live library label over the derived one', () => {
    expect(componentLabel('HRA', options)).toBe('House Rent Allowance');
  });

  it('falls back when the library item was renamed away', () => {
    // A stored code whose library row is gone must still render as something a
    // person can read, not as a raw slug.
    expect(componentLabel('SITE_ALLOWANCE', options)).toBe('Site Allowance');
  });

  it('survives an empty option list', () => {
    expect(componentLabel('BASIC', [])).toBeTruthy();
  });
});

describe('optionsFromLibrary', () => {
  it('derives values from labels', () => {
    const out = optionsFromLibrary([
      { label: 'Basic Salary' },
      { label: 'HRA' },
    ] as any);
    expect(out).toEqual([
      { value: 'BASIC', label: 'Basic Salary' },
      { value: 'HRA', label: 'HRA' },
    ]);
  });

  it('drops blanks and dedupes on the derived value', () => {
    // Two labels that slugify identically would otherwise give the dropdown two
    // indistinguishable entries.
    const out = optionsFromLibrary([
      { label: 'Lunch Allowance' },
      { label: 'Meal Allowance' },
      { label: '' },
    ] as any);
    expect(out.map((o) => o.value)).toEqual(['LUNCH']);
  });

  it('falls back to the shipped set when the library is empty', () => {
    // An empty dropdown would make the salary structure unusable rather than
    // merely unconfigured.
    expect(optionsFromLibrary([]).length).toBeGreaterThan(0);
  });
});
