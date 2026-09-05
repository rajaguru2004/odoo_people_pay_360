import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
  RATED_DESTINATION,
} from './utils/finance-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * Travel, end to end — the SURFACE suite.
 *
 * `travel.e2e-spec.ts` already proves the basics: that a per-diem rate is
 * snapshotted at submit and that a later rate edit does not rewrite an approved
 * trip. This file covers what that one does not: who may reach each of the eight
 * routes, what the server refuses and in which words, how branch and department
 * narrow the view, and — the part with teeth — that approving a trip fires each
 * of its side effects exactly once.
 *
 * The behaviour worth knowing before reading anything else: on create, Travel
 * used to treat "no approval chain governs this" as **approve immediately**,
 * rather than as **wait for a human** — and approving a trip is what commits
 * money against a budget. TRV-API-30 holds the line.
 */
describe('Finance — Travel (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any): any => res.body?.data ?? res.body;
  const rowsOf = (res: any): any[] => {
    const d = dataOf(res);
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };
  const idsOf = (res: any) => rowsOf(res).map((r: any) => r.id);

  /** Jest's `expect` takes one argument; the response body is the diagnosis. */
  const expectStatus = (
    res: any,
    expected: number | number[],
    label = '',
  ): void => {
    const want = Array.isArray(expected) ? expected : [expected];
    if (!want.includes(res.status)) {
      throw new Error(
        `${label ? `${label} — ` : ''}expected ${want.join(' or ')}, got ${res.status}: ${body(res)}`,
      );
    }
  };

  const inDays = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const trip = async (token: string, over: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/travel-requests')
      .set(bearer(token))
      .send({
        purpose: `e2e ${fx.runId}`,
        travelType: 'DOMESTIC',
        destination: RATED_DESTINATION,
        departureDate: inDays(10),
        returnDate: inDays(12),
        estimatedCost: 300,
        ...over,
      });

  /**
   * A PENDING trip, written directly.
   *
   * Posting one would work now that travel waits for a human (TRV-API-30), but
   * these rows carry a pinned per-diem rate and day count so the side-effect
   * assertions have exact numbers to check rather than whatever the library
   * happens to hold.
   */
  const pendingTrip = async (over: Record<string, unknown> = {}) =>
    ctx.prisma.travelRequest.create({
      data: {
        employeeId: fx.earnerId,
        purpose: `e2e pending ${fx.runId}`,
        travelType: 'DOMESTIC',
        destination: RATED_DESTINATION,
        departureDate: new Date(inDays(10)),
        returnDate: new Date(inDays(12)),
        perDiemRate: 25,
        perDiemDays: 3,
        estimatedCost: 300,
        status: 'PENDING',
        ...over,
      },
    });

  const commitmentsFor = (travelId: string) =>
    ctx.prisma.budgetCommitment.findMany({
      where: { sourceType: 'TRAVEL', sourceId: travelId },
    });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Raising a request ─────────────────────────────────────────────────────
  describe('raising a request', () => {
    it('TRV-API-01 every role may request a trip for themselves; anonymous may not', async () => {
      for (const who of [fx.employee, fx.manager, fx.hrScoped]) {
        const res = await trip(who.token);
        expectStatus(res, 201, who.email);
      }
      const anon = await ctx.http().post('/travel-requests').send({});
      expect(anon.status).toBe(401);
    });

    it('TRV-API-02 the per-diem rate is snapshotted at submit, from the destination library', async () => {
      const res = await trip(fx.employee.token);
      expectStatus(res, 201);
      const row = await ctx.prisma.travelRequest.findUnique({
        where: { id: dataOf(res).id },
      });
      expect(Number(row!.perDiemRate)).toBe(25);
      // Inclusive day count — a trip that leaves and returns on the same day is
      // one per-diem day, not zero.
      expect(row!.perDiemDays).toBe(3);
    });

    it('TRV-API-03 a same-day trip is one per-diem day', async () => {
      const day = inDays(20);
      const res = await trip(fx.employee.token, {
        departureDate: day,
        returnDate: day,
      });
      expectStatus(res, 201);
      const row = await ctx.prisma.travelRequest.findUnique({
        where: { id: dataOf(res).id },
      });
      expect(row!.perDiemDays).toBe(1);
    });

    it('TRV-API-04 an unknown destination carries no rate rather than failing', async () => {
      // Destinations are a free-text label against a library, not an FK. A
      // typo must not lose the trip; it loses the per-diem, which is visible.
      const res = await trip(fx.employee.token, { destination: 'Atlantis' });
      expectStatus(res, 201);
      const row = await ctx.prisma.travelRequest.findUnique({
        where: { id: dataOf(res).id },
      });
      expect(row!.perDiemRate).toBeNull();
    });

    it('TRV-API-05 a return before departure is refused', async () => {
      const res = await trip(fx.employee.token, {
        departureDate: inDays(12),
        returnDate: inDays(10),
      });
      expectStatus(res, 400);
      expect(res.body.message).toBe('Return date cannot be before departure');
    });

    it('TRV-API-06 DTO validation: bad travelType, missing purpose, negative cost, bad dates, unknown key', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['bad travelType', { travelType: 'SPACE' }],
        ['missing purpose', { purpose: undefined }],
        ['negative cost', { estimatedCost: -1 }],
        ['bad departure', { departureDate: 'soon' }],
        ['unknown key', { status: 'APPROVED' }],
      ];
      for (const [label, over] of cases) {
        const payload: Record<string, unknown> = {
          purpose: `e2e ${fx.runId}`,
          travelType: 'DOMESTIC',
          destination: RATED_DESTINATION,
          departureDate: inDays(10),
          returnDate: inDays(12),
          estimatedCost: 300,
          ...over,
        };
        if ('purpose' in over && over.purpose === undefined)
          delete payload.purpose;
        const res = await ctx
          .http()
          .post('/travel-requests')
          .set(bearer(fx.employee.token))
          .send(payload);
        expectStatus(res, 400, label);
      }
    });

    it('TRV-API-07 an itinerary is stored in leg order', async () => {
      const res = await trip(fx.employee.token, {
        itinerary: [
          { mode: 'FLIGHT', fromPlace: 'A', toPlace: 'B', startAt: new Date(inDays(10)).toISOString() },
          { mode: 'HOTEL', toPlace: 'B', startAt: new Date(inDays(10)).toISOString() },
        ],
      });
      expectStatus(res, 201);
      const legs = await ctx.prisma.travelItinerary.findMany({
        where: { travelId: dataOf(res).id },
        orderBy: { legOrder: 'asc' },
      });
      expect(legs.map((l) => [l.legOrder, l.mode])).toEqual([
        [1, 'FLIGHT'],
        [2, 'HOTEL'],
      ]);
    });

    it('TRV-API-08 only ADMIN/HR may file on behalf of someone else; others are silently filed as themselves', async () => {
      const onBehalf = await ctx
        .http()
        .post(`/travel-requests?employeeId=${fx.newJoinerId}`)
        .set(bearer(fx.hrScoped.token))
        .send({
          purpose: `on behalf ${fx.runId}`,
          travelType: 'DOMESTIC',
          destination: RATED_DESTINATION,
          departureDate: inDays(10),
          returnDate: inDays(12),
          estimatedCost: 100,
        });
      expectStatus(onBehalf, 201);
      const row = await ctx.prisma.travelRequest.findUnique({
        where: { id: dataOf(onBehalf).id },
      });
      expect(row!.employeeId).toBe(fx.newJoinerId);

      // An employee passing the same parameter is filed as themselves — the
      // override is ignored, not honoured and not refused.
      const attempted = await ctx
        .http()
        .post(`/travel-requests?employeeId=${fx.newJoinerId}`)
        .set(bearer(fx.employee.token))
        .send({
          purpose: `attempted ${fx.runId}`,
          travelType: 'DOMESTIC',
          destination: RATED_DESTINATION,
          departureDate: inDays(10),
          returnDate: inDays(12),
          estimatedCost: 100,
        });
      expectStatus(attempted, 201);
      const attemptedRow = await ctx.prisma.travelRequest.findUnique({
        where: { id: dataOf(attempted).id },
      });
      expect(attemptedRow!.employeeId).toBe(fx.employee.employeeId);
    });

    it('TRV-API-08b F23 — a user with no employee record is refused, with a sentence naming why', async () => {
      // `@Roles` on POST admits all four roles, so an ADMIN or HR account not
      // linked to an employee record may legitimately reach it. This used to
      // hand `where: { id: undefined }` to Prisma and come back a 500. Same
      // root cause as REI-API-10 and RPT-API-02b; one guard, three services.
      const res = await trip(fx.admin.token);
      expectStatus(res, [400, 404]);
      expect(String(res.body.message)).toMatch(/employee/i);
    });

    it('TRV-API-09 a branch-scoped caller cannot file for an employee in another branch', async () => {
      const res = await ctx
        .http()
        .post(`/travel-requests?employeeId=${fx.foreignId}`)
        .set(bearer(fx.hrScoped.token))
        .send({
          purpose: `cross branch ${fx.runId}`,
          travelType: 'DOMESTIC',
          destination: RATED_DESTINATION,
          departureDate: inDays(10),
          returnDate: inDays(12),
          estimatedCost: 100,
        });
      expectStatus(res, 404);
    });
  });

  // ── The dead kill switch ──────────────────────────────────────────────────
  describe('the module switch', () => {
    it('TRV-API-10 F7 — turning the module off refuses a new request', async () => {
      // `travel_enabled` was seeded, listed in the settings registry and shown
      // in the admin UI, and read by nothing: an admin who turned Travel off
      // watched trips carry on being filed, approved and paid. It now behaves
      // like its two siblings.
      await withSetting(ctx, 'travel_enabled', 'false', async () => {
        const res = await trip(fx.employee.token);
        expectStatus(res, 400);
        expect(String(res.body.message)).toMatch(/disabled/i);
      });

      // ...and lifts again, so the switch is a switch and not a one-way door.
      const after = await trip(fx.employee.token);
      expectStatus(after, 201);
    });
  });

  // ── Reading ───────────────────────────────────────────────────────────────
  describe('reading requests', () => {
    it('TRV-API-11 the full list is ADMIN/HR/MANAGER; an employee is refused', async () => {
      const expectations: Array<[string, string, number]> = [
        ['admin', fx.admin.token, 200],
        ['hrGlobal', fx.hrGlobal.token, 200],
        ['hrScoped', fx.hrScoped.token, 200],
        ['manager', fx.manager.token, 200],
        ['employee', fx.employee.token, 403],
      ];
      for (const [label, token, status] of expectations) {
        const res = await ctx
          .http()
          .get('/travel-requests')
          .set(bearer(token));
        expectStatus(res, status, label);
      }
      expect((await ctx.http().get('/travel-requests')).status).toBe(401);
    });

    it('TRV-API-12 my-requests is self-scoped for every role', async () => {
      await trip(fx.employee.token);
      for (const who of [fx.employee, fx.manager, fx.hrScoped]) {
        const res = await ctx
          .http()
          .get('/travel-requests/my-requests')
          .set(bearer(who.token));
        expectStatus(res, 200, who.email);
        const foreign = rowsOf(res)
          .filter((r) => r.employeeId !== who.employeeId)
          .map((r) => r.id);
        expect(foreign).toEqual([]);
      }
    });

    it('TRV-API-13 a branch-scoped HR does not see another branch’s trips', async () => {
      const foreign = await trip(fx.foreignEmployee.token);
      expectStatus(foreign, 201);
      const foreignId = dataOf(foreign).id;

      const scoped = await ctx
        .http()
        .get('/travel-requests')
        .set(bearer(fx.hrScoped.token));
      expect(idsOf(scoped)).not.toContain(foreignId);

      const global = await ctx
        .http()
        .get('/travel-requests')
        .set(bearer(fx.hrGlobal.token));
      expect(idsOf(global)).toContain(foreignId);
    });

    it('TRV-API-14 on-trip narrows a manager to their own departments', async () => {
      await ctx.prisma.travelRequest.create({
        data: {
          employeeId: fx.otherDeptEmployeeId,
          purpose: `other dept ${fx.runId}`,
          travelType: 'DOMESTIC',
          destination: RATED_DESTINATION,
          departureDate: new Date(inDays(1)),
          returnDate: new Date(inDays(3)),
          estimatedCost: 100,
          status: 'APPROVED',
        },
      });
      const mine = await ctx.prisma.travelRequest.create({
        data: {
          employeeId: fx.earnerId,
          purpose: `own dept ${fx.runId}`,
          travelType: 'DOMESTIC',
          destination: RATED_DESTINATION,
          departureDate: new Date(inDays(1)),
          returnDate: new Date(inDays(3)),
          estimatedCost: 100,
          status: 'APPROVED',
        },
      });

      const res = await ctx
        .http()
        .get(`/travel-requests/on-trip?from=${inDays(0)}&to=${inDays(5)}`)
        .set(bearer(fx.manager.token));
      expectStatus(res, 200);
      expect(idsOf(res)).toContain(mine.id);
      expect(
        rowsOf(res).filter((r) => r.employeeId === fx.otherDeptEmployeeId),
      ).toEqual([]);

      // An employee cannot see who is away at all.
      const emp = await ctx
        .http()
        .get(`/travel-requests/on-trip?from=${inDays(0)}&to=${inDays(5)}`)
        .set(bearer(fx.employee.token));
      expectStatus(emp, 403);
    });

    it('TRV-API-15 unknown id 404s; a malformed id is a client error, not a server fault', async () => {
      const unknown = await ctx
        .http()
        .get('/travel-requests/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token));
      expectStatus(unknown, 404);
      expect(unknown.body.message).toBe('Travel request not found');

      // `travel.controller.ts` puts a `ParseUUIDPipe` on `:id`, which is why
      // this one answers 400 rather than faulting on an unparseable key (F25).
      const malformed = await ctx
        .http()
        .get('/travel-requests/not-a-uuid')
        .set(bearer(fx.admin.token));
      expectStatus(malformed, 400);
    });

    it('TRV-API-16 F2 — an unrelated employee cannot read a colleague’s trip', async () => {
      const other = await pendingTrip({ employeeId: fx.otherDeptEmployeeId });

      // `findOne` used to assert the BRANCH and nothing else — no owner check,
      // no manager-scope check, the two that `decide` performs on the same row
      // — so any employee holding a UUID read a colleague's purpose, cost and
      // destination.
      const stranger = await ctx
        .http()
        .get(`/travel-requests/${other.id}`)
        .set(bearer(fx.auditor.token));
      expectStatus(stranger, 403);
      expect(stranger.body.message).toBe(
        'You do not have permission to view this travel request',
      );

      // The owner, ADMIN/HR and the department's own manager still read it.
      const ownerTrip = await pendingTrip();
      for (const who of [fx.employee, fx.admin, fx.hrGlobal, fx.manager]) {
        const ok = await ctx
          .http()
          .get(`/travel-requests/${ownerTrip.id}`)
          .set(bearer(who.token));
        expectStatus(ok, 200, who.email);
      }
    });


    it('TRV-API-17 a cross-branch read by id answers 404', async () => {
      const foreign = await pendingTrip({ employeeId: fx.foreignId });
      const res = await ctx
        .http()
        .get(`/travel-requests/${foreign.id}`)
        .set(bearer(fx.hrScoped.token));
      expectStatus(res, 404);
    });
  });

  // ── Deciding ──────────────────────────────────────────────────────────────
  describe('deciding a request', () => {
    it('TRV-API-18 approval is gated by the SETTING, not the decorator', async () => {
      const t1 = await pendingTrip();
      // MANAGER passes @Roles (all four roles are allowed) and fails the
      // setting, whose default is HR_MANAGER,ADMIN.
      const refused = await ctx
        .http()
        .post(`/travel-requests/${t1.id}/approve`)
        .set(bearer(fx.manager.token))
        .send({});
      expectStatus(refused, 403);
      expect(refused.body.message).toBe(
        'Your role is not configured to approve travel requests',
      );

      // Flip the setting and the same manager decides the same trip.
      await withSetting(ctx, 'travel_approver_roles', 'MANAGER', async () => {
        const ok = await ctx
          .http()
          .post(`/travel-requests/${t1.id}/approve`)
          .set(bearer(fx.manager.token))
          .send({});
        expectStatus(ok, 201);

        // ...and HR, which could a moment ago, now cannot.
        const t2 = await pendingTrip();
        const hr = await ctx
          .http()
          .post(`/travel-requests/${t2.id}/approve`)
          .set(bearer(fx.hrGlobal.token))
          .send({});
        expectStatus(hr, 403);
      });
    });

    it('TRV-API-19 a manager approver is confined to their own department', async () => {
      const foreignDept = await pendingTrip({
        employeeId: fx.otherDeptEmployeeId,
      });
      await withSetting(
        ctx,
        'travel_approver_roles',
        'MANAGER,HR_MANAGER,ADMIN',
        async () => {
          const res = await ctx
            .http()
            .post(`/travel-requests/${foreignDept.id}/approve`)
            .set(bearer(fx.manager.token))
            .send({});
          expectStatus(res, 403);
          expect(res.body.message).toBe(
            'You can only review travel requests from your own department',
          );
        },
      );
    });

    it('TRV-API-20 a settled request cannot be decided again, and says which state it is in', async () => {
      const t = await pendingTrip();
      const first = await ctx
        .http()
        .post(`/travel-requests/${t.id}/approve`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(first, 201);

      for (const verb of ['approve', 'reject']) {
        const again = await ctx
          .http()
          .post(`/travel-requests/${t.id}/${verb}`)
          .set(bearer(fx.admin.token))
          .send({ remarks: 'again' });
        expectStatus(again, 400, verb);
        expect(again.body.message).toBe(
          'Cannot decide a approved travel request',
        );
      }
    });

    it('TRV-API-21 rejection stores its reason and releases the budget commitment', async () => {
      const t = await pendingTrip();
      const res = await ctx
        .http()
        .post(`/travel-requests/${t.id}/reject`)
        .set(bearer(fx.admin.token))
        .send({ remarks: 'Client meeting moved' });
      expectStatus(res, 201);

      const row = await ctx.prisma.travelRequest.findUnique({
        where: { id: t.id },
      });
      expect(row!.status).toBe('REJECTED');
      expect(row!.rejectedReason).toBe('Client meeting moved');

      // Rejected money was never going to be spent.
      const open = (await commitmentsFor(t.id)).filter(
        (c) => c.status === 'OPEN',
      );
      expect(open).toEqual([]);
    });

    it('TRV-API-22 F12 — the declared status set matches the reachable one', async () => {
      // `COMPLETED` was declared, offered by the screen's status filter and
      // read by `findOnTrip`, and written by nothing — a filter option that
      // could only ever match zero rows. Same class as the Organization
      // CANCELLED finding, and removed rather than back-filled: nothing in the
      // product marks a trip as having happened, so inventing a value for it
      // would have been worse than admitting the gap.
      const res = await ctx
        .http()
        .get('/travel-requests?status=COMPLETED')
        .set(bearer(fx.admin.token));
      expectStatus(res, 400);

      // Every remaining status IS reachable, which is the other half of the
      // claim: PENDING and APPROVED below, REJECTED in TRV-API-21, CANCELLED
      // in TRV-API-31.
      for (const status of ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) {
        const ok = await ctx
          .http()
          .get(`/travel-requests?status=${status}`)
          .set(bearer(fx.admin.token));
        expectStatus(ok, 200, status);
      }
    });
  });

  // ── Approval side effects ─────────────────────────────────────────────────
  describe('what approval actually does', () => {
    it('TRV-API-27 approval commits the estimated cost against the department’s budget line', async () => {
      const t = await pendingTrip({ estimatedCost: 450 });
      await ctx
        .http()
        .post(`/travel-requests/${t.id}/approve`)
        .set(bearer(fx.admin.token))
        .send({});

      const commitments = await commitmentsFor(t.id);
      expect(commitments).toHaveLength(1);
      expect(commitments[0].status).toBe('OPEN');
      expect(Number(commitments[0].amount)).toBe(450);
      // The department-specific line wins over the company-wide fallback.
      expect(commitments[0].budgetLineId).toBe(fx.budgetDeptLineId);
    });

    it('TRV-API-28 an international trip with no covering visa notifies HR', async () => {
      const before = await ctx.prisma.notification.count({
        where: { userId: fx.hrGlobal.userId },
      });

      const t = await pendingTrip({
        travelType: 'INTERNATIONAL',
        country: 'IN',
      });
      await ctx
        .http()
        .post(`/travel-requests/${t.id}/approve`)
        .set(bearer(fx.admin.token))
        .send({});

      const after = await ctx.prisma.notification.count({
        where: { userId: fx.hrGlobal.userId },
      });
      expect(after).toBeGreaterThan(before);
    });

    it('TRV-API-29 budgeting never blocks an approval', async () => {
      // A trip whose department and category match no budget line at all. The
      // commitment ledger swallows the miss and logs it; the approval must
      // still succeed, because a budgeting gap is a reporting problem and not
      // a reason to strand a traveller.
      const t = await pendingTrip({ destination: 'Atlantis', perDiemRate: null });
      await ctx.prisma.budget.update({
        where: { id: fx.budgetId },
        data: { status: 'CLOSED' },
      });
      try {
        const res = await ctx
          .http()
          .post(`/travel-requests/${t.id}/approve`)
          .set(bearer(fx.admin.token))
          .send({});
        expectStatus(res, 201);
        expect(await commitmentsFor(t.id)).toEqual([]);
      } finally {
        await ctx.prisma.budget.update({
          where: { id: fx.budgetId },
          data: { status: 'ACTIVE' },
        });
      }
    });

    it('TRV-API-30 F9 — with no chain configured, a trip WAITS for a human and spends nothing', async () => {
      // `create` used to treat `!engaged` as "approve now". Approving a trip is
      // what commits money against a budget, so an admin who deactivated a
      // TRAVEL workflow was not falling back to manual approval, they were
      // falling back to NO approval.
      const res = await trip(fx.employee.token);
      expectStatus(res, 201);
      const id = dataOf(res).id;

      const row = await ctx.prisma.travelRequest.findUnique({ where: { id } });
      expect(row!.status).toBe('PENDING');
      expect(await commitmentsFor(id)).toEqual([]);

      // ...and an approver can still settle it through the legacy path.
      expectStatus(
        await ctx
          .http()
          .post(`/travel-requests/${id}/approve`)
          .set(bearer(fx.admin.token))
          .send({}),
        201,
      );
      expect(
        (await ctx.prisma.travelRequest.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('APPROVED');
      expect((await commitmentsFor(id)).length).toBe(1);
    });
  });

  // ── Cancelling ────────────────────────────────────────────────────────────
  describe('cancelling', () => {
    it('TRV-API-31 the owner cancels; a stranger cannot; ADMIN and HR can', async () => {
      const own = await pendingTrip();
      const stranger = await ctx
        .http()
        .delete(`/travel-requests/${own.id}`)
        .set(bearer(fx.manager.token));
      expectStatus(stranger, 403);
      expect(stranger.body.message).toBe(
        'Not permitted to cancel this travel request',
      );

      const owner = await ctx
        .http()
        .delete(`/travel-requests/${own.id}`)
        .set(bearer(fx.employee.token));
      expectStatus(owner, 200);

      const byHr = await pendingTrip();
      expectStatus(
        await ctx
          .http()
          .delete(`/travel-requests/${byHr.id}`)
          .set(bearer(fx.hrGlobal.token)),
        200,
      );
    });

    it('TRV-API-32 cancelling an approved trip releases the budget it committed', async () => {
      const t = await pendingTrip();
      await ctx
        .http()
        .post(`/travel-requests/${t.id}/approve`)
        .set(bearer(fx.admin.token))
        .send({});
      expect((await commitmentsFor(t.id)).length).toBe(1);

      const res = await ctx
        .http()
        .delete(`/travel-requests/${t.id}`)
        .set(bearer(fx.employee.token));
      expectStatus(res, 200);

      const open = (await commitmentsFor(t.id)).filter(
        (c) => c.status === 'OPEN',
      );
      expect(open).toEqual([]);
    });

    it('TRV-API-34 a settled request cannot be cancelled', async () => {
      const t = await pendingTrip();
      await ctx
        .http()
        .post(`/travel-requests/${t.id}/reject`)
        .set(bearer(fx.admin.token))
        .send({ remarks: 'no' });

      const res = await ctx
        .http()
        .delete(`/travel-requests/${t.id}`)
        .set(bearer(fx.employee.token));
      expectStatus(res, 400);
      expect(res.body.message).toBe(
        'Cannot cancel a rejected travel request',
      );
    });
  });

  // ── Boundaries with other modules ─────────────────────────────────────────
  describe('boundaries', () => {
    it('TRV-API-35 a trip writes no attendance and no leave', async () => {
      const before = await Promise.all([
        ctx.prisma.attendance.count({ where: { employeeId: fx.earnerId } }),
        ctx.prisma.leaveRequest.count({ where: { employeeId: fx.earnerId } }),
      ]);
      const t = await pendingTrip();
      await ctx
        .http()
        .post(`/travel-requests/${t.id}/approve`)
        .set(bearer(fx.admin.token))
        .send({});
      const after = await Promise.all([
        ctx.prisma.attendance.count({ where: { employeeId: fx.earnerId } }),
        ctx.prisma.leaveRequest.count({ where: { employeeId: fx.earnerId } }),
      ]);
      expect(after).toEqual(before);
    });

    it('TRV-API-36 editing the destination rate afterwards does not change an approved trip', async () => {
      const t = await pendingTrip();
      await ctx
        .http()
        .post(`/travel-requests/${t.id}/approve`)
        .set(bearer(fx.admin.token))
        .send({});
      await ctx.prisma.libraryItem.update({
        where: { id: fx.ratedDestinationId },
        data: { perDiemRate: 999 },
      });
      try {
        const row = await ctx.prisma.travelRequest.findUnique({
          where: { id: t.id },
        });
        expect(Number(row!.perDiemRate)).toBe(25);
      } finally {
        await ctx.prisma.libraryItem.update({
          where: { id: fx.ratedDestinationId },
          data: { perDiemRate: 25 },
        });
      }
    });
  });

  // ── Every refusal explains itself ─────────────────────────────────────────
  describe('every refusal explains itself', () => {
    const GENERIC =
      /^(bad request|forbidden|not found|conflict|error|internal server error)$/i;

    it('TRV-API-37 every reachable refusal carries a specific sentence', async () => {
      // REJECTED, not APPROVED — an approved trip is still cancellable, which
      // is the point of TRV-API-32.
      const settled = await pendingTrip();
      await ctx
        .http()
        .post(`/travel-requests/${settled.id}/reject`)
        .set(bearer(fx.admin.token))
        .send({ remarks: 'not this quarter' });
      const open = await pendingTrip();

      const probes: Array<[string, () => Promise<any>]> = [
        [
          'return before departure',
          () =>
            trip(fx.employee.token, {
              departureDate: inDays(12),
              returnDate: inDays(10),
            }),
        ],
        [
          'decide a settled trip',
          () =>
            ctx
              .http()
              .post(`/travel-requests/${settled.id}/approve`)
              .set(bearer(fx.admin.token))
              .send({}),
        ],
        [
          'cancel a rejected trip',
          () =>
            ctx
              .http()
              .delete(`/travel-requests/${settled.id}`)
              .set(bearer(fx.employee.token)),
        ],
        [
          'cancel a trip you do not own',
          () =>
            ctx
              .http()
              .delete(`/travel-requests/${open.id}`)
              .set(bearer(fx.manager.token)),
        ],
        [
          'approve without the configured role',
          () =>
            ctx
              .http()
              .post(`/travel-requests/${open.id}/approve`)
              .set(bearer(fx.manager.token))
              .send({}),
        ],
        [
          'unknown id',
          () =>
            ctx
              .http()
              .get('/travel-requests/00000000-0000-0000-0000-000000000000')
              .set(bearer(fx.admin.token)),
        ],
      ];

      const offenders: string[] = [];
      for (const [label, call] of probes) {
        const res = await call();
        if (res.status < 400) {
          throw new Error(`${label} did not refuse: ${body(res)}`);
        }
        const message = Array.isArray(res.body?.message)
          ? res.body.message.join('; ')
          : res.body?.message;
        if (!message || String(message).trim().length < 10) {
          offenders.push(`${label}: empty or too short (${message})`);
        } else if (GENERIC.test(String(message).trim())) {
          offenders.push(`${label}: generic (${message})`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  // ── Audit ─────────────────────────────────────────────────────────────────
  describe('audit', () => {
    it('TRV-API-38 request, approve, reject and cancel are each audited with their actor', async () => {
      const approved = await pendingTrip();
      await ctx
        .http()
        .post(`/travel-requests/${approved.id}/approve`)
        .set(bearer(fx.admin.token))
        .send({});
      const rejected = await pendingTrip();
      await ctx
        .http()
        .post(`/travel-requests/${rejected.id}/reject`)
        .set(bearer(fx.admin.token))
        .send({ remarks: 'no' });
      const cancelled = await pendingTrip();
      await ctx
        .http()
        .delete(`/travel-requests/${cancelled.id}`)
        .set(bearer(fx.employee.token));

      const rows = await ctx.prisma.auditLog.findMany({
        where: {
          resourceType: 'TravelRequest',
          resourceId: { in: [approved.id, rejected.id, cancelled.id] },
        },
      });
      const actions = new Set(rows.map((r) => r.action));
      expect(actions.has('TRAVEL_APPROVED')).toBe(true);
      expect(actions.has('TRAVEL_REJECTED')).toBe(true);
      expect(actions.has('TRAVEL_CANCELLED')).toBe(true);
      expect(rows.every((r) => !!r.userId)).toBe(true);
    });
  });
});
