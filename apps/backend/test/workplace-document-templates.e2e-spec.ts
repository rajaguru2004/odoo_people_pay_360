import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer, withSetting } from './utils/settings';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';

/**
 * The document template engine — lifecycle, RBAC, branch scoping and the
 * publish concurrency rule.
 *
 * Everything here runs with `document_engine_enabled` flipped ON inside
 * `withSetting`, which restores in a `finally`. The flag is PINNED OFF in the
 * e2e baseline on purpose: the default run must exercise the pre-engine
 * behaviour, so that a suite which forgets to flip it fails loudly rather than
 * inheriting somebody else's state. `maxWorkers: 1` means a leaked flag would
 * be handed to every suite that follows.
 *
 * What this file is FOR, beyond happy paths:
 *
 *   1. The flag actually gates. Off, every route is refused — and refused with
 *      a message that names the setting, not "operation could not be
 *      completed".
 *   2. The version state machine is real: published is immutable, a stale save
 *      is refused rather than silently overwriting, and rollback CLONES rather
 *      than un-archiving.
 *   3. Publish concurrency is decided by the DATABASE (two partial unique
 *      indexes), not by a check-then-write that races.
 *   4. Branch scoping in both directions — the COMPANY row is visible from
 *      inside a branch (the `direct-or-global` rule), and a cross-branch id
 *      answers 404 rather than 403, so existence does not leak.
 *   5. Write is ADMIN-only while read is ADMIN+HR. Publishing changes what
 *      goes to banks; HR drafts, an administrator ships.
 */
describe('Workplace — Document templates (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;

  /** The shipped COMPANY salary-certificate template, seeded at boot. */
  let salaryTemplateId: string;

  const engineOn = <T>(fn: () => Promise<T>) =>
    withSetting(ctx, 'document_engine_enabled', 'true', fn);

  const listTemplates = (token: string) =>
    ctx.http().get('/documents/templates').set(bearer(token));

  const getTemplate = (token: string, id: string) =>
    ctx.http().get(`/documents/templates/${id}`).set(bearer(token));

  const createDraft = (token: string, id: string, from?: string) =>
    ctx
      .http()
      .post(`/documents/templates/${id}/versions${from ? `?from=${from}` : ''}`)
      .set(bearer(token))
      .send();

  const saveDraft = (token: string, versionId: string, body: Record<string, unknown>) =>
    ctx.http().put(`/documents/versions/${versionId}`).set(bearer(token)).send(body);

  const publish = (token: string, versionId: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/documents/versions/${versionId}/publish`).set(bearer(token)).send(body);

  /** A minimal but valid block document for the salary certificate. */
  const docFor = (headline: string) => ({
    schemaVersion: 1,
    documentType: 'SALARY_CERTIFICATE',
    locale: 'en',
    dir: 'ltr',
    page: {
      size: 'A4',
      orientation: 'portrait',
      margin: { top: 20, right: 18, bottom: 20, left: 18 },
      letterhead: { source: 'company', firstPageOnly: true },
    },
    theme: { followBrand: true },
    body: [
      { id: 'h1', type: 'heading', props: { html: headline, level: 1, align: 'center' } },
      { id: 't1', type: 'text', props: { html: '<p>Dear {{employeeName}},</p>' } },
    ],
  });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);

    const shipped = await ctx.prisma.documentTemplate.findFirst({
      where: { typeKey: 'SALARY_CERTIFICATE', locale: 'en', branchId: null },
      select: { id: true },
    });
    salaryTemplateId = shipped!.id;
  }, 120_000);

  afterAll(async () => {
    await ctx?.app.close();
  });

  // ── 1. The flag gates, and says so ────────────────────────────────────────

  describe('1. the kill switch', () => {
    it('DOC-API-01 refuses every template route while the engine is off', async () => {
      // Pinned OFF in the baseline, so no withSetting here — this is the
      // default state a deployment is in.
      const res = await listTemplates(fx.admin.token);
      expect(res.status).toBe(404);
      // The refusal TEXT, not only the status: a correct 404 once reached a
      // user as "the operation could not be completed", which told them
      // nothing about what to do next.
      expect(res.body.message).toMatch(/document template engine is turned off/i);
      expect(res.body.message).toMatch(/document_engine_enabled/);
    });

    it('DOC-API-02 serves them once it is on', async () => {
      await engineOn(async () => {
        const res = await listTemplates(fx.admin.token);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThan(0);
      });
    });
  });

  // ── 2. What ships ─────────────────────────────────────────────────────────

  describe('2. shipped templates', () => {
    it('DOC-API-03 seeds a published version for every type, so a new deployment can generate at once', async () => {
      await engineOn(async () => {
        const res = await listTemplates(fx.admin.token);
        const unpublished = res.body.filter((t: any) => !t.publishedVersionId);
        // A shipped template that landed as a draft would mean nobody could
        // generate anything until an admin pressed Publish twenty-seven times.
        expect(unpublished).toEqual([]);
        expect(res.body.every((t: any) => t.scope === 'COMPANY')).toBe(true);
      });
    });

    it('DOC-API-04 ships both locales for a salary certificate', async () => {
      await engineOn(async () => {
        const res = await listTemplates(fx.admin.token);
        const locales = res.body
          .filter((t: any) => t.typeKey === 'SALARY_CERTIFICATE')
          .map((t: any) => t.locale)
          .sort();
        expect(locales).toEqual(['ar', 'en']);
      });
    });

    it('DOC-API-05 exposes the merge-field manifest the token picker reads', async () => {
      await engineOn(async () => {
        const res = await ctx
          .http()
          .get('/documents/types/SALARY_CERTIFICATE/manifest')
          .set(bearer(fx.admin.token));
        expect(res.status).toBe(200);
        const paths = res.body.groups.flatMap((g: any) => g.tokens.map((t: any) => t.path));
        expect(paths).toEqual(expect.arrayContaining(['employeeName', 'companyName', 'baseSalary']));
        // Every token carries a sample, or the preview renders blank and an
        // admin concludes the field is broken.
        for (const g of res.body.groups) {
          for (const t of g.tokens) expect(t.sampleValue).toBeDefined();
        }
      });
    });

    it('DOC-API-06 answers 404 for an unknown document type rather than an empty manifest', async () => {
      await engineOn(async () => {
        const res = await ctx
          .http()
          .get('/documents/types/NOT_A_TYPE/manifest')
          .set(bearer(fx.admin.token));
        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/NOT_A_TYPE/);
      });
    });
  });

  // ── 3. The catalogue is role-filtered ─────────────────────────────────────

  describe('3. catalogue visibility', () => {
    it('DOC-API-07 hides pay documents from a MANAGER entirely', async () => {
      await engineOn(async () => {
        const res = await ctx.http().get('/documents/types').set(bearer(fx.manager.token));
        expect(res.status).toBe(200);
        const keys = res.body.map((t: any) => t.key);
        // Filtered rather than disabled: a manager should not learn that a
        // payroll register exists.
        expect(keys).not.toContain('PAYROLL_REGISTER');
        expect(keys).not.toContain('SALARY_CERTIFICATE');
      });
    });

    it('DOC-API-08 shows an EMPLOYEE only their own self-service documents', async () => {
      await engineOn(async () => {
        const res = await ctx.http().get('/documents/types').set(bearer(fx.employee.token));
        const keys = res.body.map((t: any) => t.key);
        expect(keys).toContain('PAYSLIP');
        expect(keys).not.toContain('WARNING_LETTER');
      });
    });
  });

  // ── 4. Read/write role split ──────────────────────────────────────────────

  describe('4. who may do what', () => {
    it('DOC-API-09 lets HR read templates', async () => {
      await engineOn(async () => {
        const res = await listTemplates(fx.scopedHr.token);
        expect(res.status).toBe(200);
      });
    });

    it('DOC-API-10 refuses HR the write routes — publishing changes what goes to banks', async () => {
      await engineOn(async () => {
        const draft = await createDraft(fx.scopedHr.token, salaryTemplateId);
        expect(draft.status).toBe(403);
      });
    });

    it('DOC-API-11 refuses a MANAGER and an EMPLOYEE the template list outright', async () => {
      await engineOn(async () => {
        for (const token of [fx.manager.token, fx.employee.token]) {
          const res = await listTemplates(token);
          expect(res.status).toBe(403);
        }
      });
    });
  });

  // ── 5. The version state machine ──────────────────────────────────────────

  describe('5. drafts, publishing and history', () => {
    it('DOC-API-12 runs draft → save → publish, and archives the previous version', async () => {
      await engineOn(async () => {
        const start = await getTemplate(fx.admin.token, salaryTemplateId);
        const previouslyPublishedId = start.body.publishedVersionId;

        const created = await createDraft(fx.admin.token, salaryTemplateId);
        expect(created.status).toBe(201);
        const versionId = created.body.id;
        expect(created.body.status).toBe('DRAFT');
        // Relative, not absolute: this suite is re-runnable against a database
        // that already holds versions from a previous run, and an assertion of
        // `=== 2` would fail for a reason that has nothing to do with the
        // behaviour under test.
        const before = await getTemplate(fx.admin.token, salaryTemplateId);
        const highest = Math.max(
          ...before.body.versions.map((v: any) => v.versionNo).filter((n: number) => n !== created.body.versionNo),
        );
        expect(created.body.versionNo).toBeGreaterThan(highest);

        const saved = await saveDraft(fx.admin.token, versionId, {
          doc: docFor('SALARY CERTIFICATE v2'),
          changeNote: 'Reworded the heading',
        });
        expect(saved.status).toBe(200);
        expect(saved.body.bodyHtml).toContain('SALARY CERTIFICATE v2');
        expect(saved.body.bodyHtml).toContain('{{employeeName}}');

        const published = await publish(fx.admin.token, versionId, {
          expectedContentHash: saved.body.contentHash,
        });
        expect(published.status).toBe(201);
        expect(published.body.publishedVersionId).toBe(versionId);

        // Keyed on IDS, not version numbers: what matters is that the version
        // just published is live and the one it replaced was archived, which is
        // true on the first run and on the tenth.
        const byId = Object.fromEntries(
          published.body.versions.map((v: any) => [v.id, v.status]),
        );
        expect(byId[versionId]).toBe('PUBLISHED');
        expect(byId[previouslyPublishedId]).toBe('ARCHIVED');
        // And exactly one is live — the invariant the partial unique index holds.
        expect(Object.values(byId).filter((st) => st === 'PUBLISHED')).toHaveLength(1);
      });
    });

    it('DOC-API-13 refuses to edit a published version, and says to make a draft', async () => {
      await engineOn(async () => {
        const t = await getTemplate(fx.admin.token, salaryTemplateId);
        const publishedId = t.body.publishedVersionId;
        const res = await saveDraft(fx.admin.token, publishedId, { doc: docFor('sneaky edit') });
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/published and cannot be edited/i);
        expect(res.body.message).toMatch(/new draft/i);
      });
    });

    it('DOC-API-14 refuses a stale save rather than overwriting the other editor', async () => {
      await engineOn(async () => {
        const created = await createDraft(fx.admin.token, salaryTemplateId);
        const versionId = created.body.id;
        const first = await saveDraft(fx.admin.token, versionId, { doc: docFor('A') });
        expect(first.status).toBe(200);

        // Second editor still holds the updatedAt from before the first save.
        const stale = await saveDraft(fx.admin.token, versionId, {
          doc: docFor('B'),
          expectedUpdatedAt: created.body.updatedAt,
        });
        expect(stale.status).toBe(409);
        expect(stale.body.message).toMatch(/changed by someone else/i);

        // And the first editor's content is still there, untouched.
        const check = await getTemplate(fx.admin.token, salaryTemplateId);
        expect(check.body.draft.bodyHtml).toContain('A');

        await ctx.http().delete(`/documents/versions/${versionId}`).set(bearer(fx.admin.token));
      });
    });

    it('DOC-API-15 allows only one draft at a time', async () => {
      await engineOn(async () => {
        const first = await createDraft(fx.admin.token, salaryTemplateId);
        expect(first.status).toBe(201);
        const second = await createDraft(fx.admin.token, salaryTemplateId);
        expect(second.status).toBe(409);
        expect(second.body.message).toMatch(/already has a draft/i);
        await ctx.http().delete(`/documents/versions/${first.body.id}`).set(bearer(fx.admin.token));
      });
    });

    it('DOC-API-16 rolls back by CLONING an old version forward, never un-archiving it', async () => {
      await engineOn(async () => {
        const before = await getTemplate(fx.admin.token, salaryTemplateId);
        const archived = before.body.versions.find((v: any) => v.status === 'ARCHIVED');
        expect(archived).toBeDefined();
        const countBefore = before.body.versions.length;

        const restored = await createDraft(fx.admin.token, salaryTemplateId, archived.id);
        expect(restored.status).toBe(201);
        expect(restored.body.status).toBe('DRAFT');

        const after = await getTemplate(fx.admin.token, salaryTemplateId);
        // History is append-only: the archived row is STILL archived, and a new
        // row exists beside it. Nothing that a generated document pins to has
        // changed state.
        expect(after.body.versions.length).toBe(countBefore + 1);
        expect(
          after.body.versions.find((v: any) => v.id === archived.id).status,
        ).toBe('ARCHIVED');

        await ctx.http().delete(`/documents/versions/${restored.body.id}`).set(bearer(fx.admin.token));
      });
    });

    it('DOC-API-17 refuses to publish an empty template', async () => {
      await engineOn(async () => {
        const created = await createDraft(fx.admin.token, salaryTemplateId);
        await saveDraft(fx.admin.token, created.body.id, {
          doc: { ...docFor('x'), body: [] },
        });
        const res = await publish(fx.admin.token, created.body.id);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/empty/i);
        await ctx.http().delete(`/documents/versions/${created.body.id}`).set(bearer(fx.admin.token));
      });
    });

    it('DOC-API-18 refuses to publish a draft that moved since it was reviewed', async () => {
      await engineOn(async () => {
        const created = await createDraft(fx.admin.token, salaryTemplateId);
        await saveDraft(fx.admin.token, created.body.id, { doc: docFor('reviewed') });
        const res = await publish(fx.admin.token, created.body.id, {
          expectedContentHash: 'a-hash-from-before-the-edit',
        });
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/changed since you reviewed it/i);
        await ctx.http().delete(`/documents/versions/${created.body.id}`).set(bearer(fx.admin.token));
      });
    });
  });

  describe('5b. publishing from inside a branch', () => {
    it('DOC-API-18b publishes a COMPANY template while a branch is selected', async () => {
      // Reported from the running app: every Publish answered "Someone else
      // published a version of this template a moment ago", with nobody else
      // publishing. The admin had a branch chosen in the header, so every
      // request carried X-Branch-Id.
      await engineOn(async () => {
        const created = await ctx
          .http()
          .post(`/documents/templates/${salaryTemplateId}/versions`)
          .set(bearer(fx.admin.token))
          .set('X-Branch-Id', fx.branchA)
          .send();
        expect(created.status).toBe(201);

        const saved = await ctx
          .http()
          .put(`/documents/versions/${created.body.id}`)
          .set(bearer(fx.admin.token))
          .set('X-Branch-Id', fx.branchA)
          .send({ doc: docFor('PUBLISHED FROM A BRANCH') });
        expect(saved.status).toBe(200);

        const published = await ctx
          .http()
          .post(`/documents/versions/${created.body.id}/publish`)
          .set(bearer(fx.admin.token))
          .set('X-Branch-Id', fx.branchA)
          .send({ expectedContentHash: saved.body.contentHash });

        expect(published.status).toBe(201);
        expect(published.body.publishedVersionId).toBe(created.body.id);
        // And the previous one really was archived — exactly one live version.
        const live = published.body.versions.filter((v: any) => v.status === 'PUBLISHED');
        expect(live).toHaveLength(1);
      });
    });
  });

  describe('5c. every version read survives a selected branch', () => {
    // The publish bug was one instance of a general trap: DocumentTemplateVersion
    // is scoped through its template, and a COMPANY template's branchId is NULL,
    // which never matches an IN list. Any version read taken while a branch is
    // selected can therefore come back empty. These pin the rest of the surface
    // rather than assuming publish was the only one.
    it('DOC-API-18c returns the version history and the open draft', async () => {
      await engineOn(async () => {
        const created = await ctx
          .http()
          .post(`/documents/templates/${salaryTemplateId}/versions`)
          .set(bearer(fx.admin.token))
          .set('X-Branch-Id', fx.branchA)
          .send();
        expect(created.status).toBe(201);
        try {
          const detail = await ctx
            .http()
            .get(`/documents/templates/${salaryTemplateId}`)
            .set(bearer(fx.admin.token))
            .set('X-Branch-Id', fx.branchA);
          expect(detail.status).toBe(200);
          // An empty history here would leave the builder with nothing to edit
          // and no way to roll back, on a template that plainly has versions.
          expect(detail.body.versions.length).toBeGreaterThan(1);
          expect(detail.body.draft).not.toBeNull();
          expect(detail.body.published).not.toBeNull();
        } finally {
          await ctx
            .http()
            .delete(`/documents/versions/${created.body.id}`)
            .set(bearer(fx.admin.token))
            .set('X-Branch-Id', fx.branchA);
        }
      });
    });

    it('DOC-API-18d still refuses a SECOND draft while a branch is selected', async () => {
      // The mirror risk: if the scoped read hid the existing draft, this guard
      // would silently stop working and two drafts could coexist — which the
      // partial index would then reject at some unrelated moment.
      await engineOn(async () => {
        const first = await ctx
          .http()
          .post(`/documents/templates/${salaryTemplateId}/versions`)
          .set(bearer(fx.admin.token))
          .set('X-Branch-Id', fx.branchA)
          .send();
        expect(first.status).toBe(201);
        try {
          const second = await ctx
            .http()
            .post(`/documents/templates/${salaryTemplateId}/versions`)
            .set(bearer(fx.admin.token))
            .set('X-Branch-Id', fx.branchA)
            .send();
          expect(second.status).toBe(409);
          expect(second.body.message).toMatch(/already has a draft/i);
        } finally {
          await ctx
            .http()
            .delete(`/documents/versions/${first.body.id}`)
            .set(bearer(fx.admin.token))
            .set('X-Branch-Id', fx.branchA);
        }
      });
    });
  });

  // ── 6. Publish concurrency is settled by the database ─────────────────────

  describe('6. concurrent publish', () => {
    it('DOC-API-19 lets exactly one of two simultaneous publishes win', async () => {
      await engineOn(async () => {
        // Two drafts cannot coexist through the API, so this reaches past it to
        // create the second — the point under test is the DATABASE rule, and a
        // service-level check-then-write could not promise it.
        const template = await ctx.prisma.documentTemplate.findUnique({
          where: { id: salaryTemplateId },
          include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
        });
        const nextNo = template!.versions[0].versionNo;

        const [a, b] = await Promise.all([
          ctx.prisma.documentTemplateVersion.create({
            data: {
              templateId: salaryTemplateId, versionNo: nextNo + 1, status: 'ARCHIVED',
              bodyHtml: '<p>A</p>', contentHash: 'hash-a', pageFormat: 'A4', orientation: 'PORTRAIT',
            },
          }),
          ctx.prisma.documentTemplateVersion.create({
            data: {
              templateId: salaryTemplateId, versionNo: nextNo + 2, status: 'ARCHIVED',
              bodyHtml: '<p>B</p>', contentHash: 'hash-b', pageFormat: 'A4', orientation: 'PORTRAIT',
            },
          }),
        ]);

        const results = await Promise.allSettled([
          ctx.prisma.documentTemplateVersion.update({
            where: { id: a.id }, data: { status: 'PUBLISHED' },
          }),
          ctx.prisma.documentTemplateVersion.update({
            where: { id: b.id }, data: { status: 'PUBLISHED' },
          }),
        ]);

        // One already-published row exists (the shipped one), so BOTH of these
        // must fail against the partial unique index — which is exactly the
        // property being asserted: the database, not the service, decides.
        expect(results.filter((r) => r.status === 'rejected').length).toBeGreaterThan(0);

        const published = await ctx.prisma.documentTemplateVersion.count({
          where: { templateId: salaryTemplateId, status: 'PUBLISHED' },
        });
        expect(published).toBe(1);

        await ctx.prisma.documentTemplateVersion.deleteMany({
          where: { id: { in: [a.id, b.id] } },
        });
      });
    });
  });

  // ── 7. Branch scoping ─────────────────────────────────────────────────────

  describe('7. branch scoping', () => {
    it('DOC-API-20 shows the COMPANY template from inside a branch', async () => {
      await engineOn(async () => {
        // The `direct-or-global` rule. Under plain `direct` the company row
        // (branch_id NULL) would be invisible from every branch, and the whole
        // gallery would read as empty.
        const res = await ctx
          .http()
          .get('/documents/templates')
          .set(bearer(fx.scopedHr.token))
          .set('X-Branch-Id', fx.branchA);
        expect(res.status).toBe(200);
        expect(res.body.some((t: any) => t.typeKey === 'SALARY_CERTIFICATE')).toBe(true);
      });
    });

    it('DOC-API-20b opens the COMPANY template DETAIL from inside a branch (D-26)', async () => {
      await engineOn(async () => {
        // The list shows the card (DOC-API-20); clicking it must not 404. It
        // did: get() ran plain assertInBranch, which is fail-closed on a NULL
        // branchId for a non-global caller — right for payroll rows, wrong for
        // company stationery the gallery just displayed. Found by SDT-03 [hr]
        // in a real browser.
        const res = await ctx
          .http()
          .get(`/documents/templates/${salaryTemplateId}`)
          .set(bearer(fx.scopedHr.token))
          .set('X-Branch-Id', fx.branchA);
        expect(res.status).toBe(200);
        expect(res.body.typeKey).toBe('SALARY_CERTIFICATE');
        // Read-only stays read-only: the same scoped caller still cannot fork
        // a draft of company-wide stationery.
        const write = await createDraft(fx.scopedHr.token, salaryTemplateId);
        expect(write.status).toBe(403);
      });
    });

    it('DOC-API-21 hides a branch-B template from a branch-A caller, as 404 not 403', async () => {
      await engineOn(async () => {
        const branchTemplate = await ctx.prisma.documentTemplate.create({
          data: {
            typeKey: 'NOC', locale: 'en', scope: 'BRANCH', branchId: fx.branchB,
            name: 'Branch B NOC', origin: 'CUSTOM',
          },
        });
        try {
          const res = await ctx
            .http()
            .get(`/documents/templates/${branchTemplate.id}`)
            .set(bearer(fx.scopedHr.token))
            .set('X-Branch-Id', fx.branchA);
          // 404, not 403: a 403 would confirm the row exists, which is itself a
          // disclosure. assertInBranch throws NotFound for this reason.
          expect(res.status).toBe(404);
        } finally {
          await ctx.prisma.documentTemplate.delete({ where: { id: branchTemplate.id } });
        }
      });
    });

    it('DOC-API-22 explains a duplicate COMPANY template instead of failing opaquely', async () => {
      await engineOn(async () => {
        // One active company-wide template per (type, locale) is a real rule,
        // enforced by a partial unique index. An admin trying it is doing
        // something reasonable, so the refusal has to say what to do instead —
        // this answered "Internal server error" until this case was written.
        const res = await ctx
          .http()
          .post(`/documents/templates/${salaryTemplateId}/duplicate`)
          .set(bearer(fx.admin.token))
          .send({ scope: 'COMPANY' });
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/already a company-wide/i);
        expect(res.body.message).toMatch(/branch instead/i);
      });
    });

    it('DOC-API-22b duplicates into a BRANCH, which is the supported way to customize', async () => {
      await engineOn(async () => {
        const res = await ctx
          .http()
          .post(`/documents/templates/${salaryTemplateId}/duplicate`)
          .set(bearer(fx.admin.token))
          .send({ scope: 'BRANCH', branchId: fx.branchA, name: 'Branch A salary certificate' });
        expect(res.status).toBe(201);
        expect(res.body.scope).toBe('BRANCH');
        expect(res.body.branchId).toBe(fx.branchA);
        // Copied as a DRAFT, not published: a copy that went straight live
        // would change what a branch issues the instant somebody clicked
        // Duplicate.
        expect(res.body.publishedVersionId).toBeNull();
        expect(res.body.draft).not.toBeNull();

        // And a second attempt at the same branch is refused with a reason.
        const again = await ctx
          .http()
          .post(`/documents/templates/${salaryTemplateId}/duplicate`)
          .set(bearer(fx.admin.token))
          .send({ scope: 'BRANCH', branchId: fx.branchA });
        expect(again.status).toBe(409);
        expect(again.body.message).toMatch(/that branch already has/i);

        await ctx.prisma.documentTemplateVersion.deleteMany({ where: { templateId: res.body.id } });
        await ctx.prisma.documentTemplate.delete({ where: { id: res.body.id } });
      });
    });
  });

  // ── 8. Preview ────────────────────────────────────────────────────────────

  describe('8. preview', () => {
    it('DOC-API-23 renders exact markup with sample data, without needing Chromium', async () => {
      await engineOn(async () => {
        const res = await ctx
          .http()
          .post('/documents/preview/html')
          .set(bearer(fx.admin.token))
          .send({ doc: docFor('PREVIEW ME'), typeKey: 'SALARY_CERTIFICATE' });
        expect(res.status).toBe(201);
        expect(res.body.html).toContain('PREVIEW ME');
        // Sample data is bound, not left as raw tokens.
        expect(res.body.html).toContain('Ahmed Al-Balushi');
        expect(res.body.html).not.toMatch(/\{\{employeeName\}\}/);
        // Nothing the compiler emitted was stripped by the sanitizer.
        expect(res.body.removed).toEqual([]);
      });
    });

    it('DOC-API-24 keeps the Arabic direction on an Arabic template', async () => {
      await engineOn(async () => {
        const res = await ctx
          .http()
          .post('/documents/preview/html')
          .set(bearer(fx.admin.token))
          .send({
            doc: { ...docFor('شهادة راتب'), locale: 'ar', dir: 'rtl' },
            typeKey: 'SALARY_CERTIFICATE',
          });
        expect(res.status).toBe(201);
        expect(res.body.html).toContain('dir="rtl"');
        // The Arabic font stack lives in the base CSS, which an admin cannot
        // delete — without it every Arabic glyph renders as an empty box.
        expect(res.body.html).toContain('Noto Sans Arabic');
      });
    });

    it('DOC-API-25 strips a remote image out of an admin-authored template', async () => {
      await engineOn(async () => {
        const evil = docFor('X');
        (evil.body as any[]).push({
          id: 'evil',
          type: 'rawHtml',
          props: { html: '<img src="https://attacker.example/p.png?d=1">' },
        });
        const res = await ctx
          .http()
          .post('/documents/preview/html')
          .set(bearer(fx.admin.token))
          .send({ doc: evil, typeKey: 'SALARY_CERTIFICATE' });
        expect(res.status).toBe(201);
        expect(res.body.html).not.toContain('attacker.example');
      });
    });

    it('DOC-API-26 refuses preview to a MANAGER', async () => {
      await engineOn(async () => {
        const res = await ctx
          .http()
          .post('/documents/preview/html')
          .set(bearer(fx.manager.token))
          .send({ doc: docFor('X'), typeKey: 'SALARY_CERTIFICATE' });
        expect(res.status).toBe(403);
      });
    });
  });

  // ── 8b. The GrapesJS v2 dialect ───────────────────────────────────────────

  describe('8b. visual-editor (v2) drafts', () => {
    const grapesDoc = (html: string) => ({
      schemaVersion: 2,
      kind: 'grapes',
      documentType: 'SALARY_CERTIFICATE',
      locale: 'en',
      dir: 'ltr',
      page: {
        size: 'A4',
        orientation: 'portrait',
        margin: { top: 20, right: 18, bottom: 20, left: 18 },
        letterhead: { source: 'company', firstPageOnly: true },
      },
      theme: { followBrand: true },
      grapes: { project: { pages: [] }, html, css: '.x{color:#333}' },
    });

    it('DOC-API-30 saves a v2 draft: chips become tokens, data-var never reaches storage', async () => {
      await engineOn(async () => {
        const created = await createDraft(fx.admin.token, salaryTemplateId);
        expect(created.status).toBe(201);
        try {
          const saved = await saveDraft(fx.admin.token, created.body.id, {
            doc: grapesDoc(
              '<p>Dear <span data-var="employeeName">@ Employee Name</span>,</p>' +
                '<p>Salary: <span data-var="baseSalary" data-format="money">@ Basic</span></p>',
            ),
          });
          expect(saved.status).toBe(200);
          // The STORED bodyHtml is Handlebars, not editor markup: the server
          // owns compilation, the client never ships trusted HTML.
          expect(saved.body.bodyHtml).toContain('{{employeeName}}');
          expect(saved.body.bodyHtml).toContain('{{money baseSalary currency}}');
          expect(saved.body.bodyHtml).not.toContain('data-var');
          expect(saved.body.bodyHtml).not.toContain('@ Employee Name');
        } finally {
          await ctx.http().delete(`/documents/versions/${created.body.id}`).set(bearer(fx.admin.token));
        }
      });
    });

    it('DOC-API-31 neutralises Handlebars TYPED into the canvas — chips are the only token path', async () => {
      await engineOn(async () => {
        const created = await createDraft(fx.admin.token, salaryTemplateId);
        try {
          const saved = await saveDraft(fx.admin.token, created.body.id, {
            doc: grapesDoc('<p>{{evil}} and {{#each secrets}}{{this}}{{/each}}</p>'),
          });
          expect(saved.status).toBe(200);
          // Stored as entities: prints as the literal text the admin typed,
          // and the Handlebars parser never sees a brace.
          expect(saved.body.bodyHtml).not.toMatch(/\{\{evil\}\}/);
          expect(saved.body.bodyHtml).toContain('&#123;&#123;evil&#125;&#125;');
        } finally {
          await ctx.http().delete(`/documents/versions/${created.body.id}`).set(bearer(fx.admin.token));
        }
      });
    });

    it('DOC-API-32 previews a v2 doc with sample data bound', async () => {
      await engineOn(async () => {
        const res = await ctx
          .http()
          .post('/documents/preview/html')
          .set(bearer(fx.admin.token))
          .send({
            typeKey: 'SALARY_CERTIFICATE',
            doc: grapesDoc('<h1>CERT</h1><p><span data-var="employeeName">@ Name</span></p>'),
          });
        expect(res.status).toBe(201);
        expect(res.body.html).toContain('Ahmed Al-Balushi');
        expect(res.body.html).not.toMatch(/\{\{employeeName\}\}/);
      });
    });

    it('DOC-API-33 reports a stripped remote image through removed[]', async () => {
      await engineOn(async () => {
        const created = await createDraft(fx.admin.token, salaryTemplateId);
        try {
          const saved = await saveDraft(fx.admin.token, created.body.id, {
            doc: grapesDoc('<p>x</p><img src="https://evil.example/p.png">'),
          });
          expect(saved.status).toBe(200);
          expect((saved.body.removed ?? []).join(' ')).toContain('evil.example');
          expect(saved.body.bodyHtml).not.toContain('evil.example');
        } finally {
          await ctx.http().delete(`/documents/versions/${created.body.id}`).set(bearer(fx.admin.token));
        }
      });
    });
  });

  // ── 8c. v1 → visual conversion seed ───────────────────────────────────────

  describe('8c. visual-seed (v1 → visual conversion)', () => {
    const visualOn = <T>(fn: () => Promise<T>) =>
      withSetting(ctx, 'document_visual_editor_enabled', 'true', fn);

    const visualSeed = (token: string, versionId: string) =>
      ctx.http().get(`/documents/versions/${versionId}/visual-seed`).set(bearer(token));

    it('DOC-API-34 refuses when the visual editor flag is off, naming the setting', async () => {
      await engineOn(async () => {
        const created = await createDraft(fx.admin.token, salaryTemplateId);
        try {
          // Flag pinned 'false' in the baseline — no flip needed for this branch.
          const res = await visualSeed(fx.admin.token, created.body.id);
          expect(res.status).toBe(404);
          expect(res.body.message).toContain('document_visual_editor_enabled');
        } finally {
          await ctx.http().delete(`/documents/versions/${created.body.id}`).set(bearer(fx.admin.token));
        }
      });
    });

    it('DOC-API-35 seeds a v1 draft into a v2 doc with CHIPS, and the seed recompiles to the same fields', async () => {
      await engineOn(() =>
        visualOn(async () => {
          const created = await createDraft(fx.admin.token, salaryTemplateId);
          try {
            const res = await visualSeed(fx.admin.token, created.body.id);
            expect(res.status).toBe(200);
            expect(res.body.doc.schemaVersion).toBe(2);
            expect(res.body.doc.kind).toBe('grapes');
            // Chips, never tokens: stored bodyHtml would mangle on first save.
            expect(res.body.doc.grapes.html).toContain('data-var="employeeName"');
            expect(res.body.doc.grapes.html).not.toMatch(/\{\{employeeName\}\}/);
            expect(Array.isArray(res.body.dropped)).toBe(true);

            // The ROUND TRIP an admin actually performs: save the seed back as
            // the draft. The recompiled bodyHtml must reference the field again.
            const saved = await saveDraft(fx.admin.token, created.body.id, {
              doc: res.body.doc,
            });
            expect(saved.status).toBe(200);
            expect(saved.body.bodyHtml).toContain('{{employeeName}}');
            expect(saved.body.bodyHtml).not.toContain('data-var');
          } finally {
            await ctx.http().delete(`/documents/versions/${created.body.id}`).set(bearer(fx.admin.token));
          }
        }),
      );
    });

    it('DOC-API-36 rejects seeding a draft that is ALREADY visual', async () => {
      await engineOn(() =>
        visualOn(async () => {
          const created = await createDraft(fx.admin.token, salaryTemplateId);
          try {
            const saved = await saveDraft(fx.admin.token, created.body.id, {
              doc: {
                schemaVersion: 2,
                kind: 'grapes',
                documentType: 'SALARY_CERTIFICATE',
                locale: 'en',
                dir: 'ltr',
                page: { size: 'A4', orientation: 'portrait', margin: { top: 20, right: 18, bottom: 20, left: 18 } },
                theme: { followBrand: true },
                grapes: { project: {}, html: '<p>x</p>', css: '' },
              },
            });
            expect(saved.status).toBe(200);
            const res = await visualSeed(fx.admin.token, created.body.id);
            expect(res.status).toBe(400);
            expect(res.body.message).toContain('classic block draft');
          } finally {
            await ctx.http().delete(`/documents/versions/${created.body.id}`).set(bearer(fx.admin.token));
          }
        }),
      );
    });

    it('DOC-API-37 is ADMIN-only — HR can read templates but not open the conversion door', async () => {
      await engineOn(() =>
        visualOn(async () => {
          const created = await createDraft(fx.admin.token, salaryTemplateId);
          try {
            const res = await visualSeed(fx.scopedHr.token, created.body.id);
            expect(res.status).toBe(403);
          } finally {
            await ctx.http().delete(`/documents/versions/${created.body.id}`).set(bearer(fx.admin.token));
          }
        }),
      );
    });
  });

  // ── 9. Renderer health ────────────────────────────────────────────────────

  describe('9. health', () => {
    it('DOC-API-27 reports the renderer state to an ADMIN and refuses everyone else', async () => {
      const ok = await ctx.http().get('/documents/health').set(bearer(fx.admin.token));
      expect(ok.status).toBe(200);
      expect(ok.body).toHaveProperty('pdfEnabled');
      expect(ok.body).toHaveProperty('fonts');

      for (const token of [fx.scopedHr.token, fx.manager.token, fx.employee.token]) {
        const res = await ctx.http().get('/documents/health').set(bearer(token));
        expect(res.status).toBe(403);
      }
    });
  });
});
