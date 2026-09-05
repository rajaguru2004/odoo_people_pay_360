import { unlink } from 'fs/promises';
import { resolve as resolvePath } from 'path';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { StorageService } from '../src/storage/storage.service';
import { bearer } from './utils/settings';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';

/**
 * WP-6 — Tasks in depth, plus the four controllers that had never been reached.
 *
 * ── Why three of these sections could not exist before WP-0 ─────────────────
 *
 * `TaskCommentsModule`, `TaskAttachmentsModule` and `TaskDashboardModule` were
 * imported by `src/app.module.ts` and by nothing else. Every request to
 * `/task-comments/*`, `/task-attachments/*` and `/task-dashboard/*` therefore
 * answered **404 rather than failing honestly** — the same class of lie Phase 3
 * found with `AttendanceCorrectionsModule` and Phase 5 with
 * `LeaveAttachmentsModule`. A suite written against that would have "passed" by
 * asserting nothing at all. WP-0 mounted them; this file is their first
 * coverage of any kind.
 *
 * ── What this file owns, and what it does not ───────────────────────────────
 *
 * BEHAVIOUR and DATA rules: the DTO surface and its boundaries, the dependency
 * graph, the subtask tree, labels, and everything the three new controllers do
 * with a row. The 12 × 5 permission GRID belongs to
 * `workplace-project-rbac.e2e-spec.ts`; where a permission appears here it is
 * because a DATA consequence hangs off it — R8's bulk door, and R21's two
 * unguarded controllers, where the question is not "was it allowed" but "what
 * came back in the body".
 *
 * ── Convention ──────────────────────────────────────────────────────────────
 *
 * Pin, never hide (`docs/TESTING.md` §"Recorded defects"). Where the product is
 * wrong the case asserts what it ACTUALLY does under a `KNOWN GAP` comment, and
 * a `test.failing` twin names the intended behaviour — so the fix flips the
 * suite red and the pin gets removed rather than quietly outliving the bug.
 *
 * When one IS fixed, the pin and its twin collapse into a single case asserting
 * the correct behaviour, keeping a comment that records the defect so the case
 * reads as its regression lock. Collapsed here: R8 (TSK-API-28/28b), R21 and
 * R54 (29/30, 22b–d), R55 (16), R59 (46), the R61 error mappings
 * (04/08/09/11/15/26), and — in the second fix pass — R53's whole upload
 * surface (38/39/40), R56 transitive cycles (14), R57 orphaned subtasks (21),
 * R58 foreign statusId together with R40's missing move-status DTO (10), and
 * R62 subtask type/depth (18/19). Still pinned, with their twins, because each
 * needs a product decision: the DTO gaps at 02 (empty title), 07 (inverted
 * dates) and 34 (empty comment).
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 *
 * Sibling work packages write to the SAME database. Every assertion here is
 * filtered to rows carrying this run's `runId`, or to ids this file created.
 * Nothing counts rows globally.
 *
 * ── A real filesystem / object store is involved ────────────────────────────
 *
 * `StorageService` uploads to MinIO when configured and falls back to local
 * disk otherwise, so the attachment cases really write objects. `afterAll`
 * removes both.
 */
describe('Workplace — tasks, dependencies, subtasks, labels, comments, attachments, dashboard (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;

  const dataOf = (res: any) => res.body?.data ?? res.body;
  const msgOf = (res: any) => String(res.body?.message ?? '');
  const bodyOf = (res: any) => JSON.stringify(res.body);

  /** A syntactically valid uuid that is not in the database. */
  const ABSENT_UUID = '00000000-0000-4000-8000-00000000dead';

  // ── HTTP helpers ───────────────────────────────────────────────────────────
  const postTask = (token: string, body: Record<string, unknown>) =>
    ctx.http().post('/tasks').set(bearer(token)).send(body);

  const patchTask = (token: string, id: string, body: Record<string, unknown>) =>
    ctx.http().patch(`/tasks/${id}`).set(bearer(token)).send(body);

  const getTask = (token: string, id: string) =>
    ctx.http().get(`/tasks/${id}`).set(bearer(token));

  const listTasks = (token: string, qs: string) =>
    ctx.http().get(`/tasks?${qs}`).set(bearer(token));

  const postSubtask = (token: string, parentId: string, body: Record<string, unknown>) =>
    ctx.http().post(`/tasks/${parentId}/subtasks`).set(bearer(token)).send(body);

  const getSubtasks = (token: string, parentId: string) =>
    ctx.http().get(`/tasks/${parentId}/subtasks`).set(bearer(token));

  const addDependency = (
    token: string,
    dependentId: string,
    body: Record<string, unknown>,
  ) =>
    ctx
      .http()
      .post(`/tasks/${dependentId}/dependencies`)
      .set(bearer(token))
      .send(body);

  const getDependencies = (token: string, id: string) =>
    ctx.http().get(`/tasks/${id}/dependencies`).set(bearer(token));

  const delDependency = (token: string, depId: string) =>
    ctx.http().delete(`/tasks/dependencies/${depId}`).set(bearer(token));

  const listComments = (token: string, taskId: string) =>
    ctx.http().get(`/task-comments/task/${taskId}`).set(bearer(token));

  const postComment = (token: string, body: Record<string, unknown>) =>
    ctx.http().post('/task-comments').set(bearer(token)).send(body);

  const patchComment = (token: string, id: string, body: Record<string, unknown>) =>
    ctx.http().patch(`/task-comments/${id}`).set(bearer(token)).send(body);

  const delComment = (token: string, id: string) =>
    ctx.http().delete(`/task-comments/${id}`).set(bearer(token));

  const listAttachments = (token: string, taskId: string) =>
    ctx.http().get(`/task-attachments/task/${taskId}`).set(bearer(token));

  const upload = (
    token: string,
    taskId: string,
    buffer: Buffer,
    filename: string,
    contentType: string,
  ) =>
    ctx
      .http()
      .post(`/task-attachments/upload/${taskId}`)
      .set(bearer(token))
      .attach('file', buffer, { filename, contentType });

  const delAttachment = (token: string, id: string) =>
    ctx.http().delete(`/task-attachments/${id}`).set(bearer(token));

  const employeeDashboard = (token: string) =>
    ctx.http().get('/task-dashboard/employee').set(bearer(token));

  const managerDashboard = (token: string) =>
    ctx.http().get('/task-dashboard/manager').set(bearer(token));

  // ── Bookkeeping ────────────────────────────────────────────────────────────
  /** Every attachment this file uploads: removed from storage in afterAll. */
  const uploaded: Array<{ id: string; fileUrl: string }> = [];
  /** Label rows created directly, outside the fixture's own list. */
  const extraLabelIds: string[] = [];

  let title: (what: string) => string;

  /**
   * Creates a task in the PRIVATE fixture project as its owner, and returns the
   * row. `projectOwner` is a MANAGER **and** `ownerId`, so it clears both the
   * global `@Roles` gate the service applies and the project permission guard —
   * which keeps every case below about the RULE under test rather than about
   * who was allowed to set it up.
   */
  let seedTask: (
    what: string,
    over?: Record<string, unknown>,
  ) => Promise<{ id: string; taskCode: string }>;

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);

    title = (what: string) => `TSK ${fx.runId} ${what}`;

    seedTask = async (what, over = {}) => {
      const res = await postTask(fx.projectOwner.token, {
        title: title(what),
        projectId: fx.privateProjectId,
        statusId: fx.privateStatusIds[0],
        ...over,
      });
      if (res.status !== 201) {
        throw new Error(
          `seedTask(${what}) failed: ${res.status} ${bodyOf(res)}`,
        );
      }
      const d = dataOf(res);
      return { id: d.id, taskCode: d.taskCode };
    };
  }, 180000);

  afterAll(async () => {
    // Storage objects first — the row carries the only pointer to them, and
    // `TaskAttachment.taskId` cascades, so a row removed with its task takes
    // that pointer with it and strands the object. The API delete is tried
    // first because it is the path that also writes the activity row; where
    // the row is already gone, StorageService is asked directly.
    const storage = ctx.app.get(StorageService);
    for (const a of uploaded) {
      const viaApi = await delAttachment(fx.admin.token, a.id).catch(
        () => undefined,
      );
      if (!viaApi || viaApi.status !== 200) {
        await storage.deleteFile(a.fileUrl).catch(() => undefined);
      }
      // Local-disk residue. Uploads now take the PRIVATE door (finding R53),
      // which falls back to `private-uploads/` when MinIO is unreachable, so
      // both roots have to be swept.
      if (a.fileUrl?.startsWith('private://')) {
        await unlink(
          resolvePath(
            process.cwd(),
            'private-uploads',
            a.fileUrl.slice('private://'.length),
          ),
        ).catch(() => undefined);
      } else if (a.fileUrl && !/^https?:\/\//i.test(a.fileUrl)) {
        await unlink(
          resolvePath(process.cwd(), a.fileUrl.replace(/^\/+/, '')),
        ).catch(() => undefined);
      }
    }
    if (ctx?.prisma && extraLabelIds.length) {
      await ctx.prisma.taskLabel
        .deleteMany({ where: { labelId: { in: extraLabelIds } } })
        .catch(() => undefined);
      await ctx.prisma.label
        .deleteMany({ where: { id: { in: extraLabelIds } } })
        .catch(() => undefined);
    }
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  }, 180000);

  // ═══════════════════════════════════════════════════════════════════════════
  // A. The DTO surface and its boundaries
  // ═══════════════════════════════════════════════════════════════════════════
  describe('A — task DTO matrix and boundaries', () => {
    it('TSK-API-01 title is bounded at 500 characters, and 501 is refused', async () => {
      const at = await postTask(fx.projectOwner.token, {
        title: `${fx.runId}`.padEnd(500, 'x').slice(0, 500),
        projectId: fx.privateProjectId,
      });
      expect(at.status).toBe(201);
      expect(dataOf(at).title).toHaveLength(500);

      const over = await postTask(fx.projectOwner.token, {
        title: 'y'.repeat(501),
        projectId: fx.privateProjectId,
      });
      expect(over.status).toBe(400);
      expect(bodyOf(over)).toMatch(/title/i);
    });

    it('TSK-API-02 a missing title is refused — but an EMPTY one is accepted', async () => {
      const missing = await postTask(fx.projectOwner.token, {
        projectId: fx.privateProjectId,
      });
      expect(missing.status).toBe(400);

      // KNOWN GAP. `CreateTaskDto.title` carries `@IsString() @MaxLength(500)`
      // and no `@IsNotEmpty()`, so a task can be created with no name at all.
      // The board then renders a card with nothing on it and no way to tell two
      // of them apart — `taskCode` is the only handle left.
      const empty = await postTask(fx.projectOwner.token, {
        title: '',
        projectId: fx.privateProjectId,
      });
      expect(empty.status).toBe(201);
      expect(dataOf(empty).title).toBe('');
      const whitespace = await postTask(fx.projectOwner.token, {
        title: '   ',
        projectId: fx.privateProjectId,
      });
      expect(whitespace.status).toBe(201);
      expect(dataOf(whitespace).title).toBe('   ');
    });

    it.failing(
      'TSK-API-02b an empty or whitespace-only title should be refused',
      async () => {
        const empty = await postTask(fx.projectOwner.token, {
          title: '',
          projectId: fx.privateProjectId,
        });
        expect(empty.status).toBe(400);
      },
    );

    it('TSK-API-03 description is unbounded Text and round-trips at 20 000 characters', async () => {
      // No `@MaxLength` on `description`, and the column is `@db.Text`. Recorded
      // rather than judged: the contrast with `title`'s 500 is deliberate here,
      // but it means a single task can carry a megabyte-scale body inside the
      // 1 MB request limit and every list that includes it pays for it.
      const long = `${fx.runId} `.repeat(2000).slice(0, 20000);
      const res = await postTask(fx.projectOwner.token, {
        title: title('long description'),
        description: long,
        projectId: fx.privateProjectId,
      });
      expect(res.status).toBe(201);
      const read = await getTask(fx.projectOwner.token, dataOf(res).id);
      expect(dataOf(read).description).toHaveLength(20000);
    });

    it('TSK-API-04 storyPoints: 0 accepted, −1 refused, int4 max accepted, and 2^31 refused at the DTO', async () => {
      const zero = await postTask(fx.projectOwner.token, {
        title: title('sp zero'),
        projectId: fx.privateProjectId,
        storyPoints: 0,
      });
      expect(zero.status).toBe(201);
      expect(dataOf(zero).storyPoints).toBe(0);

      const negative = await postTask(fx.projectOwner.token, {
        title: title('sp negative'),
        projectId: fx.privateProjectId,
        storyPoints: -1,
      });
      expect(negative.status).toBe(400);

      // REGRESSION LOCK — finding R61. `@Min(0)` had no upper bound while
      // `Task.storyPoints` is a Postgres `int4`, so 2 147 483 648 passed
      // validation and failed inside Prisma: a bare 500 "Internal server
      // error" for a plain out-of-range input, and the story-points field on
      // `tasks/new` has `min={0}` and no max either (R23). `@Max(2147483647)`
      // now answers where the column's real limit is.
      const atMax = await postTask(fx.projectOwner.token, {
        title: title('sp at max'),
        projectId: fx.privateProjectId,
        storyPoints: 2147483647,
      });
      expect(atMax.status).toBe(201);
      expect(dataOf(atMax).storyPoints).toBe(2147483647);

      const huge = await postTask(fx.projectOwner.token, {
        title: title('sp huge'),
        projectId: fx.privateProjectId,
        storyPoints: 2147483648,
      });
      expect(huge.status).toBe(400);
      expect(bodyOf(huge)).toMatch(/storyPoints/i);
    });

    it('TSK-API-05 the three enums and the whitelist all refuse junk', async () => {
      const base = {
        title: title('enums'),
        projectId: fx.privateProjectId,
      };
      const badType = await postTask(fx.projectOwner.token, {
        ...base,
        type: 'CHORE',
      });
      expect(badType.status).toBe(400);
      expect(bodyOf(badType)).toMatch(/type/i);

      const badPriority = await postTask(fx.projectOwner.token, {
        ...base,
        priority: 'URGENT',
      });
      expect(badPriority.status).toBe(400);

      const badStatus = await postTask(fx.projectOwner.token, {
        ...base,
        status: 'DONE',
      });
      expect(badStatus.status).toBe(400);

      // `forbidNonWhitelisted: true` in the global pipe — an unknown key is a
      // 400 rather than a silently dropped field.
      const unknownKey = await postTask(fx.projectOwner.token, {
        ...base,
        isArchived: true,
      });
      expect(unknownKey.status).toBe(400);
      expect(bodyOf(unknownKey)).toMatch(/isArchived/);
    });

    it('TSK-API-06 numeric ranges: negative hours and off-globe coordinates are refused', async () => {
      const base = { title: title('ranges'), projectId: fx.privateProjectId };

      const hours = await postTask(fx.projectOwner.token, {
        ...base,
        estimatedHours: -0.5,
      });
      expect(hours.status).toBe(400);

      const lat = await postTask(fx.projectOwner.token, {
        ...base,
        latitude: 91,
        longitude: 0,
      });
      expect(lat.status).toBe(400);

      const lng = await postTask(fx.projectOwner.token, {
        ...base,
        latitude: 0,
        longitude: -181,
      });
      expect(lng.status).toBe(400);

      const ok = await postTask(fx.projectOwner.token, {
        ...base,
        latitude: 13.0827,
        longitude: 80.2707,
        estimatedHours: 8.5,
      });
      expect(ok.status).toBe(201);
    });

    it('TSK-API-07 startDate AFTER dueDate is accepted — there is no cross-field check', async () => {
      // KNOWN GAP. Both fields are `@IsDateString()` and nothing compares them,
      // so a task can be created that starts a year after it is due. The Gantt
      // chart (`ProjectGantt.tsx`) draws a bar from startDate to dueDate; this
      // row draws it backwards.
      const res = await postTask(fx.projectOwner.token, {
        title: title('inverted dates'),
        projectId: fx.privateProjectId,
        startDate: '2027-12-01',
        dueDate: '2026-01-05',
      });
      expect(res.status).toBe(201);
      const d = dataOf(res);
      expect(new Date(d.startDate).getTime()).toBeGreaterThan(
        new Date(d.dueDate).getTime(),
      );

      // …and PATCH will not refuse the inversion either.
      const moved = await patchTask(fx.projectOwner.token, d.id, {
        startDate: '2028-01-01',
      });
      expect(moved.status).toBe(200);
    });

    it.failing(
      'TSK-API-07b a startDate after the dueDate should be refused',
      async () => {
        const res = await postTask(fx.projectOwner.token, {
          title: title('inverted dates twin'),
          projectId: fx.privateProjectId,
          startDate: '2027-12-01',
          dueDate: '2026-01-05',
        });
        expect(res.status).toBe(400);
      },
    );

    it('TSK-API-08 an unknown sprintId / statusId / parentTaskId is a 400 naming the field', async () => {
      // REGRESSION LOCK — finding R61. All three are plain `@IsUUID()` fields
      // that used to be written straight into the row; the FK rejected them
      // inside Prisma and the caller got a bare "Internal server error" that
      // said nothing about any of them, so the screen could not tell the user
      // which field was wrong. `create()` now checks each reference first.
      const base = { title: title('bad fk'), projectId: fx.privateProjectId };

      const sprint = await postTask(fx.projectOwner.token, {
        ...base,
        sprintId: ABSENT_UUID,
      });
      expect(sprint.status).toBe(400);
      expect(msgOf(sprint)).toMatch(/sprintId/);

      const status = await postTask(fx.projectOwner.token, {
        ...base,
        statusId: ABSENT_UUID,
      });
      expect(status.status).toBe(400);
      expect(msgOf(status)).toMatch(/statusId/);

      const parent = await postTask(fx.projectOwner.token, {
        ...base,
        parentTaskId: ABSENT_UUID,
      });
      expect(parent.status).toBe(400);
      expect(msgOf(parent)).toMatch(/parentTaskId/);

      // Nothing was written on the way to any of those refusals.
      expect(
        await ctx.prisma.task.count({ where: { title: title('bad fk') } }),
      ).toBe(0);
    });

    it('TSK-API-09 an unknown assignee answers 404 on BOTH the create and the assign door', async () => {
      // REGRESSION LOCK — finding R61, and the contrast was the point:
      // `assign()` looked the employee up and threw
      // `NotFoundException('Employee not found')`, while `create()` handed the
      // same id to `assignees.connect` and let Prisma's P2025 escape as a 500.
      // Two doors, one question, two answers. They answer the same now.
      const created = await postTask(fx.projectOwner.token, {
        title: title('bad assignee'),
        projectId: fx.privateProjectId,
        assigneeId: ABSENT_UUID,
      });
      expect(created.status).toBe(404);
      expect(msgOf(created)).toBe('Employee not found');

      const task = await seedTask('assign door');
      const assigned = await ctx
        .http()
        .post(`/tasks/${task.id}/assign`)
        .set(bearer(fx.projectOwner.token))
        .send({ assigneeId: ABSENT_UUID });
      expect(assigned.status).toBe(404);
      expect(msgOf(assigned)).toBe('Employee not found');
    });

    it('TSK-API-10 (R58/R40) a statusId from ANOTHER project\'s workflow is refused, on create and on the board', async () => {
      // REGRESSION LOCK — finding R58. `create()` never checked that `statusId`
      // belonged to the project's OWN `workflowId`, so a status borrowed from
      // another project was stored and the task then appeared on NO kanban
      // board at all: its own board has no column with that id, and it was not
      // status-less either, so it missed the "unassigned" bucket `getKanban`
      // builds for legacy rows. It showed on the flat list and nowhere else.
      const foreignStatusId = fx.sharedWorkflowStatusIds[0];
      const res = await postTask(fx.projectOwner.token, {
        title: title('foreign status'),
        projectId: fx.privateProjectId,
        statusId: foreignStatusId,
      });
      expect(res.status).toBe(400);
      expect(msgOf(res)).toMatch(/another project's workflow/i);
      expect(
        await ctx.prisma.task.count({
          where: { title: title('foreign status') },
        }),
      ).toBe(0);

      // The project's OWN column is still accepted, and lands on the board.
      const ok = await postTask(fx.projectOwner.token, {
        title: title('own status'),
        projectId: fx.privateProjectId,
        statusId: fx.privateStatusIds[0],
      });
      expect(ok.status).toBe(201);
      const okId = dataOf(ok).id;
      const board = await ctx
        .http()
        .get(`/tasks/kanban?projectId=${fx.privateProjectId}`)
        .set(bearer(fx.projectOwner.token));
      expect(
        dataOf(board)
          .columns.flatMap((c: any) => c.tasks)
          .map((t: any) => t.id),
      ).toContain(okId);

      // The drag-and-drop door asks the same question…
      const moved = await ctx
        .http()
        .post(`/tasks/${okId}/move-status`)
        .set(bearer(fx.projectOwner.token))
        .send({ statusId: foreignStatusId });
      expect(moved.status).toBe(400);
      expect(msgOf(moved)).toMatch(/another project's workflow/i);

      // …and it now has a DTO at all (finding R40). `@Body('statusId')` binds a
      // bare property, and `ValidationPipe` only validates class metatypes, so
      // NOTHING was validated on this route: an absent or non-uuid statusId
      // went straight to Prisma. Same omission shape as the letters `reject`
      // reason (R5) and `AddDependencyDto` (R61).
      for (const body of [{}, { statusId: 'not-a-uuid' }, { statusId: 42 }]) {
        const bad = await ctx
          .http()
          .post(`/tasks/${okId}/move-status`)
          .set(bearer(fx.projectOwner.token))
          .send(body);
        expect(bad.status).toBe(400);
        expect(bodyOf(bad)).toMatch(/statusId/i);
      }

      // The row did not move on any of those refusals.
      expect(
        (await ctx.prisma.task.findUnique({
          where: { id: okId },
          select: { statusId: true },
        }))?.statusId,
      ).toBe(fx.privateStatusIds[0]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // B. Dependencies
  // ═══════════════════════════════════════════════════════════════════════════
  describe('B — dependencies', () => {
    it('TSK-API-11 all four DependencyType values are storable; an invalid one is a 400', async () => {
      const types = ['BLOCKS', 'BLOCKED_BY', 'RELATES_TO', 'DUPLICATES'];
      const dependent = await seedTask('dep types dependent');
      for (const type of types) {
        const blocker = await seedTask(`dep types ${type}`);
        const res = await addDependency(fx.projectOwner.token, dependent.id, {
          blockingTaskId: blocker.id,
          type,
        });
        expect(res.status).toBe(201);
        expect(dataOf(res).type).toBe(type);
      }
      const listed = await getDependencies(fx.projectOwner.token, dependent.id);
      expect(dataOf(listed).dependsOn.map((d: any) => d.type).sort()).toEqual(
        [...types].sort(),
      );

      // REGRESSION LOCK — finding R61's sibling. `addDependency` bound
      // `@Body('type') type: string` with no DTO, so `ValidationPipe` never saw
      // it and an unknown value reached the Postgres enum as a 500 — the same
      // omission shape as `letters.reject` (plan R5). `AddDependencyDto` now
      // carries `@IsEnum(DEPENDENCY_TYPES)`, and `blockingTaskId` an
      // `@IsUUID()` it never had either.
      const junk = await addDependency(fx.projectOwner.token, dependent.id, {
        blockingTaskId: (await seedTask('dep types junk')).id,
        type: 'SOMETIMES_BLOCKS',
      });
      expect(junk.status).toBe(400);
      expect(bodyOf(junk)).toMatch(/type/i);

      const noBlocker = await addDependency(fx.projectOwner.token, dependent.id, {
        type: 'BLOCKS',
      });
      expect(noBlocker.status).toBe(400);
      expect(bodyOf(noBlocker)).toMatch(/blockingTaskId/i);
    });

    it('TSK-API-12 a task cannot depend on itself', async () => {
      const t = await seedTask('self dep');
      const res = await addDependency(fx.projectOwner.token, t.id, {
        blockingTaskId: t.id,
      });
      expect(res.status).toBe(400);
      expect(msgOf(res)).toBe('A task cannot depend on itself');
      const listed = await getDependencies(fx.projectOwner.token, t.id);
      expect(dataOf(listed).dependsOn).toHaveLength(0);
    });

    it('TSK-API-13 a DIRECT cycle (A blocks B, then B blocks A) is refused', async () => {
      const a = await seedTask('cycle A');
      const b = await seedTask('cycle B');

      const first = await addDependency(fx.projectOwner.token, a.id, {
        blockingTaskId: b.id,
      });
      expect(first.status).toBe(201);

      const reverse = await addDependency(fx.projectOwner.token, b.id, {
        blockingTaskId: a.id,
      });
      expect(reverse.status).toBe(400);
      expect(msgOf(reverse)).toBe('Circular dependency detected');

      const listed = await getDependencies(fx.projectOwner.token, b.id);
      expect(dataOf(listed).dependsOn).toHaveLength(0);
      expect(dataOf(listed).blocks).toHaveLength(1);
    });

    it('TSK-API-14 (R56) an INDIRECT cycle (A→B→C→A) is refused too', async () => {
      // REGRESSION LOCK — finding R56. `addDependency` looked for exactly ONE
      // reverse edge — `findUnique` on `(dependentTaskId, blockingTaskId)`
      // swapped — and walked nothing. A three-node ring built happily, and
      // every task in it was permanently blocked by another task in it: no
      // scheduler, Gantt render or "what can I start" query over that graph
      // terminates with an answer.
      //
      // The check is now a breadth-first walk from the proposed BLOCKER over
      // what it depends on, bounded by a visited set (which alone guarantees
      // termination) plus a depth/node cap that REFUSES rather than admits when
      // it bites.
      const a = await seedTask('ring A');
      const b = await seedTask('ring B');
      const c = await seedTask('ring C');

      expect(
        (await addDependency(fx.projectOwner.token, a.id, { blockingTaskId: b.id }))
          .status,
      ).toBe(201);
      expect(
        (await addDependency(fx.projectOwner.token, b.id, { blockingTaskId: c.id }))
          .status,
      ).toBe(201);

      const closing = await addDependency(fx.projectOwner.token, c.id, {
        blockingTaskId: a.id,
      });
      expect(closing.status).toBe(400);
      expect(msgOf(closing)).toBe('Circular dependency detected');

      // Nothing was written, and the open chain is exactly as it was.
      expect(
        await ctx.prisma.taskDependency.count({
          where: { dependentTaskId: c.id, blockingTaskId: a.id },
        }),
      ).toBe(0);
      const cDeps = dataOf(await getDependencies(fx.projectOwner.token, c.id));
      expect(cDeps.dependsOn).toHaveLength(0);
      expect(cDeps.blocks).toHaveLength(1);

      // A longer ring is refused at the same door — the walk is not a
      // fixed-depth peek. A→B→C→D→E, then E→A.
      const d = await seedTask('ring D');
      const e = await seedTask('ring E');
      expect(
        (await addDependency(fx.projectOwner.token, c.id, { blockingTaskId: d.id }))
          .status,
      ).toBe(201);
      expect(
        (await addDependency(fx.projectOwner.token, d.id, { blockingTaskId: e.id }))
          .status,
      ).toBe(201);
      const longRing = await addDependency(fx.projectOwner.token, e.id, {
        blockingTaskId: a.id,
      });
      expect(longRing.status).toBe(400);
      expect(msgOf(longRing)).toBe('Circular dependency detected');

      // …while a DIAMOND — two paths to the same blocker, no ring — is still a
      // perfectly ordinary graph and is accepted. A walk that refused this
      // would have swapped one broken product for another.
      const top = await seedTask('diamond top');
      const left = await seedTask('diamond left');
      const right = await seedTask('diamond right');
      const bottom = await seedTask('diamond bottom');
      for (const [dep, blk] of [
        [top, left],
        [top, right],
        [left, bottom],
        [right, bottom],
      ] as const) {
        expect(
          (
            await addDependency(fx.projectOwner.token, dep.id, {
              blockingTaskId: blk.id,
            })
          ).status,
        ).toBe(201);
      }
    });

    it('TSK-API-15 a duplicate dependency is a 409, and the first edge is untouched', async () => {
      // REGRESSION LOCK — finding R61. `@@unique([dependentTaskId,
      // blockingTaskId])` always did its job — the second row is refused by the
      // database — but P2002 was not mapped, so the UI's "add" button answered
      // "Internal server error" instead of the 409 that lets it say "already
      // linked".
      const dependent = await seedTask('dup dep dependent');
      const blocker = await seedTask('dup dep blocker');

      const first = await addDependency(fx.projectOwner.token, dependent.id, {
        blockingTaskId: blocker.id,
      });
      expect(first.status).toBe(201);

      const second = await addDependency(fx.projectOwner.token, dependent.id, {
        blockingTaskId: blocker.id,
        type: 'RELATES_TO',
      });
      expect(second.status).toBe(409);
      expect(msgOf(second)).toMatch(/already linked|already/i);

      const rows = await ctx.prisma.taskDependency.findMany({
        where: { dependentTaskId: dependent.id, blockingTaskId: blocker.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('BLOCKS');
    });

    it('TSK-API-16 deleting a blocking task leaves the edge behind, and only TASK_EDIT can cut it', async () => {
      const dependent = await seedTask('delete blocker dependent');
      const blocker = await seedTask('delete blocker blocking');
      const added = await addDependency(fx.projectOwner.token, dependent.id, {
        blockingTaskId: blocker.id,
      });
      expect(added.status).toBe(201);
      const depId = dataOf(added).id;

      // `remove()` is a SOFT delete, and `TaskDependency` cascades only on a
      // HARD one. So the edge survives, still pointing at a task that no longer
      // resolves — `GET /tasks/:id` on it is a 404 while the dependency panel
      // keeps drawing it.
      const deleted = await ctx
        .http()
        .delete(`/tasks/${blocker.id}`)
        .set(bearer(fx.projectOwner.token));
      expect(deleted.status).toBe(200);
      expect(
        (await getTask(fx.projectOwner.token, blocker.id)).status,
      ).toBe(404);

      const listed = await getDependencies(fx.projectOwner.token, dependent.id);
      expect(dataOf(listed).dependsOn).toHaveLength(1);
      expect(dataOf(listed).dependsOn[0].blockingTask.id).toBe(blocker.id);

      // REGRESSION LOCK — finding R55. `DELETE /tasks/dependencies/:depId`
      // carried NO `@RequireProjectPermission` and no `@Roles` — the only
      // guard that ran was JwtAuthGuard — while `POST :id/dependencies` two
      // lines above it needs TASK_EDIT. `projectOutsider` is a MANAGER who is a
      // member of nothing, and the edge lives in a PRIVATE project; they cut
      // it. The delete now resolves the project through the dependency row
      // (`from: 'taskDependency'`) and demands the same TASK_EDIT as the add.
      const refused = await delDependency(fx.projectOutsider.token, depId);
      expect(refused.status).toBe(403);
      expect(
        await ctx.prisma.taskDependency.findUnique({ where: { id: depId } }),
      ).not.toBeNull();

      // …and the principal who may, does — a gate that refused everyone would
      // read the same from the outsider's side.
      const cut = await delDependency(fx.projectOwner.token, depId);
      expect(cut.status).toBe(200);
      expect(msgOf(cut)).toBe('Dependency removed');
      expect(
        await ctx.prisma.taskDependency.findUnique({ where: { id: depId } }),
      ).toBeNull();

      // An unknown dependency id is still the handler's own 404, not a
      // permission error — the guard cannot resolve a project for a row that
      // does not exist, and says nothing rather than the wrong thing.
      const ghost = await delDependency(fx.projectOwner.token, ABSENT_UUID);
      expect(ghost.status).toBe(404);
      expect(msgOf(ghost)).toBe('Dependency not found');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // C. Subtasks
  // ═══════════════════════════════════════════════════════════════════════════
  describe('C — subtasks', () => {
    it('TSK-API-17 a subtask inherits project and column, defaults to SUBTASK, and is hidden from the board', async () => {
      const parent = await seedTask('subtask parent', {
        statusId: fx.privateStatusIds[1],
      });
      const created = await postSubtask(fx.projectOwner.token, parent.id, {
        title: title('subtask child'),
      });
      expect(created.status).toBe(201);
      const child = dataOf(created);
      expect(child.parentTaskId).toBe(parent.id);
      expect(child.projectId).toBe(fx.privateProjectId);
      expect(child.statusId).toBe(fx.privateStatusIds[1]);
      expect(child.type).toBe('SUBTASK');

      const under = await getSubtasks(fx.projectOwner.token, parent.id);
      expect(dataOf(under).map((t: any) => t.id)).toEqual([child.id]);

      // `buildWhere` forces `parentTaskId: null` whenever a projectId is given,
      // so a subtask appears under its parent and nowhere else.
      const flat = await listTasks(
        fx.projectOwner.token,
        `projectId=${fx.privateProjectId}&limit=200`,
      );
      const codes = dataOf(flat).map((t: any) => t.taskCode);
      expect(codes).toContain(parent.taskCode);
      expect(codes).not.toContain(child.taskCode);

      const board = await ctx
        .http()
        .get(`/tasks/kanban?projectId=${fx.privateProjectId}`)
        .set(bearer(fx.projectOwner.token));
      const onBoard = dataOf(board)
        .columns.flatMap((c: any) => c.tasks)
        .map((t: any) => t.taskCode);
      expect(onBoard).not.toContain(child.taskCode);
    });

    it('TSK-API-18 (R62) the hierarchy is capped at five levels', async () => {
      // REGRESSION LOCK — finding R62's second half. The tree was unbounded,
      // and `findOne` only ever expands ONE level of `childTasks`, so
      // everything below a grandchild was already invisible from the parent's
      // detail payload while still counting in its own parent's
      // `_count.childTasks`. Five levels is generous next to Jira's one below a
      // standard issue; the point is that there IS a bottom.
      const chain: Array<{ id: string; taskCode: string }> = [
        await seedTask('depth L1'),
      ];
      for (let level = 2; level <= 5; level++) {
        const res = await postSubtask(
          fx.projectOwner.token,
          chain[chain.length - 1].id,
          { title: title(`depth L${level}`) },
        );
        expect(res.status).toBe(201);
        expect(dataOf(res).parentTaskId).toBe(chain[chain.length - 1].id);
        chain.push({ id: dataOf(res).id, taskCode: dataOf(res).taskCode });
      }

      const sixth = await postSubtask(
        fx.projectOwner.token,
        chain[chain.length - 1].id,
        { title: title('depth L6') },
      );
      expect(sixth.status).toBe(400);
      expect(msgOf(sixth)).toMatch(/limited to 5 levels/i);
      expect(
        await ctx.prisma.task.count({ where: { title: title('depth L6') } }),
      ).toBe(0);

      // The same cap on the flat create door, which takes `parentTaskId`
      // directly and used to bypass `createSubtask` entirely.
      const flat = await postTask(fx.projectOwner.token, {
        title: title('depth L6 flat'),
        projectId: fx.privateProjectId,
        parentTaskId: chain[chain.length - 1].id,
      });
      expect(flat.status).toBe(400);
      expect(msgOf(flat)).toMatch(/limited to 5 levels/i);

      // Recorded, not judged, and unchanged: `findOne` still expands exactly
      // one level, so a grandchild is nowhere in the root's payload.
      const detail = dataOf(await getTask(fx.projectOwner.token, chain[0].id));
      expect(detail.childTasks.map((c: any) => c.id)).toEqual([chain[1].id]);
      expect(JSON.stringify(detail.childTasks)).not.toContain(chain[2].id);
    });

    it('TSK-API-19 (R62) type and parentage must agree — no EPIC under a parent, no parentless SUBTASK', async () => {
      // REGRESSION LOCK — finding R62. `createSubtask` set
      // `type: dto.type ?? 'SUBTASK'`, so `type: 'EPIC'` gave a row that was
      // simultaneously an EPIC and somebody's child, and the mirror hole let a
      // TOP-LEVEL task declare itself a SUBTASK with no parent at all. Either
      // way `types=` filtering and every "epics" view disagreed with the tree
      // they were drawn from.
      const parent = await seedTask('type parent');
      const child = await postSubtask(fx.projectOwner.token, parent.id, {
        title: title('epic child'),
        type: 'EPIC',
      });
      expect(child.status).toBe(400);
      expect(msgOf(child)).toMatch(/EPIC/);
      expect(
        await ctx.prisma.task.count({ where: { title: title('epic child') } }),
      ).toBe(0);

      const orphanSubtask = await postTask(fx.projectOwner.token, {
        title: title('parentless subtask'),
        projectId: fx.privateProjectId,
        type: 'SUBTASK',
      });
      expect(orphanSubtask.status).toBe(400);
      expect(msgOf(orphanSubtask)).toMatch(/SUBTASK/);

      // PATCH is the third door onto the same pair of fields, and it asks the
      // same question against what the row will BE.
      const plain = await seedTask('type patch subject');
      const toSubtask = await patchTask(fx.projectOwner.token, plain.id, {
        type: 'SUBTASK',
      });
      expect(toSubtask.status).toBe(400);

      // What IS allowed: the default, and a STORY or BUG under an epic — a
      // story inside an epic is the ordinary case, not a defect.
      const defaulted = await postSubtask(fx.projectOwner.token, parent.id, {
        title: title('defaulted child'),
      });
      expect(defaulted.status).toBe(201);
      expect(dataOf(defaulted).type).toBe('SUBTASK');

      const epic = await postTask(fx.projectOwner.token, {
        title: title('top epic'),
        projectId: fx.privateProjectId,
        type: 'EPIC',
      });
      expect(epic.status).toBe(201);
      const story = await postSubtask(fx.projectOwner.token, dataOf(epic).id, {
        title: title('story under epic'),
        type: 'STORY',
      });
      expect(story.status).toBe(201);
      expect(dataOf(story).type).toBe('STORY');
      expect(dataOf(story).parentTaskId).toBe(dataOf(epic).id);
    });

    it('TSK-API-20 archiving a parent leaves its children live and unarchived', async () => {
      const parent = await seedTask('archive parent');
      const child = dataOf(
        await postSubtask(fx.projectOwner.token, parent.id, {
          title: title('archive child'),
        }),
      );

      const archived = await ctx
        .http()
        .post(`/tasks/${parent.id}/archive`)
        .set(bearer(fx.projectOwner.token));
      // POST, so Nest's default 201 — archive is not a creation, but that is
      // the status the screen has always had to read.
      expect(archived.status).toBe(201);

      const parentRow = await ctx.prisma.task.findUnique({
        where: { id: parent.id },
        select: { isArchived: true },
      });
      expect(parentRow?.isArchived).toBe(true);

      // The child is untouched: still open, still readable, still listed under
      // an archived parent.
      const childRow = await ctx.prisma.task.findUnique({
        where: { id: child.id },
        select: { isArchived: true, deletedAt: true },
      });
      expect(childRow?.isArchived).toBe(false);
      expect(childRow?.deletedAt).toBeNull();
      expect((await getTask(fx.projectOwner.token, child.id)).status).toBe(200);
      const under = await getSubtasks(fx.projectOwner.token, parent.id);
      expect(dataOf(under).map((t: any) => t.id)).toContain(child.id);
    });

    it('TSK-API-21 (R57) deleting a parent takes its whole subtree with it', async () => {
      // REGRESSION LOCK — finding R57, the sharpest of the three. `remove()`
      // soft-deleted ONLY the row it was given. The child kept `parentTaskId`
      // pointing at a task that 404s, and because `buildWhere` hides anything
      // with a parent from the project list and the board, the child became a
      // live, assignable, status-changeable task that appeared on NO screen —
      // reachable only by its own uuid, or through
      // `/tasks/:deletedParentId/subtasks`.
      //
      // The fix CASCADES rather than re-parenting to null: deleting a parent is
      // a statement about the work it breaks down, and re-parenting would
      // promote breakdown items onto the board as top-level cards nobody put
      // there. What both options had to guarantee — and this one does — is that
      // nothing is left live and unreachable.
      const parent = await seedTask('delete parent');
      const child = dataOf(
        await postSubtask(fx.projectOwner.token, parent.id, {
          title: title('orphan child'),
        }),
      );
      const grandchild = dataOf(
        await postSubtask(fx.projectOwner.token, child.id, {
          title: title('orphan grandchild'),
        }),
      );

      const deleted = await ctx
        .http()
        .delete(`/tasks/${parent.id}`)
        .set(bearer(fx.projectOwner.token));
      expect(deleted.status).toBe(200);
      expect(deleted.body.deletedSubtaskCount).toBe(2);
      expect((await getTask(fx.projectOwner.token, parent.id)).status).toBe(404);

      // The whole subtree went, not just the level below.
      for (const id of [child.id, grandchild.id]) {
        const row = await ctx.prisma.task.findUnique({
          where: { id },
          select: { deletedAt: true },
        });
        expect(row?.deletedAt).not.toBeNull();
        expect((await getTask(fx.projectOwner.token, id)).status).toBe(404);
      }

      const flat = await listTasks(
        fx.projectOwner.token,
        `projectId=${fx.privateProjectId}&limit=200`,
      );
      const codes = dataOf(flat).map((t: any) => t.taskCode);
      expect(codes).not.toContain(parent.taskCode);
      expect(codes).not.toContain(child.taskCode);

      // …and the deleted parent's `/subtasks` door, which has no guard and does
      // not check the parent, now has nothing left to hand anybody.
      const under = await getSubtasks(fx.projectOwner.token, parent.id);
      expect(under.status).toBe(200);
      expect(dataOf(under)).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // D. Labels
  // ═══════════════════════════════════════════════════════════════════════════
  describe('D — labels', () => {
    let labelA = '';
    let labelB = '';
    let foreignLabel = '';

    beforeAll(async () => {
      // Created directly rather than over the API: these three exist to give the
      // data-rule cases below a fixed starting point, including the same-name
      // pair across two projects that TSK-API-23 asserts.
      const a = await ctx.prisma.label.create({
        data: {
          name: `alpha-${fx.runId}`,
          color: '#FF0000',
          projectId: fx.privateProjectId,
        },
      });
      const b = await ctx.prisma.label.create({
        data: {
          name: `beta-${fx.runId}`,
          color: '#00FF00',
          projectId: fx.privateProjectId,
        },
      });
      const foreign = await ctx.prisma.label.create({
        data: {
          name: `alpha-${fx.runId}`,
          color: '#0000FF',
          projectId: fx.internalProjectId,
        },
      });
      labelA = a.id;
      labelB = b.id;
      foreignLabel = foreign.id;
      extraLabelIds.push(a.id, b.id, foreign.id);
    });

    it('TSK-API-22 /labels is mounted and reachable — harness regression lock', async () => {
      // This case began life as a PIN: `LabelsModule` was in `src/app.module.ts`
      // but absent from `test/utils/test-app.module.ts`, so every `/labels` call
      // answered Nest's own "Cannot POST /labels" and the whole controller was
      // untestable rather than merely untested — the same class of harness lie
      // WP-0's H1/H2 exist to catch, and the same one Phase 4 hit with
      // `PayrollBatchesModule`. The module has since been registered, so the pin
      // and its `it.failing` twin have collapsed into this single assertion of
      // the correct behaviour, which is what the convention asks for.
      const created = await ctx
        .http()
        .post('/labels')
        .set(bearer(fx.admin.token))
        .send({ name: `probe-${fx.runId}`, projectId: fx.privateProjectId });
      expect(created.status).toBe(201);
      extraLabelIds.push(dataOf(created).id);

      const listed = await ctx
        .http()
        .get(`/labels?projectId=${fx.privateProjectId}`)
        .set(bearer(fx.admin.token));
      expect(listed.status).toBe(200);
    });

    it('TSK-API-22b the label API is project-gated on both the read and the write door', async () => {
      // REGRESSION LOCK — finding R21/R60, the third instance of the same
      // shape. `LabelsController` carried only `@UseGuards(JwtAuthGuard,
      // RolesGuard)` with a global-role list — no `@RequireProjectPermission`,
      // no membership check anywhere on it — and the service took `projectId`
      // straight from the body. So a MANAGER who was a member of nothing wrote
      // into a PRIVATE project's label set, and ANY employee read it back.
      // Labels are cosmetic on their own, but the list is a private project's
      // taxonomy — sprint names, client names, workstreams — served to anyone
      // who could guess a project id.
      //
      // Writes now need TASK_EDIT (a label is task metadata, and that is the
      // permission which already governs it); reads need membership. The
      // contrast that made it a defect is the assertion that closes it: the
      // outsider still cannot read the project the label belongs to.
      const outsiderWrite = await ctx
        .http()
        .post('/labels')
        .set(bearer(fx.projectOutsider.token))
        .send({ name: `outsider-${fx.runId}`, projectId: fx.privateProjectId });
      expect(outsiderWrite.status).toBe(403);
      expect(
        await ctx.prisma.label.count({
          where: { name: `outsider-${fx.runId}` },
        }),
      ).toBe(0);

      const readProject = await ctx
        .http()
        .get(`/projects/${fx.privateProjectId}`)
        .set(bearer(fx.projectOutsider.token));
      expect(readProject.status).toBe(403);

      // A plain EMPLOYEE with no relationship to the project is refused the
      // taxonomy too — this was never about the outsider's MANAGER role.
      const employeeRead = await ctx
        .http()
        .get(`/labels?projectId=${fx.privateProjectId}`)
        .set(bearer(fx.employee.token));
      expect(employeeRead.status).toBe(403);

      // …while a member of the project reads it, and the manager preset writes
      // it: gated, not closed.
      const memberRead = await ctx
        .http()
        .get(`/labels?projectId=${fx.privateProjectId}`)
        .set(bearer(fx.projectMember.token));
      expect(memberRead.status).toBe(200);
      expect(Array.isArray(dataOf(memberRead))).toBe(true);

      const presetWrite = await ctx
        .http()
        .post('/labels')
        .set(bearer(fx.projectManager.token))
        .send({ name: `preset-${fx.runId}`, projectId: fx.privateProjectId });
      expect(presetWrite.status).toBe(201);
      extraLabelIds.push(dataOf(presetWrite).id);
    });

    it('TSK-API-22c a label\'s own routes resolve the project through the label row', async () => {
      // PATCH/DELETE carry a label id, not a projectId, so they need
      // `from: 'label'` to find the project they are protecting. Without it the
      // guard would fail open into "context could not be resolved" and the
      // write door would be gated while the edit door was not.
      const own = await ctx.prisma.label.create({
        data: { name: `gated-${fx.runId}`, projectId: fx.privateProjectId },
      });
      extraLabelIds.push(own.id);

      const outsiderPatch = await ctx
        .http()
        .patch(`/labels/${own.id}`)
        .set(bearer(fx.projectOutsider.token))
        .send({ color: '#123456' });
      expect(outsiderPatch.status).toBe(403);

      const outsiderDelete = await ctx
        .http()
        .delete(`/labels/${own.id}`)
        .set(bearer(fx.projectOutsider.token));
      expect(outsiderDelete.status).toBe(403);
      expect(
        await ctx.prisma.label.findUnique({ where: { id: own.id } }),
      ).not.toBeNull();

      const ownerPatch = await ctx
        .http()
        .patch(`/labels/${own.id}`)
        .set(bearer(fx.projectOwner.token))
        .send({ color: '#123456' });
      expect(ownerPatch.status).toBe(200);

      // An unknown label id is the handler's own 404, not a permission error.
      const ghost = await ctx
        .http()
        .patch(`/labels/${ABSENT_UUID}`)
        .set(bearer(fx.admin.token))
        .send({ color: '#123456' });
      expect(ghost.status).toBe(404);
      expect(msgOf(ghost)).toBe('Label not found');
    });

    it('TSK-API-22d a duplicate label name answers 409, not an unmapped P2002', async () => {
      // REGRESSION LOCK — finding R60/R61. `@@unique([projectId, name])` is
      // real (TSK-API-23 proves it at the database), but the service did not
      // catch P2002, so the API answered a bare 500 rather than the 409 the
      // same collision produces elsewhere in the codebase. Same shape as R32
      // (sprints, statuses) and R46 (projects).
      const dup = await ctx
        .http()
        .post('/labels')
        .set(bearer(fx.admin.token))
        .send({ name: `alpha-${fx.runId}`, projectId: fx.privateProjectId });
      expect(dup.status).toBe(409);
      expect(msgOf(dup)).toMatch(new RegExp(`alpha-${fx.runId}`));

      // The same name in ANOTHER project is still a different label, so the
      // 409 is the constraint speaking and not a global name ban.
      const elsewhere = await ctx
        .http()
        .post('/labels')
        .set(bearer(fx.admin.token))
        .send({ name: `alpha-${fx.runId}`, projectId: fx.publicProjectId });
      expect(elsewhere.status).toBe(201);
      // Removed here rather than in `afterAll`: TSK-API-23 asserts the exact
      // set of projects carrying this name, and a third would break it for a
      // reason that has nothing to do with the constraint under test.
      await ctx.prisma.label.delete({ where: { id: dataOf(elsewhere).id } });
    });

    it('TSK-API-23 @@unique([projectId, name]) holds in the e2e database, and is per project', async () => {
      // `prisma db push` builds the e2e schema, and it cannot create partial or
      // expression indexes (plan H3) — a plain composite unique it CAN, and
      // this proves the constraint is really there rather than assumed.
      await expect(
        ctx.prisma.label.create({
          data: { name: `alpha-${fx.runId}`, projectId: fx.privateProjectId },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      // The same name in a different project is a different label — that pair
      // already exists from the fixture above.
      const both = await ctx.prisma.label.findMany({
        where: { name: `alpha-${fx.runId}` },
        select: { projectId: true },
      });
      expect(both.map((l) => l.projectId).sort()).toEqual(
        [fx.privateProjectId, fx.internalProjectId].sort(),
      );
    });

    it('TSK-API-24 labels attach on create and detach on update through TaskLabel', async () => {
      const created = await postTask(fx.projectOwner.token, {
        title: title('labelled'),
        projectId: fx.privateProjectId,
        statusId: fx.privateStatusIds[0],
        labelIds: [labelA, labelB],
      });
      expect(created.status).toBe(201);
      const taskId = dataOf(created).id;
      expect(
        dataOf(created)
          .labels.map((l: any) => l.label.id)
          .sort(),
      ).toEqual([labelA, labelB].sort());

      const rows = await ctx.prisma.taskLabel.findMany({ where: { taskId } });
      expect(rows).toHaveLength(2);

      // `update()` replaces the whole set: deleteMany then create.
      const swapped = await patchTask(fx.projectOwner.token, taskId, {
        labelIds: [labelB],
      });
      expect(swapped.status).toBe(200);
      expect(dataOf(swapped).labels.map((l: any) => l.label.id)).toEqual([labelB]);

      const cleared = await patchTask(fx.projectOwner.token, taskId, {
        labelIds: [],
      });
      expect(cleared.status).toBe(200);
      expect(dataOf(cleared).labels).toEqual([]);
      expect(await ctx.prisma.taskLabel.count({ where: { taskId } })).toBe(0);

      // …and the label filter finds it while it is attached.
      const reattached = await patchTask(fx.projectOwner.token, taskId, {
        labelIds: [labelA],
      });
      expect(reattached.status).toBe(200);
      const filtered = await listTasks(
        fx.projectOwner.token,
        `projectId=${fx.privateProjectId}&labels=${labelA}&limit=200`,
      );
      expect(dataOf(filtered).map((t: any) => t.id)).toContain(taskId);
    });

    it('TSK-API-25 a label belonging to ANOTHER project attaches without complaint', async () => {
      // KNOWN GAP. Nothing compares `Label.projectId` with `Task.projectId`, so
      // a private project's task can carry an internal project's label. The
      // label picker on the board only lists the project's own labels, so the
      // chip that comes back cannot be removed from the UI that put it there.
      const created = await postTask(fx.projectOwner.token, {
        title: title('foreign label'),
        projectId: fx.privateProjectId,
        statusId: fx.privateStatusIds[0],
        labelIds: [foreignLabel],
      });
      expect(created.status).toBe(201);
      const attached = dataOf(created).labels[0].label;
      expect(attached.id).toBe(foreignLabel);
      expect(attached.projectId).toBe(fx.internalProjectId);
    });

    it.failing(
      'TSK-API-25b a label from another project should be refused',
      async () => {
        const created = await postTask(fx.projectOwner.token, {
          title: title('foreign label twin'),
          projectId: fx.privateProjectId,
          statusId: fx.privateStatusIds[0],
          labelIds: [foreignLabel],
        });
        expect(created.status).toBe(400);
      },
    );

    it('TSK-API-26 the same label twice in one payload is de-duplicated, and deleting a label silently strips it off every task', async () => {
      // REGRESSION LOCK — finding R61 (first half). `TaskLabel` is
      // `@@id([taskId, labelId])`; the create wrote the array verbatim, so a
      // duplicated id was a composite-PK violation the caller saw as a 500 —
      // and the UI's multi-select can produce exactly that. Selecting the same
      // label twice means one label, so the payload is de-duplicated.
      const dup = await postTask(fx.projectOwner.token, {
        title: title('dup labels'),
        projectId: fx.privateProjectId,
        statusId: fx.privateStatusIds[0],
        labelIds: [labelA, labelA],
      });
      expect(dup.status).toBe(201);
      expect(dataOf(dup).labels.map((l: any) => l.label.id)).toEqual([labelA]);
      expect(
        await ctx.prisma.taskLabel.count({
          where: { taskId: dataOf(dup).id },
        }),
      ).toBe(1);

      // …and the same on the update door, which replaces the whole set.
      const reDup = await patchTask(fx.projectOwner.token, dataOf(dup).id, {
        labelIds: [labelB, labelB, labelA],
      });
      expect(reDup.status).toBe(200);
      expect(
        dataOf(reDup)
          .labels.map((l: any) => l.label.id)
          .sort(),
      ).toEqual([labelA, labelB].sort());

      // Second half — recorded rather than judged: `Label` → `TaskLabel` is
      // `onDelete: Cascade`, so removing a label in use is not refused. Every
      // task wearing it loses the chip with no trace in the task's activity
      // log, which is what makes it worth pinning.
      const doomed = await ctx.prisma.label.create({
        data: { name: `doomed-${fx.runId}`, projectId: fx.privateProjectId },
      });
      extraLabelIds.push(doomed.id);
      const wearer = await postTask(fx.projectOwner.token, {
        title: title('label wearer'),
        projectId: fx.privateProjectId,
        statusId: fx.privateStatusIds[0],
        labelIds: [doomed.id],
      });
      expect(wearer.status).toBe(201);
      const wearerId = dataOf(wearer).id;

      await ctx.prisma.label.delete({ where: { id: doomed.id } });

      expect(
        await ctx.prisma.taskLabel.count({ where: { taskId: wearerId } }),
      ).toBe(0);
      const after = await getTask(fx.projectOwner.token, wearerId);
      expect(after.status).toBe(200);
      expect(dataOf(after).labels).toEqual([]);
      const activity = dataOf(after).activities.map((a: any) => a.activityType);
      expect(activity).not.toContain('LABEL_REMOVED');
    });

  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E. THE FINDINGS — R8 (the bulk door) and R21 (two unguarded controllers)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('E — the findings', () => {
    it('TSK-API-27 the SINGLE-task assign door IS project-gated — the control for TSK-API-28', async () => {
      const task = await seedTask('single assign gate');

      // `projectOutsider` is role MANAGER, so the service's own
      // `['ADMIN','HR_MANAGER','MANAGER']` check passes. What stops them is
      // `@RequireProjectPermission(TASK_ASSIGN, { from: 'task' })` on the
      // controller, resolving the PRIVATE project they are not a member of.
      const res = await ctx
        .http()
        .post(`/tasks/${task.id}/assign`)
        .set(bearer(fx.projectOutsider.token))
        .send({ assigneeId: fx.managedEmployeeId });
      expect(res.status).toBe(403);
      expect(msgOf(res)).toMatch(/permission/i);

      const row = await ctx.prisma.task.findUnique({
        where: { id: task.id },
        include: { assignees: { select: { id: true } } },
      });
      expect(row?.assignees).toHaveLength(0);
    });

    it('TSK-API-28 (R8) the BULK door is exactly as strong as the single door', async () => {
      // REGRESSION LOCK — finding R8. `POST /tasks/bulk-assign` carried only
      // `@Roles('ADMIN','HR_MANAGER','MANAGER')` and NO
      // `@RequireProjectPermission`, so the project guard never ran: there was
      // no project id in the metadata for it to resolve, while every other task
      // write in this controller was project-gated.
      //
      // The contrast with TSK-API-27 was the whole finding: the SINGLE-task
      // door needs `TASK_ASSIGN` on this specific project and refuses this
      // exact caller 403, while the BULK door — which does strictly more, to
      // many tasks at once — asked only "are you a MANAGER somewhere". A
      // MANAGER who was a member of nothing bulk-assigned tasks inside a
      // PRIVATE project and then read them back through `/tasks/my-tasks`,
      // which is keyed on assignment. The payload may span several projects, so
      // the service resolves and checks each one.
      const one = await seedTask('bulk victim one');
      const two = await seedTask('bulk victim two');

      const res = await ctx
        .http()
        .post('/tasks/bulk-assign')
        .set(bearer(fx.projectOutsider.token))
        .send({
          taskIds: [one.id, two.id],
          assigneeId: fx.outsiderEmployeeId,
        });
      expect(res.status).toBe(403);
      expect(msgOf(res)).toMatch(/permission/i);

      // Nothing was written — a 403 after a partial write would be worse than
      // the hole it replaced.
      const rows = await ctx.prisma.task.findMany({
        where: { id: { in: [one.id, two.id] } },
        include: { assignees: { select: { id: true } } },
      });
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.assignees).toHaveLength(0);
      }

      // …so the private project's tasks never reach `/tasks/my-tasks` either.
      const mine = await ctx
        .http()
        .get('/tasks/my-tasks')
        .set(bearer(fx.projectOutsider.token));
      expect(mine.status).toBe(200);
      const codes = dataOf(mine).map((t: any) => t.taskCode);
      expect(codes).not.toContain(one.taskCode);
      expect(codes).not.toContain(two.taskCode);

      // The principal who HOLDS TASK_ASSIGN on the project still bulk-assigns —
      // and this is the manager PRESET, an EMPLOYEE, which the old global-role
      // gate would have refused outright (R41).
      const allowed = await ctx
        .http()
        .post('/tasks/bulk-assign')
        .set(bearer(fx.projectManager.token))
        .send({
          taskIds: [one.id, two.id],
          assigneeId: fx.managedEmployeeId,
        });
      expect(allowed.status).toBe(201);
      expect(msgOf(allowed)).toMatch(/2 tasks assigned/);
      const after = await ctx.prisma.task.findMany({
        where: { id: { in: [one.id, two.id] } },
        include: { assignees: { select: { id: true } } },
      });
      for (const r of after) {
        expect(r.assignees.map((a) => a.id)).toContain(fx.managedEmployeeId);
      }
    });

    it('TSK-API-28b (R8) one unauthorised project in the batch refuses the whole batch', async () => {
      // The multi-project half of the same finding: the payload is not
      // necessarily one project's worth of work, so a caller who holds
      // TASK_ASSIGN on A and nothing on B must not move B's rows by putting
      // them in the same array as A's.
      const ours = await seedTask('bulk mixed ours');
      const theirs = await ctx.prisma.task.create({
        data: {
          taskCode: `TSKX-${fx.runId}`.slice(0, 20),
          title: title('bulk mixed theirs'),
          projectId: fx.internalProjectId,
        },
        select: { id: true },
      });

      const res = await ctx
        .http()
        .post('/tasks/bulk-assign')
        .set(bearer(fx.projectManager.token))
        .send({
          taskIds: [ours.id, theirs.id],
          assigneeId: fx.managedEmployeeId,
        });
      expect(res.status).toBe(403);

      // Neither half moved — not the one they were entitled to either.
      const rows = await ctx.prisma.task.findMany({
        where: { id: { in: [ours.id, theirs.id] } },
        include: { assignees: { select: { id: true } } },
      });
      for (const r of rows) expect(r.assignees).toHaveLength(0);

      await ctx.prisma.task.delete({ where: { id: theirs.id } });
    });

    it('TSK-API-29 (R21) a non-member can neither read nor write COMMENTS on a PRIVATE project task', async () => {
      // REGRESSION LOCK — finding R21. `TaskCommentsController` was
      // `@UseGuards(JwtAuthGuard, RolesGuard)` with no `ProjectPermissionGuard`
      // anywhere, and `findByTask(taskId)` took an id and read: no membership
      // check, no project check and no `isPrivate` check on any of its four
      // doors.
      //
      // The sibling RBAC spec asserts the permission question. This case
      // asserts the DATA consequence: the actual comment BODIES, and the author
      // emails beside them, used to cross the wire to someone the project's
      // visibility rules exclude entirely.
      const task = await seedTask('private discussion');
      const secret = `board-decision ${fx.runId}: headcount cut to 4`;
      const insider = await postComment(fx.projectMember.token, {
        taskId: task.id,
        comment: secret,
      });
      expect(insider.status).toBe(201);

      // The outsider cannot see the project…
      const project = await ctx
        .http()
        .get(`/projects/${fx.privateProjectId}`)
        .set(bearer(fx.projectOutsider.token));
      expect(project.status).toBe(403);

      // …and no longer reads the discussion on its tasks either.
      const read = await listComments(fx.projectOutsider.token, task.id);
      expect(read.status).toBe(403);
      expect(bodyOf(read)).not.toContain(secret);
      expect(bodyOf(read)).not.toContain(fx.projectMember.email);

      // Nor writes into it.
      const written = await postComment(fx.projectOutsider.token, {
        taskId: task.id,
        comment: `outsider ${fx.runId} was here`,
      });
      expect(written.status).toBe(403);
      const after = await listComments(fx.projectMember.token, task.id);
      expect(dataOf(after).map((c: any) => c.comment)).not.toContain(
        `outsider ${fx.runId} was here`,
      );

      // A plain EMPLOYEE with no relationship to the project at all is refused
      // too — this was never about the outsider's MANAGER role.
      const stranger = await listComments(fx.employee.token, task.id);
      expect(stranger.status).toBe(403);

      // …while the thread is exactly where it was for the people in the
      // project, viewer included: the gate is the project, not the module.
      expect((await listComments(fx.projectViewer.token, task.id)).status).toBe(200);
      expect(dataOf(after).map((c: any) => c.comment)).toContain(secret);
    });

    it('TSK-API-30 (R21/R54) a non-member cannot list, upload or delete ATTACHMENTS on a PRIVATE project task', async () => {
      // REGRESSION LOCK — findings R21 and R54, the attachment half.
      // `TaskAttachmentsController` had no `ProjectPermissionGuard` either, and
      // `findByTask` was a bare read by task id. What crossed the wire was
      // worse than the comment case: the FILENAME and the storage URL, and the
      // object behind that URL lived in the PUBLIC bucket, so the URL alone was
      // the content. R53 closed that second half too — the object is private
      // now and reached only through `/secure-files` (TSK-API-40).
      //
      // R54 is the third act: `remove()` authorised on `uploadedBy === user.id`
      // OR the caller's GLOBAL role and never on the project, so the outsider —
      // a MANAGER — deleted the member's `severance-schedule-*.pdf` out of a
      // project they are not in. Somebody else's file now needs TASK_DELETE on
      // that project.
      const task = await seedTask('private evidence');
      const insiderFile = await upload(
        fx.projectMember.token,
        task.id,
        Buffer.from(`confidential ${fx.runId}`),
        `severance-schedule-${fx.runId}.pdf`,
        'application/pdf',
      );
      expect(insiderFile.status).toBe(201);
      uploaded.push({
        id: dataOf(insiderFile).id,
        fileUrl: dataOf(insiderFile).fileUrl,
      });

      const read = await listAttachments(fx.projectOutsider.token, task.id);
      expect(read.status).toBe(403);
      expect(bodyOf(read)).not.toContain(`severance-schedule-${fx.runId}.pdf`);

      // The outsider cannot upload into the private task…
      const theirs = await upload(
        fx.projectOutsider.token,
        task.id,
        Buffer.from(`outsider payload ${fx.runId}`),
        `outsider-${fx.runId}.pdf`,
        'application/pdf',
      );
      expect(theirs.status).toBe(403);

      // …nor delete the member's file (R54).
      const removed = await delAttachment(
        fx.projectOutsider.token,
        dataOf(insiderFile).id,
      );
      expect(removed.status).toBe(403);
      const afterDelete = await listAttachments(fx.projectMember.token, task.id);
      expect(dataOf(afterDelete).map((a: any) => a.fileName)).toContain(
        `severance-schedule-${fx.runId}.pdf`,
      );

      // Somebody with authority over the project's work still can — TASK_DELETE
      // is what the rule reads now, not "MANAGER anywhere in the company".
      const byOwner = await delAttachment(
        fx.projectOwner.token,
        dataOf(insiderFile).id,
      );
      expect(byOwner.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // F. task-comments — first coverage
  // ═══════════════════════════════════════════════════════════════════════════
  describe('F — task-comments (first coverage)', () => {
    let taskId = '';

    beforeEach(async () => {
      // One parent per case: the comment list is per task, so a shared parent
      // would make "the list holds exactly what this case wrote" false for
      // reasons unrelated to the rule under test.
      taskId = (await seedTask(`comments ${Date.now()}`)).id;
    });

    it('TSK-API-31 a comment is created, listed oldest-first, and carries its author', async () => {
      const first = await postComment(fx.projectMember.token, {
        taskId,
        comment: `first ${fx.runId}`,
      });
      expect(first.status).toBe(201);
      expect(msgOf(first)).toBe('Comment added');
      expect(dataOf(first).userId).toBe(fx.projectMember.userId);

      const second = await postComment(fx.projectOwner.token, {
        taskId,
        comment: `second ${fx.runId}`,
      });
      expect(second.status).toBe(201);

      const listed = await listComments(fx.projectOwner.token, taskId);
      expect(listed.status).toBe(200);
      expect(dataOf(listed).map((c: any) => c.comment)).toEqual([
        `first ${fx.runId}`,
        `second ${fx.runId}`,
      ]);
      expect(dataOf(listed)[0].user.employee.fullName).toContain('PMEMBER');

      // Commenting writes a COMMENTED activity row against the task, which is
      // what the detail drawer's timeline renders.
      const detail = await getTask(fx.projectOwner.token, taskId);
      expect(
        dataOf(detail).activities.map((a: any) => a.activityType),
      ).toContain('COMMENTED');
      expect(dataOf(detail).comments).toHaveLength(2);
    });

    it('TSK-API-32 an author edits their own comment; a stranger cannot; ADMIN can edit anyone\'s', async () => {
      const mine = dataOf(
        await postComment(fx.projectMember.token, {
          taskId,
          comment: `original ${fx.runId}`,
        }),
      );

      const own = await patchComment(fx.projectMember.token, mine.id, {
        comment: `edited ${fx.runId}`,
      });
      expect(own.status).toBe(200);
      expect(dataOf(own).comment).toBe(`edited ${fx.runId}`);

      const foreign = await patchComment(fx.projectViewer.token, mine.id, {
        comment: `hijacked ${fx.runId}`,
      });
      expect(foreign.status).toBe(403);
      expect(msgOf(foreign)).toBe('You can only edit your own comments');

      // The project's OWNER is not privileged here either — only the two global
      // roles are, which is a different rule from every other project write.
      const owner = await patchComment(fx.projectOwner.token, mine.id, {
        comment: `owner edit ${fx.runId}`,
      });
      expect(owner.status).toBe(403);

      const admin = await patchComment(fx.admin.token, mine.id, {
        comment: `admin edit ${fx.runId}`,
      });
      expect(admin.status).toBe(200);
      expect(dataOf(admin).comment).toBe(`admin edit ${fx.runId}`);
    });

    it('TSK-API-33 delete is a soft delete: the author\'s comment leaves every list, a stranger\'s attempt is refused', async () => {
      const mine = dataOf(
        await postComment(fx.projectMember.token, {
          taskId,
          comment: `deletable ${fx.runId}`,
        }),
      );

      const foreign = await delComment(fx.projectViewer.token, mine.id);
      expect(foreign.status).toBe(403);
      expect(msgOf(foreign)).toBe('You can only delete your own comments');

      const own = await delComment(fx.projectMember.token, mine.id);
      expect(own.status).toBe(200);

      const listed = await listComments(fx.projectMember.token, taskId);
      expect(dataOf(listed)).toHaveLength(0);
      const detail = await getTask(fx.projectOwner.token, taskId);
      expect(dataOf(detail).comments).toHaveLength(0);

      // The row is still there — soft, not gone.
      const row = await ctx.prisma.taskComment.findUnique({
        where: { id: mine.id },
      });
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.comment).toBe(`deletable ${fx.runId}`);

      // A second delete of the same comment reads as absent.
      const again = await delComment(fx.projectMember.token, mine.id);
      expect(again.status).toBe(404);
    });

    it('TSK-API-34 an EMPTY comment is accepted; 5001 characters and a non-uuid taskId are refused', async () => {
      // KNOWN GAP. `CreateTaskCommentDto.comment` is `@IsString()
      // @MaxLength(5000)` with no `@IsNotEmpty()`, so the comment box posts an
      // empty bubble into the timeline — and it also fires a COMMENTED activity
      // row and (in production) a notification about nothing.
      const empty = await postComment(fx.projectMember.token, {
        taskId,
        comment: '',
      });
      expect(empty.status).toBe(201);
      expect(dataOf(empty).comment).toBe('');
      const whitespace = await postComment(fx.projectMember.token, {
        taskId,
        comment: '   \n  ',
      });
      expect(whitespace.status).toBe(201);

      const tooLong = await postComment(fx.projectMember.token, {
        taskId,
        comment: 'x'.repeat(5001),
      });
      expect(tooLong.status).toBe(400);

      const atLimit = await postComment(fx.projectMember.token, {
        taskId,
        comment: 'x'.repeat(5000),
      });
      expect(atLimit.status).toBe(201);

      const badId = await postComment(fx.projectMember.token, {
        taskId: 'not-a-uuid',
        comment: `nope ${fx.runId}`,
      });
      expect(badId.status).toBe(400);

      const extraKey = await postComment(fx.projectMember.token, {
        taskId,
        comment: `nope ${fx.runId}`,
        userId: fx.admin.userId,
      });
      expect(extraKey.status).toBe(400);
    });

    it.failing(
      'TSK-API-34b an empty or whitespace-only comment should be refused',
      async () => {
        const empty = await postComment(fx.projectMember.token, {
          taskId,
          comment: '',
        });
        expect(empty.status).toBe(400);
      },
    );

    it('TSK-API-35 commenting on an absent or already-deleted task is a 404, but LISTING one is a 200', async () => {
      const absent = await postComment(fx.projectMember.token, {
        taskId: ABSENT_UUID,
        comment: `ghost ${fx.runId}`,
      });
      expect(absent.status).toBe(404);
      expect(msgOf(absent)).toBe('Task not found');

      await ctx
        .http()
        .delete(`/tasks/${taskId}`)
        .set(bearer(fx.projectOwner.token));
      const onDeleted = await postComment(fx.projectMember.token, {
        taskId,
        comment: `after death ${fx.runId}`,
      });
      expect(onDeleted.status).toBe(404);

      // …while the read door never loads the task at all, so an unknown id is
      // an empty list rather than a 404. Same shape as the leave-attachment
      // list door (LAT-API-01).
      const listedUnknown = await listComments(fx.projectMember.token, ABSENT_UUID);
      expect(listedUnknown.status).toBe(200);
      expect(dataOf(listedUnknown)).toEqual([]);
    });

    it('TSK-API-36 comments survive their task\'s soft delete and stay readable; a hard delete cascades them', async () => {
      const survivor = dataOf(
        await postComment(fx.projectMember.token, {
          taskId,
          comment: `survives ${fx.runId}`,
        }),
      );

      await ctx
        .http()
        .delete(`/tasks/${taskId}`)
        .set(bearer(fx.projectOwner.token));
      expect((await getTask(fx.projectOwner.token, taskId)).status).toBe(404);

      // The task is gone from every task door, and the discussion is still
      // being served by the comments door — to the project's own people, who
      // are the only ones the door serves now (R21). The read resolves the
      // project through the task row, which a soft delete does not remove.
      const stillThere = await listComments(fx.projectMember.token, taskId);
      expect(stillThere.status).toBe(200);
      expect(dataOf(stillThere).map((c: any) => c.comment)).toContain(
        `survives ${fx.runId}`,
      );

      // `TaskComment.taskId` is `onDelete: Cascade`, so the row only really
      // goes when the task row does.
      await ctx.prisma.taskComment.deleteMany({ where: { taskId } });
      await ctx.prisma.taskActivity.deleteMany({ where: { taskId } });
      await ctx.prisma.task.delete({ where: { id: taskId } });
      expect(
        await ctx.prisma.taskComment.findUnique({ where: { id: survivor.id } }),
      ).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // G. task-attachments — first coverage
  // ═══════════════════════════════════════════════════════════════════════════
  describe('G — task-attachments (first coverage)', () => {
    let taskId = '';

    /** A small, valid-looking PDF payload. */
    const pdf = (bytes = 2048) => Buffer.alloc(bytes, 0x25);

    beforeEach(async () => {
      taskId = (await seedTask(`attachments ${Date.now()}`)).id;
    });

    it('TSK-API-37 a multipart upload lands, serialises fileSize as a Number, and is listed back', async () => {
      const res = await upload(
        fx.projectMember.token,
        taskId,
        pdf(),
        `spec-${fx.runId}.pdf`,
        'application/pdf',
      );
      expect(res.status).toBe(201);
      expect(msgOf(res)).toBe('Attachment uploaded');
      const d = dataOf(res);
      uploaded.push({ id: d.id, fileUrl: d.fileUrl });

      // `TaskAttachment.fileSize` is a BigInt column; unserialised it would
      // throw on `JSON.stringify` and the whole response would be a 500.
      expect(typeof d.fileSize).toBe('number');
      expect(d.fileSize).toBe(2048);
      expect(d.fileName).toBe(`spec-${fx.runId}.pdf`);
      expect(d.mimeType).toBe('application/pdf');
      expect(d.uploadedBy).toBe(fx.projectMember.userId);

      const listed = await listAttachments(fx.projectMember.token, taskId);
      expect(listed.status).toBe(200);
      expect(dataOf(listed).map((a: any) => a.id)).toEqual([d.id]);
      expect(typeof dataOf(listed)[0].fileSize).toBe('number');

      // …and through the task's own detail payload, where the same BigInt has
      // to be serialised a second time by a different code path.
      const detail = await getTask(fx.projectMember.token, taskId);
      expect(dataOf(detail).attachments.map((a: any) => a.id)).toEqual([d.id]);
      expect(typeof dataOf(detail).attachments[0].fileSize).toBe('number');

      // An ATTACHMENT_ADDED activity is written for the timeline.
      expect(
        dataOf(detail).activities.map((a: any) => a.activityType),
      ).toContain('ATTACHMENT_ADDED');
    });

    it('TSK-API-38 (R53) a disallowed MIME type is refused, and a request with no file is a 400', async () => {
      // REGRESSION LOCK — finding R53, first half. `FileInterceptor('file')`
      // was configured with NOTHING: no `fileFilter`, no `limits`. Employee
      // documents and avatars have policed both since they were written; task
      // attachments took anything, landed it in the PUBLIC bucket, and the
      // frontend renders the URL it is given — so an uploaded `.html` was a
      // stored-XSS page served from the product's own storage origin.
      const exe = await upload(
        fx.projectMember.token,
        taskId,
        Buffer.from('MZ\x90\x00'),
        `payload-${fx.runId}.exe`,
        'application/x-msdownload',
      );
      if (exe.status === 201) {
        uploaded.push({ id: dataOf(exe).id, fileUrl: dataOf(exe).fileUrl });
      }
      expect(exe.status).toBe(400);
      expect(msgOf(exe)).toMatch(/allowed as task attachments/i);

      const html = await upload(
        fx.projectMember.token,
        taskId,
        Buffer.from('<script>alert(1)</script>'),
        `xss-${fx.runId}.html`,
        'text/html',
      );
      if (html.status === 201) {
        uploaded.push({ id: dataOf(html).id, fileUrl: dataOf(html).fileUrl });
      }
      expect(html.status).toBe(400);

      // Nothing was written for either refusal.
      const listed = await listAttachments(fx.projectMember.token, taskId);
      expect(dataOf(listed)).toHaveLength(0);

      // And a request with NO file at all is a 400 rather than the 500 the
      // service used to answer by dereferencing `file.originalname` before
      // checking anything — the shape a form posts when nobody picked a file.
      const noFile = await ctx
        .http()
        .post(`/task-attachments/upload/${taskId}`)
        .set(bearer(fx.projectMember.token))
        .field('note', 'no file attached');
      expect(noFile.status).toBe(400);
      expect(msgOf(noFile)).toBe('A file is required');
    });

    it('TSK-API-39 (R53) an oversized upload is refused, and one at the cap is not', async () => {
      // REGRESSION LOCK — finding R53, second half. The body parsers are capped
      // at 1 MB (`e2e-app.ts` mirrors `main.ts`), but multipart never goes
      // through them and multer was given no `limits.fileSize` — so the buffer
      // was held entirely in memory (multer's default) and then handed to
      // MinIO, making the ceiling on one upload the container's heap. The cap
      // is 5 MB, the same number `POST /employees/:id/avatar` uses.
      const big = pdf(6 * 1024 * 1024);
      const res = await upload(
        fx.projectMember.token,
        taskId,
        big,
        `large-${fx.runId}.pdf`,
        'application/pdf',
      );
      if (res.status === 201) {
        uploaded.push({ id: dataOf(res).id, fileUrl: dataOf(res).fileUrl });
      }
      expect(res.status).toBe(413);

      // Multer stops reading at the limit, so nothing was stored.
      const listed = await listAttachments(fx.projectMember.token, taskId);
      expect(dataOf(listed)).toHaveLength(0);

      // Just under the cap still goes through — the limit is a limit, not a ban
      // on real documents.
      const ok = await upload(
        fx.projectMember.token,
        taskId,
        pdf(4 * 1024 * 1024),
        `at-cap-${fx.runId}.pdf`,
        'application/pdf',
      );
      expect(ok.status).toBe(201);
      expect(dataOf(ok).fileSize).toBe(4 * 1024 * 1024);
      uploaded.push({ id: dataOf(ok).id, fileUrl: dataOf(ok).fileUrl });
    });

    it('TSK-API-40 (R53) the object is PRIVATE, served through /secure-files, and only this module\'s own URLs can be registered', async () => {
      // REGRESSION LOCK — finding R53, the sharpest half. `uploadAndCreate`
      // called `storage.uploadFile(...)`, the PUBLIC door, whose bucket carries
      // an allow-all `s3:GetObject` policy — so `fileUrl` was a plain unsigned
      // URL and THE URL WAS THE ENTIRE CREDENTIAL for a member's
      // `severance-schedule-*.pdf`. There was no `task-attachment` resolver in
      // `/secure-files` at all, so nothing could authorise a read even if
      // somebody had wanted to. Letters, grievance attachments and vault
      // documents have always taken the private door; this now does too.
      const res = await upload(
        fx.projectMember.token,
        taskId,
        pdf(),
        `private-${fx.runId}.pdf`,
        'application/pdf',
      );
      expect(res.status).toBe(201);
      const d = dataOf(res);
      uploaded.push({ id: d.id, fileUrl: d.fileUrl });

      expect(d.fileUrl.startsWith('private://')).toBe(true);
      expect(d.fileUrl).toContain('task-attachments/');
      // Nothing renderable ever leaves the API: the payload names the
      // authenticated route instead of a URL anyone could follow.
      expect(d.downloadUrl).toBe(`/secure-files/task-attachment/${d.id}`);

      // A project member downloads it…
      const mine = await ctx
        .http()
        .get(`/secure-files/task-attachment/${d.id}`)
        .set(bearer(fx.projectMember.token));
      expect(mine.status).toBe(200);
      expect(String(mine.headers['content-disposition'])).toContain(
        `private-${fx.runId}.pdf`,
      );

      // …a project VIEWER may read the project's work, so may have it too…
      expect(
        (
          await ctx
            .http()
            .get(`/secure-files/task-attachment/${d.id}`)
            .set(bearer(fx.projectViewer.token))
        ).status,
      ).toBe(200);

      // …and the outsider MANAGER — the principal of R21/R54 — cannot, on the
      // one door that used to need no authorisation whatsoever.
      const outsider = await ctx
        .http()
        .get(`/secure-files/task-attachment/${d.id}`)
        .set(bearer(fx.projectOutsider.token));
      expect(outsider.status).toBe(403);
      expect(bodyOf(outsider)).not.toContain(`private-${fx.runId}.pdf`);

      // The register-by-URL door took `@IsString()` and wrote it verbatim, so
      // an attachment could be made to point ANYWHERE — including at another
      // module's private ref, which the frontend's `resolveFileUrl` would
      // happily render.
      const refused: Array<[string, string]> = [
        ['private ref', 'private://letters/somebody-elses-salary-certificate.pdf'],
        ['foreign public object', 'https://cdn.example.com/payslips/2026-03.pdf'],
        ['not a URL at all', 'just-a-string'],
        ['javascript', 'javascript:alert(1)'],
      ];
      for (const [what, fileUrl] of refused) {
        const registered = await ctx
          .http()
          .post('/task-attachments')
          .set(bearer(fx.projectMember.token))
          .send({
            taskId,
            fileName: `pointer-${fx.runId}.pdf`,
            fileUrl,
            mimeType: 'application/pdf',
          });
        expect([what, registered.status]).toEqual([what, 400]);
      }
      expect(
        await ctx.prisma.taskAttachment.count({
          where: { fileName: `pointer-${fx.runId}.pdf` },
        }),
      ).toBe(0);

      // A URL this module itself issued through the old public door still
      // registers — existing rows and the legacy door keep working.
      const legacy = await ctx
        .http()
        .post('/task-attachments')
        .set(bearer(fx.projectMember.token))
        .send({
          taskId,
          fileName: `legacy-${fx.runId}.pdf`,
          fileUrl: `/uploads/task-attachments/legacy-${fx.runId}.pdf`,
          mimeType: 'application/pdf',
        });
      expect(legacy.status).toBe(201);
      // …and a legacy row's `downloadUrl` is still its own public URL, because
      // there is no private object behind it to authorise.
      expect(dataOf(legacy).downloadUrl).toBe(
        `/uploads/task-attachments/legacy-${fx.runId}.pdf`,
      );
      await ctx.prisma.taskAttachment.delete({
        where: { id: dataOf(legacy).id },
      });

      // The MIME allowlist governs this door too — it is the same rule.
      const badMime = await ctx
        .http()
        .post('/task-attachments')
        .set(bearer(fx.projectMember.token))
        .send({
          taskId,
          fileName: `xss-${fx.runId}.html`,
          fileUrl: `/uploads/task-attachments/xss-${fx.runId}.html`,
          mimeType: 'text/html',
        });
      expect(badMime.status).toBe(400);
    });

    it('TSK-API-41 delete: the uploader may, a project VIEWER may not, and TASK_DELETE may', async () => {
      // The rule used to read "uploader OR a global ADMIN/HR_MANAGER/MANAGER",
      // which is what let an outsider MANAGER delete a member's file (R54,
      // TSK-API-30). It now reads "uploader OR TASK_DELETE on this project", so
      // a viewer inside the project is still refused — with the OWNERSHIP
      // message, because the guard admits them as a member and the service's
      // own rule is the one doing the work.
      const mine = dataOf(
        await upload(
          fx.projectMember.token,
          taskId,
          pdf(),
          `mine-${fx.runId}.pdf`,
          'application/pdf',
        ),
      );
      uploaded.push({ id: mine.id, fileUrl: mine.fileUrl });

      const stranger = await delAttachment(fx.projectViewer.token, mine.id);
      expect(stranger.status).toBe(403);
      expect(msgOf(stranger)).toBe('You can only delete your own attachments');

      // …while somebody else's file IS removable by a principal holding
      // TASK_DELETE on the project — here the manager PRESET, an EMPLOYEE, who
      // the old global-role rule would have refused (R41) even as it admitted
      // an outsider MANAGER (R54). Both halves changed hands at once.
      const theirs = dataOf(
        await upload(
          fx.projectMember.token,
          taskId,
          pdf(),
          `preset-removable-${fx.runId}.pdf`,
          'application/pdf',
        ),
      );
      uploaded.push({ id: theirs.id, fileUrl: theirs.fileUrl });
      const byPreset = await delAttachment(fx.projectManager.token, theirs.id);
      expect(byPreset.status).toBe(200);

      const own = await delAttachment(fx.projectMember.token, mine.id);
      expect(own.status).toBe(200);

      const listed = await listAttachments(fx.projectMember.token, taskId);
      expect(dataOf(listed).map((a: any) => a.id)).not.toContain(mine.id);

      // Soft, not gone — the row survives with the storage key still on it,
      // and `remove()` has already deleted the object behind that key.
      const row = await ctx.prisma.taskAttachment.findUnique({
        where: { id: mine.id },
      });
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.fileUrl).toBe(mine.fileUrl);

      const second = await delAttachment(fx.projectMember.token, mine.id);
      expect(second.status).toBe(404);

      // An ATTACHMENT_REMOVED activity is written.
      const detail = await getTask(fx.projectOwner.token, taskId);
      expect(
        dataOf(detail).activities.map((a: any) => a.activityType),
      ).toContain('ATTACHMENT_REMOVED');
    });

    it('TSK-API-42 attachments outlive their task\'s soft delete, and a hard delete cascades the rows but not the objects', async () => {
      const file = dataOf(
        await upload(
          fx.projectMember.token,
          taskId,
          pdf(),
          `orphan-${fx.runId}.pdf`,
          'application/pdf',
        ),
      );
      uploaded.push({ id: file.id, fileUrl: file.fileUrl });

      await ctx
        .http()
        .delete(`/tasks/${taskId}`)
        .set(bearer(fx.projectOwner.token));
      expect((await getTask(fx.projectOwner.token, taskId)).status).toBe(404);

      // The task is gone; the attachment door still serves the filename and
      // the storage ref to the project's own people (R21 closed the "anyone
      // holding the task id" half — see TSK-API-30 — and R53 made the ref
      // itself worthless without a trip back through `/secure-files`).
      const stillListed = await listAttachments(fx.projectMember.token, taskId);
      expect(stillListed.status).toBe(200);
      expect(dataOf(stillListed).map((a: any) => a.fileName)).toContain(
        `orphan-${fx.runId}.pdf`,
      );

      // `TaskAttachment.taskId` is `onDelete: Cascade`, so a HARD delete does
      // remove the row — and nothing removes the object it points at, which is
      // why the suite's own teardown has to delete through the API first.
      await ctx.prisma.taskActivity.deleteMany({ where: { taskId } });
      await ctx.prisma.task.delete({ where: { id: taskId } });
      expect(
        await ctx.prisma.taskAttachment.findUnique({ where: { id: file.id } }),
      ).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // H. task-dashboard — first coverage
  // ═══════════════════════════════════════════════════════════════════════════
  describe('H — task-dashboard (first coverage)', () => {
    /**
     * Both dashboards aggregate. The only assertions that survive siblings
     * writing to the same database are the ones keyed on rows this file made,
     * so each case looks for its OWN task codes inside the payload and asserts
     * the absence of the other department's — never a global count.
     *
     * These rows are created LAST, in this block's own `beforeAll`, because
     * `recentActivity` is `take: 10`: anything created after them could push
     * them out of the window and turn a real leak into a passing test.
     */
    let managedTask: { id: string; taskCode: string };
    let otherDeptTask: { id: string; taskCode: string };
    let mineTask: { id: string; taskCode: string };

    beforeAll(async () => {
      // `managedEmployeeId` sits in the department `fx.manager` heads.
      managedTask = await seedTask('dash managed', {
        assigneeId: fx.managedEmployeeId,
      });
      // `unmanagedEmployeeId` sits in the OTHER department — the one
      // `projectOutsider` calls home and `fx.manager` does not head.
      otherDeptTask = await seedTask('dash unmanaged', {
        assigneeId: fx.unmanagedEmployeeId,
      });
      // The plain EMPLOYEE's own task, in neither of those departments.
      mineTask = await seedTask('dash mine', {
        assigneeId: fx.employee.employeeId,
      });
    });

    it('TSK-API-43 GET employee is scoped to the caller\'s own assignments', async () => {
      const res = await employeeDashboard(fx.employee.token);
      expect(res.status).toBe(200);
      const d = dataOf(res);

      expect(d.tasks.assigned).toBeGreaterThanOrEqual(1);
      expect(d.recentTasks.map((t: any) => t.taskCode)).toContain(
        mineTask.taskCode,
      );
      // Nothing belonging to anyone else, however recent.
      const codes = d.recentTasks.map((t: any) => t.taskCode);
      expect(codes).not.toContain(managedTask.taskCode);
      expect(codes).not.toContain(otherDeptTask.taskCode);

      // Shape the screen depends on.
      expect(typeof d.hours.today).toBe('string');
      expect(typeof d.hours.week).toBe('string');
      expect(d.activeTimer).toBeNull();
      expect(d.timesheets).toHaveProperty('pendingDraft');
    });

    it('TSK-API-44 GET employee for a user with no employee row is a zeroed dashboard, not an error', async () => {
      // The global ADMIN is a User with `employeeId: null`. Recorded because
      // the screen renders "0 assigned, 0 hours" for an administrator rather
      // than telling them the dashboard does not apply — the same silent-empty
      // shape that hid the attendance defects in Phase 3.
      const res = await employeeDashboard(fx.admin.token);
      expect(res.status).toBe(200);
      const d = dataOf(res);
      expect(d.tasks).toEqual({
        assigned: 0,
        pending: 0,
        completed: 0,
        overdue: 0,
      });
      expect(d.recentTasks).toEqual([]);
      expect(d.activeTimer).toBeNull();
    });

    it('TSK-API-45 GET manager is department-scoped — a head sees their own department and not the next one', async () => {
      const res = await managerDashboard(fx.manager.token);
      expect(res.status).toBe(200);
      const d = dataOf(res);

      const codes = d.recentActivity.map((a: any) => a.task?.taskCode);
      expect(codes).toContain(managedTask.taskCode);
      // The load-bearing half: the other department's task must NOT be here.
      // This is the shape that produced real IDOR defects in Attendance and
      // Leave — an aggregate endpoint that forgets to narrow.
      expect(codes).not.toContain(otherDeptTask.taskCode);
      expect(codes).not.toContain(mineTask.taskCode);

      expect(d.tasks.total).toBeGreaterThanOrEqual(1);
      expect(typeof d.teamHoursThisWeek).toBe('string');
    });

    it('TSK-API-46 (R59) a MANAGER who heads NOTHING gets an empty team view, not their department\'s', async () => {
      // REGRESSION LOCK — finding R59. `getManagerDashboard` narrowed on
      // `managerDeptScope(user)`, which falls back to the caller's OWN
      // `departmentId` when they head no department. `projectOutsider` is a
      // MANAGER by role who manages nobody, so they read the task activity of
      // every colleague who happened to share their department — including
      // tasks inside PRIVATE projects they are not a member of, with the actor
      // NAMED, which is the same door TSK-API-28 opened by another route.
      // Heading nothing is an empty team; `manager-role.util.ts` makes exactly
      // this point from the other side ("Authority did not end, it moved
      // somewhere nobody granted").
      const res = await managerDashboard(fx.projectOutsider.token);
      expect(res.status).toBe(200);
      const d = dataOf(res);

      const codes = d.recentActivity.map((a: any) => a.task?.taskCode);
      expect(codes).not.toContain(otherDeptTask.taskCode);
      expect(codes).not.toContain(managedTask.taskCode);
      expect(codes).not.toContain(mineTask.taskCode);

      // Empty, and empty in the SHAPE the screen expects — a 200 whose body
      // the dashboard cannot render would be a different defect.
      expect(d.recentActivity).toEqual([]);
      expect(d.tasks.total).toBe(0);
      expect(d.timesheets.pendingApproval).toBe(0);
      expect(d.teamHoursThisWeek).toBe('0.00');
    });

    it('TSK-API-47 an EMPLOYEE cannot read the manager view at all', async () => {
      for (const who of [fx.employee, fx.projectMember, fx.projectViewer]) {
        const res = await managerDashboard(who.token);
        expect(res.status).toBe(403);
      }
      // …while the employee view is open to every authenticated role.
      expect((await employeeDashboard(fx.employee.token)).status).toBe(200);
      expect((await employeeDashboard(fx.projectViewer.token)).status).toBe(200);

      // Both doors refuse an anonymous caller, which is what proves the 403s
      // above came from the role gate rather than from a missing route.
      expect((await ctx.http().get('/task-dashboard/manager')).status).toBe(401);
      expect((await ctx.http().get('/task-dashboard/employee')).status).toBe(401);
    });

    it('TSK-API-48 ADMIN and HR_MANAGER get the manager view UNSCOPED — every department at once', async () => {
      // `deptFilter` is `{}` for anything that is not role MANAGER, so both
      // global roles see the whole company. Asserted as "contains both of this
      // run's departments", never as a global count, because siblings are
      // writing to the same tables.
      for (const who of [fx.admin, fx.scopedHr]) {
        const res = await managerDashboard(who.token);
        expect(res.status).toBe(200);
        const codes = dataOf(res).recentActivity.map(
          (a: any) => a.task?.taskCode,
        );
        expect(codes).toContain(managedTask.taskCode);
        expect(codes).toContain(otherDeptTask.taskCode);
      }

      // A branch-scoped HR_MANAGER is scoped for assets and letters and NOT
      // here — the tracker has no branch scoping by design
      // (`branch-scope.map.ts` excludes it), and this endpoint has no
      // department scoping for HR either. Recorded so the intent is on the
      // record rather than assumed.
      const scoped = await managerDashboard(fx.scopedHr.token);
      expect(dataOf(scoped).tasks.total).toBeGreaterThanOrEqual(2);
    });
  });
});
