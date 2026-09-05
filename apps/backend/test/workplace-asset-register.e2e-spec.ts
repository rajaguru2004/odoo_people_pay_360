import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';
import { ASSET_STATUSES } from '../src/assets/assets.service';

/**
 * WP-1 — Asset Register, the GAP on top of `asset-register.e2e-spec.ts`.
 *
 * The inherited file (44 cases) already proves the happy paths and the role
 * matrix: CRUD, the status-machine guards, assign/return/acknowledge, MANAGER
 * department scoping, the summary endpoint, cross-branch invisibility. None of
 * that is repeated here. This file is the part that was missing, and it is
 * deliberately weighted towards the edges where a register goes wrong quietly:
 *
 *   1. DTO matrix and boundaries — every `@MaxLength`/`@Min` at n and n+1.
 *   2. Filters, singly and combined, including `unassignedOnly` against the two
 *      statuses that are unassignable but unheld (RETIRED, LOST).
 *   3. Pagination edges — page past the end, empty result shape, order stability.
 *   4. `GET /assets/:id` custody history with three CLOSED periods plus one OPEN.
 *   5. Two parallel assigns of one asset against the partial unique index
 *      `asset_assignments_one_open_per_asset`.
 *   6. Audit rows for all six asset actions (CLEARANCE_OVERRIDDEN is WP-2's).
 *   7. `GET /assets/clearance/reports/outstanding`, which had ZERO coverage.
 *   8. The refusals around `assign()` — non-ACTIVE holder, already-held asset,
 *      an asset whose status is not in `ASSIGNABLE_STATUSES = {AVAILABLE}`.
 *   9. The plan findings — R1/R1b, R3 and R25 now FIXED and locked, R2 and R15
 *      still pinned because both need a Prisma migration.
 *
 * House convention on findings (docs/TESTING.md, "Recorded defects"): where the
 * product is wrong the case asserts what it ACTUALLY does under a `KNOWN GAP`
 * comment naming the finding, and an `it.failing` twin asserts the behaviour we
 * want. The day the product is fixed the twin goes green, jest reports the
 * `it.failing` as a failure, and the pin has to be removed. Nothing is skipped
 * and no product code is bent to make a test pass.
 *
 * ALL FIVE pairs have since COLLAPSED, each into one case that keeps the
 * finding's id and a comment recording what the defect was and that the case is
 * now its regression lock:
 *
 *   R1/R1b  AST-API-31/31b/31c/32  a branch-A asset could be handed to a
 *                                  branch-B employee, and the owning branch was
 *                                  then 404'd out of recording the return.
 *   R3      AST-API-19/19b/19c     deleting a returned asset cascaded its whole
 *                                  custody history away.
 *   R25     AST-API-61/61b         custody actions were filed only under
 *                                  `AssetAssignment`, so nothing was reachable
 *                                  from the asset's own id.
 *   R2      AST-API-06b/06c        `asset_tag` was GLOBALLY unique, so a
 *                                  branch-scoped HR reusing another branch's
 *                                  tag got a 409 about a row they cannot see.
 *   R15     AST-API-09/09b         `AssetItem.status` was free-text VarChar(20)
 *                                  with the DTO as its only gate.
 *
 * The last two needed the schema change the earlier pass declared out of scope:
 * `@@unique([branchId, assetTag])` and `enum AssetStatus`, applied through
 * prisma/migrations/20260818140000_asset_tag_per_branch_and_status_enum,
 * prisma/db-push-preflight.sql (which is what provisions production) and
 * asserted in prisma/e2e-partial-indexes.sql.
 *
 * IDs start at `AST-API-31` because the inherited file numbers up to 30-odd
 * cases in its own sequence; the four findings keep the IDs the plan's §3 table
 * assigned them (`AST-API-31/32`, `-06b`, `-19`, `-09`) so a reader coming from
 * the plan lands on the right case.
 *
 * Isolation: every row is tagged with the fixtures' `runId` and every list
 * assertion is filtered down to this run's own rows — never a bare total. The
 * e2e database is shared, and a case that counts everything is a case that
 * fails when a neighbouring suite is running.
 */
describe('Workplace — Asset Register (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;
  /** Short run tag; `asset_tag` is VarChar(50) and the full runId is long. */
  let short: string;

  const msg = (res: any) => JSON.stringify(res.body?.message ?? res.body);
  const rowsOf = (res: any): any[] =>
    Array.isArray(res.body?.data) ? res.body.data : [];
  const tagsOf = (res: any) => rowsOf(res).map((r: any) => r.assetTag);

  let seq = 0;
  /** Unique, runId-bearing and inside VarChar(50). */
  const tag = (label: string) => `WPL-${label}-${++seq}-${fx.runId}`.slice(0, 50);

  const postAsset = (token: string, payload: Record<string, unknown>) =>
    ctx.http().post('/assets').set(bearer(token)).send(payload);

  const validAsset = (over: Record<string, unknown> = {}) => ({
    assetTag: tag('DTO'),
    category: 'Laptop',
    name: 'WPL DTO probe',
    branchId: fx.branchA,
    ...over,
  });

  const listAssets = (token: string, query: string) =>
    ctx.http().get(`/assets?${query}`).set(bearer(token));

  const assign = (token: string, payload: Record<string, unknown>) =>
    ctx.http().post('/assets/assignments').set(bearer(token)).send(payload);

  const returnAsset = (
    token: string,
    assignmentId: string,
    payload: Record<string, unknown> = {},
  ) =>
    ctx
      .http()
      .post(`/assets/assignments/${assignmentId}/return`)
      .set(bearer(token))
      .send(payload);

  /** Create an asset straight through the API and hand back its id. */
  const makeAsset = async (over: Record<string, unknown> = {}) => {
    const res = await postAsset(fx.admin.token, validAsset(over));
    if (res.status !== 201) {
      throw new Error(`asset setup failed: ${res.status} ${msg(res)}`);
    }
    return res.body.data as { id: string; assetTag: string; status: string };
  };

  const auditRows = (action: string, resourceId: string) =>
    ctx.prisma.auditLog.findMany({ where: { action, resourceId } });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);
    short = fx.runId.slice(-8);
  }, 180000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. DTO matrix and boundaries
  //
  // Layer-0 material by the plan's own §0.1 rule, EXCEPT that these decorators
  // are the only thing standing between free-text and the database: `assetTag`
  // is VarChar(50), `status` is VarChar(20) with no PG enum behind it (R15), and
  // `purchaseCost` is Decimal(12,2). A `@MaxLength` that is one out from the
  // column is a 500 in production, not a 400, so both sides of each edge are
  // asserted against the real column.
  // ══════════════════════════════════════════════════════════════════════════
  describe('DTO matrix and boundaries', () => {
    it('AST-API-33 accepts an assetTag of exactly 50 characters', async () => {
      const fifty = `${fx.runId}-`.padEnd(50, 'x').slice(0, 50);
      expect(fifty).toHaveLength(50);
      const res = await postAsset(
        fx.admin.token,
        validAsset({ assetTag: fifty }),
      );
      expect(res.status).toBe(201);
      expect(res.body.data.assetTag).toBe(fifty);
    });

    it('AST-API-34 refuses an assetTag of 51 characters', async () => {
      const fiftyOne = `${fx.runId}-`.padEnd(51, 'y').slice(0, 51);
      expect(fiftyOne).toHaveLength(51);
      const res = await postAsset(
        fx.admin.token,
        validAsset({ assetTag: fiftyOne }),
      );
      expect(res.status).toBe(400);
      expect(msg(res)).toMatch(/assetTag/i);
    });

    it('AST-API-35 accepts a name of 200 and refuses 201', async () => {
      const ok = await postAsset(
        fx.admin.token,
        validAsset({ name: 'n'.repeat(200) }),
      );
      expect(ok.status).toBe(201);

      const tooLong = await postAsset(
        fx.admin.token,
        validAsset({ name: 'n'.repeat(201) }),
      );
      expect(tooLong.status).toBe(400);
      expect(msg(tooLong)).toMatch(/name/i);
    });

    it('AST-API-36 accepts a category of 100 and refuses 101', async () => {
      const ok = await postAsset(
        fx.admin.token,
        validAsset({ category: 'c'.repeat(100) }),
      );
      expect(ok.status).toBe(201);

      const tooLong = await postAsset(
        fx.admin.token,
        validAsset({ category: 'c'.repeat(101) }),
      );
      expect(tooLong.status).toBe(400);
      expect(msg(tooLong)).toMatch(/category/i);
    });

    it('AST-API-37 accepts a serialNumber of 150 and refuses 151', async () => {
      const ok = await postAsset(
        fx.admin.token,
        validAsset({ serialNumber: 's'.repeat(150) }),
      );
      expect(ok.status).toBe(201);

      const tooLong = await postAsset(
        fx.admin.token,
        validAsset({ serialNumber: 's'.repeat(151) }),
      );
      expect(tooLong.status).toBe(400);
      expect(msg(tooLong)).toMatch(/serialNumber/i);
    });

    it('AST-API-38 accepts purchaseCost 0 and refuses -1', async () => {
      // Zero is a real value — a donated or fully-depreciated asset — so `@Min(0)`
      // has to admit it rather than treating falsy as absent.
      const zero = await postAsset(
        fx.admin.token,
        validAsset({ purchaseCost: 0 }),
      );
      expect(zero.status).toBe(201);
      expect(Number(zero.body.data.purchaseCost)).toBe(0);

      const negative = await postAsset(
        fx.admin.token,
        validAsset({ purchaseCost: -1 }),
      );
      expect(negative.status).toBe(400);
      expect(msg(negative)).toMatch(/purchaseCost/i);
    });

    it('AST-API-39 refuses a malformed purchaseDate or warrantyExpiry as bad input, not as a server fault', async () => {
      // `@IsDateString()` answering 500 rather than 400 is a defect this
      // codebase has already had once (docs/TESTING.md, Phase 2). Asserting the
      // status explicitly is what keeps it from coming back.
      const badPurchase = await postAsset(
        fx.admin.token,
        validAsset({ purchaseDate: 'not-a-date' }),
      );
      expect(badPurchase.status).toBe(400);
      expect(msg(badPurchase)).toMatch(/purchaseDate/i);

      const badWarranty = await postAsset(
        fx.admin.token,
        validAsset({ warrantyExpiry: '2026-13-45' }),
      );
      expect(badWarranty.status).toBe(400);
      expect(msg(badWarranty)).toMatch(/warrantyExpiry/i);
    });

    it('AST-API-40 refuses a non-uuid branchId and a missing branchId', async () => {
      const malformed = await postAsset(
        fx.admin.token,
        validAsset({ branchId: 'not-a-uuid' }),
      );
      expect(malformed.status).toBe(400);
      expect(msg(malformed)).toMatch(/branchId/i);

      const payload = validAsset();
      delete (payload as any).branchId;
      const missing = await postAsset(fx.admin.token, payload);
      expect(missing.status).toBe(400);
      expect(msg(missing)).toMatch(/branchId/i);
    });

    it('AST-API-41 refuses an unknown property (whitelist is forbidNonWhitelisted)', async () => {
      const res = await postAsset(
        fx.admin.token,
        validAsset({ depreciationRate: 12 }),
      );
      expect(res.status).toBe(400);
      expect(msg(res)).toMatch(/depreciationRate/i);
    });

    it('AST-API-42 limit 200 is honoured; limit 201 is accepted and clamped, and meta reports the clamp honestly', async () => {
      // `QueryAssetsDto.limit` carries `@Min(1)` and no `@Max`, so 201 is not a
      // validation error — the service clamps with `Math.min(limit, 200)`.
      // The clamp is worth an assertion in both directions because `meta.limit`
      // is what the client computes its next offset from: had `meta` echoed the
      // requested 201 while `take` used 200, every page after the first would
      // silently skip a row. It reports the value actually applied, so this is
      // an assertion of correct behaviour, not a pin.
      const ok = await listAssets(fx.admin.token, 'limit=200');
      expect(ok.status).toBe(200);
      expect(ok.body.meta.limit).toBe(200);

      const over = await listAssets(fx.admin.token, 'limit=201');
      expect(over.status).toBe(200);
      expect(over.body.meta.limit).toBe(200);
      expect(rowsOf(over).length).toBeLessThanOrEqual(200);
    });

    it('AST-API-43 refuses page 0 and a non-integer page', async () => {
      const zero = await listAssets(fx.admin.token, 'page=0');
      expect(zero.status).toBe(400);
      expect(msg(zero)).toMatch(/page/i);

      const fractional = await listAssets(fx.admin.token, 'page=1.5');
      expect(fractional.status).toBe(400);
      expect(msg(fractional)).toMatch(/page/i);
    });

    it('AST-API-44 refuses a status outside ASSET_STATUSES on create and on the list filter', async () => {
      const created = await postAsset(
        fx.admin.token,
        validAsset({ status: 'BANANA' }),
      );
      expect(created.status).toBe(400);
      expect(msg(created)).toMatch(/status/i);

      const filtered = await listAssets(fx.admin.token, 'status=BANANA');
      expect(filtered.status).toBe(400);
      expect(msg(filtered)).toMatch(/status/i);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2 + 3. Filters and pagination
  //
  // One fleet, five assets, sharing a category value nothing else in the
  // database can collide with — so every assertion below is exact rather than
  // "at least contains", even with sibling suites writing to the same database.
  // ══════════════════════════════════════════════════════════════════════════
  describe('filters and pagination', () => {
    let fleetCategory: string;
    let serialAlpha: string;
    let f1: any; // branch A, AVAILABLE, the searchable serial
    let f2: any; // branch A, RETIRED
    let f3: any; // branch A, LOST
    let f4: any; // branch A, IN_REPAIR
    let f5: any; // branch B, AVAILABLE

    beforeAll(async () => {
      fleetCategory = `WPLFILT-${short}`;
      serialAlpha = `SNFILT-${short}-ALPHA`;

      f1 = await makeAsset({
        assetTag: tag('FLT-A'),
        category: fleetCategory,
        serialNumber: serialAlpha,
        name: 'Fleet Alpha',
      });
      f2 = await makeAsset({
        assetTag: tag('FLT-B'),
        category: fleetCategory,
        status: 'RETIRED',
        name: 'Fleet Bravo',
      });
      f3 = await makeAsset({
        assetTag: tag('FLT-C'),
        category: fleetCategory,
        status: 'LOST',
        name: 'Fleet Charlie',
      });
      f4 = await makeAsset({
        assetTag: tag('FLT-D'),
        category: fleetCategory,
        status: 'IN_REPAIR',
        name: 'Fleet Delta',
      });
      f5 = await makeAsset({
        assetTag: tag('FLT-E'),
        category: fleetCategory,
        branchId: fx.branchB,
        name: 'Fleet Echo',
      });
    });

    it('AST-API-45 category filter matches exactly, and nothing else', async () => {
      const res = await listAssets(
        fx.admin.token,
        `category=${encodeURIComponent(fleetCategory)}&limit=50`,
      );
      expect(res.status).toBe(200);
      expect(tagsOf(res).sort()).toEqual(
        [f1, f2, f3, f4, f5].map((a) => a.assetTag).sort(),
      );
      expect(res.body.meta.total).toBe(5);
    });

    it('AST-API-46 branchId filter narrows to that branch', async () => {
      const res = await listAssets(
        fx.admin.token,
        `category=${encodeURIComponent(fleetCategory)}&branchId=${fx.branchB}`,
      );
      expect(res.status).toBe(200);
      expect(tagsOf(res)).toEqual([f5.assetTag]);
    });

    it('AST-API-47 status filter returns only that status', async () => {
      const retired = await listAssets(
        fx.admin.token,
        `category=${encodeURIComponent(fleetCategory)}&status=RETIRED`,
      );
      expect(retired.status).toBe(200);
      expect(tagsOf(retired)).toEqual([f2.assetTag]);

      const repair = await listAssets(
        fx.admin.token,
        `category=${encodeURIComponent(fleetCategory)}&status=IN_REPAIR`,
      );
      expect(tagsOf(repair)).toEqual([f4.assetTag]);
    });

    it('AST-API-48 search matches the serial number, case-insensitively', async () => {
      const exact = await listAssets(
        fx.admin.token,
        `search=${encodeURIComponent(serialAlpha)}`,
      );
      expect(exact.status).toBe(200);
      expect(tagsOf(exact)).toEqual([f1.assetTag]);

      const lowered = await listAssets(
        fx.admin.token,
        `search=${encodeURIComponent(serialAlpha.toLowerCase())}`,
      );
      expect(tagsOf(lowered)).toEqual([f1.assetTag]);
    });

    it('AST-API-49 filters combine as AND, not OR', async () => {
      // `search` is itself an OR across tag/name/serial; combining it with a
      // status must narrow, not widen. Fleet Bravo is the only RETIRED row whose
      // name matches "Fleet".
      const res = await listAssets(
        fx.admin.token,
        `category=${encodeURIComponent(fleetCategory)}&status=RETIRED&search=Fleet&unassignedOnly=true`,
      );
      expect(res.status).toBe(200);
      expect(tagsOf(res)).toEqual([f2.assetTag]);
    });

    it('AST-API-50 DOCUMENTED BEHAVIOUR: unassignedOnly=true includes RETIRED and LOST assets', async () => {
      // `unassignedOnly` is implemented as `assignments: { none: { returnedAt:
      // null } }` — "nobody currently holds it" — which is deliberately NOT the
      // same question as "may it be handed out". The service says so in a
      // comment, and an IN_REPAIR asset genuinely is unheld.
      //
      // The consequence is worth recording rather than celebrating: the only
      // consumer of this flag is the Assign modal's asset picker, and
      // `ASSIGNABLE_STATUSES` is `{AVAILABLE}`. So the picker offers a RETIRED
      // or LOST asset and the assign that follows is refused with a 400. That is
      // a UI-side selection defect (AST-UI, WP-9), not a server rule the server
      // gets wrong, so it is asserted here as the server's real answer and left
      // without a failing twin.
      const res = await listAssets(
        fx.admin.token,
        `category=${encodeURIComponent(fleetCategory)}&unassignedOnly=true&limit=50`,
      );
      expect(res.status).toBe(200);
      const returned = rowsOf(res);
      expect(returned.map((r: any) => r.assetTag).sort()).toEqual(
        [f1, f2, f3, f4, f5].map((a) => a.assetTag).sort(),
      );
      expect(returned.map((r: any) => r.status).sort()).toEqual(
        ['AVAILABLE', 'AVAILABLE', 'IN_REPAIR', 'LOST', 'RETIRED'],
      );
      expect(returned.every((r: any) => r.currentHolder === null)).toBe(true);
    });

    it('AST-API-51 a filter matching nothing is an empty page, not an error', async () => {
      const res = await listAssets(
        fx.admin.token,
        `search=${encodeURIComponent(`no-such-asset-${short}`)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(rowsOf(res)).toEqual([]);
      expect(res.body.meta).toEqual({ total: 0, page: 1, limit: 25 });
    });

    it('AST-API-52 a page beyond the end is empty but still reports the true total', async () => {
      const res = await listAssets(
        fx.admin.token,
        `category=${encodeURIComponent(fleetCategory)}&page=99&limit=2`,
      );
      expect(res.status).toBe(200);
      expect(rowsOf(res)).toEqual([]);
      expect(res.body.meta).toEqual({ total: 5, page: 99, limit: 2 });
    });

    it('AST-API-53 paging is stable: three pages of two cover the fleet exactly once, in (status, assetTag) order', async () => {
      const base = `category=${encodeURIComponent(fleetCategory)}&limit=2`;
      const [p1, p2, p3] = await Promise.all([
        listAssets(fx.admin.token, `${base}&page=1`),
        listAssets(fx.admin.token, `${base}&page=2`),
        listAssets(fx.admin.token, `${base}&page=3`),
      ]);
      expect([p1.status, p2.status, p3.status]).toEqual([200, 200, 200]);
      expect([
        rowsOf(p1).length,
        rowsOf(p2).length,
        rowsOf(p3).length,
      ]).toEqual([2, 2, 1]);

      const paged = [...rowsOf(p1), ...rowsOf(p2), ...rowsOf(p3)];
      expect(new Set(paged.map((r: any) => r.id)).size).toBe(5);

      // `orderBy: [{ status: 'asc' }, { assetTag: 'asc' }]`.
      const whole = await listAssets(fx.admin.token, `${base.replace('limit=2', 'limit=50')}&page=1`);
      expect(paged.map((r: any) => r.id)).toEqual(
        rowsOf(whole).map((r: any) => r.id),
      );
      const keys = paged.map((r: any) => `${r.status}|${r.assetTag}`);
      expect(keys).toEqual([...keys].sort());
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Custody history on GET /assets/:id
  // ══════════════════════════════════════════════════════════════════════════
  describe('custody history', () => {
    let assetId: string;
    let openAssignmentId: string;
    const closedIds: string[] = [];

    beforeAll(async () => {
      const asset = await makeAsset({
        assetTag: tag('HIST'),
        name: 'History subject',
      });
      assetId = asset.id;

      // Three complete custody periods, then a fourth left open. `assignedAt`
      // is @db.Date, so periods have to be days apart for the ordering
      // assertion to mean anything — same-day rows would sort arbitrarily.
      const periods: Array<[string, string, string]> = [
        [fx.holderId, '2025-01-05', '2025-02-05'],
        [fx.managedEmployeeId, '2025-03-05', '2025-04-05'],
        [fx.managerEmployeeId, '2025-05-05', '2025-06-05'],
      ];
      for (const [employeeId, assignedAt, returnedAt] of periods) {
        const a = await assign(fx.admin.token, {
          assetId,
          employeeId,
          assignedAt,
          conditionOut: 'GOOD',
          notes: `out ${assignedAt}`,
        });
        if (a.status !== 201) {
          throw new Error(`history assign failed: ${a.status} ${msg(a)}`);
        }
        closedIds.push(a.body.data.id);
        const r = await returnAsset(fx.admin.token, a.body.data.id, {
          returnedAt,
          conditionIn: 'GOOD',
          assetStatus: 'AVAILABLE',
        });
        if (r.status !== 201) {
          throw new Error(`history return failed: ${r.status} ${msg(r)}`);
        }
      }

      const open = await assign(fx.admin.token, {
        assetId,
        employeeId: fx.holderId,
        assignedAt: '2025-07-05',
        conditionOut: 'FAIR',
      });
      if (open.status !== 201) {
        throw new Error(`history open assign failed: ${open.status} ${msg(open)}`);
      }
      openAssignmentId = open.body.data.id;
    });

    it('AST-API-54 returns all four custody periods, newest first', async () => {
      const res = await ctx
        .http()
        .get(`/assets/${assetId}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const history = res.body.data.history;
      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(4);

      const assignedDates = history.map((h: any) =>
        String(h.assignedAt).slice(0, 10),
      );
      expect(assignedDates).toEqual([
        '2025-07-05',
        '2025-05-05',
        '2025-03-05',
        '2025-01-05',
      ]);

      // Exactly one open period, and it is the one `currentHolder` projects.
      const open = history.filter((h: any) => h.returnedAt === null);
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe(openAssignmentId);
      expect(res.body.data.currentHolder.assignmentId).toBe(openAssignmentId);
      expect(res.body.data.currentHolder.employee.id).toBe(fx.holderId);
      expect(res.body.data.status).toBe('ASSIGNED');
    });

    it('AST-API-55 every field of a closed custody period is present and populated', async () => {
      const res = await ctx
        .http()
        .get(`/assets/${assetId}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const closed = res.body.data.history.find(
        (h: any) => h.id === closedIds[0],
      );
      expect(closed).toBeDefined();
      expect(Object.keys(closed)).toEqual(
        expect.arrayContaining([
          'id',
          'assetId',
          'employeeId',
          'assignedAt',
          'assignedById',
          'conditionOut',
          'acknowledgedAt',
          'acknowledgedNote',
          'returnedAt',
          'conditionIn',
          'returnReceivedById',
          'notes',
          'createdAt',
          'updatedAt',
          'employee',
          'assignedBy',
          'returnedTo',
        ]),
      );
      expect(closed.assetId).toBe(assetId);
      expect(closed.employeeId).toBe(fx.holderId);
      expect(String(closed.returnedAt).slice(0, 10)).toBe('2025-02-05');
      expect(closed.conditionOut).toBe('GOOD');
      expect(closed.conditionIn).toBe('GOOD');
      expect(closed.notes).toBe('out 2025-01-05');

      // Both sides of the custody chain are named, which is the whole point of
      // keeping the row: who handed it over and who took it back.
      expect(closed.assignedBy).toMatchObject({ id: fx.admin.userId });
      expect(closed.assignedBy.email).toBe(fx.admin.email);
      expect(closed.returnedTo).toMatchObject({ id: fx.admin.userId });
      expect(closed.employee).toMatchObject({ id: fx.holderId });
      expect(closed.employee.employeeCode).toEqual(expect.any(String));
      expect(closed.employee.fullName).toEqual(expect.any(String));
      expect(closed.employee.department).toBeTruthy();
    });

    it('AST-API-56 a malformed asset id is refused as bad input, not as a server fault', async () => {
      // Pinning the actual status rather than assuming it: `@Param('id',
      // ParseUUIDPipe)` is what keeps a malformed id from reaching Prisma and
      // returning a 500 carrying the repository's absolute path — a defect this
      // codebase shipped once already (docs/TESTING.md, People phase).
      const res = await ctx
        .http()
        .get('/assets/not-a-uuid')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(400);
      expect(res.status).not.toBe(500);
      expect(msg(res)).not.toMatch(/prisma|\/home\//i);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Concurrency — the partial unique index is the only real referee
  // ══════════════════════════════════════════════════════════════════════════
  describe('concurrent assignment', () => {
    it('AST-API-57 two simultaneous assigns of one asset: exactly one wins, the loser gets a clean 409', async () => {
      // `assign()` reads the asset's status and THEN writes, so the in-service
      // `ASSIGNABLE_STATUSES` check cannot referee a race — both callers read
      // AVAILABLE. The only thing that can is the partial unique index
      // `asset_assignments_one_open_per_asset ON (asset_id) WHERE returned_at IS
      // NULL`, whose P2002 the service maps to a 409.
      //
      // This is precisely the shape `prisma db push` cannot create (it cannot
      // express a partial index), so on a test database built without
      // `prisma/e2e-partial-indexes.sql` BOTH calls succeed and one asset ends
      // up held by two people — the failure mode Phase 4 found in payroll.
      const asset = await makeAsset({ assetTag: tag('RACE') });

      const [a, b] = await Promise.all([
        assign(fx.admin.token, {
          assetId: asset.id,
          employeeId: fx.holderId,
        }),
        assign(fx.admin.token, {
          assetId: asset.id,
          employeeId: fx.managedEmployeeId,
        }),
      ]);

      const statuses = [a.status, b.status].sort();
      const winners = [a, b].filter((r) => r.status >= 200 && r.status < 300);
      const losers = [a, b].filter((r) => r.status >= 400);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      // Not two successes, and not a raw 500 leaking the constraint name.
      expect(losers[0].status).toBe(409);
      expect(statuses).not.toContain(500);
      expect(msg(losers[0])).toMatch(/already assigned/i);

      const open = await ctx.prisma.assetAssignment.findMany({
        where: { assetId: asset.id, returnedAt: null },
      });
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe(winners[0].body.data.id);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Audit rows for every asset action
  //
  // CLEARANCE_OVERRIDDEN is the seventh action and belongs to WP-2's clearance
  // spec; the six the register itself writes are here.
  // ══════════════════════════════════════════════════════════════════════════
  describe('audit trail', () => {
    it('AST-API-58 ASSET_CREATED carries the actor and resourceType AssetItem', async () => {
      const asset = await makeAsset({ assetTag: tag('AUD-C') });
      const rows = await auditRows('ASSET_CREATED', asset.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(fx.admin.userId);
      expect(rows[0].resourceType).toBe('AssetItem');
      expect(rows[0].newData).toMatchObject({ assetTag: asset.assetTag });
    });

    it('AST-API-59 ASSET_UPDATED carries the actor and the submitted change', async () => {
      const asset = await makeAsset({ assetTag: tag('AUD-U') });
      const res = await ctx
        .http()
        .patch(`/assets/${asset.id}`)
        .set(bearer(fx.admin.token))
        .send({ name: 'Renamed by audit case' });
      expect(res.status).toBe(200);

      const rows = await auditRows('ASSET_UPDATED', asset.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(fx.admin.userId);
      expect(rows[0].resourceType).toBe('AssetItem');
      expect(rows[0].newData).toMatchObject({ name: 'Renamed by audit case' });
    });

    it('AST-API-60 ASSET_DELETED survives the row it describes', async () => {
      // The audit row is the only thing left after the delete, so it has to
      // carry the tag — an id alone points at nothing.
      const asset = await makeAsset({ assetTag: tag('AUD-D') });
      const res = await ctx
        .http()
        .delete(`/assets/${asset.id}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const rows = await auditRows('ASSET_DELETED', asset.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(fx.admin.userId);
      expect(rows[0].resourceType).toBe('AssetItem');
      expect(rows[0].newData).toMatchObject({ assetTag: asset.assetTag });
      expect(
        await ctx.prisma.assetItem.findUnique({ where: { id: asset.id } }),
      ).toBeNull();
    });

    it('AST-API-61 a custody action is discoverable from the asset it moved AND from the assignment', async () => {
      // REGRESSION LOCK (R25 — fixed). The controller is
      // `@AuditResource('AssetItem')`, but `ASSET_ASSIGNED`/`RETURNED`/
      // `ACKNOWLEDGED` were filed ONLY under `resourceType: 'AssetAssignment'`
      // with the assignment id, so zero rows existed under the asset's own id.
      // An auditor filtering by `AssetItem` — the only resource type the asset
      // screens know — saw the register's lifecycle but not who was handed
      // what: the trail split and the asset half lost the custody half.
      //
      // `AssetAssignmentsService.logCustody()` now writes the action at BOTH
      // ends — the original `AssetAssignment` row plus a mirror under
      // `AssetItem`/`assetId` — and folds `assetId` + `assignmentId` into the
      // payload of each, so either row alone pivots to the other.
      const asset = await makeAsset({ assetTag: tag('AUD-A') });
      const res = await assign(fx.admin.token, {
        assetId: asset.id,
        employeeId: fx.managedEmployeeId,
        conditionOut: 'NEW',
      });
      expect(res.status).toBe(201);
      const assignmentId = res.body.data.id;

      const underAssignment = await auditRows('ASSET_ASSIGNED', assignmentId);
      expect(underAssignment).toHaveLength(1);
      expect(underAssignment[0].userId).toBe(fx.admin.userId);
      expect(underAssignment[0].resourceType).toBe('AssetAssignment');
      expect(underAssignment[0].newData).toMatchObject({
        assetTag: asset.assetTag,
        employeeId: fx.managedEmployeeId,
        assetId: asset.id,
        assignmentId,
      });

      // The half that did not exist before: the asset's own id.
      const underAsset = await auditRows('ASSET_ASSIGNED', asset.id);
      expect(underAsset).toHaveLength(1);
      expect(underAsset[0].userId).toBe(fx.admin.userId);
      expect(underAsset[0].resourceType).toBe('AssetItem');
      expect(underAsset[0].newData).toMatchObject({
        assetTag: asset.assetTag,
        employeeId: fx.managedEmployeeId,
        assignmentId,
      });
    });

    it('AST-API-61b return and acknowledge are mirrored to the asset too, not just assign', async () => {
      // REGRESSION LOCK (R25 — fixed). All THREE custody actions went through
      // the same broken shape, so all three are locked, not just the one the
      // finding quoted.
      const asset = await makeAsset({ assetTag: tag('AUD-A2') });
      const a = await assign(fx.admin.token, {
        assetId: asset.id,
        employeeId: fx.employee.employeeId!,
      });
      expect(a.status).toBe(201);
      const assignmentId = a.body.data.id;

      const ack = await ctx
        .http()
        .post(`/assets/assignments/${assignmentId}/acknowledge`)
        .set(bearer(fx.employee.token))
        .send({ note: 'received' });
      expect(ack.status).toBe(201);

      const r = await returnAsset(fx.admin.token, assignmentId, {
        conditionIn: 'GOOD',
      });
      expect(r.status).toBe(201);

      for (const action of [
        'ASSET_ASSIGNED',
        'ASSET_ACKNOWLEDGED',
        'ASSET_RETURNED',
      ]) {
        const byAsset = await auditRows(action, asset.id);
        expect(byAsset).toHaveLength(1);
        expect(byAsset[0].resourceType).toBe('AssetItem');
        expect(byAsset[0].newData).toMatchObject({ assignmentId });

        const byAssignment = await auditRows(action, assignmentId);
        expect(byAssignment).toHaveLength(1);
        expect(byAssignment[0].resourceType).toBe('AssetAssignment');
        expect(byAssignment[0].newData).toMatchObject({ assetId: asset.id });
      }
    });

    it('AST-API-62 ASSET_RETURNED records the condition and the status the asset went back to', async () => {
      const asset = await makeAsset({ assetTag: tag('AUD-R') });
      const a = await assign(fx.admin.token, {
        assetId: asset.id,
        employeeId: fx.managedEmployeeId,
      });
      expect(a.status).toBe(201);

      const r = await returnAsset(fx.admin.token, a.body.data.id, {
        conditionIn: 'DAMAGED',
        assetStatus: 'IN_REPAIR',
      });
      expect(r.status).toBe(201);

      const rows = await auditRows('ASSET_RETURNED', a.body.data.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(fx.admin.userId);
      expect(rows[0].resourceType).toBe('AssetAssignment');
      expect(rows[0].newData).toMatchObject({
        assetTag: asset.assetTag,
        conditionIn: 'DAMAGED',
        assetStatus: 'IN_REPAIR',
      });
    });

    it('AST-API-63 ASSET_ACKNOWLEDGED names the EMPLOYEE as actor, not the HR user who assigned it', async () => {
      // The acknowledgement is the employee's digital receipt. If the audit row
      // named the assigning HR user the record would prove nothing.
      const asset = await makeAsset({ assetTag: tag('AUD-K') });
      const a = await assign(fx.admin.token, {
        assetId: asset.id,
        employeeId: fx.employee.employeeId!,
      });
      expect(a.status).toBe(201);

      const ack = await ctx
        .http()
        .post(`/assets/assignments/${a.body.data.id}/acknowledge`)
        .set(bearer(fx.employee.token))
        .send({ note: 'received in good order' });
      expect(ack.status).toBe(201);

      const rows = await auditRows('ASSET_ACKNOWLEDGED', a.body.data.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(fx.employee.userId);
      expect(rows[0].userId).not.toBe(fx.admin.userId);
      expect(rows[0].resourceType).toBe('AssetAssignment');
      expect(rows[0].newData).toMatchObject({
        assetTag: asset.assetTag,
        note: 'received in good order',
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7. GET /assets/clearance/reports/outstanding — zero coverage before this
  //
  // The HR worklist for assets held by people who have already left. Nothing
  // else in the product surfaces them: the clearance GATE only fires during an
  // offboarding, so anyone who left before it existed, or through an override,
  // is invisible until this report names them.
  // ══════════════════════════════════════════════════════════════════════════
  describe('outstanding report', () => {
    const outstanding = (token?: string) => {
      const req = ctx.http().get('/assets/clearance/reports/outstanding');
      return token ? req.set(bearer(token)) : req;
    };

    let clearedLeaverId: string;
    let branchBLeaverId: string;
    let branchBAssetTag: string;

    beforeAll(async () => {
      // An INACTIVE leaver who DID hand everything back — the negative control.
      // Without it, "the report lists inactive employees" and "the report lists
      // inactive employees who still hold something" look identical.
      const cleared = await ctx.prisma.employee.create({
        data: {
          employeeCode: `EMP-${fx.runId}-CLRD`,
          fullName: 'WPL Cleared Leaver',
          dateOfBirth: new Date('1990-01-01'),
          idCard: `ID-${fx.runId}-CLRD`,
          email: `clrd-${fx.runId}@test.local`,
          departmentId: fx.managedDeptId,
          branchId: fx.branchA,
          position: 'Engineer',
          startDate: new Date('2024-01-01'),
          baseSalary: 50000,
          status: 'INACTIVE',
        },
      });
      clearedLeaverId = cleared.id;
      const clearedAsset = await ctx.prisma.assetItem.create({
        data: {
          assetTag: tag('OUT-CLR'),
          category: 'Laptop',
          name: 'Handed back',
          branchId: fx.branchA,
          status: 'AVAILABLE',
        },
      });
      await ctx.prisma.assetAssignment.create({
        data: {
          assetId: clearedAsset.id,
          employeeId: cleared.id,
          assignedAt: new Date('2025-01-01'),
          assignedById: fx.admin.userId,
          returnedAt: new Date('2025-02-01'),
          returnReceivedById: fx.admin.userId,
        },
      });

      // An INACTIVE leaver in branch B still holding a branch-B asset — the
      // subject the scoped-HR case turns on.
      const branchBLeaver = await ctx.prisma.employee.create({
        data: {
          employeeCode: `EMP-${fx.runId}-BLVR`,
          fullName: 'WPL Branch B Leaver',
          dateOfBirth: new Date('1990-01-01'),
          idCard: `ID-${fx.runId}-BLVR`,
          email: `blvr-${fx.runId}@test.local`,
          departmentId: fx.otherDeptId,
          branchId: fx.branchB,
          position: 'Engineer',
          startDate: new Date('2024-01-01'),
          baseSalary: 50000,
          status: 'INACTIVE',
        },
      });
      branchBLeaverId = branchBLeaver.id;
      branchBAssetTag = tag('OUT-BLV');
      const branchBAsset = await ctx.prisma.assetItem.create({
        data: {
          assetTag: branchBAssetTag,
          category: 'Laptop',
          name: 'Still out in branch B',
          branchId: fx.branchB,
          status: 'ASSIGNED',
        },
      });
      await ctx.prisma.assetAssignment.create({
        data: {
          assetId: branchBAsset.id,
          employeeId: branchBLeaver.id,
          assignedAt: new Date('2025-01-01'),
          assignedById: fx.admin.userId,
        },
      });
    });

    it('AST-API-64 ADMIN 200; HR 200; MANAGER 403; EMPLOYEE 403; anonymous 401', async () => {
      expect((await outstanding(fx.admin.token)).status).toBe(200);
      expect((await outstanding(fx.scopedHr.token)).status).toBe(200);
      expect((await outstanding(fx.manager.token)).status).toBe(403);
      expect((await outstanding(fx.employee.token)).status).toBe(403);
      expect((await outstanding()).status).toBe(401);
    });

    it('AST-API-65 an INACTIVE leaver still holding an asset appears, with the asset and the employee named', async () => {
      const res = await outstanding(fx.admin.token);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const row = rowsOf(res).find((r: any) => r.employeeId === fx.leaverId);
      expect(row).toBeDefined();
      expect(row.returnedAt).toBeNull();
      expect(row.asset).toMatchObject({
        id: fx.assetLeaverHeldId,
        assetTag: fx.assetLeaverHeldTag,
      });
      expect(row.asset.name).toEqual(expect.any(String));
      expect(row.asset.category).toEqual(expect.any(String));
      expect(row.employee).toMatchObject({
        id: fx.leaverId,
        status: 'INACTIVE',
      });
      expect(row.employee.employeeCode).toEqual(expect.any(String));
      expect(row.employee.fullName).toEqual(expect.any(String));
      expect(row.employee).toHaveProperty('endDate');
      expect(row.employee.department).toBeTruthy();
    });

    it('AST-API-66 a leaver who handed everything back does NOT appear', async () => {
      const res = await outstanding(fx.admin.token);
      expect(res.status).toBe(200);
      expect(
        rowsOf(res).some((r: any) => r.employeeId === clearedLeaverId),
      ).toBe(false);
    });

    it('AST-API-67 an ACTIVE employee holding an asset does NOT appear — the report is about leavers, not custody', async () => {
      const res = await outstanding(fx.admin.token);
      expect(res.status).toBe(200);
      // `fx.holderId` is ACTIVE and holds `assetHeldAId` throughout this file.
      expect(rowsOf(res).some((r: any) => r.employeeId === fx.holderId)).toBe(
        false,
      );
    });

    it('AST-API-68 the report is branch-scoped by the HOLDER: branch-A HR sees the branch-A leaver and not the branch-B one', async () => {
      const asAdmin = await outstanding(fx.admin.token);
      const adminEmployees = rowsOf(asAdmin).map((r: any) => r.employeeId);
      expect(adminEmployees).toEqual(expect.arrayContaining([fx.leaverId]));
      expect(adminEmployees).toEqual(
        expect.arrayContaining([branchBLeaverId]),
      );

      const asHr = await outstanding(fx.scopedHr.token);
      expect(asHr.status).toBe(200);
      const hrEmployees = rowsOf(asHr).map((r: any) => r.employeeId);
      expect(hrEmployees).toEqual(expect.arrayContaining([fx.leaverId]));
      expect(hrEmployees).not.toContain(branchBLeaverId);
      expect(rowsOf(asHr).map((r: any) => r.asset.assetTag)).not.toContain(
        branchBAssetTag,
      );
    });

    it('AST-API-69 rows are ordered oldest custody first — the longest-outstanding item leads the worklist', async () => {
      const res = await outstanding(fx.admin.token);
      const dates = rowsOf(res).map((r: any) =>
        new Date(r.assignedAt).getTime(),
      );
      expect(dates).toEqual([...dates].sort((a, b) => a - b));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. What assign() refuses
  // ══════════════════════════════════════════════════════════════════════════
  describe('assignment refusals', () => {
    it('AST-API-70 refuses an employee who is not ACTIVE', async () => {
      // Clearance is keyed on open assignments, so handing an asset to someone
      // already INACTIVE creates an obligation no offboarding will ever check.
      const asset = await makeAsset({ assetTag: tag('REF-INA') });
      const res = await assign(fx.admin.token, {
        assetId: asset.id,
        employeeId: fx.leaverId,
      });
      expect(res.status).toBe(400);
      expect(msg(res)).toMatch(/INACTIVE/);

      expect(
        await ctx.prisma.assetAssignment.count({
          where: { assetId: asset.id },
        }),
      ).toBe(0);
      const after = await ctx.prisma.assetItem.findUnique({
        where: { id: asset.id },
      });
      expect(after?.status).toBe('AVAILABLE');
    });

    it('AST-API-71 refuses an asset that is already ASSIGNED, before the index has to', async () => {
      const res = await assign(fx.admin.token, {
        assetId: fx.assetHeldAId,
        employeeId: fx.managedEmployeeId,
      });
      expect(res.status).toBe(400);
      expect(msg(res)).toMatch(/ASSIGNED and cannot be assigned/i);
    });

    it('AST-API-72 refuses RETIRED, LOST and IN_REPAIR assets — ASSIGNABLE_STATUSES is {AVAILABLE}', async () => {
      for (const status of ['RETIRED', 'LOST', 'IN_REPAIR']) {
        const asset = await makeAsset({
          assetTag: tag(`REF-${status}`),
          status,
        });
        const res = await assign(fx.admin.token, {
          assetId: asset.id,
          employeeId: fx.managedEmployeeId,
        });
        expect(res.status).toBe(400);
        expect(msg(res)).toMatch(
          new RegExp(`is ${status} and cannot be assigned`, 'i'),
        );
        expect(
          await ctx.prisma.assetAssignment.count({
            where: { assetId: asset.id },
          }),
        ).toBe(0);
      }
    });

    it('AST-API-73 refuses an unknown asset and an unknown employee with 404, distinctly', async () => {
      // A v4-shaped uuid on purpose: `AssignAssetDto` uses `@IsUUID()`, whose
      // default "all" mode still requires a real version nibble, so an all-zero
      // uuid is a 400 from validation and would never reach the 404 this case
      // exists to prove.
      const unknown = '11111111-1111-4111-8111-111111111111';
      const noAsset = await assign(fx.admin.token, {
        assetId: unknown,
        employeeId: fx.managedEmployeeId,
      });
      expect(noAsset.status).toBe(404);
      expect(msg(noAsset)).toMatch(/asset not found/i);

      const asset = await makeAsset({ assetTag: tag('REF-NOE') });
      const noEmployee = await assign(fx.admin.token, {
        assetId: asset.id,
        employeeId: unknown,
      });
      expect(noEmployee.status).toBe(404);
      expect(msg(noEmployee)).toMatch(/employee not found/i);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 9. THE FINDINGS — pinned, never hidden
  // ══════════════════════════════════════════════════════════════════════════

  // ── R1 ────────────────────────────────────────────────────────────────────
  describe('R1 — assign() compares the asset branch with the employee branch', () => {
    it('AST-API-31 a branch-A asset cannot be handed to a branch-B employee: 400, naming both branches', async () => {
      // REGRESSION LOCK (R1/R1b — fixed). `assign()` called `assertInBranch` on
      // the asset AND on the employee, but both against the CALLER's scope and
      // never against each other, so a global ADMIN passed both and nothing
      // compared `asset.branchId` with `employee.branchId`.
      //
      // The damage was structural, not cosmetic. `branch-scope.map.ts` scopes
      // `AssetAssignment` by RELATION — the HOLDER's branch — while `AssetItem`
      // is scoped `direct` by the asset's own branch. Once the two disagreed the
      // custody row lived in branch B while the asset lived in branch A: branch
      // A's HR saw an asset marked ASSIGNED with no visible holder, the
      // open-assignments screen they chase items back with was silent about it,
      // and `return()` — which asserted on the HOLDER's branch — answered them
      // 404 for their own property (R1b, the lockout).
      //
      // `asset-assignments.service.ts:assign()` now refuses the pairing, so the
      // clearance obligation cannot leave the branch that owns the asset.
      const asset = await makeAsset({ assetTag: tag('R1'), name: 'R1 subject' });

      const res = await assign(fx.admin.token, {
        assetId: asset.id,
        employeeId: fx.branchBEmployeeId,
      });
      expect(res.status).toBe(400);
      // Both ends are named, so the operator knows which way to move what.
      expect(msg(res)).toContain(asset.assetTag);
      expect(msg(res)).toContain(fx.branchAcode);
      expect(msg(res)).toContain(fx.branchBcode);

      // Nothing was written: no custody row, and the asset is untouched and
      // still assignable inside its own branch.
      expect(
        await ctx.prisma.assetAssignment.count({ where: { assetId: asset.id } }),
      ).toBe(0);
      const row = await ctx.prisma.assetItem.findUnique({
        where: { id: asset.id },
      });
      expect(row!.status).toBe('AVAILABLE');
      expect(row!.branchId).toBe(fx.branchA);
    });

    it('AST-API-31b the refusal is symmetric — a branch-B asset cannot be handed to a branch-A employee either', async () => {
      // REGRESSION LOCK (R1). The guard is a comparison, not a one-way check
      // against the caller's own branch, so it has to hold in both directions.
      const assetB = await makeAsset({
        assetTag: tag('R1-B'),
        name: 'R1 branch-B subject',
        branchId: fx.branchB,
      });

      const res = await assign(fx.admin.token, {
        assetId: assetB.id,
        employeeId: fx.managedEmployeeId,
      });
      expect(res.status).toBe(400);
      expect(msg(res)).toMatch(/branch/i);
      expect(
        await ctx.prisma.assetAssignment.count({
          where: { assetId: assetB.id },
        }),
      ).toBe(0);
    });

    it('AST-API-31c a same-branch assignment is untouched, and the owning branch can close it', async () => {
      // REGRESSION LOCK (R1b). The control the guard must not break: branch A's
      // own HR assigns branch A's asset to a branch A employee and records the
      // return, end to end, under their own scoped token. This is the flow the
      // cross-branch bug locked branch A out of with a 404.
      const asset = await makeAsset({
        assetTag: tag('R1-OK'),
        name: 'R1 same-branch control',
      });

      const a = await assign(fx.scopedHr.token, {
        assetId: asset.id,
        employeeId: fx.managedEmployeeId,
      });
      expect(a.status).toBe(201);
      const assignmentId = a.body.data.id;

      // Visible on the screen HR chases items back with.
      const open = await ctx
        .http()
        .get('/assets/assignments/open')
        .set(bearer(fx.scopedHr.token));
      expect(open.status).toBe(200);
      expect(rowsOf(open).map((r: any) => r.id)).toContain(assignmentId);

      const ret = await returnAsset(fx.scopedHr.token, assignmentId, {
        conditionIn: 'GOOD',
      });
      expect(ret.status).toBe(201);

      const closed = await ctx.prisma.assetAssignment.findUnique({
        where: { id: assignmentId },
      });
      expect(closed?.returnedAt).not.toBeNull();
    });

    it('AST-API-32 an employee with NO branch is still assignable — the guard compares, it does not require', async () => {
      // REGRESSION LOCK (R1). `Employee.branchId` is nullable. A null branch is
      // "unassigned / company-wide", not "a different branch", so refusing it
      // would turn a defect fix into a new outage on a population the finding
      // never mentioned.
      const asset = await makeAsset({ assetTag: tag('R1-NULL') });
      const emp = await ctx.prisma.employee.update({
        where: { id: fx.branchBEmployeeId },
        data: { branchId: null },
        select: { id: true },
      });

      try {
        const res = await assign(fx.admin.token, {
          assetId: asset.id,
          employeeId: emp.id,
        });
        expect(res.status).toBe(201);
        await ctx.prisma.assetAssignment.delete({
          where: { id: res.body.data.id },
        });
        await ctx.prisma.assetItem.update({
          where: { id: asset.id },
          data: { status: 'AVAILABLE' },
        });
      } finally {
        await ctx.prisma.employee.update({
          where: { id: fx.branchBEmployeeId },
          data: { branchId: fx.branchB },
        });
      }
    });
  });

  // ── R2 ────────────────────────────────────────────────────────────────────
  describe('R2 — assetTag is unique per branch', () => {
    it('AST-API-06b a scoped HR may register a tag another branch already holds', async () => {
      // REGRESSION LOCK (R2 — fixed). `asset_tag` used to be globally `@unique`
      // (schema.prisma), so two branches could not both hold "LAP-001" —
      // and branches genuinely do run their own numbering. The refusal was not
      // just inconvenient, it was UNRESOLVABLE for the person who hit it: a
      // branch-A HR was told the tag was already in use, and the search that
      // message invites returned nothing, because the colliding row lived in a
      // branch the Prisma branch middleware hides from them. They were told to
      // pick another tag by an error that named a row they could not reach.
      //
      // `@@unique([branchId, assetTag])` now, so this is the ordinary case:
      // branch A registering its own copy of a tag branch B holds.
      const res = await postAsset(fx.scopedHr.token, {
        assetTag: fx.assetAvailableBTag,
        category: 'Laptop',
        name: 'Branch A reuses a branch B tag',
        branchId: fx.branchA,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.assetTag).toBe(fx.assetAvailableBTag);
      expect(res.body.data.branch.id).toBe(fx.branchA);

      // Both rows exist, one per branch, and each branch sees only its own.
      const asAdmin = await listAssets(
        fx.admin.token,
        `search=${encodeURIComponent(fx.assetAvailableBTag)}`,
      );
      expect(rowsOf(asAdmin).map((r: any) => r.branch.id).sort()).toEqual(
        [fx.branchA, fx.branchB].sort(),
      );

      const asScoped = await listAssets(
        fx.scopedHr.token,
        `search=${encodeURIComponent(fx.assetAvailableBTag)}`,
      );
      expect(rowsOf(asScoped).map((r: any) => r.branch.id)).toEqual([
        fx.branchA,
      ]);
    });

    it('AST-API-06c the same tag twice in ONE branch is still 409, and the message names the branch', async () => {
      // The other half of the decision, and the one that keeps the constraint
      // worth having: per-branch does not mean unenforced. A duplicate WITHIN a
      // branch is exactly the mistake the register exists to prevent, and the
      // caller can act on this refusal because the row it names is one they can
      // see — which is what the global constraint could not promise.
      const duplicate = tag('R2-DUP');

      const first = await postAsset(fx.admin.token, {
        assetTag: duplicate,
        category: 'Laptop',
        name: 'R2 first in branch A',
        branchId: fx.branchA,
      });
      expect(first.status).toBe(201);

      const second = await postAsset(fx.admin.token, {
        assetTag: duplicate,
        category: 'Laptop',
        name: 'R2 second in branch A',
        branchId: fx.branchA,
      });
      expect(second.status).toBe(409);
      expect(msg(second)).toMatch(/already in use/i);
      expect(msg(second)).toContain(duplicate);
      // Actionable: it says WHERE, and it says the rule.
      expect(msg(second)).toMatch(/branch/i);
      expect(msg(second)).toMatch(/unique per branch/i);

      // And the caller can actually find the row the message is about.
      const found = await listAssets(
        fx.admin.token,
        `search=${encodeURIComponent(duplicate)}&branchId=${fx.branchA}`,
      );
      expect(tagsOf(found)).toEqual([duplicate]);
    });

    it('AST-API-06d moving an asset into a branch that already holds its tag is 409, not a 500', async () => {
      // Either half of the pair can now cause the collision, and the branch
      // transfer is the half that has no `assetTag` in its own payload. Before
      // the message was rebuilt around the pair it would have read
      // `Asset tag "undefined" is already in use`.
      const shared = tag('R2-MOVE');

      const inA = await postAsset(fx.admin.token, {
        assetTag: shared,
        category: 'Laptop',
        name: 'R2 move — the branch A incumbent',
        branchId: fx.branchA,
      });
      expect(inA.status).toBe(201);

      const inB = await postAsset(fx.admin.token, {
        assetTag: shared,
        category: 'Laptop',
        name: 'R2 move — the branch B copy',
        branchId: fx.branchB,
      });
      expect(inB.status).toBe(201);

      const moved = await ctx
        .http()
        .patch(`/assets/${inB.body.data.id}`)
        .set(bearer(fx.admin.token))
        .send({ branchId: fx.branchA });
      expect(moved.status).toBe(409);
      expect(msg(moved)).toContain(shared);
      expect(msg(moved)).not.toMatch(/undefined/);
    });
  });

  // ── R3 ────────────────────────────────────────────────────────────────────
  describe('R3 — deleting an asset that has custody history is refused', () => {
    it('AST-API-19 an asset with CLOSED history cannot be deleted, and the evidence survives the attempt', async () => {
      // REGRESSION LOCK (R3 — fixed). `remove()` blocked only on an OPEN
      // assignment, and `asset_assignments.asset_id` is `onDelete: Cascade`
      // (`schema.prisma`). So an asset that had been handed out, signed for and
      // handed back could be deleted by any ADMIN, and every custody row went
      // with it — including the acknowledgement that proved the employee
      // received it and the return that cleared their offboarding. Nothing
      // warned, and the surviving `ASSET_DELETED` audit row carried only the
      // tag. The register's whole purpose is that trail.
      //
      // `assets.service.ts:remove()` now refuses when ANY assignment exists,
      // open or closed, and says what to do instead (retire it). The FK is
      // untouched — this is a service-level RESTRICT, deliberately, because the
      // e2e schema is built by `db push` and a migration is out of scope.
      const asset = await makeAsset({ assetTag: tag('R3'), name: 'R3 subject' });

      const a = await assign(fx.admin.token, {
        assetId: asset.id,
        employeeId: fx.employee.employeeId!,
        conditionOut: 'NEW',
      });
      expect(a.status).toBe(201);
      const assignmentId = a.body.data.id;

      const ack = await ctx
        .http()
        .post(`/assets/assignments/${assignmentId}/acknowledge`)
        .set(bearer(fx.employee.token))
        .send({ note: 'signed for' });
      expect(ack.status).toBe(201);

      const r = await returnAsset(fx.admin.token, assignmentId, {
        conditionIn: 'GOOD',
      });
      expect(r.status).toBe(201);

      // Nobody holds it — the OPEN-assignment rule below would let this through.
      const del = await ctx
        .http()
        .delete(`/assets/${asset.id}`)
        .set(bearer(fx.admin.token));
      expect(del.status).toBe(400);
      expect(msg(del)).toMatch(/custody record/i);
      expect(msg(del)).toMatch(/retire/i);

      // The asset and its full trail are exactly as they were.
      expect(
        await ctx.prisma.assetItem.findUnique({ where: { id: asset.id } }),
      ).not.toBeNull();
      const after = await ctx.prisma.assetAssignment.findMany({
        where: { assetId: asset.id },
      });
      expect(after).toHaveLength(1);
      expect(after[0].acknowledgedAt).not.toBeNull();
      expect(after[0].returnedAt).not.toBeNull();

      // And the employee's own record of having held it is intact.
      const my = await ctx
        .http()
        .get('/assets/my')
        .set(bearer(fx.employee.token));
      expect(my.status).toBe(200);
      expect(rowsOf(my).map((row: any) => row.id)).toContain(assignmentId);
    });

    it('AST-API-19b a held asset still gives the more specific "record its return" message', async () => {
      // REGRESSION LOCK (R3). Two refusals, two different remedies: an OPEN
      // assignment is fixable (record the return), a closed history is not
      // (retire it). Collapsing them into one message would send HR looking for
      // an item nobody has.
      const asset = await makeAsset({ assetTag: tag('R3-OPEN') });
      const a = await assign(fx.admin.token, {
        assetId: asset.id,
        employeeId: fx.managedEmployeeId,
      });
      expect(a.status).toBe(201);

      const del = await ctx
        .http()
        .delete(`/assets/${asset.id}`)
        .set(bearer(fx.admin.token));
      expect(del.status).toBe(400);
      expect(msg(del)).toMatch(/currently held/i);
      expect(msg(del)).toMatch(/record its return/i);
    });

    it('AST-API-19c an asset that was never assigned still deletes cleanly', async () => {
      // REGRESSION LOCK (R3). The control: the fix restricts deletion to assets
      // with no custody history at all, so a mis-typed row added this morning is
      // still removable. Without this, "refuse the delete" would have quietly
      // become "never delete".
      const asset = await makeAsset({ assetTag: tag('R3-CLEAN') });
      const del = await ctx
        .http()
        .delete(`/assets/${asset.id}`)
        .set(bearer(fx.admin.token));
      expect(del.status).toBe(200);
      expect(
        await ctx.prisma.assetItem.findUnique({ where: { id: asset.id } }),
      ).toBeNull();
    });
  });

  // ── R15 ───────────────────────────────────────────────────────────────────
  describe('R15 — AssetItem.status is a real database enum', () => {
    it('AST-API-09 the database refuses a status outside the five, not just the DTO', async () => {
      // REGRESSION LOCK (R15 — fixed). `status` used to be
      // `String @default("AVAILABLE") @db.VarChar(20)` with
      // `@IsIn(ASSET_STATUSES)` in the DTOs as the ONLY gate. A DTO guards one
      // door. Anything that reached the table by another route — a seed, a
      // backfill, an MCP tool, a future endpoint that forgot the constant — was
      // stored happily, served straight back out of `GET /assets/:id`, counted
      // in `/assets/summary` byStatus as if it were a real status, and then
      // UNREACHABLE: `?status=SCRAPPED` is refused by the same DTO that refuses
      // to create it, so no filter could find the row again. It was not
      // assignable either, so the register held an item no screen had a label,
      // a filter or an action for.
      //
      // `enum AssetStatus` is a PG enum now, so the column itself refuses it.
      // Driven through PRISMA, not the HTTP door, because the whole finding is
      // that the HTTP door was never the problem.
      const rejectedByDto = await postAsset(
        fx.admin.token,
        validAsset({ status: 'SCRAPPED' as any }),
      );
      expect(rejectedByDto.status).toBe(400);

      // The same value written directly is now refused by the DATABASE.
      await expect(
        ctx.prisma.assetItem.create({
          data: {
            assetTag: tag('R15'),
            category: `WPLR15-${short}`,
            name: 'Free-text status',
            branchId: fx.branchA,
            status: 'SCRAPPED' as any,
          },
        }),
      ).rejects.toThrow();

      // Nothing was written, so nothing can be served back or counted.
      const leaked = await ctx.prisma.assetItem.findMany({
        where: { category: `WPLR15-${short}` },
        select: { id: true },
      });
      expect(leaked).toEqual([]);

      const summary = await ctx
        .http()
        .get('/assets/summary')
        .set(bearer(fx.admin.token));
      expect(summary.status).toBe(200);
      expect(Object.keys(summary.body.data.byStatus)).not.toContain('SCRAPPED');
      // The keys the register reports are now exactly the enum's members.
      expect(
        Object.keys(summary.body.data.byStatus).filter(
          (k) => !ASSET_STATUSES.includes(k as any),
        ),
      ).toEqual([]);

      // An UPDATE cannot smuggle one in either — the DTO and the column both
      // refuse, and this is the path an admin edit screen actually takes.
      const subject = await makeAsset({ assetTag: tag('R15-UPD') });
      await expect(
        ctx.prisma.assetItem.update({
          where: { id: subject.id },
          data: { status: 'SCRAPPED' as any },
        }),
      ).rejects.toThrow();
    });

    it('AST-API-09b every one of the five statuses is still writable and still filterable', async () => {
      // The positive control. A constraint that refuses everything would also
      // pass the case above, and "the enum is too narrow" is the failure this
      // change could plausibly introduce — ASSIGNED in particular is written
      // only by the custody transaction, never by hand.
      const category = `WPLR15OK-${short}`;
      for (const status of ASSET_STATUSES) {
        const row = await ctx.prisma.assetItem.create({
          data: {
            assetTag: tag(`R15-${status}`),
            category,
            name: `Enum member ${status}`,
            branchId: fx.branchA,
            status,
          },
        });
        expect(row.status).toBe(status);

        // …and the `?status=` filter the DTO used to make unusable now reaches
        // every value the column can hold.
        const filtered = await listAssets(
          fx.admin.token,
          `status=${status}&category=${encodeURIComponent(category)}`,
        );
        expect(filtered.status).toBe(200);
        expect(tagsOf(filtered)).toContain(row.assetTag);
      }
    });
  });
});
