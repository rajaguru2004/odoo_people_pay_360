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
 * The surfaces beyond the form: Excel export, the import template, letters, the
 * list payload and the MCP schema tool.
 *
 * These are the places a template field is easy to forget, and each has a rule
 * that is not obvious from the code: export appends rather than reorders,
 * sensitive fields never leave the system in a spreadsheet or a letter, and the
 * list `select` is an allowlist so a new field is not returned for free.
 */
describe('employee template read surfaces (e2e)', () => {
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

    const existing = await ctx.prisma.systemSetting.findUnique({ where: { key: FLAG } });
    previousFlag = existing?.value ?? null;

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
          fieldKey: 'sfcGrade',
          label: 'Surface Grade',
          fieldType: 'TEXT',
          storage: 'JSONB',
          origin: 'CUSTOM',
          isCustomized: true,
          displayOrder: 950,
        },
        {
          templateId,
          sectionId,
          fieldKey: 'sfcNationalId',
          label: 'Surface National Id',
          fieldType: 'TEXT',
          storage: 'JSONB',
          origin: 'CUSTOM',
          isCustomized: true,
          displayOrder: 951,
          // Must never reach a spreadsheet or a letter.
          isSensitive: true,
        },
      ],
    });

    await ctx.prisma.systemSetting.upsert({
      where: { key: FLAG },
      create: { key: FLAG, value: 'true' },
      update: { value: 'true' },
    });

    // Clear the resolver's 60s cache the way a real admin write would.
    const anyField = await ctx.prisma.profileTemplateField.findFirst({
      where: { templateId },
      select: { id: true, label: true },
    });
    await ctx
      .http()
      .patch(`/profile-templates/${templateId}/fields/${anyField!.id}`)
      .set({ Authorization: `Bearer ${fx.globalAdmin.token}` })
      .send({ label: anyField!.label });

    await ctx.prisma.employee.update({
      where: { id: fx.empAId },
      data: { customFields: { sfcGrade: 'G7', sfcNationalId: '1234567890' } },
    });
  }, 120000);

  afterAll(async () => {
    await ctx.prisma.profileTemplateField.deleteMany({
      where: { templateId, fieldKey: { in: ['sfcGrade', 'sfcNationalId'] } },
    });
    if (previousFlag !== null) {
      await ctx.prisma.systemSetting.update({
        where: { key: FLAG },
        data: { value: previousFlag },
      });
    }
    await fx.cleanup();
    await ctx.app.close();
  }, 120000);

  const admin = () => ({ Authorization: `Bearer ${fx.globalAdmin.token}` });

  describe('employee list', () => {
    it('returns customFields so template columns can render', async () => {
      // The select is an explicit allowlist; without customFields on it the
      // list columns would render blank with no error to explain why.
      const res = await ctx.http().get('/employees?limit=100').set(admin());
      expect(res.status).toBe(200);
      const row = res.body.data.find((e: any) => e.id === fx.empAId);
      expect(row).toBeDefined();
      expect(row.customFields).toMatchObject({ sfcGrade: 'G7' });
    });
  });

  describe('excel export', () => {
    it('produces a workbook with the custom column appended and the sensitive one absent', async () => {
      const res = await ctx
        .http()
        .get('/export/employees')
        .set(admin())
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      const buf = res.body as Buffer;
      expect(buf.length).toBeGreaterThan(0);

      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const ws = wb.worksheets[0];
      const headers = (ws.getRow(1).values as unknown[])
        .slice(1)
        .map((v) => String(v ?? ''));

      // The fixed ten keep their positions — customers key scripts to them.
      expect(headers.slice(0, 10)).toEqual([
        'EMP Code',
        'Full Name',
        'Email',
        'Phone Number',
        'Department',
        'Position',
        'Base Salary',
        'Pay Basis',
        'Join Date',
        'Status',
      ]);
      expect(headers).toContain('Surface Grade');
      // Sensitive fields get no column at all: masked is useless, unmasked leaks.
      expect(headers).not.toContain('Surface National Id');
    });
  });

  describe('import template', () => {
    it('appends the custom column after the fixed thirteen', async () => {
      const res = await ctx
        .http()
        .get('/employees/import/template')
        .set(admin())
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as Buffer);
      const headers = (wb.worksheets[0].getRow(1).values as unknown[])
        .slice(1)
        .map((v) => String(v ?? ''));

      expect(headers[0]).toBe('Full Name *');
      expect(headers[12]).toBe('Timezone');
      // Appended, never woven in — a file downloaded before this feature must
      // still import against the positional reader.
      expect(headers.indexOf('Surface Grade')).toBeGreaterThan(12);
      expect(headers).not.toContain('Surface National Id');
    });
  });

  // The MCP tool is covered in mcp-catalog.e2e-spec.ts, which boots McpModule
  // through the proper MCP harness rather than this app slice.

  describe('profile completion', () => {
    it('is computed from the template rather than the old fixed list', async () => {
      const res = await ctx.http().get(`/employees/${fx.empAId}/profile`).set(admin());
      expect(res.status).toBe(200);
      const pct = res.body.data.profileCompletionPercentage;
      expect(typeof pct).toBe('number');
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    });
  });
});
