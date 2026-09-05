import {
  validateDynamicData,
  validateDynamicValue,
  normalizeDynamicValue,
  maskDynamicData,
} from './validate-dynamic-data';
import { FieldDef } from './field-def';

const field = (over: Partial<FieldDef> = {}): FieldDef => ({
  fieldKey: 'f',
  label: 'Field',
  fieldType: 'TEXT',
  validationType: 'NONE',
  required: false,
  displayOrder: 1,
  isSensitive: false,
  ...over,
});

describe('validateDynamicValue', () => {
  it.each([
    ['EMAIL', 'a@b.co', null],
    ['EMAIL', 'nope', 'Invalid email address'],
    ['PHONE', '+968 9123 4567', null],
    ['PHONE', 'abc', 'Invalid phone number'],
    ['URL', 'https://x.dev/a', null],
    ['URL', 'x.dev', 'Invalid URL'],
    ['DATE', '2026-02-30', 'Invalid date'],
    ['DATE', '2026-02-10', null],
    ['NUMBER', '0012', null],
    ['NUMBER', '1.5', 'Must be digits only'],
    ['IFSC', 'HDFC0001234', null],
    ['SORT_CODE', '123456', null],
    ['ROUTING', '12345678', 'Routing number must be 9 digits'],
  ])('%s of %s', (validationType, value, expected) => {
    expect(validateDynamicValue(field({ validationType }), value)).toBe(
      expected,
    );
  });

  it('treats an empty value as the caller requiredness problem, not an error', () => {
    expect(validateDynamicValue(field({ validationType: 'EMAIL' }), '')).toBeNull();
  });

  it('never blocks the user on a broken configured regex', () => {
    // A bad pattern is an admin mistake. Refusing every save would be worse
    // than accepting the value — carried over from the banking original.
    const f = field({ validationType: 'REGEX', regex: '([unclosed' });
    expect(validateDynamicValue(f, 'anything')).toBeNull();
  });

  it('enforces a working regex', () => {
    const f = field({ validationType: 'REGEX', regex: '^\\d{8}$' });
    expect(validateDynamicValue(f, '12345678')).toBeNull();
    expect(validateDynamicValue(f, '1234')).toBe('Invalid format');
  });

  it('applies RANGE bounds', () => {
    const f = field({ validationType: 'RANGE', minValue: 1900, maxValue: 2100 });
    expect(validateDynamicValue(f, '1999')).toBeNull();
    expect(validateDynamicValue(f, '1800')).toBe('Must be at least 1900');
    expect(validateDynamicValue(f, '2200')).toBe('Must be at most 2100');
    expect(validateDynamicValue(f, 'x')).toBe('Must be a number');
  });

  it('applies LENGTH bounds', () => {
    const f = field({ validationType: 'LENGTH', minLength: 3, maxLength: 5 });
    expect(validateDynamicValue(f, 'abcd')).toBeNull();
    expect(validateDynamicValue(f, 'ab')).toBe('Must be at least 3 characters');
    expect(validateDynamicValue(f, 'abcdef')).toBe('Must be at most 5 characters');
  });

  it('checks DATE_PAST and DATE_FUTURE against now', () => {
    const past = field({ validationType: 'DATE_PAST' });
    const future = field({ validationType: 'DATE_FUTURE' });
    expect(validateDynamicValue(past, '1990-01-01')).toBeNull();
    expect(validateDynamicValue(past, '2999-01-01')).toBe(
      'Date must be in the past',
    );
    expect(validateDynamicValue(future, '2999-01-01')).toBeNull();
    expect(validateDynamicValue(future, '1990-01-01')).toBe(
      'Date must be in the future',
    );
  });

  it('skips LIBRARY_ITEM when the caller could not supply the option set', () => {
    // Guessing would reject every value on a service that has no lookup wired.
    const f = field({ validationType: 'LIBRARY_ITEM', optionSource: 'POSITION' });
    expect(validateDynamicValue(f, 'Fitter')).toBeNull();
    expect(
      validateDynamicValue(f, 'Fitter', {
        allowedOptions: { POSITION: new Set(['Welder']) },
      }),
    ).toBe('Not an available option');
  });
});

describe('normalizeDynamicValue', () => {
  it('strips separators for bank identifiers', () => {
    expect(normalizeDynamicValue('SORT_CODE', '12-34 56')).toBe('123456');
    expect(normalizeDynamicValue('SWIFT', ' bkmb om rx ')).toBe('BKMBOMRX');
  });

  it('lowercases emails so a duplicate cannot slip past a unique check', () => {
    expect(normalizeDynamicValue('EMAIL', ' A@B.CO ')).toBe('a@b.co');
  });
});

describe('validateDynamicData', () => {
  const fields: FieldDef[] = [
    field({ fieldKey: 'grade', label: 'Grade', required: true }),
    field({ fieldKey: 'age', label: 'Age', fieldType: 'NUMBER' }),
    field({ fieldKey: 'active', label: 'Active', fieldType: 'BOOLEAN' }),
    field({
      fieldKey: 'shift',
      label: 'Shift',
      fieldType: 'SELECT',
      options: [
        { value: 'DAY', label: 'Day' },
        { value: 'NIGHT', label: 'Night' },
      ],
    }),
  ];

  it('coerces to the field type', () => {
    const r = validateDynamicData(
      { grade: ' G4 ', age: '42', active: 'yes', shift: 'DAY' },
      fields,
    );
    expect(r.valid).toBe(true);
    expect(r.normalized).toEqual({
      grade: 'G4',
      age: 42,
      active: true,
      shift: 'DAY',
    });
  });

  it('reports a type error rather than storing a NaN', () => {
    const r = validateDynamicData({ grade: 'G4', age: 'old' }, fields);
    expect(r.valid).toBe(false);
    expect(r.errors.age).toBe('Age must be a valid number');
    expect(r.normalized).not.toHaveProperty('age');
  });

  it('enforces a SELECT option set even when validationType is NONE', () => {
    // Otherwise "choices" would be a rendering hint the API happily ignores.
    const r = validateDynamicData({ grade: 'G4', shift: 'SWING' }, fields);
    expect(r.valid).toBe(false);
    expect(r.errors.shift).toContain('not an allowed option');
  });

  it('enforces required on a full submit', () => {
    const r = validateDynamicData({ age: '30' }, fields);
    expect(r.errors.grade).toBe('Grade is required');
  });

  it('skips absent keys under partial, so PATCH does not demand every field', () => {
    const r = validateDynamicData({ age: '30' }, fields, { partial: true });
    expect(r.valid).toBe(true);
    expect(r.normalized).toEqual({ age: 30 });
  });

  it('still enforces required when PATCH explicitly clears a field', () => {
    const r = validateDynamicData({ grade: '' }, fields, { partial: true });
    expect(r.errors.grade).toBe('Grade is required');
  });

  it('keeps an explicit null as a deliberate clear', () => {
    const r = validateDynamicData({ age: null }, fields, { partial: true });
    expect(r.valid).toBe(true);
    expect(r.normalized).toEqual({ age: null });
  });

  it('rejects unknown keys when asked to', () => {
    // The employee template's mode: a typo'd field that silently vanishes after
    // "Saved!" is worse than a 400.
    const r = validateDynamicData({ grade: 'G4', typo: 'x' }, fields, {
      unknownKeys: 'reject',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.typo).toContain('Unknown field');
  });

  it('drops unknown keys when asked to — the banking behaviour', () => {
    const r = validateDynamicData({ grade: 'G4', legacy: 'x' }, fields, {
      unknownKeys: 'drop',
    });
    expect(r.valid).toBe(true);
    expect(r.normalized).not.toHaveProperty('legacy');
  });

  it('prefixes error keys so they match the submitted request path', () => {
    const r = validateDynamicData({}, fields, {
      errorKeyPrefix: 'customFields',
    });
    expect(r.errors['customFields.grade']).toBe('Grade is required');
  });

  it('validates MULTISELECT members individually', () => {
    const multi = [
      field({
        fieldKey: 'skills',
        label: 'Skills',
        fieldType: 'MULTISELECT',
        options: [
          { value: 'A', label: 'A' },
          { value: 'B', label: 'B' },
        ],
      }),
    ];
    expect(validateDynamicData({ skills: ['A', 'B'] }, multi).valid).toBe(true);
    const bad = validateDynamicData({ skills: ['A', 'Z'] }, multi);
    expect(bad.errors.skills).toContain('Z');
    expect(validateDynamicData({ skills: 'A' }, multi).errors.skills).toContain(
      'valid multiselect',
    );
  });
});

describe('maskDynamicData', () => {
  it('keeps the last four of a sensitive value', () => {
    const fields = [
      field({ fieldKey: 'ssn', isSensitive: true }),
      field({ fieldKey: 'grade' }),
    ];
    expect(maskDynamicData({ ssn: '123456789', grade: 'G4' }, fields)).toEqual({
      ssn: '••••6789',
      grade: 'G4',
    });
  });

  it('masks a short sensitive value entirely', () => {
    const fields = [field({ fieldKey: 'pin', isSensitive: true })];
    expect(maskDynamicData({ pin: '12' }, fields)).toEqual({ pin: '••••' });
  });
});
