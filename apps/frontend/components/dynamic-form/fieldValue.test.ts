/**
 * Reading and formatting a template field's value, and deciding which fields may
 * become list columns.
 *
 * `listColumnCandidates` is the one with teeth: the employee LIST endpoint
 * selects an explicit allowlist of columns, so offering a candidate it does not
 * return renders a permanently blank column with no error anywhere. Profile-table
 * fields are excluded for the same reason — surfacing them would need a join per
 * page.
 */
import { describe, it, expect } from 'vitest';
import {
  readFieldValue,
  formatFieldValue,
  maskValue,
  displayFieldValue,
  listColumnCandidates,
} from './fieldValue';
import type { TemplateField } from '@/types/profile-template';

const field = (over: Partial<TemplateField>): TemplateField =>
  ({
    fieldKey: 'x',
    label: 'X',
    fieldType: 'TEXT',
    storage: 'JSONB',
    boundColumn: null,
    isActive: true,
    isSensitive: false,
    options: null,
    ...over,
  }) as TemplateField;

describe('readFieldValue', () => {
  const employee = {
    fullName: 'Ada',
    customFields: { grade: 'G4' },
    profile: { nationality: 'Omani' },
  };

  it('reads a bound employee column', () => {
    expect(
      readFieldValue(
        field({
          fieldKey: 'fullName',
          storage: 'COLUMN',
          boundColumn: 'employee.fullName',
        }),
        employee,
      ),
    ).toBe('Ada');
  });

  it('reads a bound profile column from the nested profile', () => {
    expect(
      readFieldValue(
        field({
          fieldKey: 'nationality',
          storage: 'COLUMN',
          boundColumn: 'employeeProfile.nationality',
        }),
        employee,
        (employee as any).profile,
      ),
    ).toBe('Omani');
  });

  it('reads a custom value out of the JSONB bag', () => {
    expect(readFieldValue(field({ fieldKey: 'grade' }), employee)).toBe('G4');
  });

  it('returns nothing for a key the record has never held', () => {
    // A pre-template employee has customFields NULL. That must read as empty
    // rather than throwing on a property of null.
    expect(
      readFieldValue(field({ fieldKey: 'grade' }), { fullName: 'Ada' }),
    ).toBeFalsy();
  });
});

describe('formatFieldValue', () => {
  it('renders a boolean as words, including false', () => {
    // 'No' is an answer; falsy-to-blank would make it look unanswered.
    expect(formatFieldValue(field({ fieldType: 'BOOLEAN' }), true)).toMatch(/yes/i);
    expect(formatFieldValue(field({ fieldType: 'BOOLEAN' }), false)).toMatch(/no/i);
  });

  it('renders a SELECT using its option label, not the stored value', () => {
    const f = field({
      fieldType: 'SELECT',
      options: [{ value: 'G4', label: 'Grade 4' }] as any,
    });
    expect(formatFieldValue(f, 'G4')).toBe('Grade 4');
  });

  it('leaves a stored value alone when no option matches', () => {
    const f = field({
      fieldType: 'SELECT',
      options: [{ value: 'G4', label: 'Grade 4' }] as any,
    });
    expect(formatFieldValue(f, 'G9')).toBe('G9');
  });

  it('returns null, not a string, for an unset value', () => {
    // null rather than '' on purpose: the read view renders
    // `displayFieldValue(...) ?? '—'`, so an empty string would print as blank
    // where an em dash is meant to say "not provided".
    expect(formatFieldValue(field({}), null)).toBeNull();
    expect(formatFieldValue(field({}), undefined)).toBeNull();
    expect(formatFieldValue(field({}), '')).toBeNull();
  });
});

describe('maskValue', () => {
  it('does not reveal the whole value', () => {
    // Last four kept so a human can still recognise the record; everything
    // before it replaced.
    expect(maskValue('1234567890')).toBe('••••7890');
  });

  it('reveals nothing at all when the value is too short to keep four', () => {
    // 'ab' has no safe tail — masking to '••ab' would expose the whole value.
    expect(maskValue('a')).toBe('••••');
    expect(maskValue('abcd')).toBe('••••');
    expect(maskValue('')).toBe('••••');
  });
});

describe('displayFieldValue', () => {
  it('masks a sensitive field', () => {
    const f = field({ fieldKey: 'idCard', isSensitive: true });
    const out = displayFieldValue(f, { customFields: { idCard: '1234567890' } });
    expect(out).not.toBe('1234567890');
  });

  it('shows a non-sensitive field in full', () => {
    const f = field({ fieldKey: 'grade' });
    expect(displayFieldValue(f, { customFields: { grade: 'G4' } })).toBe('G4');
  });
});

describe('listColumnCandidates', () => {
  it('offers custom JSONB fields', () => {
    // customFields is in the list endpoint's select, so these render.
    const out = listColumnCandidates([field({ fieldKey: 'grade' })]);
    expect(out.map((f) => f.fieldKey)).toContain('grade');
  });

  it('never offers a profile-table field', () => {
    // The list endpoint does not join employee_profiles, so this column would
    // be blank on every row with nothing to indicate why.
    const out = listColumnCandidates([
      field({
        fieldKey: 'nationality',
        storage: 'COLUMN',
        boundColumn: 'employeeProfile.nationality',
      }),
    ]);
    expect(out.map((f) => f.fieldKey)).not.toContain('nationality');
  });

  it('never offers a column the table already shows', () => {
    // Duplicating Full Name as an "extra" column is noise, not a feature.
    const out = listColumnCandidates([
      field({
        fieldKey: 'fullName',
        storage: 'COLUMN',
        boundColumn: 'employee.fullName',
      }),
    ]);
    expect(out.map((f) => f.fieldKey)).not.toContain('fullName');
  });

  it('returns an empty list when nothing qualifies', () => {
    // ColumnPicker renders null on an empty list rather than an empty popover.
    expect(listColumnCandidates([])).toEqual([]);
  });
});
