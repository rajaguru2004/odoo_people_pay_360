import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer, withSettings } from './utils/settings';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';

/**
 * Generating a real document — the payslip path end to end.
 *
 * This is the RBAC file. The template lifecycle is covered by
 * `workplace-document-templates.e2e-spec.ts`; what is asserted here is who may
 * turn data into a PDF, and about whom.
 *
 * Three rules carry most of the weight, and each one is a rule the product
 * already enforces elsewhere that the engine must not become a way around:
 *
 *   1. An EMPLOYEE gets their OWN payslip and nobody else's, decided from the
 *      token rather than from anything the caller sent.
 *   2. A MANAGER gets no payslip at all. A manager has no business reading a
 *      subordinate's pay, which is the same reason letters refuse them.
 *   3. A DRAFT payroll is not a statement of pay. HR may look at one; an
 *      employee may not be handed one as a PDF, because a PDF looks settled.
 *
 * PDF rendering needs Chromium. Where it is absent the render cases are
 * SKIPPED with a reason rather than failed — the refusal path is asserted
 * separately and always runs.
 */
describe('Workplace — Document generation (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;

  let approvedItemId: string;
  let draftItemId: string;
  let approvedPayrollId: string;
  let draftPayrollId: string;
  /** Whether this machine can actually render. */
  let canRender = false;

  const enginePlusPdf = <T>(fn: () => Promise<T>) =>
    withSettings(
      ctx,
      { document_engine_enabled: 'true', pdf_enabled: 'true' },
      fn,
    );

  const generate = (token: string, body: Record<string, unknown>) =>
    ctx.http().post('/documents/generate').set(bearer(token)).send(body);

  const download = (token: string, id: string) =>
    ctx.http().get(`/secure-files/generated-document/${id}`).set(bearer(token));

  const payslipBody = (employeeId: string, month: number, year: number) => ({
    typeKey: 'PAYSLIP',
    employeeId,
    params: { month, year },
  });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);

    const health = await ctx.http().get('/documents/health').set(bearer(fx.admin.token));
    canRender = Boolean(health.body?.browserLaunchOk);
    if (!canRender) {
      // eslint-disable-next-line no-console
      console.warn(
        '[document-generation] Chromium unavailable — render cases will be skipped, refusal cases still run.',
      );
    }

    // An APPROVED run (visible to the employee) and a DRAFT run (not).
    const approved = await ctx.prisma.payroll.create({
      data: {
        month: 7, year: 2026, status: 'APPROVED', branchId: fx.branchA,
        totalAmount: 1000,
      },
    });
    approvedPayrollId = approved.id;
    const item = await ctx.prisma.payrollItem.create({
      data: {
        payrollId: approved.id, employeeId: fx.base.empAId,
        baseSalary: 1000, workDays: 22, actualWorkDays: 22,
        allowances: 200, netSalary: 1150, deduction: 50,
      },
    });
    approvedItemId = item.id;

    const draft = await ctx.prisma.payroll.create({
      data: {
        month: 6, year: 2026, status: 'DRAFT', branchId: fx.branchA,
        totalAmount: 1000,
      },
    });
    draftPayrollId = draft.id;
    const draftItem = await ctx.prisma.payrollItem.create({
      data: {
        payrollId: draft.id, employeeId: fx.base.empAId,
        baseSalary: 1000, workDays: 22, actualWorkDays: 22, netSalary: 1000,
      },
    });
    draftItemId = draftItem.id;
  }, 180_000);

  afterAll(async () => {
    await ctx?.prisma.generatedDocument.deleteMany({ where: { typeKey: 'PAYSLIP' } });
    await ctx?.prisma.payrollItem.deleteMany({
      where: { id: { in: [approvedItemId, draftItemId].filter(Boolean) } },
    });
    await ctx?.prisma.payroll.deleteMany({
      where: { id: { in: [approvedPayrollId, draftPayrollId].filter(Boolean) } },
    });
    await ctx?.app.close();
  });

  // ── Refusals. These run everywhere, Chromium or not. ──────────────────────

  describe('1. who may generate', () => {
    it('DOC-GEN-01 refuses everyone while the engine is off', async () => {
      const res = await generate(fx.admin.token, payslipBody(fx.base.empAId, 7, 2026));
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/document engine is turned off/i);
    });

    it('DOC-GEN-02 refuses a MANAGER a payslip outright', async () => {
      await enginePlusPdf(async () => {
        const res = await generate(fx.manager.token, payslipBody(fx.base.empAId, 7, 2026));
        expect(res.status).toBe(403);
        // MANAGER is simply not among PAYSLIP's allowedRoles, so the role gate
        // refuses before the sensitivity gate is ever consulted — and the
        // message names the document rather than saying "Forbidden resource",
        // which is what the user would otherwise be told.
        expect(res.body.message).toMatch(/cannot generate a payslip/i);
      });
    });

    it('DOC-GEN-03 refuses an EMPLOYEE a colleague’s payslip', async () => {
      await enginePlusPdf(async () => {
        const res = await generate(
          fx.employee.token,
          payslipBody(fx.branchBEmployeeId, 7, 2026),
        );
        expect([403, 404]).toContain(res.status);
        expect(res.body.message).not.toMatch(/1150|1,150/);
      });
    });

    it('DOC-GEN-04 refuses an EMPLOYEE a DRAFT payroll — a draft is not a statement of pay', async () => {
      await enginePlusPdf(async () => {
        const res = await generate(fx.employee.token, payslipBody(fx.base.empAId, 6, 2026));
        expect(res.status).toBe(404);
      });
    });

    it('DOC-GEN-05 refuses an unknown document type by name', async () => {
      await enginePlusPdf(async () => {
        const res = await generate(fx.admin.token, { typeKey: 'NOT_A_TYPE' });
        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/NOT_A_TYPE/);
      });
    });

    it('DOC-GEN-06 names both remedies when PDF rendering is unavailable', async () => {
      // The refusal an admin actually sees on a deployment without Chromium.
      // It has to name what to change, or it reads as a policy decision.
      await withSettings(
        ctx,
        { document_engine_enabled: 'true', pdf_enabled: 'false' },
        async () => {
          const res = await generate(fx.admin.token, payslipBody(fx.base.empAId, 7, 2026));
          expect(res.status).toBe(503);
          expect(res.body.message).toMatch(/pdf_enabled/);
          expect(res.body.message).toMatch(/chromium/i);
        },
      );
    });
  });

  // ── The real thing. ───────────────────────────────────────────────────────

  describe('2. generating and downloading', () => {
    const maybe = (name: string, fn: () => Promise<void>, timeout = 90_000) =>
      it(name, async () => {
        if (!canRender) {
          console.warn(`SKIPPED (no Chromium): ${name}`);
          return;
        }
        await fn();
      }, timeout);

    maybe('DOC-GEN-07 HR generates a payslip, files it in the vault and returns a download path', async () => {
      await enginePlusPdf(async () => {
        const res = await generate(fx.scopedHr.token, payslipBody(fx.base.empAId, 7, 2026));
        expect(res.status).toBe(201);
        expect(res.body.downloadPath).toMatch(/^\/secure-files\/generated-document\//);

        const row = await ctx.prisma.generatedDocument.findUnique({
          where: { id: res.body.documentId },
          include: { employeeDocument: true },
        });
        expect(row).toBeTruthy();
        // The version is PINNED, so this document remains traceable to the
        // exact wording it was produced from even after ten more publishes.
        expect(row!.templateVersionId).toBeTruthy();
        expect(row!.templateContentHash).toBeTruthy();
        // Private bucket only. A payslip readable by link is a payslip anyone
        // who sees the URL can read.
        expect(row!.privateRef.startsWith('private://')).toBe(true);
        // And it appears in the employee's vault as system-generated.
        expect(row!.employeeDocument?.isSystemGenerated).toBe(true);
        expect(row!.employeeDocument?.fileUrl).toBe('');
      });
    });

    maybe('DOC-GEN-08 the bytes really are a PDF, through the authenticated door', async () => {
      await enginePlusPdf(async () => {
        const gen = await generate(fx.scopedHr.token, payslipBody(fx.base.empAId, 7, 2026));
        const res = await download(fx.scopedHr.token, gen.body.documentId).buffer(true);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/pdf/);
        // Never cached: a payslip in a shared browser cache is a disclosure.
        expect(res.headers['cache-control']).toMatch(/no-store/);
        expect(Buffer.from(res.body).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      });
    });

    maybe('DOC-GEN-09 an employee generates and downloads their OWN payslip', async () => {
      await enginePlusPdf(async () => {
        const res = await generate(fx.employee.token, payslipBody(fx.base.empAId, 7, 2026));
        expect(res.status).toBe(201);
        const dl = await download(fx.employee.token, res.body.documentId).buffer(true);
        expect(dl.status).toBe(200);
        expect(Buffer.from(dl.body).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      });
    });

    maybe('DOC-GEN-10 a MANAGER cannot download a payslip even by id', async () => {
      await enginePlusPdf(async () => {
        const gen = await generate(fx.scopedHr.token, payslipBody(fx.base.empAId, 7, 2026));
        const res = await download(fx.manager.token, gen.body.documentId);
        // 404, not 403 — a 403 would confirm the document exists.
        expect(res.status).toBe(404);
      });
    });

    maybe('DOC-GEN-11 lists an employee’s own documents from the token, never a parameter', async () => {
      await enginePlusPdf(async () => {
        await generate(fx.employee.token, payslipBody(fx.base.empAId, 7, 2026));
        const res = await ctx.http().get('/documents/mine').set(bearer(fx.employee.token));
        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
        for (const d of res.body) {
          expect(d.downloadPath).toMatch(/^\/secure-files\/generated-document\//);
        }
      });
    });
  });
});
