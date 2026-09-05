import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer, withSetting } from './utils/settings';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';

/**
 * Letter Requests — WP-3 of the Workplace phase (plan §5 "Letter request",
 * §6.1 role matrix, §9 "Letters").
 *
 * This file is the GAP, not the whole module. Two specs already hold the
 * baseline and are deliberately not duplicated here:
 *
 *   - `letters-full-lifecycle.e2e-spec.ts` (26 cases) — template upsert RBAC,
 *     activeOnly filtering, the PENDING → REJECTED happy path, on-behalf for
 *     A/HR, the override silently ignored for M/E, the 403 matrix, five
 *     concurrent EXPERIENCE requests minting unique serials, and the two
 *     `{valid:false}` verification edges.
 *   - `letters-grievance-vault.e2e-spec.ts` (13 cases) — the REAL PDF path:
 *     both-locale shipped templates, a rendered PDF stored privately and filed
 *     in the vault, double-issue refusal, the non-ASCII Content-Disposition
 *     header, and the employee-document download matrix.
 *
 * What is left, and what this file asserts:
 *
 *   1. The three findings the phase exists to record. R4 (the auto-issue
 *      orphan) and R5 (a reject reason nothing validates) are FIXED, and their
 *      cases are now regression locks on the corrected behaviour — each keeps
 *      the account of what the defect was. R14 (issue() does not care whether
 *      the template is still active) stands as recorded: it is the intended
 *      behaviour, pinned against a regression rather than against a defect.
 *   2. Branch scoping across all four service entry points that call
 *      `assertInBranch` — request / issue / reject / fileFor.
 *   3. Download authorization through the secure-download route, including the
 *      rule the service comment states and nothing tested: a MANAGER is refused
 *      even for a direct report.
 *   4. The `@@unique([key, locale])` pair as a real pair — an `ar` round trip.
 *   5. Template upsert as an UPSERT (update, not duplicate) and its DTO bounds.
 *   6. The status machine's four illegal transitions from both terminal states.
 *   7. Serial provenance, a NULL serial on a REJECTED row, and the public
 *      verification payload as a DISCLOSURE test.
 *   8. `my-requests` for an account with no linked employee (the Finance F24
 *      shape).
 *   9. The four audit actions.
 *  10. R66 — a letter request that OUTLIVES its subject: the leaver flag both
 *      list endpoints now carry, and the issue/reject decision saying so.
 *
 * HOUSE CONVENTION (docs/TESTING.md §"Recorded defects"): where the product is
 * wrong, the case asserts what it DOES under a `KNOWN GAP` banner beside an
 * `it.failing` twin naming the intended behaviour — and once the defect is
 * fixed the pair COLLAPSES into one case asserting the correct behaviour,
 * keeping a short account of what the defect was so the case reads as its
 * regression lock. R4, R5 and R66 have collapsed; no `KNOWN GAP` banner remains
 * in this file.
 *
 * SHARED CONFIGURATION: `pdf_enabled` is global. Only LET-API-14 touches it,
 * inside `withSetting` (which restores in a `finally`) and scoped to the single
 * case rather than the describe — `letters-grievance-vault` depends on the real
 * PDF path and must not inherit a flipped flag.
 */
describe('Workplace — Letter Requests (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;
  let short: string;

  /** ISSUED, owned by `fx.employee` (branch A) — the download owner persona. */
  let issuedOwnLetterId: string;
  let issuedOwnSerial: string;
  /** ISSUED, owned by `fx.holderId` — a direct report of `fx.manager`. */
  let issuedReportLetterId: string;
  /** ISSUED, owned by the branch-B employee. Invisible to the scoped HR. */
  let issuedBranchBLetterId: string;
  /** PENDING, owned by the branch-B employee — the issue/reject 404 subject. */
  let pendingBranchBLetterId: string;
  /** REJECTED, owned by `fx.employee` — the other terminal state. */
  let rejectedLetterId: string;

  // ── helpers ───────────────────────────────────────────────────────────────

  const requestLetter = (
    token: string,
    body: Record<string, unknown>,
    employeeId?: string,
  ) =>
    ctx
      .http()
      .post(employeeId ? `/letters?employeeId=${employeeId}` : '/letters')
      .set(bearer(token))
      .send(body);

  const issueLetter = (token: string, id: string) =>
    ctx.http().post(`/letters/${id}/issue`).set(bearer(token)).send();

  const rejectLetter = (
    token: string,
    id: string,
    body: Record<string, unknown>,
  ) => ctx.http().post(`/letters/${id}/reject`).set(bearer(token)).send(body);

  const upsertTemplate = (token: string, body: Record<string, unknown>) =>
    ctx.http().put('/letters/templates').set(bearer(token)).send(body);

  const download = (token: string | null, id: string) => {
    const r = ctx.http().get(`/secure-files/letter/${id}`);
    return token ? r.set(bearer(token)) : r;
  };

  /** Raise a PENDING request against the approval template and return its id. */
  async function pending(
    marker: string,
    employeeId?: string,
  ): Promise<string> {
    const res = employeeId
      ? await requestLetter(
          fx.admin.token,
          { templateKey: fx.tplApprovalKey, purpose: marker },
          employeeId,
        )
      : await requestLetter(fx.employee.token, {
          templateKey: fx.tplApprovalKey,
          purpose: marker,
        });
    if (res.status !== 201) {
      throw new Error(
        `pending(${marker}) failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body.data.id as string;
  }

  const auditRows = (action: string, resourceId: string) =>
    ctx.prisma.auditLog.findMany({
      where: { action, resourceId },
      orderBy: { createdAt: 'desc' },
    });

  // ── setup ─────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    ctx = await bootE2EApp();
    // The serial generator reads a Postgres sequence directly; `db push` does
    // not create sequences, so a fresh template DB can lack it.
    await ctx.prisma
      .$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "letter_serial_seq" START 1`)
      .catch(() => undefined);

    fx = await setupWorkplaceFixtures(ctx);
    short = fx.runId.slice(-8);

    // Three real issues up front, reused by the status-machine, download,
    // serial, verification and audit describes so the suite renders as few
    // PDFs as the assertions actually need.
    issuedOwnLetterId = await pending('own letter');
    const issuedOwn = await issueLetter(fx.admin.token, issuedOwnLetterId);
    if (issuedOwn.status !== 201) {
      throw new Error(
        `fixture issue failed: ${issuedOwn.status} ${JSON.stringify(issuedOwn.body)}`,
      );
    }
    issuedOwnSerial = issuedOwn.body.data.serialNumber;

    issuedReportLetterId = await pending('direct report letter', fx.holderId);
    await issueLetter(fx.admin.token, issuedReportLetterId);

    issuedBranchBLetterId = await pending(
      'branch B issued',
      fx.branchBEmployeeId,
    );
    await issueLetter(fx.admin.token, issuedBranchBLetterId);

    pendingBranchBLetterId = await pending(
      'branch B pending',
      fx.branchBEmployeeId,
    );

    rejectedLetterId = await pending('terminal rejected');
    await rejectLetter(fx.admin.token, rejectedLetterId, {
      reason: 'terminal state fixture',
    });
  });

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Template upsert — it is an UPSERT, and it has bounds
  // ══════════════════════════════════════════════════════════════════════════

  describe('template upsert', () => {
    const bodyHtml = '<html><body><h1>{{employeeName}}</h1></body></html>';

    it('LET-API-01 ADMIN creates a template on a new key+locale', async () => {
      const key = `UPS-${short}`;
      const res = await upsertTemplate(fx.admin.token, {
        key,
        name: 'Upsert Probe',
        locale: 'en',
        bodyHtml,
        requiresApproval: true,
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        key,
        locale: 'en',
        name: 'Upsert Probe',
        requiresApproval: true,
        isActive: true,
      });

      const rows = await ctx.prisma.letterTemplate.findMany({ where: { key } });
      expect(rows).toHaveLength(1);
    });

    it('LET-API-02 upserting the SAME key+locale updates the row rather than duplicating it', async () => {
      const key = `UPS2-${short}`;
      const first = await upsertTemplate(fx.admin.token, {
        key,
        name: 'First Name',
        locale: 'en',
        bodyHtml,
      });
      expect(first.status).toBe(200);

      const second = await upsertTemplate(fx.admin.token, {
        key,
        name: 'Second Name',
        locale: 'en',
        bodyHtml: '<html><body>rewritten</body></html>',
      });
      expect(second.status).toBe(200);

      // Same row, not a second one — the @@unique([key, locale]) pair is what
      // the upsert targets.
      expect(second.body.data.id).toBe(first.body.data.id);
      const rows = await ctx.prisma.letterTemplate.findMany({ where: { key } });
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Second Name');
      expect(rows[0].bodyHtml).toBe('<html><body>rewritten</body></html>');
    });

    it('LET-API-03 flipping requiresApproval true→false changes the behaviour of the NEXT request', async () => {
      const key = `TOG-${short}`;
      await upsertTemplate(fx.admin.token, {
        key,
        name: 'Toggle Probe',
        locale: 'en',
        bodyHtml,
        requiresApproval: true,
      });

      const beforeToggle = await requestLetter(fx.employee.token, {
        templateKey: key,
        purpose: 'before toggle',
      });
      expect(beforeToggle.status).toBe(201);
      expect(beforeToggle.body.data.status).toBe('PENDING');
      expect(beforeToggle.body.data.serialNumber).toBeNull();

      await upsertTemplate(fx.admin.token, {
        key,
        name: 'Toggle Probe',
        locale: 'en',
        bodyHtml,
        requiresApproval: false,
      });

      const afterToggle = await requestLetter(fx.employee.token, {
        templateKey: key,
        purpose: 'after toggle',
      });
      expect(afterToggle.status).toBe(201);
      // request() collapsed into issue() inline — no HR step happened.
      expect(afterToggle.body.data.status).toBe('ISSUED');
      expect(afterToggle.body.data.serialNumber).toEqual(expect.any(String));
      expect(afterToggle.body.message).toBe('Letter issued.');
    });

    it('LET-API-04 bodyHtml is required — a template without one is refused', async () => {
      const res = await upsertTemplate(fx.admin.token, {
        key: `NOBODY-${short}`,
        name: 'No Body',
        locale: 'en',
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toMatch(/bodyHtml/);
      expect(
        await ctx.prisma.letterTemplate.count({
          where: { key: `NOBODY-${short}` },
        }),
      ).toBe(0);
    });

    it('LET-API-05 a key longer than 50 characters is refused', async () => {
      const res = await upsertTemplate(fx.admin.token, {
        key: 'K'.repeat(51),
        name: 'Too Long Key',
        locale: 'en',
        bodyHtml,
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toMatch(/key/);
    });

    it('LET-API-06 a name longer than 200 characters is refused', async () => {
      const res = await upsertTemplate(fx.admin.token, {
        key: `LONGNAME-${short}`,
        name: 'N'.repeat(201),
        locale: 'en',
        bodyHtml,
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toMatch(/name/);
      expect(
        await ctx.prisma.letterTemplate.count({
          where: { key: `LONGNAME-${short}` },
        }),
      ).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. R5 (FIXED) — the reject reason nothing used to validate
  // ══════════════════════════════════════════════════════════════════════════

  describe('reject reason (plan finding R5 — fixed)', () => {
    it('LET-API-07 a real reason is stored verbatim and returned', async () => {
      const id = await pending('reason control');
      const res = await rejectLetter(fx.admin.token, id, {
        reason: 'Salary data cannot be released to this addressee.',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('REJECTED');
      expect(res.body.data.rejectedReason).toBe(
        'Salary data cannot be released to this addressee.',
      );

      const row = await ctx.prisma.letterRequest.findUnique({ where: { id } });
      expect(row!.rejectedReason).toBe(
        'Salary data cannot be released to this addressee.',
      );
    });

    /**
     * REGRESSION LOCK (R5, fixed) — `LettersController.reject` used to bind
     * `@Body('reason') reason: string`. The global ValidationPipe only runs
     * when the parameter's metatype is a CLASS, so a primitive binding is
     * unvalidated by construction: an absent reason fell through to the
     * controller's own `reason ?? 'No reason given'` literal, and the employee
     * was notified that their letter had been refused for a reason nobody had
     * given.
     *
     * The route now takes `RejectLetterDto` — `@IsString() @MinLength(5)`,
     * matching what a department change request already demands of its
     * `reviewNote` (`departments/dto/review-change-request.dto.ts`). The reason
     * is the only explanation the employee ever gets, so it is required.
     */
    it('LET-API-08 an ABSENT reason is refused (400) and the request is left PENDING', async () => {
      const id = await pending('reason absent');
      const res = await rejectLetter(fx.admin.token, id, {});

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toMatch(/reason/i);

      // The refusal did not half-apply: the request is still settleable.
      const row = await ctx.prisma.letterRequest.findUnique({ where: { id } });
      expect(row!.status).toBe('PENDING');
      expect(row!.rejectedReason).toBeNull();
    });

    /**
     * REGRESSION LOCK (R5, fixed) — the second half, and the reason the fix is
     * a DTO rather than a longer fallback expression. `??` is NULLISH
     * coalescing, so `''` and `'   '` both survived it — they are not nullish,
     * so the fallback never fired and the value went to `rejected_reason`
     * exactly as sent, then straight out as the entire body of the employee's
     * rejection notification.
     *
     * The DTO trims BEFORE validating, so whitespace cannot buy its way past
     * the minimum length.
     */
    it('LET-API-09 an EMPTY and a WHITESPACE-ONLY reason are both refused (400), and neither request is touched', async () => {
      const emptyId = await pending('reason empty');
      const emptyRes = await rejectLetter(fx.admin.token, emptyId, {
        reason: '',
      });
      expect(emptyRes.status).toBe(400);
      expect(JSON.stringify(emptyRes.body.message)).toMatch(/reason/i);

      const blankId = await pending('reason whitespace');
      const blankRes = await rejectLetter(fx.admin.token, blankId, {
        reason: '   ',
      });
      expect(blankRes.status).toBe(400);
      expect(JSON.stringify(blankRes.body.message)).toMatch(/reason/i);

      const rows = await ctx.prisma.letterRequest.findMany({
        where: { id: { in: [emptyId, blankId] } },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status)).toEqual(['PENDING', 'PENDING']);
      expect(rows.map((r) => r.rejectedReason)).toEqual([null, null]);
    });

    /**
     * The floor is a floor, not a formality: four characters is refused and
     * five is taken, so the minimum is enforced at exactly the boundary the DTO
     * declares rather than by an incidental truthiness check.
     */
    it('LET-API-09b the 5-character floor is enforced at the boundary — 4 refused, 5 accepted', async () => {
      const shortId = await pending('reason too short');
      const tooShort = await rejectLetter(fx.admin.token, shortId, {
        reason: 'nope',
      });
      expect(tooShort.status).toBe(400);

      const okId = await pending('reason just long enough');
      const accepted = await rejectLetter(fx.admin.token, okId, {
        reason: '  stale  ',
      });
      expect(accepted.status).toBe(201);
      // Trimmed on the way in, so what is stored is what will be read back —
      // and 'stale' is exactly five, so the trim happens BEFORE the check.
      expect(accepted.body.data.rejectedReason).toBe('stale');

      const row = await ctx.prisma.letterRequest.findUnique({
        where: { id: okId },
      });
      expect(row!.rejectedReason).toBe('stale');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. R4 (FIXED) — auto-issue was not atomic
  // ══════════════════════════════════════════════════════════════════════════

  describe('auto-issue (plan finding R4 — fixed)', () => {
    let autoIssued: any;

    beforeAll(async () => {
      const res = await requestLetter(fx.employee.token, {
        templateKey: fx.tplAutoIssueKey,
        purpose: 'auto issue control',
      });
      expect(res.status).toBe(201);
      autoIssued = res.body;
    });

    it('LET-API-12 a requiresApproval:false template issues inside request(), leaving no PENDING row', async () => {
      expect(autoIssued.data.status).toBe('ISSUED');
      expect(autoIssued.data.serialNumber).toEqual(expect.any(String));
      expect(autoIssued.data.issuedAt).toEqual(expect.any(String));

      const stillPending = await ctx.prisma.letterRequest.findMany({
        where: {
          templateKey: fx.tplAutoIssueKey,
          purpose: 'auto issue control',
          status: 'PENDING',
        },
      });
      expect(stillPending).toHaveLength(0);
    });

    it('LET-API-13 the auto-issue response is the ISSUED row, not the PENDING one it was created as', async () => {
      // request() returns `this.issue(...)` directly, so the caller never sees
      // the intermediate PENDING row it created a moment earlier.
      expect(autoIssued.message).toBe('Letter issued.');
      expect(autoIssued.data.issuedById).toBe(fx.employee.userId);
      const row = await ctx.prisma.letterRequest.findUnique({
        where: { id: autoIssued.data.id },
      });
      expect(row!.status).toBe('ISSUED');
      expect(row!.documentId).toEqual(expect.any(String));
    });

    /**
     * REGRESSION LOCK (R4, fixed) — THE FINDING THIS PHASE EXISTS FOR.
     *
     * `LettersService.request()` used to do this, in this order, with NOTHING
     * around it:
     *
     *     const request = await prisma.letterRequest.create({ status: 'PENDING' })
     *     await audit.log('LETTER_REQUESTED')
     *     if (!template.requiresApproval) return this.issue(request.id, user)
     *
     * `issue()` throws BadRequest when `pdf.isAvailable()` is false — which it
     * is whenever `pdf_enabled` is off or Chromium is missing from the image.
     * The caller got a 400 and believed nothing had happened, while the PENDING
     * row stayed behind against a `requiresApproval:false` template — one with
     * no HR queue behind it, so nobody would ever come back to it and the
     * employee's `my-requests` showed a letter stuck PENDING for ever. Beside
     * it sat a `LETTER_REQUESTED` audit row claiming a request the API denied.
     *
     * The fix could not be a transaction spanning the two: `issue()` renders a
     * PDF and uploads it to object storage, seconds of I/O that must not be
     * held inside a database transaction and that a rollback could not take
     * back. `request()` compensates instead — a failed inline issue deletes the
     * row and its audit row before rethrowing — and `issue()`'s own two
     * database writes (the vault document and the ISSUED update) were moved
     * into one transaction that opens only after all I/O is done.
     *
     * `pdf_enabled` is global and shared with every other suite, so it is
     * flipped inside `withSetting` — which restores the previous value in a
     * `finally` even when the assertions below fail — and only for the width of
     * this one case.
     */
    it('LET-API-14 when issue() fails inside request(), the 400 leaves NO row and NO audit row behind', async () => {
      const marker = `R4 orphan probe ${short}`;
      const before = new Date();

      const res = await withSetting(ctx, 'pdf_enabled', 'false', async () =>
        requestLetter(
          fx.admin.token,
          { templateKey: fx.tplAutoIssueKey, purpose: marker },
          fx.managedEmployeeId,
        ),
      );

      // The caller is told the request failed...
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/PDF generation is unavailable/i);

      // ...and nothing survives to contradict that. No orphan against a
      // template that has no approval step behind it.
      const orphans = await ctx.prisma.letterRequest.findMany({
        where: { employeeId: fx.managedEmployeeId, purpose: marker },
      });
      expect(orphans).toHaveLength(0);

      // And no audit row claiming a letter was requested. Asserted as the
      // invariant rather than by id — the row the compensation deleted has no
      // id left to look up — and scoped to rows written since this case
      // started, so a neighbouring suite's legitimate request cannot fail it:
      // every LETTER_REQUESTED written in that window still resolves to a real
      // LetterRequest.
      const written = await ctx.prisma.auditLog.findMany({
        where: {
          action: 'LETTER_REQUESTED',
          resourceType: 'LetterRequest',
          createdAt: { gte: before },
        },
        select: { resourceId: true },
      });
      const resolved = await ctx.prisma.letterRequest.findMany({
        where: {
          id: { in: written.map((r) => r.resourceId!).filter(Boolean) },
        },
        select: { id: true },
      });
      expect(written.map((r) => r.resourceId).sort()).toEqual(
        resolved.map((r) => r.id).sort(),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Status machine — both terminal states, all four illegal edges
  // ══════════════════════════════════════════════════════════════════════════

  describe('status machine', () => {
    it('LET-API-15 issuing an ISSUED request is refused with the exact message', async () => {
      const res = await issueLetter(fx.admin.token, issuedOwnLetterId);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('This letter has already been issued');
    });

    it('LET-API-16 rejecting an ISSUED request is refused with the exact message', async () => {
      const res = await rejectLetter(fx.admin.token, issuedOwnLetterId, {
        reason: 'too late',
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Only a pending request can be rejected');

      // The refusal did not half-apply: the row is untouched.
      const row = await ctx.prisma.letterRequest.findUnique({
        where: { id: issuedOwnLetterId },
      });
      expect(row!.status).toBe('ISSUED');
      expect(row!.rejectedReason).toBeNull();
    });

    /**
     * RECORDED INTENT (R14) — `issue()` resolves the template by
     * `key_locale` with NO `isActive` filter, while `request()` refuses an
     * inactive template outright ("No active … template for locale …").
     *
     * The asymmetry is arguably correct: a request raised while the template
     * was live is a promise already made to the employee, and retiring the
     * wording should not strand the queue behind it. But it was neither
     * asserted nor written down anywhere, so a future `isActive` filter added
     * to `issue()` "for consistency" would silently break every in-flight
     * request the moment HR retires a template.
     *
     * This case is the record. There is no `it.failing` twin because today's
     * behaviour is the intended one — the pin here is against a REGRESSION,
     * not against a defect.
     */
    it('LET-API-17 R14: a request raised while the template was active can still be issued after it is deactivated', async () => {
      const key = `MIDFLIGHT-${short}`;
      await upsertTemplate(fx.admin.token, {
        key,
        name: 'Mid-flight Probe',
        locale: 'en',
        bodyHtml: '<html><body><p>{{employeeName}} {{serialNumber}}</p></body></html>',
        requiresApproval: true,
        isActive: true,
      });

      const raised = await requestLetter(fx.employee.token, {
        templateKey: key,
        purpose: 'raised while active',
      });
      expect(raised.status).toBe(201);
      const id = raised.body.data.id as string;

      // HR retires the wording while the request is still in the queue.
      await upsertTemplate(fx.admin.token, {
        key,
        name: 'Mid-flight Probe',
        locale: 'en',
        bodyHtml: '<html><body><p>{{employeeName}} {{serialNumber}}</p></body></html>',
        isActive: false,
      });

      // request() now refuses the same template...
      const blocked = await requestLetter(fx.employee.token, {
        templateKey: key,
        purpose: 'raised after deactivation',
      });
      expect(blocked.status).toBe(404);
      expect(String(blocked.body.message)).toMatch(/No active/);

      // ...but issue() never looks at isActive, so the in-flight request still
      // completes. THIS IS THE INTENT, recorded.
      const issued = await issueLetter(fx.admin.token, id);
      expect(issued.status).toBe(201);
      expect(issued.body.data.status).toBe('ISSUED');
      expect(issued.body.data.serialNumber).toEqual(expect.any(String));
    });

    it('LET-API-18 issuing a REJECTED request is refused with the exact message', async () => {
      const res = await issueLetter(fx.admin.token, rejectedLetterId);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('This request was rejected');
    });

    it('LET-API-19 rejecting a REJECTED request is refused with the exact message', async () => {
      const res = await rejectLetter(fx.admin.token, rejectedLetterId, {
        reason: 'again',
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Only a pending request can be rejected');

      const row = await ctx.prisma.letterRequest.findUnique({
        where: { id: rejectedLetterId },
      });
      // The original reason survived the second attempt.
      expect(row!.rejectedReason).toBe('terminal state fixture');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Branch scoping — LetterRequest is 'relation'-scoped AND the service
  //    calls assertInBranch in request / issue / reject / fileFor
  // ══════════════════════════════════════════════════════════════════════════

  describe('branch scoping (branch-A scoped HR against a branch-B employee)', () => {
    /**
     * NOTE ON THE EXPECTED CODE: `assertInBranch` throws `NotFoundException`,
     * not `ForbiddenException` — deliberately, so a scoped caller cannot use
     * the status code to prove a row in another branch exists. The plan's role
     * matrix (§6.1) says "in-branch"; the code says 404, and 404 is what these
     * cases assert.
     */

    it('LET-API-20 GET /letters hides a branch-B request from the branch-A scoped HR', async () => {
      const res = await ctx
        .http()
        .get('/letters')
        .set(bearer(fx.scopedHr.token));

      expect(res.status).toBe(200);
      const ids: string[] = res.body.data.map((r: any) => r.id);
      expect(ids).not.toContain(issuedBranchBLetterId);
      expect(ids).not.toContain(pendingBranchBLetterId);
      // Control: the same list DOES carry the branch-A rows, so the exclusion
      // above is scoping rather than an empty response.
      expect(ids).toContain(issuedOwnLetterId);
    });

    it('LET-API-21 the scoped HR cannot request a letter on behalf of a branch-B employee (404)', async () => {
      const res = await requestLetter(
        fx.scopedHr.token,
        { templateKey: fx.tplApprovalKey, purpose: 'cross-branch on behalf' },
        fx.branchBEmployeeId,
      );
      expect(res.status).toBe(404);

      const rows = await ctx.prisma.letterRequest.findMany({
        where: {
          employeeId: fx.branchBEmployeeId,
          purpose: 'cross-branch on behalf',
        },
      });
      expect(rows).toHaveLength(0);
    });

    it('LET-API-22 the scoped HR cannot issue a branch-B request (404)', async () => {
      const res = await issueLetter(fx.scopedHr.token, pendingBranchBLetterId);
      expect(res.status).toBe(404);

      const row = await ctx.prisma.letterRequest.findUnique({
        where: { id: pendingBranchBLetterId },
      });
      expect(row!.status).toBe('PENDING');
    });

    it('LET-API-23 the scoped HR cannot reject a branch-B request (404)', async () => {
      const res = await rejectLetter(
        fx.scopedHr.token,
        pendingBranchBLetterId,
        { reason: 'out of scope' },
      );
      expect(res.status).toBe(404);

      const row = await ctx.prisma.letterRequest.findUnique({
        where: { id: pendingBranchBLetterId },
      });
      expect(row!.status).toBe('PENDING');
      expect(row!.rejectedReason).toBeNull();
    });

    it('LET-API-24 CONTROL: a global ADMIN settles the same branch-B request, so the 404s above were scope and not a broken row', async () => {
      const res = await rejectLetter(fx.admin.token, pendingBranchBLetterId, {
        reason: 'admin reaches every branch',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('REJECTED');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Download authorization — LettersService.fileFor via the secure route
  // ══════════════════════════════════════════════════════════════════════════

  describe('download authorization (/secure-files/letter/:id)', () => {
    it('LET-API-25 the OWNER downloads their own letter', async () => {
      const res = await download(fx.employee.token, issuedOwnLetterId);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('LET-API-26 an ADMIN downloads it', async () => {
      const res = await download(fx.admin.token, issuedOwnLetterId);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    });

    it('LET-API-27 the branch-A scoped HR downloads a branch-A letter', async () => {
      const res = await download(fx.scopedHr.token, issuedOwnLetterId);
      expect(res.status).toBe(200);
    });

    it('LET-API-28 a colleague is refused (403)', async () => {
      const res = await download(fx.projectMember.token, issuedOwnLetterId);
      expect(res.status).toBe(403);
      expect(String(res.body.message)).toMatch(
        /Not permitted to download this letter/,
      );
    });

    /**
     * THE RULE THE SERVICE COMMENT STATES AND NOTHING TESTED:
     * "A manager has no business reading a subordinate's salary certificate."
     *
     * `fx.manager` heads the department `fx.holderId` sits in — a genuine
     * direct report, not a stranger — and is still refused. `fileFor` grants
     * only `isOwner || ADMIN || HR_MANAGER`; MANAGER is nowhere in it, which is
     * the one role that would otherwise look reasonable.
     */
    it('LET-API-29 a MANAGER is refused even for a DIRECT REPORT (403)', async () => {
      // Precondition: the report really is in the department this manager heads.
      const report = await ctx.prisma.employee.findUnique({
        where: { id: fx.holderId },
        select: { departmentId: true },
      });
      expect(report!.departmentId).toBe(fx.managedDeptId);

      const res = await download(fx.manager.token, issuedReportLetterId);
      expect(res.status).toBe(403);
      expect(String(res.body.message)).toMatch(
        /Not permitted to download this letter/,
      );
    });

    it('LET-API-30 an anonymous caller is refused (401)', async () => {
      const res = await download(null, issuedOwnLetterId);
      expect(res.status).toBe(401);
    });

    it('LET-API-31 the branch-A scoped HR downloading a branch-B letter gets 404, not 403 — assertInBranch runs before the owner/HR test', async () => {
      const res = await download(fx.scopedHr.token, issuedBranchBLetterId);
      expect(res.status).toBe(404);
      // Not the Forbidden message: the row was hidden, not refused.
      expect(String(res.body.message)).not.toMatch(
        /Not permitted to download this letter/,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7. Locale — @@unique([key, locale]) means en and ar are two rows
  // ══════════════════════════════════════════════════════════════════════════

  describe('locale', () => {
    let arRequestId: string;
    let arSerial: string;
    let arTemplateName: string;

    beforeAll(async () => {
      const tpl = await ctx.prisma.letterTemplate.findUnique({
        where: {
          key_locale: { key: fx.tplArabicKey, locale: fx.tplArabicLocale },
        },
      });
      arTemplateName = tpl!.name;

      const raised = await requestLetter(fx.employee.token, {
        templateKey: fx.tplArabicKey,
        locale: fx.tplArabicLocale,
        purpose: 'ar round trip',
        addressedTo: 'بنك مسقط',
      });
      expect(raised.status).toBe(201);
      arRequestId = raised.body.data.id;

      const issued = await issueLetter(fx.admin.token, arRequestId);
      expect(issued.status).toBe(201);
      arSerial = issued.body.data.serialNumber;
    });

    it('LET-API-32 the same key in two locales is two distinct template rows', async () => {
      const res = await ctx
        .http()
        .get('/letters/templates')
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);

      const pair = res.body.data.filter(
        (t: any) => t.key === fx.tplApprovalKey,
      );
      expect(pair).toHaveLength(2);
      expect(pair.map((t: any) => t.locale).sort()).toEqual(['ar', 'en']);
      expect(new Set(pair.map((t: any) => t.id)).size).toBe(2);
      // Same key, different wording — the pair is real, not an alias.
      expect(pair[0].bodyHtml).not.toBe(pair[1].bodyHtml);
    });

    it('LET-API-33 an ar request round-trips: PENDING with locale ar, then ISSUED with a serial, and my-requests agrees', async () => {
      const row = await ctx.prisma.letterRequest.findUnique({
        where: { id: arRequestId },
      });
      expect(row!.locale).toBe('ar');
      expect(row!.status).toBe('ISSUED');
      expect(row!.serialNumber).toBe(arSerial);
      expect(row!.addressedTo).toBe('بنك مسقط');

      const mine = await ctx
        .http()
        .get('/letters/my-requests')
        .set(bearer(fx.employee.token));
      expect(mine.status).toBe(200);
      const found = mine.body.data.find((r: any) => r.id === arRequestId);
      expect(found).toBeDefined();
      expect(found.locale).toBe('ar');
      expect(found.serialNumber).toBe(arSerial);
    });

    it('LET-API-34 the ar issue rendered the ar template row, not the en one that shares its key', async () => {
      const row = await ctx.prisma.letterRequest.findUnique({
        where: { id: arRequestId },
      });
      const doc = await ctx.prisma.employeeDocument.findUnique({
        where: { id: row!.documentId! },
      });
      // issue() names the vault document after the template it resolved.
      expect(doc!.description).toBe(arTemplateName);
      expect(doc!.fileName).toContain(arTemplateName);
      expect(doc!.isSystemGenerated).toBe(true);
    });

    it('LET-API-35 an unsupported locale is refused (400)', async () => {
      const res = await requestLetter(fx.employee.token, {
        templateKey: fx.tplApprovalKey,
        locale: 'fr',
        purpose: 'unsupported locale',
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toMatch(/locale/);

      expect(
        await ctx.prisma.letterRequest.count({
          where: { purpose: 'unsupported locale' },
        }),
      ).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. Serials and the public verification payload
  // ══════════════════════════════════════════════════════════════════════════

  describe('serials and verification', () => {
    it('LET-API-36 the serial is `{PREFIX}-{YEAR}-{00000}` and is drawn from the letter_serial_seq sequence', async () => {
      const id = await pending('serial provenance');
      const issued = await issueLetter(fx.admin.token, id);
      expect(issued.status).toBe(201);

      const serial: string = issued.body.data.serialNumber;
      const prefix = fx.tplApprovalKey
        .split('_')[0]
        .slice(0, 6)
        .toUpperCase();
      const year = new Date().getFullYear();

      expect(serial).toMatch(
        new RegExp(`^${prefix}-${year}-\\d{5,}$`),
      );

      // Provenance: the next value the sequence hands out is exactly one past
      // the number printed on the letter. A MAX()+1 scheme could not promise
      // that, which is why the service uses a sequence.
      const tail = Number(serial.split('-').pop());
      const rows = await ctx.prisma.$queryRawUnsafe<
        Array<{ n: bigint }>
      >(`SELECT nextval('letter_serial_seq') AS n`);
      expect(Number(rows[0].n)).toBe(tail + 1);
    });

    it('LET-API-37 a REJECTED request carries a NULL serial — nothing was minted for it', async () => {
      const row = await ctx.prisma.letterRequest.findUnique({
        where: { id: rejectedLetterId },
      });
      expect(row!.status).toBe('REJECTED');
      expect(row!.serialNumber).toBeNull();
      expect(row!.fileRef).toBeNull();
      expect(row!.documentId).toBeNull();
      expect(row!.issuedAt).toBeNull();

      const list = await ctx
        .http()
        .get('/letters?status=REJECTED')
        .set(bearer(fx.admin.token));
      expect(list.status).toBe(200);
      const found = list.body.data.find((r: any) => r.id === rejectedLetterId);
      expect(found.serialNumber).toBeNull();
    });

    /**
     * A DISCLOSURE TEST, not a shape test. `/letters/verify/:serial` is
     * `@Public()` — a bank clerk checking a salary certificate has no account
     * here. The whole reason the PDF is stored in the private bucket is undone
     * if the unauthenticated verification hands back who the letter is about or
     * what it says.
     */
    it('LET-API-38 verifying an ISSUED serial discloses ONLY {valid, serialNumber, letterType, issuedAt} — no name, no salary', async () => {
      const employee = await ctx.prisma.employee.findUnique({
        where: { id: fx.employee.employeeId! },
        select: { fullName: true, employeeCode: true, baseSalary: true },
      });

      const res = await ctx.http().get(`/letters/verify/${issuedOwnSerial}`);
      expect(res.status).toBe(200);

      expect(Object.keys(res.body.data).sort()).toEqual([
        'issuedAt',
        'letterType',
        'serialNumber',
        'valid',
      ]);
      expect(res.body.data.valid).toBe(true);
      expect(res.body.data.serialNumber).toBe(issuedOwnSerial);
      expect(res.body.data.letterType).toBe(fx.tplApprovalKey);

      // Nothing about the person, and nothing about their pay, anywhere in the
      // response — including the envelope around `data`.
      const wire = JSON.stringify(res.body);
      expect(wire).not.toContain(employee!.fullName);
      expect(wire).not.toContain(employee!.employeeCode);
      expect(wire).not.toContain(String(Number(employee!.baseSalary)));
      expect(wire).not.toMatch(/purpose|addressedTo|fileRef|employeeId/i);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 9. my-requests for an account with no linked employee (Finance F24 shape)
  // ══════════════════════════════════════════════════════════════════════════

  describe('my-requests', () => {
    /**
     * The exact bug that shipped in Finance (docs/TESTING.md, defect F24):
     * `my-requests` for an account with no `employeeId` fell through to an
     * unfiltered query and returned the WHOLE COMPANY's requests as "mine".
     * The letters controller short-circuits to an empty list instead — this
     * case is what keeps it that way.
     */
    it('LET-API-39 an account with NO linked employee record gets an empty list, not the whole company', async () => {
      // Precondition: this ADMIN genuinely has no employee row...
      const adminUser = await ctx.prisma.user.findUnique({
        where: { id: fx.admin.userId },
        select: { employeeId: true },
      });
      expect(adminUser!.employeeId).toBeNull();

      // ...and there ARE requests in the system for it to have leaked.
      const all = await ctx
        .http()
        .get('/letters')
        .set(bearer(fx.admin.token));
      expect(all.status).toBe(200);
      expect(all.body.data.length).toBeGreaterThan(0);

      const mine = await ctx
        .http()
        .get('/letters/my-requests')
        .set(bearer(fx.admin.token));
      expect(mine.status).toBe(200);
      expect(mine.body.data).toEqual([]);
    });

    it('LET-API-40 a letter HR raised ON BEHALF of an employee appears in that employee\'s my-requests', async () => {
      const res = await requestLetter(
        fx.scopedHr.token,
        { templateKey: fx.tplApprovalKey, purpose: 'raised by HR on behalf' },
        fx.employee.employeeId,
      );
      expect(res.status).toBe(201);
      const id = res.body.data.id as string;

      const mine = await ctx
        .http()
        .get('/letters/my-requests')
        .set(bearer(fx.employee.token));
      expect(mine.status).toBe(200);
      const found = mine.body.data.find((r: any) => r.id === id);
      expect(found).toBeDefined();
      expect(found.purpose).toBe('raised by HR on behalf');
      // And still only their own — nobody else's request came with it.
      const foreign = mine.body.data.filter(
        (r: any) => r.employeeId !== fx.employee.employeeId,
      );
      expect(foreign).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 10. Audit rows
  // ══════════════════════════════════════════════════════════════════════════

  describe('audit trail', () => {
    it('LET-API-41 LETTER_TEMPLATE_UPSERT records the actor and the key+locale pair', async () => {
      const key = `AUD-${short}`;
      const res = await upsertTemplate(fx.admin.token, {
        key,
        name: 'Audit Probe',
        locale: 'ar',
        bodyHtml: '<html><body>audit</body></html>',
      });
      expect(res.status).toBe(200);

      const rows = await auditRows(
        'LETTER_TEMPLATE_UPSERT',
        res.body.data.id,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(fx.admin.userId);
      expect(rows[0].resourceType).toBe('LetterTemplate');
      expect(rows[0].newData).toEqual({ key, locale: 'ar' });
    });

    it('LET-API-42 LETTER_REQUESTED records the requester, the template and the branch', async () => {
      const id = await pending('audit requested');
      const rows = await auditRows('LETTER_REQUESTED', id);

      expect(rows).toHaveLength(1);
      // Raised on behalf by nobody — `pending()` without an employeeId posts as
      // the employee themselves.
      expect(rows[0].userId).toBe(fx.employee.userId);
      expect(rows[0].resourceType).toBe('LetterRequest');
      expect(rows[0].newData).toEqual({
        templateKey: fx.tplApprovalKey,
        locale: 'en',
      });
      expect(rows[0].branchId).toBe(fx.branchA);
    });

    it('LET-API-43 LETTER_ISSUED records the serial and the issuing actor', async () => {
      const rows = await auditRows('LETTER_ISSUED', issuedOwnLetterId);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(fx.admin.userId);
      // The subject's status at issue time rides along (R66) — here an
      // ordinary ACTIVE employee, which is the control for LET-API-47.
      expect(rows[0].newData).toEqual({
        serialNumber: issuedOwnSerial,
        templateKey: fx.tplApprovalKey,
        employeeStatus: 'ACTIVE',
        isFormerEmployee: false,
      });
      expect(rows[0].branchId).toBe(fx.branchA);
    });

    it('LET-API-44 LETTER_REJECTED records the reason that was actually stored', async () => {
      const rows = await auditRows('LETTER_REJECTED', rejectedLetterId);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(fx.admin.userId);
      expect(rows[0].newData).toEqual({
        reason: 'terminal state fixture',
        employeeStatus: 'ACTIVE',
        isFormerEmployee: false,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 11. R66 — the request that outlives its subject
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * R66 (COLLAPSED — the pin and its twin are this describe).
   *
   * WHAT THE DEFECT WAS. `LetterRequest.employeeId` is `onDelete: Cascade`, so
   * the schema's answer to "what happens to an open request when the person
   * leaves" is "it disappears". But a termination is not a delete — it writes
   * `Employee.status = 'INACTIVE'` — so the cascade never fired and the request
   * stayed exactly where it was: PENDING, in `GET /letters?status=PENDING`,
   * which is what the queue screen defaults to. It could still be ISSUED,
   * because nothing in the letters module read `Employee.status` at request or
   * at issue time, so a salary certificate stating pay that is no longer paid
   * was minted for a leaver and filed in their vault. The two offboarding
   * routes therefore left HR's queue in two different states — the hard delete
   * DOES cascade the row away (`XM-API-16c` holds that contrast).
   *
   * WHAT WAS DECIDED. Allow the issue, flag the leaver. Issuing after an exit
   * is legitimate — an experience or service letter is most often asked for
   * precisely then — so nothing is blocked and nothing is auto-cancelled. What
   * was wrong is that HR could not TELL. So both list endpoints carry the
   * subject's status and a derived `employee.isFormerEmployee`, and the audit
   * row for the decision records what the subject was at the moment it was
   * taken. `Employee.status` gates nothing anywhere: LET-API-47 is the case
   * that would go red if anyone ever turned the flag into a refusal.
   *
   * `status !== 'ACTIVE'` is the predicate, not the string `TERMINATED` (R72:
   * all three exits write `INACTIVE`, and `TERMINATED` is a CONTRACT status).
   */
  describe('a former employee\'s request', () => {
    /** PENDING, owned by the INACTIVE `fx.leaverId`. */
    let leaverPendingId: string;

    beforeAll(async () => {
      // Precondition: the fixture leaver really is off the books, and by the
      // value all three exits write.
      const leaver = await ctx.prisma.employee.findUniqueOrThrow({
        where: { id: fx.leaverId },
        select: { status: true },
      });
      expect(leaver.status).toBe('INACTIVE');

      leaverPendingId = await pending('leaver still needs it', fx.leaverId);
    });

    it('LET-API-45 the HR queue marks the leaver\'s row and leaves an active colleague\'s alone', async () => {
      // One read of the queue HR actually looks at — its default filter — with
      // both populations in it, because a flag that is always true and a flag
      // that is always false look identical in a single-row assertion.
      const queue = await ctx
        .http()
        .get('/letters?status=PENDING')
        .set(bearer(fx.admin.token));
      expect(queue.status).toBe(200);

      const rows = queue.body.data as any[];
      const leaverRow = rows.find((r) => r.id === leaverPendingId);
      expect(leaverRow).toBeDefined();
      // Beside the name that was already projected, not instead of it.
      expect(leaverRow.employee.fullName).toEqual(expect.any(String));
      expect(leaverRow.employee.employeeCode).toEqual(expect.any(String));
      expect(leaverRow.employee.status).toBe('INACTIVE');
      expect(leaverRow.employee.isFormerEmployee).toBe(true);

      // Still PENDING and still in the queue: the decision was to flag it, not
      // to hide it or cancel it.
      expect(leaverRow.status).toBe('PENDING');

      const activeId = await pending('active colleague');
      const again = await ctx
        .http()
        .get('/letters?status=PENDING')
        .set(bearer(fx.admin.token));
      const activeRow = (again.body.data as any[]).find((r) => r.id === activeId);
      expect(activeRow.employee.status).toBe('ACTIVE');
      expect(activeRow.employee.isFormerEmployee).toBe(false);
    });

    it('LET-API-46 my-requests carries the same card, so a leaver chasing their own letter sees the same fact HR does', async () => {
      const before = await ctx
        .http()
        .get('/letters/my-requests')
        .set(bearer(fx.employee.token));
      expect(before.status).toBe(200);
      expect(before.body.data.length).toBeGreaterThan(0);
      expect(before.body.data[0].employee.isFormerEmployee).toBe(false);

      // `my-requests` needs a token, and the fixture leaver has no user
      // account — so the persona is made by taking the ACTIVE employee off the
      // books for the length of this case and putting them back in a `finally`.
      // The token is not re-minted: the flag must come from the row, not from
      // anything baked into the JWT.
      try {
        await ctx.prisma.employee.update({
          where: { id: fx.employee.employeeId! },
          data: { status: 'INACTIVE' },
        });

        const mine = await ctx
          .http()
          .get('/letters/my-requests')
          .set(bearer(fx.employee.token));
        expect(mine.status).toBe(200);
        expect(mine.body.data.length).toBe(before.body.data.length);
        for (const row of mine.body.data as any[]) {
          expect(row.employee.status).toBe('INACTIVE');
          expect(row.employee.isFormerEmployee).toBe(true);
        }
      } finally {
        await ctx.prisma.employee.update({
          where: { id: fx.employee.employeeId! },
          data: { status: 'ACTIVE' },
        });
      }
    });

    it('LET-API-47 the leaver\'s letter is ISSUED — allowed, warned about in the response, and recorded as a decision about a former employee', async () => {
      const issued = await issueLetter(fx.admin.token, leaverPendingId);

      // ALLOWED. The flag is a fact the caller is shown, never a refusal —
      // this expectation is what goes red if anyone turns it into a gate.
      expect(issued.status).toBe(201);
      expect(issued.body.data.status).toBe('ISSUED');
      expect(issued.body.data.serialNumber).toEqual(expect.any(String));

      // SAID AT THE MOMENT OF DECISION. The issuing HR user reads the response,
      // not the audit table, so the fact is in both.
      expect(issued.body.warning).toEqual(expect.any(String));
      expect(issued.body.warning).toContain('no longer an active employee');
      expect(issued.body.warning).toContain('INACTIVE');
      expect(issued.body.message).toBe('Letter issued.');

      // And it files itself in the leaver's vault like any other letter.
      const doc = await ctx.prisma.employeeDocument.findUniqueOrThrow({
        where: { id: issued.body.data.documentId },
      });
      expect(doc.isSystemGenerated).toBe(true);
      expect(doc.employeeId).toBe(fx.leaverId);

      // RECORDED. Months later the trail has to explain itself without the
      // employee row, which by then may have been hard-deleted.
      const rows = await auditRows('LETTER_ISSUED', leaverPendingId);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(fx.admin.userId);
      expect(rows[0].newData).toEqual({
        serialNumber: issued.body.data.serialNumber,
        templateKey: fx.tplApprovalKey,
        employeeStatus: 'INACTIVE',
        isFormerEmployee: true,
      });
    }, 60000);

    it('LET-API-48 rejecting a leaver\'s request records and warns about the same fact', async () => {
      // The other half of the decision, and the one someone is most likely to
      // be asked to justify: refusing an ex-employee their experience letter.
      const id = await pending('leaver to be refused', fx.leaverId);
      const res = await rejectLetter(fx.admin.token, id, {
        reason: 'Superseded by the settlement letter',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('REJECTED');
      expect(res.body.warning).toContain('no longer an active employee');

      const rows = await auditRows('LETTER_REJECTED', id);
      expect(rows).toHaveLength(1);
      expect(rows[0].newData).toEqual({
        reason: 'Superseded by the settlement letter',
        employeeStatus: 'INACTIVE',
        isFormerEmployee: true,
      });
    });
  });
});
