import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import { withSetting } from './utils/settings';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';
import {
  BranchContext,
  runWithBranchBypass,
  runWithBranchStore,
  setBranchContext,
} from '../src/common/branch/branch-context';
import { ClearanceService } from '../src/assets/clearance.service';
import { PdfService } from '../src/pdf/pdf.service';
import {
  ProfileTemplateResolverService,
  TEMPLATE_ENABLED_KEY,
} from '../src/profile-templates/profile-template-resolver.service';

/**
 * WP-8 — the cross-module seams (plan §8).
 *
 * The last backend package. Every module's own behaviour has already been
 * pinned by WP-1…WP-7; what is left is the places where two of them touch and
 * neither one owns the outcome:
 *
 *   XM-API-07  nested `runWithBranchBypass` around a clearance count (plan R19)
 *   XM-API-10  a letter for an employee whose profile template carries an
 *              `isSensitive` field — a disclosure test
 *   XM-API-11  an issued letter landing in the employee's document vault
 *   XM-API-13  an asset following its holder into another manager's department
 *   XM-API-15  deleting a `Branch` that owns assets
 *   XM-API-16  NEW SEAM, not in the plan: an employee offboarded through the
 *              termination-request path while a letter request of theirs is
 *              still PENDING
 *
 * ALREADY COVERED ELSEWHERE — deliberately not repeated here:
 *
 *   XM-API-01..04  the clearance gate across all three offboarding doors, the
 *                  two kill switches, loans in four statuses, override + audit
 *                  -> `workplace-asset-clearance.e2e-spec.ts` (CLR-API-01..26)
 *   XM-API-12      warranty reminder tiers and the dedupe key
 *                  -> `workplace-asset-clearance.e2e-spec.ts` (XM-API-12a..g)
 *
 * House rules (plan §0): every assertion is filtered to THIS run's rows — the
 * sibling suites write to the same database — and every known defect is PINNED
 * with a `KNOWN GAP` comment plus an `it.failing` twin, never hidden.
 */
describe('Workplace — cross-module seams (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;

  // Rows this spec owns, torn down in `afterAll` BEFORE `fx.cleanup()`.
  const ownDeptIds: string[] = [];
  const ownBranchIds: string[] = [];
  const ownAssetIds: string[] = [];
  const ownEmployeeIds: string[] = [];
  const ownUserIds: string[] = [];
  const ownContractIds: string[] = [];
  const ownTerminationRequestIds: string[] = [];
  const ownChangeRequestIds: string[] = [];

  // ── Helpers ────────────────────────────────────────────────────────────────

  const get = (path: string, token?: string) => {
    const r = ctx.http().get(path);
    return token ? r.set(bearer(token)) : r;
  };

  const login = async (email: string): Promise<string> => {
    const res = await ctx
      .http()
      .post('/auth/login')
      .send({ email, password: fx.password });
    if (!res.body?.data?.accessToken) {
      throw new Error(
        `login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body.data.accessToken;
  };

  /** A department with NOBODY in it — the only kind a parent change can move. */
  const mkDept = async (suffix: string, over: Record<string, unknown> = {}) => {
    const dept = await ctx.prisma.department.create({
      data: {
        code: `XM-${suffix}-${fx.runId}`.slice(0, 50),
        name: `XM ${suffix} ${fx.runId}`,
        isActive: true,
        ...over,
      },
    });
    ownDeptIds.push(dept.id);
    return dept;
  };

  const mkEmployee = async (suffix: string, over: Record<string, unknown> = {}) => {
    const emp = await ctx.prisma.employee.create({
      data: {
        employeeCode: `EMP-${fx.runId}-X8${suffix}`,
        fullName: `XM ${suffix}`,
        dateOfBirth: new Date('1993-06-06'),
        idCard: `IDX-${fx.runId}-${suffix}`,
        email: `xm${suffix.toLowerCase()}-${fx.runId}@test.local`,
        departmentId: fx.managedDeptId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: new Date('2024-01-01'),
        baseSalary: 45000,
        status: 'ACTIVE',
        ...over,
      },
    });
    ownEmployeeIds.push(emp.id);
    return emp;
  };

  const mkAsset = async (suffix: string, over: Record<string, unknown> = {}) => {
    const asset = await ctx.prisma.assetItem.create({
      data: {
        assetTag: `XM8-${fx.runId}-${suffix}`.slice(0, 50),
        category: 'Laptop',
        name: `XM Asset ${suffix}`,
        serialNumber: `XMSN-${fx.runId}-${suffix}`,
        branchId: fx.branchA,
        status: 'AVAILABLE',
        purchaseDate: new Date('2025-02-01'),
        purchaseCost: 800,
        warrantyExpiry: new Date('2029-02-01'),
        ...over,
      },
    });
    ownAssetIds.push(asset.id);
    return asset;
  };

  /** An open custody row — `returnedAt IS NULL` is what clearance keys on. */
  const assign = (assetId: string, employeeId: string) =>
    ctx.prisma.assetAssignment.create({
      data: {
        assetId,
        employeeId,
        assignedAt: new Date('2025-03-01'),
        assignedById: fx.admin.userId,
        conditionOut: 'GOOD',
      },
    });

  /** `POST /letters?employeeId=` — the on-behalf door, ADMIN/HR only. */
  const requestLetter = (
    token: string,
    employeeId: string,
    body: Record<string, unknown> = {},
  ) =>
    ctx
      .http()
      .post(`/letters?employeeId=${employeeId}`)
      .set(bearer(token))
      .send({ templateKey: fx.tplApprovalKey, locale: 'en', ...body });

  const issueLetter = (token: string, id: string) =>
    ctx.http().post(`/letters/${id}/issue`).set(bearer(token)).send();

  const createChangeRequest = (
    token: string,
    departmentId: string,
    payload: Record<string, unknown>,
  ) =>
    ctx
      .http()
      .post(`/departments/${departmentId}/change-requests`)
      .set(bearer(token))
      .send(payload);

  const reviewChangeRequest = (
    token: string,
    requestId: string,
    payload: Record<string, unknown>,
  ) =>
    ctx
      .http()
      .patch(`/departments/change-requests/${requestId}/review`)
      .set(bearer(token))
      .send(payload);

  /**
   * Notifications raised for THIS run's principals. The department change
   * request flow tells people (XM-API-06b/06c, R18), and a global count would
   * be poisoned by whichever sibling suite is running.
   */
  const runNotificationCount = () =>
    ctx.prisma.notification.count({
      where: { user: { email: { contains: fx.runId } } },
    });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    const { prisma } = ctx;

    // FK order, children first. `requestedBy` is RESTRICT on User and
    // `AssetAssignment.assignedById` is RESTRICT too, so both have to clear
    // before the base fixture deletes its users.
    await prisma.departmentChangeRequest.deleteMany({
      where: { id: { in: ownChangeRequestIds } },
    });
    await prisma.departmentHistory.deleteMany({
      where: { departmentId: { in: ownDeptIds } },
    });
    await prisma.terminationRequest.deleteMany({
      where: { id: { in: ownTerminationRequestIds } },
    });
    await prisma.contract.deleteMany({ where: { id: { in: ownContractIds } } });

    await prisma.assetAssignment.deleteMany({
      where: { assetId: { in: ownAssetIds } },
    });
    await prisma.assetItem.deleteMany({ where: { id: { in: ownAssetIds } } });

    await prisma.letterRequest.deleteMany({
      where: { employeeId: { in: ownEmployeeIds } },
    });
    await prisma.auditLog.deleteMany({
      where: { userId: { in: ownUserIds } },
    });
    await prisma.auditLog.deleteMany({
      where: {
        action: 'CLEARANCE_OVERRIDDEN',
        user: { email: { contains: fx.runId } },
      },
    });
    await prisma.user.deleteMany({ where: { id: { in: ownUserIds } } });

    // A headship pins an employee the base is about to delete.
    await prisma.department.updateMany({
      where: { id: { in: ownDeptIds } },
      data: { managerId: null },
    });
    await prisma.employee.deleteMany({ where: { id: { in: ownEmployeeIds } } });
    await prisma.department.deleteMany({ where: { id: { in: ownDeptIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: ownBranchIds } } });

    await fx?.cleanup();
    await ctx?.app.close();
  }, 120000);

  // ───────────────────────────────────────────────────────────────────────────
  // XM-API-07 — nested branch bypass around a clearance count (plan finding R19)
  // ───────────────────────────────────────────────────────────────────────────
  describe('XM-API-07 nested runWithBranchBypass around a clearance count (R19)', () => {
    /**
     * There is no HTTP route that nests two bypasses around a clearance count —
     * `assertDepartmentInBranchScope` opens one, the profile-template resolver
     * opens another, and neither calls the other. So the seam is driven in
     * process, against the SAME singletons the HTTP pipeline uses:
     * `runWithBranchStore` seeds the AsyncLocalStorage exactly as
     * `BranchContextMiddleware` does, `setBranchContext` fills it exactly as
     * `BranchContextInterceptor` does, and `ClearanceService` comes out of the
     * live Nest container. Nothing is faked but the request.
     */
    const scopedTo = (branchId: string): BranchContext => ({
      effectiveBranchId: branchId,
      accessibleBranchIds: [branchId],
      isAllBranches: false,
      isGlobal: false,
    });

    /** Open assets the clearance service can see under the current scoping. */
    const openAssetCount = async () => {
      const clearance = ctx.app.get(ClearanceService);
      const status = await clearance.getClearanceStatus(fx.holderId);
      return status.openAssets.length;
    };

    it('XM-API-07 the counted depth keeps the branch-correct answer at every nesting level', async () => {
      // The subject: a branch-A employee holding one open asset.
      // `AssetAssignment` is `'relation'`-scoped through its holder
      // (`branch-scope.map.ts`), so a caller narrowed to branch B must not see
      // it — and a bypass must.
      const trace: number[] = [];

      await runWithBranchStore(async () => {
        setBranchContext(scopedTo(fx.branchB));

        trace.push(await openAssetCount()); // depth 0 — scoped, hidden
        await runWithBranchBypass(async () => {
          trace.push(await openAssetCount()); // depth 1 — bypassed, visible
          await runWithBranchBypass(async () => {
            trace.push(await openAssetCount()); // depth 2 — still visible
          });
          // The inner bypass has closed. A saved-boolean restore would have
          // written `false` back here and re-enabled scoping while the OUTER
          // bypass was still open; the counter must keep it off.
          trace.push(await openAssetCount()); // depth 1 again — still visible
        });
        // Both closed: scoping is back on, and NOT stuck off.
        trace.push(await openAssetCount()); // depth 0 — hidden again
      });

      expect(trace).toEqual([0, 1, 1, 1, 0]);

      // And the mirror: scoped to the holder's OWN branch, the answer is the
      // same at every depth — the bypass changes what is hidden, never what is
      // true.
      const ownBranch: number[] = [];
      await runWithBranchStore(async () => {
        setBranchContext(scopedTo(fx.branchA));
        ownBranch.push(await openAssetCount());
        await runWithBranchBypass(async () => {
          ownBranch.push(await openAssetCount());
          await runWithBranchBypass(async () => {
            ownBranch.push(await openAssetCount());
          });
        });
        ownBranch.push(await openAssetCount());
      });
      expect(ownBranch).toEqual([1, 1, 1, 1]);
    });

    it('XM-API-07b two OVERLAPPING bypasses in one store leave no bypass stuck on', async () => {
      // The failure mode `BranchStore.bypassDepth` documents, driven for real:
      //   A opens, B opens, A closes, B closes.
      // With the old saved-boolean restore, B's `finally` wrote back the `true`
      // it had observed and the store stayed bypassed for the rest of the
      // request, silently unscoping every later query. The counter must survive
      // the interleaving.
      let releaseA!: () => void;
      const aClosed = new Promise<void>((r) => (releaseA = r));
      let markBOpen!: () => void;
      const bOpen = new Promise<void>((r) => (markBOpen = r));

      const seen: Record<string, number> = {};

      await runWithBranchStore(async () => {
        setBranchContext(scopedTo(fx.branchB));

        const a = runWithBranchBypass(async () => {
          await bOpen; // hold A open until B is also open
          seen.insideA = await openAssetCount();
        });
        const b = runWithBranchBypass(async () => {
          markBOpen();
          await aClosed; // hold B open until A has closed
          seen.insideB = await openAssetCount();
        });

        await a;
        releaseA();
        await b;

        seen.after = await openAssetCount();
      });

      // Both saw through the scoping while any bypass was open…
      expect(seen.insideA).toBe(1);
      expect(seen.insideB).toBe(1);
      // …and the store is NOT stuck: branch scoping is enforced again.
      expect(seen.after).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // XM-API-10 — the letter render must not disclose an isSensitive field
  // ───────────────────────────────────────────────────────────────────────────
  describe('XM-API-10 isSensitive profile fields never reach a letter', () => {
    /**
     * The rendered context is observed by spying on the ONE seam it crosses:
     * `PdfService.renderHandlebars(source, context)`. The spy calls through, so
     * a real PDF is still produced, stored and filed — the case asserts what
     * the template was handed, not a substitute for it. Reading the PDF bytes
     * instead would prove nothing: Handlebars renders a missing key as the
     * empty string, so an absent value and a present-but-blank one look
     * identical on the page.
     */
    const captureLetterContext = async (
      employeeId: string,
    ): Promise<Record<string, any>> => {
      const pdf = ctx.app.get(PdfService);
      const spy = jest.spyOn(pdf, 'renderHandlebars');
      try {
        const created = await requestLetter(fx.admin.token, employeeId, {
          purpose: 'sensitive field disclosure check',
        });
        expect(created.status).toBe(201);
        const issued = await issueLetter(fx.admin.token, created.body.data.id);
        expect(issued.status).toBe(201);

        expect(spy).toHaveBeenCalled();
        const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
        return lastCall[1] as Record<string, any>;
      } finally {
        spy.mockRestore();
      }
    };

    it('XM-API-10 the rendered context EXCLUDES an isSensitive field outright — it is not masked, it is absent', async () => {
      const resolver = ctx.app.get(ProfileTemplateResolverService);

      // The value really is on the row — this is an exclusion by
      // `customLetterFields()`, not an empty database.
      const employee = await ctx.prisma.employee.findUniqueOrThrow({
        where: { id: fx.holderId },
        select: { customFields: true },
      });
      expect((employee.customFields as any)[fx.sensitiveFieldKey]).toBe('999.000');
      expect((employee.customFields as any)[fx.visibleFieldKey]).toBe('G7');

      // `employee_template_enabled` is a globally shared setting and defaults
      // to 'false', which short-circuits `customLetterFields()` to `{}`. Wrap
      // the narrowest possible scope, and clear the resolver's 60s cache on
      // both edges so neither this case nor its neighbours read a stale
      // template.
      const context = await withSetting(
        ctx,
        TEMPLATE_ENABLED_KEY,
        'true',
        async () => {
          resolver.invalidate();
          try {
            return await captureLetterContext(fx.holderId);
          } finally {
            resolver.invalidate();
          }
        },
      );

      // The non-sensitive field came through…
      expect(context.custom).toBeDefined();
      expect(context.custom[fx.visibleFieldKey]).toBe('G7');

      // …and the sensitive one is not there in ANY form. Not masked, not
      // '***', not null — the key does not exist.
      expect(Object.keys(context.custom)).not.toContain(fx.sensitiveFieldKey);
      expect(context.custom).not.toHaveProperty(fx.sensitiveFieldKey);
      expect(JSON.stringify(context)).not.toContain('999.000');
      expect(JSON.stringify(context)).not.toContain(fx.sensitiveFieldKey);
    }, 120000);

    it('XM-API-10b custom.* carries only ACTIVE JSONB fields — deactivating one removes it from the letter', async () => {
      const resolver = ctx.app.get(ProfileTemplateResolverService);

      const context = await withSetting(
        ctx,
        TEMPLATE_ENABLED_KEY,
        'true',
        async () => {
          await ctx.prisma.profileTemplateField.update({
            where: { id: fx.visibleFieldId },
            data: { isActive: false },
          });
          resolver.invalidate();
          try {
            return await captureLetterContext(fx.holderId);
          } finally {
            await ctx.prisma.profileTemplateField.update({
              where: { id: fx.visibleFieldId },
              data: { isActive: true },
            });
            resolver.invalidate();
          }
        },
      );

      // The value is still on the employee row; only the field's `isActive`
      // moved. `ProfileTemplateResolverService.loadTemplate()` filters
      // `fields: { where: { isActive: true } }`, so the field never reaches
      // `customLetterFields()` at all.
      expect(context.custom).toEqual({});
      expect(JSON.stringify(context)).not.toContain('G7');
    }, 120000);

    it('XM-API-10c RECORDED: a template placeholder for a sensitive field renders BLANK, with nothing telling its author why', async () => {
      // The fixture template body carries both `{{custom.grade…}}` and
      // `{{custom.secret…}}`. Handlebars resolves the missing key to the empty
      // string, so an HR user who adds a sensitive field to a letter gets a
      // silently empty line rather than an error or a placeholder. That is the
      // SAFE direction — the alternative would be disclosure — but it is worth
      // recording, because "the letter came out blank" is the bug report this
      // behaviour generates.
      const resolver = ctx.app.get(ProfileTemplateResolverService);
      const template = await ctx.prisma.letterTemplate.findUniqueOrThrow({
        where: { id: fx.tplApprovalId },
      });
      expect(template.bodyHtml).toContain(`{{custom.${fx.sensitiveFieldKey}}}`);

      const pdf = ctx.app.get(PdfService);
      const spy = jest.spyOn(pdf, 'renderHandlebars');
      let renderedHtml = '';
      try {
        await withSetting(ctx, TEMPLATE_ENABLED_KEY, 'true', async () => {
          resolver.invalidate();
          try {
            const created = await requestLetter(fx.admin.token, fx.holderId, {
              purpose: 'blank placeholder check',
            });
            expect(created.status).toBe(201);
            await issueLetter(fx.admin.token, created.body.data.id).expect(201);

            const [source, context] =
              spy.mock.calls[spy.mock.calls.length - 1];
            // Render the same source with the same context the service used.
            const Handlebars = require('handlebars');
            renderedHtml = Handlebars.compile(source as string)(context);
          } finally {
            resolver.invalidate();
          }
        });
      } finally {
        spy.mockRestore();
      }

      expect(renderedHtml).toContain('Grade: G7');
      // The sensitive line survives as an empty label, not as a redaction.
      expect(renderedHtml).toContain('Secret: </p>');
      expect(renderedHtml).not.toContain('999.000');
    }, 120000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // XM-API-11 — an issued letter lands in the employee's document vault
  // ───────────────────────────────────────────────────────────────────────────
  describe('XM-API-11 an issued letter files itself in the document vault', () => {
    let letterId: string;
    let documentId: string;
    let serialNumber: string;
    let fileRef: string;

    beforeAll(async () => {
      // The base fixture's plain EMPLOYEE — the only persona in this file with
      // both an Employee row and a login, which `/document-vault/me` needs.
      const created = await requestLetter(
        fx.admin.token,
        fx.employee.employeeId!,
        { purpose: 'vault filing', addressedTo: 'Bank Muscat' },
      );
      if (created.status !== 201) {
        throw new Error(
          `fixture letter request failed: ${created.status} ${JSON.stringify(created.body)}`,
        );
      }
      letterId = created.body.data.id;

      const issued = await issueLetter(fx.admin.token, letterId);
      if (issued.status !== 201) {
        throw new Error(
          `fixture letter issue failed: ${issued.status} ${JSON.stringify(issued.body)}`,
        );
      }
      documentId = issued.body.data.documentId;
      serialNumber = issued.body.data.serialNumber;
      fileRef = issued.body.data.fileRef;
    }, 120000);

    it('XM-API-11 the issued letter creates an EmployeeDocument flagged isSystemGenerated with a private:// ref', async () => {
      expect(documentId).toEqual(expect.any(String));

      const doc = await ctx.prisma.employeeDocument.findUniqueOrThrow({
        where: { id: documentId },
      });

      expect(doc.employeeId).toBe(fx.employee.employeeId);
      expect(doc.documentType).toBe('Letter');
      // The flag that lets the vault tell "generated by HR" from "uploaded by
      // me" — the whole reason EmployeeDocument carries it.
      expect(doc.isSystemGenerated).toBe(true);
      expect(doc.mimeType).toBe('application/pdf');
      expect(doc.fileName).toContain(serialNumber);
      expect(Number(doc.fileSize)).toBeGreaterThan(1000);

      // The letter row points back at it, and both hold the same private ref.
      const request = await ctx.prisma.letterRequest.findUniqueOrThrow({
        where: { id: letterId },
      });
      expect(request.documentId).toBe(doc.id);
      expect(request.fileRef).toBe(fileRef);
      expect(doc.privateRef).toBe(fileRef);
    });

    it('XM-API-11b there is no public URL to reach — the stored fileUrl is the private ref, and nothing serves it', async () => {
      const doc = await ctx.prisma.employeeDocument.findUniqueOrThrow({
        where: { id: documentId },
      });

      // `fileUrl` on a generated letter is deliberately NOT a URL. Both columns
      // carry the opaque `private://` handle, so a leaked row cannot be turned
      // into a link.
      expect(doc.privateRef?.startsWith('private://')).toBe(true);
      expect(doc.fileUrl.startsWith('private://')).toBe(true);
      expect(doc.fileUrl).not.toMatch(/^https?:/i);

      // And the object path behind the ref resolves to no route at all — a
      // salary certificate is never static-served. Nest's own "Cannot GET"
      // marker is the proof that nothing HANDLES it, as opposed to a handler
      // refusing.
      const objectPath = doc.fileUrl.slice('private://'.length);
      const probe = await ctx.http().get(`/${objectPath}`);
      expect(probe.status).toBe(404);
      expect(String(probe.body?.message ?? '')).toMatch(/^Cannot GET\s/);
    });

    it('XM-API-11c the employee sees it on /document-vault/me as a LETTER, with fileUrl null and a secure handle instead', async () => {
      const res = await get('/document-vault/me', fx.employee.token);
      expect(res.status).toBe(200);

      const items: any[] = res.body.data.items;
      const mine = items.find((i) => i.id === documentId);
      expect(mine).toBeDefined();

      expect(mine.kind).toBe('LETTER');
      expect(mine.category).toBe('Letter');
      expect(mine.source).toBe('Generated by HR');
      expect(mine.title).toContain(serialNumber);
      // A private file is projected with NO url — the screen must route through
      // the authenticated download instead.
      expect(mine.fileUrl).toBeNull();
      expect(mine.secureKind).toBe('employee-document');
      expect(mine.secureId).toBe(documentId);

      expect(res.body.data.summary.byKind.LETTER).toBeGreaterThanOrEqual(1);
    });

    it('XM-API-11d HR reads the same row through /document-vault/employee/:id; a MANAGER is refused outright', async () => {
      const asAdmin = await get(
        `/document-vault/employee/${fx.employee.employeeId}`,
        fx.admin.token,
      );
      expect(asAdmin.status).toBe(200);
      expect(
        (asAdmin.body.data.items as any[]).map((i) => i.id),
      ).toContain(documentId);

      // `@Roles('ADMIN','HR_MANAGER')` — "a line manager has no business
      // reading a subordinate's salary certificate".
      const asManager = await get(
        `/document-vault/employee/${fx.employee.employeeId}`,
        fx.manager.token,
      );
      expect(asManager.status).toBe(403);
    });

    it('XM-API-11e a colleague\'s vault does not list it, and the secure download refuses them', async () => {
      // The outsider persona: a real login, a different employee.
      const theirs = await get('/document-vault/me', fx.outsider.token);
      expect(theirs.status).toBe(200);
      expect(
        (theirs.body.data.items as any[]).map((i) => i.id),
      ).not.toContain(documentId);

      const download = await get(
        `/secure-files/employee-document/${documentId}`,
        fx.outsider.token,
      );
      expect(download.status).toBe(403);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // XM-API-13 — an asset following its holder into another department
  // ───────────────────────────────────────────────────────────────────────────
  describe('XM-API-13 an open assignment follows its holder between managers', () => {
    let subjectId: string;
    let assignmentId: string;
    let newDeptId: string;
    let newManagerToken: string;

    const openIdsFor = async (token: string, query = '') => {
      const res = await get(`/assets/assignments/open${query}`, token);
      expect(res.status).toBe(200);
      return (res.body.data as any[]).map((r) => r.id);
    };

    beforeAll(async () => {
      // A second department with a head of its own — `findOpen` narrows a
      // MANAGER to `managedDepartmentIds`, and with only one department a
      // broken filter and a working one look identical.
      const newDept = await mkDept('NEWDEPT');
      newDeptId = newDept.id;

      const newManagerEmp = await mkEmployee('NMGR', {
        departmentId: newDept.id,
        position: 'Head of XM New',
      });
      const newManagerUser = await ctx.prisma.user.create({
        data: {
          email: `xmnewmgr-${fx.runId}@test.local`,
          passwordHash: (
            await ctx.prisma.user.findUniqueOrThrow({
              where: { id: fx.manager.userId },
              select: { passwordHash: true },
            })
          ).passwordHash,
          role: 'MANAGER',
          isActive: true,
          isGlobalBranchAccess: true,
          employeeId: newManagerEmp.id,
        },
      });
      ownUserIds.push(newManagerUser.id);

      await ctx.prisma.department.update({
        where: { id: newDept.id },
        data: { managerId: newManagerEmp.id },
      });

      // The subject starts in the department `fx.manager` heads, holding one
      // asset.
      const subject = await mkEmployee('HOLDER13');
      subjectId = subject.id;
      const asset = await mkAsset('A13', { status: 'ASSIGNED' });
      const assignment = await assign(asset.id, subject.id);
      assignmentId = assignment.id;

      newManagerToken = await login(newManagerUser.email);
    }, 120000);

    it('XM-API-13 before the move, only the holder\'s own department head sees the open assignment', async () => {
      expect(await openIdsFor(fx.manager.token)).toContain(assignmentId);
      expect(await openIdsFor(newManagerToken)).not.toContain(assignmentId);

      // The unscoped roles see it either way — the narrowing is a MANAGER rule,
      // not a visibility rule.
      expect(await openIdsFor(fx.admin.token)).toContain(assignmentId);
    });

    it('XM-API-13b moving the employee moves the asset\'s visibility with them', async () => {
      // The move is written directly: `PATCH /employees/:id` drags in the whole
      // profile-template DTO surface, which is another package's subject. What
      // this case is about is `findOpen`'s `where.employee.departmentId`, and
      // that reads the same column either way.
      await ctx.prisma.employee.update({
        where: { id: subjectId },
        data: { departmentId: newDeptId },
      });

      // The custody row itself never moved — `AssetAssignment` has no
      // department of its own. Visibility is derived from the holder, live.
      const stillOpen = await ctx.prisma.assetAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
      });
      expect(stillOpen.returnedAt).toBeNull();

      expect(await openIdsFor(newManagerToken)).toContain(assignmentId);
      expect(await openIdsFor(fx.manager.token)).not.toContain(assignmentId);
      expect(await openIdsFor(fx.admin.token)).toContain(assignmentId);
    });

    it('XM-API-13c the ?employeeId= door flips with it — 200 for the new head, 403 for the old one', async () => {
      // `findOpen` takes a different branch when `employeeId` is supplied: it
      // resolves the employee and REFUSES rather than returning an empty list,
      // so the two doors have to be asserted separately.
      const byNew = await get(
        `/assets/assignments/open?employeeId=${subjectId}`,
        newManagerToken,
      );
      expect(byNew.status).toBe(200);
      expect((byNew.body.data as any[]).map((r) => r.id)).toContain(assignmentId);

      const byOld = await get(
        `/assets/assignments/open?employeeId=${subjectId}`,
        fx.manager.token,
      );
      expect(byOld.status).toBe(403);
      expect(String(byOld.body.message)).toContain('your own department');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // XM-API-15 — deleting a Branch that owns assets
  // ───────────────────────────────────────────────────────────────────────────
  describe('XM-API-15 deleting a Branch that owns assets', () => {
    const mkBranch = async (suffix: string) => {
      const branch = await ctx.prisma.branch.create({
        data: {
          code: `XMB-${suffix}-${fx.runId}`.slice(0, 50),
          name: `XM Branch ${suffix}`,
          isActive: true,
          timezone: 'Asia/Muscat',
          officeStartTime: '08:00',
          officeEndTime: '17:00',
        },
      });
      ownBranchIds.push(branch.id);
      return branch;
    };

    it('XM-API-15 a branch holding assets is refused with a clean 400, like the employees rule', async () => {
      // REGRESSION LOCK (R65, fixed). `asset_items.branch_id` is a required
      // relation, so Prisma declares `onDelete: Restrict` and Postgres enforces
      // it (XM-API-15c proves that below) — but `BranchesService.delete()` used
      // to check ONLY `_count.employees` and then write `isActive: false`, a
      // soft delete. The FK was unreachable from the API, so the mirror of the
      // Organization phase's "cannot delete with employees" rule simply did not
      // exist for assets: a branch was retired out from under its own property,
      // the assets stayed AVAILABLE pointing at it, and clearance kept counting
      // them for a branch no longer on any list. `delete()` now counts assets
      // beside employees and refuses. XM-API-15d holds the employees rule as
      // the live control, so the two refusals stay the same shape.
      const branch = await mkBranch('ASSETS');
      const asset = await mkAsset('B15', { branchId: branch.id });

      const res = await ctx
        .http()
        .delete(`/branches/${branch.id}`)
        .set(bearer(fx.admin.token));

      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/asset/i);

      // Refused means untouched — not a soft delete that also reported an error.
      const branchRow = await ctx.prisma.branch.findUniqueOrThrow({
        where: { id: branch.id },
      });
      expect(branchRow.isActive).toBe(true);

      const assetRow = await ctx.prisma.assetItem.findUniqueOrThrow({
        where: { id: asset.id },
      });
      expect(assetRow.branchId).toBe(branch.id);
      expect(assetRow.status).toBe('AVAILABLE');
    });

    it('XM-API-15c the RESTRICT is real at the database — a row delete raises P2003, not a silent orphan', async () => {
      // Probed properly per R32/R46: several unhandled FK/unique errors in this
      // module surface as flat 500s, so it matters whether the constraint
      // exists at all. It does — it is only the API that never meets it.
      const branch = await mkBranch('FK');
      await mkAsset('B15F', { branchId: branch.id });

      let code: string | undefined;
      let status: number | undefined;
      try {
        await ctx.prisma.branch.delete({ where: { id: branch.id } });
      } catch (err: any) {
        code = err?.code;
        status = err?.meta?.constraint ? 409 : undefined;
      }
      expect(code).toBe('P2003');
      expect(status).toBeUndefined(); // nothing here maps it to an HTTP status

      // The branch is still there — the refusal was total, not partial.
      const still = await ctx.prisma.branch.findUnique({
        where: { id: branch.id },
      });
      expect(still).not.toBeNull();
    });

    it('XM-API-15d control: the branch-with-EMPLOYEES rule still answers a clean 400, not a 500', async () => {
      // `fx.branchA` holds every fixture employee. This is the rule assets
      // should have had, asserted so the comparison in XM-API-15 is against a
      // live control rather than a remembered one.
      const res = await ctx
        .http()
        .delete(`/branches/${fx.branchA}`)
        .set(bearer(fx.admin.token));

      expect(res.status).toBe(400);
      expect(String(res.body.message)).toContain(
        'Cannot delete branch with employees',
      );

      // And nothing moved.
      const branchRow = await ctx.prisma.branch.findUniqueOrThrow({
        where: { id: fx.branchA },
      });
      expect(branchRow.isActive).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // XM-API-16 — NEW SEAM: termination while a letter request is still PENDING
  // ───────────────────────────────────────────────────────────────────────────
  describe('XM-API-16 offboarding an employee who has a PENDING letter request', () => {
    /**
     * Not in plan §8. It is the join of two things WP-2 and WP-3 each pinned on
     * their own and neither followed across: the clearance gate on the
     * termination-request door, and the `PENDING → ISSUED | REJECTED` letter
     * machine.
     *
     * `LetterRequest.employeeId` is `onDelete: Cascade`, so the schema's answer
     * to "what happens to an open request when the person leaves" is "it
     * disappears". But a TERMINATION is not a delete — it writes
     * `status: 'INACTIVE'` — so the cascade never runs and the request stays
     * exactly where it was.
     *
     * R66 (COLLAPSED — the pin and its twin are XM-API-16 and XM-API-16b).
     * What the defect was: nothing in the letters module read
     * `Employee.status`, at request time or at issue time, so the surviving
     * request sat PENDING in `GET /letters?status=PENDING` — HR's default
     * filter — for someone who no longer worked here, and could be ISSUED with
     * nothing anywhere saying so. What was decided: the SURVIVAL is correct (an
     * ex-employee still needs an experience letter, and refusing would break a
     * real flow) and so is the issue; what was missing was that HR could not
     * TELL. So the request still survives and is still issuable — and both list
     * endpoints now carry `employee.status` and `employee.isFormerEmployee`,
     * and the `LETTER_ISSUED` audit row records what the subject was at the
     * moment the decision was taken. The module-side detail is in
     * `workplace-letters.e2e-spec.ts` §11; what these cases own is the SEAM —
     * that the termination is what produces the flagged row.
     *
     * The OTHER half of this seam is fixed and locked here. R72: the two
     * offboarding routes used to leave the person in two different statuses —
     * `INACTIVE` from the termination request, `TERMINATED` from the employee
     * soft delete — so every report, headcount and payroll-eligibility query
     * keying on one silently missed the other population. All three exits now
     * write `INACTIVE`; XM-API-16 and XM-API-16d assert the pair agrees.
     */
    const mkLeaverWithLetter = async (suffix: string) => {
      const employee = await mkEmployee(suffix);
      const contract = await ctx.prisma.contract.create({
        data: {
          employeeId: employee.id,
          contractType: 'INDEFINITE',
          contractNumber: `XM-CT-${fx.runId}-${suffix}`,
          startDate: new Date('2022-01-01'),
          salary: 45000,
          workType: 'FULL_TIME',
          workHoursPerWeek: 40,
          status: 'ACTIVE',
        },
      });
      ownContractIds.push(contract.id);

      const asset = await mkAsset(`AL${suffix}`, { status: 'ASSIGNED' });
      const assignment = await assign(asset.id, employee.id);

      const created = await requestLetter(fx.admin.token, employee.id, {
        purpose: 'outstanding at the time of exit',
      });
      expect(created.status).toBe(201);
      expect(created.body.data.status).toBe('PENDING');

      const termination = await ctx.prisma.terminationRequest.create({
        data: {
          contractId: contract.id,
          requestedBy: fx.admin.userId,
          terminationCategory: 'RESIGNATION',
          noticeDate: new Date(),
          terminationDate: new Date(),
          reason: 'Resigned',
          status: 'PENDING_APPROVAL',
        },
      });
      ownTerminationRequestIds.push(termination.id);

      return {
        employeeId: employee.id,
        contractId: contract.id,
        assignmentId: assignment.id,
        letterId: created.body.data.id as string,
        terminationRequestId: termination.id,
      };
    };

    const approveTermination = (requestId: string, body: any = {}) =>
      ctx
        .http()
        .post(`/contracts/termination-requests/${requestId}/approve`)
        .set(bearer(fx.admin.token))
        .send({ approverId: fx.admin.userId, comments: 'ok', ...body });

    it('XM-API-16 terminating the employee writes INACTIVE and leaves their letter request PENDING in HR\'s queue, now flagged as a leaver\'s', async () => {
      // Two regression locks meet in this case.
      //
      // R72 (fixed): the employee status this route writes is asserted
      // head-on, and XM-API-16d drives the OTHER offboarding route and asserts
      // the same value. They used to disagree.
      //
      // R66 (fixed): the letter half below. A termination is not a delete, so
      // the `Cascade` never fires and the request stays in HR's default PENDING
      // queue — which is intended, and is now VISIBLE: the queue row says whose
      // request it is. It used to be indistinguishable from an active
      // colleague's.
      const s = await mkLeaverWithLetter('LTR1');

      // The asset half is deliberately overridden rather than returned — this
      // case is about the letter, and an ADMIN override is the only way to keep
      // the asset outstanding through the door (CLR-API-20 owns the gate
      // itself). The override is audited, which is what makes it acceptable.
      const approved = await approveTermination(s.terminationRequestId, {
        clearanceOverrideReason: 'Laptop written off — recovery in progress',
      });
      expect(approved.status).toBe(201);

      const employee = await ctx.prisma.employee.findUniqueOrThrow({
        where: { id: s.employeeId },
      });
      expect(employee.status).toBe('INACTIVE');
      expect(employee.endDate).not.toBeNull();

      // The letter request survives the exit untouched — still PENDING, no
      // rejection reason, no serial. Nothing is auto-cancelled: the letter an
      // ex-employee most often wants is the one they ask for on the way out.
      const letter = await ctx.prisma.letterRequest.findUniqueOrThrow({
        where: { id: s.letterId },
      });
      expect(letter.status).toBe('PENDING');
      expect(letter.rejectedReason).toBeNull();
      expect(letter.serialNumber).toBeNull();

      // And it is still in the queue HR actually looks at — but the row now
      // says the subject has left. This is the half that was missing (R66):
      // the queue could not tell a leaver's request from a colleague's.
      const queue = await get('/letters?status=PENDING', fx.admin.token);
      expect(queue.status).toBe(200);
      const row = (queue.body.data as any[]).find((r) => r.id === s.letterId);
      expect(row).toBeDefined();
      expect(row.employee.id).toBe(s.employeeId);
      expect(row.employee.status).toBe('INACTIVE');
      expect(row.employee.isFormerEmployee).toBe(true);

      // The custody obligation survived the override too — an override is a
      // decision to proceed, not a write-off of the record.
      const held = await ctx.prisma.assetAssignment.findUniqueOrThrow({
        where: { id: s.assignmentId },
      });
      expect(held.returnedAt).toBeNull();
    }, 120000);

    it('XM-API-16b the letter is still ISSUABLE after termination, and the issue is recorded as a decision about a former employee', async () => {
      const s = await mkLeaverWithLetter('LTR2');

      await approveTermination(s.terminationRequestId, {
        clearanceOverrideReason: 'Urgent exit',
      }).expect(201);
      expect(
        (
          await ctx.prisma.employee.findUniqueOrThrow({
            where: { id: s.employeeId },
          })
        ).status,
      ).toBe('INACTIVE');

      // A letter for someone who left, issued deliberately. `Employee.status`
      // is never a gate — an exit is precisely when an experience or service
      // letter is asked for — so this 201 is the assertion that goes red if
      // anyone ever turns the flag two lines down into a refusal.
      const issued = await issueLetter(fx.admin.token, s.letterId);
      expect(issued.status).toBe(201);
      expect(issued.body.data.status).toBe('ISSUED');
      expect(issued.body.data.serialNumber).toEqual(expect.any(String));

      // What R66 added: the response tells the HR user who is doing it that the
      // subject has gone, and the audit row keeps that fact for whoever asks
      // later why a certificate carries a date after the leaving date.
      expect(issued.body.warning).toContain('no longer an active employee');
      const audit = await ctx.prisma.auditLog.findMany({
        where: { action: 'LETTER_ISSUED', resourceId: s.letterId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].newData).toMatchObject({
        serialNumber: issued.body.data.serialNumber,
        employeeStatus: 'INACTIVE',
        isFormerEmployee: true,
      });

      // It files itself in the leaver's vault like any other.
      const doc = await ctx.prisma.employeeDocument.findUniqueOrThrow({
        where: { id: issued.body.data.documentId },
      });
      expect(doc.isSystemGenerated).toBe(true);
      expect(doc.employeeId).toBe(s.employeeId);
    }, 120000);

    it('XM-API-16c the Cascade the termination never fires: a real row delete does erase the request', async () => {
      // The CONTRAST between the two offboarding routes, and the reason the
      // pair above is worth asserting. The schema's answer for a departed
      // employee — Cascade — is only ever reached by `EmployeesService.delete()`'s
      // HARD path or a direct row delete: the request is erased, so there is no
      // row left to flag and nothing for HR to settle. Terminating never gets
      // there, which is why XM-API-16/16b have a surviving, flagged, issuable
      // request to assert. The two routes still leave the LETTER QUEUE in
      // different states — deliberately: a hard delete says this person is not
      // in the system at all, a termination says they worked here and left.
      // Their effect on `Employee.status` no longer differs — that was R72, and
      // XM-API-16d locks it.
      const employee = await mkEmployee('LTR3');
      const created = await requestLetter(fx.admin.token, employee.id, {
        purpose: 'about to be cascaded',
      });
      expect(created.status).toBe(201);
      const letterId = created.body.data.id;

      await ctx.prisma.employee.delete({ where: { id: employee.id } });

      const letter = await ctx.prisma.letterRequest.findUnique({
        where: { id: letterId },
      });
      expect(letter).toBeNull();
    }, 60000);

    it('XM-API-16d the employee SOFT DELETE route records the same exit status as the termination route', async () => {
      // REGRESSION LOCK (R72, fixed). `EmployeesService.delete()` wrote
      // `status: 'TERMINATED'` while `TerminationRequestService.approveTermination`
      // and `ContractsService.terminate` wrote `status: 'INACTIVE'` — one
      // outcome, "this person has left", recorded two ways. Any query keying on
      // one status silently missed the other population, and the ones that do
      // key on it are load-bearing: `DashboardService.getTurnoverStats` counts
      // `status = 'INACTIVE'` AS terminations, `getDepartmentTurnover` groups on
      // it, and the chatbot's headcount answers from it. `INACTIVE` is the value
      // the codebase already read back, so it is the one all three exits write.
      //
      // Asserted as a PAIR on purpose: a case that only checked one route would
      // have passed throughout the defect.
      const viaSoftDelete = await mkEmployee('R72SD');
      const viaTermination = await mkLeaverWithLetter('R72TR');

      const removed = await ctx
        .http()
        .delete(`/employees/${viaSoftDelete.id}`)
        .set(bearer(fx.admin.token));
      expect(removed.status).toBe(200);

      await approveTermination(viaTermination.terminationRequestId, {
        clearanceOverrideReason: 'Laptop written off — recovery in progress',
      }).expect(201);

      const [softDeleted, terminated] = await Promise.all([
        ctx.prisma.employee.findUniqueOrThrow({
          where: { id: viaSoftDelete.id },
        }),
        ctx.prisma.employee.findUniqueOrThrow({
          where: { id: viaTermination.employeeId },
        }),
      ]);

      expect(softDeleted.status).toBe('INACTIVE');
      expect(terminated.status).toBe('INACTIVE');
      expect(softDeleted.status).toBe(terminated.status);
      expect(softDeleted.endDate).not.toBeNull();
      expect(terminated.endDate).not.toBeNull();

      // `TERMINATED` keeps its own meaning on the CONTRACT, which is the only
      // place it ever belonged.
      const contract = await ctx.prisma.contract.findUniqueOrThrow({
        where: { id: viaTermination.contractId },
      });
      expect(contract.status).toBe('TERMINATED');

      // And the one thing that reads the exit status back — the hard-delete
      // precondition — admits the value the soft delete now writes.
      await withSetting(ctx, 'allow_hard_delete_terminated', 'true', async () => {
        const hard = await ctx
          .http()
          .delete(`/employees/${viaSoftDelete.id}/hard`)
          .set(bearer(fx.admin.token));
        expect(hard.status).toBe(200);
      });
      expect(
        await ctx.prisma.employee.findUnique({ where: { id: viaSoftDelete.id } }),
      ).toBeNull();
    }, 120000);
  });
});
