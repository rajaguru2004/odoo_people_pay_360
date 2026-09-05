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
 * The kill switch, flipped for real, with live data in the bag.
 *
 * Two properties matter and neither is obvious from reading the resolver:
 *
 *  1. A flip takes effect on the NEXT request. The resolver caches templates for
 *     60s, so it looks like a flip could be swallowed for a minute — but
 *     `resolve()` reads the flag from the database on every call, BEFORE it
 *     consults the cache, and the cached value is template CONTENT rather than
 *     the flag. Every one of the eleven template mutations calls `invalidate()`,
 *     so the cache cannot hold content that a write has superseded either.
 *     Pinned here because "did my toggle actually do anything" is the first
 *     thing anyone asks, and a sleep() in this suite would hide a regression.
 *
 *  2. Turning the feature OFF hides custom fields; it never deletes them.
 *     An admin who flips the switch to test something must not lose the data
 *     entered while it was on.
 */
describe('employee template kill switch (e2e)', () => {
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

    await ctx.prisma.profileTemplateField.create({
      data: {
        templateId,
        sectionId,
        fieldKey: 'ksGrade',
        label: 'Kill Switch Grade',
        fieldType: 'TEXT',
        storage: 'JSONB',
        origin: 'CUSTOM',
        isCustomized: true,
        displayOrder: 950,
      },
    });
  }, 120000);

  afterAll(async () => {
    await ctx.prisma.profileTemplateField.deleteMany({
      where: { templateId, fieldKey: 'ksGrade' },
    });
    await restoreTemplateFlag(ctx, previousFlag);
    await assertTemplateFlagRestored(ctx, previousFlag);
    await fx.cleanup();
    await ctx.app.close();
  }, 120000);

  const admin = () => ({ Authorization: `Bearer ${fx.globalAdmin.token}` });
  const active = () =>
    ctx.http().get('/profile-templates/active').set(admin());
  const bagOf = async () => {
    const row = await ctx.prisma.employee.findUnique({
      where: { id: fx.empAId },
      select: { customFields: true },
    });
    return (row?.customFields ?? {}) as Record<string, unknown>;
  };

  it('stores a custom value while the feature is on', async () => {
    await setTemplateFlag(ctx, true);
    const res = await ctx
      .http()
      .patch(`/employees/${fx.empAId}`)
      .set(admin())
      .send({ customFields: { ksGrade: 'G5' } });
    expect(res.status).toBe(200);
    expect(await bagOf()).toMatchObject({ ksGrade: 'G5' });
  });

  it('reports itself disabled on the very next request after switching off', async () => {
    // No sleep, deliberately. If this ever needs one, the flag has started
    // going through the 60s cache and an admin turning the feature off would be
    // told it is still on.
    await setTemplateFlag(ctx, false);
    const res = await active();
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
    expect(res.body.data.source).toBe('LEGACY_BASELINE');
  });

  it('keeps the stored value while the feature is off', async () => {
    // Hidden, not deleted. Losing data on a config toggle would make the switch
    // unusable for exactly the cautious operator it exists for.
    expect(await bagOf()).toMatchObject({ ksGrade: 'G5' });
  });

  it('refuses further custom writes while off', async () => {
    const res = await ctx
      .http()
      .patch(`/employees/${fx.empAId}`)
      .set(admin())
      .send({ customFields: { ksGrade: 'G6' } });
    expect(res.status).toBe(400);
    expect(await bagOf()).toMatchObject({ ksGrade: 'G5' });
  });

  it('reports itself enabled again on the very next request after switching on', async () => {
    await setTemplateFlag(ctx, true);
    const res = await active();
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.source).toBe('COMPANY');
    expect(
      res.body.data.fields.some((f: any) => f.fieldKey === 'ksGrade'),
    ).toBe(true);
  });

  it('returns the original value unchanged after the round trip', async () => {
    const read = await ctx
      .http()
      .get(`/employees/${fx.empAId}`)
      .set(admin());
    expect(read.body.data.customFields).toMatchObject({ ksGrade: 'G5' });
  });

  it('accepts custom writes again', async () => {
    const res = await ctx
      .http()
      .patch(`/employees/${fx.empAId}`)
      .set(admin())
      .send({ customFields: { ksGrade: 'G7' } });
    expect(res.status).toBe(200);
    expect(await bagOf()).toMatchObject({ ksGrade: 'G7' });
  });
});
