import {
  assertFieldsWritable,
  canEditField,
  canViewField,
  projectEmployeeForRole,
  visibleFields,
  FieldPermissionError,
} from './field-permissions.util';
import { ResolvedField } from './profile-template.types';

const f = (over: Partial<ResolvedField> = {}): ResolvedField =>
  ({
    id: 'x',
    sectionKey: 's',
    fieldKey: 'k',
    label: 'K',
    fieldType: 'TEXT',
    storage: 'COLUMN',
    boundColumn: 'employee.k',
    validationType: 'NONE',
    required: false,
    displayOrder: 1,
    isSensitive: false,
    defaultValue: null,
    colSpan: 1,
    visibleToRoles: [],
    editableByRoles: [],
    selfVisible: true,
    selfEditable: false,
    includeInCompletion: false,
    isActive: true,
    systemDeprecated: false,
    origin: 'SYSTEM',
    locked: false,
    systemRequired: false,
    ...over,
  }) as ResolvedField;

const hr = { role: 'HR_MANAGER', isSelf: false };
const mgr = { role: 'MANAGER', isSelf: false };
const admin = { role: 'ADMIN', isSelf: false };
const self = { role: 'EMPLOYEE', isSelf: true };

describe('canViewField', () => {
  it('treats an empty roles array as every role, not no role', () => {
    // Inverting this would hide every field on a freshly seeded template.
    expect(canViewField(f(), mgr)).toBe(true);
  });

  it('honours an explicit role list', () => {
    const salary = f({ visibleToRoles: ['ADMIN', 'HR_MANAGER'] });
    expect(canViewField(salary, hr)).toBe(true);
    expect(canViewField(salary, mgr)).toBe(false);
  });

  it('does not exempt ADMIN', () => {
    // A field hidden from ADMIN really is hidden. Special-casing would make the
    // builder's preview lie about what it configured.
    expect(canViewField(f({ visibleToRoles: ['HR_MANAGER'] }), admin)).toBe(false);
  });

  it('lets an employee see a selfVisible field without naming EMPLOYEE', () => {
    expect(canViewField(f({ visibleToRoles: ['ADMIN'] }), self)).toBe(true);
  });

  it('hides a field flagged not selfVisible even from a listed role', () => {
    const salary = f({ visibleToRoles: ['ADMIN'], selfVisible: false });
    expect(canViewField(salary, { role: 'ADMIN', isSelf: true })).toBe(false);
  });
});

describe('canEditField', () => {
  it('requires selfEditable for a self-service caller', () => {
    expect(canEditField(f({ selfEditable: false }), self)).toBe(false);
    expect(canEditField(f({ selfEditable: true }), self)).toBe(true);
  });

  it('never allows editing what cannot be viewed', () => {
    const hidden = f({ visibleToRoles: ['ADMIN'], editableByRoles: [] });
    expect(canEditField(hidden, mgr)).toBe(false);
  });

  it('honours editableByRoles for a privileged caller', () => {
    const salary = f({ editableByRoles: ['ADMIN'] });
    expect(canEditField(salary, admin)).toBe(true);
    expect(canEditField(salary, hr)).toBe(false);
  });
});

describe('visibleFields', () => {
  it('returns only what the actor may see', () => {
    const fields = [
      f({ fieldKey: 'a' }),
      f({ fieldKey: 'b', visibleToRoles: ['ADMIN'] }),
    ];
    expect(visibleFields(fields, mgr).map((x) => x.fieldKey)).toEqual(['a']);
  });
});

describe('projectEmployeeForRole', () => {
  const fields = [
    f({ fieldKey: 'fullName' }),
    f({ fieldKey: 'baseSalary', visibleToRoles: ['ADMIN', 'HR_MANAGER'] }),
    f({ fieldKey: 'nationality', boundColumn: 'employeeProfile.nationality' }),
    f({ fieldKey: 'grade', storage: 'JSONB', boundColumn: null }),
    f({
      fieldKey: 'medicalNote',
      storage: 'JSONB',
      boundColumn: null,
      visibleToRoles: ['ADMIN'],
    }),
  ];

  const row = () => ({
    id: 'e1',
    fullName: 'Ada',
    baseSalary: 5000,
    department: { name: 'Ops' },
    profile: { nationality: 'Omani' },
    customFields: { grade: 'G4', medicalNote: 'private' },
  });

  it('strips a bound column the role may not see', () => {
    const out = projectEmployeeForRole(row(), fields, mgr);
    expect(out).not.toHaveProperty('baseSalary');
    expect(out.fullName).toBe('Ada');
  });

  it('strips a JSONB key the role may not see', () => {
    const out = projectEmployeeForRole(row(), fields, mgr);
    expect(out.customFields).toEqual({ grade: 'G4' });
  });

  it('leaves relations and ids alone', () => {
    // It must be safe to apply to a full findOne payload without knowing its
    // shape, or every include would need a matching template entry.
    const out = projectEmployeeForRole(row(), fields, mgr);
    expect(out.id).toBe('e1');
    expect(out.department).toEqual({ name: 'Ops' });
  });

  it('does not mutate the row it was given', () => {
    const original = row();
    projectEmployeeForRole(original, fields, mgr);
    expect(original.baseSalary).toBe(5000);
    expect(original.customFields).toEqual({ grade: 'G4', medicalNote: 'private' });
    expect(original.profile).toEqual({ nationality: 'Omani' });
  });

  it('strips a hidden field nested under profile too', () => {
    const hidden = [f({ fieldKey: 'nationality', visibleToRoles: ['ADMIN'] })];
    const out = projectEmployeeForRole(row(), hidden, mgr);
    expect(out.profile).toEqual({});
  });

  it('passes everything through for a fully privileged role', () => {
    const out = projectEmployeeForRole(row(), fields, admin);
    expect(out.baseSalary).toBe(5000);
    expect(out.customFields).toEqual({ grade: 'G4', medicalNote: 'private' });
  });

  it('survives a null row', () => {
    expect(projectEmployeeForRole(null as any, fields, admin)).toBeNull();
  });
});

describe('assertFieldsWritable', () => {
  const fields = [
    f({ fieldKey: 'phone', selfEditable: true }),
    f({ fieldKey: 'baseSalary', editableByRoles: ['ADMIN'] }),
    f({ fieldKey: 'status', editableByRoles: ['ADMIN'] }),
  ];

  it('allows a permitted write', () => {
    expect(() => assertFieldsWritable({ phone: '1' }, fields, self)).not.toThrow();
  });

  it('reports EVERY offending key, not just the first', () => {
    // Otherwise a user fixing a form discovers them one round-trip at a time.
    try {
      assertFieldsWritable({ baseSalary: 1, status: 'X' }, fields, hr);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FieldPermissionError);
      expect((e as FieldPermissionError).fields.sort()).toEqual([
        'baseSalary',
        'status',
      ]);
    }
  });

  it('ignores keys the template does not govern', () => {
    // Contract and salary-component payloads travel alongside and have their
    // own endpoints; rejecting them here would break those callers.
    expect(() =>
      assertFieldsWritable({ contractType: 'PERMANENT' }, fields, hr),
    ).not.toThrow();
  });
});
