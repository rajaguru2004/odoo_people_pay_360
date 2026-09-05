import {
  readFieldValue,
  formatFieldValue,
  readFormatted,
} from './employee-field-values';

/**
 * Export, letters and the profile read view all route through this, so a wrong
 * answer here shows up in a spreadsheet, a legal document and the UI at once.
 */
describe('readFieldValue', () => {
  const employee = {
    fullName: 'Ada',
    baseSalary: 5000,
    customFields: { jobGrade: 'G4' },
    profile: { nationality: 'Omani' },
  };

  it('reads a field bound to the employees table', () => {
    expect(
      readFieldValue({ employee }, { fieldKey: 'fullName', storage: 'COLUMN' }),
    ).toBe('Ada');
  });

  it('reads a field bound to employee_profiles via the nested include', () => {
    expect(
      readFieldValue({ employee }, { fieldKey: 'nationality', storage: 'COLUMN' }),
    ).toBe('Omani');
  });

  it('prefers an explicitly passed profile over the nested one', () => {
    // Callers that fetch the profile separately must not be silently ignored.
    expect(
      readFieldValue(
        { employee, profile: { nationality: 'Indian' } },
        { fieldKey: 'nationality', storage: 'COLUMN' },
      ),
    ).toBe('Indian');
  });

  it('reads a custom field out of the JSONB bag', () => {
    expect(
      readFieldValue({ employee }, { fieldKey: 'jobGrade', storage: 'JSONB' }),
    ).toBe('G4');
  });

  it('returns undefined for a key the registry does not know', () => {
    expect(
      readFieldValue({ employee }, { fieldKey: 'nope', storage: 'COLUMN' }),
    ).toBeUndefined();
  });

  it('survives a missing bag and a missing profile', () => {
    expect(
      readFieldValue({ employee: {} }, { fieldKey: 'jobGrade', storage: 'JSONB' }),
    ).toBeUndefined();
    expect(
      readFieldValue({ employee: {} }, { fieldKey: 'nationality', storage: 'COLUMN' }),
    ).toBeUndefined();
  });
});

describe('formatFieldValue', () => {
  const f = (over: Record<string, unknown> = {}) => ({
    fieldKey: 'k',
    storage: 'JSONB',
    ...over,
  });

  it('renders a blank for an unset value', () => {
    expect(formatFieldValue(f(), null)).toBe('');
    expect(formatFieldValue(f(), undefined)).toBe('');
    expect(formatFieldValue(f(), '')).toBe('');
  });

  it('honours a custom blank, which letters use for missing fields', () => {
    expect(formatFieldValue(f(), null, { blank: '—' })).toBe('—');
  });

  it('renders booleans as words, not true/false', () => {
    expect(formatFieldValue(f({ fieldType: 'BOOLEAN' }), true)).toBe('Yes');
    expect(formatFieldValue(f({ fieldType: 'BOOLEAN' }), false)).toBe('No');
  });

  it('resolves a SELECT to its label', () => {
    const field = f({
      fieldType: 'SELECT',
      options: [{ value: 'MALE', label: 'Male' }],
    });
    expect(formatFieldValue(field, 'MALE')).toBe('Male');
  });

  it('falls back to the raw value when no option matches', () => {
    const field = f({ fieldType: 'SELECT', options: [{ value: 'A', label: 'Alpha' }] });
    expect(formatFieldValue(field, 'Z')).toBe('Z');
  });

  it('joins a MULTISELECT through its labels', () => {
    const field = f({
      fieldType: 'MULTISELECT',
      options: [
        { value: 'A', label: 'Alpha' },
        { value: 'B', label: 'Beta' },
      ],
    });
    expect(formatFieldValue(field, ['A', 'B'])).toBe('Alpha, Beta');
  });

  it('formats dates and leaves an unparseable one alone', () => {
    expect(formatFieldValue(f({ fieldType: 'DATE' }), '2026-03-01')).toContain('2026');
    expect(formatFieldValue(f({ fieldType: 'DATE' }), 'not a date')).toBe('not a date');
  });

  it('never emits [object Object] into a spreadsheet or a letter', () => {
    const out = formatFieldValue(f(), { a: 1 });
    expect(out).not.toBe('[object Object]');
    expect(out).toBe('{"a":1}');
  });

  it('stringifies Decimal-like wrappers through their own toString', () => {
    const decimal = { toString: () => '1234.50' };
    expect(formatFieldValue(f(), decimal)).toBe('1234.50');
  });
});

describe('readFormatted', () => {
  it('reads and formats in one step', () => {
    expect(
      readFormatted(
        { employee: { customFields: { onSite: true } } },
        { fieldKey: 'onSite', storage: 'JSONB', fieldType: 'BOOLEAN' },
      ),
    ).toBe('Yes');
  });
});
