/**
 * Schema construction and payload shaping for the template-driven employee form.
 *
 * `toEmployeePayloads` is the highest-consequence function on the frontend and
 * has no visible failure mode. The employee endpoints run under
 * `forbidNonWhitelisted`, so ONE ungoverned key in the body makes the whole save
 * 400 — and this form once shipped sending its entire react-hook-form model,
 * `id`, `createdAt`, `_count` and all, which meant every edit failed. It also
 * has to split keys across two endpoints, because the profile columns live
 * behind `PATCH /employees/:id/profile`.
 *
 * None of that is observable by reading the form. Hence these.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTemplateSchema,
  schemaForField,
  toEmployeePayloads,
  toEmployeePayload,
  toFormDefaults,
  fieldNamesForStep,
  wizardSteps,
} from './buildTemplateSchema';
import type { TemplateField, TemplateSection } from '@/types/profile-template';

const field = (over: Partial<TemplateField>): TemplateField =>
  ({
    fieldKey: 'x',
    label: 'X',
    fieldType: 'TEXT',
    storage: 'JSONB',
    validationType: 'NONE',
    required: false,
    boundColumn: null,
    regex: null,
    options: null,
    minValue: null,
    maxValue: null,
    minLength: null,
    maxLength: null,
    // The resolver only ever returns active fields, but fieldNamesForStep
    // filters on it defensively, so the fixture has to carry it.
    isActive: true,
    ...over,
  }) as TemplateField;

const bound = (key: string, table: 'employee' | 'employeeProfile') =>
  field({ fieldKey: key, storage: 'COLUMN', boundColumn: `${table}.${key}` });

describe('toEmployeePayloads — only governed keys reach the server', () => {
  const fields = [
    bound('fullName', 'employee'),
    bound('nationality', 'employeeProfile'),
    field({ fieldKey: 'grade' }),
  ];

  it('drops keys the template does not govern', () => {
    // The exact bug that 400'd every save: RHF hands back the whole model,
    // including server-owned properties the DTO has never heard of.
    const { employee, profile } = toEmployeePayloads(
      {
        fullName: 'Ada',
        id: 'emp-1',
        createdAt: '2020-01-01',
        _count: { contracts: 2 },
        department: { id: 'd1', name: 'Ops' },
      },
      fields,
    );
    expect(employee).toEqual({ fullName: 'Ada' });
    expect(profile).toEqual({});
    for (const forbidden of ['id', 'createdAt', '_count', 'department']) {
      expect(employee).not.toHaveProperty(forbidden);
    }
  });

  it('routes profile columns to the profile body, not the employee body', () => {
    // They are different endpoints. Sending nationality to /employees is a 400.
    const { employee, profile } = toEmployeePayloads(
      { fullName: 'Ada', nationality: 'Omani' },
      fields,
    );
    expect(employee).toEqual({ fullName: 'Ada' });
    expect(profile).toEqual({ nationality: 'Omani' });
  });

  it('nests custom values under customFields on the employee body', () => {
    const { employee } = toEmployeePayloads(
      { customFields: { grade: 'G4' } },
      fields,
    );
    expect(employee).toEqual({ customFields: { grade: 'G4' } });
  });

  it('omits customFields entirely when nothing was entered', () => {
    // An empty bag is not the same as an absent one: the server treats an
    // absent key as "leave alone" and rejects the bag outright when the feature
    // is off, so sending {} would 400 a save that changed nothing.
    const { employee } = toEmployeePayloads({ fullName: 'Ada' }, fields);
    expect(employee).not.toHaveProperty('customFields');
  });

  it('drops a custom key the template no longer declares', () => {
    // A form left open across an admin's field deletion still holds the old key
    // in its model. The server rejects unknown keys, so sending it would fail
    // the save for a value the user cannot even see any more.
    const { employee } = toEmployeePayloads(
      { customFields: { grade: 'G4', removedField: 'stale' } },
      fields,
    );
    expect(employee.customFields).toEqual({ grade: 'G4' });
  });

  it('drops empty custom values rather than sending them', () => {
    const { employee } = toEmployeePayloads(
      { customFields: { grade: '' } },
      fields,
    );
    expect(employee).not.toHaveProperty('customFields');
  });

  it('keeps a false and a zero, which are answers', () => {
    const withScalars = [
      ...fields,
      field({ fieldKey: 'remote', fieldType: 'BOOLEAN' }),
      field({ fieldKey: 'children', fieldType: 'NUMBER' }),
    ];
    const { employee } = toEmployeePayloads(
      { customFields: { remote: false, children: 0 } },
      withScalars,
    );
    // Falsy-but-present must survive: `if (!value) continue` would silently
    // discard "no" and "none".
    expect(employee.customFields).toEqual({ remote: false, children: 0 });
  });

  it('merges both bodies for the flat profile endpoint', () => {
    const flat = toEmployeePayload(
      { fullName: 'Ada', nationality: 'Omani' },
      fields,
    );
    expect(flat).toEqual({ fullName: 'Ada', nationality: 'Omani' });
  });
});

describe('empty optional columns never reach the server as ""', () => {
  /**
   * The create failure this locks down. A blank text input yields `''`, and
   * class-validator's `@IsOptional()` skips undefined and null but NOT `''`.
   * So five untouched optional fields failed their own validators at once:
   *
   *   status must be one of the following values: ACTIVE, INACTIVE, ...
   *   endDate must be a valid ISO 8601 date string
   *   supervisorId must be a UUID
   *   dateFormat must be one of the following values: DD/MM/YYYY, ...
   *   overtimePolicyId must be a UUID
   *
   * None of them filled in by anyone.
   */
  const optional = (key: string) => bound(key, 'employee');
  const fields = [
    optional('status'),
    optional('supervisorId'),
    optional('endDate'),
    { ...bound('fullName', 'employee'), required: true } as TemplateField,
  ];

  it('omits an empty optional column on create', () => {
    const { employee } = toEmployeePayloads(
      { fullName: 'Ada', status: '', supervisorId: '', endDate: '' },
      fields,
      { emptyValues: 'omit' },
    );
    expect(employee).toEqual({ fullName: 'Ada' });
    for (const k of ['status', 'supervisorId', 'endDate']) {
      expect(k in employee).toBe(false);
    }
  });

  it('sends null on edit, because emptying a box means clear it', () => {
    // null is what the DTOs accept: supervisorId is documented "null clears
    // the assignment" and carries @ValidateIf((_o, v) => v !== null).
    const { employee } = toEmployeePayloads(
      { fullName: 'Ada', supervisorId: '' },
      fields,
      { emptyValues: 'null' },
    );
    expect(employee.supervisorId).toBeNull();
  });

  it('leaves a REQUIRED field empty rather than hiding it', () => {
    // Blanking a required field is a real error and the server's message says
    // so. Omitting it would turn a clear rejection into a silent no-op.
    const { employee } = toEmployeePayloads({ fullName: '' }, fields, {
      emptyValues: 'omit',
    });
    expect(employee.fullName).toBe('');
  });

  it('never converts a real value', () => {
    const { employee } = toEmployeePayloads(
      { status: 'ACTIVE', supervisorId: 'uuid-1' },
      fields,
      { emptyValues: 'omit' },
    );
    expect(employee).toEqual({ status: 'ACTIVE', supervisorId: 'uuid-1' });
  });

  it('applies to profile columns too', () => {
    const withProfile = [bound('nationality', 'employeeProfile')];
    expect(
      toEmployeePayloads({ nationality: '' }, withProfile, {
        emptyValues: 'omit',
      }).profile,
    ).toEqual({});
    expect(
      toEmployeePayloads({ nationality: '' }, withProfile, {
        emptyValues: 'null',
      }).profile,
    ).toEqual({ nationality: null });
  });

  it('defaults to omitting when no mode is given', () => {
    const { employee } = toEmployeePayloads({ status: '' }, fields);
    expect('status' in employee).toBe(false);
  });
});

describe('null is "not provided", for every field type', () => {
  /**
   * The bug this locks down: the API returns `null` for every unset column, the
   * form resets from that record, and zod's `.optional()` accepts `undefined`
   * but not `null`. So editing an existing employee who had a blank Address —
   * or Photo, or Attendance Device ID — failed with
   * "Invalid input: expected string, received null" and the save was blocked on
   * fields nobody had touched and nothing required.
   *
   * It shipped because every test built values by hand and no test ever fed a
   * record shaped the way the API actually returns one.
   */
  const optionalOf = (fieldType: string) =>
    schemaForField(field({ fieldType, required: false }));

  it.each([
    'TEXT',
    'TEXTAREA',
    'EMAIL',
    'PHONE',
    'DATE',
    'SELECT',
    'FILE',
    'BOOLEAN',
    'NUMBER',
    'DECIMAL',
    'CURRENCY',
    'MULTISELECT',
    'PHONE_COUNTRY',
    'LIBRARY_SELECT',
  ])('accepts null on an optional %s field', (fieldType) => {
    expect(optionalOf(fieldType).safeParse(null).success).toBe(true);
  });

  it('still rejects null when the field IS required', () => {
    // The coercion must not weaken requiredness — null and undefined are both
    // "not provided", and that is exactly what required forbids.
    const f = schemaForField(field({ fieldType: 'TEXT', required: true }));
    expect(f.safeParse(null).success).toBe(false);
    expect(f.safeParse(undefined).success).toBe(false);
    expect(f.safeParse('x').success).toBe(true);
  });

  it('accepts a whole employee record with nulls where the API sends them', () => {
    // The shape that actually broke: an existing employee with several unset
    // optional columns, straight off GET /employees/:id.
    const schema = buildTemplateSchema([
      bound('fullName', 'employee'),
      bound('address', 'employee'),
      bound('avatarUrl', 'employee'),
      bound('attendanceExternalId', 'employee'),
      field({ fieldKey: 'grade' }),
    ]);
    const out = schema.safeParse({
      fullName: 'Ada',
      address: null,
      avatarUrl: null,
      attendanceExternalId: null,
      customFields: null,
    });
    expect(out.success).toBe(true);
  });

  it('accepts a null customFields bag', () => {
    // custom_fields is nullable with no default, so every employee created
    // before the template has null there rather than {}.
    const schema = buildTemplateSchema([field({ fieldKey: 'grade' })]);
    expect(schema.safeParse({ customFields: null }).success).toBe(true);
  });

  it('accepts a null value inside the bag', () => {
    const schema = buildTemplateSchema([field({ fieldKey: 'grade' })]);
    expect(schema.safeParse({ customFields: { grade: null } }).success).toBe(true);
  });
});

describe('toFormDefaults', () => {
  /**
   * The other half of the null problem. Making the SCHEMA accept null stops the
   * validation error, but the null is still sitting in the form model, and
   * React will not take null as an input value — it warns and treats the field
   * as uncontrolled until the first keystroke.
   *
   * The forms used to handle this with a hand-kept list of `x || ''` lines,
   * which covers whatever someone remembered and misses every field the
   * template gains afterwards. This is driven by the template instead.
   */
  const fields = [
    bound('address', 'employee'),
    bound('avatarUrl', 'employee'),
    field({ fieldKey: 'remote', fieldType: 'BOOLEAN' }),
    field({ fieldKey: 'children', fieldType: 'NUMBER' }),
    field({ fieldKey: 'certs', fieldType: 'MULTISELECT' }),
    field({ fieldKey: 'grade' }),
  ];

  it('turns a null text column into an empty string', () => {
    const out = toFormDefaults({ address: null }, fields);
    expect(out.address).toBe('');
  });

  it('gives each type the empty value its control expects', () => {
    // '' is not universally right: a checkbox would read it as truthy-ish and a
    // number input would parse it as NaN.
    const out = toFormDefaults(
      { customFields: { remote: null, children: null, certs: null } },
      fields,
    );
    const bag = out.customFields as Record<string, unknown>;
    expect(bag.remote).toBeUndefined();
    expect(bag.children).toBeUndefined();
    expect(bag.certs).toEqual([]);
  });

  it('replaces a null bag with an object', () => {
    const out = toFormDefaults({ customFields: null }, fields);
    expect(out.customFields).toEqual({});
  });

  it('leaves real values alone', () => {
    const out = toFormDefaults(
      { address: 'Muscat', customFields: { grade: 'G4' } },
      fields,
    );
    expect(out.address).toBe('Muscat');
    expect((out.customFields as any).grade).toBe('G4');
  });

  it('does not invent keys the record never had', () => {
    // Only nulls are rewritten. Adding absent keys would make every field look
    // touched and defeat the partial-PATCH semantics.
    const out = toFormDefaults({ address: null }, fields);
    expect('avatarUrl' in out).toBe(false);
  });

  it('passes through keys the template does not govern', () => {
    // The forms carry a contract block and salary rows the template knows
    // nothing about; stripping them here would empty half the create wizard.
    const out = toFormDefaults(
      { initialContract: { enabled: false }, id: 'emp-1' },
      fields,
    );
    expect(out.initialContract).toEqual({ enabled: false });
    expect(out.id).toBe('emp-1');
  });

  it('leaves false and 0 untouched', () => {
    const out = toFormDefaults(
      { customFields: { remote: false, children: 0 } },
      fields,
    );
    const bag = out.customFields as Record<string, unknown>;
    expect(bag.remote).toBe(false);
    expect(bag.children).toBe(0);
  });
});

describe('schemaForField', () => {
  const parse = (f: TemplateField, value: unknown) =>
    schemaForField(f).safeParse(value);

  it('accepts an empty optional field', () => {
    expect(parse(field({}), '').success).toBe(true);
  });

  it('rejects an empty required field', () => {
    expect(parse(field({ required: true }), '').success).toBe(false);
  });

  it('enforces a configured regex', () => {
    const f = field({ validationType: 'REGEX', regex: '^G\\d$' });
    expect(parse(f, 'G4').success).toBe(true);
    expect(parse(f, 'nope').success).toBe(false);
  });

  it('does not let an uncompilable regex block the user', () => {
    // A misconfigured field must degrade to "no check", not to a form nobody
    // can submit.
    const f = field({ validationType: 'REGEX', regex: '([' });
    expect(parse(f, 'anything').success).toBe(true);
  });

  it('enforces min and max length', () => {
    const f = field({ validationType: 'LENGTH', minLength: 2, maxLength: 4 });
    expect(parse(f, 'a').success).toBe(false);
    expect(parse(f, 'abc').success).toBe(true);
    expect(parse(f, 'abcde').success).toBe(false);
  });

  it('enforces a numeric range', () => {
    const f = field({
      fieldType: 'NUMBER',
      validationType: 'RANGE',
      minValue: 1,
      maxValue: 10,
    });
    expect(parse(f, 0).success).toBe(false);
    expect(parse(f, 5).success).toBe(true);
    expect(parse(f, 11).success).toBe(false);
  });

  it('checks email shape', () => {
    const f = field({ validationType: 'EMAIL' });
    expect(parse(f, 'a@b.co').success).toBe(true);
    expect(parse(f, 'not-an-email').success).toBe(false);
  });

  it('accepts only a country the picker offers for PHONE_COUNTRY', () => {
    const f = field({ fieldType: 'PHONE_COUNTRY' });
    expect(parse(f, 'OM').success).toBe(true);
    // '' clears the picker and inherits the branch default — still valid.
    expect(parse(f, '').success).toBe(true);
    expect(parse(f, 'ZZ').success).toBe(false);
  });
});

describe('buildTemplateSchema', () => {
  it('nests JSONB fields under customFields and leaves columns top-level', () => {
    const schema = buildTemplateSchema([
      bound('fullName', 'employee'),
      field({ fieldKey: 'grade' }),
    ]);
    const out = schema.safeParse({
      fullName: 'Ada',
      customFields: { grade: 'G4' },
    });
    expect(out.success).toBe(true);
  });

  it('passes unknown top-level keys through', () => {
    // The form also carries blocks the template knows nothing about — the
    // initial contract, the salary breakup. Stripping them would silently drop
    // half the onboarding wizard.
    const schema = buildTemplateSchema([bound('fullName', 'employee')]);
    const out = schema.safeParse({
      fullName: 'Ada',
      initialContract: { startDate: '2026-01-01' },
    });
    expect(out.success).toBe(true);
  });
});

describe('derived fields are not required of the user', () => {
  /**
   * The dead end this prevents: `idCard` is required and rendered read-only on
   * wizard step 1, and the only thing that fills it is `departmentId` on step 2.
   * Step 1 could therefore never be satisfied — the create wizard demanded a
   * value the user could not type and whose source they had not reached. The
   * form was unusable, not merely awkward.
   *
   * The rule, stated once: a field the user cannot type into must not be
   * required of the user. The server keeps its own requirement, and the field
   * that actually drives the value stays required.
   */
  const fields = [
    bound('idCard', 'employee'),
    bound('employeeCode', 'employee'),
    bound('departmentId', 'employee'),
  ].map((f) => ({ ...f, required: true }));

  it('lets an empty derived field pass', () => {
    const schema = buildTemplateSchema(fields, {
      derivedFields: ['idCard', 'employeeCode'],
    });
    const out = schema.safeParse({
      idCard: '',
      employeeCode: '',
      departmentId: 'dept-1',
    });
    expect(out.success).toBe(true);
  });

  it('still blocks on the field that DRIVES the derived value', () => {
    // Nothing is actually skipped: no department, no submit.
    const schema = buildTemplateSchema(fields, {
      derivedFields: ['idCard', 'employeeCode'],
    });
    expect(
      schema.safeParse({ idCard: '', employeeCode: '', departmentId: '' })
        .success,
    ).toBe(false);
  });

  it('blocks on the derived field when it is NOT declared derived', () => {
    // Proves the option is what changes the outcome, so the test cannot pass
    // for an unrelated reason.
    const schema = buildTemplateSchema(fields);
    expect(
      schema.safeParse({
        idCard: '',
        employeeCode: '',
        departmentId: 'dept-1',
      }).success,
    ).toBe(false);
  });

  it('keeps format rules on a derived field', () => {
    // Requiredness is dropped; validation is not. Whatever the system writes
    // still has to be well-formed.
    const schema = buildTemplateSchema(
      [
        {
          ...bound('idCard', 'employee'),
          required: true,
          validationType: 'LENGTH',
          maxLength: 4,
        } as TemplateField,
      ],
      { derivedFields: ['idCard'] },
    );
    expect(schema.safeParse({ idCard: '' }).success).toBe(true);
    expect(schema.safeParse({ idCard: 'toolong' }).success).toBe(false);
  });

  it('leaves every other field untouched', () => {
    const schema = buildTemplateSchema(
      [{ ...bound('fullName', 'employee'), required: true } as TemplateField],
      { derivedFields: ['idCard'] },
    );
    expect(schema.safeParse({ fullName: '' }).success).toBe(false);
    expect(schema.safeParse({ fullName: 'Ada' }).success).toBe(true);
  });
});

describe('wizard step helpers', () => {
  const sections = [
    { sectionKey: 'a', wizardStep: 1, fields: [field({ fieldKey: 'one' })] },
    {
      sectionKey: 'b',
      wizardStep: 2,
      fields: [bound('fullName', 'employee')],
    },
  ] as unknown as TemplateSection[];

  it('lists the steps present, in order, without duplicates', () => {
    expect(wizardSteps(sections)).toEqual([1, 2]);
  });

  it('returns the RHF names for one step', () => {
    // These feed trigger() for per-step validation — a wrong name means the
    // step validates nothing and the wizard advances over an invalid field.
    expect(fieldNamesForStep(sections, 2)).toEqual(['fullName']);
    expect(fieldNamesForStep(sections, 1)).toEqual(['customFields.one']);
  });
});
