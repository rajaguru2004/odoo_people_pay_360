import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupFixtures, Fixtures } from './utils/fixtures';
import { assertDevDb } from './utils/mcp-harness';

/**
 * Employee Profile Template administration.
 *
 * The invariants under test are the ones that keep a configurable form from
 * breaking payroll and from losing data:
 *
 *   - adopting a country preset COPIES it, so later edits are the customer's;
 *   - a locked field cannot be removed, and the refusal explains why;
 *   - "removing" an optional field hides it and keeps every stored value;
 *   - re-running the shipped preset never overwrites a customization;
 *   - the branch template wins over the company one for its own branch.
 */
describe('employee profile templates (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;
  const created: string[] = [];

  beforeAll(async () => {
    assertDevDb();
    ctx = await bootE2EApp();
    fx = await setupFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    // Cascades to sections and fields.
    if (created.length) {
      await ctx.prisma.profileTemplate.deleteMany({
        where: { id: { in: created } },
      });
    }
    await fx.cleanup();
    await ctx.app.close();
  }, 120000);

  const admin = () => ({ Authorization: `Bearer ${fx.globalAdmin.token}` });
  const hr = () => ({ Authorization: `Bearer ${fx.scopedHr.token}` });
  const employee = () => ({ Authorization: `Bearer ${fx.plainEmployee.token}` });

  /** The COMPANY template the boot seeder guarantees exists. */
  const companyTemplate = async () => {
    const res = await ctx.http().get('/profile-templates?scope=COMPANY').set(admin());
    expect(res.status).toBe(200);
    return res.body.data.find((t: any) => t.isActive);
  };

  it('seeds a company template on boot', async () => {
    const tpl = await companyTemplate();
    expect(tpl).toBeDefined();
    expect(tpl.scope).toBe('COMPANY');
    expect(tpl.branchId).toBeNull();
    expect(tpl._count.fields).toBeGreaterThan(40);
  });

  it('exposes the country presets available to adopt', async () => {
    const res = await ctx.http().get('/profile-templates/presets').set(admin());
    expect(res.status).toBe(200);
    const codes = res.body.data.map((p: any) => p.country);
    expect(codes).toEqual(expect.arrayContaining(['OM', 'IN', 'AE', 'SA']));
    const om = res.body.data.find((p: any) => p.country === 'OM');
    expect(om.extraFieldCount).toBeGreaterThan(0);
  });

  it('decorates fields with the lock metadata the builder needs', async () => {
    const tpl = await companyTemplate();
    const res = await ctx.http().get(`/profile-templates/${tpl.id}`).set(admin());
    expect(res.status).toBe(200);

    const fields = res.body.data.sections.flatMap((s: any) => s.fields);
    const salary = fields.find((f: any) => f.fieldKey === 'baseSalary');
    expect(salary.locked).toBe(true);
    expect(salary.systemRequired).toBe(true);
    expect(salary.storage).toBe('COLUMN');
    // The reason is shown to the admin, so it must actually be there.
    expect(typeof salary.lockReason).toBe('string');
    expect(salary.lockReason.length).toBeGreaterThan(10);

    const gender = fields.find((f: any) => f.fieldKey === 'gender');
    expect(gender.locked).toBe(false);
  });

  describe('adopting a preset', () => {
    let branchTplId: string;

    it('copies the preset into a new branch template', async () => {
      const res = await ctx
        .http()
        .post('/profile-templates/adopt')
        .set(admin())
        .send({ country: 'OM', scope: 'BRANCH', branchId: fx.branchA });

      expect(res.status).toBe(201);
      branchTplId = res.body.data.id;
      created.push(branchTplId);

      expect(res.body.data.scope).toBe('BRANCH');
      expect(res.body.data.branchId).toBe(fx.branchA);
      expect(res.body.data.country).toBe('OM');

      const keys = res.body.data.sections
        .flatMap((s: any) => s.fields)
        .map((f: any) => f.fieldKey);
      // Baseline plus the Oman delta.
      expect(keys).toEqual(expect.arrayContaining(['fullName', 'baseSalary', 'civilIdNumber']));
    });

    it('refuses a second active template for the same branch', async () => {
      const res = await ctx
        .http()
        .post('/profile-templates/adopt')
        .set(admin())
        .send({ country: 'OM', scope: 'BRANCH', branchId: fx.branchA });
      expect(res.status).toBe(409);
    });

    it('leaves the company template untouched — it is a copy, not a link', async () => {
      const company = await companyTemplate();
      const before = await ctx
        .http()
        .get(`/profile-templates/${company.id}`)
        .set(admin());

      // Rename a label on the BRANCH template.
      const branch = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const field = branch.body.data.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.fieldKey === 'nationality');
      await ctx
        .http()
        .patch(`/profile-templates/${branchTplId}/fields/${field.id}`)
        .set(admin())
        .send({ label: 'Citizenship' })
        .expect(200);

      const after = await ctx
        .http()
        .get(`/profile-templates/${company.id}`)
        .set(admin());
      const companyLabel = after.body.data.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.fieldKey === 'nationality').label;
      const beforeLabel = before.body.data.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.fieldKey === 'nationality').label;
      expect(companyLabel).toBe(beforeLabel);
      expect(companyLabel).not.toBe('Citizenship');
    });

    it('keeps a customization when the shipped preset is re-applied', async () => {
      // This is the whole "our v2 must not overwrite their edits" guarantee.
      await ctx
        .http()
        .post(`/profile-templates/${branchTplId}/reseed`)
        .set(admin())
        .expect(201);

      const res = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const nationality = res.body.data.sections
        .flatMap((f: any) => f.fields)
        .find((f: any) => f.fieldKey === 'nationality');
      expect(nationality.label).toBe('Citizenship');
      expect(nationality.isCustomized).toBe(true);
    });

    it('never resurrects a field the admin removed', async () => {
      const res = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const ethnicity = res.body.data.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.fieldKey === 'ethnicity');

      await ctx
        .http()
        .delete(`/profile-templates/${branchTplId}/fields/${ethnicity.id}`)
        .set(admin())
        .expect(200);

      // Two reseeds: the create-only upsert must not bring it back on either.
      await ctx.http().post(`/profile-templates/${branchTplId}/reseed`).set(admin());
      await ctx.http().post(`/profile-templates/${branchTplId}/reseed`).set(admin());

      const after = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const still = after.body.data.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.fieldKey === 'ethnicity');
      // The ROW survives (so stored values survive) but stays hidden.
      expect(still).toBeDefined();
      expect(still.isActive).toBe(false);
    });

    it('refuses to remove a locked field, and says why', async () => {
      const res = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const salary = res.body.data.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.fieldKey === 'baseSalary');

      const del = await ctx
        .http()
        .delete(`/profile-templates/${branchTplId}/fields/${salary.id}`)
        .set(admin());
      expect(del.status).toBe(400);
      expect(del.body.message).toMatch(/payroll/i);

      const after = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const stillActive = after.body.data.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.fieldKey === 'baseSalary');
      expect(stillActive.isActive).toBe(true);
    });

    it('refuses to make a system-required field optional', async () => {
      const res = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const fullName = res.body.data.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.fieldKey === 'fullName');

      const patch = await ctx
        .http()
        .patch(`/profile-templates/${branchTplId}/fields/${fullName.id}`)
        .set(admin())
        .send({ required: false });
      expect(patch.status).toBe(400);
      expect(patch.body.message).toMatch(/optional/i);
    });

    it('refuses to retype a bound field', async () => {
      const res = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const salary = res.body.data.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.fieldKey === 'baseSalary');

      const patch = await ctx
        .http()
        .patch(`/profile-templates/${branchTplId}/fields/${salary.id}`)
        .set(admin())
        .send({ fieldType: 'TEXT' });
      expect(patch.status).toBe(400);
    });

    it('refuses a custom field that shadows a built-in one', async () => {
      const res = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const section = res.body.data.sections[0];

      const post = await ctx
        .http()
        .post(`/profile-templates/${branchTplId}/fields`)
        .set(admin())
        .send({ fieldKey: 'baseSalary', label: 'Sneaky', sectionId: section.id });
      expect(post.status).toBe(400);
      expect(post.body.message).toMatch(/built-in/i);
    });

    it('creates a custom field, always as JSONB', async () => {
      const res = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const section = res.body.data.sections[0];

      const post = await ctx
        .http()
        .post(`/profile-templates/${branchTplId}/fields`)
        .set(admin())
        // storage is sent deliberately: the service must ignore it rather than
        // let a request put arbitrary input on a real column.
        .send({
          fieldKey: 'jobGrade',
          label: 'Job Grade',
          sectionId: section.id,
          fieldType: 'TEXT',
          storage: 'COLUMN',
        });
      expect(post.status).toBe(201);
      expect(post.body.data.storage).toBe('JSONB');
      expect(post.body.data.boundColumn).toBeNull();
      expect(post.body.data.origin).toBe('CUSTOM');
    });

    it('rejects an uncompilable regex instead of storing one that never matches', async () => {
      const res = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const custom = res.body.data.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.fieldKey === 'jobGrade');

      const patch = await ctx
        .http()
        .patch(`/profile-templates/${branchTplId}/fields/${custom.id}`)
        .set(admin())
        .send({ validationType: 'REGEX', regex: '([unclosed' });
      expect(patch.status).toBe(400);
    });

    it('reorders fields', async () => {
      const res = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const section = res.body.data.sections.find((s: any) => s.fields.length >= 2);
      const ids = section.fields.map((f: any) => f.id);
      const reversed = [...ids].reverse();

      await ctx
        .http()
        .post(`/profile-templates/${branchTplId}/fields/reorder`)
        .set(admin())
        .send({ order: reversed })
        .expect(201);

      const after = await ctx.http().get(`/profile-templates/${branchTplId}`).set(admin());
      const nowIds = after.body.data.sections
        .find((s: any) => s.id === section.id)
        .fields.map((f: any) => f.id);
      expect(nowIds).toEqual(reversed);
    });

    it('refuses to reorder fields belonging to another template', async () => {
      const company = await companyTemplate();
      const other = await ctx.http().get(`/profile-templates/${company.id}`).set(admin());
      const foreignId = other.body.data.sections[0].fields[0].id;

      const res = await ctx
        .http()
        .post(`/profile-templates/${branchTplId}/fields/reorder`)
        .set(admin())
        .send({ order: [foreignId] });
      expect(res.status).toBe(400);
    });
  });

  describe('authorization', () => {
    it('lets HR read but not mutate', async () => {
      const tpl = await companyTemplate();
      await ctx.http().get(`/profile-templates/${tpl.id}`).set(hr()).expect(200);

      const res = await ctx
        .http()
        .post('/profile-templates/adopt')
        .set(hr())
        .send({ country: 'IN', scope: 'COMPANY' });
      expect(res.status).toBe(403);
    });

    it('denies a plain employee the admin surface', async () => {
      await ctx.http().get('/profile-templates').set(employee()).expect(403);
      await ctx.http().get('/profile-templates/presets').set(employee()).expect(403);
    });

    it('still serves every employee the active template', async () => {
      // The form has to render for the person filling it in.
      const res = await ctx.http().get('/profile-templates/active').set(employee());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.fields)).toBe(true);
    });
  });

  describe('resolution chain', () => {
    it('prefers the branch template for an employee in that branch', async () => {
      const res = await ctx
        .http()
        .get(`/profile-templates/resolve/${fx.empAId}`)
        .set(admin());
      expect(res.status).toBe(200);
      // Only meaningful when the feature is on; otherwise everyone gets LEGACY.
      if (res.body.data.enabled) {
        expect(res.body.data.source).toBe('BRANCH_OVERRIDE');
      } else {
        expect(res.body.data.source).toBe('LEGACY_BASELINE');
      }
    });

    it('falls back to the company template for a branch with no override', async () => {
      const res = await ctx
        .http()
        .get(`/profile-templates/resolve/${fx.empBId}`)
        .set(admin());
      expect(res.status).toBe(200);
      expect(['COMPANY', 'LEGACY_BASELINE']).toContain(res.body.data.source);
    });

    it('404s for an unknown employee', async () => {
      await ctx
        .http()
        .get('/profile-templates/resolve/00000000-0000-4000-8000-000000000000')
        .set(admin())
        .expect(404);
    });
  });
});
