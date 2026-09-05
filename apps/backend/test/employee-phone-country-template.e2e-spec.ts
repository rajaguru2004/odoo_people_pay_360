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
 * phoneCountryCode survives the template rewrite.
 *
 * The profile-template branch replaced the employee forms with a template
 * renderer while main had just added a hand-written phone-country picker to
 * them. Taking the rewritten forms deleted the picker, and the field was not in
 * the bound-column registry, so the template could not render it either: the
 * API kept accepting the value while no UI could produce one.
 *
 * It is now a bound PHONE_COUNTRY template field. These cases prove that end to
 * end on BOTH sides of the kill switch, because the flag-off path is what
 * production runs and the flag-on path is where the template must not lose it.
 */
describe('phone country through the profile template (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;
  let previousFlag: TemplateFlagSnapshot = null;

  beforeAll(async () => {
    assertDevDb();
    ctx = await bootE2EApp();
    fx = await setupFixtures(ctx);
    previousFlag = await readTemplateFlag(ctx);
  }, 120000);

  afterAll(async () => {
    await restoreTemplateFlag(ctx, previousFlag);
    await assertTemplateFlagRestored(ctx, previousFlag);
    await fx.cleanup();
    await ctx.app.close();
  }, 120000);

  const admin = () => ({ Authorization: `Bearer ${fx.globalAdmin.token}` });

  /**
   * The resolver caches for 60s per process. A no-op field PATCH calls
   * invalidate(), which is how the existing template suites bust it too.
   */
  const bustCache = async () => {
    const tpl = await ctx.prisma.profileTemplate.findFirst({
      where: { scope: 'COMPANY', isActive: true },
    });
    const field = await ctx.prisma.profileTemplateField.findFirst({
      where: { templateId: tpl!.id },
    });
    await ctx
      .http()
      .patch(`/profile-templates/${tpl!.id}/fields/${field!.id}`)
      .set(admin())
      .send({ label: field!.label });
  };

  const readBack = async (id: string) => {
    const res = await ctx.http().get(`/employees/${id}`).set(admin());
    expect(res.status).toBe(200);
    return res.body.data;
  };

  describe.each([
    ['off', false],
    ['on', true],
  ])('with the kill switch %s', (_label, on) => {
    beforeAll(async () => {
      await setTemplateFlag(ctx, on);
      await bustCache();
    });

    it('persists a country set on update and reads it back', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ phoneCountryCode: 'AE' });
      expect(res.status).toBe(200);
      expect((await readBack(fx.empAId)).phoneCountryCode).toBe('AE');
    });

    it('canonicalises a lowercase code', async () => {
      await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ phoneCountryCode: 'om' });
      expect((await readBack(fx.empAId)).phoneCountryCode).toBe('OM');
    });

    it('treats an empty string as "clear it and inherit the branch"', async () => {
      // '' is how the form clears the picker. undefined would mean "leave
      // alone", so the two must not collapse into one another.
      await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ phoneCountryCode: '' });
      expect((await readBack(fx.empAId)).phoneCountryCode).toBeNull();
    });

    it('rejects a value that is not an alpha-2 code', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ phoneCountryCode: 'Oman' });
      expect(res.status).toBe(400);
    });

    it('stores an unassigned alpha-2 code as null rather than as itself', async () => {
      // Pinning current behaviour, not endorsing it: the DTO checks the shape
      // and normalisePhoneRegion checks the country, and a code that passes the
      // first but fails the second is silently dropped rather than refused. The
      // Excel importer, by contrast, reports it. Recorded so the asymmetry is a
      // known one.
      await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ phoneCountryCode: 'ZZ' });
      expect((await readBack(fx.empAId)).phoneCountryCode).toBeNull();
    });
  });

  describe('with the kill switch on', () => {
    beforeAll(async () => {
      await setTemplateFlag(ctx, true);
      await bustCache();
    });

    it('offers the field on the active template as a bound column', async () => {
      const res = await ctx
        .http()
        .get('/profile-templates/active')
        .set(admin());
      expect(res.status).toBe(200);
      const field = res.body.data.fields.find(
        (f: any) => f.fieldKey === 'phoneCountryCode',
      );
      // Absent here is the exact failure this suite exists to catch: the column
      // accepts writes while no form can produce one.
      expect(field).toBeDefined();
      expect(field.storage).toBe('COLUMN');
      expect(field.fieldType).toBe('PHONE_COUNTRY');
      expect(field.sectionKey).toBe('personal');
    });

    it('places it in the personal section, next to the phone it qualifies', async () => {
      const res = await ctx
        .http()
        .get('/profile-templates/active')
        .set(admin());
      const personal = res.body.data.sections.find(
        (s: any) => s.sectionKey === 'personal',
      );
      const keys = personal.fields.map((f: any) => f.fieldKey);
      expect(keys).toContain('phoneCountryCode');
      expect(keys.indexOf('phoneCountryCode')).toBe(keys.indexOf('phone') + 1);
    });

    it('is not offered as a custom JSONB key', async () => {
      // It is a real column; accepting it into the bag as well would give the
      // same concept two storage locations that disagree.
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ customFields: { phoneCountryCode: 'IN' } });
      expect(res.status).toBe(400);
    });
  });

  describe('self-service', () => {
    beforeAll(async () => {
      await setTemplateFlag(ctx, true);
      await bustCache();
    });

    it('lets an employee correct their own phone country', async () => {
      // phone has always been self-editable; a number whose country an employee
      // cannot fix is a number the notification outbox may not be able to dial.
      const self = {
        Authorization: `Bearer ${fx.plainEmployee.token}`,
      };
      const id = fx.plainEmployee.employeeId;
      const res = await ctx
        .http()
        .patch(`/employees/${id}`)
        .set(self)
        .send({ phoneCountryCode: 'IN' });
      expect(res.status).toBe(200);

      const row = await ctx.prisma.employee.findUnique({ where: { id } });
      expect(row!.phoneCountryCode).toBe('IN');
    });

    it('still refuses a privileged field from the same caller', async () => {
      // Proves the widening above is one field, not a hole in the narrowing.
      const self = {
        Authorization: `Bearer ${fx.plainEmployee.token}`,
      };
      const id = fx.plainEmployee.employeeId;
      const before = await ctx.prisma.employee.findUnique({ where: { id } });
      await ctx
        .http()
        .patch(`/employees/${id}`)
        .set(self)
        .send({ baseSalary: 999999 });
      const after = await ctx.prisma.employee.findUnique({ where: { id } });
      expect(Number(after!.baseSalary)).toBe(Number(before!.baseSalary));
    });
  });
});
