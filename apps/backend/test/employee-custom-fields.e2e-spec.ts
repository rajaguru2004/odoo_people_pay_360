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
 * Template-driven custom fields on the employee endpoints, and the per-field
 * read/write permissions that go with them.
 *
 * The kill switch is flipped inside this suite and restored afterwards, because
 * the two halves that matter are "off behaves exactly as before" and "on stores
 * the value" — and only one of them is the default.
 */
describe('employee custom fields (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;
  let templateId: string;
  let sectionId: string;
  let previousFlag: TemplateFlagSnapshot = null;

  const FLAG = 'employee_template_enabled';

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
  }, 120000);

  afterAll(async () => {
    await ctx.prisma.profileTemplateField.deleteMany({
      where: { templateId, origin: 'CUSTOM' },
    });
    // Deleting the row when it did not exist before is the part that used to be
    // missing: on a database where the seed had not created it, "restore" was a
    // no-op and the flag leaked ON into every later suite (maxWorkers: 1).
    await restoreTemplateFlag(ctx, previousFlag);
    await assertTemplateFlagRestored(ctx, previousFlag);
    await fx.cleanup();
    await ctx.app.close();
  }, 120000);

  const admin = () => ({ Authorization: `Bearer ${fx.globalAdmin.token}` });
  const employee = () => ({ Authorization: `Bearer ${fx.plainEmployee.token}` });

  const setFlag = (on: boolean) => setTemplateFlag(ctx, on);

  /**
   * The resolver caches for 60s, so a test that flips the flag must clear it or
   * it reads the previous state. Publishing through the API is what does that
   * in production; here a no-op field write is the cheapest equivalent.
   */
  const bustCache = async () => {
    const field = await ctx.prisma.profileTemplateField.findFirst({
      where: { templateId },
      select: { id: true, label: true },
    });
    await ctx
      .http()
      .patch(`/profile-templates/${templateId}/fields/${field!.id}`)
      .set(admin())
      .send({ label: field!.label });
  };

  describe('with the kill switch off', () => {
    beforeAll(async () => {
      await setFlag(false);
      await bustCache();
    });

    it('rejects customFields rather than silently dropping them', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ customFields: { anything: 'x' } });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not enabled/i);
    });

    it('leaves an ordinary update working exactly as before', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ phone: '+96891234567' });
      expect(res.status).toBe(200);
      expect(res.body.data.phone).toBe('+96891234567');
    });
  });

  describe('with the kill switch on', () => {
    beforeAll(async () => {
      // A validated custom field, plus one only ADMIN may see.
      await ctx.prisma.profileTemplateField.createMany({
        data: [
          {
            templateId,
            sectionId,
            fieldKey: 'e2eGrade',
            label: 'Grade',
            fieldType: 'TEXT',
            storage: 'JSONB',
            validationType: 'REGEX',
            regex: '^G\\d$',
            required: false,
            origin: 'CUSTOM',
            isCustomized: true,
            displayOrder: 900,
            selfVisible: true,
            selfEditable: true,
          },
          {
            templateId,
            sectionId,
            fieldKey: 'e2eSecret',
            label: 'Secret Note',
            fieldType: 'TEXT',
            storage: 'JSONB',
            origin: 'CUSTOM',
            isCustomized: true,
            displayOrder: 901,
            visibleToRoles: ['ADMIN'],
            editableByRoles: ['ADMIN'],
            selfVisible: false,
            selfEditable: false,
          },
        ],
      });
      await setFlag(true);
      await bustCache();
    });

    it('persists a valid value and reads it back', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ customFields: { e2eGrade: 'G4' } });
      expect(res.status).toBe(200);
      expect(res.body.data.customFields).toMatchObject({ e2eGrade: 'G4' });

      const read = await ctx.http().get(`/employees/${fx.empAId}`).set(admin());
      expect(read.body.data.customFields).toMatchObject({ e2eGrade: 'G4' });
    });

    it('enforces the configured validation, keyed to the submitted path', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ customFields: { e2eGrade: 'nope' } });
      expect(res.status).toBe(400);
      // The key must match the RHF field path so the form can highlight it.
      // Bracket access, not toHaveProperty: jest would read the dot as a path.
      expect(res.body.errors['customFields.e2eGrade']).toBe('Invalid format');
    });

    it('rejects a key no template field declares', async () => {
      // Silently dropping would look like a successful save that lost data.
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ customFields: { notAField: 'x' } });
      expect(res.status).toBe(400);
      expect(res.body.errors['customFields.notAField']).toMatch(/unknown/i);
    });

    it('merges rather than replacing, so a partial save keeps the rest', async () => {
      await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ customFields: { e2eSecret: 'classified' } })
        .expect(200);

      const row = await ctx.prisma.employee.findUnique({
        where: { id: fx.empAId },
        select: { customFields: true },
      });
      expect(row!.customFields).toMatchObject({
        e2eGrade: 'G4',
        e2eSecret: 'classified',
      });
    });

    it('records each change in employee history', async () => {
      const rows = await ctx.prisma.employeeHistory.findMany({
        where: { employeeId: fx.empAId, field: { startsWith: 'custom.' } },
      });
      expect(rows.map((r) => r.field)).toEqual(
        expect.arrayContaining(['custom.e2eGrade', 'custom.e2eSecret']),
      );
    });

    it('strips a field the reader may not see', async () => {
      const res = await ctx.http().get(`/employees/${fx.empAId}`).set({
        Authorization: `Bearer ${fx.scopedHr.token}`,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.customFields).toHaveProperty('e2eGrade');
      // Configured ADMIN-only, and HR is not ADMIN.
      expect(res.body.data.customFields).not.toHaveProperty('e2eSecret');
    });

    it('lets an employee set a self-editable custom field on their own record', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${fx.plainEmployee.employeeId}`)
        .set(employee())
        .send({ customFields: { e2eGrade: 'G2' } });
      expect(res.status).toBe(200);
    });

    it('refuses an employee a custom field they may not edit', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${fx.plainEmployee.employeeId}`)
        .set(employee())
        .send({ customFields: { e2eSecret: 'nope' } });
      expect(res.status).toBe(403);
    });

    it('leaves an employee created before the template fully usable', async () => {
      // empB predates every custom field, so its bag is NULL.
      const before = await ctx.prisma.employee.findUnique({
        where: { id: fx.empBId },
        select: { customFields: true },
      });
      expect(before!.customFields).toBeNull();

      const read = await ctx.http().get(`/employees/${fx.empBId}`).set(admin());
      expect(read.status).toBe(200);

      const write = await ctx
        .http()
        .patch(`/employees/${fx.empBId}`)
        .set(admin())
        .send({ phone: '+96899999999' });
      expect(write.status).toBe(200);
    });

    it('still rejects unknown top-level properties (whitelist intact)', async () => {
      // customFields is one declared property; it must not have loosened the
      // global forbidNonWhitelisted pipe.
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ notADtoProperty: 'x' });
      expect(res.status).toBe(400);
    });

    it('does not strip the inner keys of customFields', async () => {
      // The pipe whitelists top-level DTO properties only. If it ever started
      // walking into the bag, values would vanish on a "successful" save.
      const res = await ctx
        .http()
        .patch(`/employees/${fx.empAId}`)
        .set(admin())
        .send({ customFields: { e2eGrade: 'G7' } });
      expect(res.status).toBe(200);
      expect(res.body.data.customFields.e2eGrade).toBe('G7');
    });
  });
});
