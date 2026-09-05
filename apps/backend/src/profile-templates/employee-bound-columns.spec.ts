/**
 * The registry in `employee-bound-columns.ts` claims a mapping between template
 * field keys and real Prisma columns. Nothing at runtime re-checks that claim —
 * a stale entry would write to a column that no longer exists, or (worse) let an
 * admin deactivate a field the DB still demands, and the failure would surface
 * as a 500 on employee create in production.
 *
 * So the schema itself is the assertion: every check below reads
 * `Prisma.dmmf.datamodel` rather than a hand-maintained list. Rename a column in
 * schema.prisma without updating the registry and this suite goes red.
 *
 * Mirrors the intent of `src/library-items/library-coverage.spec.ts`.
 */
import { Prisma } from '@prisma/client';
import {
  BOUND_BY_KEY,
  EMPLOYEE_BOUND_COLUMNS,
  EXCLUDED_COLUMNS,
  LOCKED_FIELD_KEYS,
  splitByStorage,
} from './employee-bound-columns';

type TableKey = 'employee' | 'employeeProfile';

const MODEL_OF: Record<TableKey, string> = {
  employee: 'Employee',
  employeeProfile: 'EmployeeProfile',
};

function scalarsOf(modelName: string) {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) throw new Error(`Model ${modelName} not found in Prisma dmmf`);
  return model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum');
}

describe('EMPLOYEE_BOUND_COLUMNS', () => {
  it('has no duplicate fieldKey', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const c of EMPLOYEE_BOUND_COLUMNS) {
      if (seen.has(c.fieldKey)) dupes.push(c.fieldKey);
      seen.add(c.fieldKey);
    }
    expect(dupes).toEqual([]);
    expect(BOUND_BY_KEY.size).toBe(EMPLOYEE_BOUND_COLUMNS.length);
  });

  it('has no duplicate (table, column) target', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const c of EMPLOYEE_BOUND_COLUMNS) {
      const k = `${c.table}.${c.column}`;
      if (seen.has(k)) dupes.push(k);
      seen.add(k);
    }
    expect(dupes).toEqual([]);
  });

  it('every bound column exists on its Prisma model', () => {
    const missing: string[] = [];
    for (const c of EMPLOYEE_BOUND_COLUMNS) {
      const names = scalarsOf(MODEL_OF[c.table]).map((f) => f.name);
      if (!names.includes(c.column)) missing.push(`${c.table}.${c.column}`);
    }
    expect(missing).toEqual([]);
  });

  it('marks systemRequired exactly when the column is NOT NULL with no DB default', () => {
    // This is the floor the template engine enforces: a column the DB will not
    // fill for us can never be made optional by an admin, at any scope.
    const wrong: string[] = [];
    for (const c of EMPLOYEE_BOUND_COLUMNS) {
      const field = scalarsOf(MODEL_OF[c.table]).find(
        (f) => f.name === c.column,
      );
      if (!field) continue; // reported by the previous test
      const mandatory = field.isRequired && !field.hasDefaultValue;
      if (mandatory !== c.systemRequired) {
        wrong.push(
          `${c.fieldKey}: registry systemRequired=${c.systemRequired}, schema says ${mandatory}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it('locks every systemRequired field', () => {
    // Deactivating a field the DB demands would make employee create fail with
    // a Prisma error instead of a validation message.
    const unlocked = EMPLOYEE_BOUND_COLUMNS.filter(
      (c) => c.systemRequired && !c.locked,
    ).map((c) => c.fieldKey);
    expect(unlocked).toEqual([]);
  });

  it('gives every locked field a reason for the builder tooltip', () => {
    const noReason = EMPLOYEE_BOUND_COLUMNS.filter(
      (c) => c.locked && !c.reason?.trim(),
    ).map((c) => c.fieldKey);
    expect(noReason).toEqual([]);
  });

  it('binds every editable column on Employee and EmployeeProfile', () => {
    // Catches the real drift risk in the other direction: a column added to
    // schema.prisma that nobody bound, which would silently never appear on any
    // form. Genuinely non-form columns belong in EXCLUDED_COLUMNS, deliberately.
    const unbound: string[] = [];
    for (const table of Object.keys(MODEL_OF) as TableKey[]) {
      const bound = new Set(
        EMPLOYEE_BOUND_COLUMNS.filter((c) => c.table === table).map(
          (c) => c.column,
        ),
      );
      const excluded = new Set(EXCLUDED_COLUMNS[table]);
      for (const f of scalarsOf(MODEL_OF[table])) {
        if (bound.has(f.name) || excluded.has(f.name)) continue;
        unbound.push(`${table}.${f.name}`);
      }
    }
    expect(unbound).toEqual([]);
  });

  it('lists only real columns in EXCLUDED_COLUMNS', () => {
    const stale: string[] = [];
    for (const table of Object.keys(MODEL_OF) as TableKey[]) {
      const names = new Set(scalarsOf(MODEL_OF[table]).map((f) => f.name));
      for (const col of EXCLUDED_COLUMNS[table]) {
        if (!names.has(col)) stale.push(`${table}.${col}`);
      }
    }
    // `customFields` is added to Employee in the profile-templates migration;
    // until then it is legitimately absent, so allow exactly that one.
    expect(stale.filter((s) => s !== 'employee.customFields')).toEqual([]);
  });

  it('exposes the locked keys the builder renders with a lock icon', () => {
    expect(LOCKED_FIELD_KEYS).toContain('baseSalary');
    expect(LOCKED_FIELD_KEYS).toContain('branchId');
    expect(LOCKED_FIELD_KEYS).not.toContain('gender');
  });
});

describe('splitByStorage', () => {
  const fields = [
    { fieldKey: 'fullName' }, // employees.full_name
    { fieldKey: 'nationality' }, // employee_profiles.nationality
    { fieldKey: 'employeeGrade' }, // custom => JSONB
  ];

  it('routes bound keys to their table and unknown keys to the JSONB bag', () => {
    const out = splitByStorage(
      { fullName: 'Ada', nationality: 'Omani', employeeGrade: 'G4' },
      fields,
    );
    expect(out.employee).toEqual({ fullName: 'Ada' });
    expect(out.profile).toEqual({ nationality: 'Omani' });
    expect(out.custom).toEqual({ employeeGrade: 'G4' });
  });

  it('ignores template fields the caller did not submit', () => {
    // A PATCH must not blank a field just because the template declares it.
    const out = splitByStorage({ fullName: 'Ada' }, fields);
    expect(out.profile).toEqual({});
    expect(out.custom).toEqual({});
  });

  it('routes an explicit null through rather than dropping it', () => {
    // Clearing an optional field is a legitimate edit; `undefined` would be a
    // Prisma no-op, so the distinction has to survive the split.
    const out = splitByStorage({ nationality: null }, fields);
    expect(out.profile).toEqual({ nationality: null });
  });

  it('drops keys the template does not declare', () => {
    const out = splitByStorage({ notInTemplate: 'x' }, fields);
    expect(out.employee).toEqual({});
    expect(out.profile).toEqual({});
    expect(out.custom).toEqual({});
  });
});

/**
 * phoneCountryCode has to be a bound field, not an exclusion.
 *
 * The profile-template branch rewrote the employee forms into a template
 * renderer while main had just added a hand-written phone-country picker to
 * them. Taking the rewritten forms deleted that picker, and the column was not
 * in this registry, so the template could not render it either — the field went
 * dead on every surface while the API happily kept accepting it.
 *
 * The sweep above catches that as `employee.phoneCountryCode` unbound. The
 * cheap way to make it green is to add the column to EXCLUDED_COLUMNS, which
 * silences the test and leaves the field dead forever. These cases exist to
 * make that shortcut fail loudly.
 */
describe('phoneCountryCode is bound, not excluded', () => {
  it('binds to the real employees column', () => {
    expect(BOUND_BY_KEY.get('phoneCountryCode')).toMatchObject({
      table: 'employee',
      column: 'phoneCountryCode',
      type: 'PHONE_COUNTRY',
    });
  });

  it('is not in EXCLUDED_COLUMNS', () => {
    // The anti-shortcut assertion. Excluding it would turn the sweep green and
    // permanently remove the field from every form.
    expect(EXCLUDED_COLUMNS.employee).not.toContain('phoneCountryCode');
  });

  it('is optional and unlocked', () => {
    const bound = BOUND_BY_KEY.get('phoneCountryCode')!;
    // The column is nullable with no default, and the WhatsApp outbox falls
    // back to the branch country, so requiring it would be a lie.
    expect(bound.systemRequired).toBe(false);
    // Nothing does money or regulatory arithmetic on it, so an admin may
    // relabel, reorder or remove it.
    expect(bound.locked).toBe(false);
  });

  it('splits onto the employee table, not into the JSONB bag', () => {
    const out = splitByStorage({ phoneCountryCode: 'AE' }, [
      { fieldKey: 'phoneCountryCode' } as any,
    ]);
    expect(out.employee).toEqual({ phoneCountryCode: 'AE' });
    expect(out.custom).toEqual({});
  });
});
