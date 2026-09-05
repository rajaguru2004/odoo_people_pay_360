import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import { withSetting } from './utils/settings';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';
import { presetRolesCreateData } from '../src/projects/rbac/permissions.constants';

/**
 * WP-4 — Project core.
 *
 * Scope: CRUD and its DTO surface, the visibility × membership grid on BOTH
 * doors (`GET /projects` and `GET /projects/:id`), `/projects/stats` scoping,
 * membership management, archive, soft delete, the activity log, charts, and
 * the concurrency / tenancy / FK findings the plan names R6, R9, R10, R12,
 * R13 and R16.
 *
 * NOT in this file: the 12 × 5 permission grid (WP-5,
 * `workplace-project-rbac.e2e-spec.ts`), tasks (WP-6), sprints and workflow
 * statuses (WP-7). Nor anything `test/projects-lifecycle.e2e-spec.ts` already
 * owns — auto projectCode on the happy path, EMPLOYEE create 403, by-slug read,
 * PATCH name+status, duplicate-slug auto-increment, the preset-role checks, the
 * chart shape at zero tasks, or the outsider 403 on activity.
 *
 * House rules (plan §0): every assertion is filtered to THIS run's rows — three
 * sibling suites write to the same database — and every known defect is PINNED
 * with a `KNOWN GAP` comment plus an `it.failing` twin, never hidden.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HISTORICAL NOTE — the single project-code slot is GONE.
 *
 * R6 is fixed. `generateProjectCode()` used to take the LEXICAL maximum
 * `project_code` and `parseInt(code.replace('PROJ-',''))` it, so any code that
 * is not `PROJ-<digits>` — the `WP…` codes these very fixtures seed — made the
 * generator emit the literal string `PROJ-0NaN`, and since `project_code` is
 * `@unique` only ONE create per database could ever succeed. Every workplace
 * spec ran in that state, and this file could make at most one `POST /projects`
 * per case.
 *
 * `ProjectsService.nextProjectCode()` now draws from the Postgres sequence
 * `project_code_seq` (migration `20260818120000_add_project_code_sequence`,
 * mirrored into `prisma/e2e-partial-indexes.sql`), exactly as letter serials
 * draw from `letter_serial_seq`. PRJ-API-33/33a are the regression locks.
 *
 * What survives is ordinary hygiene, not an accommodation: `postProject()`
 * records what it created and `afterEach` removes it, so a project one case
 * creates cannot leak into another case's list, stats or search assertions —
 * every one of which is filtered to `fx.runId`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('Workplace — project core (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;

  /** `runId.slice(-8)` — `project_code` is VarChar(20). */
  let short: string;

  /** Rows this spec created directly; removed in `afterAll` before fx.cleanup. */
  const ownProjectIds: string[] = [];
  const ownDeptIds: string[] = [];
  const ownTeamIds: string[] = [];
  const ownTaskIds: string[] = [];
  const ownEmployeeIds: string[] = [];

  /** Rows created through `POST /projects`; removed after every test. */
  const createdViaApi: string[] = [];

  const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000000ff';

  // ── Helpers ────────────────────────────────────────────────────────────────

  const get = (path: string, token?: string) => {
    const r = ctx.http().get(path);
    return token ? r.set(bearer(token)) : r;
  };

  /**
   * `POST /projects`, remembering the created row so `afterEach` can take it
   * back out of the shared database before the next case lists or counts.
   */
  const postProject = async (token: string, dto: Record<string, unknown>) => {
    const res = await ctx.http().post('/projects').set(bearer(token)).send(dto);
    if (res.status === 201 && res.body?.data?.id) {
      createdViaApi.push(res.body.data.id);
    }
    return res;
  };

  const dropApiProjects = async () => {
    if (createdViaApi.length === 0) return;
    const ids = createdViaApi.splice(0);
    await ctx.prisma.project.deleteMany({ where: { id: { in: ids } } });
  };

  /** A project built straight through Prisma — no code slot consumed. */
  const mkProject = async (
    suffix: string,
    over: Record<string, unknown> = {},
  ) => {
    const project = await ctx.prisma.project.create({
      data: {
        // Once upon a time this had to sort BELOW 'PROJ-' or it would poison
        // `generateProjectCode()` for every other suite (R6). The sequence has
        // no opinion about other rows' formats; the prefix stays only because
        // the teardown filters on it.
        projectCode: `C4${short}${suffix}`.slice(0, 20),
        name: `WP4 ${suffix} ${fx.runId}`,
        slug: `wp4-${suffix.toLowerCase()}-${fx.runId}`,
        visibility: 'PRIVATE',
        status: 'ACTIVE',
        priority: 'MEDIUM',
        workflowId: fx.privateWorkflowId,
        departmentId: fx.otherDeptId,
        ownerId: fx.ownerEmployeeId,
        roles: { create: presetRolesCreateData() },
        ...over,
      },
    });
    ownProjectIds.push(project.id);
    return project;
  };

  const roleIdsOf = async (projectId: string) => {
    const rows = await ctx.prisma.projectRole.findMany({
      where: { projectId },
      select: { id: true, slug: true },
    });
    const map: Record<string, string> = {};
    for (const r of rows) map[r.slug] = r.id;
    return map;
  };

  const mkEmployee = async (
    suffix: string,
    over: Record<string, unknown> = {},
  ) => {
    const emp = await ctx.prisma.employee.create({
      data: {
        employeeCode: `EMP-${fx.runId}-W4${suffix}`,
        fullName: `WP4 ${suffix}`,
        dateOfBirth: new Date('1993-03-03'),
        idCard: `ID-${fx.runId}-W4${suffix}`,
        email: `w4${suffix.toLowerCase()}-${fx.runId}@test.local`,
        departmentId: fx.otherDeptId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: new Date('2024-01-01'),
        baseSalary: 4000,
        status: 'ACTIVE',
        ...over,
      },
    });
    ownEmployeeIds.push(emp.id);
    return emp;
  };

  const mkTask = async (
    projectId: string,
    suffix: string,
    statusId: string,
    over: Record<string, unknown> = {},
  ) => {
    const task = await ctx.prisma.task.create({
      data: {
        taskCode: `T4${short}${suffix}`.slice(0, 20),
        title: `WP4 task ${suffix} ${fx.runId}`,
        projectId,
        statusId,
        ...over,
      },
    });
    ownTaskIds.push(task.id);
    return task;
  };

  /**
   * `DELETE /employees/:id/hard` — the ONLY path that fires
   * `Project.ownerId`'s `SetNull` and `ProjectMember.employeeId`'s `Cascade`,
   * and therefore the only path the R12/R13 handover runs on.
   *
   * It is gated on the `allow_hard_delete_terminated` system setting, which is
   * off by default and is put back exactly as it was found — `maxWorkers: 1`
   * means a suite that leaves it on hands it to every suite after this one.
   * The caller must already be INACTIVE/TERMINATED; that precondition is what
   * makes "hard delete" strictly a second step after an offboarding, never a
   * first one.
   */
  const hardDelete = (employeeId: string) =>
    withSetting(ctx, 'allow_hard_delete_terminated', 'true', () =>
      ctx
        .http()
        .delete(`/employees/${employeeId}/hard`)
        .set(bearer(fx.admin.token)),
    );

  /** Slugs of MY run's projects visible to `token` on `GET /projects`. */
  const listSlugs = async (
    token: string | undefined,
    query = '',
  ): Promise<string[]> => {
    const res = await get(
      `/projects?search=${fx.runId}&limit=200${query}`,
      token,
    );
    expect(res.status).toBe(200);
    return (res.body.data as Array<{ slug: string }>).map((p) => p.slug);
  };

  // ── Setup / teardown ───────────────────────────────────────────────────────

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);
    short = fx.runId.slice(-8);
  }, 300000);

  afterEach(async () => {
    await dropApiProjects();
  });

  afterAll(async () => {
    if (ctx?.prisma) {
      try {
        await dropApiProjects();
        await ctx.prisma.auditLog.deleteMany({
          where: { resourceId: { in: [...ownProjectIds, ...ownTaskIds] } },
        });
        await ctx.prisma.task.deleteMany({
          where: {
            OR: [
              { id: { in: ownTaskIds } },
              { projectId: { in: ownProjectIds } },
            ],
          },
        });
        await ctx.prisma.projectMember.deleteMany({
          where: {
            OR: [
              { projectId: { in: ownProjectIds } },
              { employeeId: { in: ownEmployeeIds } },
            ],
          },
        });
        await ctx.prisma.project.deleteMany({
          where: {
            OR: [
              { id: { in: ownProjectIds } },
              { ownerId: { in: ownEmployeeIds } },
            ],
          },
        });
        await ctx.prisma.employee.deleteMany({
          where: { id: { in: ownEmployeeIds } },
        });
        await ctx.prisma.team.deleteMany({ where: { id: { in: ownTeamIds } } });
        await ctx.prisma.department.deleteMany({
          where: { id: { in: ownDeptIds } },
        });
      } catch {
        // Teardown must not mask a real failure; fx.cleanup() sweeps the rest.
      }
    }
    await fx?.cleanup();
    await ctx?.app.close();
  }, 300000);

  // ══════════════════════════════════════════════════════════════════════════
  // 1. DTO / validation matrix on POST /projects and GET /projects
  // ══════════════════════════════════════════════════════════════════════════

  describe('DTO boundaries', () => {
    it('PRJ-API-01 name accepts 150 characters and refuses 151', async () => {
      const long = 'n'.repeat(151);
      const tooLong = await postProject(fx.admin.token, {
        name: long,
        slug: `too-long-name-${fx.runId}`,
      });
      expect(tooLong.status).toBe(400);
      expect(JSON.stringify(tooLong.body.message)).toContain('name');

      const atLimit = await postProject(fx.admin.token, {
        name: `${'n'.repeat(150 - fx.runId.length - 1)} ${fx.runId}`,
      });
      expect(atLimit.status).toBe(201);
      expect(atLimit.body.data.name.length).toBeLessThanOrEqual(150);
    });

    it('PRJ-API-02 taskPrefix accepts 8 characters and refuses 9', async () => {
      const bad = await postProject(fx.admin.token, {
        name: `prefix 9 ${fx.runId}`,
        taskPrefix: 'ABCDEFGHI',
      });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body.message)).toContain('taskPrefix');

      const ok = await postProject(fx.admin.token, {
        name: `prefix 8 ${fx.runId}`,
        taskPrefix: 'ABCDEFGH',
      });
      expect(ok.status).toBe(201);
      expect(ok.body.data.taskPrefix).toBe('ABCDEFGH');
    });

    it('PRJ-API-03 color must be a hex value, not merely 9 characters long', async () => {
      // REGRESSION LOCK (R49, fixed). `color` used to be length-checked ONLY:
      // MaxLength(9) agreed with the VarChar(9) column, but nothing asserted it
      // was a colour, so 'not-a-hex' — exactly 9 characters — was stored and
      // served to the UI as a CSS value. `CreateProjectDto.color` now also
      // carries @Matches(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/).
      const tooLong = await postProject(fx.admin.token, {
        name: `color 10 ${fx.runId}`,
        color: '#0123456789',
      });
      expect(tooLong.status).toBe(400);
      expect(JSON.stringify(tooLong.body.message)).toContain('color');

      for (const color of ['not-a-hex', '#12345', 'red', '00358F', '#GGGGGG']) {
        const res = await postProject(fx.admin.token, {
          name: `color ${color} ${fx.runId}`,
          color,
        });
        expect(`${color}:${res.status}`).toBe(`${color}:400`);
        expect(JSON.stringify(res.body.message)).toContain('color');
      }

      // Both widths the column can hold are still accepted.
      const rgb = await postProject(fx.admin.token, {
        name: `color rgb ${fx.runId}`,
        color: '#00358F',
      });
      expect(rgb.status).toBe(201);
      expect(rgb.body.data.color).toBe('#00358F');

      const rgba = await postProject(fx.admin.token, {
        name: `color rgba ${fx.runId}`,
        color: '#00358FAA',
      });
      expect(rgba.status).toBe(201);
      expect(rgba.body.data.color).toBe('#00358FAA');
    });

    it('PRJ-API-04 slug obeys ^[a-z0-9-]+$', async () => {
      const rejected = [
        ['uppercase', `Bad-Slug-${fx.runId}`],
        ['spaces', `bad slug ${fx.runId}`],
        ['underscores', `bad_slug_${fx.runId}`],
        ['dot', `bad.slug.${fx.runId}`],
      ] as const;

      for (const [label, slug] of rejected) {
        const res = await postProject(fx.admin.token, {
          name: `slug ${label} ${fx.runId}`,
          slug,
        });
        expect(`${label}:${res.status}`).toBe(`${label}:400`);
        expect(JSON.stringify(res.body.message)).toContain('slug');
      }

      const ok = await postProject(fx.admin.token, {
        name: `slug ok ${fx.runId}`,
        slug: `good-slug-99-${fx.runId}`,
      });
      expect(ok.status).toBe(201);
      expect(ok.body.data.slug).toBe(`good-slug-99-${fx.runId}`);
    });

    it('PRJ-API-05 status / priority / visibility reject values outside the enum', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['status', { status: 'ARCHIVED' }],
        ['priority', { priority: 'CRITICAL' }],
        ['visibility', { visibility: 'SECRET' }],
      ];
      for (const [field, body] of cases) {
        const res = await postProject(fx.admin.token, {
          name: `enum ${field} ${fx.runId}`,
          ...body,
        });
        expect(`${field}:${res.status}`).toBe(`${field}:400`);
        expect(JSON.stringify(res.body.message)).toContain(field);
      }
    });

    it('PRJ-API-06 relation ids and memberIds must be UUIDs', async () => {
      const fields = ['workflowId', 'departmentId', 'teamId', 'ownerId'];
      for (const field of fields) {
        const res = await postProject(fx.admin.token, {
          name: `uuid ${field} ${fx.runId}`,
          [field]: 'not-a-uuid',
        });
        expect(`${field}:${res.status}`).toBe(`${field}:400`);
        expect(JSON.stringify(res.body.message)).toContain(field);
      }

      const members = await postProject(fx.admin.token, {
        name: `uuid members ${fx.runId}`,
        memberIds: [fx.memberEmployeeId, 'not-a-uuid'],
      });
      expect(members.status).toBe(400);
      expect(JSON.stringify(members.body.message)).toContain('memberIds');
    });

    it('PRJ-API-08 an unknown-but-well-formed relation id is a 400 naming the field, and creates nothing', async () => {
      // REGRESSION LOCK (R46, fixed). Every one of these is a foreign key the
      // service never checked: Prisma raised P2003 and `AllExceptionsFilter`
      // turned it into a bare 500 "Internal server error", so the caller could
      // not tell WHICH id was wrong and the UI had no field to attach it to.
      // `ProjectsService.assertRelationsExist()` now resolves them up front.
      const fields = ['workflowId', 'departmentId', 'teamId', 'ownerId'];
      for (const field of fields) {
        const name = `ghost ${field} ${fx.runId}`;
        const res = await postProject(fx.admin.token, {
          name,
          [field]: UNKNOWN_UUID,
        });
        expect(`${field}:${res.status}`).toBe(`${field}:400`);
        expect(JSON.stringify(res.body.message)).toContain(field);
        expect(JSON.stringify(res.body.message)).toContain(UNKNOWN_UUID);
        const row = await ctx.prisma.project.findFirst({ where: { name } });
        expect(row).toBeNull();
      }

      // memberIds is the same class — an unknown id there used to fail the
      // nested member create with the same anonymous 500.
      const members = await postProject(fx.admin.token, {
        name: `ghost memberIds ${fx.runId}`,
        memberIds: [fx.memberEmployeeId, UNKNOWN_UUID],
      });
      expect(members.status).toBe(400);
      expect(JSON.stringify(members.body.message)).toContain('memberIds');

      // And PATCH, which writes the same four columns, is checked too.
      const project = await mkProject('GHOSTFK');
      const patched = await ctx
        .http()
        .patch(`/projects/${project.id}`)
        .set(bearer(fx.admin.token))
        .send({ departmentId: UNKNOWN_UUID });
      expect(patched.status).toBe(400);
      expect(JSON.stringify(patched.body.message)).toContain('departmentId');
    });

    it('PRJ-API-09 list pagination: page 0 and limit 201 are both refused, limit 200 honoured', async () => {
      const zero = await get('/projects?page=0', fx.admin.token);
      expect(zero.status).toBe(400);
      expect(JSON.stringify(zero.body.message)).toContain('page');

      const atLimit = await get('/projects?limit=200', fx.admin.token);
      expect(atLimit.status).toBe(200);
      expect(atLimit.body.meta.limit).toBe(200);

      // REGRESSION LOCK (R52, fixed). `QueryProjectDto.limit` carried @Min(1)
      // and no @Max, so 201 was accepted and `findAll` silently clamped it with
      // Math.min(..., 200) — the caller was answered 200 OK and told
      // `limit: 200` for a request it never made, while `page=0` next door was
      // correctly refused. @Max(200) makes the pair consistent.
      const over = await get('/projects?limit=201', fx.admin.token);
      expect(over.status).toBe(400);
      expect(JSON.stringify(over.body.message)).toContain('limit');

      const beyondEnd = await get(
        `/projects?search=${fx.runId}&page=50&limit=20`,
        fx.admin.token,
      );
      expect(beyondEnd.status).toBe(200);
      expect(beyondEnd.body.data).toHaveLength(0);
    });

    it('PRJ-API-10 endDate before startDate is refused on POST and on PATCH — including a one-field PATCH', async () => {
      // REGRESSION LOCK (R48, fixed). There was NO cross-field check anywhere
      // on the project date pair — not in CreateProjectDto, not in
      // UpdateProjectDto (`PartialType(CreateProjectDto)`, which is exactly
      // where a cross-field rule gets lost), not in the service. A project that
      // ended five months before it started was a valid row, and
      // ProjectGantt.tsx rendered it as a negative-width bar.
      const created = await postProject(fx.admin.token, {
        name: `reversed dates ${fx.runId}`,
        startDate: '2026-12-31',
        endDate: '2026-01-01',
      });
      expect(created.status).toBe(400);
      expect(JSON.stringify(created.body.message)).toContain('endDate');

      const ok = await postProject(fx.admin.token, {
        name: `ordered dates ${fx.runId}`,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      expect(ok.status).toBe(201);
      expect(ok.body.data.startDate).toContain('2026-01-01');
      expect(ok.body.data.endDate).toContain('2026-12-31');

      const project = await mkProject('DATES', {
        startDate: new Date('2027-06-01'),
        endDate: new Date('2027-09-01'),
      });
      const patch = (body: Record<string, unknown>) =>
        ctx
          .http()
          .patch(`/projects/${project.id}`)
          .set(bearer(fx.admin.token))
          .send(body);

      // Both halves in one PATCH.
      const both = await patch({
        startDate: '2027-06-01',
        endDate: '2027-01-01',
      });
      expect(both.status).toBe(400);

      // ONE half, checked against the half already stored — the case a DTO
      // rule cannot see, and the reason the check lives in the service.
      const endOnly = await patch({ endDate: '2027-01-01' });
      expect(endOnly.status).toBe(400);
      const startOnly = await patch({ startDate: '2027-12-01' });
      expect(startOnly.status).toBe(400);

      // The row is untouched by any of the three refusals.
      const row = await ctx.prisma.project.findUnique({
        where: { id: project.id },
      });
      expect(row!.startDate!.toISOString()).toContain('2027-06-01');
      expect(row!.endDate!.toISOString()).toContain('2027-09-01');

      // A widening PATCH that keeps the order still lands.
      const good = await patch({ endDate: '2027-12-31' });
      expect(good.status).toBe(200);
      expect(good.body.data.endDate).toContain('2027-12-31');
    });

    it('PRJ-API-38 a malformed project id in the path is a 400, not a 500', async () => {
      // REGRESSION LOCK (R46, second half, fixed). The id went straight into a
      // Prisma `where` on a @db.Uuid column, so a client mistake came back as
      // 500 "Internal server error". The `:id` params now carry ParseUUIDPipe.
      const res = await get('/projects/not-a-uuid', fx.admin.token);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message).toLowerCase()).toContain('uuid');

      // A well-formed id that matches nothing is still the 404 it should be —
      // the pipe checks the SHAPE, it does not resolve the row.
      const missing = await get(`/projects/${UNKNOWN_UUID}`, fx.admin.token);
      expect(missing.status).toBe(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Visibility × membership, on BOTH doors
  // ══════════════════════════════════════════════════════════════════════════

  describe('visibility × membership grid', () => {
    /**
     * The seven principals the plan's §6.1 row "Project list / read by id"
     * distinguishes. `projectMember` / `projectViewer` hold member rows on the
     * PRIVATE fixture project ONLY — the INTERNAL and PUBLIC fixtures have an
     * owner but no member rows, which is exactly what makes the two doors
     * disagree.
     */
    const actors = () =>
      [
        ['owner', fx.projectOwner.token],
        ['member (private only)', fx.projectMember.token],
        ['viewer (private only)', fx.projectViewer.token],
        ['outsider MANAGER', fx.projectOutsider.token],
        ['plain EMPLOYEE', fx.employee.token],
        ['ADMIN', fx.admin.token],
        ['HR_MANAGER (branch-scoped)', fx.scopedHr.token],
      ] as const;

    it('PRJ-API-11 GET /projects — a PRIVATE project is listed only for owner, members and global admins', async () => {
      const expected: Record<string, boolean> = {
        owner: true,
        'member (private only)': true,
        'viewer (private only)': true,
        'outsider MANAGER': false,
        'plain EMPLOYEE': false,
        ADMIN: true,
        'HR_MANAGER (branch-scoped)': true,
      };
      for (const [label, token] of actors()) {
        const slugs = await listSlugs(token);
        expect(`${label}:${slugs.includes(fx.privateProjectSlug)}`).toBe(
          `${label}:${expected[label]}`,
        );
      }
      const anon = await ctx.http().get('/projects');
      expect(anon.status).toBe(401);
    });

    it('PRJ-API-12 GET /projects — an INTERNAL project is listed for every authenticated principal', async () => {
      for (const [label, token] of actors()) {
        const slugs = await listSlugs(token);
        expect(`${label}:${slugs.includes(fx.internalProjectSlug)}`).toBe(
          `${label}:true`,
        );
      }
    });

    it('PRJ-API-13 GET /projects — a PUBLIC project is listed for every authenticated principal', async () => {
      for (const [label, token] of actors()) {
        const slugs = await listSlugs(token);
        expect(`${label}:${slugs.includes(fx.publicProjectSlug)}`).toBe(
          `${label}:true`,
        );
      }
    });

    it('PRJ-API-15 GET /projects/:id — PRIVATE: members and global admins 200, everyone else 403', async () => {
      const expected: Record<string, number> = {
        owner: 200,
        'member (private only)': 200,
        'viewer (private only)': 200,
        'outsider MANAGER': 403,
        'plain EMPLOYEE': 403,
        ADMIN: 200,
        'HR_MANAGER (branch-scoped)': 200,
      };
      for (const [label, token] of actors()) {
        const res = await get(`/projects/${fx.privateProjectId}`, token);
        expect(`${label}:${res.status}`).toBe(`${label}:${expected[label]}`);
      }
      const anon = await ctx.http().get(`/projects/${fx.privateProjectId}`);
      expect(anon.status).toBe(401);
    });

    it('PRJ-API-16 GET /projects/:id — INTERNAL is readable by every authenticated user, and READ ONLY', async () => {
      /**
       * REGRESSION LOCK — finding R51. The list and the detail door used to
       * disagree: `buildWhere()` has always put every INTERNAL/PUBLIC project
       * into every authenticated user's list, while `@RequireProjectMembership`
       * on `GET /:id` refused a non-member 403 — a card that could not be
       * clicked, and in the browser (R51b) an "Access Denied" modal stacked
       * over a "project not found" panel: two wrong explanations, neither of
       * them "you are not a member".
       *
       * `ProjectVisibility.INTERNAL` means "visible to all authenticated
       * users", so the DOOR was what disagreed with the product, not the list.
       * `@RequireProjectRead` now admits any authenticated principal to an
       * INTERNAL or PUBLIC project.
       */
      for (const [label, token] of actors()) {
        const res = await get(`/projects/${fx.internalProjectId}`, token);
        expect(`${label}:${res.status}`).toBe(`${label}:200`);
      }

      // The two doors now agree for the same principal: it is in the list AND
      // it opens.
      const slugs = await listSlugs(fx.employee.token);
      expect(slugs).toContain(fx.internalProjectSlug);

      // Anonymous is still refused — "all authenticated users" is the widening,
      // not "everyone".
      const anon = await ctx.http().get(`/projects/${fx.internalProjectId}`);
      expect(anon.status).toBe(401);
    });

    it('PRJ-API-16b the widened READ door widens READ and nothing else', async () => {
      // The other half of the R51 fix, and the one worth guarding: visibility
      // is consulted by `@RequireProjectRead` alone. Every WRITE still asks for
      // its project permission, which a non-member does not have — so a caller
      // who can now OPEN an INTERNAL project still cannot change it.
      const emp = fx.employee.token;

      const readable = await get(`/projects/${fx.internalProjectId}`, emp);
      expect(readable.status).toBe(200);

      // Issued one at a time on purpose — `ctx.http()` binds a fresh ephemeral
      // port per call, and four in flight at once race each other's listener.
      const writes: Array<[string, () => Promise<any>]> = [
        [
          'PATCH /:id',
          () =>
            ctx
              .http()
              .patch(`/projects/${fx.internalProjectId}`)
              .set(bearer(emp))
              .send({ name: `hijacked ${fx.runId}` }),
        ],
        [
          'POST /:id/archive',
          () =>
            ctx
              .http()
              .post(`/projects/${fx.internalProjectId}/archive`)
              .set(bearer(emp))
              .send({}),
        ],
        [
          'DELETE /:id',
          () =>
            ctx.http().delete(`/projects/${fx.internalProjectId}`).set(bearer(emp)),
        ],
        [
          'POST /:id/members',
          () =>
            ctx
              .http()
              .post(`/projects/${fx.internalProjectId}/members`)
              .set(bearer(emp))
              .send({ employeeIds: [fx.employee.employeeId] }),
        ],
      ];
      for (const [label, send] of writes) {
        const res = await send();
        expect(`${label}:${res.status}`).toBe(`${label}:403`);
      }

      // The project is untouched, and PRIVATE is still membership-only —
      // asserted here as well as in PRJ-API-15 because it is the invariant the
      // widening must not have moved.
      const row = await ctx.prisma.project.findUnique({
        where: { id: fx.internalProjectId },
        select: { name: true, isArchived: true, deletedAt: true },
      });
      expect(row!.name).toBe(`WPL INT ${fx.runId}`);
      expect(row!.isArchived).toBe(false);
      expect(row!.deletedAt).toBeNull();

      const stillPrivate = await get(`/projects/${fx.privateProjectId}`, emp);
      expect(stillPrivate.status).toBe(403);

      // ...and the activity log is deliberately NOT part of the widening: it is
      // audit history, not the project record, so it stays membership-only
      // whatever the visibility says.
      const activity = await get(
        `/projects/${fx.internalProjectId}/activity`,
        emp,
      );
      expect(activity.status).toBe(403);
    });

    it('PRJ-API-17 GET /projects/:id — PUBLIC behaves exactly like INTERNAL: listed for all, readable by all', async () => {
      // REGRESSION LOCK — finding R51, the PUBLIC half. PUBLIC is INTERNAL and
      // then some, so it cannot be the stricter of the two; before the fix both
      // were refused to non-members alike. (Twin PRJ-API-17b has collapsed into
      // this case.)
      for (const [label, token] of actors()) {
        const res = await get(`/projects/${fx.publicProjectId}`, token);
        expect(`${label}:${res.status}`).toBe(`${label}:200`);
      }
    });

    it('PRJ-API-18 GET /projects/by-slug/:slug applies the same membership gate as GET /:id', async () => {
      // R51 — "the same gate" now means the same VISIBILITY-aware gate: PRIVATE
      // is membership-only through either door, PUBLIC opens through either.
      // Before the fix the slug door refused a non-member a PUBLIC project,
      // exactly as `GET /:id` did.
      const pairs: Array<[string, string, string, number]> = [
        ['private / member', fx.privateProjectSlug, fx.projectMember.token, 200],
        ['public / non-member', fx.publicProjectSlug, fx.projectMember.token, 200],
        ['internal / non-member', fx.internalProjectSlug, fx.employee.token, 200],
        ['private / non-member', fx.privateProjectSlug, fx.employee.token, 403],
      ];
      for (const [label, slug, token, expected] of pairs) {
        const res = await get(`/projects/by-slug/${slug}`, token);
        expect(`${label}:${res.status}`).toBe(`${label}:${expected}`);
      }

      // An unknown slug cannot be resolved to a project, so the guard refuses
      // before the service can 404 — the same answer a real-but-forbidden slug
      // gets, which is what stops slug enumeration.
      const ghost = await get(
        `/projects/by-slug/no-such-slug-${fx.runId}`,
        fx.projectMember.token,
      );
      expect(ghost.status).toBe(403);
    });

    it('PRJ-API-14 GET /projects/:id/my-permissions is behind the read door, and is still not an existence oracle', async () => {
      /**
       * REGRESSION LOCK — finding R9. `myPermissions` was the one route on
       * ProjectsController with no project guard at all: an EMPLOYEE who is a
       * member of nothing got 200 for a PRIVATE project they can neither list
       * nor read.
       *
       * The other half of R9 was REFUTED by this phase and must stay refuted:
       * it is NOT an existence oracle. `getAccess()` resolves a missing project
       * and a forbidden one through the same null branch, so a real PRIVATE id
       * and a random uuid answered byte-identically. A guard that 404'd the
       * unknown id and 403'd the private one would have closed a small hole by
       * opening a bigger one, so the route carries the SAME `@RequireProjectRead`
       * as `GET /:id`: a non-member of a PRIVATE project and a caller naming a
       * uuid that does not exist both fail the same membership test, then both
       * fail the same visibility lookup, and both get the identical 403.
       */
      const probe = await get(
        `/projects/${fx.privateProjectId}/my-permissions`,
        fx.employee.token,
      );
      expect(probe.status).toBe(403);

      const ghost = await get(
        `/projects/${UNKNOWN_UUID}/my-permissions`,
        fx.employee.token,
      );
      expect(ghost.status).toBe(403);

      // Indistinguishable, still. The error envelope carries a `path` (the
      // caller's own URL, echoed back) and a `timestamp`, so those two are
      // excluded — everything that could TELL the two apart is compared, and it
      // is identical. This is the assertion the R9 fix had to preserve, not
      // merely not break.
      const tell = (res: any) => ({
        status: res.status,
        success: res.body.success,
        statusCode: res.body.statusCode,
        message: res.body.message,
        errors: res.body.errors,
        keys: Object.keys(res.body).sort(),
      });
      expect(tell(ghost)).toEqual(tell(probe));

      // A member still gets their real answer through the same door.
      const member = await get(
        `/projects/${fx.privateProjectId}/my-permissions`,
        fx.projectMember.token,
      );
      expect(member.status).toBe(200);
      expect(member.body.data.roleSlug).not.toBeNull();

      // R51's requirement on this route: a non-member of an INTERNAL project
      // can now READ the project, so `my-permissions` must answer — and must
      // answer honestly, with the empty permission set every write refusal
      // rests on.
      const internal = await get(
        `/projects/${fx.internalProjectId}/my-permissions`,
        fx.employee.token,
      );
      expect(internal.status).toBe(200);
      expect(internal.body.data).toEqual({
        isGlobalAdmin: false,
        isOwner: false,
        roleSlug: null,
        permissions: [],
      });

      // Anonymous is still refused before any of this.
      const anon = await ctx
        .http()
        .get(`/projects/${fx.privateProjectId}/my-permissions`);
      expect(anon.status).toBe(401);
    });

    it('PRJ-API-07 POST /projects admits MANAGER (R16)', async () => {
      // `e2e/routes.ts` recorded `/dashboard/projects/new` as ADMIN_HR until
      // this phase corrected it. The controller carries
      // @Roles('ADMIN','HR_MANAGER','MANAGER'), so a MANAGER who is a member of
      // nothing may create a project — and becomes its owner.
      const res = await postProject(fx.projectOutsider.token, {
        name: `manager created ${fx.runId}`,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.ownerId).toBe(fx.projectOutsider.employeeId);
      expect(res.body.data.visibility).toBe('PRIVATE');

      // The creator is seeded as a member with the owner role, so the project
      // is immediately readable by id — proof the grant is real, not nominal.
      const read = await get(
        `/projects/${res.body.data.id}`,
        fx.projectOutsider.token,
      );
      expect(read.status).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. /projects/stats scoping
  // ══════════════════════════════════════════════════════════════════════════

  describe('GET /projects/stats', () => {
    const statsOf = async (token: string) => {
      const res = await get('/projects/stats', token);
      expect(res.status).toBe(200);
      return res.body.data as {
        total: number;
        active: number;
        completed: number;
        onHold: number;
      };
    };

    it("PRJ-API-19 an outsider's counts exclude projects they cannot see", async () => {
      const beforeOutsider = await statsOf(fx.projectOutsider.token);
      const beforeAdmin = await statsOf(fx.admin.token);

      // Two projects, added together: one the outsider must never count, one
      // they must. A count that moves by 2 is a leak; by 0 is a scoping bug in
      // the other direction.
      const hidden = await mkProject('STATSPRIV', {
        visibility: 'PRIVATE',
        status: 'ACTIVE',
      });
      const seen = await mkProject('STATSINT', {
        visibility: 'INTERNAL',
        status: 'ACTIVE',
      });

      const afterOutsider = await statsOf(fx.projectOutsider.token);
      const afterAdmin = await statsOf(fx.admin.token);

      expect(afterOutsider.total - beforeOutsider.total).toBe(1);
      expect(afterOutsider.active - beforeOutsider.active).toBe(1);
      expect(afterAdmin.total - beforeAdmin.total).toBe(2);
      expect(afterAdmin.active - beforeAdmin.active).toBe(2);

      // And the same principal's list agrees with their own counts.
      const slugs = await listSlugs(fx.projectOutsider.token);
      expect(slugs).toContain(seen.slug);
      expect(slugs).not.toContain(hidden.slug);
    });

    it('PRJ-API-20 archived and soft-deleted projects drop out of stats', async () => {
      const project = await mkProject('STATSDROP', {
        visibility: 'INTERNAL',
        status: 'ACTIVE',
      });
      const withProject = await statsOf(fx.projectOutsider.token);

      await ctx.prisma.project.update({
        where: { id: project.id },
        data: { isArchived: true },
      });
      const archived = await statsOf(fx.projectOutsider.token);
      expect(withProject.total - archived.total).toBe(1);

      await ctx.prisma.project.update({
        where: { id: project.id },
        data: { isArchived: false },
      });
      const restored = await statsOf(fx.projectOutsider.token);
      expect(restored.total).toBe(withProject.total);

      const removed = await ctx
        .http()
        .delete(`/projects/${project.id}`)
        .set(bearer(fx.admin.token));
      expect(removed.status).toBe(200);
      const deleted = await statsOf(fx.projectOutsider.token);
      expect(withProject.total - deleted.total).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Members
  // ══════════════════════════════════════════════════════════════════════════

  describe('members', () => {
    it('PRJ-API-21 employeeIds adds several members in one call, all on the default role', async () => {
      const project = await mkProject('BULK');
      const ids = [
        fx.memberEmployeeId,
        fx.viewerEmployeeId,
        fx.managedEmployeeId,
      ];
      const res = await ctx
        .http()
        .post(`/projects/${project.id}/members`)
        .set(bearer(fx.admin.token))
        .send({ employeeIds: ids });
      expect(res.status).toBe(201);
      expect(res.body.data).toHaveLength(3);

      const listed = await get(
        `/projects/${project.id}/members`,
        fx.admin.token,
      );
      expect(listed.status).toBe(200);
      const rows = listed.body.data as Array<{
        employeeId: string;
        role: string;
        projectRole: { slug: string; isDefault: boolean };
      }>;
      expect(rows.map((r) => r.employeeId).sort()).toEqual([...ids].sort());
      for (const row of rows) {
        expect(row.projectRole.slug).toBe('member');
        expect(row.projectRole.isDefault).toBe(true);
        expect(row.role).toBe('MEMBER');
      }

      // `employeeId` and `employeeIds` are unioned, not exclusive.
      const both = await ctx
        .http()
        .post(`/projects/${project.id}/members`)
        .set(bearer(fx.admin.token))
        .send({
          employeeId: fx.unmanagedEmployeeId,
          employeeIds: [fx.holderId],
        });
      expect(both.status).toBe(201);
      expect(both.body.data).toHaveLength(2);

      // Neither key at all is the one refusal this endpoint makes.
      const empty = await ctx
        .http()
        .post(`/projects/${project.id}/members`)
        .set(bearer(fx.admin.token))
        .send({});
      expect(empty.status).toBe(400);
      expect(empty.body.message).toContain('employeeId');
    });

    it('PRJ-API-22 re-adding an existing member UPSERTS — 201, one row, role silently overwritten', async () => {
      // The `@@unique([projectId, employeeId])` pair is honoured by
      // `projectMember.upsert`, so a duplicate add is not a 409. Recorded as
      // deliberate: `addMember` computes `newIds` precisely so the notification
      // only fires for genuinely new members. The consequence worth knowing is
      // that a re-add with a different role is an UNDECLARED role change with
      // no separate audit action.
      const project = await mkProject('DUP');
      const roles = await roleIdsOf(project.id);

      const first = await ctx
        .http()
        .post(`/projects/${project.id}/members`)
        .set(bearer(fx.admin.token))
        .send({ employeeId: fx.memberEmployeeId, roleId: roles.viewer });
      expect(first.status).toBe(201);

      const second = await ctx
        .http()
        .post(`/projects/${project.id}/members`)
        .set(bearer(fx.admin.token))
        .send({ employeeId: fx.memberEmployeeId, roleId: roles.manager });
      expect(second.status).toBe(201);

      const rows = await ctx.prisma.projectMember.findMany({
        where: { projectId: project.id, employeeId: fx.memberEmployeeId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].roleId).toBe(roles.manager);
      expect(rows[0].role).toBe('MANAGER');
      expect(rows[0].id).toBe(first.body.data[0].id);
    });

    it('PRJ-API-23 an unknown employeeId is refused up front, naming the id, and the good ids survive', async () => {
      // REGRESSION LOCK (R47, fixed). `addMember` never checked the employees
      // existed: the upsert failed the FK (P2003) INSIDE the $transaction, so
      // the whole batch rolled back — one bad id in a bulk add silently
      // discarded the good ones — and the caller was told only "Internal server
      // error", with no way to learn which id was at fault.
      const project = await mkProject('GHOSTMEM');
      const post = (body: Record<string, unknown>) =>
        ctx
          .http()
          .post(`/projects/${project.id}/members`)
          .set(bearer(fx.admin.token))
          .send(body);

      const mixed = await post({
        employeeIds: [fx.memberEmployeeId, UNKNOWN_UUID],
      });
      expect([400, 404]).toContain(mixed.status);
      expect(JSON.stringify(mixed.body.message)).toContain(UNKNOWN_UUID);
      // Named, so the caller can drop the offender rather than lose the batch.
      expect(JSON.stringify(mixed.body.message)).not.toContain(
        fx.memberEmployeeId,
      );

      // Nothing was written — the refusal is before the transaction, not a
      // rollback of it.
      expect(
        await ctx.prisma.projectMember.findMany({
          where: { projectId: project.id },
        }),
      ).toHaveLength(0);

      // Singular `employeeId` is the same door.
      const single = await post({ employeeId: UNKNOWN_UUID });
      expect([400, 404]).toContain(single.status);
      expect(JSON.stringify(single.body.message)).toContain(UNKNOWN_UUID);

      // And the good half of the batch lands once the offender is dropped.
      const retry = await post({ employeeIds: [fx.memberEmployeeId] });
      expect(retry.status).toBe(201);
      const rows = await ctx.prisma.projectMember.findMany({
        where: { projectId: project.id },
      });
      expect(rows.map((r) => r.employeeId)).toEqual([fx.memberEmployeeId]);
    });

    it('PRJ-API-24 removing or updating a member row that does not exist answers 404', async () => {
      const project = await mkProject('NOMEMBER');

      const removed = await ctx
        .http()
        .delete(`/projects/${project.id}/members/${UNKNOWN_UUID}`)
        .set(bearer(fx.admin.token));
      expect(removed.status).toBe(404);
      expect(removed.body.message).toBe('Member not found');

      const updated = await ctx
        .http()
        .patch(`/projects/${project.id}/members/${UNKNOWN_UUID}`)
        .set(bearer(fx.admin.token))
        .send({ role: 'VIEWER' });
      expect(updated.status).toBe(404);

      // A member row that belongs to ANOTHER project is 404 too — the service
      // scopes by `{ id, projectId }`, so a memberId cannot be walked across
      // projects.
      const foreign = await ctx
        .http()
        .delete(`/projects/${project.id}/members/${fx.privateMemberIds.member}`)
        .set(bearer(fx.admin.token));
      expect(foreign.status).toBe(404);
    });

    it("PRJ-API-25 removing the OWNER's membership row leaves the project, and the owner, intact", async () => {
      const project = await mkProject('OWNERROW');
      const roles = await roleIdsOf(project.id);
      const ownerRow = await ctx.prisma.projectMember.create({
        data: {
          projectId: project.id,
          employeeId: fx.ownerEmployeeId,
          role: 'OWNER',
          roleId: roles.owner,
        },
      });

      const res = await ctx
        .http()
        .delete(`/projects/${project.id}/members/${ownerRow.id}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const rows = await ctx.prisma.projectMember.findMany({
        where: { projectId: project.id },
      });
      expect(rows).toHaveLength(0);

      // `Project.ownerId` is untouched — the project is NOT orphaned, and
      // `getAccess()` still grants owner rights through `ownerId === employeeId`
      // even with no membership row at all.
      const row = await ctx.prisma.project.findUnique({
        where: { id: project.id },
      });
      expect(row!.ownerId).toBe(fx.ownerEmployeeId);

      const stillOwner = await ctx
        .http()
        .patch(`/projects/${project.id}`)
        .set(bearer(fx.projectOwner.token))
        .send({ description: `still owner ${fx.runId}` });
      expect(stillOwner.status).toBe(200);

      const perms = await get(
        `/projects/${project.id}/my-permissions`,
        fx.projectOwner.token,
      );
      expect(perms.body.data.isOwner).toBe(true);
      expect(perms.body.data.roleSlug).toBe('owner');
    });

    it('PRJ-API-26 resolveMemberRole prefers roleId, then the slug, then the project default — and refuses an unknown name', async () => {
      const project = await mkProject('ROLEDISPATCH');
      const roles = await roleIdsOf(project.id);

      const add = (employeeId: string, body: Record<string, unknown>) =>
        ctx
          .http()
          .post(`/projects/${project.id}/members`)
          .set(bearer(fx.admin.token))
          .send({ employeeId, ...body });

      // 1. roleId WINS over a conflicting legacy `role`.
      const byId = await add(fx.memberEmployeeId, {
        roleId: roles.viewer,
        role: 'MANAGER',
      });
      expect(byId.status).toBe(201);
      expect(byId.body.data[0].roleId).toBe(roles.viewer);
      expect(byId.body.data[0].role).toBe('VIEWER');

      // 2. No roleId → the legacy string is lower-cased and matched on SLUG.
      const bySlug = await add(fx.viewerEmployeeId, { role: 'MANAGER' });
      expect(bySlug.body.data[0].roleId).toBe(roles.manager);
      expect(bySlug.body.data[0].role).toBe('MANAGER');

      // 2b. The literal 'MEMBER' `NewProjectModal` posts still resolves,
      //     because the match lower-cases before comparing the slug.
      const modalShape = await add(fx.managedEmployeeId, { role: 'MEMBER' });
      expect(modalShape.status).toBe(201);
      expect(modalShape.body.data[0].roleId).toBe(roles.member);

      // 3. REGRESSION LOCK (R50, fixed). A non-empty string that matches no
      //    role used to fall through to the project default SILENTLY — 201,
      //    and the caller was told nothing about the role it asked for.
      const unknownRole = await add(fx.unmanagedEmployeeId, {
        role: 'SUPREME_LEADER',
      });
      expect(unknownRole.status).toBe(400);
      expect(JSON.stringify(unknownRole.body.message)).toContain(
        'SUPREME_LEADER',
      );
      expect(
        await ctx.prisma.projectMember.findFirst({
          where: { projectId: project.id, employeeId: fx.unmanagedEmployeeId },
        }),
      ).toBeNull();

      // 4. Nothing at all → the default role. Absent, '' and blank all mean
      //    "use the default"; only an unrecognised NON-empty name is refused.
      const bare = await add(fx.unmanagedEmployeeId, {});
      expect(bare.body.data[0].roleId).toBe(roles.member);
      const blank = await add(fx.unmanagedEmployeeId, { role: '   ' });
      expect(blank.status).toBe(201);
      expect(blank.body.data[0].roleId).toBe(roles.member);

      // 5. PATCH runs the same resolver.
      const memberRow = byId.body.data[0].id;
      const patched = await ctx
        .http()
        .patch(`/projects/${project.id}/members/${memberRow}`)
        .set(bearer(fx.admin.token))
        .send({ role: 'owner' });
      expect(patched.status).toBe(200);
      expect(patched.body.data.roleId).toBe(roles.owner);
      expect(patched.body.data.projectRole.slug).toBe('owner');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Archive / unarchive, asserted as a disappearance
  // ══════════════════════════════════════════════════════════════════════════

  describe('archive / unarchive', () => {
    it('PRJ-API-27 archiving REMOVES the project from the default list and puts it in the archived one', async () => {
      const project = await mkProject('ARCHIVE', { visibility: 'INTERNAL' });

      expect(await listSlugs(fx.admin.token)).toContain(project.slug);
      expect(await listSlugs(fx.admin.token, '&isArchived=true')).not.toContain(
        project.slug,
      );

      const archived = await ctx
        .http()
        .post(`/projects/${project.id}/archive`)
        .set(bearer(fx.admin.token));
      // 201, not 200: archive/unarchive are `@Post()` handlers, so Nest's
      // default POST status applies to what is a state toggle on an existing
      // row. Recorded because the frontend checks `res.ok`, not the code.
      expect(archived.status).toBe(201);
      expect(archived.body.data.isArchived).toBe(true);

      // The disappearance the baseline spec never asserted.
      expect(await listSlugs(fx.admin.token)).not.toContain(project.slug);
      expect(
        await listSlugs(fx.admin.token, '&isArchived=false'),
      ).not.toContain(project.slug);
      expect(await listSlugs(fx.admin.token, '&isArchived=true')).toContain(
        project.slug,
      );

      // It disappears for a non-admin viewer too — `isArchived` is applied
      // before the visibility clause, not after it.
      expect(await listSlugs(fx.projectOutsider.token)).not.toContain(
        project.slug,
      );

      // But it is still readable by id, and still countable by anyone holding
      // the id. Archive is a list filter, not an access control.
      const byId = await get(`/projects/${project.id}`, fx.admin.token);
      expect(byId.status).toBe(200);
      expect(byId.body.data.isArchived).toBe(true);
    });

    it('PRJ-API-28 unarchiving restores it to the default list and removes it from the archived one', async () => {
      const project = await mkProject('UNARCHIVE', { isArchived: true });

      expect(await listSlugs(fx.admin.token)).not.toContain(project.slug);

      const res = await ctx
        .http()
        .post(`/projects/${project.id}/unarchive`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(201);
      expect(res.body.data.isArchived).toBe(false);

      expect(await listSlugs(fx.admin.token)).toContain(project.slug);
      expect(await listSlugs(fx.admin.token, '&isArchived=true')).not.toContain(
        project.slug,
      );

      // Archiving something already archived, and unarchiving something
      // already live, are both idempotent successes rather than 409s.
      const again = await ctx
        .http()
        .post(`/projects/${project.id}/unarchive`)
        .set(bearer(fx.admin.token));
      expect(again.status).toBe(201);
      expect(again.body.data.isArchived).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Soft delete
  // ══════════════════════════════════════════════════════════════════════════

  describe('soft delete', () => {
    it('PRJ-API-29 DELETE stamps deletedAt and the row leaves every list and count', async () => {
      const project = await mkProject('SOFTDEL', { visibility: 'INTERNAL' });
      expect(await listSlugs(fx.admin.token)).toContain(project.slug);

      const res = await ctx
        .http()
        .delete(`/projects/${project.id}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Project deleted successfully');

      const row = await ctx.prisma.project.findUnique({
        where: { id: project.id },
      });
      expect(row).not.toBeNull();
      expect(row!.deletedAt).toBeInstanceOf(Date);

      expect(await listSlugs(fx.admin.token)).not.toContain(project.slug);
      expect(await listSlugs(fx.admin.token, '&isArchived=true')).not.toContain(
        project.slug,
      );
      expect(await listSlugs(fx.projectOutsider.token)).not.toContain(
        project.slug,
      );

      // Deleting it twice is a 404, not a second soft delete.
      const again = await ctx
        .http()
        .delete(`/projects/${project.id}`)
        .set(bearer(fx.admin.token));
      expect(again.status).toBe(404);
    });

    it('PRJ-API-30 a soft-deleted project is NOT readable by id — unlike the Organization phase finding', async () => {
      const project = await mkProject('SOFTDELREAD', {
        visibility: 'INTERNAL',
      });
      await ctx
        .http()
        .delete(`/projects/${project.id}`)
        .set(bearer(fx.admin.token))
        .expect(200);

      // CORRECT despite looking wrong. The Organization phase found soft-deleted
      // rows still readable by id because the read path forgot the
      // `deletedAt: null` filter the list applies. Projects do NOT repeat it:
      // `findOne`, `findBySlug`, `update`, `remove`, `setArchived` and
      // `getCharts` all use `findFirst({ where: { …, deletedAt: null } })`.
      for (const token of [fx.admin.token, fx.projectOwner.token]) {
        const byId = await get(`/projects/${project.id}`, token);
        expect(byId.status).toBe(404);
        expect(byId.body.message).toBe('Project not found');

        const bySlug = await get(`/projects/by-slug/${project.slug}`, token);
        expect(bySlug.status).toBe(404);
      }

      // Writes are refused too, on the same filter.
      const patched = await ctx
        .http()
        .patch(`/projects/${project.id}`)
        .set(bearer(fx.admin.token))
        .send({ name: `zombie ${fx.runId}` });
      expect(patched.status).toBe(404);

      const archived = await ctx
        .http()
        .post(`/projects/${project.id}/archive`)
        .set(bearer(fx.admin.token));
      expect(archived.status).toBe(404);

      const charts = await get(
        `/projects/${project.slug}/charts`,
        fx.admin.token,
      );
      expect(charts.status).toBe(404);

      // The one seam that still answers: the guard resolves membership from a
      // `findUnique` with NO deletedAt filter, so a non-member is still told
      // 403 (not 404) for a project that no longer exists. Harmless — it leaks
      // nothing a 404 would not — but recorded so the asymmetry is not a
      // surprise later.
      const outsider = await get(
        `/projects/${project.id}`,
        fx.projectOutsider.token,
      );
      expect(outsider.status).toBe(403);

      // Members endpoints have no deletedAt filter at all: the roster of a
      // deleted project is still readable by its members.
      const members = await get(
        `/projects/${project.id}/members`,
        fx.admin.token,
      );
      expect(members.status).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7. Activity log
  // ══════════════════════════════════════════════════════════════════════════

  describe('activity log', () => {
    let activityProjectId: string;
    let activityTaskId: string;
    const TOTAL_PROJECT_ROWS = 24;

    beforeAll(async () => {
      const project = await mkProject('ACTIVITY');
      activityProjectId = project.id;
      const task = await mkTask(project.id, 'ACT', fx.privateStatusIds[0]);
      activityTaskId = task.id;

      // Rows are written directly rather than through the API: the audit
      // interceptor fires `void auditService.log(...)` AFTER the response, so a
      // spec that PATCHes N times and then reads cannot assert an exact count
      // without polling. Ordering and pagination are what this case is about.
      const base = Date.now() - 60 * 60 * 1000;
      await ctx.prisma.auditLog.createMany({
        data: [
          ...Array.from({ length: TOTAL_PROJECT_ROWS }, (_, i) => ({
            userId: fx.admin.userId,
            action: 'UPDATE',
            resourceType: 'Project',
            resourceId: project.id,
            newData: { seq: i } as any,
            createdAt: new Date(base + i * 1000),
          })),
          {
            userId: fx.admin.userId,
            action: 'UPDATE',
            resourceType: 'Task',
            resourceId: task.id,
            newData: { seq: 'task' } as any,
            createdAt: new Date(base + TOTAL_PROJECT_ROWS * 1000),
          },
          // Noise that must NOT be picked up: another resourceType on the same
          // id, and a Task row belonging to no project of ours.
          {
            userId: fx.admin.userId,
            action: 'UPDATE',
            resourceType: 'Employee',
            resourceId: project.id,
            createdAt: new Date(base),
          },
        ],
      });
    }, 120000);

    it('PRJ-API-31 activity paginates and orders newest-first', async () => {
      const total = TOTAL_PROJECT_ROWS + 1; // + the Task row
      const page1 = await get(
        `/projects/${activityProjectId}/activity?page=1&limit=10`,
        fx.admin.token,
      );
      expect(page1.status).toBe(200);
      expect(page1.body.meta).toMatchObject({
        total,
        page: 1,
        limit: 10,
        totalPages: 3,
      });
      expect(page1.body.data).toHaveLength(10);

      const times = (body: any) =>
        (body.data as Array<{ createdAt: string }>).map((r) =>
          new Date(r.createdAt).getTime(),
        );
      const t1 = times(page1.body);
      expect([...t1].sort((a, b) => b - a)).toEqual(t1);

      const page3 = await get(
        `/projects/${activityProjectId}/activity?page=3&limit=10`,
        fx.admin.token,
      );
      expect(page3.body.data).toHaveLength(5);
      // No row appears on two pages, and the last page is strictly older.
      expect(Math.max(...times(page3.body))).toBeLessThan(Math.min(...t1));

      // Default paging when the query is omitted.
      const bare = await get(
        `/projects/${activityProjectId}/activity`,
        fx.admin.token,
      );
      expect(bare.body.meta).toMatchObject({ page: 1, limit: 20 });
      expect(bare.body.data).toHaveLength(20);

      // Each row carries the actor, which is the whole point of the feed.
      expect(bare.body.data[0].user.email).toBe(fx.admin.email);
    });

    it('PRJ-API-32 activity unions AuditLog rows for resourceType Project AND Task', async () => {
      const res = await get(
        `/projects/${activityProjectId}/activity?limit=200`,
        fx.admin.token,
      );
      expect(res.status).toBe(200);
      const rows = res.body.data as Array<{
        resourceType: string;
        resourceId: string;
      }>;

      const kinds = new Set(rows.map((r) => r.resourceType));
      expect(kinds).toEqual(new Set(['Project', 'Task']));
      expect(rows.filter((r) => r.resourceType === 'Task')).toHaveLength(1);
      expect(rows.find((r) => r.resourceType === 'Task')!.resourceId).toBe(
        activityTaskId,
      );

      // The `Employee` row planted on the same resourceId is excluded — the
      // filter is (resourceType, resourceId), not resourceId alone.
      expect(rows.some((r) => r.resourceType === 'Employee')).toBe(false);

      // A project with no tasks and no audit rows renders as an empty feed
      // rather than failing on the empty `IN ()` branch.
      const quiet = await mkProject('QUIETFEED');
      const empty = await get(`/projects/${quiet.id}/activity`, fx.admin.token);
      expect(empty.status).toBe(200);
      expect(empty.body.data).toHaveLength(0);
      expect(empty.body.meta.total).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. Charts
  // ══════════════════════════════════════════════════════════════════════════

  describe('charts', () => {
    it("PRJ-API-37 charts count only this project's live tasks and compute completionRate from the DONE category", async () => {
      const project = await mkProject('CHARTS');
      const [todoId, inProgressId, doneId] = fx.privateStatusIds;

      await mkTask(project.id, 'C1', todoId, { priority: 'HIGH' });
      await mkTask(project.id, 'C2', inProgressId, { priority: 'HIGH' });
      await mkTask(project.id, 'C3', doneId, {
        priority: 'LOW',
        storyPoints: 5,
      });
      // Soft-deleted tasks must not count.
      await mkTask(project.id, 'C4', doneId, { deletedAt: new Date() });
      // A task on the fixture project that shares this workflow must not leak in.
      await mkTask(fx.privateProjectId, 'C5', doneId);

      const res = await get(`/projects/${project.slug}/charts`, fx.admin.token);
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.kpi).toEqual({
        total: 3,
        done: 1,
        inProgress: 1,
        todo: 1,
        completionRate: 33,
      });

      // statusDistribution follows the workflow's column order, not task order.
      expect(
        data.statusDistribution.map((s: { name: string; value: number }) => [
          s.name,
          s.value,
        ]),
      ).toEqual([
        ['To Do', 1],
        ['In Progress', 1],
        ['Done', 1],
      ]);

      const byPriority = Object.fromEntries(
        data.byPriority.map((p: { name: string; value: number }) => [
          p.name,
          p.value,
        ]),
      );
      expect(byPriority).toMatchObject({ HIGH: 2, LOW: 1 });

      // KNOWN GAP (no finding id): `byPriority` and `byType` are Prisma
      // groupBy calls over `{ projectId, deletedAt: null }`, but the KPI block
      // is computed from a separate `findMany`. They agree here; they are two
      // queries that could drift apart, which is worth a note beside the count.
      const priorityTotal = (
        data.byPriority as Array<{ value: number }>
      ).reduce((s, p) => s + p.value, 0);
      expect(priorityTotal).toBe(data.kpi.total);

      // The charts door is membership-gated exactly like `GET /:id`.
      const outsider = await get(
        `/projects/${project.slug}/charts`,
        fx.projectOutsider.token,
      );
      expect(outsider.status).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 9. THE FINDINGS
  // ══════════════════════════════════════════════════════════════════════════

  describe('findings', () => {
    it('PRJ-API-33 project codes come from a sequence, so a non-PROJ code cannot poison the generator (R6)', async () => {
      // REGRESSION LOCK (R6 / plan §5.5 F11 — the worst defect of the phase,
      // now fixed). `generateProjectCode()` used to be:
      //
      //   const last = await prisma.project.findFirst({
      //     orderBy: { projectCode: 'desc' }, select: { projectCode: true } });
      //   const nextNum = last ? parseInt(last.projectCode.replace('PROJ-',''),10)+1 : 1;
      //   return `PROJ-${String(nextNum).padStart(4,'0')}`;
      //
      // It assumed every row in the table was `PROJ-<digits>`. Any code whose
      // first letter sorts above 'P' became the lexical maximum, parseInt
      // returned NaN, and the generator emitted the LITERAL string
      // 'PROJ-0NaN'. `project_code` is @unique, so exactly one row could hold
      // it: the first create returned 201 with a nonsense code and EVERY later
      // create in that database answered 500 (raw P2002) until somebody deleted
      // the row. The workplace fixtures seed `WP…` codes, so every suite in the
      // phase ran in that state — and an imported or hand-assigned code does it
      // in production, permanently.
      //
      // `nextProjectCode()` now reads `nextval('project_code_seq')`, the same
      // mechanism letter serials use (`letter_serial_seq`,
      // `LettersService.nextSerial()`): atomic, and blind to how any other row
      // spells its code.

      // The poison is present — this is the state the whole phase ran in.
      const max = await ctx.prisma.project.findFirst({
        orderBy: { projectCode: 'desc' },
        select: { projectCode: true },
      });
      expect(max).not.toBeNull();
      expect(max!.projectCode).not.toMatch(/^PROJ-\d+$/);

      // Three consecutive creates, all 201, all well-formed, all distinct and
      // strictly increasing. Under the old generator the second was a 500.
      const codes: string[] = [];
      for (const n of [1, 2, 3]) {
        const res = await postProject(fx.admin.token, {
          name: `code probe ${n} ${fx.runId}`,
        });
        expect(`probe${n}:${res.status}`).toBe(`probe${n}:201`);
        expect(res.body.data.projectCode).toMatch(/^PROJ-\d{4,}$/);
        codes.push(res.body.data.projectCode);
      }
      expect(new Set(codes).size).toBe(3);
      const nums = codes.map((c) => Number(c.slice(5)));
      expect(nums[1]).toBeGreaterThan(nums[0]);
      expect(nums[2]).toBeGreaterThan(nums[1]);
      expect(codes).not.toContain('PROJ-0NaN');

      // The sequence is the source, proved the way the letters suite proves
      // its own: the next value follows the last code minted.
      const [{ last_value }] = await ctx.prisma.$queryRawUnsafe<
        Array<{ last_value: bigint }>
      >(`SELECT last_value FROM project_code_seq`);
      expect(Number(last_value)).toBe(nums[2]);
    });

    it('PRJ-API-33a parallel creates: distinct codes, and a slug collision is a clean 409 (R6/R45)', async () => {
      // REGRESSION LOCK (R6 second half + R45, fixed). `generateProjectCode()`
      // and `uniqueSlug()` are both read-then-write. The code half is now a
      // sequence, which cannot hand two racers the same number; the slug half
      // still reads before it writes, so the loser's P2002 is mapped to a
      // ConflictException instead of escaping as a raw 500.
      const [a, b] = await Promise.all([
        postProject(fx.admin.token, { name: `race A ${fx.runId}` }),
        postProject(fx.admin.token, { name: `race B ${fx.runId}` }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.data.projectCode).not.toBe(b.body.data.projectCode);

      // Same explicit slug, sent at the same moment: exactly one wins, and the
      // loser is told what happened.
      const slug = `race-slug-${fx.runId}`;
      const [c, d] = await Promise.all([
        postProject(fx.admin.token, { name: `race slug C ${fx.runId}`, slug }),
        postProject(fx.admin.token, { name: `race slug D ${fx.runId}`, slug }),
      ]);
      const statuses = [c.status, d.status].sort();
      expect(statuses.filter((x) => x === 201)).toHaveLength(1);
      expect(statuses).not.toContain(500);
      // The loser is a 409 — or a 201 with a de-duplicated slug, if the two
      // reads happened not to overlap. Never a 500, and never two rows on the
      // one slug.
      const loser = [c, d].find((r) => r.status !== 201);
      if (loser) expect(loser.status).toBe(409);
      expect(await ctx.prisma.project.count({ where: { slug } })).toBe(1);
    });

    it('PRJ-API-39 a soft-deleted department or team is still identifiable on the project (R63/R64)', async () => {
      // REGRESSION LOCK (R63 / R64, fixed on this side). `DELETE
      // /departments/:id` and `DELETE /teams/:id` write `isActive:false` — the
      // rows are never deleted, so the `SetNull` FKs on Project never fire and
      // the project keeps pointing at something `GET /departments` and
      // `GET /teams` have already dropped. The project projection was
      // `{id,name,code}` with no `isActive`, so the payload was
      // indistinguishable from a live link: a screen rendered a department name
      // that exists nowhere else in the product, and no caller could tell.
      //
      // Those two services belong to another module and are not edited here.
      // What IS fixed here is the projection: `isActive` now rides along, so a
      // retired link is legible.
      const dept = await ctx.prisma.department.create({
        data: { code: `WP4D-${short}`, name: `WP4 dept ${fx.runId}` },
      });
      ownDeptIds.push(dept.id);
      const team = await ctx.prisma.team.create({
        data: {
          code: `WP4T-${short}`,
          name: `WP4 team ${fx.runId}`,
          departmentId: dept.id,
        },
      });
      ownTeamIds.push(team.id);

      const project = await mkProject('RETIREDLINK', {
        departmentId: dept.id,
        teamId: team.id,
      });

      const live = await get(`/projects/${project.id}`, fx.admin.token);
      expect(live.status).toBe(200);
      expect(live.body.data.department).toMatchObject({
        id: dept.id,
        isActive: true,
      });
      expect(live.body.data.team).toMatchObject({
        id: team.id,
        isActive: true,
      });

      // Exactly what DELETE /departments/:id and DELETE /teams/:id write.
      await ctx.prisma.department.update({
        where: { id: dept.id },
        data: { isActive: false },
      });
      await ctx.prisma.team.update({
        where: { id: team.id },
        data: { isActive: false },
      });

      const retired = await get(`/projects/${project.id}`, fx.admin.token);
      expect(retired.status).toBe(200);
      // The FK survives the soft delete — that half is unchanged and is the
      // finding.
      expect(retired.body.data.departmentId).toBe(dept.id);
      expect(retired.body.data.teamId).toBe(team.id);
      // But the caller can now SEE that both links are retired.
      expect(retired.body.data.department.isActive).toBe(false);
      expect(retired.body.data.team.isActive).toBe(false);

      // The list projection carries it too — same `projectInclude`.
      const listed = await get(
        `/projects?search=${fx.runId}&limit=200`,
        fx.admin.token,
      );
      const card = (listed.body.data as Array<any>).find(
        (p) => p.id === project.id,
      );
      expect(card.department.isActive).toBe(false);
      expect(card.team.isActive).toBe(false);
    });

    it('PRJ-API-34 R10 — RECORDED INTENT: projects have NO branch scoping at all', async () => {
      // This is NOT a defect. `src/common/branch/branch-scope.map.ts` contains
      // no entry for Project, ProjectMember, ProjectRole, Task or Sprint — the
      // whole tracker is excluded from tenancy by design, because a project is
      // a cross-branch collaboration surface.
      //
      // It is asserted LOUDLY because the same codebase gives three different
      // answers: AssetItem is 'direct'-scoped (an out-of-branch asset is
      // invisible), LetterRequest is 'relation'-scoped through its employee,
      // and Project is not scoped at all. Anyone reasoning "HR is scoped to
      // branch A, therefore they cannot touch branch B's data" is wrong here,
      // and this case is the record of that.
      const branchBSecond = await mkEmployee('BB2', { branchId: fx.branchB });

      const project = await mkProject('BRANCHB', {
        ownerId: fx.branchBEmployeeId,
        visibility: 'PRIVATE',
      });
      const roles = await roleIdsOf(project.id);
      await ctx.prisma.projectMember.create({
        data: {
          projectId: project.id,
          employeeId: fx.branchBEmployeeId,
          role: 'OWNER',
          roleId: roles.owner,
        },
      });

      // Everything about this project lives in branch B.
      const members = await ctx.prisma.projectMember.findMany({
        where: { projectId: project.id },
        include: { employee: { select: { branchId: true } } },
      });
      expect(members).toHaveLength(1);
      for (const m of members) {
        expect(m.employee.branchId).toBe(fx.branchB);
      }

      // The branch-A-scoped HR_MANAGER reads it...
      const read = await get(`/projects/${project.id}`, fx.scopedHr.token);
      expect(read.status).toBe(200);

      // ...lists it...
      expect(await listSlugs(fx.scopedHr.token)).toContain(project.slug);

      // ...edits it...
      const edited = await ctx
        .http()
        .patch(`/projects/${project.id}`)
        .set(bearer(fx.scopedHr.token))
        .send({ name: `renamed by branch-A HR ${fx.runId}` });
      expect(edited.status).toBe(200);

      // ...and adds a branch-B employee to it.
      const added = await ctx
        .http()
        .post(`/projects/${project.id}/members`)
        .set(bearer(fx.scopedHr.token))
        .send({ employeeId: branchBSecond.id });
      expect(added.status).toBe(201);

      // Contrast, in the same request cycle: the SAME principal cannot see a
      // branch-B ASSET, because AssetItem *is* branch-scoped.
      const asset = await get(
        `/assets/${fx.assetAvailableBId}`,
        fx.scopedHr.token,
      );
      expect(asset.status).toBe(404);
    });

    /**
     * R12, COLLAPSED. `PRJ-API-35` used to assert the ownerless outcome and its
     * `it.failing` twin `PRJ-API-35b` asserted that a project should never be
     * left ownerless; both are gone, replaced by this case and the two below
     * asserting the behaviour the product owner decided on.
     *
     * THE DEFECT. `Project.ownerId` is `onDelete: SetNull` and
     * `ProjectMember.employeeId` is `onDelete: Cascade`, so a HARD delete of an
     * employee nulled the owner of every project they owned AND erased their
     * membership row in the same instant — severing both of the routes
     * `ProjectAccessService.getAccess()` has to owner rights (`ownerId ===
     * employeeId`, or a membership row carrying the `owner` slug). Nobody
     * inherited: the surviving members got 403 on `PATCH` and only a global
     * ADMIN/HR_MANAGER could act on the project again.
     *
     * THE FIX. `EmployeesService.hardDelete` now calls
     * `reassignProjectOwnershipOnEmployeeDelete` inside the same transaction as
     * the delete, so a project is never OBSERVABLE without an owner. The heir is
     * chosen by a three-rule ladder; this case is rule 1, the longest-serving
     * OTHER member carrying the `owner` slug. `PRJ-API-35a` is rule 2 (the
     * creator) and `PRJ-API-35b` is rule 3 (accept the null owner, but make it
     * findable).
     *
     * The soft-delete half is asserted FIRST and deliberately kept: the
     * product's ordinary offboarding writes `Employee.status = 'INACTIVE'`
     * (R72) and fires neither FK, so ownership survives a normal departure
     * untouched. That contrast is why the finding was subtle — "the owner left
     * the company" really is handled — and losing it would make this suite
     * weaker than it was when it found the bug.
     */
    it('PRJ-API-35 R12 — a soft delete leaves ownership alone; a HARD delete hands it to the longest-serving owner-role member', async () => {
      const owner = await mkEmployee('R12OWNER');
      const junior = await mkEmployee('R12JR');
      const plain = await mkEmployee('R12PLAIN');
      // The heir is a fixture persona precisely because they have a LOGIN:
      // `ownerId` moving is only half the claim, and `my-permissions` answering
      // through a real token is the other half.
      const elderId = fx.projectMember.employeeId!;

      const project = await mkProject('R12', {
        ownerId: owner.id,
        visibility: 'INTERNAL',
      });
      const roles = await roleIdsOf(project.id);
      await ctx.prisma.projectMember.createMany({
        data: [
          {
            projectId: project.id,
            employeeId: owner.id,
            role: 'OWNER',
            roleId: roles.owner,
            joinedAt: new Date('2022-01-01'),
          },
          // Joined before either owner-role member — and still does NOT
          // inherit. Seniority only ranks candidates that already hold `owner`;
          // it never promotes anybody.
          {
            projectId: project.id,
            employeeId: plain.id,
            role: 'MEMBER',
            roleId: roles.member,
            joinedAt: new Date('2023-01-01'),
          },
          {
            projectId: project.id,
            employeeId: elderId,
            role: 'OWNER',
            roleId: roles.owner,
            joinedAt: new Date('2024-01-01'),
          },
          {
            projectId: project.id,
            employeeId: junior.id,
            role: 'OWNER',
            roleId: roles.owner,
            joinedAt: new Date('2025-01-01'),
          },
        ],
      });

      // ── The SOFT delete: the real offboarding door, and it changes nothing ──
      const soft = await ctx
        .http()
        .delete(`/employees/${owner.id}`)
        .set(bearer(fx.admin.token));
      expect(soft.status).toBe(200);
      expect(
        (await ctx.prisma.employee.findUnique({ where: { id: owner.id } }))!
          .status,
      ).toBe('INACTIVE');

      const afterSoft = await ctx.prisma.project.findUnique({
        where: { id: project.id },
      });
      expect(afterSoft!.ownerId).toBe(owner.id);
      expect(
        await ctx.prisma.projectMember.count({
          where: { projectId: project.id, employeeId: owner.id },
        }),
      ).toBe(1);

      // ── The HARD delete: ownership is handed over, in the same transaction ──
      const hard = await hardDelete(owner.id);
      expect(hard.status).toBe(200);
      expect(
        await ctx.prisma.employee.findUnique({ where: { id: owner.id } }),
      ).toBeNull();

      const after = await ctx.prisma.project.findUnique({
        where: { id: project.id },
      });
      expect(after!.ownerId).toBe(elderId);
      expect(after!.ownerId).not.toBeNull();

      // Both of `getAccess()`'s routes agree — `ownerId` AND a membership row
      // carrying the `owner` slug. One of them silently failing can no longer
      // strand the project.
      const heirRow = await ctx.prisma.projectMember.findUnique({
        where: {
          projectId_employeeId: { projectId: project.id, employeeId: elderId },
        },
        include: { projectRole: { select: { slug: true } } },
      });
      expect(heirRow!.projectRole!.slug).toBe('owner');
      expect(heirRow!.role).toBe('OWNER');

      const perms = await get(
        `/projects/${project.id}/my-permissions`,
        fx.projectMember.token,
      );
      expect(perms.status).toBe(200);
      expect(perms.body.data.isOwner).toBe(true);

      const edit = await ctx
        .http()
        .patch(`/projects/${project.id}`)
        .set(bearer(fx.projectMember.token))
        .send({ description: `heir edit ${fx.runId}` });
      expect(edit.status).toBe(200);

      // Seniority decided it: the junior owner-role member is untouched, and
      // the plain member is still a plain member.
      expect(after!.ownerId).not.toBe(junior.id);
      const plainRow = await ctx.prisma.projectMember.findUnique({
        where: {
          projectId_employeeId: {
            projectId: project.id,
            employeeId: plain.id,
          },
        },
        include: { projectRole: { select: { slug: true } } },
      });
      expect(plainRow!.projectRole!.slug).toBe('member');

      // The handover is visible where every other project change is visible.
      const handoverLog = await ctx.prisma.auditLog.findFirst({
        where: {
          resourceType: 'Project',
          resourceId: project.id,
          action: 'PROJECT_OWNER_REASSIGNED',
        },
      });
      expect(handoverLog).toBeTruthy();
      expect((handoverLog!.oldData as any).ownerId).toBe(owner.id);
      expect((handoverLog!.newData as any).ownerId).toBe(elderId);
      expect((handoverLog!.newData as any).via).toBe('owner-role-member');

      const activity = await get(
        `/projects/${project.id}/activity`,
        fx.admin.token,
      );
      expect(activity.status).toBe(200);
      expect(
        (activity.body.data as Array<{ action: string }>).map((r) => r.action),
      ).toContain('PROJECT_OWNER_REASSIGNED');
    });

    /**
     * R12, rule 2 — and the exact shape the original pin recorded: an owner and
     * ONE plain member. Before the fix this was the stranding case, because the
     * survivor holds `member` (TASK_STATUS_UPDATE only) and the `ownerId` was
     * nulled, so nobody below a global ADMIN could edit, archive or delete the
     * project ever again.
     *
     * The decision does not promote the plain member — they were never given
     * owner rights and inventing them here would be a privilege escalation
     * dressed as a repair. It falls back to `Project.createdById` instead: the
     * person who stood the project up, if they are still here and still ACTIVE.
     * Note `createdById` holds a USER id (`ProjectsService.create` writes
     * `user?.id`), so the handover resolves it through `User.employeeId`.
     */
    it('PRJ-API-35a R12 — with no other owner-role member, the still-active creator inherits', async () => {
      const owner = await mkEmployee('R12CREATOR');
      const survivorId = fx.projectMember.employeeId!;
      const creatorEmployeeId = fx.projectOwner.employeeId!;

      const project = await mkProject('R12CR', {
        ownerId: owner.id,
        createdById: fx.projectOwner.userId,
      });
      const roles = await roleIdsOf(project.id);
      await ctx.prisma.projectMember.createMany({
        data: [
          {
            projectId: project.id,
            employeeId: owner.id,
            role: 'OWNER',
            roleId: roles.owner,
          },
          {
            projectId: project.id,
            employeeId: survivorId,
            role: 'MEMBER',
            roleId: roles.member,
          },
        ],
      });

      // The creator is not a member and holds no project rights yet.
      const beforeEdit = await ctx
        .http()
        .patch(`/projects/${project.id}`)
        .set(bearer(fx.projectOwner.token))
        .send({ description: `creator edit before ${fx.runId}` });
      expect(beforeEdit.status).toBe(403);

      await ctx.prisma.employee.update({
        where: { id: owner.id },
        data: { status: 'INACTIVE' },
      });
      const hard = await hardDelete(owner.id);
      expect(hard.status).toBe(200);

      const after = await ctx.prisma.project.findUnique({
        where: { id: project.id },
      });
      expect(after!.ownerId).toBe(creatorEmployeeId);

      // A membership row is CREATED for them, carrying the owner slug — the
      // second route to owner rights, not merely the `ownerId` pointer.
      const creatorRow = await ctx.prisma.projectMember.findUnique({
        where: {
          projectId_employeeId: {
            projectId: project.id,
            employeeId: creatorEmployeeId,
          },
        },
        include: { projectRole: { select: { slug: true } } },
      });
      expect(creatorRow).toBeTruthy();
      expect(creatorRow!.projectRole!.slug).toBe('owner');

      const afterEdit = await ctx
        .http()
        .patch(`/projects/${project.id}`)
        .set(bearer(fx.projectOwner.token))
        .send({ description: `creator edit after ${fx.runId}` });
      expect(afterEdit.status).toBe(200);

      // The plain survivor is deliberately NOT promoted — still 403, and still
      // a `member`. The repair restores a chain of command; it does not hand
      // one out.
      const bySurvivor = await ctx
        .http()
        .patch(`/projects/${project.id}`)
        .set(bearer(fx.projectMember.token))
        .send({ description: `survivor edit ${fx.runId}` });
      expect(bySurvivor.status).toBe(403);

      const log = await ctx.prisma.auditLog.findFirst({
        where: {
          resourceType: 'Project',
          resourceId: project.id,
          action: 'PROJECT_OWNER_REASSIGNED',
        },
      });
      expect((log!.newData as any).via).toBe('creator');
    });

    /**
     * R12, rule 3 — the branch the deleted twin `PRJ-API-35b` asserted could
     * never happen. It can, and the product owner decided it should: a project
     * with nobody left to inherit accepts a null `ownerId` rather than blocking
     * the delete of a person the business has already decided to erase.
     *
     * That is only defensible because the result is FINDABLE, which is what
     * this case exists to prove. Three affordances, at three distances:
     * `GET /projects/ownerless` for an admin looking on purpose, a
     * `PROJECT_OWNER_ORPHANED` audit row in the project's own activity feed,
     * and a `logger.warn` at the moment it happens. Before the fix the state
     * was reachable only by reading the column.
     */
    it('PRJ-API-35b R12 — with no heir at all the delete still lands, and the ownerless project is discoverable', async () => {
      const owner = await mkEmployee('R12ORPHAN');
      const project = await mkProject('R12OR', {
        ownerId: owner.id,
        // No creator to fall back to — the third rule is the only one left.
        createdById: null,
      });
      const roles = await roleIdsOf(project.id);
      await ctx.prisma.projectMember.create({
        data: {
          projectId: project.id,
          employeeId: owner.id,
          role: 'OWNER',
          roleId: roles.owner,
        },
      });

      await ctx.prisma.employee.update({
        where: { id: owner.id },
        data: { status: 'INACTIVE' },
      });
      const hard = await hardDelete(owner.id);
      expect(hard.status).toBe(200);

      const after = await ctx.prisma.project.findUnique({
        where: { id: project.id },
      });
      expect(after!.ownerId).toBeNull();
      expect(
        await ctx.prisma.projectMember.count({
          where: { projectId: project.id },
        }),
      ).toBe(0);

      // 1. The remediation queue.
      const queue = await get('/projects/ownerless', fx.admin.token);
      expect(queue.status).toBe(200);
      expect(
        (queue.body.data as Array<{ id: string }>).map((p) => p.id),
      ).toContain(project.id);

      // Whole-estate query, so it is ADMIN/HR_MANAGER only.
      const byEmployee = await get('/projects/ownerless', fx.projectMember.token);
      expect(byEmployee.status).toBe(403);

      // 2. The audit row, in the project's own feed.
      const orphanLog = await ctx.prisma.auditLog.findFirst({
        where: {
          resourceType: 'Project',
          resourceId: project.id,
          action: 'PROJECT_OWNER_ORPHANED',
        },
      });
      expect(orphanLog).toBeTruthy();
      expect((orphanLog!.oldData as any).ownerId).toBe(owner.id);
      expect((orphanLog!.newData as any).ownerId).toBeNull();
      expect((orphanLog!.newData as any).via).toBe('none');

      const activity = await get(
        `/projects/${project.id}/activity`,
        fx.admin.token,
      );
      expect(activity.status).toBe(200);
      expect(
        (activity.body.data as Array<{ action: string }>).map((r) => r.action),
      ).toContain('PROJECT_OWNER_ORPHANED');

      // And an ADMIN can put it right through the ordinary door.
      const repaired = await ctx
        .http()
        .patch(`/projects/${project.id}`)
        .set(bearer(fx.admin.token))
        .send({ ownerId: fx.projectOwner.employeeId });
      expect(repaired.status).toBe(200);
      expect(repaired.body.data.ownerId).toBe(fx.projectOwner.employeeId);
    });

    /**
     * R13, COLLAPSED. `PRJ-API-36` asserted the membership row simply vanished
     * with no tombstone, and its `it.failing` twin `PRJ-API-36b` asserted the
     * record should be preserved; both are gone.
     *
     * THE JUDGEMENT, recorded here because the decision left it open. The ROW
     * still cascades. Keeping it would mean making `ProjectMember.employeeId`
     * nullable or adding a tombstone table — a Prisma migration, which is not
     * what this fix is, and which would put a dangling member on every roster,
     * every mention picker and every `_count` in the product. What was actually
     * missing was not the row but the FACT, so the fact is what is now kept: an
     * `AuditLog` row per project naming who left, the role they held and when
     * they had joined. `ProjectsService.getActivity` reads `AuditLog` for
     * `resourceType: 'Project'`, so the departure appears in the project's own
     * activity feed — the same place every other project change appears —
     * instead of the roster silently shrinking overnight.
     */
    it('PRJ-API-36 R13 — the membership row still cascades, but the departure is tombstoned in the activity feed', async () => {
      const leaving = await mkEmployee('R13MEM');
      const staying = await mkEmployee('R13STAY');
      const project = await mkProject('R13', { visibility: 'INTERNAL' });
      const roles = await roleIdsOf(project.id);
      await ctx.prisma.projectMember.createMany({
        data: [
          {
            projectId: project.id,
            employeeId: leaving.id,
            role: 'MANAGER',
            roleId: roles.manager,
            joinedAt: new Date('2023-06-01'),
          },
          {
            projectId: project.id,
            employeeId: staying.id,
            role: 'MEMBER',
            roleId: roles.member,
          },
        ],
      });
      const task = await mkTask(project.id, 'R13', fx.privateStatusIds[0]);
      await ctx.prisma.auditLog.create({
        data: {
          userId: fx.admin.userId,
          action: 'UPDATE',
          resourceType: 'Task',
          resourceId: task.id,
        },
      });

      const before = await get(
        `/projects/${project.id}/members`,
        fx.admin.token,
      );
      expect(before.body.data).toHaveLength(2);

      await ctx.prisma.employee.update({
        where: { id: leaving.id },
        data: { status: 'INACTIVE' },
      });
      const hard = await hardDelete(leaving.id);
      expect(hard.status).toBe(200);

      // The row goes — that part is unchanged, and deliberately so.
      const rows = await ctx.prisma.projectMember.findMany({
        where: { projectId: project.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].employeeId).toBe(staying.id);

      const after = await get(
        `/projects/${project.id}/members`,
        fx.admin.token,
      );
      expect(after.status).toBe(200);
      expect(after.body.data).toHaveLength(1);

      // What is new: the fact survives the row, with enough of the person in it
      // to answer "who was that, and what were they?" after the employee record
      // has gone.
      const tombstone = await ctx.prisma.auditLog.findFirst({
        where: {
          resourceType: 'Project',
          resourceId: project.id,
          action: 'PROJECT_MEMBER_REMOVED',
        },
      });
      expect(tombstone).toBeTruthy();
      const gone = tombstone!.oldData as any;
      expect(gone.employeeId).toBe(leaving.id);
      expect(gone.employeeName).toBe(leaving.fullName);
      expect(gone.employeeCode).toBe(leaving.employeeCode);
      expect(gone.roleSlug).toBe('manager');
      expect(new Date(gone.joinedAt).toISOString()).toBe(
        new Date('2023-06-01').toISOString(),
      );
      expect((tombstone!.newData as any).reason).toBe('EMPLOYEE_HARD_DELETED');

      // The activity feed still renders — the AuditLog row hangs off the USER,
      // not the employee, the task is untouched, and the departure is now one
      // of the entries rather than an unexplained gap in the roster.
      const activity = await get(
        `/projects/${project.id}/activity`,
        fx.admin.token,
      );
      expect(activity.status).toBe(200);
      expect(activity.body.meta.total).toBeGreaterThanOrEqual(2);
      expect(
        (activity.body.data as Array<{ resourceId: string }>).some(
          (r) => r.resourceId === task.id,
        ),
      ).toBe(true);
      expect(
        (activity.body.data as Array<{ action: string }>).map((r) => r.action),
      ).toContain('PROJECT_MEMBER_REMOVED');

      const charts = await get(
        `/projects/${project.slug}/charts`,
        fx.admin.token,
      );
      expect(charts.status).toBe(200);
    });
  });
});
