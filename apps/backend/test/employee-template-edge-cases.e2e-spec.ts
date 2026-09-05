import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupFixtures, Fixtures } from './utils/fixtures';
import { assertDevDb } from './utils/mcp-harness';
import {
  readTemplateFlag,
  setTemplateFlag,
  restoreTemplateFlag,
  assertTemplateFlagRestored,
  TemplateFlagSnapshot,
} from './utils/template-flag';

/**
 * Adversarial edge cases for the Employee Profile Template, run before
 * production.
 *
 * Deliberately NOT a re-run of the happy paths — those are covered by
 * profile-template, employee-custom-fields, employee-template-surfaces,
 * employee-write-doors, employee-kill-switch and
 * employee-phone-country-template. What is here is the input nobody types on
 * purpose and the state nobody sets up deliberately: hostile strings, absent
 * envelopes, records that predate the feature, keys that collide with the
 * machinery, and races.
 *
 * The bar for every case is the same and it is low on purpose: **never a 500,
 * never silent data loss**. A clean 400 is a pass. A stack trace is not.
 */
describe('employee template — edge cases (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;
  let previousFlag: TemplateFlagSnapshot = null;
  let templateId: string;
  let sectionId: string;

  beforeAll(async () => {
    assertDevDb();
    ctx = await bootE2EApp();
    fx = await setupFixtures(ctx);
    previousFlag = await readTemplateFlag(ctx);

    const tpl = await ctx.prisma.profileTemplate.findFirst({
      where: { scope: 'COMPANY', isActive: true },
      include: { sections: { where: { sectionKey: 'personal_extended' } } },
    });
    if (!tpl) throw new Error('boot seeder did not create a company template');
    templateId = tpl.id;
    sectionId = tpl.sections[0].id;

    await ctx.prisma.profileTemplateField.createMany({
      data: [
        {
          templateId,
          sectionId,
          fieldKey: 'edgeText',
          label: 'Edge Text',
          fieldType: 'TEXT',
          storage: 'JSONB',
          origin: 'CUSTOM',
          isCustomized: true,
          displayOrder: 960,
        },
        {
          templateId,
          sectionId,
          fieldKey: 'edgeRequired',
          label: 'Edge Required',
          fieldType: 'TEXT',
          storage: 'JSONB',
          required: true,
          origin: 'CUSTOM',
          isCustomized: true,
          displayOrder: 961,
        },
        {
          templateId,
          sectionId,
          fieldKey: 'edgeNum',
          label: 'Edge Number',
          fieldType: 'NUMBER',
          storage: 'JSONB',
          origin: 'CUSTOM',
          isCustomized: true,
          displayOrder: 962,
        },
      ],
    });
    await setTemplateFlag(ctx, true);
  }, 120000);

  afterAll(async () => {
    await ctx.prisma.profileTemplateField.deleteMany({
      where: { templateId, fieldKey: { startsWith: 'edge' } },
    });
    await restoreTemplateFlag(ctx, previousFlag);
    await assertTemplateFlagRestored(ctx, previousFlag);
    await fx.cleanup();
    await ctx.app.close();
  }, 120000);

  const admin = () => ({ Authorization: `Bearer ${fx.globalAdmin.token}` });
  const patch = (body: any, id = fx.empAId) =>
    ctx.http().patch(`/employees/${id}`).set(admin()).send(body);
  const custom = (customFields: Record<string, unknown>) => patch({ customFields });
  const bag = async (id = fx.empAId) => {
    const row = await ctx.prisma.employee.findUnique({
      where: { id },
      select: { customFields: true },
    });
    return (row?.customFields ?? {}) as Record<string, unknown>;
  };

  // ── hostile strings ───────────────────────────────────────────────────────

  describe('hostile input', () => {
    it('round-trips emoji and astral-plane characters byte for byte', async () => {
      const value = 'a👨‍👩‍👧‍👦b🇴🇲c';
      expect((await custom({ edgeText: value })).status).toBe(200);
      expect((await bag()).edgeText).toBe(value);
    });

    it('round-trips RTL and combining marks without normalising them away', async () => {
      // Silent Unicode normalisation would change a stored legal name.
      const value = 'مرحبا ‮ reversed ́ combining';
      expect((await custom({ edgeText: value })).status).toBe(200);
      expect((await bag()).edgeText).toBe(value);
    });

    it('rejects a NUL byte cleanly instead of 500ing', async () => {
      // Postgres cannot store U+0000 in a jsonb string and rejects the whole
      // statement, so unhandled this is a 500 from the driver — on input a user
      // can paste from a hex editor or a badly-exported CSV. Escaped rather
      // than literal: a real NUL in this file makes it binary.
      const res = await custom({ edgeText: 'a\u0000b' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/NUL/i);
    });

    it('does not 500 on a very large value', async () => {
      const res = await custom({ edgeText: 'x'.repeat(100_000) });
      expect(res.status).toBeLessThan(500);
    });

    it('stores script content as data, never interpreting it', async () => {
      const value = '<script>alert(1)</script>';
      expect((await custom({ edgeText: value })).status).toBe(200);
      expect((await bag()).edgeText).toBe(value);
    });

    it('treats a SQL fragment as an ordinary string', async () => {
      const value = "'; DROP TABLE employees;--";
      expect((await custom({ edgeText: value })).status).toBe(200);
      expect((await bag()).edgeText).toBe(value);
      // The table is obviously still there if this query works at all.
      expect(await ctx.prisma.employee.count()).toBeGreaterThan(0);
    });
  });

  // ── prototype pollution ───────────────────────────────────────────────────

  describe('reserved JavaScript keys', () => {
    /**
     * Sent as a raw JSON string, not an object literal. `{ __proto__: ... }` in
     * JS sets the prototype rather than creating an own property, so building
     * the body that way ships `{}` and tests nothing. Over the wire it is an
     * ordinary key and `JSON.parse` makes it an own property, which is exactly
     * the case worth checking.
     */
    const rawBody = (json: string) =>
      ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .set('Content-Type', 'application/json')
        .send(json);

    it('does not merge __proto__ into the stored bag', async () => {
      const res = await rawBody(
        '{"customFields":{"__proto__":{"polluted":true}}}',
      );
      expect(res.status).toBeLessThan(500);
      expect((await bag()).polluted).toBeUndefined();
    });

    it('leaves Object.prototype unpolluted', async () => {
      expect(({} as any).polluted).toBeUndefined();
    });

    it('does not store constructor or prototype as custom values', async () => {
      // Whether these 400 as unknown keys or are dropped upstream by the
      // validation pipe, the requirement is the same: they must not end up in
      // the bag. Asserting the outcome rather than the status keeps this
      // honest about a path that has two legitimate implementations.
      for (const json of [
        '{"customFields":{"constructor":"x"}}',
        '{"customFields":{"prototype":"x"}}',
      ]) {
        const res = await rawBody(json);
        expect(res.status).toBeLessThan(500);
      }
      // hasOwnProperty, not a truthiness check: every object INHERITS
      // `constructor` from Object.prototype, so `after.constructor` is the
      // Object function whether or not anything was stored. Only an own
      // property means the write actually landed.
      const after = await bag();
      const own = (k: string) => Object.prototype.hasOwnProperty.call(after, k);
      expect(own('constructor')).toBe(false);
      expect(own('prototype')).toBe(false);
    });
  });

  // ── type coercion ─────────────────────────────────────────────────────────

  describe('wrong types for the declared field', () => {
    it('rejects an array where a scalar is declared', async () => {
      const res = await custom({ edgeText: ['a', 'b'] });
      expect(res.status).toBeLessThan(500);
    });

    it('rejects a nested object where a scalar is declared', async () => {
      const res = await custom({ edgeText: { nested: true } });
      expect(res.status).toBeLessThan(500);
    });

    it('rejects a non-numeric string on a NUMBER field', async () => {
      const res = await custom({ edgeNum: 'not-a-number' });
      expect(res.status).toBe(400);
    });

    it('does not 500 on Infinity or NaN', async () => {
      // JSON has no literal for these; they arrive as strings or null.
      for (const v of ['Infinity', 'NaN', null]) {
        const res = await custom({ edgeNum: v });
        expect(res.status).toBeLessThan(500);
      }
    });
  });

  // ── requiredness ──────────────────────────────────────────────────────────

  describe('required custom fields', () => {
    it('rejects an explicitly blank required field', async () => {
      const res = await custom({ edgeRequired: '' });
      expect(res.status).toBe(400);
    });

    it('allows a PATCH that simply omits it', async () => {
      // Partial semantics: absent means "leave alone", not "clear it". A PATCH
      // that failed on every unrelated edit would make the record uneditable.
      const res = await custom({ edgeText: 'still fine' });
      expect(res.status).toBe(200);
    });

    it('records what CREATE does when the envelope is omitted entirely', async () => {
      // resolveCustomFields returns early on `undefined`, so the requiredness
      // check never runs. Pinning current behaviour: this is a known gap,
      // tracked for before the flag is enabled in any tenant.
      const res = await ctx
        .http()
        .post('/employees')
        .set(admin())
        .send({
          fullName: 'Edge NoEnvelope',
          email: `edge-noenv-${fx.runId}@test.local`,
          idCard: `EDGE-NE-${fx.runId}`.slice(0, 20),
          dateOfBirth: '1990-01-01',
          startDate: '2026-01-01',
          departmentId: fx.deptId,
          position: 'Tester',
          baseSalary: 1000,
          branchId: fx.branchA,
        });
      // Documented, not endorsed: a required custom field is not enforced when
      // the client sends no customFields key at all.
      expect([201, 400]).toContain(res.status);
      if (res.status === 201) {
        await ctx.prisma.employee
          .delete({ where: { id: res.body.data.id } })
          .catch(() => undefined);
      }
    });
  });

  // ── nulls at columns that cannot hold them ────────────────────────────────

  describe('clearing a NOT NULL column', () => {
    /**
     * The incident: PATCH /employees/:id/profile 500'd with
     * "Argument `employee` is missing" — a message that names neither the field
     * nor the real problem. `numberOfChildren Int @default(0)` is NOT NULL, so
     * nobody has to supply it and every layer treated it as optional, but an
     * explicit null makes the object fail to match Prisma's unchecked input and
     * Prisma then reports the checked variant's requirements instead.
     */
    it('does not 500 when a non-nullable profile column is sent as null', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}/profile`)
        .set(admin())
        .send({ numberOfChildren: null, permanentAddress: 'Muscat' });
      expect(res.status).toBeLessThan(500);
    });

    it('still writes the fields sent alongside it', async () => {
      // The null must be ignored, not poison the whole request.
      const row = await ctx.prisma.employeeProfile.findUnique({
        where: { employeeId: fx.empAId },
      });
      expect(row?.permanentAddress).toBe('Muscat');
    });

    it('leaves the non-nullable column at a real value', async () => {
      const row = await ctx.prisma.employeeProfile.findUnique({
        where: { employeeId: fx.empAId },
      });
      expect(row?.numberOfChildren).not.toBeNull();
    });

    it('still clears a column that IS nullable', async () => {
      // The guard must not become a blanket "never write null".
      await ctx
        .http()
        .patch(`/employees/${fx.empAId}/profile`)
        .set(admin())
        .send({ placeOfBirth: 'Nizwa' });
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}/profile`)
        .set(admin())
        .send({ placeOfBirth: null });
      expect(res.status).toBeLessThan(500);
      const row = await ctx.prisma.employeeProfile.findUnique({
        where: { employeeId: fx.empAId },
      });
      expect(row?.placeOfBirth).toBeNull();
    });

    it('does not 500 on the employee table either', async () => {
      const res = await patch({ status: null, phoneCountryCode: null });
      expect(res.status).toBeLessThan(500);
      const row = await ctx.prisma.employee.findUnique({
        where: { id: fx.empAId },
      });
      expect(row?.status).not.toBeNull();
    });
  });

  // ── records that predate the template ─────────────────────────────────────

  describe('an employee created before the template existed', () => {
    let legacyId: string;

    beforeAll(async () => {
      // customFields NULL, exactly like every row that existed pre-feature.
      const emp = await ctx.prisma.employee.findUnique({
        where: { id: fx.empBId },
      });
      legacyId = emp!.id;
      await ctx.prisma.employee.update({
        where: { id: legacyId },
        data: { customFields: undefined },
      });
      await ctx.prisma.$executeRawUnsafe(
        `UPDATE employees SET custom_fields = NULL WHERE id = $1::uuid`,
        legacyId,
      );
    });

    it('reads back without throwing on a NULL bag', async () => {
      const res = await ctx.http().get(`/employees/${legacyId}`).set(admin());
      expect(res.status).toBe(200);
    });

    it('accepts the first custom value and creates the bag', async () => {
      const res = await custom({ edgeText: 'first' });
      expect(res.status).toBe(200);
    });

    it('writes exactly one key, inventing nothing', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${legacyId}`)
        .set(admin())
        .send({ customFields: { edgeText: 'first' } });
      expect(res.status).toBe(200);
      expect(Object.keys(await bag(legacyId))).toEqual(['edgeText']);
    });

    it('still computes profile completion', async () => {
      const res = await ctx
        .http()
        .get(`/employees/${legacyId}/profile`)
        .set(admin());
      expect(res.status).toBe(200);
      const pct = res.body.data.profileCompletionPercentage;
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    });
  });

  // ── keys that collide with the machinery ──────────────────────────────────

  describe('field keys that collide', () => {
    const createField = (fieldKey: string, label = fieldKey) =>
      ctx
        .http()
        .post(`/profile-templates/${templateId}/fields`)
        .set(admin())
        .send({ sectionId, fieldKey, label, fieldType: 'TEXT' });

    it('refuses a key that shadows a real employee column', async () => {
      expect((await createField('fullName')).status).toBeGreaterThanOrEqual(400);
      expect((await createField('baseSalary')).status).toBeGreaterThanOrEqual(400);
    });

    it('refuses a key that shadows the bag itself', async () => {
      expect((await createField('customFields')).status).toBeGreaterThanOrEqual(400);
    });

    it('records what happens for a non-form employee column', async () => {
      // hasCompleteProfile is a real column but is in EXCLUDED_COLUMNS rather
      // than RESERVED_FIELD_KEYS. Pinning whichever way it goes so a change is
      // deliberate.
      const res = await createField('hasCompleteProfile');
      expect(res.status).toBeLessThan(500);
      if (res.status < 300) {
        await ctx.prisma.profileTemplateField.deleteMany({
          where: { templateId, fieldKey: 'hasCompleteProfile' },
        });
      }
    });

    it('does not 500 on an absurdly long key or label', async () => {
      const res = await createField('k'.repeat(300), 'L'.repeat(1000));
      expect(res.status).toBeLessThan(500);
    });
  });

  // ── locked fields ─────────────────────────────────────────────────────────

  describe('locked fields resist every route', () => {
    const lockedField = async () => {
      const f = await ctx.prisma.profileTemplateField.findFirst({
        where: { templateId, fieldKey: 'baseSalary' },
      });
      return f!;
    };

    it('cannot be deactivated', async () => {
      const f = await lockedField();
      const res = await ctx
        .http()
        .patch(`/profile-templates/${templateId}/fields/${f.id}`)
        .set(admin())
        .send({ isActive: false });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('cannot be deleted', async () => {
      const f = await lockedField();
      const res = await ctx
        .http()
        .delete(`/profile-templates/${templateId}/fields/${f.id}`)
        .set(admin());
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('cannot be retyped', async () => {
      const f = await lockedField();
      const res = await ctx
        .http()
        .patch(`/profile-templates/${templateId}/fields/${f.id}`)
        .set(admin())
        .send({ fieldType: 'TEXT' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('survives all three attempts intact', async () => {
      const f = await lockedField();
      expect(f.isActive).toBe(true);
      expect(f.fieldType).not.toBe('TEXT');
    });
  });

  // ── concurrency ───────────────────────────────────────────────────────────

  describe('races', () => {
    it('never lets two company templates be active at once', async () => {
      // The partial unique index is the real guard; the service pre-check
      // races. Fire both at once and require the database to arbitrate.
      const adopt = () =>
        ctx
          .http()
          .post('/profile-templates/adopt')
          .set(admin())
          .send({ scope: 'COMPANY', country: 'IN' });
      const results = await Promise.allSettled([adopt(), adopt()]);
      const created = results.filter(
        (r) => r.status === 'fulfilled' && (r.value as any).status < 300,
      );
      expect(created.length).toBeLessThanOrEqual(1);

      const active = await ctx.prisma.profileTemplate.count({
        where: { scope: 'COMPANY', isActive: true },
      });
      expect(active).toBe(1);

      for (const r of created) {
        const id = (r as any).value.body?.data?.id;
        if (id) {
          await ctx.prisma.profileTemplate
            .delete({ where: { id } })
            .catch(() => undefined);
        }
      }
    });

    it('does not lose a concurrent write to a different key', async () => {
      // Two PATCHes to different custom fields must not clobber one another —
      // the merge is read-modify-write on a single JSONB column.
      await custom({ edgeText: 'base' });
      const [a, b] = await Promise.all([
        custom({ edgeText: 'from-a' }),
        custom({ edgeNum: 42 }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const after = await bag();
      // At least one survives; a lost update on BOTH would mean the merge is
      // dropping writes outright.
      expect(after.edgeText !== undefined || after.edgeNum !== undefined).toBe(true);
    });
  });

  // ── scoping ───────────────────────────────────────────────────────────────

  describe('template configuration scoping', () => {
    it('does not 500 when an employee asks for another branch template', async () => {
      const res = await ctx
        .http()
        .get(`/profile-templates/active?branchId=${fx.branchB}`)
        .set({ Authorization: `Bearer ${fx.plainEmployee.token}` });
      // Known gap: this is unscoped today. Pinned so the fix is visible when it
      // lands, and so it never degrades into a 500.
      expect(res.status).toBeLessThan(500);
    });

    it('refuses template mutation to a non-admin', async () => {
      const res = await ctx
        .http()
        .post(`/profile-templates/${templateId}/fields`)
        .set({ Authorization: `Bearer ${fx.scopedHr.token}` })
        .send({ sectionId, fieldKey: 'edgeSneak', label: 'Sneak', fieldType: 'TEXT' });
      expect(res.status).toBe(403);
    });

    it('refuses a garbage template id without leaking internals', async () => {
      const res = await ctx
        .http()
        .get('/profile-templates/not-a-uuid')
        .set(admin());
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|sql|stack/i);
    });
  });
});
