/**
 * "Optional to fill in" and "accepts NULL" are different properties.
 *
 * Conflating them produced a 500 on PATCH /employees/:id/profile:
 * `numberOfChildren Int @default(0)` is NOT NULL, so nobody has to supply it
 * and every layer above treated it as optional — but clearing the field sent
 * `null` and Prisma rejected the statement. The error it emits for this reads
 * `Argument 'employee' is missing`, because one unmatchable field makes the
 * object fail to match UncheckedCreateInput and Prisma falls back to describing
 * the checked variant. Nothing in it names the field that caused the failure,
 * which is most of why this was worth encoding.
 */
import { Prisma } from '@prisma/client';
import {
  notNullColumns,
  stripUnsettableNulls,
} from './nullable-columns.util';

describe('notNullColumns', () => {
  it('reports a NOT NULL column that carries a default', () => {
    // The exact column from the incident. Optional to the user, not nullable
    // to Postgres.
    expect(notNullColumns('EmployeeProfile').has('numberOfChildren')).toBe(true);
  });

  it('does not report a genuinely nullable column', () => {
    expect(notNullColumns('EmployeeProfile').has('placeOfBirth')).toBe(false);
    expect(notNullColumns('Employee').has('phoneCountryCode')).toBe(false);
  });

  it('agrees with the schema for every scalar on Employee', () => {
    // Derived, not hand-listed: making a column nullable must change this
    // answer without anyone remembering to edit a list.
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Employee')!;
    const expected = model.fields
      .filter((f) => (f.kind === 'scalar' || f.kind === 'enum') && f.isRequired)
      .map((f) => f.name)
      .sort();
    expect([...notNullColumns('Employee')].sort()).toEqual(expected);
  });

  it('throws on a model that does not exist rather than returning nothing', () => {
    // An empty set would silently strip nothing and let the 500 back in.
    expect(() => notNullColumns('NotARealModel')).toThrow(/not found/i);
  });
});

describe('stripUnsettableNulls', () => {
  it('drops a null aimed at a NOT NULL column', () => {
    const out = stripUnsettableNulls(
      { numberOfChildren: null, placeOfBirth: 'Muscat' },
      'EmployeeProfile',
    );
    expect('numberOfChildren' in out).toBe(false);
    expect(out.placeOfBirth).toBe('Muscat');
  });

  it('keeps a null aimed at a nullable column', () => {
    // Clearing a field that CAN be cleared still has to work — this guard must
    // not become a blanket "never write null".
    const out = stripUnsettableNulls(
      { placeOfBirth: null },
      'EmployeeProfile',
    );
    expect(out.placeOfBirth).toBeNull();
  });

  it('drops rather than substituting the column default', () => {
    // Writing 0 because someone cleared a box is a guess about intent, and a
    // silently wrong dependants count is worse than the value staying put.
    const out = stripUnsettableNulls({ numberOfChildren: null }, 'EmployeeProfile');
    expect(out).toEqual({});
  });

  it('leaves undefined alone', () => {
    // Prisma already reads undefined as "leave this column alone"; rewriting it
    // would change a no-op into something else.
    const out = stripUnsettableNulls(
      { numberOfChildren: undefined },
      'EmployeeProfile',
    );
    expect('numberOfChildren' in out).toBe(true);
    expect(out.numberOfChildren).toBeUndefined();
  });

  it('keeps real values of every falsy shape', () => {
    const out = stripUnsettableNulls(
      { numberOfChildren: 0, placeOfBirth: '' },
      'EmployeeProfile',
    );
    expect(out.numberOfChildren).toBe(0);
    expect(out.placeOfBirth).toBe('');
  });

  it('works on Employee too', () => {
    const out = stripUnsettableNulls(
      { status: null, phoneCountryCode: null },
      'Employee',
    );
    // status is NOT NULL with a default; phoneCountryCode is nullable.
    expect('status' in out).toBe(false);
    expect(out.phoneCountryCode).toBeNull();
  });

  it('passes through keys the model does not declare', () => {
    // Nested writes and relation payloads sit alongside scalars; this guard is
    // about nulls on real columns and must not eat anything else.
    const out = stripUnsettableNulls(
      { customFields: { a: 1 }, profile: { create: {} } } as any,
      'Employee',
    );
    expect(out.customFields).toEqual({ a: 1 });
    expect(out.profile).toEqual({ create: {} });
  });
});
