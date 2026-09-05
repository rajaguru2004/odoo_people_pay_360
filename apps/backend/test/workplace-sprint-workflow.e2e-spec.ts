import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
  bearer,
} from './utils/workplace-fixtures';

/**
 * WP-7 — Sprints and workflow status columns (`SPR-API-*`).
 *
 * The baseline (`projects-lifecycle.e2e-spec.ts` §7, from 3c22f56) already walks
 * the HAPPY sprint path: create in PLANNING, viewer 403, member 403, rename,
 * start, complete, list, read, delete-detaches-tasks. Nothing here repeats it.
 *
 * What this file is for is everything the happy path cannot see:
 *
 *   1. **The state machine, in full.** `SprintsService.start()` and `complete()`
 *      once wrote the next status without ever reading the current one, so
 *      every "illegal" transition was in fact legal, including resurrecting a
 *      COMPLETED sprint. §1 now walks the whole edge set —
 *      `PLANNING -> ACTIVE -> COMPLETED`, COMPLETED terminal — because a
 *      lifecycle that only ever runs forwards proves nothing about the edges,
 *      and the edges are where a scrum board loses data.
 *   2. **`SprintStatus.CANCELLED`.** Four values in the enum, and for a
 *      while only three in the lifecycle. The Organization phase found
 *      `RESTRUCTURE` dead this way; §1 now walks the cancel verb R37 was
 *      decided into — PLANNING or ACTIVE -> CANCELLED, terminal, open work
 *      returned to the backlog — because an enum value nothing can write is
 *      a rule the schema states and the product does not keep.
 *   3. **`@ValidateNested` on `PATCH /project-statuses/reorder`.** The decorator
 *      that silently does nothing when it is misconfigured — Phase 4 found four
 *      payroll DTOs where `ValidationPipe` never ran at all. §4 proves it runs,
 *      and that a degenerate payload reaches it rather than being turned into
 *      a permission error on the way past the guard.
 *   4. **Finding R7 (`SPR-API-20`), fixed.** `projectIdFromStatus()` resolved a
 *      status to its `workflowId` and then to *an arbitrary project using that
 *      workflow* — `findFirst`, no ordering, no relation to the caller.
 *      Workflows are shared. §5 holds `STATUS_MANAGE` on project A and proves
 *      project B's board is now untouchable through it, asserting the BOARD
 *      rather than the admission, plus the write-target half: a soft-deleted
 *      column no longer accepts tasks. (The sibling `workplace-project-rbac`
 *      spec owns the permission half of R7 — "did the guard admit the caller";
 *      this file owns "what happened to the other project's board".)
 *
 * House convention, per `docs/TESTING.md` §"Recorded defects": every defect is
 * PINNED as it behaves today with a `KNOWN GAP` note, beside an `it.failing`
 * twin naming the behaviour the product should have — and once it is FIXED the
 * pair COLLAPSES into one case asserting the correct behaviour, with the defect
 * recorded in a `REGRESSION LOCK` comment so the case still says what it is
 * guarding. Findings R7 (the shared workflow, both halves), R30 (the sprint
 * state machine), R31 (one ACTIVE sprint per project), R32 (the two unmapped
 * P2002s), R33 (guards answering payload problems), R34 (a soft-deleted task
 * blocking its column), R35 (a board emptied of every column) and all three
 * halves of R38 are fixed and collapsed here.
 *
 * The last four were **product decisions**, taken since and collapsed in the
 * same way: R36 (`StatusTransition` enforced where rows exist — SPR-API-25),
 * R37 (a cancel verb — SPR-API-05), the OVERLAP half of R38 (SPR-API-13 and
 * -13c) and R39 (a completing sprint returns its open work — SPR-API-15).
 * **No `it.failing` twin is left in this file.** Two of those decisions move
 * rows the caller never named and one can refuse a move that used to work, so
 * each carries a positive control proving the ordinary path is untouched:
 * SPR-API-15d (a sprint that finished everything moves nothing) and the first
 * half of SPR-API-25 (a workflow with no transition rows behaves exactly as
 * before).
 *
 * Isolation: three sibling specs write to the same database concurrently.
 * `setupWorkplaceFixtures` builds its own workflows, projects and personas
 * under a fresh `runId`, so every assertion below filters to rows this run
 * created. The one genuinely shared artefact — the two-projects-on-one-workflow
 * pair — is restored in §5's `afterAll`.
 */

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Workplace — sprints & workflow statuses (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;
  let runId: string;

  /** Sprint names must be unique per project — `@@unique([projectId, slug])`. */
  let seq = 0;
  const uniqueName = (label: string) => `${label} ${++seq} ${runId}`;

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);
    runId = fx.runId;
  }, 240000);

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  const createSprint = (
    token: string,
    body: Record<string, unknown>,
  ) => ctx.http().post('/sprints').set(bearer(token)).send(body);

  /** A PLANNING sprint on the private project, owned by `projectOwner`. */
  const newSprint = async (label = 'Sprint'): Promise<string> => {
    const res = await createSprint(fx.projectOwner.token, {
      projectId: fx.privateProjectId,
      name: uniqueName(label),
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };

  const start = (id: string, token = fx.projectOwner.token) =>
    ctx.http().patch(`/sprints/${id}/start`).set(bearer(token)).send({});

  const complete = (id: string, token = fx.projectOwner.token) =>
    ctx.http().patch(`/sprints/${id}/complete`).set(bearer(token)).send({});

  const cancel = (id: string, token = fx.projectOwner.token) =>
    ctx.http().patch(`/sprints/${id}/cancel`).set(bearer(token)).send({});

  const patchSprint = (
    id: string,
    body: Record<string, unknown>,
    token = fx.projectOwner.token,
  ) => ctx.http().patch(`/sprints/${id}`).set(bearer(token)).send(body);

  const sprintRow = (id: string) =>
    ctx.prisma.sprint.findUnique({ where: { id } });

  const createTask = (
    token: string,
    body: Record<string, unknown>,
  ) => ctx.http().post('/tasks').set(bearer(token)).send(body);

  const listStatuses = (projectId: string, token = fx.projectOwner.token) =>
    ctx
      .http()
      .get(`/project-statuses?projectId=${projectId}`)
      .set(bearer(token));

  const kanban = (projectId: string, token = fx.projectOwner.token) =>
    ctx.http().get(`/tasks/kanban?projectId=${projectId}`).set(bearer(token));

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. The sprint state machine — every "illegal" transition
  // ═══════════════════════════════════════════════════════════════════════════

  describe('1. sprint state machine', () => {
    /**
     * Finding R31 is enforced by REFUSING a second start, so every case in this
     * block has to hand the project back with nothing running — otherwise the
     * next one would be answered 409 for a reason that has nothing to do with
     * what it is asserting.
     */
    afterEach(async () => {
      await ctx.prisma.sprint.updateMany({
        where: { projectId: fx.privateProjectId, status: 'ACTIVE' },
        data: { status: 'COMPLETED', endDate: new Date() },
      });
    });

    it('SPR-API-01 starting an already-ACTIVE sprint is refused', async () => {
      /**
       * REGRESSION LOCK — finding R30. `SprintsService.start()` never read the
       * current status before writing the next one, so a double-click on
       * "Start sprint" answered 200 twice; worse, the force-complete recorded
       * as R31 closed every ACTIVE sprint in the project first, which on a
       * re-start is THIS sprint — so the row round-tripped through COMPLETED
       * and back to ACTIVE with nobody told.
       */
      const id = await newSprint('Restart');
      expect((await start(id)).status).toBe(200);

      const again = await start(id);
      expect(again.status).toBe(400);
      expect(again.body.message).toMatch(/already ACTIVE/i);

      // And the row never moved.
      expect((await sprintRow(id))?.status).toBe('ACTIVE');
    });

    it('SPR-API-02 COMPLETED is terminal — a closed sprint cannot be resurrected', async () => {
      const id = await newSprint('Resurrect');
      await start(id);
      expect((await complete(id)).status).toBe(200);

      const res = await start(id);

      /**
       * REGRESSION LOCK — finding R30. COMPLETED was not terminal: a closed
       * sprint, whose burndown and velocity had already been reported, reopened
       * on a single PATCH and silently re-entered the board's "current sprint"
       * slot. The refusal names BOTH ends of the move it refused, because
       * "not allowed" on its own is not actionable from a board.
       */
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/COMPLETED/);
      expect(res.body.message).toMatch(/ACTIVE/);
      expect((await sprintRow(id))?.status).toBe('COMPLETED');
    });

    it('SPR-API-03 a PLANNING sprint that never started cannot be COMPLETED', async () => {
      const id = await newSprint('Never started');
      const before = await sprintRow(id);
      expect(before?.status).toBe('PLANNING');
      expect(before?.startDate).toBeNull();

      const res = await complete(id);

      /**
       * REGRESSION LOCK — finding R30. PLANNING -> COMPLETED used to skip
       * ACTIVE entirely: the row ended up COMPLETED with `endDate` stamped and
       * `startDate` still NULL, which is not a state any burndown chart can
       * render — it closed before it ever opened.
       */
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/PLANNING/);
      expect(res.body.message).toMatch(/COMPLETED/);

      const after = await sprintRow(id);
      expect(after?.status).toBe('PLANNING');
      expect(after?.startDate).toBeNull();
      expect(after?.endDate).toBeNull();
    });

    it('SPR-API-04 completing an already-COMPLETED sprint is refused, and the first endDate stands', async () => {
      const id = await newSprint('Double complete');
      await start(id);
      await complete(id);
      const firstEnd = (await sprintRow(id))?.endDate;
      expect(firstEnd).not.toBeNull();

      const res = await complete(id);

      /**
       * REGRESSION LOCK — finding R30. The second call used to answer 200
       * "Sprint completed" while `endDate: existing.endDate ?? new Date()`
       * quietly made it a no-op, so a UI reporting success had no way to tell a
       * real close from a replayed one.
       */
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already COMPLETED/i);
      expect((await sprintRow(id))?.endDate?.toISOString()).toBe(
        firstEnd?.toISOString(),
      );
    });

    it('SPR-API-05 cancel is a real verb — PLANNING or ACTIVE -> CANCELLED, terminal, and open work goes back to the backlog', async () => {
      /**
       * REGRESSION LOCK — finding R37 (twin SPR-API-05b has collapsed into this
       * case). `SprintStatus` carries PLANNING / ACTIVE / COMPLETED / CANCELLED
       * and the lifecycle had three of them. CANCELLED was reachable only
       * through the generic `PATCH /sprints/:id`, where it had no verb, no
       * message and no side effects — so cancelling a sprint was
       * indistinguishable from renaming one, and a CANCELLED sprint restarted
       * straight back to ACTIVE. The R30 fix, which took `status` off
       * `UpdateSprintDto`, then made the value fully unreachable: an enum
       * member nothing in the product could write.
       *
       * DECIDED: cancelling is a real operation. `PATCH /sprints/:id/cancel`,
       * from PLANNING or ACTIVE, gated by the same SPRINT_MANAGE permission as
       * the other verbs, terminal exactly as COMPLETED is — and it returns the
       * sprint's open work to the backlog on the same rule as completion
       * (R39), because a sprint abandoned mid-flight strands work exactly as a
       * closed one does.
       */

      // ── From PLANNING ────────────────────────────────────────────────────
      const planning = await newSprint('Cancel from planning');
      const fromPlanning = await cancel(planning);
      expect(fromPlanning.status).toBe(200);
      expect(fromPlanning.body.data.status).toBe('CANCELLED');
      expect((await sprintRow(planning))?.status).toBe('CANCELLED');
      // Nothing was on it, so nothing moved — and the caller is told so.
      expect(fromPlanning.body.tasksReturnedToBacklog).toBe(0);

      // ── From ACTIVE, carrying live work ──────────────────────────────────
      const active = await newSprint('Cancel from active');
      await start(active);
      const open = await createTask(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        sprintId: active,
        title: `abandoned work ${runId}`,
      });
      expect(open.status).toBe(201);
      const openTaskId = open.body.data.id as string;

      const fromActive = await cancel(active);
      expect(fromActive.status).toBe(200);
      expect(fromActive.body.data.status).toBe('CANCELLED');
      // The count is reported, because rows the request never named moved.
      expect(fromActive.body.tasksReturnedToBacklog).toBe(1);
      expect(fromActive.body.message).toMatch(/backlog/i);
      expect(
        (
          await ctx.prisma.task.findUnique({
            where: { id: openTaskId },
            select: { sprintId: true },
          })
        )?.sprintId,
      ).toBeNull();
      // The task itself survives — it is back in the backlog, not deleted.
      expect(
        (
          await ctx
            .http()
            .get(`/tasks/${openTaskId}`)
            .set(bearer(fx.projectOwner.token))
        ).status,
      ).toBe(200);

      // A cancelled sprint does not leave the endDate stamped: it never ran,
      // so recording a close that did not happen would be a lie the burndown
      // would then draw.
      expect((await sprintRow(active))?.endDate).toBeNull();

      // ── CANCELLED is terminal, in every direction ────────────────────────
      for (const [verb, res] of [
        ['start', await start(active)],
        ['complete', await complete(active)],
        ['cancel', await cancel(active)],
      ] as const) {
        expect(`${verb}:${res.status}`).toBe(`${verb}:400`);
        expect(res.body.message).toMatch(/CANCELLED/);
      }
      expect((await sprintRow(active))?.status).toBe('CANCELLED');

      // ── The old generic door is still shut (R30) ─────────────────────────
      const stillPlanning = await newSprint('Cancel via patch');
      const viaPatch = await patchSprint(stillPlanning, { status: 'CANCELLED' });
      expect(viaPatch.status).toBe(400);
      expect(JSON.stringify(viaPatch.body)).toMatch(/status/i);
      expect((await sprintRow(stillPlanning))?.status).toBe('PLANNING');

      // ── And it is gated like every other sprint verb ─────────────────────
      // `projectMember` holds no SPRINT_MANAGE (the 12x5 grid in
      // `workplace-project-rbac` owns that assertion); the new door must not
      // be the one weak spot in the set.
      const denied = await cancel(stillPlanning, fx.projectMember.token);
      expect(denied.status).toBe(403);
      expect((await sprintRow(stillPlanning))?.status).toBe('PLANNING');
    });

    it('SPR-API-06 PATCH /sprints/:id cannot drive the status field at all', async () => {
      const id = await newSprint('Free status');
      await start(id);
      await complete(id);

      /**
       * REGRESSION LOCK — finding R30, the door that made every case above
       * reachable. The generic PATCH wrote `status` straight through in ANY
       * direction, COMPLETED -> PLANNING included, so the enum was policed and
       * the transition was not. `status` is off `UpdateSprintDto` now and the
       * lifecycle verbs own transitions outright, which is the narrowest
       * answer available: one door into each status, and it is guarded.
       */
      for (const status of ['PLANNING', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'DONE']) {
        const res = await patchSprint(id, { status });
        expect(`${status}:${res.status}`).toBe(`${status}:400`);
      }
      expect((await sprintRow(id))?.status).toBe('COMPLETED');

      // A narrowing, not a lockout — the editorial fields still patch.
      const edited = await patchSprint(id, { goal: `still editable ${runId}` });
      expect(edited.status).toBe(200);
      expect(edited.body.data.goal).toBe(`still editable ${runId}`);
      expect(edited.body.data.status).toBe('COMPLETED');
    });

    it('SPR-API-07 a second sprint is REFUSED while one is live, and the live one is not touched', async () => {
      const first = await newSprint('Live A');
      const second = await newSprint('Live B');

      await start(first);
      const firstBefore = await sprintRow(first);
      expect(firstBefore?.status).toBe('ACTIVE');

      const res = await start(second);

      /**
       * REGRESSION LOCK — finding R31. "One live sprint per project" is a
       * reasonable invariant; the way it was enforced was not. Starting sprint
       * 12 force-completed sprint 11 through an `updateMany` that wrote only
       * `status` — no prompt, no confirmation, no audit row, and sprint 11 left
       * COMPLETED with its `endDate` exactly as it was (NULL, here): a closed
       * sprint with no closing date. The invariant now refuses the sprint the
       * caller actually named, and says which one is in the way.
       */
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already has an active sprint/i);
      expect(res.body.message).toContain(firstBefore!.name);

      // The row the caller never mentioned is untouched.
      const firstAfter = await sprintRow(first);
      expect(firstAfter?.status).toBe('ACTIVE');
      expect(firstAfter?.endDate).toBeNull();

      // And the one that was refused did not move either.
      expect((await sprintRow(second))?.status).toBe('PLANNING');
      expect((await sprintRow(second))?.startDate).toBeNull();

      // The invariant itself still holds: exactly one ACTIVE sprint.
      const active = await ctx.prisma.sprint.findMany({
        where: { projectId: fx.privateProjectId, status: 'ACTIVE' },
        select: { id: true },
      });
      expect(active.map((s) => s.id)).toEqual([first]);

      // Close it, and the second one starts cleanly — the refusal is a
      // sequencing rule, not a dead end.
      expect((await complete(first)).status).toBe(200);
      expect((await start(second)).status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Sprint DTO / constraint matrix
  // ═══════════════════════════════════════════════════════════════════════════

  describe('2. sprint payload and constraints', () => {
    it('SPR-API-08 name is bounded at 150 chars, and an EMPTY name is refused', async () => {
      /**
       * REGRESSION LOCK — finding R38, the empty-name half (twin SPR-API-08b
       * has collapsed into this case). `@IsString() @MaxLength(150)` carried no
       * `@IsNotEmpty()`, so `''` was stored — and `slugify('')` is `''`, so the
       * SECOND unnamed sprint in a project collided on
       * `@@unique([projectId, slug])`. The 409 that collision produces (R32,
       * SPR-API-14) names the offending name, which in that case is the empty
       * string: diagnosable in principle, no help to anybody in practice.
       *
       * The name is trimmed before it is validated, so whitespace is the empty
       * name it is; and the service refuses any name that slugifies to nothing
       * ("---"), because an empty IDENTIFIER is the actual defect and the DTO
       * cannot see it.
       */
      const at = await createSprint(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        name: `${'x'.repeat(140)}${runId}`.slice(0, 150),
      });
      expect(at.status).toBe(201);

      const over = await createSprint(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        name: 'y'.repeat(151),
      });
      expect(over.status).toBe(400);

      for (const name of ['', '   ', '---']) {
        const res = await createSprint(fx.projectOwner.token, {
          projectId: fx.privateProjectId,
          name,
        });
        expect(`${JSON.stringify(name)}:${res.status}`).toBe(
          `${JSON.stringify(name)}:400`,
        );
      }

      // Nothing with an empty slug reached the table.
      const empties = await ctx.prisma.sprint.count({
        where: { projectId: fx.privateProjectId, slug: '' },
      });
      expect(empties).toBe(0);

      // The same rule on the PATCH door — the second way a name reaches `slug`.
      const id = await newSprint('Renameable');
      const blanked = await patchSprint(id, { name: '   ' });
      expect(blanked.status).toBe(400);
      expect((await sprintRow(id))?.slug).not.toBe('');
    });

    it('SPR-API-09 a MISSING or MALFORMED projectId answers 400 naming the field, not 403', async () => {
      /**
       * REGRESSION LOCK — finding R33. Guards precede pipes in Nest, so
       * `@IsUUID() projectId` never ran: `ProjectPermissionGuard` resolved
       * `from: 'body'` to `undefined` and threw
       * *403 "Project context could not be resolved"*. The client was told it
       * lacked PERMISSION for a request that was merely malformed — the same
       * misdiagnosis for a typo as for a genuine denial.
       *
       * `SprintPayloadGuard` is declared ahead of the permission guard and
       * answers on the SHAPE of the payload alone. It cannot weaken the
       * denial: it never looks at the caller.
       */
      const res = await createSprint(fx.projectOwner.token, {
        name: uniqueName('No project'),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/projectId/i);

      // Every unusable shape is the same problem and gets the same answer.
      for (const projectId of [null, 12345, {}, '', 'not-a-uuid']) {
        const bad = await createSprint(fx.projectOwner.token, {
          projectId,
          name: uniqueName('Bad shape'),
        });
        expect(`${JSON.stringify(projectId)}:${bad.status}`).toBe(
          `${JSON.stringify(projectId)}:400`,
        );
      }

      // ...while a GENUINE denial is still a denial: a well-formed id the
      // caller has no standing on stays 403, with the permission guard's own
      // message.
      const denied = await createSprint(fx.projectOutsider.token, {
        projectId: fx.privateProjectId,
        name: uniqueName('Outsider'),
      });
      expect(denied.status).toBe(403);
    });

    it('SPR-API-10 an UNKNOWN projectId answers 404 for an admin and 403 for everyone else', async () => {
      const ghost = uuid(70001);

      const asAdmin = await createSprint(fx.admin.token, {
        projectId: ghost,
        name: uniqueName('Ghost'),
      });
      expect(asAdmin.status).toBe(404);
      expect(asAdmin.body.message).toBe('Project not found');

      // A non-admin is stopped by the guard first: `getAccess` on a project
      // that does not exist yields an empty permission set, which is
      // indistinguishable from a project they simply cannot touch. That is the
      // correct answer here — it denies an existence oracle.
      const asOwner = await createSprint(fx.projectOwner.token, {
        projectId: ghost,
        name: uniqueName('Ghost owner'),
      });
      expect(asOwner.status).toBe(403);
    });

    it('SPR-API-11 a non-uuid projectId is refused before anything reads it', async () => {
      // Driven as ADMIN on purpose. Before the R33 fix this was the ONE shape
      // that reached the ValidationPipe, because `getAccess` short-circuits on
      // GLOBAL_ADMIN_ROLES before touching Prisma; for every other caller the
      // guard answered first. `SprintPayloadGuard` now answers identically for
      // all of them, which is the point — the reply no longer depends on who
      // is asking.
      const res = await createSprint(fx.admin.token, {
        projectId: 'not-a-uuid',
        name: uniqueName('Bad id'),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/projectId/i);
    });

    it('SPR-API-12 endDate BEFORE startDate is refused, on create and on patch', async () => {
      /**
       * REGRESSION LOCK — finding R38, the inverted-range half (twin
       * SPR-API-12b has collapsed into this case). Neither the DTO nor the
       * service compared the two dates, so a sprint of NEGATIVE length was
       * stored and every duration, burndown and capacity figure downstream
       * inherited it.
       *
       * The OVERLAP half of R38 is enforced separately — SPR-API-13 below.
       */
      const res = await createSprint(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        name: uniqueName('Backwards'),
        startDate: '2026-06-30',
        endDate: '2026-06-01',
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/endDate/i);

      // Equal dates are a one-day sprint, not an inversion.
      const sameDay = await createSprint(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        name: uniqueName('Single day'),
        startDate: '2026-06-30',
        endDate: '2026-06-30',
      });
      expect(sameDay.status).toBe(201);

      // A PATCH may move either end, so the pair is checked as it will END UP:
      // patching only `endDate` is still capable of inverting the range against
      // the `startDate` already on the row.
      const ok = await createSprint(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        name: uniqueName('Forwards'),
        startDate: '2026-09-01',
        endDate: '2026-09-14',
      });
      expect(ok.status).toBe(201);
      const id = ok.body.data.id as string;

      const backwardsEnd = await patchSprint(id, { endDate: '2026-08-01' });
      expect(backwardsEnd.status).toBe(400);

      const backwardsStart = await patchSprint(id, { startDate: '2026-10-01' });
      expect(backwardsStart.status).toBe(400);

      // The row is exactly as it was created.
      const row = await sprintRow(id);
      expect(row!.endDate!.getTime()).toBeGreaterThan(row!.startDate!.getTime());

      // And a legal move through the same door still lands.
      const forwards = await patchSprint(id, { endDate: '2026-09-21' });
      expect(forwards.status).toBe(200);
    });

    it('SPR-API-13 two sprints in one project may not cover the same days, on create and on patch', async () => {
      /**
       * REGRESSION LOCK — finding R38, the OVERLAP half (twin SPR-API-13b has
       * collapsed into this case). Nothing anywhere compared one sprint's range
       * with another's, so two sprints could cover the same days — which sat
       * oddly beside SPR-API-07's one-ACTIVE-sprint-at-a-time invariant: the
       * product held two positions at once, overlapping sprints could be
       * PLANNED but not both RUN, and the planner only discovered the
       * contradiction at the moment they pressed Start.
       *
       * DECIDED: refuse the overlap where the range is set. Both ends are
       * inclusive, and a sprint with no dates cannot overlap anything.
       *
       * The window is 2031 on purpose. `start()` stamps `startDate` with today
       * and `complete()` stamps `endDate` with today, so section 1 leaves
       * several COMPLETED single-day sprints dated NOW on this project; a case
       * written around the current month would be refused for a reason that has
       * nothing to do with what it is asserting.
       */
      const mk = (name: string, startDate?: string, endDate?: string) =>
        createSprint(fx.projectOwner.token, {
          projectId: fx.privateProjectId,
          name: uniqueName(name),
          ...(startDate && { startDate }),
          ...(endDate && { endDate }),
        });

      const a = await mk('Overlap A', '2031-03-01', '2031-03-14');
      expect(a.status).toBe(201);

      // Any shared day is an overlap, and the refusal names the sprint in the
      // way along with both ranges — "these dates are taken" with no way to see
      // by what is not actionable from a planning screen.
      const b = await mk('Overlap B', '2031-03-07', '2031-03-21');
      expect(b.status).toBe(400);
      expect(b.body.message).toMatch(/overlap/i);
      expect(b.body.message).toContain(a.body.data.name);
      expect(b.body.message).toContain('2031-03-01');
      expect(b.body.message).toContain('2031-03-14');

      // A range that swallows the existing one whole, and one swallowed by it —
      // both are overlaps, in case the comparison is ever written one-sided.
      expect((await mk('Overlap around', '2031-02-01', '2031-04-01')).status).toBe(400);
      expect((await mk('Overlap inside', '2031-03-05', '2031-03-06')).status).toBe(400);

      // BOTH ends are inclusive: sharing the single closing day is an overlap…
      expect((await mk('Overlap touching', '2031-03-14', '2031-03-28')).status).toBe(400);
      // …and the day after it is not.
      const next = await mk('Adjacent', '2031-03-15', '2031-03-28');
      expect(next.status).toBe(201);
      const nextId = next.body.data.id as string;

      // A sprint with no dates cannot overlap anything, and neither can a
      // half-set range: an open end names no span of days, and refusing one
      // would block the ordinary act of typing the first date.
      expect((await mk('Undated')).status).toBe(201);
      expect((await mk('Start only', '2031-03-10')).status).toBe(201);
      expect((await mk('End only', undefined, '2031-03-10')).status).toBe(201);

      // The rule holds on PATCH too, checked as the range will END UP — moving
      // one end alone is enough to walk a sprint onto its neighbour's days.
      const clash = await patchSprint(nextId, { startDate: '2031-03-10' });
      expect(clash.status).toBe(400);
      expect(clash.body.message).toContain(a.body.data.name);

      // …and the row did not move.
      const row = await sprintRow(nextId);
      expect(row!.startDate!.toISOString().slice(0, 10)).toBe('2031-03-15');

      // A sprint cannot collide with ITSELF: re-sending its own range, or
      // extending it away from the neighbour, still lands.
      expect(
        (await patchSprint(nextId, { startDate: '2031-03-15', endDate: '2031-03-28' }))
          .status,
      ).toBe(200);
      expect((await patchSprint(nextId, { endDate: '2031-03-30' })).status).toBe(200);
    });

    it('SPR-API-13c a CANCELLED sprint stops reserving its days; a COMPLETED one keeps reserving them', async () => {
      /**
       * The half of the overlap decision that had to be decided rather than
       * derived. A CANCELLED sprint never ran, so its range is an abandoned
       * plan and must not stop anyone re-planning the same window — otherwise
       * cancelling would poison the calendar it was meant to free. A COMPLETED
       * sprint is the opposite: it is the project's record of what actually
       * shipped over those days, and velocity, burndown and capacity all read
       * back by date, so letting a new sprint cover a closed one's days would
       * leave two sprints claiming the same delivered period.
       */
      const mk = (name: string, startDate: string, endDate: string) =>
        createSprint(fx.projectOwner.token, {
          projectId: fx.privateProjectId,
          name: uniqueName(name),
          startDate,
          endDate,
        });

      // ── CANCELLED releases the window ────────────────────────────────────
      const abandoned = await mk('Abandoned window', '2031-05-01', '2031-05-14');
      expect(abandoned.status).toBe(201);
      // While it is still PLANNING the window is taken…
      expect((await mk('Replan blocked', '2031-05-01', '2031-05-14')).status).toBe(400);
      expect((await cancel(abandoned.body.data.id)).status).toBe(200);
      // …and once it is cancelled the same range is free.
      const replanned = await mk('Replanned', '2031-05-01', '2031-05-14');
      expect(replanned.status).toBe(201);
      expect((await cancel(replanned.body.data.id)).status).toBe(200);

      // ── COMPLETED keeps it ───────────────────────────────────────────────
      const delivered = await mk('Delivered window', '2031-06-01', '2031-06-14');
      expect(delivered.status).toBe(201);
      const deliveredId = delivered.body.data.id as string;
      expect((await start(deliveredId)).status).toBe(200);
      expect((await complete(deliveredId)).status).toBe(200);
      // `start`/`complete` preserve a range that was already set, so the closed
      // sprint still covers exactly the days it was planned for.
      const closed = await sprintRow(deliveredId);
      expect(closed?.status).toBe('COMPLETED');
      expect(closed!.startDate!.toISOString().slice(0, 10)).toBe('2031-06-01');
      expect(closed!.endDate!.toISOString().slice(0, 10)).toBe('2031-06-14');

      const overlappingClosed = await mk('Re-run history', '2031-06-07', '2031-06-21');
      expect(overlappingClosed.status).toBe(400);
      expect(overlappingClosed.body.message).toContain('COMPLETED');
      expect(overlappingClosed.body.message).toContain(delivered.body.data.name);
    });

    it('SPR-API-14 a duplicate name in one project answers 409 naming the name', async () => {
      const name = uniqueName('Twin name');

      const first = await createSprint(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        name,
      });
      expect(first.status).toBe(201);

      const second = await createSprint(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        name,
      });

      /**
       * REGRESSION LOCK — finding R32. `create()` derives the slug from the name
       * and wrote it straight through; the `@@unique([projectId, slug])`
       * constraint fired P2002, nothing caught it, and `AllExceptionsFilter`
       * turned the non-HttpException into a flat 500 "Internal server error".
       * The user had retyped a sprint name and was shown a server crash with no
       * mention of the name, leaving the UI nothing to bind an inline field
       * error to. `AssetsService` mapped exactly this condition to a 409 all
       * along; sprints do now too, and the message carries the name back.
       */
      expect(second.status).toBe(409);
      expect(second.body.message).toContain(name);

      // The constraint is per PROJECT, and that half is right: the same name in
      // a different project is fine.
      const elsewhere = await createSprint(fx.projectOwner.token, {
        projectId: fx.internalProjectId,
        name,
      });
      expect(elsewhere.status).toBe(201);
    });

    it('SPR-API-14c renaming a sprint onto a name already in use answers 409 too', async () => {
      // The other half of the same constraint, and the likelier one on a board:
      // `update()` keeps the slug in step with the name, so a rename hits
      // `@@unique([projectId, slug])` exactly as a create does.
      const taken = uniqueName('Taken name');
      const first = await createSprint(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        name: taken,
      });
      expect(first.status).toBe(201);
      const other = await createSprint(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        name: uniqueName('Renamer'),
      });
      expect(other.status).toBe(201);

      const clash = await patchSprint(other.body.data.id, { name: taken });
      expect(clash.status).toBe(409);
      expect(clash.body.message).toContain(taken);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Sprints and the tasks they hold
  // ═══════════════════════════════════════════════════════════════════════════

  describe('3. sprint <-> task consequences', () => {
    it('SPR-API-15 completing a sprint returns its OPEN work to the backlog and leaves the delivered work attached', async () => {
      /**
       * REGRESSION LOCK — finding R39 (twin SPR-API-15b has collapsed into this
       * case). `complete()` wrote one field and stopped. Unfinished work was
       * neither carried into the next sprint nor returned to the backlog: it
       * stayed attached to a sprint that was over, so `GET /tasks?sprintId=`
       * kept returning it and the closed sprint's scope kept growing after it
       * closed — while the work itself was invisible to any "unsprinted
       * backlog" view, which filters on `sprintId IS NULL`.
       *
       * DECIDED: on completion, open tasks get `sprintId = null`, in the SAME
       * transaction as the completion, and the count comes back in the response
       * so the caller can tell the user what moved.
       *
       * "Open" is read off the WORKFLOW STATUS CATEGORY, not the `Task.status`
       * enum: `StatusCategory.DONE` is what `TasksService.moveStatus()` reads to
       * stamp `completedDate` and fire the completion notification, so a
       * DONE-categorised column is what this product means by delivered. Tasks
       * in one stay attached, and the closed sprint's record of what it shipped
       * stays honest.
       */
      const [todoCol, inProgressCol, doneCol] = fx.privateStatusIds;

      const sprintId = await newSprint('Carryover');
      await start(sprintId);

      const mkTask = async (label: string, statusId: string) => {
        const res = await createTask(fx.projectOwner.token, {
          projectId: fx.privateProjectId,
          sprintId,
          statusId,
          title: `${label} ${runId}`,
        });
        expect(res.status).toBe(201);
        return res.body.data.id as string;
      };

      const todoTaskId = await mkTask('carryover todo', todoCol);
      const wipTaskId = await mkTask('carryover wip', inProgressCol);
      const doneTaskId = await mkTask('carryover done', doneCol);

      const res = await complete(sprintId);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('COMPLETED');

      // The caller is told what moved. A bulk write across rows the request
      // never named, reported as a bare "Sprint completed", is how a board
      // surprises the person who pressed the button.
      expect(res.body.tasksReturnedToBacklog).toBe(2);
      expect(res.body.message).toMatch(/backlog/i);

      const rows = await ctx.prisma.task.findMany({
        where: { id: { in: [todoTaskId, wipTaskId, doneTaskId] } },
        select: { id: true, sprintId: true, deletedAt: true },
      });
      const sprintOf = Object.fromEntries(rows.map((r) => [r.id, r.sprintId]));

      // TODO and IN_PROGRESS are open, so they are back in the backlog…
      expect(sprintOf[todoTaskId]).toBeNull();
      expect(sprintOf[wipTaskId]).toBeNull();
      // …and DONE stays with the sprint that delivered it.
      expect(sprintOf[doneTaskId]).toBe(sprintId);
      // Returned, not removed: every row survives.
      for (const r of rows) expect(r.deletedAt).toBeNull();

      // Read back through the API the board actually uses: the completed
      // sprint now lists only what it finished…
      const listed = await ctx
        .http()
        .get(`/tasks?projectId=${fx.privateProjectId}&sprintId=${sprintId}`)
        .set(bearer(fx.projectOwner.token));
      expect(listed.status).toBe(200);
      const ids = (listed.body.data ?? []).map((t: any) => t.id);
      expect(ids).toContain(doneTaskId);
      expect(ids).not.toContain(todoTaskId);
      expect(ids).not.toContain(wipTaskId);

      // …and the carried-over work is reachable, unsprinted, on the project.
      for (const id of [todoTaskId, wipTaskId]) {
        const got = await ctx
          .http()
          .get(`/tasks/${id}`)
          .set(bearer(fx.projectOwner.token));
        expect(got.status).toBe(200);
        expect(got.body.data.sprintId).toBeNull();
        expect(got.body.data.projectId).toBe(fx.privateProjectId);
      }

      // These three occupy named COLUMNS of the shared private board, and
      // SPR-API-23 two sections down deletes one of those columns — a live
      // occupant left behind would refuse that delete for a reason that has
      // nothing to do with what it asserts. Removed outright, not soft-deleted,
      // because a soft-deleted row is exactly what SPR-API-23 puts there itself.
      const carried = [todoTaskId, wipTaskId, doneTaskId];
      await ctx.prisma.taskActivity.deleteMany({
        where: { taskId: { in: carried } },
      });
      await ctx.prisma.task.deleteMany({ where: { id: { in: carried } } });
    });

    it('SPR-API-15d a sprint that finished everything moves NOTHING, and says so', async () => {
      /**
       * The positive control for R39 and R37. The sweep those decisions added
       * touches rows the caller never named, so the ordinary path — a sprint
       * closing with all its work done — has to be proved untouched, not
       * assumed. Nothing moves, the reported count is zero, and the message is
       * the plain one rather than a claim about a backlog that did not change.
       */
      const doneCol = fx.privateStatusIds[2];

      const sprintId = await newSprint('Clean close');
      await start(sprintId);

      const finished: string[] = [];
      for (const label of ['clean one', 'clean two']) {
        const res = await createTask(fx.projectOwner.token, {
          projectId: fx.privateProjectId,
          sprintId,
          statusId: doneCol,
          title: `${label} ${runId}`,
        });
        expect(res.status).toBe(201);
        finished.push(res.body.data.id as string);
      }

      const res = await complete(sprintId);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('COMPLETED');
      expect(res.body.tasksReturnedToBacklog).toBe(0);
      expect(res.body.message).toBe('Sprint completed');

      const rows = await ctx.prisma.task.findMany({
        where: { id: { in: finished } },
        select: { sprintId: true },
      });
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.sprintId).toBe(sprintId);

      // Same reason as SPR-API-15: the board's columns are shared with the
      // cases after this one.
      await ctx.prisma.taskActivity.deleteMany({
        where: { taskId: { in: finished } },
      });
      await ctx.prisma.task.deleteMany({ where: { id: { in: finished } } });
    });

    it('SPR-API-16 DELETE detaches tasks — they survive and their sprintId is genuinely NULL, not dangling', async () => {
      const sprintId = await newSprint('Delete me');
      const created = await Promise.all([
        createTask(fx.projectOwner.token, {
          projectId: fx.privateProjectId,
          sprintId,
          title: `survivor one ${runId}`,
        }),
        createTask(fx.projectOwner.token, {
          projectId: fx.privateProjectId,
          sprintId,
          title: `survivor two ${runId}`,
        }),
      ]);
      const taskIds = created.map((r) => {
        expect(r.status).toBe(201);
        return r.body.data.id as string;
      });

      const res = await ctx
        .http()
        .delete(`/sprints/${sprintId}`)
        .set(bearer(fx.projectOwner.token));
      expect(res.status).toBe(200);

      // The sprint is HARD deleted (no `deletedAt` on the model).
      expect(await sprintRow(sprintId)).toBeNull();

      // The baseline asserts the tasks survive. What it does not assert, and
      // what a `Cascade` regression would break silently, is that the pointer
      // is really NULL rather than left holding the id of a row that no longer
      // exists — a dangling reference the board would try to group by.
      const rows = await ctx.prisma.task.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, sprintId: true, deletedAt: true },
      });
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.sprintId).toBeNull();
        expect(r.deletedAt).toBeNull();
      }

      // And they are readable over the API, not just present in the table.
      for (const id of taskIds) {
        const got = await ctx
          .http()
          .get(`/tasks/${id}`)
          .set(bearer(fx.projectOwner.token));
        expect(got.status).toBe(200);
        expect(got.body.data.sprintId).toBeNull();
      }

      // Nothing anywhere still points at the deleted sprint.
      const dangling = await ctx.prisma.task.count({ where: { sprintId } });
      expect(dangling).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Workflow status columns
  // ═══════════════════════════════════════════════════════════════════════════

  describe('4. workflow status columns', () => {
    it('SPR-API-17 create / update / delete a column, with the documented defaults', async () => {
      const before = await listStatuses(fx.privateProjectId);
      expect(before.status).toBe(200);
      const startingCount = before.body.data.length;

      const created = await ctx
        .http()
        .post('/project-statuses')
        .set(bearer(fx.projectOwner.token))
        .send({ projectId: fx.privateProjectId, name: `QA ${runId}` });
      expect(created.status).toBe(201);
      const statusId = created.body.data.id as string;

      // Defaults come from the service, not the DTO: colour `#64748B`,
      // category TODO, position = the count of live columns before it.
      expect(created.body.data).toMatchObject({
        color: '#64748B',
        category: 'TODO',
        position: startingCount,
        workflowId: fx.privateWorkflowId,
      });

      const updated = await ctx
        .http()
        .patch(`/project-statuses/${statusId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ name: `QA Review ${runId}`, color: '#112233', category: 'IN_PROGRESS' });
      expect(updated.status).toBe(200);
      expect(updated.body.data).toMatchObject({
        name: `QA Review ${runId}`,
        color: '#112233',
        category: 'IN_PROGRESS',
      });

      const removed = await ctx
        .http()
        .delete(`/project-statuses/${statusId}`)
        .set(bearer(fx.projectOwner.token));
      expect(removed.status).toBe(200);

      // SOFT delete — the row stays, `deletedAt` is stamped, and the list drops
      // it. That matters because `Task.statusId` has no cascade: a hard delete
      // would have to move every task first.
      const row = await ctx.prisma.projectTaskStatus.findUnique({
        where: { id: statusId },
        select: { deletedAt: true },
      });
      expect(row?.deletedAt).not.toBeNull();

      const after = await listStatuses(fx.privateProjectId);
      expect(after.body.data.map((s: any) => s.id)).not.toContain(statusId);
      expect(after.body.data).toHaveLength(startingCount);
    });

    it('SPR-API-18 @@unique([workflowId, name]) answers 409, and the message says where else to look', async () => {
      const name = `Dup column ${runId}`;
      const first = await ctx
        .http()
        .post('/project-statuses')
        .set(bearer(fx.projectOwner.token))
        .send({ projectId: fx.privateProjectId, name });
      expect(first.status).toBe(201);

      const second = await ctx
        .http()
        .post('/project-statuses')
        .set(bearer(fx.projectOwner.token))
        .send({ projectId: fx.privateProjectId, name });

      /**
       * REGRESSION LOCK — finding R32, and the worse half of it. Naming a
       * column something that already exists is the single most likely mistake
       * on a board settings screen, and it used to answer 500 "Internal server
       * error".
       *
       * Worse than the sprint case because the constraint is on the WORKFLOW,
       * not the project: workflows are shared (see §5), so the colliding name
       * may live on a board the caller cannot see at all — and the index does
       * not exclude soft-deleted rows, so it may belong to a column that is not
       * on any board any more. A bare "name already exists" would be
       * undiagnosable from the caller's own project, so the message has to say
       * both of those things out loud.
       */
      expect(second.status).toBe(409);
      expect(second.body.message).toContain(name);
      expect(second.body.message).toMatch(/shared/i);

      // And the claim about deleted columns is true, which is exactly why the
      // message makes it: the name stays reserved after the column goes.
      const removed = await ctx
        .http()
        .delete(`/project-statuses/${first.body.data.id}`)
        .set(bearer(fx.projectOwner.token));
      expect(removed.status).toBe(200);

      const afterDelete = await ctx
        .http()
        .post('/project-statuses')
        .set(bearer(fx.projectOwner.token))
        .send({ projectId: fx.privateProjectId, name });
      expect(afterDelete.status).toBe(409);
    });

    it('SPR-API-19 the column DTO matrix — name 100, colour 9, StatusCategory', async () => {
      const post = (body: Record<string, unknown>) =>
        ctx
          .http()
          .post('/project-statuses')
          .set(bearer(fx.projectOwner.token))
          .send({ projectId: fx.privateProjectId, ...body });

      // The three `StatusCategory` values, each accepted...
      const madeIds: string[] = [];
      for (const category of ['TODO', 'IN_PROGRESS', 'DONE']) {
        const res = await post({ name: `Cat ${category} ${runId}`, category });
        expect(res.status).toBe(201);
        expect(res.body.data.category).toBe(category);
        madeIds.push(res.body.data.id);
      }
      // ...and a fourth refused. The enum is policed at the DTO, unlike
      // `AssetItem.status`, which is free-text VarChar(20).
      expect((await post({ name: `Cat bad ${runId}`, category: 'IN_REVIEW' })).status).toBe(400);

      // `name` is VarChar(100) in the schema and MaxLength(100) in the DTO.
      const at100 = await post({ name: `n${runId}`.padEnd(100, 'z').slice(0, 100) });
      expect(at100.status).toBe(201);
      madeIds.push(at100.body.data.id);
      expect((await post({ name: 'z'.repeat(101) })).status).toBe(400);

      // `color` is VarChar(9) / MaxLength(9) — long enough for #RRGGBBAA.
      const at9 = await post({ name: `Col9 ${runId}`, color: '#11223344' });
      expect(at9.status).toBe(201);
      madeIds.push(at9.body.data.id);
      expect(
        (await post({ name: `Col10 ${runId}`, color: '#112233445' })).status,
      ).toBe(400);

      // Nothing validates that a colour is a colour — the length is the whole
      // rule, so 'chartreuse' is stored and the board renders no swatch.
      const word = await post({ name: `ColWord ${runId}`, color: 'not-a-hex' });
      expect(word.status).toBe(201);
      expect(word.body.data.color).toBe('not-a-hex');
      madeIds.push(word.body.data.id);

      for (const id of madeIds) {
        await ctx
          .http()
          .delete(`/project-statuses/${id}`)
          .set(bearer(fx.projectOwner.token));
      }
    });

    it('SPR-API-21 reorder: @ValidateNested really runs, and a degenerate body answers 400, not 403', async () => {
      const live = (await listStatuses(fx.privateProjectId)).body.data as any[];
      const firstId = live[0].id as string;

      const reorder = (body: unknown) =>
        ctx
          .http()
          .patch('/project-statuses/reorder')
          .set(bearer(fx.projectOwner.token))
          .send(body as any);

      /**
       * The point of this case. `@ValidateNested({ each: true }) @Type(() =>
       * ReorderItem)` is the decorator pair that silently validates NOTHING
       * when `@Type` is missing or the pipe is not wired — Phase 4 found four
       * payroll DTOs in exactly that state. A malformed nested member must be
       * rejected on its own merits, not merely tolerated.
       */
      const badPosition = await reorder({
        items: [{ id: firstId, position: 'first' }],
      });
      expect(badPosition.status).toBe(400);
      expect(JSON.stringify(badPosition.body)).toMatch(/position/i);

      const badNestedId = await reorder({
        items: [{ id: firstId, position: 0 }, { id: 'nope', position: 1 }],
      });
      expect(badNestedId.status).toBe(400);

      // `whitelist` + `forbidNonWhitelisted` reach INSIDE the nested item too.
      const strayKey = await reorder({
        items: [{ id: firstId, position: 0, colour: 'red' }],
      });
      expect(strayKey.status).toBe(400);

      /**
       * REGRESSION LOCK — finding R33, on the one route where a drag-and-drop
       * client is most likely to post a degenerate body. These three shapes
       * never reached validation at all: `ProjectPermissionGuard` runs before
       * the pipe and resolves this route from `req.body.items[0].id`, so when
       * that was absent it threw "Project context could not be resolved" and an
       * empty array, a missing key and a non-array all answered 403 — a
       * permission error for a payload problem, indistinguishable from a real
       * denial.
       *
       * `ProjectStatusPayloadGuard` is declared ahead of it and answers on the
       * shape alone, naming the key at fault.
       */
      for (const body of [{ items: [] }, {}, { items: 'not-an-array' }, { items: [{ position: 0 }] }]) {
        const res = await reorder(body);
        expect(`${JSON.stringify(body)}:${res.status}`).toBe(
          `${JSON.stringify(body)}:400`,
        );
        expect(JSON.stringify(res.body)).toMatch(/items/i);
      }

      // A GENUINE denial is untouched: a well-formed payload from a caller
      // without STATUS_MANAGE is still 403, with the guard's own message.
      const denied = await ctx
        .http()
        .patch('/project-statuses/reorder')
        .set(bearer(fx.projectViewer.token))
        .send({ items: [{ id: firstId, position: live[0].position }] });
      expect(denied.status).toBe(403);
    });

    it('SPR-API-22 reorder really moves the columns, and the new order is stable', async () => {
      const before = (await listStatuses(fx.privateProjectId)).body.data as any[];
      expect(before.length).toBeGreaterThanOrEqual(3);
      const original = before.map((s) => ({ id: s.id as string, position: s.position as number }));

      const reversed = [...before]
        .reverse()
        .map((s, i) => ({ id: s.id as string, position: i }));

      const res = await ctx
        .http()
        .patch('/project-statuses/reorder')
        .set(bearer(fx.projectOwner.token))
        .send({ items: reversed });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Statuses reordered');

      const after = (await listStatuses(fx.privateProjectId)).body.data as any[];
      expect(after.map((s) => s.id)).toEqual(reversed.map((r) => r.id));
      expect(after.map((s) => s.position)).toEqual(after.map((_, i) => i));

      // Stable: a second read, and the kanban board built from the same rows,
      // both agree. `getKanban` orders by position independently.
      const again = (await listStatuses(fx.privateProjectId)).body.data as any[];
      expect(again.map((s) => s.id)).toEqual(after.map((s) => s.id));

      const board = await kanban(fx.privateProjectId);
      expect(board.status).toBe(200);
      expect(board.body.data.columns.map((c: any) => c.id)).toEqual(
        after.map((s) => s.id),
      );

      // Put it back so the cases after this one read the fixture order.
      const restore = await ctx
        .http()
        .patch('/project-statuses/reorder')
        .set(bearer(fx.projectOwner.token))
        .send({ items: original });
      expect(restore.status).toBe(200);
    });

    it('SPR-API-23 a LIVE task blocks its column; a SOFT-DELETED one does not', async () => {
      const columns = (await listStatuses(fx.privateProjectId)).body.data as any[];
      const target = columns[1];

      const task = await createTask(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        statusId: target.id,
        title: `column occupant ${runId}`,
      });
      expect(task.status).toBe(201);
      const taskId = task.body.data.id as string;

      const blocked = await ctx
        .http()
        .delete(`/project-statuses/${target.id}`)
        .set(bearer(fx.projectOwner.token));

      // This half is RIGHT, and is the behaviour that keeps a board intact:
      // tasks are never orphaned onto a column that no longer exists.
      expect(blocked.status).toBe(400);
      expect(blocked.body.message).toMatch(/still has tasks/i);
      const stillLive = await ctx.prisma.projectTaskStatus.findUnique({
        where: { id: target.id },
        select: { deletedAt: true },
      });
      expect(stillLive?.deletedAt).toBeNull();

      // Now SOFT-delete the task — `DELETE /tasks/:id` is a soft delete.
      const gone = await ctx
        .http()
        .delete(`/tasks/${taskId}`)
        .set(bearer(fx.projectOwner.token));
      expect(gone.status).toBe(200);
      const softRow = await ctx.prisma.task.findUnique({
        where: { id: taskId },
        select: { deletedAt: true, statusId: true },
      });
      expect(softRow?.deletedAt).not.toBeNull();
      expect(softRow?.statusId).toBe(target.id);

      const nowFree = await ctx
        .http()
        .delete(`/project-statuses/${target.id}`)
        .set(bearer(fx.projectOwner.token));

      /**
       * REGRESSION LOCK — finding R34. `remove()` counted with
       * `prisma.task.count({ where: { statusId } })` and no `deletedAt: null`,
       * so a task that had been deleted — appearing on no board and in no list —
       * kept its column alive for ever. The message told the admin to "move
       * them first"; there was nothing left to move, and no screen that could
       * have shown it to them.
       */
      expect(nowFree.status).toBe(200);
      const removedRow = await ctx.prisma.projectTaskStatus.findUnique({
        where: { id: target.id },
        select: { deletedAt: true },
      });
      expect(removedRow?.deletedAt).not.toBeNull();

      // Restore the column for the cases after this one; the soft-deleted task
      // stays where it was, which is the whole point.
      await ctx.prisma.projectTaskStatus.update({
        where: { id: target.id },
        data: { deletedAt: null },
      });
    });

    it('SPR-API-24 a board cannot be emptied: the default column is held, and the last one cannot go', async () => {
      /**
       * Driven against the INTERNAL project's own workflow so nothing else in
       * this file (or in a sibling spec) reads a board mid-demolition. Restored
       * at the end.
       *
       * REGRESSION LOCK — finding R35. `isDefault` was decorative: the column
       * every new task falls back to was deletable, and once it had gone so was
       * every other one. A project could be left with ZERO columns, and a task
       * created afterwards got `statusId: null` — which `getKanban` buckets
       * into `columns[0]`, a column that did not exist. The work was in the
       * database, on no board, in nobody's way and nobody's view.
       */
      const columns = (await listStatuses(fx.internalProjectId)).body.data as any[];
      expect(columns.length).toBe(3);
      const defaultColumn = columns.find((c) => c.isDefault);
      expect(defaultColumn).toBeDefined();

      const del = (id: string) =>
        ctx
          .http()
          .delete(`/project-statuses/${id}`)
          .set(bearer(fx.projectOwner.token));

      // 1. The default column is held — it is where a task with no explicit
      //    status lands, so it cannot simply disappear.
      const killDefault = await del(defaultColumn.id);
      expect(killDefault.status).toBe(400);
      expect(killDefault.body.message).toMatch(/default column/i);
      expect(killDefault.body.message).toContain(defaultColumn.name);

      // 2. ...but it is not immortal. Promote another column and the old
      //    default becomes deletable, which is what makes the rule a sequencing
      //    rule rather than a trap.
      const heir = columns.find((c) => c.id !== defaultColumn.id);
      const promoted = await ctx
        .http()
        .patch(`/project-statuses/${heir.id}`)
        .set(bearer(fx.projectOwner.token))
        .send({ isDefault: true });
      expect(promoted.status).toBe(200);
      expect(promoted.body.data.isDefault).toBe(true);
      // Exactly one column holds the flag.
      const flags = await ctx.prisma.projectTaskStatus.findMany({
        where: { id: { in: columns.map((c: any) => c.id) }, isDefault: true },
        select: { id: true },
      });
      expect(flags.map((f) => f.id)).toEqual([heir.id]);

      expect((await del(defaultColumn.id)).status).toBe(200);

      // 3. And there is a floor. The third column goes; the LAST one is
      //    refused, so the board can never reach zero.
      const other = columns.find(
        (c) => c.id !== defaultColumn.id && c.id !== heir.id,
      );
      expect((await del(other.id)).status).toBe(200);

      const last = await del(heir.id);
      expect(last.status).toBe(400);
      expect(last.body.message).toMatch(/last remaining column/i);

      // The board is down to one column, and it is a real one.
      const remaining = await listStatuses(fx.internalProjectId);
      expect(remaining.body.data.map((c: any) => c.id)).toEqual([heir.id]);
      const board = await kanban(fx.internalProjectId);
      expect(board.body.data.columns.map((c: any) => c.id)).toEqual([heir.id]);

      // 4. So a task created into the project lands ON a column instead of
      //    falling through to `statusId: null` and off the board entirely.
      const task = await createTask(fx.projectOwner.token, {
        projectId: fx.internalProjectId,
        title: `columnless ${runId}`,
      });
      expect(task.status).toBe(201);
      expect(task.body.data.statusId).toBe(heir.id);
      const boardAfter = await kanban(fx.internalProjectId);
      const placed = (boardAfter.body.data.columns as any[]).flatMap((c) =>
        c.tasks.map((t: any) => t.id),
      );
      expect(placed).toContain(task.body.data.id);

      // Restore the internal workflow for anything that reads it later.
      await ctx.prisma.taskActivity.deleteMany({
        where: { taskId: task.body.data.id },
      });
      await ctx.prisma.task.deleteMany({ where: { id: task.body.data.id } });
      await ctx.prisma.projectTaskStatus.updateMany({
        where: { id: { in: columns.map((c) => c.id) } },
        data: { deletedAt: null, isDefault: false },
      });
      await ctx.prisma.projectTaskStatus.update({
        where: { id: defaultColumn.id },
        data: { isDefault: true },
      });
      const restored = await listStatuses(fx.internalProjectId);
      expect(restored.body.data).toHaveLength(3);
    });

    it('SPR-API-25 StatusTransition is ENFORCED when the workflow declares rows, and only then', async () => {
      /**
       * REGRESSION LOCK — finding R36. `StatusTransition` carries a real
       * `@@unique([workflowId, fromStatusId, toStatusId])` and three cascading
       * FKs, and the only writer in the whole repository was
       * `sample-data.extras.ts`. No controller read it, no controller wrote it,
       * and `TasksService.moveStatus()` did not consult it — so with `from->to`
       * declared the API still accepted the REVERSE move. The table described a
       * workflow rule the product did not enforce: dead surface.
       *
       * DECIDED: enforce it when rows exist, and only then. A workflow with no
       * transition rows stays unrestricted — every board shipping today is in
       * that state and none of them may change behaviour. A workflow with any
       * rows is a declared graph, and a task may move only along a declared
       * edge. Defining the rules is explicitly OUT of scope: there is still no
       * CRUD surface for the table, and the probes below keep it that way.
       */
      const [todoCol, wipCol, doneCol] = fx.privateStatusIds;
      const nameOf = async (id: string) =>
        (
          await ctx.prisma.projectTaskStatus.findUnique({
            where: { id },
            select: { name: true },
          })
        )!.name;
      const todoName = await nameOf(todoCol);
      const wipName = await nameOf(wipCol);

      const move = (taskId: string, statusId: string) =>
        ctx
          .http()
          .post(`/tasks/${taskId}/move-status`)
          .set(bearer(fx.projectOwner.token))
          .send({ statusId });

      const statusOf = async (taskId: string) =>
        (
          await ctx.prisma.task.findUnique({
            where: { id: taskId },
            select: { statusId: true },
          })
        )?.statusId;

      const created = await createTask(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
        statusId: todoCol,
        title: `transition probe ${runId}`,
      });
      expect(created.status).toBe(201);
      const taskId = created.body.data.id as string;

      let declared: { id: string } | null = null;
      try {
        // ── THE POSITIVE CONTROL, first ──────────────────────────────────────
        // With NO rows on this workflow the board is unrestricted, exactly as
        // it was before this rule existed. This is the state every project in
        // the product is in, so it is the case that proves the change is
        // backwards compatible — it goes red if enforcement ever becomes
        // unconditional.
        expect(
          await ctx.prisma.statusTransition.count({
            where: { workflowId: fx.privateWorkflowId },
          }),
        ).toBe(0);
        for (const to of [wipCol, doneCol, todoCol, doneCol, wipCol]) {
          const res = await move(taskId, to);
          expect(`${to}:${res.status}`).toBe(`${to}:201`);
        }
        expect(await statusOf(taskId)).toBe(wipCol);

        // ── Declare ONE edge, and the graph starts governing ────────────────
        declared = await ctx.prisma.statusTransition.create({
          data: {
            workflowId: fx.privateWorkflowId,
            fromStatusId: todoCol,
            toStatusId: wipCol,
          },
          select: { id: true },
        });

        // Put the card back at the start. That move is itself now undeclared,
        // so the board cannot do it — the row is repositioned directly.
        await ctx.prisma.task.update({
          where: { id: taskId },
          data: { statusId: todoCol },
        });

        // The declared edge is allowed…
        expect((await move(taskId, wipCol)).status).toBe(201);
        expect(await statusOf(taskId)).toBe(wipCol);

        // …and the REVERSE, which the table never declared, is refused —
        // naming BOTH columns, because "this move is not allowed" on its own
        // tells a board nothing the user can act on.
        const reverse = await move(taskId, todoCol);
        expect(reverse.status).toBe(400);
        expect(reverse.body.message).toContain(todoName);
        expect(reverse.body.message).toContain(wipName);
        expect(await statusOf(taskId)).toBe(wipCol);

        // Any other undeclared edge is refused for the same reason.
        expect((await move(taskId, doneCol)).status).toBe(400);
        expect(await statusOf(taskId)).toBe(wipCol);

        // The QUIET door answers to the same graph. `PATCH /tasks/:id` can set
        // `statusId` too, and a rule enforced on the board but not on the API
        // behind it is not enforced at all.
        const viaPatch = await ctx
          .http()
          .patch(`/tasks/${taskId}`)
          .set(bearer(fx.projectOwner.token))
          .send({ statusId: doneCol });
        expect(viaPatch.status).toBe(400);
        expect(viaPatch.body.message).toContain(wipName);
        expect(await statusOf(taskId)).toBe(wipCol);

        // Re-setting the column a task already occupies is not a move, and is
        // not refused as one.
        expect((await move(taskId, wipCol)).status).toBe(201);

        // CREATE is not a move either — a `StatusTransition` is a from->to edge
        // and a new card has no `from`, so a declared workflow must not refuse
        // the first card anyone files into a column.
        const fresh = await createTask(fx.projectOwner.token, {
          projectId: fx.privateProjectId,
          statusId: doneCol,
          title: `transition entry ${runId}`,
        });
        expect(fresh.status).toBe(201);
        await ctx.prisma.taskActivity.deleteMany({
          where: { taskId: fresh.body.data.id },
        });
        await ctx.prisma.task.deleteMany({ where: { id: fresh.body.data.id } });

        // The DB constraint is still the DB's: a duplicate edge is P2002, and
        // there is deliberately no HTTP surface that could produce one. An
        // admin UI for the rules is out of scope; this is enforcement only.
        await expect(
          ctx.prisma.statusTransition.create({
            data: {
              workflowId: fx.privateWorkflowId,
              fromStatusId: todoCol,
              toStatusId: wipCol,
            },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });

        for (const path of [
          '/project-statuses/transitions',
          '/status-transitions',
          `/project-statuses/${todoCol}/transitions`,
        ]) {
          const res = await ctx
            .http()
            .get(path)
            .set(bearer(fx.projectOwner.token));
          expect(res.status).toBe(404);
          expect(res.body.message).toMatch(/^Cannot GET/i);
        }
      } finally {
        // The rows are shared state on a workflow every other case in this file
        // uses, so they come out even if an assertion above threw.
        if (declared) {
          await ctx.prisma.statusTransition.deleteMany({
            where: { workflowId: fx.privateWorkflowId },
          });
        }
        await ctx.prisma.taskActivity.deleteMany({ where: { taskId } });
        await ctx.prisma.task.deleteMany({ where: { id: taskId } });
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. R7 (FIXED) — the shared workflow. SPR-API-20.
  // ═══════════════════════════════════════════════════════════════════════════

  describe('5. SPR-API-20 — R7, a shared workflow is governed by every project on it', () => {
    /**
     * REGRESSION LOCK — finding R7 (red-flagged). `projectIdFromStatus()` was:
     *
     *     const st   = await prisma.projectTaskStatus.findUnique({ where: { id } })
     *     const proj = await prisma.project.findFirst({ where: { workflowId: st.workflowId } })
     *     return proj?.id ?? null
     *
     * `findFirst`, no `orderBy`, no reference to the caller. When two projects
     * share a workflow the guard picked whichever row Postgres handed back
     * first and asked "may you manage statuses THERE" — a question about a
     * project the request never mentioned. A principal holding STATUS_MANAGE on
     * project A, and 403 on even READING project B, could rename a column of
     * B's board AND recategorise it to DONE (so it stamps `completedDate` and
     * fires completion notifications for work still in progress), reorder B's
     * board, and delete one of B's columns outright — all around live work.
     *
     * The rule chosen: **a shared column is governed by EVERY project that uses
     * its workflow.** A status row is one object with many owners, so authority
     * over it is the intersection of their authorities, never the union.
     * `resolveProjectIds()` returns all of them and the guard demands
     * STATUS_MANAGE on each — and reorder is resolved from every item, not
     * `items[0]`, because the transaction writes every one of them.
     *
     * It is not a freeze: a principal who governs the whole workflow still
     * manages the column (the positive control at the end of SPR-API-20), which
     * is why the rule is "every project" rather than "refuse the shared case".
     *
     * The write-target half of the same finding is SPR-API-20c: a soft-deleted
     * column must not accept new tasks. The sibling `workplace-project-rbac`
     * spec owns the ADMISSION grid (`PRJ-API-41*`); this file owns what happens
     * to the other project's board.
     */

    let original: Array<{ id: string; name: string; position: number }> = [];
    const strayTaskIds: string[] = [];
    let taskOnB = '';
    let doomedColumn = '';
    let renamedColumn = '';

    beforeAll(async () => {
      const rows = await ctx.prisma.projectTaskStatus.findMany({
        where: { workflowId: fx.sharedWorkflowId },
        orderBy: { position: 'asc' },
        select: { id: true, name: true, position: true },
      });
      original = rows;
      renamedColumn = rows[1].id;
      doomedColumn = rows[2].id;
    });

    afterAll(async () => {
      // Restore the shared workflow exactly as the fixture left it — names,
      // positions and any soft-deleted column — so a sibling spec reading it
      // (or a second run of this file) sees the fixture shape.
      await ctx.prisma.taskActivity.deleteMany({
        where: { taskId: { in: strayTaskIds } },
      });
      await ctx.prisma.task.deleteMany({ where: { id: { in: strayTaskIds } } });
      for (const s of original) {
        await ctx.prisma.projectTaskStatus.update({
          where: { id: s.id },
          data: { name: s.name, position: s.position, deletedAt: null },
        });
      }
    });

    it('SPR-API-20 STATUS_MANAGE on project A cannot rewrite, reorder or DELETE a column project B depends on', async () => {
      // ── The workflow really is shared ──────────────────────────────────────
      const onWorkflow = await ctx.prisma.project.findMany({
        where: { workflowId: fx.sharedWorkflowId, deletedAt: null },
        select: { id: true },
      });
      expect(onWorkflow.map((p) => p.id).sort()).toEqual(
        [fx.sharedWorkflowProjectAId, fx.sharedWorkflowProjectBId].sort(),
      );

      // The caller has STATUS_MANAGE on A, and is a stranger to B.
      const onA = await ctx.prisma.projectMember.findFirst({
        where: {
          projectId: fx.sharedWorkflowProjectAId,
          employeeId: fx.projectManager.employeeId,
        },
        include: { projectRole: true },
      });
      expect(onA?.projectRole?.permissions).toContain('STATUS_MANAGE');
      const onB = await ctx.prisma.projectMember.findFirst({
        where: {
          projectId: fx.sharedWorkflowProjectBId,
          employeeId: fx.projectManager.employeeId,
        },
      });
      expect(onB).toBeNull();

      // ── Project B's board, with live work on it ────────────────────────────
      const seed = await createTask(fx.projectOwner.token, {
        projectId: fx.sharedWorkflowProjectBId,
        statusId: renamedColumn,
        title: `B board work ${runId}`,
      });
      expect(seed.status).toBe(201);
      taskOnB = seed.body.data.id;
      strayTaskIds.push(taskOnB);

      const boardBefore = await kanban(fx.sharedWorkflowProjectBId);
      expect(boardBefore.status).toBe(200);
      const namesBefore = boardBefore.body.data.columns.map((c: any) => c.name);
      expect(namesBefore).toEqual(original.map((s) => s.name));

      // B is closed to this caller when asked about DIRECTLY, and — the whole
      // point of the finding — must be just as closed when asked about
      // SIDEWAYS, through a column B's board is built on.
      const directOnB = await ctx
        .http()
        .post('/project-statuses')
        .set(bearer(fx.projectManager.token))
        .send({ projectId: fx.sharedWorkflowProjectBId, name: `direct ${runId}` });
      expect(directOnB.status).toBe(403);

      // ── The three mutations, all as the project-A principal ────────────────
      const renamed = await ctx
        .http()
        .patch(`/project-statuses/${renamedColumn}`)
        .set(bearer(fx.projectManager.token))
        .send({ name: `HIJACKED ${runId}`, color: '#FF0000', category: 'DONE' });
      expect(renamed.status).toBe(403);
      expect(renamed.body.message).toMatch(/shared with other projects/i);

      const reordered = await ctx
        .http()
        .patch('/project-statuses/reorder')
        .set(bearer(fx.projectManager.token))
        .send({
          items: [
            { id: original[2].id, position: 0 },
            { id: original[1].id, position: 1 },
            { id: original[0].id, position: 2 },
          ],
        });
      expect(reordered.status).toBe(403);

      const deleted = await ctx
        .http()
        .delete(`/project-statuses/${doomedColumn}`)
        .set(bearer(fx.projectManager.token));
      expect(deleted.status).toBe(403);

      // ══ PROJECT B'S BOARD IS EXACTLY AS IT WAS ════════════════════════════
      const boardAfter = await kanban(fx.sharedWorkflowProjectBId);
      expect(boardAfter.status).toBe(200);
      const columnsAfter = boardAfter.body.data.columns as any[];

      // D1 — no rename and, more importantly, no RECATEGORISATION: the middle
      // column is still IN_PROGRESS, so moving a task into it does not stamp
      // `completedDate` or fire a completion notification for work in flight.
      const untouched = columnsAfter.find((c) => c.id === renamedColumn);
      expect(untouched.name).toBe(original[1].name);
      expect(untouched.category).not.toBe('DONE');

      // D2 — B's grouping order is its own.
      expect(columnsAfter.map((c) => c.id)).toEqual(original.map((s) => s.id));

      // D3 — B has lost nothing.
      expect(columnsAfter).toHaveLength(3);
      expect(columnsAfter.map((c) => c.id)).toContain(doomedColumn);
      const bList = await listStatuses(fx.sharedWorkflowProjectBId);
      expect(bList.body.data.map((s: any) => s.id)).toContain(doomedColumn);
      const doomedRow = await ctx.prisma.projectTaskStatus.findUnique({
        where: { id: doomedColumn },
        select: { deletedAt: true },
      });
      expect(doomedRow?.deletedAt).toBeNull();

      // D4 — and the live task never moved.
      const stillThere = await ctx.prisma.task.findUnique({
        where: { id: taskOnB },
        select: { statusId: true },
      });
      expect(stillThere?.statusId).toBe(renamedColumn);

      // ── The positive control ──────────────────────────────────────────────
      // `projectOwner` owns BOTH projects on this workflow, so the intersection
      // is non-empty and the column is still manageable by someone. The rule
      // narrows authority; it does not orphan a shared board.
      const byOwner = await ctx
        .http()
        .patch(`/project-statuses/${renamedColumn}`)
        .set(bearer(fx.projectOwner.token))
        .send({ name: `Owned ${runId}` });
      expect(byOwner.status).toBe(200);
      const restore = await ctx
        .http()
        .patch(`/project-statuses/${renamedColumn}`)
        .set(bearer(fx.admin.token))
        .send({ name: original[1].name });
      expect(restore.status).toBe(200);
    });

    it('SPR-API-20c a SOFT-DELETED column is not a valid write target', async () => {
      /**
       * REGRESSION LOCK — finding R7, the write-target half. Neither
       * `TasksService.assertReferencesExist()` nor `moveStatus()` filtered
       * `deletedAt`, so a deleted column stayed a legal `statusId`: the task was
       * created 201, was live, was returned by `GET /tasks` — and appeared on NO
       * column of any board, because the board only renders live columns. Not
       * status-less either, so it missed the unassigned bucket too. Work
       * silently off the board is worse than a refusal.
       *
       * Driven through the API by a principal who governs the whole workflow,
       * so the deletion itself is legitimate; the point is what happens NEXT.
       */
      const deleted = await ctx
        .http()
        .delete(`/project-statuses/${doomedColumn}`)
        .set(bearer(fx.projectOwner.token));
      expect(deleted.status).toBe(200);

      const ghostRow = await ctx.prisma.projectTaskStatus.findUnique({
        where: { id: doomedColumn },
        select: { deletedAt: true },
      });
      expect(ghostRow?.deletedAt).not.toBeNull();

      // 1. Create into the ghost column — refused, naming the field.
      const intoGhost = await createTask(fx.projectOwner.token, {
        projectId: fx.sharedWorkflowProjectBId,
        statusId: doomedColumn,
        title: `lost to the ghost column ${runId}`,
      });
      expect(intoGhost.status).toBe(400);
      expect(JSON.stringify(intoGhost.body)).toMatch(/statusId/i);

      // 2. Nothing was written.
      const stray = await ctx.prisma.task.count({
        where: { statusId: doomedColumn, deletedAt: null },
      });
      expect(stray).toBe(0);

      // 3. And a task that exists cannot be MOVED there either — the other
      //    door onto the same column.
      const live = await createTask(fx.projectOwner.token, {
        projectId: fx.sharedWorkflowProjectBId,
        statusId: original[0].id,
        title: `still on the board ${runId}`,
      });
      expect(live.status).toBe(201);
      strayTaskIds.push(live.body.data.id);

      const moved = await ctx
        .http()
        .post(`/tasks/${live.body.data.id}/move-status`)
        .set(bearer(fx.projectOwner.token))
        .send({ statusId: doomedColumn });
      expect(moved.status).toBe(400);

      // 4. The task is still where it was, and still ON the board.
      const board = await kanban(fx.sharedWorkflowProjectBId);
      const placed = (board.body.data.columns as any[]).flatMap((c) =>
        c.tasks.map((t: any) => t.id),
      );
      expect(placed).toContain(live.body.data.id);

      // Restore the column for the afterAll (and for anything reading later).
      await ctx.prisma.projectTaskStatus.update({
        where: { id: doomedColumn },
        data: { deletedAt: null },
      });
    });
  });
});
