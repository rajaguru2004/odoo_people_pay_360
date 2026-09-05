/**
 * The presets are shipped data, so their mistakes are shipped mistakes: a field
 * pointing at a section that does not exist violates a NOT NULL foreign key at
 * seed time, on a customer's boot, with no user action to blame it on. These
 * checks run the definitions through the same rules the seeder relies on.
 */
import {
  BASELINE_FIELDS,
  BASELINE_SECTIONS,
  BASELINE_FIELD_KEYS,
  PRESET_COUNTRIES,
  buildTemplateDefinition,
  listPresets,
  unplacedBoundKeys,
  seedProfileTemplate,
  ensureCompanyTemplate,
} from './profile-template-defaults';
import {
  BOUND_BY_KEY,
  EMPLOYEE_BOUND_COLUMNS,
} from './employee-bound-columns';
import { FIELD_TYPES, VALIDATION_TYPES } from '../common/dynamic-fields/field-def';

describe('profile template presets', () => {
  const allCountries = [...PRESET_COUNTRIES, 'ZZ', '', null];

  it.each(allCountries)('builds a coherent definition for %s', (country) => {
    const def = buildTemplateDefinition(country as string | null);

    const sectionKeys = new Set(def.sections.map((s) => s.sectionKey));
    // Would be a NOT NULL FK violation at seed time.
    const orphans = def.fields
      .filter((f) => !sectionKeys.has(f.sectionKey))
      .map((f) => f.fieldKey);
    expect(orphans).toEqual([]);

    // Duplicate keys collide on @@unique([templateId, fieldKey]).
    const keys = def.fields.map((f) => f.fieldKey);
    expect(new Set(keys).size).toBe(keys.length);

    const sKeys = def.sections.map((s) => s.sectionKey);
    expect(new Set(sKeys).size).toBe(sKeys.length);
  });

  it('falls back to the bare baseline for a country with no preset', () => {
    // A deployment in a country we have not modelled still needs a usable form.
    const def = buildTemplateDefinition('ZZ');
    expect(def.fields).toHaveLength(BASELINE_FIELDS.length);
    expect(def.country).toBe('ZZ');
  });

  it('normalizes the country code', () => {
    expect(buildTemplateDefinition(' om ').fields.length).toBe(
      buildTemplateDefinition('OM').fields.length,
    );
  });

  it('places every bound column somewhere in the baseline', () => {
    // Otherwise a column exists that no form can ever reach.
    expect(unplacedBoundKeys()).toEqual([]);
    expect(BASELINE_FIELD_KEYS).toHaveLength(EMPLOYEE_BOUND_COLUMNS.length);
  });

  it('only adds JSONB fields in country deltas', () => {
    // Onboarding a country must never need a schema change, so no delta may
    // claim a real column.
    const baseline = new Set(BASELINE_FIELD_KEYS);
    for (const country of PRESET_COUNTRIES) {
      const extra = buildTemplateDefinition(country).fields.filter(
        (f) => !baseline.has(f.fieldKey),
      );
      for (const f of extra) {
        expect(BOUND_BY_KEY.has(f.fieldKey)).toBe(false);
        // A JSONB field has no column to infer a type from.
        expect(f.fieldType).toBeDefined();
      }
    }
  });

  it('uses only known field and validation types', () => {
    for (const country of PRESET_COUNTRIES) {
      for (const f of buildTemplateDefinition(country).fields) {
        if (f.fieldType) expect(FIELD_TYPES).toContain(f.fieldType);
        if (f.validationType)
          expect(VALIDATION_TYPES).toContain(f.validationType as any);
      }
    }
  });

  it('ships compilable regexes', () => {
    // A broken pattern is never enforced at runtime, so it would silently
    // accept anything rather than fail loudly.
    for (const country of PRESET_COUNTRIES) {
      for (const f of buildTemplateDefinition(country).fields) {
        if (!f.regex) continue;
        expect(() => new RegExp(f.regex as string)).not.toThrow();
        expect(f.validationType).toBe('REGEX');
      }
    }
  });

  it('never asks for a field the DB demands to be optional', () => {
    for (const f of BASELINE_FIELDS) {
      const bound = BOUND_BY_KEY.get(f.fieldKey);
      if (bound?.systemRequired) expect(f.required).toBe(true);
    }
  });

  it('keeps salary out of self-service view', () => {
    const salary = BASELINE_FIELDS.filter((f) =>
      ['baseSalary', 'salaryType'].includes(f.fieldKey),
    );
    expect(salary).toHaveLength(2);
    for (const f of salary) {
      expect(f.selfVisible).toBe(false);
      expect(f.visibleToRoles).toEqual(['ADMIN', 'HR_MANAGER']);
    }
  });

  it('reproduces the previous hardcoded self-service allowlist', () => {
    // The controller used to hardcode exactly five. Anything wider here would
    // silently grant employees write access they never had, so every addition
    // has to be argued for in this list rather than just appearing.
    //
    // phoneCountryCode is the one deliberate widening. It did not exist when
    // the controller list was written; it only qualifies `phone`, which was
    // always self-editable, and an employee able to change their number but not
    // its country can leave a number the WhatsApp outbox cannot dial. It
    // carries no payroll, regulatory or access-control meaning.
    const selfEditableBound = BASELINE_FIELDS.filter(
      (f) => f.selfEditable && BOUND_BY_KEY.get(f.fieldKey)?.table === 'employee',
    ).map((f) => f.fieldKey);
    expect(selfEditableBound.sort()).toEqual(
      [
        'address',
        'dateFormat',
        'dateOfBirth',
        'phone',
        'phoneCountryCode',
        'timezone',
      ].sort(),
    );
  });

  it('lists presets for the adopt screen', () => {
    const presets = listPresets();
    expect(presets.map((p) => p.country)).toEqual(PRESET_COUNTRIES);
    const om = presets.find((p) => p.country === 'OM')!;
    expect(om.extraFieldCount).toBeGreaterThan(0);
    expect(om.fieldCount).toBe(BASELINE_FIELDS.length + om.extraFieldCount);
  });

  it('assigns every section to a wizard step', () => {
    for (const s of BASELINE_SECTIONS) expect(s.wizardStep).toBeGreaterThan(0);
  });
});

describe('phoneCountryCode in the shipped baseline', () => {
  const field = () =>
    BASELINE_FIELDS.find((f) => f.fieldKey === 'phoneCountryCode');

  it('ships in the personal section', () => {
    // Without a baseline entry the field is bindable but never rendered, which
    // is exactly the state that lost the picker in the first place.
    expect(field()).toBeDefined();
    expect(field()!.sectionKey).toBe('personal');
  });

  it('sits between phone and date of birth without renumbering either', () => {
    const orderOf = (key: string) =>
      BASELINE_FIELDS.find((f) => f.fieldKey === key)!.displayOrder;
    // The boot seeder pushes shipped revisions onto uncustomised rows, so
    // renumbering neighbours to make room would rewrite live installs purely
    // for cosmetics. 35 slots in without touching 30 or 40.
    expect(orderOf('phone')).toBe(30);
    expect(orderOf('phoneCountryCode')).toBe(35);
    expect(orderOf('dateOfBirth')).toBe(40);
  });

  it('is self-editable, like the phone it qualifies', () => {
    // An employee who may correct their number but not its country can produce
    // a number the WhatsApp outbox cannot dial.
    expect(field()!.selfEditable).toBe(true);
  });

  it('does not collide with another field in its section', () => {
    const orders = BASELINE_FIELDS.filter(
      (f) => f.sectionKey === 'personal',
    ).map((f) => f.displayOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

// ── The provenance contract ────────────────────────────────────────────────
// These are the rules that make "our update must not overwrite their
// customization" true, exercised against a fake db that records the queries.

describe('seedProfileTemplate — provenance', () => {
  function fakeDb() {
    const sectionUpserts: any[] = [];
    const fieldUpserts: any[] = [];
    const fieldUpdateManys: any[] = [];
    const db = {
      profileTemplate: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(async ({ data }: any) => ({ id: 'tpl-1', ...data })),
      },
      profileTemplateSection: {
        upsert: jest.fn().mockImplementation(async (a: any) => {
          sectionUpserts.push(a);
          return {};
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest
          .fn()
          .mockImplementation(async () =>
            BASELINE_SECTIONS.map((s) => ({
              id: `sec-${s.sectionKey}`,
              sectionKey: s.sectionKey,
            })),
          ),
      },
      profileTemplateField: {
        upsert: jest.fn().mockImplementation(async (a: any) => {
          fieldUpserts.push(a);
          return {};
        }),
        updateMany: jest.fn().mockImplementation(async (a: any) => {
          fieldUpdateManys.push(a);
          return { count: 0 };
        }),
      },
    };
    return { db, sectionUpserts, fieldUpserts, fieldUpdateManys };
  }

  it('never writes anything in an upsert update block', async () => {
    // THE rule. A non-empty `update` here would undo every admin rename on the
    // next container restart.
    const { db, sectionUpserts, fieldUpserts } = fakeDb();
    await seedProfileTemplate(db as any, { id: 'tpl-1', country: 'OM' });

    expect(sectionUpserts.length).toBeGreaterThan(0);
    expect(fieldUpserts.length).toBeGreaterThan(0);
    for (const u of [...sectionUpserts, ...fieldUpserts]) {
      expect(u.update).toEqual({});
    }
  });

  it('only pushes a newer revision onto untouched SYSTEM rows', async () => {
    const { db, fieldUpdateManys } = fakeDb();
    await seedProfileTemplate(db as any, { id: 'tpl-1', country: 'IN' });

    const revisionUpdates = fieldUpdateManys.filter(
      (u) => u.where.systemRevision !== undefined,
    );
    expect(revisionUpdates.length).toBeGreaterThan(0);
    for (const u of revisionUpdates) {
      expect(u.where.isCustomized).toBe(false);
      expect(u.where.origin).toBe('SYSTEM');
      expect(u.where.systemRevision).toHaveProperty('lt');
    }
  });

  it('deprecates rather than deletes fields it no longer ships', async () => {
    const { db, fieldUpdateManys } = fakeDb();
    await seedProfileTemplate(db as any, { id: 'tpl-1', country: 'OM' });

    const deprecation = fieldUpdateManys.find(
      (u) => u.data?.systemDeprecated === true,
    );
    expect(deprecation).toBeDefined();
    expect(deprecation.where.origin).toBe('SYSTEM'); // never touches CUSTOM fields
    expect(deprecation.where.fieldKey).toHaveProperty('notIn');
    expect(deprecation.data).not.toHaveProperty('isActive');
  });

  it('never issues a delete', async () => {
    const { db } = fakeDb();
    await seedProfileTemplate(db as any, { id: 'tpl-1', country: 'AE' });
    for (const model of [
      db.profileTemplateField,
      db.profileTemplateSection,
    ] as any[]) {
      expect(model.delete).toBeUndefined();
      expect(model.deleteMany).toBeUndefined();
    }
  });

  it('leaves admin-created fields entirely alone', async () => {
    const { db, fieldUpserts, fieldUpdateManys } = fakeDb();
    await seedProfileTemplate(db as any, { id: 'tpl-1', country: 'OM' });

    // Nothing the seeder writes may target origin CUSTOM.
    for (const u of fieldUpdateManys) {
      expect(u.where.origin).toBe('SYSTEM');
    }
    for (const u of fieldUpserts) {
      expect(u.create.origin).toBe('SYSTEM');
    }
  });

  it('applies the registry requiredness floor over the preset', async () => {
    const { db, fieldUpserts } = fakeDb();
    await seedProfileTemplate(db as any, { id: 'tpl-1', country: 'OM' });

    const salary = fieldUpserts.find(
      (u) => u.create.fieldKey === 'baseSalary',
    )!;
    expect(salary.create.required).toBe(true);
    expect(salary.create.storage).toBe('COLUMN');

    const custom = fieldUpserts.find(
      (u) => u.create.fieldKey === 'civilIdNumber',
    )!;
    expect(custom.create.storage).toBe('JSONB');
    expect(custom.create.boundColumn).toBeNull();
  });
});

describe('ensureCompanyTemplate', () => {
  it('creates the company template when none exists', async () => {
    const create = jest
      .fn()
      .mockResolvedValue({ id: 'tpl-new', country: 'OM' });
    const db: any = {
      profileTemplate: { findFirst: jest.fn().mockResolvedValue(null), create },
      profileTemplateSection: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest
          .fn()
          .mockResolvedValue(
            BASELINE_SECTIONS.map((s) => ({
              id: `sec-${s.sectionKey}`,
              sectionKey: s.sectionKey,
            })),
          ),
      },
      profileTemplateField: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    await ensureCompanyTemplate(db, 'OM');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      scope: 'COMPANY',
      branchId: null,
      country: 'OM',
    });
  });

  it('keeps the country an existing template was adopted with', async () => {
    // Changing payroll_country must not silently reshape a customized form.
    const create = jest.fn();
    const db: any = {
      profileTemplate: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tpl-1', country: 'OM' }),
        create,
      },
      profileTemplateSection: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest
          .fn()
          .mockResolvedValue(
            BASELINE_SECTIONS.map((s) => ({
              id: `sec-${s.sectionKey}`,
              sectionKey: s.sectionKey,
            })),
          ),
      },
      profileTemplateField: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const result = await ensureCompanyTemplate(db, 'IN');
    expect(create).not.toHaveBeenCalled();
    // Seeded against OM (its adopted country), not the IN we passed in.
    expect(result.fieldsSeeded).toBe(
      buildTemplateDefinition('OM').fields.length,
    );
  });
});
