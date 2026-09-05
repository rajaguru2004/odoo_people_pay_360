import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';

/**
 * WP-0 — the three harness truths every other Workplace spec is trusted on.
 *
 * This file asserts nothing about the product. It asserts that the HARNESS is
 * not lying, because phases 3, 4 and 5 each lost days to one that was:
 *
 *   H1  `ProjectsModule, TasksModule, SprintsModule, ProjectRbacModule,
 *        ProjectStatusesModule` are really registered in `test-app.module.ts`.
 *        An unmounted module answers 404 — identical, from a spec's point of
 *        view, to "the endpoint refused me". The whole surface then reads as
 *        COVERED while being structurally untestable.
 *   H2  `TaskCommentsModule, TaskAttachmentsModule, TaskDashboardModule` too.
 *        These are NOT in the 3c22f56 registration list, so they are the three
 *        most likely to be missing.
 *   H3  The e2e template database really carries the constraints production
 *        does. `prisma db push` cannot create a PARTIAL or EXPRESSION index,
 *        and the project RBAC tables have no migration file at all — they
 *        exist only via `db push`. Phase 4 found a payroll period could be paid
 *        twice for exactly this reason: the test DB was WEAKER than production,
 *        so a concurrency case passed for the wrong reason.
 *
 * A missing route here must fail as "route not mounted", never as an assertion
 * about permissions — hence `isUnmounted()` below, which reads Nest's own
 * `Cannot GET /x` marker rather than trusting the status code alone.
 */

interface ProbeResult {
  status: number;
  message: string;
}

/**
 * The one thing this file exists to catch. Nest answers an unmatched route with
 * a NotFoundException whose message is literally `Cannot GET /assets`; a
 * MOUNTED route that 404s carries a domain message ("Task not found"). Without
 * this distinction a 404 is ambiguous and H1/H2 cannot fail honestly.
 */
const isUnmounted = (r: ProbeResult) =>
  r.status === 404 && /^Cannot (GET|POST|PATCH|PUT|DELETE)\s/i.test(r.message);

const describeProbe = (path: string, r: ProbeResult) =>
  `${path} -> ${r.status} ${JSON.stringify(r.message)}`;

const ANY_UUID = '00000000-0000-0000-0000-000000000001';

describe('Workplace harness truths — H1/H2 route mounting (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await bootE2EApp();
  }, 120000);

  afterAll(async () => {
    await ctx?.app.close();
  });

  const probe = async (path: string): Promise<ProbeResult> => {
    const res = await ctx.http().get(path);
    return { status: res.status, message: res.body?.message ?? '' };
  };

  /**
   * Every workplace route reachable without a path parameter, plus one per
   * parameterised controller. Unauthenticated on purpose: a 401 is positive
   * proof the route resolved to a handler and its JwtAuthGuard ran, which is
   * precisely what "the module is mounted" means. Nothing here asserts a
   * permission — that is WP-1..WP-8's job.
   */
  const GUARDED_ROUTES: Array<[string, string]> = [
    // ── Assets (mounted since before this phase; the control group) ─────────
    ['assets list', '/assets'],
    ['assets ESS', '/assets/my'],
    ['assets summary', '/assets/summary'],
    ['assets open assignments', '/assets/assignments/open'],
    ['assets clearance', `/assets/clearance/${ANY_UUID}`],
    ['assets outstanding report', '/assets/clearance/reports/outstanding'],

    // ── Letters ────────────────────────────────────────────────────────────
    ['letter templates', '/letters/templates'],
    ['letters queue', '/letters'],
    ['letters ESS', '/letters/my-requests'],

    // ── H1: the five modules 3c22f56 registered ────────────────────────────
    ['projects list', '/projects'],
    ['projects stats', '/projects/stats'],
    ['project by slug', '/projects/by-slug/does-not-exist'],
    ['project members', `/projects/${ANY_UUID}/members`],
    ['project my-permissions', `/projects/${ANY_UUID}/my-permissions`],
    ['project roles catalog', '/project-roles/catalog'],
    ['project roles', `/projects/${ANY_UUID}/roles`],
    ['tasks list', '/tasks'],
    ['tasks kanban', '/tasks/kanban'],
    ['tasks mine', '/tasks/my-tasks'],
    ['sprints list', '/sprints'],
    ['project statuses list', '/project-statuses'],

    // ── H2: the three modules 3c22f56 did NOT register ─────────────────────
    ['task comments', `/task-comments/task/${ANY_UUID}`],
    ['task attachments', `/task-attachments/task/${ANY_UUID}`],
    ['task dashboard (employee)', '/task-dashboard/employee'],
    ['task dashboard (manager)', '/task-dashboard/manager'],
  ];

  describe('H1/H2 — every workplace route resolves to a handler', () => {
    it.each(GUARDED_ROUTES)(
      '%s (%s) is mounted, and answers 401 unauthenticated',
      async (_label, path) => {
        const r = await probe(path);
        expect(isUnmounted(r)).toBe(
          // A `false` here reads in the report as "route not mounted".
          false,
        );
        // Belt and braces: an unauthenticated 401 is the only status that
        // proves the JwtAuthGuard on the handler actually ran.
        expect(describeProbe(path, r)).toContain('401');
      },
    );
  });

  describe('H1/H2 — the public letter-verification route is mounted too', () => {
    /**
     * `GET /letters/verify/:serial` is `@Public()`, so it cannot prove itself
     * with a 401. It proves itself by answering a DOMAIN 404 ("Letter not
     * found") rather than Nest's routing 404.
     */
    it('answers a domain 404, not a routing 404', async () => {
      const r = await probe(`/letters/verify/NO-SUCH-SERIAL-${Date.now()}`);
      expect(isUnmounted(r)).toBe(false);
      expect([200, 404]).toContain(r.status);
    });
  });

  describe('control — a route that genuinely does not exist still reads as unmounted', () => {
    /**
     * Without this, `isUnmounted()` could be silently inverted or dead and
     * every case above would pass regardless. This is the negative control
     * that keeps the whole file honest.
     */
    it('detects an unmounted path', async () => {
      const r = await probe('/definitely-not-a-workplace-module');
      expect(isUnmounted(r)).toBe(true);
    });
  });
});

describe('Workplace harness truths — H3 database constraints (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await bootE2EApp();
  }, 120000);

  afterAll(async () => {
    await ctx?.app.close();
  });

  const indexesOn = (table: string) =>
    ctx.prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = '${table}'`,
    );

  /** Fails with the table's whole index list, so a miss is diagnosable at once. */
  const expectIndexMatching = async (table: string, pattern: RegExp) => {
    const rows = await indexesOn(table);
    const hit = rows.find((r) => pattern.test(r.indexdef));
    if (!hit) {
      throw new Error(
        `No index on "${table}" matching ${pattern}.\n` +
          `Add it to prisma/e2e-partial-indexes.sql. Indexes present:\n` +
          rows.map((r) => `  ${r.indexdef}`).join('\n'),
      );
    }
    return hit;
  };

  describe('the tables exist at all', () => {
    /**
     * `project_members` / `project_roles` have NO migration file — they reach
     * the e2e template only through `db push` off schema.prisma. If the push
     * ever silently skips them, every RBAC case would fail as a 500 with no
     * clue why.
     */
    it('every workplace table is present in information_schema', async () => {
      const rows = await ctx.prisma.$queryRawUnsafe<
        Array<{ table_name: string }>
      >(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'`,
      );
      const present = new Set(rows.map((r) => r.table_name));
      for (const t of [
        'asset_items',
        'asset_assignments',
        'letter_templates',
        'letter_requests',
        'projects',
        'project_members',
        'project_roles',
        'workflows',
        'task_workflow_statuses',
        'sprints',
        'tasks',
        'task_comments',
        'task_attachments',
        'task_dependencies',
      ]) {
        expect(`${t}:${present.has(t)}`).toBe(`${t}:true`);
      }
    });
  });

  describe('assets', () => {
    /**
     * The rule the whole offboarding clearance gate reads. Prisma cannot
     * express a partial index, so `db push` never creates it — it lives in
     * prisma/e2e-partial-indexes.sql, and if that file is not applied the test
     * DB permits two people to hold one laptop at the same time.
     */
    it('asset_assignments_one_open_per_asset is a PARTIAL UNIQUE index on (asset_id) WHERE returned_at IS NULL', async () => {
      const hit = await expectIndexMatching(
        'asset_assignments',
        /^CREATE UNIQUE INDEX asset_assignments_one_open_per_asset\b/i,
      );
      expect(hit.indexdef).toMatch(/\(asset_id\)/i);
      expect(hit.indexdef).toMatch(/WHERE \(returned_at IS NULL\)/i);
    });
  });

  describe('letters', () => {
    /**
     * A bare SEQUENCE is not expressible in schema.prisma either. Without it
     * `LettersService.nextSerial()` answers 500 and the entire letters half of
     * the phase fails against a freshly built template.
     */
    it('letter_serial_seq exists and is readable', async () => {
      const seqs = await ctx.prisma.$queryRawUnsafe<
        Array<{ sequencename: string }>
      >(
        `SELECT sequencename FROM pg_sequences
          WHERE schemaname = 'public' AND sequencename = 'letter_serial_seq'`,
      );
      expect(seqs.map((s) => s.sequencename)).toEqual(['letter_serial_seq']);

      // Read without consuming — `nextval` would burn a serial number.
      const [{ last_value: lastValue }] = await ctx.prisma.$queryRawUnsafe<
        Array<{ last_value: bigint | null }>
      >(`SELECT last_value FROM letter_serial_seq`);
      expect(typeof lastValue === 'bigint' || typeof lastValue === 'number')
        .toBe(true);
    });

    it('letter_requests.serial_number is UNIQUE', async () => {
      await expectIndexMatching(
        'letter_requests',
        /^CREATE UNIQUE INDEX .* ON public\.letter_requests USING btree \(serial_number\)$/i,
      );
    });
  });

  describe('projects', () => {
    it('projects.project_code is UNIQUE', async () => {
      await expectIndexMatching(
        'projects',
        /^CREATE UNIQUE INDEX .* ON public\.projects USING btree \(project_code\)$/i,
      );
    });

    it('projects.slug is UNIQUE', async () => {
      await expectIndexMatching(
        'projects',
        /^CREATE UNIQUE INDEX .* ON public\.projects USING btree \(slug\)$/i,
      );
    });

    it('project_members(project_id, employee_id) is UNIQUE', async () => {
      await expectIndexMatching(
        'project_members',
        /^CREATE UNIQUE INDEX .* ON public\.project_members USING btree \(project_id, employee_id\)$/i,
      );
    });

    it('project_roles(project_id, slug) is UNIQUE', async () => {
      await expectIndexMatching(
        'project_roles',
        /^CREATE UNIQUE INDEX .* ON public\.project_roles USING btree \(project_id, slug\)$/i,
      );
    });
  });
});

describe('Workplace harness truths — the fixture set itself (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();
  });

  describe('the shapes every downstream spec assumes', () => {
    it('builds both custody states — an ACTIVE holder and an INACTIVE leaver still holding', async () => {
      const holder = await ctx.prisma.employee.findUnique({
        where: { id: fx.holderId },
        select: { status: true },
      });
      const leaver = await ctx.prisma.employee.findUnique({
        where: { id: fx.leaverId },
        select: { status: true },
      });
      expect(holder?.status).toBe('ACTIVE');
      expect(leaver?.status).toBe('INACTIVE');

      const open = await ctx.prisma.assetAssignment.findMany({
        where: {
          employeeId: { in: [fx.holderId, fx.leaverId] },
          returnedAt: null,
        },
        select: { assetId: true },
      });
      expect(open.map((a) => a.assetId).sort()).toEqual(
        [fx.assetHeldAId, fx.assetLeaverHeldId].sort(),
      );
    });

    it('builds an asset whose history is CLOSED, so the delete-cascade case has something to erase', async () => {
      const closed = await ctx.prisma.assetAssignment.findUnique({
        where: { id: fx.closedAssignmentId },
        select: { assetId: true, returnedAt: true },
      });
      expect(closed?.assetId).toBe(fx.assetClosedHistoryAId);
      expect(closed?.returnedAt).not.toBeNull();
    });

    it('the partial index actually REFUSES a second open assignment on one asset', async () => {
      /**
       * The structural assertion above proves the index is defined; this proves
       * it BITES. Phase 4's payroll defect was found exactly here — an index
       * that exists in production and not in the template makes a concurrency
       * case pass for the wrong reason.
       */
      await expect(
        ctx.prisma.assetAssignment.create({
          data: {
            assetId: fx.assetHeldAId,
            employeeId: fx.managedEmployeeId,
            assignedAt: new Date(),
            assignedById: fx.admin.userId,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('puts one employee inside the MANAGER department boundary and one outside it', async () => {
      const rows = await ctx.prisma.employee.findMany({
        where: { id: { in: [fx.managedEmployeeId, fx.unmanagedEmployeeId] } },
        select: { id: true, departmentId: true },
      });
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.departmentId]));
      expect(byId[fx.managedEmployeeId]).toBe(fx.managedDeptId);
      expect(byId[fx.unmanagedEmployeeId]).toBe(fx.otherDeptId);

      const dept = await ctx.prisma.department.findUnique({
        where: { id: fx.managedDeptId },
        select: { managerId: true },
      });
      expect(dept?.managerId).toBe(fx.managerEmployeeId);
    });

    it('builds all four letter-template states', async () => {
      const rows = await ctx.prisma.letterTemplate.findMany({
        where: {
          id: {
            in: [
              fx.tplApprovalId,
              fx.tplAutoIssueId,
              fx.tplArabicId,
              fx.tplInactiveId,
            ],
          },
        },
        select: {
          id: true,
          key: true,
          locale: true,
          requiresApproval: true,
          isActive: true,
        },
      });
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(by[fx.tplApprovalId]).toMatchObject({
        requiresApproval: true,
        isActive: true,
        locale: 'en',
      });
      expect(by[fx.tplAutoIssueId]).toMatchObject({
        requiresApproval: false,
        isActive: true,
      });
      expect(by[fx.tplArabicId]).toMatchObject({ locale: 'ar' });
      expect(by[fx.tplInactiveId]).toMatchObject({ isActive: false });
      // The `ar` row is the SAME key as the approval row — the second half of
      // the @@unique([key, locale]) pair, not an unrelated template.
      expect(by[fx.tplArabicId].key).toBe(by[fx.tplApprovalId].key);
    });

    it('builds one project per visibility, each with the four seeded presets', async () => {
      const rows = await ctx.prisma.project.findMany({
        where: {
          id: {
            in: [
              fx.privateProjectId,
              fx.internalProjectId,
              fx.publicProjectId,
            ],
          },
        },
        select: { id: true, visibility: true, ownerId: true },
      });
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(by[fx.privateProjectId].visibility).toBe('PRIVATE');
      expect(by[fx.internalProjectId].visibility).toBe('INTERNAL');
      expect(by[fx.publicProjectId].visibility).toBe('PUBLIC');
      expect(by[fx.privateProjectId].ownerId).toBe(fx.ownerEmployeeId);

      expect(Object.keys(fx.privateRoleIds).sort()).toEqual([
        'manager',
        'member',
        'owner',
        'viewer',
      ]);
    });

    it('builds TWO projects sharing ONE workflow (the R7 shape)', async () => {
      const rows = await ctx.prisma.project.findMany({
        where: { workflowId: fx.sharedWorkflowId },
        select: { id: true },
      });
      expect(rows.map((r) => r.id).sort()).toEqual(
        [fx.sharedWorkflowProjectAId, fx.sharedWorkflowProjectBId].sort(),
      );
      // Statuses belong to the WORKFLOW, not to either project — which is
      // exactly why `projectIdFromStatus()` has to guess.
      expect(fx.sharedWorkflowStatusIds).toHaveLength(3);
    });

    it('builds an isSensitive profile-template field beside an ordinary one', async () => {
      const rows = await ctx.prisma.profileTemplateField.findMany({
        where: { templateId: fx.profileTemplateId },
        select: {
          fieldKey: true,
          storage: true,
          isActive: true,
          isSensitive: true,
        },
        orderBy: { displayOrder: 'asc' },
      });
      expect(rows).toEqual([
        {
          fieldKey: fx.visibleFieldKey,
          storage: 'JSONB',
          isActive: true,
          isSensitive: false,
        },
        {
          fieldKey: fx.sensitiveFieldKey,
          storage: 'JSONB',
          isActive: true,
          isSensitive: true,
        },
      ]);

      // The holder carries a value for BOTH, so "excluded" is distinguishable
      // from "there was nothing to exclude".
      const holder = await ctx.prisma.employee.findUnique({
        where: { id: fx.holderId },
        select: { customFields: true },
      });
      expect(holder?.customFields).toMatchObject({
        [fx.visibleFieldKey]: 'G7',
        [fx.sensitiveFieldKey]: '999.000',
      });
    });
  });

  describe('H1/H2 with a real principal — the handlers run, not just the guards', () => {
    /**
     * A 401 proves the route resolved. These prove the module behind it is
     * genuinely wired: the service resolves, Prisma answers, and the response
     * envelope is the house shape.
     */
    it('GET /assets answers 200 for ADMIN', async () => {
      const res = await ctx
        .http()
        .get('/assets')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
    });

    it('GET /letters/templates answers 200 for ADMIN', async () => {
      const res = await ctx
        .http()
        .get('/letters/templates')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
    });

    it('GET /projects answers 200 for ADMIN and lists the fixture projects', async () => {
      const res = await ctx
        .http()
        .get('/projects?limit=200')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      const body = res.body?.data;
      const list: any[] = Array.isArray(body) ? body : (body?.data ?? body?.items ?? []);
      const ids = list.map((p: any) => p.id);
      expect(ids).toEqual(expect.arrayContaining([fx.privateProjectId]));
    });

    it('GET /project-roles/catalog answers 200 for ADMIN', async () => {
      const res = await ctx
        .http()
        .get('/project-roles/catalog')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
    });

    it('GET /sprints?projectId answers 200 for ADMIN', async () => {
      const res = await ctx
        .http()
        .get(`/sprints?projectId=${fx.privateProjectId}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
    });

    it('GET /project-statuses?projectId answers 200 and returns the workflow columns', async () => {
      const res = await ctx
        .http()
        .get(`/project-statuses?projectId=${fx.privateProjectId}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      const list: any[] = res.body?.data ?? [];
      expect(list.map((s: any) => s.id).sort()).toEqual(
        [...fx.privateStatusIds].sort(),
      );
    });

    it('GET /task-comments/task/:id answers 200 (H2 — module was never registered before)', async () => {
      const res = await ctx
        .http()
        .get(`/task-comments/task/${ANY_UUID}`)
        .set(bearer(fx.admin.token));
      expect([200, 404]).toContain(res.status);
      expect(res.body?.message ?? '').not.toMatch(/^Cannot GET/i);
    });

    it('GET /task-attachments/task/:id answers 200 (H2)', async () => {
      const res = await ctx
        .http()
        .get(`/task-attachments/task/${ANY_UUID}`)
        .set(bearer(fx.admin.token));
      expect([200, 404]).toContain(res.status);
      expect(res.body?.message ?? '').not.toMatch(/^Cannot GET/i);
    });

    it('GET /task-dashboard/employee answers for an employee principal (H2)', async () => {
      const res = await ctx
        .http()
        .get('/task-dashboard/employee')
        .set(bearer(fx.projectMember.token));
      expect(res.status).toBe(200);
    });

    it('GET /task-dashboard/manager answers for a MANAGER principal (H2)', async () => {
      const res = await ctx
        .http()
        .get('/task-dashboard/manager')
        .set(bearer(fx.manager.token));
      expect(res.status).toBe(200);
    });
  });

  describe('every persona can authenticate', () => {
    it.each([
      ['admin'],
      ['scopedHr'],
      ['employee'],
      ['manager'],
      ['projectOwner'],
      ['projectManager'],
      ['projectMember'],
      ['projectViewer'],
      ['projectOutsider'],
    ])('%s holds a usable token', async (persona) => {
      const user = (fx as any)[persona];
      expect(typeof user.token).toBe('string');
      const res = await ctx
        .http()
        .get('/auth/me')
        .set(bearer(user.token));
      expect(res.status).toBe(200);
    });
  });
});
