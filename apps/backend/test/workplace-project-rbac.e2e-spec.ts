import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';
import { presetRolesCreateData } from '../src/projects/rbac/permissions.constants';

/**
 * WP-5 — Project-scoped RBAC, end to end.
 *
 * This file is the heart of the Projects module: `ProjectPermissionGuard` plus
 * `ProjectAccessService` decide every write in `projects`, `tasks`, `sprints`
 * and `project-statuses`. Nothing below re-reads `permissions.constants.ts` and
 * nothing below trusts `GET /projects/:id/my-permissions` — a permission is
 * proved by an HTTP request that either performs the operation or is refused.
 * `my-permissions` is the thing under test's own opinion of itself; taking it as
 * the oracle would make the whole grid self-certifying.
 *
 * What it covers:
 *
 *  1. The plan's §6.2 grid, LIVE — 12 permissions × 5 principals (owner,
 *     manager preset, member, viewer, outsider), one real request per cell.
 *     The **manager preset had no coverage at all** before this file; it is the
 *     single biggest hole in the module and three of its seven cells turn out
 *     not to work.
 *  2. The `GLOBAL_ADMIN_ROLES` bypass for ADMIN **and** HR_MANAGER, neither of
 *     which is a member of anything.
 *  3. Both owner-resolution paths in `getAccess()` — `project.ownerId ===
 *     employeeId` and `roleSlug === 'owner'` — proved independently, because a
 *     project can have either without the other.
 *  4. All seven `ProjectIdSource` resolutions. Each is a different way the
 *     guard finds the project it is protecting; a source that resolves to
 *     `null` fails open into "Project context could not be resolved", so each
 *     needs its own proof that it genuinely gates.
 *  5. The `meta.permissions.length === 0` branch (`@RequireProjectMembership`).
 *  6. Custom roles end to end: arbitrary subsets, `copyFromRoleId`, live effect
 *     of an update on the NEXT request, DTO rejection, in-use and `isSystem`
 *     delete refusals, slug collision under `@@unique([projectId, slug])`.
 *  7. The authorisation findings this phase raised, now fixed and locked here
 *     as regressions (each pin and its `it.failing` twin collapsed into ONE
 *     case asserting the correct behaviour, with the defect recorded in a
 *     comment — `docs/TESTING.md` §"Recorded defects"):
 *       R41 `TasksService.assign()`/`remove()` re-checked the GLOBAL role after
 *           the guard had granted the project permission, so the `manager`
 *           preset could not use the TASK_ASSIGN / TASK_DELETE it ships with
 *           (PRJ-API-40g/40i, 49e/49f).
 *       R42 the project OWNER was 403 editing a task they did not report, while
 *           a manager-preset EMPLOYEE edited the same task 200 (PRJ-API-49c/d).
 *       R43 the `member` preset's TASK_STATUS_UPDATE was "your own tasks", not
 *           the board-wide capability the catalogue describes (PRJ-API-49a/b).
 *       R11 `ProjectRolesService.update()` silently discarded a permission
 *           change to the owner role while answering 200 (PRJ-API-46a).
 *       R21 `task-comments` / `task-attachments` / `labels` carried no
 *           `ProjectPermissionGuard` at all (PRJ-API-50b–f).
 *     Still pinned, with its twin, because the fix is a product decision:
 *       R7  `projectIdFromStatus()` resolves through a SHARED workflow to an
 *           arbitrary project — a STATUS_MANAGE grant on one project mutates
 *           another project's board.
 *
 * Every row this file writes is tagged with the fixture `runId`; assertions are
 * filtered to it. Sibling Workplace specs write to the same database.
 *
 * NOT here (owned by siblings, deliberately): project CRUD/visibility/members
 * (`workplace-project-core`), the task and comment/attachment CRUD surface
 * (`workplace-task`), sprint and workflow-status behaviour
 * (`workplace-sprint-workflow`). This file only ever asks "was the principal
 * allowed?".
 */

const ALLOW = 'allow';
const DENY = 'deny';

describe('WP-5 Project RBAC — the permission grid, live (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;

  /** Short, collision-free tag for VarChar(20) columns (taskCode, projectCode). */
  let short: string;
  let codePrefix: string;
  let seq = 0;
  const uniq = () => `${short}${(seq += 1)}`;

  /** Everything this file creates outside the fixture set, for teardown. */
  const createdProjectIds: string[] = [];

  // ── Low-level helpers ──────────────────────────────────────────────────────

  const H = () => ctx.http();

  /**
   * A task the principal both REPORTS and is ASSIGNED to.
   *
   * `TasksService.assertUpdateAccess()` narrows edits/status changes to the
   * reporter or the assignee on top of whatever the guard already allowed, so a
   * task belonging to somebody else would confound "the permission was denied"
   * with "the task was not yours". The grid rows below are about the guard;
   * PRJ-API-49 is where the narrowing itself is asserted.
   */
  async function mkTask(
    projectId: string,
    employeeId: string,
    label: string,
    statusId?: string | null,
  ): Promise<string> {
    const t = await ctx.prisma.task.create({
      data: {
        taskCode: `${codePrefix}${(seq += 1)}`.slice(0, 20),
        title: `rbac ${label} ${fx.runId}`,
        projectId,
        statusId: statusId === undefined ? fx.privateStatusIds[0] : statusId,
        reporterId: employeeId,
        assignees: { connect: [{ id: employeeId }] },
      },
      select: { id: true },
    });
    return t.id;
  }

  /**
   * A throwaway PRIVATE project carrying the same four preset roles and the
   * same four members as the fixture PRIVATE project.
   *
   * `workflowId` is deliberately NULL. Every disposable project sharing the
   * fixture workflow would make `projectIdFromStatus()` — which resolves a
   * status to *an arbitrary project using that workflow* — non-deterministic,
   * and PRJ-API-45f/g and PRJ-API-41 depend on it being deterministic.
   */
  async function mkDisposableProject(tag: string) {
    const p = await ctx.prisma.project.create({
      data: {
        projectCode: `R${short}${tag}`.slice(0, 20),
        name: `RBAC ${tag} ${fx.runId}`,
        slug: `rbac-${tag}-${fx.runId}`.toLowerCase(),
        taskPrefix: 'RB',
        visibility: 'PRIVATE',
        status: 'ACTIVE',
        priority: 'MEDIUM',
        ownerId: fx.ownerEmployeeId,
        roles: { create: presetRolesCreateData() },
      },
      select: { id: true, slug: true },
    });
    createdProjectIds.push(p.id);

    const roles = await ctx.prisma.projectRole.findMany({
      where: { projectId: p.id },
      select: { id: true, slug: true },
    });
    const bySlug: Record<string, string> = {};
    for (const r of roles) bySlug[r.slug] = r.id;

    await ctx.prisma.projectMember.createMany({
      data: [
        {
          projectId: p.id,
          employeeId: fx.ownerEmployeeId,
          role: 'OWNER',
          roleId: bySlug.owner,
        },
        {
          projectId: p.id,
          employeeId: fx.managerPresetEmployeeId,
          role: 'MANAGER',
          roleId: bySlug.manager,
        },
        {
          projectId: p.id,
          employeeId: fx.memberEmployeeId,
          role: 'MEMBER',
          roleId: bySlug.member,
        },
        {
          projectId: p.id,
          employeeId: fx.viewerEmployeeId,
          role: 'VIEWER',
          roleId: bySlug.viewer,
        },
      ],
    });

    return { id: p.id, slug: p.slug, roleIds: bySlug };
  }

  // ── One callable per permission ────────────────────────────────────────────
  // Each performs the single canonical operation that permission gates, so a
  // status code IS the cell. Payloads are unique per call: `project_roles`,
  // `sprints` and `task_workflow_statuses` all carry uniqueness constraints that
  // would otherwise turn a permitted request into a 409/500 and read as a denial.

  const st = (r: { status: number }) => r.status;

  const projectEdit = async (token: string, projectId: string) =>
    st(
      await H()
        .patch(`/projects/${projectId}`)
        .set(bearer(token))
        .send({ description: `edited ${uniq()}` }),
    );

  const projectArchive = async (token: string, projectId: string) =>
    st(await H().post(`/projects/${projectId}/archive`).set(bearer(token)).send({}));

  const projectUnarchive = async (token: string, projectId: string) =>
    st(
      await H().post(`/projects/${projectId}/unarchive`).set(bearer(token)).send({}),
    );

  const projectDelete = async (token: string, projectId: string) =>
    st(await H().delete(`/projects/${projectId}`).set(bearer(token)));

  const memberManage = async (token: string, projectId: string) =>
    st(
      await H()
        .post(`/projects/${projectId}/members`)
        .set(bearer(token))
        .send({ employeeId: fx.managedEmployeeId, role: 'viewer' }),
    );

  const roleManage = async (token: string, projectId: string) =>
    st(
      await H()
        .post(`/projects/${projectId}/roles`)
        .set(bearer(token))
        .send({ name: `Role ${uniq()}` }),
    );

  const taskCreate = async (token: string, projectId: string) =>
    st(
      await H()
        .post('/tasks')
        .set(bearer(token))
        .send({ projectId, title: `grid task ${uniq()}` }),
    );

  const taskAssign = async (token: string, taskId: string, assigneeId: string) =>
    st(
      await H()
        .post(`/tasks/${taskId}/assign`)
        .set(bearer(token))
        .send({ assigneeId }),
    );

  const taskEdit = async (token: string, taskId: string) =>
    st(
      await H()
        .patch(`/tasks/${taskId}`)
        .set(bearer(token))
        .send({ title: `edited ${uniq()}` }),
    );

  const taskDelete = async (token: string, taskId: string) =>
    st(await H().delete(`/tasks/${taskId}`).set(bearer(token)));

  const taskStatusUpdate = async (token: string, taskId: string) =>
    st(
      await H()
        .post(`/tasks/${taskId}/status`)
        .set(bearer(token))
        .send({ status: 'IN_PROGRESS' }),
    );

  const sprintManage = async (token: string, projectId: string) =>
    st(
      await H()
        .post('/sprints')
        .set(bearer(token))
        .send({ projectId, name: `Sprint ${uniq()}` }),
    );

  const statusManage = async (token: string, projectId: string) =>
    st(
      await H()
        .post('/project-statuses')
        .set(bearer(token))
        .send({ projectId, name: `Col ${uniq()}` }),
    );

  /** Verdict form, so an unexpected 400/404/500 cannot masquerade as a denial. */
  const verdict = (status: number) => {
    if (status >= 200 && status < 300) return ALLOW;
    if (status === 403) return DENY;
    return `unexpected ${status}`;
  };

  // ── Setup / teardown ───────────────────────────────────────────────────────

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);
    short = fx.runId.slice(-8);
    codePrefix = `T${short}`;

    // The base plain EMPLOYEE is this file's "clean principal": a member of
    // nothing, with no global role that could mask a project permission.
    expect(fx.employee.employeeId).toBeTruthy();
  }, 180000);

  afterAll(async () => {
    if (ctx?.prisma) {
      const mine = { task: { taskCode: { startsWith: codePrefix } } };
      await ctx.prisma.taskActivity.deleteMany({ where: mine });
      await ctx.prisma.taskComment.deleteMany({ where: mine });
      await ctx.prisma.taskAttachment.deleteMany({ where: mine });
      await ctx.prisma.task.deleteMany({
        where: { taskCode: { startsWith: codePrefix } },
      });
      if (createdProjectIds.length) {
        await ctx.prisma.task.deleteMany({
          where: { projectId: { in: createdProjectIds } },
        });
        await ctx.prisma.sprint.deleteMany({
          where: { projectId: { in: createdProjectIds } },
        });
        await ctx.prisma.projectMember.deleteMany({
          where: { projectId: { in: createdProjectIds } },
        });
        await ctx.prisma.projectRole.deleteMany({
          where: { projectId: { in: createdProjectIds } },
        });
        await ctx.prisma.project.deleteMany({
          where: { id: { in: createdProjectIds } },
        });
      }
    }
    await fx?.cleanup();
    await ctx?.app.close();
  }, 180000);

  // ═══════════════════════════════════════════════════════════════════════════
  // PRJ-API-40 — the §6.2 grid, one live request per cell
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PRJ-API-40 — 12 permissions × 5 principals, live', () => {
    it('PRJ-API-40a PROJECT_EDIT — owner only', async () => {
      const p = fx.privateProjectId;
      expect(verdict(await projectEdit(fx.projectOwner.token, p))).toBe(ALLOW);
      expect(verdict(await projectEdit(fx.projectManager.token, p))).toBe(DENY);
      expect(verdict(await projectEdit(fx.projectMember.token, p))).toBe(DENY);
      expect(verdict(await projectEdit(fx.projectViewer.token, p))).toBe(DENY);
      expect(verdict(await projectEdit(fx.projectOutsider.token, p))).toBe(DENY);
    });

    it('PRJ-API-40b PROJECT_ARCHIVE — owner only, and the archive is real', async () => {
      const p = fx.privateProjectId;
      expect(verdict(await projectArchive(fx.projectManager.token, p))).toBe(DENY);
      expect(verdict(await projectArchive(fx.projectMember.token, p))).toBe(DENY);
      expect(verdict(await projectArchive(fx.projectViewer.token, p))).toBe(DENY);
      expect(verdict(await projectArchive(fx.projectOutsider.token, p))).toBe(DENY);
      expect(verdict(await projectArchive(fx.projectOwner.token, p))).toBe(ALLOW);

      // A 201 that changed nothing would pass the cell for the wrong reason.
      const archived = await ctx.prisma.project.findUnique({
        where: { id: p },
        select: { isArchived: true },
      });
      expect(archived?.isArchived).toBe(true);

      expect(verdict(await projectUnarchive(fx.projectOwner.token, p))).toBe(ALLOW);
      const restored = await ctx.prisma.project.findUnique({
        where: { id: p },
        select: { isArchived: true },
      });
      expect(restored?.isArchived).toBe(false);
    });

    it('PRJ-API-40c PROJECT_DELETE — owner only, on a fresh project per principal', async () => {
      // Soft-delete is terminal for the row it hits, so each principal gets its
      // own project. Sharing one would make every attempt after the first read
      // 404 "Project not found" instead of the permission answer.
      const mgr = await mkDisposableProject(`d${uniq()}`);
      const mem = await mkDisposableProject(`d${uniq()}`);
      const vwr = await mkDisposableProject(`d${uniq()}`);
      const out = await mkDisposableProject(`d${uniq()}`);
      const own = await mkDisposableProject(`d${uniq()}`);

      expect(verdict(await projectDelete(fx.projectManager.token, mgr.id))).toBe(DENY);
      expect(verdict(await projectDelete(fx.projectMember.token, mem.id))).toBe(DENY);
      expect(verdict(await projectDelete(fx.projectViewer.token, vwr.id))).toBe(DENY);
      expect(verdict(await projectDelete(fx.projectOutsider.token, out.id))).toBe(DENY);
      expect(verdict(await projectDelete(fx.projectOwner.token, own.id))).toBe(ALLOW);

      const rows = await ctx.prisma.project.findMany({
        where: { id: { in: [mgr.id, own.id] } },
        select: { id: true, deletedAt: true },
      });
      expect(rows.find((r) => r.id === own.id)?.deletedAt).not.toBeNull();
      expect(rows.find((r) => r.id === mgr.id)?.deletedAt).toBeNull();
    });

    it('PRJ-API-40d MEMBER_MANAGE — owner only', async () => {
      const p = fx.privateProjectId;
      expect(verdict(await memberManage(fx.projectManager.token, p))).toBe(DENY);
      expect(verdict(await memberManage(fx.projectMember.token, p))).toBe(DENY);
      expect(verdict(await memberManage(fx.projectViewer.token, p))).toBe(DENY);
      expect(verdict(await memberManage(fx.projectOutsider.token, p))).toBe(DENY);
      expect(verdict(await memberManage(fx.projectOwner.token, p))).toBe(ALLOW);

      const added = await ctx.prisma.projectMember.findFirst({
        where: { projectId: p, employeeId: fx.managedEmployeeId },
        select: { id: true },
      });
      expect(added).not.toBeNull();
      await ctx.prisma.projectMember.deleteMany({
        where: { projectId: p, employeeId: fx.managedEmployeeId },
      });
    });

    it('PRJ-API-40e ROLE_MANAGE — owner only', async () => {
      const p = fx.privateProjectId;
      expect(verdict(await roleManage(fx.projectManager.token, p))).toBe(DENY);
      expect(verdict(await roleManage(fx.projectMember.token, p))).toBe(DENY);
      expect(verdict(await roleManage(fx.projectViewer.token, p))).toBe(DENY);
      expect(verdict(await roleManage(fx.projectOutsider.token, p))).toBe(DENY);
      expect(verdict(await roleManage(fx.projectOwner.token, p))).toBe(ALLOW);
    });

    it('PRJ-API-40f TASK_CREATE — owner and manager preset', async () => {
      const p = fx.privateProjectId;
      expect(verdict(await taskCreate(fx.projectOwner.token, p))).toBe(ALLOW);
      expect(verdict(await taskCreate(fx.projectManager.token, p))).toBe(ALLOW);
      expect(verdict(await taskCreate(fx.projectMember.token, p))).toBe(DENY);
      expect(verdict(await taskCreate(fx.projectViewer.token, p))).toBe(DENY);
      expect(verdict(await taskCreate(fx.projectOutsider.token, p))).toBe(DENY);
    });

    it('PRJ-API-40g TASK_ASSIGN — owner and manager preset', async () => {
      const p = fx.privateProjectId;
      const forOwner = await mkTask(p, fx.ownerEmployeeId, 'assign-owner');
      const forMgr = await mkTask(p, fx.managerPresetEmployeeId, 'assign-mgr');
      const forMem = await mkTask(p, fx.memberEmployeeId, 'assign-mem');
      const forVwr = await mkTask(p, fx.viewerEmployeeId, 'assign-vwr');
      const forOut = await mkTask(p, fx.outsiderEmployeeId, 'assign-out');
      const target = fx.managedEmployeeId;

      expect(verdict(await taskAssign(fx.projectOwner.token, forOwner, target))).toBe(ALLOW);

      // REGRESSION LOCK — finding R41, fixed. The guard admitted the request
      // (the manager preset really does carry TASK_ASSIGN) and then
      // `TasksService.assign()` re-checked the GLOBAL role and refused anyone
      // who was not ADMIN / HR_MANAGER / MANAGER. The preset is a project role
      // held by an EMPLOYEE, so one of the twelve catalogued permissions was
      // 403 always. The redundant re-check is gone; the guard decides.
      expect(verdict(await taskAssign(fx.projectManager.token, forMgr, target))).toBe(ALLOW);

      // The neighbouring cells still refuse — the widening is exactly the one
      // cell §4 marks ✓, and nothing else moved.
      expect(verdict(await taskAssign(fx.projectMember.token, forMem, target))).toBe(DENY);
      expect(verdict(await taskAssign(fx.projectViewer.token, forVwr, target))).toBe(DENY);
      expect(verdict(await taskAssign(fx.projectOutsider.token, forOut, target))).toBe(DENY);
    });

    it('PRJ-API-40h TASK_EDIT — owner and manager preset', async () => {
      const p = fx.privateProjectId;
      const forOwner = await mkTask(p, fx.ownerEmployeeId, 'edit-owner');
      const forMgr = await mkTask(p, fx.managerPresetEmployeeId, 'edit-mgr');
      const forMem = await mkTask(p, fx.memberEmployeeId, 'edit-mem');
      const forVwr = await mkTask(p, fx.viewerEmployeeId, 'edit-vwr');
      const forOut = await mkTask(p, fx.outsiderEmployeeId, 'edit-out');

      expect(verdict(await taskEdit(fx.projectOwner.token, forOwner))).toBe(ALLOW);
      expect(verdict(await taskEdit(fx.projectManager.token, forMgr))).toBe(ALLOW);
      expect(verdict(await taskEdit(fx.projectMember.token, forMem))).toBe(DENY);
      expect(verdict(await taskEdit(fx.projectViewer.token, forVwr))).toBe(DENY);
      expect(verdict(await taskEdit(fx.projectOutsider.token, forOut))).toBe(DENY);
    });

    it('PRJ-API-40i TASK_DELETE — owner and manager preset', async () => {
      const p = fx.privateProjectId;
      const forOwner = await mkTask(p, fx.ownerEmployeeId, 'del-owner');
      const forMgr = await mkTask(p, fx.managerPresetEmployeeId, 'del-mgr');
      const forMem = await mkTask(p, fx.memberEmployeeId, 'del-mem');
      const forVwr = await mkTask(p, fx.viewerEmployeeId, 'del-vwr');
      const forOut = await mkTask(p, fx.outsiderEmployeeId, 'del-out');

      expect(verdict(await taskDelete(fx.projectOwner.token, forOwner))).toBe(ALLOW);

      // REGRESSION LOCK — finding R41, fixed. Same shape as PRJ-API-40g:
      // `TasksService.remove()` demanded a global ADMIN/HR_MANAGER/MANAGER role
      // after the guard had already granted the project permission.
      expect(verdict(await taskDelete(fx.projectManager.token, forMgr))).toBe(ALLOW);

      expect(verdict(await taskDelete(fx.projectMember.token, forMem))).toBe(DENY);
      expect(verdict(await taskDelete(fx.projectViewer.token, forVwr))).toBe(DENY);
      expect(verdict(await taskDelete(fx.projectOutsider.token, forOut))).toBe(DENY);

      // Both allowed deletes really happened, and both refused ones did not —
      // an ALLOW that changed nothing would pass the cell for the wrong reason.
      const rows = await ctx.prisma.task.findMany({
        where: { id: { in: [forOwner, forMgr, forMem, forVwr, forOut] } },
        select: { id: true, deletedAt: true },
      });
      const deletedAt = (id: string) =>
        rows.find((r) => r.id === id)?.deletedAt ?? null;
      expect(deletedAt(forOwner)).not.toBeNull();
      expect(deletedAt(forMgr)).not.toBeNull();
      expect(deletedAt(forMem)).toBeNull();
      expect(deletedAt(forVwr)).toBeNull();
      expect(deletedAt(forOut)).toBeNull();
    });

    it('PRJ-API-40j TASK_STATUS_UPDATE — owner, manager preset and member', async () => {
      const p = fx.privateProjectId;
      const forOwner = await mkTask(p, fx.ownerEmployeeId, 'st-owner');
      const forMgr = await mkTask(p, fx.managerPresetEmployeeId, 'st-mgr');
      const forMem = await mkTask(p, fx.memberEmployeeId, 'st-mem');
      const forVwr = await mkTask(p, fx.viewerEmployeeId, 'st-vwr');
      const forOut = await mkTask(p, fx.outsiderEmployeeId, 'st-out');

      expect(verdict(await taskStatusUpdate(fx.projectOwner.token, forOwner))).toBe(ALLOW);
      expect(verdict(await taskStatusUpdate(fx.projectManager.token, forMgr))).toBe(ALLOW);
      expect(verdict(await taskStatusUpdate(fx.projectMember.token, forMem))).toBe(ALLOW);
      expect(verdict(await taskStatusUpdate(fx.projectViewer.token, forVwr))).toBe(DENY);
      expect(verdict(await taskStatusUpdate(fx.projectOutsider.token, forOut))).toBe(DENY);
    });

    it('PRJ-API-40k SPRINT_MANAGE — owner and manager preset', async () => {
      const p = fx.privateProjectId;
      expect(verdict(await sprintManage(fx.projectOwner.token, p))).toBe(ALLOW);
      expect(verdict(await sprintManage(fx.projectManager.token, p))).toBe(ALLOW);
      expect(verdict(await sprintManage(fx.projectMember.token, p))).toBe(DENY);
      expect(verdict(await sprintManage(fx.projectViewer.token, p))).toBe(DENY);
      expect(verdict(await sprintManage(fx.projectOutsider.token, p))).toBe(DENY);
    });

    it('PRJ-API-40l STATUS_MANAGE — owner and manager preset', async () => {
      const p = fx.privateProjectId;
      expect(verdict(await statusManage(fx.projectOwner.token, p))).toBe(ALLOW);
      expect(verdict(await statusManage(fx.projectManager.token, p))).toBe(ALLOW);
      expect(verdict(await statusManage(fx.projectMember.token, p))).toBe(DENY);
      expect(verdict(await statusManage(fx.projectViewer.token, p))).toBe(DENY);
      expect(verdict(await statusManage(fx.projectOutsider.token, p))).toBe(DENY);
    });

    it('PRJ-API-40m read the project — every member, and the outsider refused', async () => {
      const p = fx.privateProjectId;
      const read = async (token: string) =>
        st(await H().get(`/projects/${p}`).set(bearer(token)));

      expect(verdict(await read(fx.projectOwner.token))).toBe(ALLOW);
      expect(verdict(await read(fx.projectManager.token))).toBe(ALLOW);
      expect(verdict(await read(fx.projectMember.token))).toBe(ALLOW);
      expect(verdict(await read(fx.projectViewer.token))).toBe(ALLOW);
      expect(verdict(await read(fx.projectOutsider.token))).toBe(DENY);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRJ-API-42 / 43 — GLOBAL_ADMIN_ROLES bypass
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PRJ-API-42/43 — global admin bypass, members of nothing', () => {
    /**
     * `getAccess()` short-circuits on `GLOBAL_ADMIN_ROLES.includes(user.role)`
     * BEFORE it looks at `ProjectMember` at all, so the bypass has to hold for a
     * principal with no membership row anywhere. Both cases assert that first.
     */
    const runAllTwelve = async (token: string) => {
      const p = fx.privateProjectId;
      const disposable = await mkDisposableProject(`g${uniq()}`);
      const own = await mkTask(p, fx.holderId, 'bypass');
      const forDelete = await mkTask(p, fx.holderId, 'bypass-del');

      return {
        PROJECT_EDIT: verdict(await projectEdit(token, p)),
        PROJECT_ARCHIVE: verdict(await projectArchive(token, p)),
        PROJECT_DELETE: verdict(await projectDelete(token, disposable.id)),
        MEMBER_MANAGE: verdict(await memberManage(token, p)),
        ROLE_MANAGE: verdict(await roleManage(token, p)),
        TASK_CREATE: verdict(await taskCreate(token, p)),
        TASK_ASSIGN: verdict(await taskAssign(token, own, fx.managedEmployeeId)),
        TASK_EDIT: verdict(await taskEdit(token, own)),
        TASK_STATUS_UPDATE: verdict(await taskStatusUpdate(token, own)),
        TASK_DELETE: verdict(await taskDelete(token, forDelete)),
        SPRINT_MANAGE: verdict(await sprintManage(token, p)),
        STATUS_MANAGE: verdict(await statusManage(token, p)),
        _unarchive: verdict(await projectUnarchive(token, p)),
      };
    };

    const allAllowed = (row: Record<string, string>) =>
      Object.entries(row)
        .filter(([, v]) => v !== ALLOW)
        .map(([k, v]) => `${k}=${v}`);

    it('PRJ-API-42 ADMIN passes every cell without a membership row', async () => {
      // The global ADMIN has no employee row at all, so `user.employeeId` is
      // null and `getAccess()` could never find a membership even if one
      // existed — the bypass is the ONLY thing that can be carrying these
      // twelve cells.
      expect(fx.admin.employeeId ?? null).toBeNull();

      const row = await runAllTwelve(fx.admin.token);
      expect(allAllowed(row)).toEqual([]);
      await ctx.prisma.projectMember.deleteMany({
        where: { projectId: fx.privateProjectId, employeeId: fx.managedEmployeeId },
      });
    });

    it('PRJ-API-43 HR_MANAGER passes every cell without a membership row', async () => {
      // The half that has never been tested. HR_MANAGER is in
      // GLOBAL_ADMIN_ROLES beside ADMIN, and this HR is branch-scoped — the
      // project tracker has no branch scoping at all, so the scope must not
      // narrow anything here either.
      const memberships = await ctx.prisma.projectMember.count({
        where: { employeeId: fx.scopedHr.employeeId ?? '00000000-0000-0000-0000-000000000000' },
      });
      expect(memberships).toBe(0);

      const row = await runAllTwelve(fx.scopedHr.token);
      expect(allAllowed(row)).toEqual([]);
      await ctx.prisma.projectMember.deleteMany({
        where: { projectId: fx.privateProjectId, employeeId: fx.managedEmployeeId },
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRJ-API-44 — the two owner-resolution paths
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PRJ-API-44 — getAccess() grants owner rights by ownerId OR by role slug', () => {
    it('PRJ-API-44a ownerId alone, with NO membership row at all', async () => {
      // `isOwner = (project.ownerId === employeeId) || roleSlug === 'owner'`.
      // The first disjunct has to stand on its own: a project created by an
      // admin and handed to an employee never gets a member row automatically.
      const p = await ctx.prisma.project.create({
        data: {
          projectCode: `R${short}o${uniq()}`.slice(0, 20),
          name: `RBAC ownerId ${fx.runId}`,
          slug: `rbac-ownerid-${fx.runId}`,
          visibility: 'PRIVATE',
          status: 'ACTIVE',
          priority: 'MEDIUM',
          ownerId: fx.employee.employeeId,
          roles: { create: presetRolesCreateData() },
        },
        select: { id: true },
      });
      createdProjectIds.push(p.id);

      const rows = await ctx.prisma.projectMember.count({ where: { projectId: p.id } });
      expect(rows).toBe(0);

      expect(verdict(await projectEdit(fx.employee.token, p.id))).toBe(ALLOW);
      expect(verdict(await roleManage(fx.employee.token, p.id))).toBe(ALLOW);
      expect(verdict(await sprintManage(fx.employee.token, p.id))).toBe(ALLOW);
      expect(verdict(await projectDelete(fx.employee.token, p.id))).toBe(ALLOW);
    });

    it('PRJ-API-44b the owner-slug role alone, on a project owned by someone else', async () => {
      const p = await mkDisposableProject(`s${uniq()}`);
      // ownerId points at the fixture project owner, NOT at the principal.
      await ctx.prisma.projectMember.create({
        data: {
          projectId: p.id,
          employeeId: fx.employee.employeeId!,
          role: 'OWNER',
          roleId: p.roleIds.owner,
        },
      });

      const row = await ctx.prisma.project.findUnique({
        where: { id: p.id },
        select: { ownerId: true },
      });
      expect(row?.ownerId).toBe(fx.ownerEmployeeId);
      expect(row?.ownerId).not.toBe(fx.employee.employeeId);

      expect(verdict(await projectEdit(fx.employee.token, p.id))).toBe(ALLOW);
      expect(verdict(await roleManage(fx.employee.token, p.id))).toBe(ALLOW);
      expect(verdict(await memberManage(fx.employee.token, p.id))).toBe(ALLOW);

      // Negative control on the same project: the viewer member is refused, so
      // "allowed" above cannot be an artefact of the project being permissive.
      expect(verdict(await projectEdit(fx.projectViewer.token, p.id))).toBe(DENY);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRJ-API-45 — all seven ProjectIdSource resolutions
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PRJ-API-45 — every ProjectIdSource actually gates', () => {
    const NO_SUCH_UUID = '00000000-0000-0000-0000-0000000000ff';

    it("PRJ-API-45a from:'param' — PATCH /projects/:id", async () => {
      expect(verdict(await projectEdit(fx.projectOwner.token, fx.privateProjectId))).toBe(ALLOW);
      expect(verdict(await projectEdit(fx.projectOutsider.token, fx.privateProjectId))).toBe(DENY);

      // A well-formed id for a project that does not exist resolves fine but
      // yields an empty permission set — the guard refuses BEFORE the service
      // could answer 404, so a probe cannot use this route as an oracle.
      const res = await H()
        .patch(`/projects/${NO_SUCH_UUID}`)
        .set(bearer(fx.projectOwner.token))
        .send({ description: 'x' });
      expect(res.status).toBe(403);
    });

    it("PRJ-API-45b from:'paramSlug' — GET /projects/by-slug/:slug", async () => {
      const bySlug = async (token: string, slug: string) =>
        st(await H().get(`/projects/by-slug/${slug}`).set(bearer(token)));

      expect(verdict(await bySlug(fx.projectViewer.token, fx.privateProjectSlug))).toBe(ALLOW);
      expect(verdict(await bySlug(fx.projectOutsider.token, fx.privateProjectSlug))).toBe(DENY);

      // Unknown slug → resolveProjectId returns null → the guard's own
      // "Project context could not be resolved", never a 404.
      const res = await H()
        .get(`/projects/by-slug/no-such-slug-${fx.runId}`)
        .set(bearer(fx.projectOwner.token));
      expect(res.status).toBe(403);
      expect(res.body?.message).toContain('Project context could not be resolved');
    });

    it("PRJ-API-45c from:'body' — POST /tasks reads projectId out of the payload", async () => {
      expect(verdict(await taskCreate(fx.projectManager.token, fx.privateProjectId))).toBe(ALLOW);
      expect(verdict(await taskCreate(fx.projectOutsider.token, fx.privateProjectId))).toBe(DENY);

      // The guard runs before the ValidationPipe, so a body with no projectId
      // is refused for lack of context rather than validated.
      const res = await H()
        .post('/tasks')
        .set(bearer(fx.projectOwner.token))
        .send({ title: `no project ${fx.runId}` });
      expect(res.status).toBe(403);
      expect(res.body?.message).toContain('Project context could not be resolved');
    });

    it("PRJ-API-45d from:'task' — PATCH /tasks/:id resolves through the task row", async () => {
      const mine = await mkTask(fx.privateProjectId, fx.ownerEmployeeId, 'src-task');
      expect(verdict(await taskEdit(fx.projectOwner.token, mine))).toBe(ALLOW);
      expect(verdict(await taskEdit(fx.projectOutsider.token, mine))).toBe(DENY);

      const res = await H()
        .patch(`/tasks/${NO_SUCH_UUID}`)
        .set(bearer(fx.projectOwner.token))
        .send({ title: 'x' });
      expect(res.status).toBe(403);
      expect(res.body?.message).toContain('Project context could not be resolved');
    });

    it("PRJ-API-45e from:'sprint' — PATCH /sprints/:id resolves through the sprint row", async () => {
      const created = await H()
        .post('/sprints')
        .set(bearer(fx.projectOwner.token))
        .send({ projectId: fx.privateProjectId, name: `Src Sprint ${uniq()}` });
      expect(created.status).toBe(201);
      const sprintId = created.body.data.id as string;

      const patch = async (token: string) =>
        st(
          await H()
            .patch(`/sprints/${sprintId}`)
            .set(bearer(token))
            .send({ goal: `goal ${uniq()}` }),
        );

      expect(verdict(await patch(fx.projectManager.token))).toBe(ALLOW);
      expect(verdict(await patch(fx.projectViewer.token))).toBe(DENY);
      expect(verdict(await patch(fx.projectOutsider.token))).toBe(DENY);
    });

    it("PRJ-API-45f from:'status' — PATCH /project-statuses/:id resolves through the workflow", async () => {
      const statusId = fx.privateStatusIds[1];
      const patch = async (token: string) =>
        st(
          await H()
            .patch(`/project-statuses/${statusId}`)
            .set(bearer(token))
            .send({ color: '#123456' }),
        );

      expect(verdict(await patch(fx.projectManager.token))).toBe(ALLOW);
      expect(verdict(await patch(fx.projectMember.token))).toBe(DENY);
      expect(verdict(await patch(fx.projectOutsider.token))).toBe(DENY);
    });

    it("PRJ-API-45g from:'statusItems' — PATCH /project-statuses/reorder reads items[0].id", async () => {
      // The most obscure source: the guard reaches into the reorder PAYLOAD,
      // takes the FIRST element's id, and resolves the whole request from it.
      const ids = fx.privateStatusIds.slice(0, 3);
      const items = ids.map((id, i) => ({ id, position: i }));
      const reorder = async (token: string, body: object) =>
        st(await H().patch('/project-statuses/reorder').set(bearer(token)).send(body));

      expect(verdict(await reorder(fx.projectManager.token, { items }))).toBe(ALLOW);
      expect(verdict(await reorder(fx.projectViewer.token, { items }))).toBe(DENY);
      expect(verdict(await reorder(fx.projectOutsider.token, { items }))).toBe(DENY);

      // A degenerate payload is a PAYLOAD problem, and says so. This used to be
      // finding R33's sharpest instance: guards run before pipes, so `{items:
      // []}` never reached `@IsArray()` and came back as *403 "Project context
      // could not be resolved"* — a permission error on the one route a
      // drag-and-drop client is most likely to post a bad body to, where a typo
      // and a genuine denial were indistinguishable. `project-statuses` now
      // declares a payload guard AHEAD of `ProjectPermissionGuard` that checks
      // only the SHAPE of `items` and answers 400 naming the key.
      const empty = await H()
        .patch('/project-statuses/reorder')
        .set(bearer(fx.projectOwner.token))
        .send({ items: [] });
      expect(empty.status).toBe(400);
      expect(JSON.stringify(empty.body)).toMatch(/items/i);

      // …and the permission guard still gates behind it: a WELL-FORMED payload
      // the caller has no standing on is refused, not reordered. Without this
      // half, a shape check that swallowed the whole route would look like a
      // pass.
      const unauthorised = await H()
        .patch('/project-statuses/reorder')
        .set(bearer(fx.projectOutsider.token))
        .send({ items });
      expect(unauthorised.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRJ-API-47 — @RequireProjectMembership (the zero-permission branch)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PRJ-API-47 — membership-only routes', () => {
    it('PRJ-API-47a a non-member is told to be a member, in those words', async () => {
      // The guard has two distinct refusal messages and the UI shows them.
      // Asserting the string is how the two branches stay distinguishable:
      // `meta.permissions.length === 0` must NOT fall through to the
      // "you do not have permission" text.
      const res = await H()
        .get(`/projects/${fx.privateProjectId}/members`)
        .set(bearer(fx.projectOutsider.token));
      expect(res.status).toBe(403);
      expect(res.body?.message).toBe('You must be a member of this project');
    });

    it('PRJ-API-47b a viewer with ZERO permissions still passes the membership branch', async () => {
      const viewerRole = await ctx.prisma.projectRole.findFirst({
        where: { projectId: fx.privateProjectId, slug: 'viewer' },
        select: { permissions: true },
      });
      expect(viewerRole?.permissions).toEqual([]);

      for (const path of [
        `/projects/${fx.privateProjectId}`,
        `/projects/${fx.privateProjectId}/members`,
        `/projects/${fx.privateProjectId}/activity`,
        `/projects/by-slug/${fx.privateProjectSlug}`,
        `/projects/${fx.privateProjectSlug}/charts`,
      ]) {
        const res = await H().get(path).set(bearer(fx.projectViewer.token));
        expect(`${path} -> ${res.status}`).toBe(`${path} -> 200`);
      }

      // And the same five refuse the outsider, so "200" above is membership,
      // not an unguarded route.
      for (const path of [
        `/projects/${fx.privateProjectId}`,
        `/projects/${fx.privateProjectId}/members`,
        `/projects/${fx.privateProjectId}/activity`,
        `/projects/by-slug/${fx.privateProjectSlug}`,
        `/projects/${fx.privateProjectSlug}/charts`,
      ]) {
        const res = await H().get(path).set(bearer(fx.projectOutsider.token));
        expect(`${path} -> ${res.status}`).toBe(`${path} -> 403`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRJ-API-48 — custom roles
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PRJ-API-48 — custom roles behave exactly as their permission list', () => {
    let projectId: string;
    let memberRowId: string;
    let subsetRoleId: string;

    /** The custom-role holder: a plain EMPLOYEE, member of nothing else. */
    const holder = () => fx.employee;

    beforeAll(async () => {
      const p = await mkDisposableProject(`c${uniq()}`);
      projectId = p.id;
      const m = await ctx.prisma.projectMember.create({
        data: {
          projectId,
          employeeId: fx.employee.employeeId!,
          role: 'MEMBER',
          roleId: p.roleIds.member,
        },
        select: { id: true },
      });
      memberRowId = m.id;
    });

    it('PRJ-API-48a a role holding [SPRINT_MANAGE, STATUS_MANAGE] grants those two and nothing else', async () => {
      const created = await H()
        .post(`/projects/${projectId}/roles`)
        .set(bearer(fx.projectOwner.token))
        .send({
          name: `Sprint Lead ${uniq()}`,
          permissions: ['SPRINT_MANAGE', 'STATUS_MANAGE'],
        });
      expect(created.status).toBe(201);
      subsetRoleId = created.body.data.id;
      expect(created.body.data.isSystem).toBe(false);

      const assigned = await H()
        .patch(`/projects/${projectId}/members/${memberRowId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ roleId: subsetRoleId });
      expect(assigned.status).toBe(200);

      // The two granted…
      expect(verdict(await sprintManage(holder().token, projectId))).toBe(ALLOW);
      // …the project has no workflow, so STATUS_MANAGE is proved by the guard
      // letting the request THROUGH to the service's own complaint, not by 403.
      const statusRes = await H()
        .post('/project-statuses')
        .set(bearer(holder().token))
        .send({ projectId, name: `Col ${uniq()}` });
      expect(statusRes.status).toBe(400);
      expect(statusRes.body?.message).toContain('workflow');

      // …and the ten that were not granted.
      expect(verdict(await taskCreate(holder().token, projectId))).toBe(DENY);
      expect(verdict(await projectEdit(holder().token, projectId))).toBe(DENY);
      expect(verdict(await memberManage(holder().token, projectId))).toBe(DENY);
      expect(verdict(await roleManage(holder().token, projectId))).toBe(DENY);
      expect(verdict(await projectArchive(holder().token, projectId))).toBe(DENY);
    });

    it('PRJ-API-48b copyFromRoleId clones the source permission list', async () => {
      const roles = await ctx.prisma.projectRole.findMany({
        where: { projectId, slug: 'manager' },
        select: { id: true, permissions: true },
      });
      const src = roles[0];
      expect(src.permissions).toHaveLength(7);

      const created = await H()
        .post(`/projects/${projectId}/roles`)
        .set(bearer(fx.projectOwner.token))
        .send({ name: `Cloned ${uniq()}`, copyFromRoleId: src.id });
      expect(created.status).toBe(201);
      expect([...created.body.data.permissions].sort()).toEqual(
        [...src.permissions].sort(),
      );

      // A clone is only real if it works: hand it to the holder and create a
      // task, which the subset role above was refused.
      const cloneId = created.body.data.id;
      await H()
        .patch(`/projects/${projectId}/members/${memberRowId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ roleId: cloneId });
      expect(verdict(await taskCreate(holder().token, projectId))).toBe(ALLOW);

      await H()
        .patch(`/projects/${projectId}/members/${memberRowId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ roleId: subsetRoleId });
    });

    it('PRJ-API-48c editing a role changes the holder on the NEXT request, without re-login', async () => {
      // The permission set is resolved per request from the role row, so the
      // JWT never carries it. If it were baked into the token, a revocation
      // would take effect only at the next login — which is how permission
      // systems leak.
      expect(verdict(await sprintManage(holder().token, projectId))).toBe(ALLOW);

      const patched = await H()
        .patch(`/projects/${projectId}/roles/${subsetRoleId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ permissions: ['STATUS_MANAGE'] });
      expect(patched.status).toBe(200);

      // Same token, no re-login, immediately refused.
      expect(verdict(await sprintManage(holder().token, projectId))).toBe(DENY);

      const restored = await H()
        .patch(`/projects/${projectId}/roles/${subsetRoleId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ permissions: ['SPRINT_MANAGE', 'STATUS_MANAGE'] });
      expect(restored.status).toBe(200);
      expect(verdict(await sprintManage(holder().token, projectId))).toBe(ALLOW);
    });

    it('PRJ-API-48d @ArrayUnique rejects a duplicated permission', async () => {
      const res = await H()
        .post(`/projects/${projectId}/roles`)
        .set(bearer(fx.projectOwner.token))
        .send({ name: `Dup ${uniq()}`, permissions: ['TASK_CREATE', 'TASK_CREATE'] });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/unique/i);
    });

    it('PRJ-API-48e @IsIn(ALL_PROJECT_PERMISSIONS) rejects an invented key', async () => {
      const res = await H()
        .post(`/projects/${projectId}/roles`)
        .set(bearer(fx.projectOwner.token))
        .send({ name: `Bogus ${uniq()}`, permissions: ['PROJECT_TAKEOVER'] });
      expect(res.status).toBe(400);

      // …and on update too, so the create path is not the only door.
      const upd = await H()
        .patch(`/projects/${projectId}/roles/${subsetRoleId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ permissions: ['PROJECT_TAKEOVER'] });
      expect(upd.status).toBe(400);
    });

    it('PRJ-API-48f deleting a role that members still hold is a 409, and the role survives', async () => {
      const res = await H()
        .delete(`/projects/${projectId}/roles/${subsetRoleId}`)
        .set(bearer(fx.projectOwner.token));
      expect(res.status).toBe(409);
      expect(res.body?.message).toMatch(/member/i);

      const still = await ctx.prisma.projectRole.findUnique({
        where: { id: subsetRoleId },
        select: { id: true },
      });
      expect(still).not.toBeNull();

      // Reassign the holder, and the same delete now succeeds — which proves
      // the 409 was about the assignment and not about the role.
      const backToMember = await ctx.prisma.projectRole.findFirst({
        where: { projectId, slug: 'member' },
        select: { id: true },
      });
      await H()
        .patch(`/projects/${projectId}/members/${memberRowId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ roleId: backToMember!.id });

      const second = await H()
        .delete(`/projects/${projectId}/roles/${subsetRoleId}`)
        .set(bearer(fx.projectOwner.token));
      expect(second.status).toBe(200);
    });

    it('PRJ-API-48g a system preset role cannot be deleted', async () => {
      const viewer = await ctx.prisma.projectRole.findFirst({
        where: { projectId, slug: 'viewer' },
        select: { id: true, isSystem: true },
      });
      expect(viewer?.isSystem).toBe(true);

      const res = await H()
        .delete(`/projects/${projectId}/roles/${viewer!.id}`)
        .set(bearer(fx.projectOwner.token));
      expect(res.status).toBe(400);
      expect(res.body?.message).toContain('System roles cannot be deleted');
    });

    it('PRJ-API-48h a colliding slug is suffixed rather than violating @@unique([projectId, slug])', async () => {
      const res = await H()
        .post(`/projects/${projectId}/roles`)
        .set(bearer(fx.projectOwner.token))
        .send({ name: 'Owner' });
      expect(res.status).toBe(201);
      expect(res.body.data.slug).not.toBe('owner');
      expect(res.body.data.slug).toMatch(/^owner-\d+$/);

      const owners = await ctx.prisma.projectRole.findMany({
        where: { projectId, slug: { startsWith: 'owner' } },
        select: { slug: true, isSystem: true },
      });
      expect(new Set(owners.map((r) => r.slug)).size).toBe(owners.length);

      // The impostor is NOT a system role and, crucially, does not inherit the
      // owner slug's runtime meaning — `getAccess()` keys on the slug exactly.
      const impostor = owners.find((r) => r.slug !== 'owner');
      expect(impostor?.isSystem).toBe(false);
      expect(res.body.data.permissions).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRJ-API-41 — FINDING R7 (FIXED): a STATUS_MANAGE grant must not escape
  // through a shared workflow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PRJ-API-41 — R7: a shared workflow is governed by every project on it', () => {
    /** The project the old resolver would have picked — an unordered findFirst. */
    let guardSees: string;
    /** The other project on the same workflow — what used to be the victim. */
    let victim: string;
    let victimTaskId: string;
    let renameTargetId: string;
    let deleteTargetId: string;

    beforeAll(async () => {
      // Mirror the OLD resolver exactly: `findFirst({ where: { workflowId } })`,
      // no ordering, no deletedAt filter. Which of the two projects Postgres
      // answers with is an implementation detail; the finding was that the
      // guard checked THAT one and authorised a change to the OTHER one's board.
      const resolved = await ctx.prisma.project.findFirst({
        where: { workflowId: fx.sharedWorkflowId },
        select: { id: true },
      });
      guardSees = resolved!.id;
      victim =
        guardSees === fx.sharedWorkflowProjectAId
          ? fx.sharedWorkflowProjectBId
          : fx.sharedWorkflowProjectAId;

      // The principal: STATUS_MANAGE on `guardSees` ONLY, via a custom role.
      const role = await ctx.prisma.projectRole.create({
        data: {
          projectId: guardSees,
          name: `Board ${short}`,
          slug: `board-${short}`,
          isSystem: false,
          isDefault: false,
          permissions: ['STATUS_MANAGE'],
          sortOrder: 90,
        },
        select: { id: true },
      });
      await ctx.prisma.projectMember.create({
        data: {
          projectId: guardSees,
          employeeId: fx.memberEmployeeId,
          role: 'MEMBER',
          roleId: role.id,
        },
      });

      // The victim's board is genuinely in use: a task sitting in its first
      // column. Without this the "board" is an abstraction and the case would
      // prove nothing a user would notice.
      victimTaskId = await mkTask(
        victim,
        fx.holderId,
        'victim-board',
        fx.sharedWorkflowStatusIds[0],
      );
      renameTargetId = fx.sharedWorkflowStatusIds[0];
      deleteTargetId = fx.sharedWorkflowStatusIds[2];
    });

    it('PRJ-API-41a the principal has no rights whatsoever on the victim project', async () => {
      // The control the whole finding rests on.
      const read = await H()
        .get(`/projects/${victim}`)
        .set(bearer(fx.projectMember.token));
      expect(read.status).toBe(403);

      const create = await H()
        .post('/project-statuses')
        .set(bearer(fx.projectMember.token))
        .send({ projectId: victim, name: `Direct ${uniq()}` });
      expect(create.status).toBe(403);
    });

    it("PRJ-API-41b renaming and reordering a shared column is refused, and the other board is untouched", async () => {
      /**
       * REGRESSION LOCK — finding R7 (red-flagged), the admission half. Twins
       * Twins PRJ-API-41d and PRJ-API-41e have collapsed into this case and
       * PRJ-API-41c; PRJ-API-41f holds the other side of the chosen rule.
       *
       * `ProjectAccessService.projectIdFromStatus()` resolved a status to its
       * `workflowId` and then to *an arbitrary project using that workflow* —
       * `findFirst`, no ordering, no reference to the caller. Workflows are
       * shared, so the guard asked "may you manage statuses in `guardSees`?" —
       * a project the request never mentioned — and on a yes let this principal
       * rewrite a board they cannot even READ (PRJ-API-41a).
       *
       * The rule now: a shared column is governed by EVERY project that uses
       * its workflow, so `resolveProjectIds()` returns all of them and the
       * guard demands STATUS_MANAGE on each. Authority over an object with many
       * owners is the intersection of their authorities, never the union.
       */
      const before = await H()
        .get(`/tasks/kanban?projectId=${victim}`)
        .set(bearer(fx.admin.token));
      const namesBefore = (before.body.data.columns as any[]).map((c) => c.name);
      const idsBefore = (before.body.data.columns as any[]).map((c) => c.id);

      const renamed = await H()
        .patch(`/project-statuses/${renameTargetId}`)
        .set(bearer(fx.projectMember.token))
        .send({ name: `Hijacked ${short}` });
      expect(renamed.status).toBe(403);
      // The refusal says WHY, because "you do not have permission" on a column
      // the caller can see on their own board is otherwise unactionable.
      expect(renamed.body.message).toMatch(/shared with other projects/i);

      const reversed = [...fx.sharedWorkflowStatusIds]
        .reverse()
        .map((id, i) => ({ id, position: i }));
      const reordered = await H()
        .patch('/project-statuses/reorder')
        .set(bearer(fx.projectMember.token))
        .send({ items: reversed });
      expect(reordered.status).toBe(403);

      // Nothing moved — names, order, and the task still on its column. Read as
      // the ADMIN, so this is the board a user of `victim` would see.
      const after = await H()
        .get(`/tasks/kanban?projectId=${victim}`)
        .set(bearer(fx.admin.token));
      const columns = after.body.data.columns as Array<{
        id: string;
        name: string;
        tasks: Array<{ id: string }>;
      }>;
      expect(columns.map((c) => c.name)).toEqual(namesBefore);
      expect(columns.map((c) => c.id)).toEqual(idsBefore);
      expect(
        columns.find((c) => c.tasks.some((t) => t.id === victimTaskId))?.id,
      ).toBe(renameTargetId);
    });

    it("PRJ-API-41c DELETING a shared column is refused, and it survives on both boards", async () => {
      // REGRESSION LOCK — finding R7, the destructive half (twin PRJ-API-41e).
      // Soft-deleting a workflow status removes the column from EVERY project
      // on that workflow, so it is the mutation with the widest blast radius
      // and the one the old resolver authorised most cheaply.
      const removed = await H()
        .delete(`/project-statuses/${deleteTargetId}`)
        .set(bearer(fx.projectMember.token));
      expect(removed.status).toBe(403);

      for (const projectId of [victim, guardSees]) {
        const board = await H()
          .get(`/tasks/kanban?projectId=${projectId}`)
          .set(bearer(fx.admin.token));
        expect(
          (board.body.data.columns as Array<{ id: string }>).map((c) => c.id),
        ).toContain(deleteTargetId);
      }

      const row = await ctx.prisma.projectTaskStatus.findUnique({
        where: { id: deleteTargetId },
        select: { deletedAt: true },
      });
      expect(row?.deletedAt).toBeNull();
    });

    it('PRJ-API-41f the rule is not a freeze — a principal who governs every project on the workflow still manages the column', async () => {
      // The other side of the chosen rule, and the reason it is "every project"
      // rather than "refuse the shared case outright": `projectOwner` owns BOTH
      // projects on this workflow, so the intersection is non-empty and the
      // column is still editable by someone. A shared board is not orphaned.
      const original = await ctx.prisma.projectTaskStatus.findUnique({
        where: { id: renameTargetId },
        select: { name: true },
      });

      const renamed = await H()
        .patch(`/project-statuses/${renameTargetId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ name: `Owned ${uniq()}` });
      expect(renamed.status).toBe(200);

      // A global admin bypasses project scope entirely and is likewise unaffected.
      const restored = await H()
        .patch(`/project-statuses/${renameTargetId}`)
        .set(bearer(fx.admin.token))
        .send({ name: original!.name });
      expect(restored.status).toBe(200);
      expect(restored.body.data.name).toBe(original!.name);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRJ-API-46 — the owner role is fixed, and the API says so
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PRJ-API-46 — the owner role refuses permission changes explicitly', () => {
    it('PRJ-API-46a PATCH stripping the owner role is refused, and the row is untouched', async () => {
      // REGRESSION LOCK — finding R11, fixed. `ProjectRolesService.update()`
      // used to force-restore ALL_PROJECT_PERMISSIONS whenever
      // `role.slug === 'owner'` and then answer `{ success: true, message:
      // 'Role updated' }`, echoing the untouched twelve back — so an
      // administrator was told a restriction had landed when the row never
      // moved, and was misled twice over. Immutability is defensible;
      // reporting success for a write that was silently dropped is not. It now
      // answers 400 and says why.
      const ownerRoleId = fx.privateRoleIds.owner;
      const before = await ctx.prisma.projectRole.findUnique({
        where: { id: ownerRoleId },
        select: { permissions: true },
      });
      expect(before?.permissions).toHaveLength(12);

      const res = await H()
        .patch(`/projects/${fx.privateProjectId}/roles/${ownerRoleId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ permissions: ['TASK_STATUS_UPDATE'] });

      expect(res.status).toBe(400);
      expect(res.body?.success).not.toBe(true);
      expect(String(res.body?.message ?? '')).toMatch(/owner role/i);

      const after = await ctx.prisma.projectRole.findUnique({
        where: { id: ownerRoleId },
        select: { permissions: true },
      });
      expect([...(after?.permissions ?? [])].sort()).toEqual(
        [...(before?.permissions ?? [])].sort(),
      );

      // And the capability is unchanged too: the owner still edits.
      expect(verdict(await projectEdit(fx.projectOwner.token, fx.privateProjectId))).toBe(ALLOW);
    });

    it('PRJ-API-46d the owner role\'s other fields are still editable — only permissions are fixed', async () => {
      // The refusal has to be about the PERMISSIONS, not about the row: a
      // blanket 400 on the owner role would be a different (and worse) product
      // decision than the one the fix makes.
      const ownerRoleId = fx.privateRoleIds.owner;
      const res = await H()
        .patch(`/projects/${fx.privateProjectId}/roles/${ownerRoleId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ description: `owner desc ${uniq()}` });
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toHaveLength(12);
    });

    it('PRJ-API-46c a non-owner system role CAN be edited, so 46a is the owner slug and not "system"', async () => {
      // Without this control, PRJ-API-46a would be indistinguishable from
      // "system roles are immutable" — which would be a defensible design.
      const memberRoleId = fx.privateRoleIds.member;
      const res = await H()
        .patch(`/projects/${fx.privateProjectId}/roles/${memberRoleId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ permissions: [] });
      expect(res.status).toBe(200);

      const row = await ctx.prisma.projectRole.findUnique({
        where: { id: memberRoleId },
        select: { permissions: true, isSystem: true },
      });
      expect(row?.isSystem).toBe(true);
      expect(row?.permissions).toEqual([]);

      // Restore — later files and the fixture contract expect the preset.
      await H()
        .patch(`/projects/${fx.privateProjectId}/roles/${memberRoleId}`)
        .set(bearer(fx.projectOwner.token))
        .send({ permissions: ['TASK_STATUS_UPDATE'] });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRJ-API-49 — the service no longer re-decides what the guard decided
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PRJ-API-49 — the catalogue and the runtime agree', () => {
    it('PRJ-API-49a a member with TASK_STATUS_UPDATE can move ANY card on the board', async () => {
      // REGRESSION LOCK — finding R43, fixed. §4 grants the member preset
      // TASK_STATUS_UPDATE for the PROJECT and the catalogue calls it "Update
      // task status", a board-wide capability. `assertUpdateAccess()` then
      // narrowed an EMPLOYEE holding the `member` slug to tasks they were
      // assigned to or reported, so the permission was really "update the
      // status of your OWN tasks" and a member could not move a colleague's
      // card on the board they share. The permission now governs, as written.
      const notMine = await mkTask(
        fx.privateProjectId,
        fx.ownerEmployeeId,
        'not-members',
      );
      expect(verdict(await taskStatusUpdate(fx.projectMember.token, notMine))).toBe(ALLOW);

      const mine = await mkTask(
        fx.privateProjectId,
        fx.memberEmployeeId,
        'members-own',
      );
      expect(verdict(await taskStatusUpdate(fx.projectMember.token, mine))).toBe(ALLOW);
    });

    it('PRJ-API-49b the widening stops exactly there — a member still cannot EDIT that card', async () => {
      // The load-bearing half of R43's fix. TASK_STATUS_UPDATE became
      // board-wide; it did not become TASK_EDIT, and it did not reach the two
      // principals §4 marks ✗. Without this case, "the member can now do more"
      // and "the member can now do anything" look identical.
      const notMine = await mkTask(
        fx.privateProjectId,
        fx.ownerEmployeeId,
        'member-edit-refused',
      );
      expect(verdict(await taskEdit(fx.projectMember.token, notMine))).toBe(DENY);
      expect(verdict(await taskDelete(fx.projectMember.token, notMine))).toBe(DENY);

      // The viewer and the outsider are where they were: ✗ on the same card.
      expect(verdict(await taskStatusUpdate(fx.projectViewer.token, notMine))).toBe(DENY);
      expect(verdict(await taskStatusUpdate(fx.projectOutsider.token, notMine))).toBe(DENY);
    });

    it('PRJ-API-49c the project OWNER can edit a task they did not report', async () => {
      // REGRESSION LOCK — finding R42, fixed. The owner resolves to all 12
      // permissions and the guard let the request through, but
      // `assertUpdateAccess()` computed its project-permission flag ONLY when
      // `user.role === 'EMPLOYEE'`. This owner's global role is MANAGER, so it
      // was never computed and the owner fell through to the reporter/assignee
      // test — an owner with a LOWER global role had MORE power over their own
      // project. The flag is now computed for every caller, from the real
      // permission set rather than a `slug !== 'member'` guess.
      const someoneElses = await mkTask(
        fx.privateProjectId,
        fx.memberEmployeeId,
        'owner-can-edit',
      );
      expect(verdict(await taskEdit(fx.projectOwner.token, someoneElses))).toBe(ALLOW);

      // The manager preset — an EMPLOYEE — edits the very same task, as before.
      expect(verdict(await taskEdit(fx.projectManager.token, someoneElses))).toBe(ALLOW);
    });

    it('PRJ-API-49d ownership by `ownerId` alone is enough — no membership row needed', async () => {
      // `getAccess()` resolves an owner two ways, and R42 was invisible to the
      // one the fixture project uses. A project whose owner holds NO
      // ProjectMember row proves the fix reads `project.ownerId`, not a slug.
      const orphanOwner = await ctx.prisma.project.create({
        data: {
          projectCode: `O${short}${(seq += 1)}`.slice(0, 20),
          name: `Owner-only ${fx.runId}`,
          slug: `owner-only-${fx.runId}`.toLowerCase(),
          taskPrefix: 'OO',
          visibility: 'PRIVATE',
          status: 'ACTIVE',
          priority: 'MEDIUM',
          ownerId: fx.ownerEmployeeId,
        },
        select: { id: true },
      });
      createdProjectIds.push(orphanOwner.id);

      const rows = await ctx.prisma.projectMember.count({
        where: { projectId: orphanOwner.id },
      });
      expect(rows).toBe(0);

      const someoneElses = await mkTask(
        orphanOwner.id,
        fx.memberEmployeeId,
        'orphan-owner-edit',
        null,
      );
      expect(verdict(await taskEdit(fx.projectOwner.token, someoneElses))).toBe(ALLOW);
    });

    it('PRJ-API-49e the manager preset can use the TASK_ASSIGN it holds', async () => {
      // REGRESSION LOCK — finding R41 (assign half). See PRJ-API-40g.
      const t = await mkTask(
        fx.privateProjectId,
        fx.managerPresetEmployeeId,
        'preset-assign',
      );
      expect(
        verdict(
          await taskAssign(fx.projectManager.token, t, fx.managedEmployeeId),
        ),
      ).toBe(ALLOW);

      const row = await ctx.prisma.task.findUnique({
        where: { id: t },
        include: { assignees: { select: { id: true } } },
      });
      expect(row?.assignees.map((a) => a.id)).toContain(fx.managedEmployeeId);
    });

    it('PRJ-API-49f the manager preset can use the TASK_DELETE it holds', async () => {
      // REGRESSION LOCK — finding R41 (delete half). See PRJ-API-40i.
      const t = await mkTask(
        fx.privateProjectId,
        fx.managerPresetEmployeeId,
        'preset-delete',
      );
      expect(verdict(await taskDelete(fx.projectManager.token, t))).toBe(ALLOW);

      const row = await ctx.prisma.task.findUnique({
        where: { id: t },
        select: { deletedAt: true },
      });
      expect(row?.deletedAt).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRJ-API-50 — R21: the three controllers that carried no project guard
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PRJ-API-50 — comments, attachments and labels are project-gated', () => {
    let taskId: string;

    beforeAll(async () => {
      taskId = await mkTask(fx.privateProjectId, fx.ownerEmployeeId, 'r21-subject');
    });

    it('PRJ-API-50a the project really is PRIVATE and the outsider really is outside it', async () => {
      const proj = await ctx.prisma.project.findUnique({
        where: { id: fx.privateProjectId },
        select: { visibility: true },
      });
      expect(proj?.visibility).toBe('PRIVATE');

      const member = await ctx.prisma.projectMember.findFirst({
        where: {
          projectId: fx.privateProjectId,
          employeeId: fx.outsiderEmployeeId,
        },
      });
      expect(member).toBeNull();

      // Every other project-scoped write refuses them, which is the contrast
      // the next two cases are measured against.
      expect(verdict(await taskCreate(fx.projectOutsider.token, fx.privateProjectId))).toBe(DENY);
      expect(verdict(await taskEdit(fx.projectOutsider.token, taskId))).toBe(DENY);
    });

    it('PRJ-API-50b a VIEWER may READ the thread and may not write to it', async () => {
      // REGRESSION LOCK — finding R21, fixed. `TaskCommentsController` was
      // `@UseGuards(JwtAuthGuard, RolesGuard)` with
      // `@Roles('ADMIN','HR_MANAGER','MANAGER','EMPLOYEE')` — i.e. every
      // authenticated user — and carried no `ProjectPermissionGuard` and no
      // `@RequireProjectPermission` at all, while every other project-scoped
      // write is gated. A viewer's role grants [] and they could still write.
      //
      // The line now drawn is the catalogue's own: `viewer` is "read-only
      // access to the project", so the thread is readable and not writable;
      // the write needs TASK_STATUS_UPDATE, the permission that separates
      // somebody who works on the project's tasks from somebody watching.
      const write = await H()
        .post('/task-comments')
        .set(bearer(fx.projectViewer.token))
        .send({ taskId, comment: `viewer comment ${fx.runId}` });
      expect(write.status).toBe(403);

      const row = await ctx.prisma.taskComment.findFirst({
        where: { taskId, comment: { contains: `viewer comment ${fx.runId}` } },
        select: { id: true },
      });
      expect(row).toBeNull();

      const read = await H()
        .get(`/task-comments/task/${taskId}`)
        .set(bearer(fx.projectViewer.token));
      expect(read.status).toBe(200);
    });

    it('PRJ-API-50c a MEMBER writes and reads — the gate is the project, not the module', async () => {
      // The positive control the three refusals below are measured against: a
      // guard that refused everybody would look identical to a correct one.
      const posted = await H()
        .post('/task-comments')
        .set(bearer(fx.projectMember.token))
        .send({ taskId, comment: `member comment ${fx.runId}` });
      expect(posted.status).toBe(201);

      const listed = await H()
        .get(`/task-comments/task/${taskId}`)
        .set(bearer(fx.projectMember.token));
      expect(listed.status).toBe(200);
      expect(
        (listed.body.data as Array<{ comment: string }>).map((c) => c.comment),
      ).toContain(`member comment ${fx.runId}`);
    });

    it('PRJ-API-50d a complete OUTSIDER can neither read nor write the thread', async () => {
      // REGRESSION LOCK — finding R21. The same hole reached by a principal
      // with no relationship to the project whatsoever:
      // `TaskCommentsService.create()` checked only that the task existed.
      const posted = await H()
        .post('/task-comments')
        .set(bearer(fx.projectOutsider.token))
        .send({ taskId, comment: `outsider comment ${fx.runId}` });
      expect(posted.status).toBe(403);

      const listed = await H()
        .get(`/task-comments/task/${taskId}`)
        .set(bearer(fx.projectOutsider.token));
      expect(listed.status).toBe(403);

      // Nothing of theirs reached the thread.
      const row = await ctx.prisma.taskComment.findFirst({
        where: { taskId, comment: { contains: `outsider comment ${fx.runId}` } },
        select: { id: true },
      });
      expect(row).toBeNull();
    });

    it('PRJ-API-50e a complete OUTSIDER can neither register nor list attachments', async () => {
      // REGRESSION LOCK — finding R21, attachment half.
      // `TaskAttachmentsController` had the identical shape. Registration by
      // URL is used here rather than the multipart upload so the case turns on
      // the AUTHORISATION and not on object storage.
      const created = await H()
        .post('/task-attachments')
        .set(bearer(fx.projectOutsider.token))
        .send({
          taskId,
          fileName: `outsider-${fx.runId}.txt`,
          fileUrl: `https://example.invalid/${fx.runId}.txt`,
          mimeType: 'text/plain',
        });
      expect(created.status).toBe(403);

      const listed = await H()
        .get(`/task-attachments/task/${taskId}`)
        .set(bearer(fx.projectOutsider.token));
      expect(listed.status).toBe(403);

      expect(
        await ctx.prisma.taskAttachment.count({
          where: { taskId, fileName: `outsider-${fx.runId}.txt` },
        }),
      ).toBe(0);
    });

    it('PRJ-API-50f LABELS are project-gated too — the third instance of the same shape', async () => {
      // REGRESSION LOCK — finding R21/R60. `LabelsController` took `projectId`
      // straight from the body under a global-role list, so a MANAGER who was a
      // member of nothing wrote into a PRIVATE project's label set and any
      // EMPLOYEE read the taxonomy back. Writes need TASK_EDIT (a label IS task
      // metadata); reads need membership.
      const outsiderWrite = await H()
        .post('/labels')
        .set(bearer(fx.projectOutsider.token))
        .send({ name: `rbac-outsider-${uniq()}`, projectId: fx.privateProjectId });
      expect(outsiderWrite.status).toBe(403);

      const outsiderRead = await H()
        .get(`/labels?projectId=${fx.privateProjectId}`)
        .set(bearer(fx.projectOutsider.token));
      expect(outsiderRead.status).toBe(403);

      // A member reads the taxonomy; the manager preset, holding TASK_EDIT,
      // writes it. Both halves, so "gated" is not "closed".
      expect(
        (
          await H()
            .get(`/labels?projectId=${fx.privateProjectId}`)
            .set(bearer(fx.projectMember.token))
        ).status,
      ).toBe(200);

      const presetWrite = await H()
        .post('/labels')
        .set(bearer(fx.projectManager.token))
        .send({ name: `rbac-preset-${uniq()}`, projectId: fx.privateProjectId });
      expect(presetWrite.status).toBe(201);
      await ctx.prisma.label.delete({ where: { id: presetWrite.body.data.id } });

      // …and a member, who does not hold TASK_EDIT, still cannot.
      const memberWrite = await H()
        .post('/labels')
        .set(bearer(fx.projectMember.token))
        .send({ name: `rbac-member-${uniq()}`, projectId: fx.privateProjectId });
      expect(memberWrite.status).toBe(403);
    });
  });
});
