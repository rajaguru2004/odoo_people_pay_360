import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
  RATED_DESTINATION,
} from './utils/finance-fixtures';
import { bearer } from './utils/settings';

/**
 * The Change Request lifecycle, over Finance.
 *
 * Two of the Finance areas are governed by the shared approval engine —
 * `TRAVEL` and `BANK_CHANGE` — and until this file **not one test anywhere
 * drove a multi-step chain over either of them.** The e2e baseline pins
 * `supervisor_approval_enabled = 'false'`, so every other suite in the repo,
 * including the five Finance ones beside this, exercises only the legacy
 * single-approver path. The chain is the product's answer to "who signs off on
 * company money", and it was untested for the request kinds that move it.
 *
 * The engine's contract, which shapes every case here:
 *
 *   - It is **engaged** only when the master switch is on AND an active
 *     `ApprovalWorkflow` exists for the type. Otherwise callers keep their
 *     legacy path — which is NOT the same as no approval at all, and is
 *     finding F9, pinned in `finance-travel.e2e-spec.ts`.
 *   - It runs **no domain side-effects**. The calling service does those when
 *     `finalized && outcome === 'APPROVED'`. So "the chain finished" and "the
 *     money moved" are two assertions, and a test that makes only the first
 *     proves nothing a user would notice.
 *   - `RequestApproval` is polymorphic with **no foreign key** to the domain
 *     row, so a deleted request leaves an orphan trail. The engine treats an
 *     unresolvable requester as "not actionable" rather than throwing, which is
 *     what stops one bad row wedging an approver's whole queue.
 *
 * The switch is global and the suite runs `maxWorkers: 1`, so this file must
 * put it back exactly as it found it — see `afterAll`.
 */
describe('Finance — the Change Request lifecycle (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any): any => res.body?.data ?? res.body;
  const rowsOf = (res: any): any[] => {
    const d = dataOf(res);
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

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

  const workflowIds: string[] = [];

  /**
   * Installs a chain for one request type. `PUT /approval-workflows` upserts by
   * type, so a later call replaces an earlier one rather than stacking.
   */
  const setChain = async (
    requestType: 'TRAVEL' | 'BANK_CHANGE',
    approverTypes: Array<'SUPERVISOR' | 'MANAGER' | 'HR_MANAGER' | 'ADMIN'>,
    mode: 'SEQUENTIAL' | 'PARALLEL' = 'SEQUENTIAL',
  ) => {
    const res = await ctx
      .http()
      .put('/approval-workflows')
      .set(bearer(fx.admin.token))
      .send({
        requestType,
        name: `wf-${requestType.toLowerCase()}-${fx.runId}`,
        mode,
        steps: approverTypes.map((approverType) => ({ approverType })),
      });
    expectStatus(res, [200, 201], `configure ${requestType}`);
    const id = dataOf(res)?.id;
    if (id && !workflowIds.includes(id)) workflowIds.push(id);
    return id as string;
  };

  const setSwitch = (value: 'true' | 'false') =>
    ctx
      .http()
      .post('/system-settings')
      .set(bearer(fx.admin.token))
      .send({ settings: { supervisor_approval_enabled: value } });

  const trailFor = (
    requestType: string,
    requestId: string,
  ) =>
    ctx.prisma.requestApproval.findMany({
      where: { requestType: requestType as any, requestId },
      orderBy: { stepOrder: 'asc' },
    });

  // ── The request factory ───────────────────────────────────────────────────
  const raiseTravel = async () =>
    ctx
      .http()
      .post('/travel-requests')
      .set(bearer(fx.employee.token))
      .send({
        purpose: `chain e2e ${fx.runId}`,
        travelType: 'DOMESTIC',
        destination: RATED_DESTINATION,
        departureDate: inDays(10),
        returnDate: inDays(12),
        estimatedCost: 250,
      });

  /**
   * The surviving domain side effect of a travel approval: `travel.service.ts`
   * commits the estimated cost against the department's budget line. It is what
   * separates "the chain closed" from "the money moved".
   */
  const commitmentsFor = (travelId: string) =>
    ctx.prisma.budgetCommitment.findMany({
      where: { sourceType: 'TRAVEL', sourceId: travelId },
    });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);

    // The requester's supervisor is the department manager, so a SUPERVISOR
    // step has somebody to resolve to. Without this the first step resolves to
    // an empty approver set, which is a different case (CR-API-14).
    await ctx.prisma.employee.update({
      where: { id: fx.earnerId },
      data: { supervisorId: fx.manager.employeeId },
    });

    await setSwitch('true');
  }, 120000);

  afterAll(async () => {
    // Global state. Put it back as the baseline pins it, or every suite that
    // runs after this one inherits a chain it never asked for.
    if (ctx) {
      await setSwitch('false').catch(() => undefined);
      for (const id of workflowIds) {
        await ctx.prisma.approvalStep
          .deleteMany({ where: { workflowId: id } })
          .catch(() => undefined);
        await ctx.prisma.approvalWorkflow
          .delete({ where: { id } })
          .catch(() => undefined);
      }
      await ctx.prisma.requestApproval
        .deleteMany({
          where: { requestType: { in: ['TRAVEL', 'BANK_CHANGE'] } },
        })
        .catch(() => undefined);
    }
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Configuring a chain ───────────────────────────────────────────────────
  describe('configuring the chain', () => {
    it('CR-API-01 only ADMIN may write a workflow; HR may read one', async () => {
      const write = await ctx
        .http()
        .put('/approval-workflows')
        .set(bearer(fx.hrGlobal.token))
        .send({
          requestType: 'TRAVEL',
          steps: [{ approverType: 'HR_MANAGER' }],
        });
      expectStatus(write, 403);

      const read = await ctx
        .http()
        .get('/approval-workflows')
        .set(bearer(fx.hrGlobal.token));
      expectStatus(read, 200);

      for (const who of [fx.manager, fx.employee]) {
        expectStatus(
          await ctx
            .http()
            .get('/approval-workflows')
            .set(bearer(who.token)),
          403,
          who.email,
        );
      }
    });

    it('CR-API-02 the governable kinds include both Finance ones', async () => {
      const res = await ctx
        .http()
        .get('/approval-workflows/kinds')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
      const kinds = JSON.stringify(dataOf(res));
      for (const kind of ['TRAVEL', 'BANK_CHANGE']) {
        expect(kinds).toContain(kind);
      }
    });

    it('CR-API-03 an unknown request type and an empty step list are both refused', async () => {
      const badType = await ctx
        .http()
        .put('/approval-workflows')
        .set(bearer(fx.admin.token))
        .send({ requestType: 'PARKING', steps: [{ approverType: 'ADMIN' }] });
      expectStatus(badType, 400);

      const noSteps = await ctx
        .http()
        .put('/approval-workflows')
        .set(bearer(fx.admin.token))
        .send({ requestType: 'TRAVEL', steps: [] });
      expectStatus(noSteps, 400);

      const badApprover = await ctx
        .http()
        .put('/approval-workflows')
        .set(bearer(fx.admin.token))
        .send({
          requestType: 'TRAVEL',
          steps: [{ approverType: 'CEO' }],
        });
      expectStatus(badApprover, 400);
    });
  });

  // ── The sequential chain ──────────────────────────────────────────────────
  describe('a sequential chain, end to end', () => {
    it('CR-API-04 a governed travel request WAITS, and the trail materialises one row per step', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER']);
      const res = await raiseTravel();
      expectStatus(res, 201);
      const id = dataOf(res).id;

      const row = await ctx.prisma.travelRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('PENDING');

      // No side effects yet: the money must not move until the chain finishes.
      expect(await commitmentsFor(id)).toEqual([]);

      const trail = await trailFor('TRAVEL', id);
      expect(trail).toHaveLength(2);
      expect(trail.map((t) => t.status)).toEqual(['ACTIVE', 'PENDING']);
      expect(trail.map((t) => t.approverType)).toEqual([
        'SUPERVISOR',
        'HR_MANAGER',
      ]);
    });

    it('CR-API-05 step 1 approving activates step 2 and finalises nothing', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER']);
      const id = dataOf(await raiseTravel()).id;

      // The supervisor is the department manager (set in beforeAll).
      const step1 = await ctx
        .http()
        .post(`/travel-requests/${id}/approve`)
        .set(bearer(fx.manager.token))
        .send({ remarks: 'ok from the supervisor' });
      expectStatus(step1, 201);

      const row = await ctx.prisma.travelRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('PENDING');
      expect(await commitmentsFor(id)).toEqual([]);

      const trail = await trailFor('TRAVEL', id);
      expect(trail[0].status).toBe('APPROVED');
      expect(trail[0].decidedById).toBe(fx.manager.userId);
      expect(trail[1].status).toBe('ACTIVE');
    });

    it('CR-API-06 the LAST step finalises the chain AND fires the domain side effects', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER']);
      const id = dataOf(await raiseTravel()).id;

      expectStatus(
        await ctx
          .http()
          .post(`/travel-requests/${id}/approve`)
          .set(bearer(fx.manager.token))
          .send({}),
        201,
      );
      expectStatus(
        await ctx
          .http()
          .post(`/travel-requests/${id}/approve`)
          .set(bearer(fx.hrGlobal.token))
          .send({ remarks: 'HR sign-off' }),
        201,
      );

      const row = await ctx.prisma.travelRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('APPROVED');
      // The engine runs no side effects — the DOMAIN does, once. This is the
      // assertion that separates "the chain closed" from "the money moved".
      expect(await commitmentsFor(id)).toHaveLength(1);

      const trail = await trailFor('TRAVEL', id);
      expect(trail.map((t) => t.status)).toEqual(['APPROVED', 'APPROVED']);
    });

    it('CR-API-07 an approver at a not-yet-active step is refused', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER']);
      const id = dataOf(await raiseTravel()).id;

      // HR is step 2; step 1 has not been decided.
      const early = await ctx
        .http()
        .post(`/travel-requests/${id}/approve`)
        .set(bearer(fx.hrGlobal.token))
        .send({});
      expectStatus(early, 403);
      expect(String(early.body.message)).toMatch(/eligible approver/i);

      // ...and the request is untouched.
      expect(
        (await ctx.prisma.travelRequest.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('PENDING');
    });

    it('CR-API-08 somebody outside the chain entirely is refused', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER']);
      const id = dataOf(await raiseTravel()).id;

      const outsider = await ctx
        .http()
        .post(`/travel-requests/${id}/approve`)
        .set(bearer(fx.foreignManager.token))
        .send({});
      expectStatus(outsider, [403, 404]);
    });

    it('CR-API-09 the first REJECTION finalises the whole chain', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER']);
      const id = dataOf(await raiseTravel()).id;

      const reject = await ctx
        .http()
        .post(`/travel-requests/${id}/reject`)
        .set(bearer(fx.manager.token))
        .send({ remarks: 'no budget this quarter' });
      expectStatus(reject, 201);

      const row = await ctx.prisma.travelRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('REJECTED');
      expect(row.rejectedReason).toBe('no budget this quarter');
      expect(await commitmentsFor(id)).toEqual([]);

      const trail = await trailFor('TRAVEL', id);
      expect(trail[0].status).toBe('REJECTED');
      // A step that will never be reached must not sit ACTIVE forever in
      // somebody's queue.
      expect(['SKIPPED', 'PENDING']).toContain(trail[1].status);
      expect(trail[1].status).not.toBe('ACTIVE');
    });

    it('CR-API-10 a settled request cannot be decided again by anyone in the chain', async () => {
      await setChain('TRAVEL', ['SUPERVISOR']);
      const id = dataOf(await raiseTravel()).id;
      expectStatus(
        await ctx
          .http()
          .post(`/travel-requests/${id}/approve`)
          .set(bearer(fx.manager.token))
          .send({}),
        201,
      );

      const again = await ctx
        .http()
        .post(`/travel-requests/${id}/approve`)
        .set(bearer(fx.manager.token))
        .send({});
      expectStatus(again, 400);
    });
  });

  // ── The parallel chain ────────────────────────────────────────────────────
  describe('a parallel chain', () => {
    it('CR-API-11 every step activates at once and the LAST approval finalises', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER'], 'PARALLEL');
      const id = dataOf(await raiseTravel()).id;

      const trail = await trailFor('TRAVEL', id);
      expect(trail.map((t) => t.status)).toEqual(['ACTIVE', 'ACTIVE']);

      // Decided in the reverse of the declared order, which a parallel chain
      // must accept.
      expectStatus(
        await ctx
          .http()
          .post(`/travel-requests/${id}/approve`)
          .set(bearer(fx.hrGlobal.token))
          .send({}),
        201,
      );
      expect(
        (await ctx.prisma.travelRequest.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('PENDING');

      expectStatus(
        await ctx
          .http()
          .post(`/travel-requests/${id}/approve`)
          .set(bearer(fx.manager.token))
          .send({}),
        201,
      );
      expect(
        (await ctx.prisma.travelRequest.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('APPROVED');
      expect(await commitmentsFor(id)).toHaveLength(1);
    });

    it('CR-API-12 one rejection finalises a parallel chain too', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER'], 'PARALLEL');
      const id = dataOf(await raiseTravel()).id;

      expectStatus(
        await ctx
          .http()
          .post(`/travel-requests/${id}/reject`)
          .set(bearer(fx.hrGlobal.token))
          .send({ remarks: 'declined' }),
        201,
      );
      expect(
        (await ctx.prisma.travelRequest.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('REJECTED');

      // The other outstanding step must stop being actionable.
      const late = await ctx
        .http()
        .post(`/travel-requests/${id}/approve`)
        .set(bearer(fx.manager.token))
        .send({});
      expectStatus(late, 400);
    });
  });

  // ── Resolution edge cases ─────────────────────────────────────────────────
  describe('resolving approvers', () => {
    it('CR-API-13 a requester who IS the resolved approver does not approve their own request', async () => {
      // The manager is their own department's manager. A chain whose only step
      // resolves to the requester must not simply let them sign their own
      // money off — the engine skips the step rather than self-approving.
      await setChain('TRAVEL', ['MANAGER']);
      const res = await ctx
        .http()
        .post('/travel-requests')
        .set(bearer(fx.manager.token))
        .send({
          purpose: `self chain ${fx.runId}`,
          travelType: 'DOMESTIC',
          destination: RATED_DESTINATION,
          departureDate: inDays(10),
          returnDate: inDays(12),
          estimatedCost: 100,
        });
      expectStatus(res, 201);
      const id = dataOf(res).id;

      const trail = await trailFor('TRAVEL', id);
      const selfDecided = trail.filter(
        (t) => t.status === 'APPROVED' && t.decidedById === fx.manager.userId,
      );
      expect(selfDecided).toEqual([]);
    });

    it('CR-API-14 a step with nobody to resolve to does not wedge the request', async () => {
      // `newJoiner` has no supervisor. A SUPERVISOR step therefore resolves to
      // an empty set. Whatever the engine does with that, the request must not
      // end up ACTIVE-forever with no possible approver — an unactionable row
      // in nobody's queue is the worst outcome of the three.
      await ctx.prisma.employee.update({
        where: { id: fx.newJoinerId },
        data: { supervisorId: null },
      });
      await setChain('TRAVEL', ['SUPERVISOR']);

      const res = await ctx
        .http()
        .post(`/travel-requests?employeeId=${fx.newJoinerId}`)
        .set(bearer(fx.admin.token))
        .send({
          purpose: `orphan chain ${fx.runId}`,
          travelType: 'DOMESTIC',
          destination: RATED_DESTINATION,
          departureDate: inDays(10),
          returnDate: inDays(12),
          estimatedCost: 100,
        });
      expectStatus(res, 201);
      const id = dataOf(res).id;

      const row = await ctx.prisma.travelRequest.findUniqueOrThrow({
        where: { id },
      });
      const trail = await trailFor('TRAVEL', id);
      const stuck =
        row.status === 'PENDING' &&
        trail.some((t) => t.status === 'ACTIVE' && !t.resolvedApproverId);
      expect(stuck).toBe(false);
    });
  });

  // ── Abandoning ────────────────────────────────────────────────────────────
  describe('abandoning a chain', () => {
    it('CR-API-15 cancelling mid-chain closes the trail and the request', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER']);
      const id = dataOf(await raiseTravel()).id;

      expectStatus(
        await ctx
          .http()
          .delete(`/travel-requests/${id}`)
          .set(bearer(fx.employee.token)),
        200,
      );
      expect(
        (await ctx.prisma.travelRequest.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('CANCELLED');

      const trail = await trailFor('TRAVEL', id);
      expect(trail.filter((t) => t.status === 'ACTIVE')).toEqual([]);
    });

    it('CR-API-16 an abandoned request cannot then be approved', async () => {
      await setChain('TRAVEL', ['SUPERVISOR']);
      const id = dataOf(await raiseTravel()).id;
      await ctx
        .http()
        .delete(`/travel-requests/${id}`)
        .set(bearer(fx.employee.token));

      const late = await ctx
        .http()
        .post(`/travel-requests/${id}/approve`)
        .set(bearer(fx.manager.token))
        .send({});
      expectStatus(late, [400, 403]);
    });
  });

  // ── The switch and the workflow flag ──────────────────────────────────────
  describe('engagement', () => {
    it('CR-API-17 F9 — with the workflow DEACTIVATED, travel falls back to a HUMAN, not to nothing', async () => {
      // F9, seen from the chain side. Deactivating a workflow used to fall back
      // to NO approval at all — the trip's budget commitment fired on submit,
      // with nobody having agreed to it. It now falls back to the legacy
      // single-approver path: a human still decides, and the money still waits
      // for that decision.
      const workflowId = await setChain('TRAVEL', ['SUPERVISOR']);
      expectStatus(
        await ctx
          .http()
          .patch(`/approval-workflows/${workflowId}/active`)
          .set(bearer(fx.admin.token))
          .send({ isActive: false }),
        200,
      );

      const id = dataOf(await raiseTravel()).id;
      const row = await ctx.prisma.travelRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('PENDING');
      expect(await commitmentsFor(id)).toEqual([]);
      // No trail: the engine is disengaged, so there is nothing for it to own.
      expect(await trailFor('TRAVEL', id)).toEqual([]);

      // An approver settles it through the legacy path, and only then does the
      // money move.
      expectStatus(
        await ctx
          .http()
          .post(`/travel-requests/${id}/approve`)
          .set(bearer(fx.admin.token))
          .send({}),
        201,
      );
      expect(await commitmentsFor(id)).toHaveLength(1);
    });

    it('CR-API-19 turning the master switch off disengages every kind at once', async () => {
      await setChain('TRAVEL', ['SUPERVISOR']);
      await setSwitch('false');
      try {
        const id = dataOf(await raiseTravel()).id;
        // Disengaged: no trail, and the legacy approver decides.
        expect(
          (await ctx.prisma.travelRequest.findUniqueOrThrow({ where: { id } }))
            .status,
        ).toBe('PENDING');
        expect(await trailFor('TRAVEL', id)).toEqual([]);
      } finally {
        await setSwitch('true');
      }
    });
  });

  // ── The inbox ─────────────────────────────────────────────────────────────
  describe('the approver inbox', () => {
    it('CR-API-22 the inbox shows a governed Finance request to the approver of its ACTIVE step', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER']);
      const id = dataOf(await raiseTravel()).id;

      const mgrInbox = await ctx
        .http()
        .get('/approval-workflows/inbox')
        .set(bearer(fx.manager.token));
      expectStatus(mgrInbox, 200);
      expect(JSON.stringify(dataOf(mgrInbox))).toContain(id);

      // HR is step 2 and must not see it yet — an inbox that lists what its
      // owner cannot action is worse than an empty one.
      const hrInbox = await ctx
        .http()
        .get('/approval-workflows/inbox')
        .set(bearer(fx.hrGlobal.token));
      expectStatus(hrInbox, 200);
      expect(JSON.stringify(dataOf(hrInbox))).not.toContain(id);
    });

    it('CR-API-23 a settled request leaves the inbox', async () => {
      await setChain('TRAVEL', ['SUPERVISOR']);
      const id = dataOf(await raiseTravel()).id;
      await ctx
        .http()
        .post(`/travel-requests/${id}/approve`)
        .set(bearer(fx.manager.token))
        .send({});

      const inbox = await ctx
        .http()
        .get('/approval-workflows/inbox')
        .set(bearer(fx.manager.token));
      expectStatus(inbox, 200);
      expect(JSON.stringify(dataOf(inbox))).not.toContain(id);
    });

    it('CR-API-24 the inbox never carries bank account values', async () => {
      // `APPROVAL_KINDS.BANK_CHANGE.hydrate` deliberately omits them: an
      // approver decides on the FACT of a change, not on the payment details.
      const inbox = await ctx
        .http()
        .get('/approval-workflows/inbox')
        .set(bearer(fx.hrGlobal.token));
      expectStatus(inbox, 200);
      const json = JSON.stringify(dataOf(inbox));
      expect(json).not.toMatch(/"iban"\s*:/i);
      expect(json).not.toMatch(/"accountNumber"\s*:/i);
    });

    it('CR-API-25 the trail is readable, and reports who decided what', async () => {
      await setChain('TRAVEL', ['SUPERVISOR', 'HR_MANAGER']);
      const id = dataOf(await raiseTravel()).id;
      await ctx
        .http()
        .post(`/travel-requests/${id}/approve`)
        .set(bearer(fx.manager.token))
        .send({ remarks: 'supervisor ok' });

      const trail = await ctx
        .http()
        .get(`/approval-workflows/trail/TRAVEL/${id}`)
        .set(bearer(fx.employee.token));
      expectStatus(trail, 200);
      const json = JSON.stringify(dataOf(trail));
      expect(json).toContain('APPROVED');
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────
  describe('two approvers at once', () => {
    it('CR-API-26 a step decided twice in parallel resolves exactly once', async () => {
      await setChain('TRAVEL', ['HR_MANAGER']);
      const id = dataOf(await raiseTravel()).id;

      const [a, b] = await Promise.all([
        ctx
          .http()
          .post(`/travel-requests/${id}/approve`)
          .set(bearer(fx.hrGlobal.token))
          .send({ remarks: 'A' }),
        ctx
          .http()
          .post(`/travel-requests/${id}/reject`)
          .set(bearer(fx.hrScoped.token))
          .send({ remarks: 'B' }),
      ]);

      // Exactly one arm may win. This used to be an intermittent product race
      // (roughly 1 run in 7): both callers read PENDING, the approve arm
      // committed the trip's cost against the budget, and the reject arm then
      // won the status write — leaving a trip that was refused AND funded. The
      // decision paths now claim the transition with a conditional update
      // before they spend anything, so the loser is refused outright.
      const succeeded = [a, b].filter((r) => r.status < 400);
      const refused = [a, b].filter((r) => r.status >= 400);
      expect(succeeded).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(String(refused[0].body.message)).toMatch(
        /already been decided|already been processed|Cannot decide/i,
      );

      const row = await ctx.prisma.travelRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(['APPROVED', 'REJECTED']).toContain(row.status);

      // The invariant that actually matters: the money follows the outcome.
      // A refused trip has committed nothing; an approved one holds exactly one
      // commitment, never two.
      const commitments = await commitmentsFor(id);
      if (row.status === 'REJECTED') {
        expect(commitments).toEqual([]);
      } else {
        expect(commitments).toHaveLength(1);
      }
    });

    it('CR-API-26b the same race on the legacy path, with no chain governing it', async () => {
      // The conditional claim lives in the apply paths, which both the engine
      // route and the legacy route funnel through — so turning the engine off
      // must not reopen the window.
      await setSwitch('false');
      try {
        const id = dataOf(await raiseTravel()).id;
        const [a, b] = await Promise.all([
          ctx
            .http()
            .post(`/travel-requests/${id}/approve`)
            .set(bearer(fx.admin.token))
            .send({ remarks: 'A' }),
          ctx
            .http()
            .post(`/travel-requests/${id}/reject`)
            .set(bearer(fx.hrGlobal.token))
            .send({ remarks: 'B' }),
        ]);

        expect([a, b].filter((r) => r.status < 400)).toHaveLength(1);

        const row = await ctx.prisma.travelRequest.findUniqueOrThrow({
          where: { id },
        });
        const commitments = await commitmentsFor(id);
        if (row.status === 'REJECTED') {
          expect(commitments).toEqual([]);
        } else {
          expect(commitments).toHaveLength(1);
        }
      } finally {
        await setSwitch('true');
      }
    });
  });

  // ── The orphan trail ──────────────────────────────────────────────────────
  describe('an orphan trail', () => {
    it('CR-API-27 a trail whose request is gone does not wedge the approver’s queue', async () => {
      // `RequestApproval` has NO foreign key to the domain row, so a hard-
      // deleted request leaves its trail behind. The engine must treat an
      // unresolvable requester as "not actionable" rather than throwing — one
      // bad row must not take the whole inbox down with it.
      await setChain('TRAVEL', ['SUPERVISOR']);
      const id = dataOf(await raiseTravel()).id;

      await ctx.prisma.travelItinerary.deleteMany({ where: { travelId: id } });
      await ctx.prisma.travelRequest.delete({ where: { id } });

      const orphans = await trailFor('TRAVEL', id);
      expect(orphans.length).toBeGreaterThan(0);

      const inbox = await ctx
        .http()
        .get('/approval-workflows/inbox')
        .set(bearer(fx.manager.token));
      expectStatus(inbox, 200);
      expect(JSON.stringify(dataOf(inbox))).not.toContain(id);
    });
  });

  // ── The frontend seam ─────────────────────────────────────────────────────
  describe('the inbox contract with the screen', () => {
    it('CR-API-28 F8 — every kind the API will govern is actionable from the inbox', async () => {
      // `/approval-workflows/kinds` answers with every type the API is willing
      // to govern, and a chain over each works end to end (CR-API-04 … -06).
      // `apps/frontend/lib/approvalKinds.tsx` carries one entry per kind, and a
      // kind the API governs with no entry there draws an inbox row whose
      // Approve button answers "Unsupported request type: <that kind>".
      //
      // Asserted from the backend because that is where the contract lives:
      // every kind the API is willing to govern needs a UI entry. `UI_KINDS`
      // below mirrors that file, so adding a governable type without an inbox
      // entry turns this red.
      const res = await ctx
        .http()
        .get('/approval-workflows/kinds')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);

      const kinds: string[] = rowsOf(res).map((k: any) =>
        typeof k === 'string' ? k : k.type ?? k.value,
      );
      const UI_KINDS = [
        'LEAVE',
        'OVERTIME',
        'TRAVEL',
        'TRAINING',
        'BANK_CHANGE',
      ];
      expect(kinds.filter((k) => !UI_KINDS.includes(k))).toEqual([]);
    });

  });
});
