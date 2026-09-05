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
 * There are two write doors onto an employee, and they have to agree.
 *
 *   PATCH /employees/:id           — ran every field through the template
 *   PATCH /employees/:id/profile   — ran nothing through it
 *
 * The second spread its DTO straight into the profile upsert and called
 * resolveCustomFields with no actor, so assertFieldsWritable never ran. An
 * employee refused a field on the first route could write it by posting to the
 * second. Every shipped permission test used the first route, so nothing caught
 * it.
 *
 * The rule these cases encode: the SAME payload, from the SAME caller, must get
 * the SAME answer whichever door it arrives at.
 */
describe('employee write doors agree (e2e)', () => {
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
      include: { sections: true },
    });
    if (!tpl) throw new Error('boot seeder did not create a company template');
    templateId = tpl.id;
    sectionId = tpl.sections.find((s) => s.sectionKey === 'personal')!.id;
  }, 120000);

  afterAll(async () => {
    await ctx.prisma.profileTemplateField.deleteMany({
      where: { templateId, fieldKey: { in: ['wdSecret'] } },
    });
    await restoreTemplateFlag(ctx, previousFlag);
    await assertTemplateFlagRestored(ctx, previousFlag);
    await fx.cleanup();
    await ctx.app.close();
  }, 120000);

  const admin = () => ({ Authorization: `Bearer ${fx.globalAdmin.token}` });
  const selfHeaders = () => ({
    Authorization: `Bearer ${fx.plainEmployee.token}`,
  });
  const selfId = () => fx.plainEmployee.employeeId!;

  /** The resolver caches 60s per process; a no-op field PATCH invalidates it. */
  const bustCache = async () => {
    const field = await ctx.prisma.profileTemplateField.findFirst({
      where: { templateId },
    });
    await ctx
      .http()
      .patch(`/profile-templates/${templateId}/fields/${field!.id}`)
      .set(admin())
      .send({ label: field!.label });
  };

  describe('with the template enabled', () => {
    beforeAll(async () => {
      await setTemplateFlag(ctx, true);
      // An ADMIN-only custom field: the thing a self-service caller must not be
      // able to set through either door.
      await ctx
        .http()
        .post(`/profile-templates/${templateId}/fields`)
        .set(admin())
        .send({
          sectionId,
          fieldKey: 'wdSecret',
          label: 'Write Door Secret',
          fieldType: 'TEXT',
          editableByRoles: ['ADMIN'],
          selfEditable: false,
        });
      await bustCache();
    });

    it('refuses an ADMIN-only custom field on PATCH /employees/:id', async () => {
      const res = await ctx
        .http()
        .patch(`/employees/${selfId()}`)
        .set(selfHeaders())
        .send({ customFields: { wdSecret: 'via-employees' } });
      expect(res.status).toBe(403);
    });

    it('refuses the same field on PATCH /employees/:id/profile', async () => {
      // This is the defect. Before the fix this returned 200 and persisted.
      const res = await ctx
        .http()
        .patch(`/employees/${selfId()}/profile`)
        .set(selfHeaders())
        .send({ customFields: { wdSecret: 'via-profile' } });
      expect(res.status).toBe(403);
    });

    it('leaves nothing behind in the bag from either attempt', async () => {
      const row = await ctx.prisma.employee.findUnique({
        where: { id: selfId() },
      });
      const bag = (row!.customFields ?? {}) as Record<string, unknown>;
      expect(bag.wdSecret).toBeUndefined();
    });

    it('does not write a non-selfEditable profile column through the profile door', async () => {
      // taxCode lives on employee_profiles and is a template field that is not
      // selfEditable. The profile route used to spread it straight into the
      // upsert with no check at all.
      const before = await ctx.prisma.employeeProfile.findUnique({
        where: { employeeId: selfId() },
      });
      const res = await ctx
        .http()
        .patch(`/employees/${selfId()}/profile`)
        .set(selfHeaders())
        .send({ taxCode: 'HACKED' });

      // Dropped rather than refused, matching updateAsSelfService: this form
      // posts its whole model, so a read-only field riding along must not fail
      // the request. What matters is that it is not STORED.
      expect(res.status).toBeLessThan(400);
      const after = await ctx.prisma.employeeProfile.findUnique({
        where: { employeeId: selfId() },
      });
      expect(after?.taxCode ?? null).toBe(before?.taxCode ?? null);
      expect(after?.taxCode).not.toBe('HACKED');
    });

    it('still lets the employee write a field the template does allow', async () => {
      // The narrowing has to be a filter, not a wall — otherwise self-service
      // is broken rather than secured. emergencyContactName is on the same
      // profile table as taxCode above and IS selfEditable in the baseline, so
      // the two together show the boundary rather than a blanket refusal.
      const res = await ctx
        .http()
        .patch(`/employees/${selfId()}/profile`)
        .set(selfHeaders())
        .send({ emergencyContactName: 'Aisha' });
      expect(res.status).toBeLessThan(400);
      const after = await ctx.prisma.employeeProfile.findUnique({
        where: { employeeId: selfId() },
      });
      expect(after?.emergencyContactName).toBe('Aisha');
    });

    it('hides a self-invisible field from the employee on the profile route', async () => {
      // The read side of the same asymmetry: GET /employees/:id projected per
      // role while GET /employees/:id/profile returned everything. With the
      // template on, baseSalary is selfVisible: false and must be absent.
      const res = await ctx
        .http()
        .get(`/employees/${selfId()}/profile`)
        .set(selfHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data.baseSalary).toBeUndefined();
    });

    it('lets an ADMIN set the ADMIN-only field through the profile door', async () => {
      // Proves the check is role-based, not a blanket refusal of the route.
      const res = await ctx
        .http()
        .patch(`/employees/${selfId()}/profile`)
        .set(admin())
        .send({ customFields: { wdSecret: 'ok' } });
      expect(res.status).toBeLessThan(400);
      const row = await ctx.prisma.employee.findUnique({
        where: { id: selfId() },
      });
      expect((row!.customFields as any).wdSecret).toBe('ok');
    });
  });

  describe('with the template disabled — the production default', () => {
    beforeAll(async () => {
      await setTemplateFlag(ctx, false);
      await bustCache();
    });

    it('returns base salary to the employee on their own profile', async () => {
      // The read half of the kill-switch contract, and the exact case the fix
      // is for. The baseline marks baseSalary selfVisible: false and the
      // projection runs whether or not the feature is enabled — so while
      // legacy() copied those gates through, turning the switch OFF still
      // stripped the field. Off must mean off.
      const res = await ctx
        .http()
        .get(`/employees/${selfId()}/profile`)
        .set(selfHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data.baseSalary).toBeDefined();
    });

    it('serves the same record to an admin, unprojected', async () => {
      const res = await ctx
        .http()
        .get(`/employees/${fx.empAId}`)
        .set(admin());
      expect(res.status).toBe(200);
      expect(res.body.data.baseSalary).toBeDefined();
    });

    it('rejects customFields on BOTH doors rather than one', async () => {
      // Symmetry again: the feature is off, so neither route may accept a bag.
      const viaEmployees = await ctx
        .http()
        .patch(`/employees/${selfId()}`)
        .set(admin())
        .send({ customFields: { anything: 'x' } });
      const viaProfile = await ctx
        .http()
        .patch(`/employees/${selfId()}/profile`)
        .set(admin())
        .send({ customFields: { anything: 'x' } });
      expect(viaEmployees.status).toBe(400);
      expect(viaProfile.status).toBe(400);
    });
  });
});
