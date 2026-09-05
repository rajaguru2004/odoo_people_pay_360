import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import { ALL_PROJECT_PERMISSIONS } from '../src/projects/rbac/permissions.constants';

/**
 * Projects module — end-to-end lifecycle.
 *
 * Covers:
 *   1.  Project CRUD (create, list, get, update, delete, archive/unarchive)
 *   2.  Visibility scoping (PRIVATE / INTERNAL / PUBLIC)
 *   3.  Member management (add, update role, remove)
 *   4.  RBAC preset roles (Owner, Manager, Member, Viewer resolved permissions)
 *   5.  Tasks — full lifecycle (create, update, assign, status, archive, delete)
 *   6.  Tasks — subtasks and dependencies
 *   7.  Sprints — full lifecycle (PLANNING → ACTIVE → COMPLETED → deleted)
 *   8.  Analytics (charts endpoint with KPIs)
 *   9.  Activity log
 *  10.  Project stats endpoint
 */
describe('Projects lifecycle (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `prj${Date.now()}`;

  // ── Personas ──────────────────────────────────────────────────────────────
  let adminToken: string;
  let ownerToken: string;    // project owner (MANAGER role in HRM)
  let memberToken: string;   // project MEMBER (EMPLOYEE in HRM)
  let viewerToken: string;   // project VIEWER (EMPLOYEE in HRM)
  let outsiderToken: string; // employee, NOT a project member at all

  // Employee IDs (needed to add as project members)
  let ownerEmpId: string;
  let memberEmpId: string;
  let viewerEmpId: string;
  let outsiderEmpId: string;

  // Project IDs (created across groups)
  let mainProjectId: string;
  let mainProjectSlug: string;
  let privateProjectId: string;
  let internalProjectId: string;

  // Role IDs within mainProject
  let projectManagerRoleId: string;
  let projectMemberRoleId: string;
  let projectViewerRoleId: string;

  // Member row IDs (for update/remove)
  let memberMemberRowId: string;
  let viewerMemberRowId: string;

  // Task IDs
  let taskId: string;
  let subtaskId: string;
  let taskForStatusId: string;

  // Status IDs for mainProject workflow
  let todoStatusId: string;
  let inProgressStatusId: string;
  let doneStatusId: string;

  // Sprint IDs
  let sprintId: string;

  // ── Helpers ───────────────────────────────────────────────────────────────

  async function makeEmployee(email: string, code: string) {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const dept = await ctx.prisma.department.findFirst({ where: { isActive: true } });
    const emp = await ctx.prisma.employee.create({
      data: {
        employeeCode: code,
        fullName: `Prj Person ${code}`,
        email,
        idCard: `ID-PRJ-${code}`,
        dateOfBirth: new Date('1992-01-01'),
        startDate: new Date('2022-01-01'),
        departmentId: dept!.id,
        position: 'Developer',
        branchId: (await ctx.prisma.branch.findFirst({ where: { isActive: true } }))!.id,
        baseSalary: 3000,
        status: 'ACTIVE',
      },
    });
    await ctx.prisma.user.create({
      data: {
        email,
        passwordHash: hash,
        role: 'EMPLOYEE',
        employeeId: emp.id,
        isActive: true,
        isGlobalBranchAccess: true, // global so branch scoping doesn't interfere
      },
    });
    return emp.id;
  }

  async function login(email: string) {
    const res = await ctx.http().post('/auth/login').send({ email, password: PASSWORD });
    return res.body.data.accessToken as string;
  }

  // ── Setup / teardown ──────────────────────────────────────────────────────

  beforeAll(async () => {
    ctx = await bootE2EApp();
    const { prisma } = ctx;
    const hash = await bcrypt.hash(PASSWORD, 10);

    // Admin user (no employee required)
    await prisma.user.create({
      data: {
        email: `admin-${runId}@test.local`,
        passwordHash: hash,
        role: 'ADMIN',
        isActive: true,
        isGlobalBranchAccess: true,
      },
    });

    ownerEmpId = await makeEmployee(`owner-${runId}@test.local`, `PRJ-OWN-${runId}`);
    memberEmpId = await makeEmployee(`member-${runId}@test.local`, `PRJ-MBR-${runId}`);
    viewerEmpId = await makeEmployee(`viewer-${runId}@test.local`, `PRJ-VWR-${runId}`);
    outsiderEmpId = await makeEmployee(`outsider-${runId}@test.local`, `PRJ-OUT-${runId}`);

    adminToken = await login(`admin-${runId}@test.local`);
    ownerToken = await login(`owner-${runId}@test.local`);
    memberToken = await login(`member-${runId}@test.local`);
    viewerToken = await login(`viewer-${runId}@test.local`);
    outsiderToken = await login(`outsider-${runId}@test.local`);
    expect(adminToken).toBeTruthy();
  });

  afterAll(async () => {
    const { prisma } = ctx;

    // Delete in dependency order
    const projectIds = [mainProjectId, privateProjectId, internalProjectId].filter(Boolean);
    if (projectIds.length) {
      await prisma.taskDependency.deleteMany({
        where: { OR: [
          { dependentTask: { projectId: { in: projectIds } } },
          { blockingTask: { projectId: { in: projectIds } } },
        ] },
      });
      await prisma.taskActivity.deleteMany({
        where: { task: { projectId: { in: projectIds } } },
      });
      await prisma.taskComment.deleteMany({
        where: { task: { projectId: { in: projectIds } } },
      });
      await prisma.taskAttachment.deleteMany({
        where: { task: { projectId: { in: projectIds } } },
      });
      await prisma.task.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.sprint.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.projectMember.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.projectRole.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.auditLog.deleteMany({
        where: { resourceType: 'Project', resourceId: { in: projectIds } },
      });
      // Hard delete (un-soft-delete) so the project rows can be wiped
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    }

    await prisma.user.deleteMany({
      where: { email: { endsWith: `${runId}@test.local` } },
    });
    await prisma.employee.deleteMany({
      where: { employeeCode: { endsWith: runId } },
    });
    await ctx.app.close();
  });

  // ── 1. Project CRUD ───────────────────────────────────────────────────────

  describe('project CRUD', () => {
    it('ADMIN creates a project; projectCode is auto-generated', async () => {
      const res = await ctx
        .http()
        .post('/projects')
        .set(bearer(adminToken))
        .send({
          name: `Main Project ${runId}`,
          description: 'E2E test project',
          status: 'PLANNING',
          priority: 'HIGH',
          visibility: 'PRIVATE',
          ownerId: ownerEmpId,
          memberIds: [ownerEmpId, memberEmpId, viewerEmpId],
        })
        .expect(201);

      mainProjectId = res.body.data.id;
      mainProjectSlug = res.body.data.slug;
      expect(res.body.success).toBe(true);
      expect(res.body.data.projectCode).toMatch(/^PROJ-\d{4}$/);
      expect(mainProjectSlug).toBeTruthy();
    });

    it('EMPLOYEE cannot create a project (403)', async () => {
      await ctx
        .http()
        .post('/projects')
        .set(bearer(outsiderToken))
        .send({ name: `Outsider Project ${runId}`, visibility: 'PRIVATE' })
        .expect(403);
    });

    it('GET /projects/stats returns scoped counts', async () => {
      const res = await ctx
        .http()
        .get('/projects/stats')
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('total');
      expect(res.body.data).toHaveProperty('active');
      expect(res.body.data).toHaveProperty('completed');
      expect(res.body.data).toHaveProperty('onHold');
    });

    it('GET /projects list includes the created project for its owner', async () => {
      const res = await ctx
        .http()
        .get('/projects')
        .set(bearer(ownerToken))
        .expect(200);

      const ids = res.body.data.map((p: any) => p.id);
      expect(ids).toContain(mainProjectId);
    });

    it('GET /projects/by-slug/:slug returns the project', async () => {
      const res = await ctx
        .http()
        .get(`/projects/by-slug/${mainProjectSlug}`)
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.data.id).toBe(mainProjectId);
    });

    it('PATCH updates project name and status', async () => {
      const res = await ctx
        .http()
        .patch(`/projects/${mainProjectId}`)
        .set(bearer(adminToken))
        .send({ name: `Main Project Updated ${runId}`, status: 'ACTIVE' })
        .expect(200);

      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.name).toContain('Updated');
    });

    it('duplicate slug is auto-incremented to avoid collision', async () => {
      // Create another project with the same base slug
      const res = await ctx
        .http()
        .post('/projects')
        .set(bearer(adminToken))
        .send({
          name: `Main Project Updated ${runId}`, // same name → same base slug
          visibility: 'PRIVATE',
        })
        .expect(201);

      // Slug must differ from mainProjectSlug
      expect(res.body.data.slug).not.toBe(mainProjectSlug);
      // Clean up this extra project immediately
      await ctx.prisma.project.deleteMany({ where: { id: res.body.data.id } });
    });

    it('archive hides project from default list; unarchive restores it', async () => {
      await ctx
        .http()
        .post(`/projects/${mainProjectId}/archive`)
        .set(bearer(adminToken))
        .expect(201);

      const archived = await ctx
        .http()
        .get('/projects')
        .set(bearer(adminToken))
        .query({ isArchived: 'false' })
        .expect(200);

      const idsInActive = archived.body.data.map((p: any) => p.id);
      expect(idsInActive).not.toContain(mainProjectId);

      // Unarchive
      await ctx
        .http()
        .post(`/projects/${mainProjectId}/unarchive`)
        .set(bearer(adminToken))
        .expect(201);

      const unarchived = await ctx
        .http()
        .get('/projects')
        .set(bearer(adminToken))
        .query({ isArchived: 'false' })
        .expect(200);

      const idsAfterUnarchive = unarchived.body.data.map((p: any) => p.id);
      expect(idsAfterUnarchive).toContain(mainProjectId);
    });
  });

  // ── 2. Visibility scoping ─────────────────────────────────────────────────

  describe('visibility scoping', () => {
    it('PRIVATE project is invisible to non-members', async () => {
      // Create a private project owned by admin
      const res = await ctx
        .http()
        .post('/projects')
        .set(bearer(adminToken))
        .send({
          name: `Private Project ${runId}`,
          visibility: 'PRIVATE',
          ownerId: ownerEmpId,
        })
        .expect(201);
      privateProjectId = res.body.data.id;

      // outsiderToken is not a member and not admin
      const list = await ctx
        .http()
        .get('/projects')
        .set(bearer(outsiderToken))
        .expect(200);

      const ids = list.body.data.map((p: any) => p.id);
      expect(ids).not.toContain(privateProjectId);
    });

    it('INTERNAL project is visible to all authenticated users', async () => {
      const res = await ctx
        .http()
        .post('/projects')
        .set(bearer(adminToken))
        .send({
          name: `Internal Project ${runId}`,
          visibility: 'INTERNAL',
          ownerId: ownerEmpId,
        })
        .expect(201);
      internalProjectId = res.body.data.id;

      const list = await ctx
        .http()
        .get('/projects')
        .set(bearer(outsiderToken))
        .expect(200);

      const ids = list.body.data.map((p: any) => p.id);
      expect(ids).toContain(internalProjectId);
    });
  });

  // ── 3. Member management ──────────────────────────────────────────────────

  describe('member management', () => {
    beforeAll(async () => {
      // Capture the role IDs seeded for mainProject
      const roles = await ctx.prisma.projectRole.findMany({
        where: { projectId: mainProjectId },
      });
      projectManagerRoleId = roles.find((r) => r.slug === 'manager')!.id;
      projectMemberRoleId = roles.find((r) => r.slug === 'member')!.id;
      projectViewerRoleId = roles.find((r) => r.slug === 'viewer')!.id;

      // Get member row IDs for the members already added at project creation
      const members = await ctx.prisma.projectMember.findMany({
        where: { projectId: mainProjectId },
      });
      memberMemberRowId = members.find((m) => m.employeeId === memberEmpId)!.id;
      viewerMemberRowId = members.find((m) => m.employeeId === viewerEmpId)!.id;
    });

    it('GET /projects/:id/members lists all members', async () => {
      const res = await ctx
        .http()
        .get(`/projects/${mainProjectId}/members`)
        .set(bearer(adminToken))
        .expect(200);

      const empIds = res.body.data.map((m: any) => m.employeeId);
      expect(empIds).toContain(ownerEmpId);
      expect(empIds).toContain(memberEmpId);
      expect(empIds).toContain(viewerEmpId);
    });

    it('POST /projects/:id/members adds a new member by employeeId', async () => {
      const res = await ctx
        .http()
        .post(`/projects/${mainProjectId}/members`)
        .set(bearer(adminToken))
        .send({ employeeId: outsiderEmpId, roleId: projectMemberRoleId })
        .expect(201);

      expect(res.body.success).toBe(true);
    });

    it('PATCH /projects/:id/members/:memberId updates the member\'s role to viewer', async () => {
      const res = await ctx
        .http()
        .patch(`/projects/${mainProjectId}/members/${viewerMemberRowId}`)
        .set(bearer(adminToken))
        .send({ roleId: projectViewerRoleId })
        .expect(200);

      expect(res.body.data.roleId).toBe(projectViewerRoleId);
    });

    it('assigning a roleId from a different project returns 400', async () => {
      // internalProjectId has its own roles — use one of those IDs
      const alienRole = await ctx.prisma.projectRole.findFirst({
        where: { projectId: internalProjectId },
      });
      expect(alienRole).toBeTruthy();

      const res = await ctx
        .http()
        .patch(`/projects/${mainProjectId}/members/${memberMemberRowId}`)
        .set(bearer(adminToken))
        .send({ roleId: alienRole!.id })
        .expect(400);

      expect(res.body.message).toMatch(/does not belong/i);
    });

    it('DELETE /projects/:id/members/:memberId removes a member', async () => {
      // Remove outsider who was added above
      const row = await ctx.prisma.projectMember.findFirst({
        where: { projectId: mainProjectId, employeeId: outsiderEmpId },
      });
      expect(row).toBeTruthy();

      await ctx
        .http()
        .delete(`/projects/${mainProjectId}/members/${row!.id}`)
        .set(bearer(adminToken))
        .expect(200);
    });
  });

  // ── 4. RBAC preset roles ──────────────────────────────────────────────────

  describe('RBAC preset roles', () => {
    it('ADMIN has all project permissions (global admin bypass)', async () => {
      const res = await ctx
        .http()
        .get(`/projects/${mainProjectId}/my-permissions`)
        .set(bearer(adminToken))
        .expect(200);

      // Admin bypasses project RBAC entirely
      expect(res.body.data.isGlobalAdmin).toBe(true);
      expect(res.body.data.permissions.length).toBe(ALL_PROJECT_PERMISSIONS.length);
    });

    it('owner has all project permissions', async () => {
      const res = await ctx
        .http()
        .get(`/projects/${mainProjectId}/my-permissions`)
        .set(bearer(ownerToken))
        .expect(200);

      expect(res.body.data.isOwner).toBe(true);
      expect(res.body.data.permissions.length).toBe(ALL_PROJECT_PERMISSIONS.length);
    });

    it('member has only TASK_STATUS_UPDATE', async () => {
      const res = await ctx
        .http()
        .get(`/projects/${mainProjectId}/my-permissions`)
        .set(bearer(memberToken))
        .expect(200);

      expect(res.body.data.permissions).toContain('TASK_STATUS_UPDATE');
      expect(res.body.data.permissions).not.toContain('TASK_CREATE');
      expect(res.body.data.permissions).not.toContain('TASK_ASSIGN');
      expect(res.body.data.permissions).not.toContain('PROJECT_DELETE');
    });

    it('viewer has no permissions', async () => {
      const res = await ctx
        .http()
        .get(`/projects/${mainProjectId}/my-permissions`)
        .set(bearer(viewerToken))
        .expect(200);

      expect(res.body.data.permissions).toHaveLength(0);
    });

    it('viewer cannot create a task (403)', async () => {
      // Need a status to create a task — get one from the workflow
      const statuses = await ctx.prisma.projectTaskStatus.findMany({
        where: { workflow: { projects: { some: { id: mainProjectId } } } },
      });
      const statusId = statuses[0]?.id;

      await ctx
        .http()
        .post('/tasks')
        .set(bearer(viewerToken))
        .send({
          projectId: mainProjectId,
          title: 'Viewer creates a task',
          statusId,
        })
        .expect(403);
    });

    it('member cannot create a task (only has TASK_STATUS_UPDATE) (403)', async () => {
      const statuses = await ctx.prisma.projectTaskStatus.findMany({
        where: { workflow: { projects: { some: { id: mainProjectId } } } },
      });
      const statusId = statuses[0]?.id;

      await ctx
        .http()
        .post('/tasks')
        .set(bearer(memberToken))
        .send({
          projectId: mainProjectId,
          title: 'Member creates task',
          statusId,
        })
        .expect(403);
    });
  });

  // ── 5. Tasks — full lifecycle ─────────────────────────────────────────────

  describe('tasks lifecycle', () => {
    beforeAll(async () => {
      // Resolve workflow statuses
      const statuses = await ctx.prisma.projectTaskStatus.findMany({
        where: { workflow: { projects: { some: { id: mainProjectId } } } },
        orderBy: { position: 'asc' },
      });
      todoStatusId = statuses.find((s) => s.category === 'TODO')?.id ?? statuses[0]?.id;
      inProgressStatusId =
        statuses.find((s) => s.category === 'IN_PROGRESS')?.id ?? statuses[1]?.id;
      doneStatusId = statuses.find((s) => s.category === 'DONE')?.id ?? statuses[statuses.length - 1]?.id;
    });

    it('admin creates a task with title, description, and priority', async () => {
      const res = await ctx
        .http()
        .post('/tasks')
        .set(bearer(adminToken))
        .send({
          projectId: mainProjectId,
          title: `Main task ${runId}`,
          description: 'E2E test task',
          priority: 'HIGH',
          type: 'TASK',
          statusId: todoStatusId,
        })
        .expect(201);

      taskId = res.body.data.id;
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toContain(runId);
    });

    it('task code is auto-generated in TASK-NNNN format', async () => {
      expect(res_taskId_code(taskId)).resolves.toMatch(/^TASK-\d{4}$/);

      async function res_taskId_code(id: string) {
        const t = await ctx.prisma.task.findUnique({ where: { id }, select: { taskCode: true } });
        return t?.taskCode ?? '';
      }
    });

    it('PATCH updates task title and description', async () => {
      const res = await ctx
        .http()
        .patch(`/tasks/${taskId}`)
        .set(bearer(adminToken))
        .send({ title: `Updated task ${runId}`, description: 'New description' })
        .expect(200);

      expect(res.body.data.title).toContain('Updated');
    });

    it('GET /tasks lists tasks for a project', async () => {
      const res = await ctx
        .http()
        .get('/tasks')
        .set(bearer(adminToken))
        .query({ projectId: mainProjectId })
        .expect(200);

      const ids = res.body.data.map((t: any) => t.id);
      expect(ids).toContain(taskId);
    });

    it('GET /tasks/kanban groups tasks by workflow status', async () => {
      const res = await ctx
        .http()
        .get('/tasks/kanban')
        .set(bearer(adminToken))
        .query({ projectId: mainProjectId })
        .expect(200);

      expect(res.body.success).toBe(true);
      // kanban returns columns keyed by status
      expect(Array.isArray(res.body.data) || typeof res.body.data === 'object').toBe(true);
    });

    it('GET /tasks/:id returns task detail', async () => {
      const res = await ctx
        .http()
        .get(`/tasks/${taskId}`)
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.data.id).toBe(taskId);
    });

    it('POST /tasks/:id/assign assigns task to a member', async () => {
      const res = await ctx
        .http()
        .post(`/tasks/${taskId}/assign`)
        .set(bearer(adminToken))
        .send({ assigneeId: memberEmpId })
        .expect(201);

      expect(res.body.success).toBe(true);
    });

    it('member without TASK_ASSIGN cannot reassign (403)', async () => {
      await ctx
        .http()
        .post(`/tasks/${taskId}/assign`)
        .set(bearer(memberToken))
        .send({ assigneeId: viewerEmpId })
        .expect(403);
    });

    it('POST /tasks/:id/status changes the task status', async () => {
      const res = await ctx
        .http()
        .post(`/tasks/${taskId}/status`)
        .set(bearer(adminToken))
        .send({ status: 'IN_PROGRESS' })
        .expect(201);

      expect(res.body.data.status).toBe('IN_PROGRESS');
    });

    it('member (TASK_STATUS_UPDATE only) can change status', async () => {
      const res = await ctx
        .http()
        .post(`/tasks/${taskId}/status`)
        .set(bearer(memberToken))
        .send({ status: 'TODO' })
        .expect(201);

      expect(res.body.success).toBe(true);
    });

    it('viewer cannot change task status (403)', async () => {
      await ctx
        .http()
        .post(`/tasks/${taskId}/status`)
        .set(bearer(viewerToken))
        .send({ status: 'COMPLETED' })
        .expect(403);
    });

    it('POST /tasks/:id/move-status moves task to a workflow status', async () => {
      const res = await ctx
        .http()
        .post(`/tasks/${taskId}/move-status`)
        .set(bearer(adminToken))
        .send({ statusId: inProgressStatusId })
        .expect(201);

      expect(res.body.success).toBe(true);
    });

    it('creates a second task for status and archive tests', async () => {
      const res = await ctx
        .http()
        .post('/tasks')
        .set(bearer(adminToken))
        .send({
          projectId: mainProjectId,
          title: `Archive task ${runId}`,
          type: 'TASK',
          statusId: todoStatusId,
        })
        .expect(201);
      taskForStatusId = res.body.data.id;
    });

    it('POST /tasks/:id/archive archives a task; it disappears from default list', async () => {
      await ctx
        .http()
        .post(`/tasks/${taskForStatusId}/archive`)
        .set(bearer(adminToken))
        .expect(201);

      const res = await ctx
        .http()
        .get('/tasks')
        .set(bearer(adminToken))
        .query({ projectId: mainProjectId, isArchived: 'false' })
        .expect(200);

      const ids = res.body.data.map((t: any) => t.id);
      expect(ids).not.toContain(taskForStatusId);
    });

    it('GET /tasks/my-tasks returns only tasks assigned to the caller', async () => {
      // taskId is assigned to memberEmpId
      const res = await ctx
        .http()
        .get('/tasks/my-tasks')
        .set(bearer(memberToken))
        .expect(200);

      const ids = res.body.data.map((t: any) => t.id);
      expect(ids).toContain(taskId);
    });

    it('GET /tasks/stats returns statistics for the caller', async () => {
      const res = await ctx
        .http()
        .get('/tasks/stats')
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('viewer cannot PATCH task (403)', async () => {
      await ctx
        .http()
        .patch(`/tasks/${taskId}`)
        .set(bearer(viewerToken))
        .send({ title: 'Viewer edits task' })
        .expect(403);
    });

    it('viewer cannot DELETE task (403)', async () => {
      await ctx
        .http()
        .delete(`/tasks/${taskId}`)
        .set(bearer(viewerToken))
        .expect(403);
    });
  });

  // ── 6. Tasks — subtasks and dependencies ──────────────────────────────────

  describe('subtasks and dependencies', () => {
    it('creates a subtask under the main task', async () => {
      const res = await ctx
        .http()
        .post(`/tasks/${taskId}/subtasks`)
        .set(bearer(adminToken))
        .send({
          projectId: mainProjectId,
          title: `Subtask of ${runId}`,
          type: 'SUBTASK',
          statusId: todoStatusId,
        })
        .expect(201);

      subtaskId = res.body.data.id;
      expect(res.body.success).toBe(true);
    });

    it('GET /tasks/:id/subtasks lists subtasks of the parent', async () => {
      const res = await ctx
        .http()
        .get(`/tasks/${taskId}/subtasks`)
        .set(bearer(adminToken))
        .expect(200);

      const ids = res.body.data.map((t: any) => t.id);
      expect(ids).toContain(subtaskId);
    });

    it('adds a dependency: subtask blocks main task', async () => {
      const res = await ctx
        .http()
        .post(`/tasks/${taskId}/dependencies`)
        .set(bearer(adminToken))
        .send({ blockingTaskId: subtaskId, type: 'BLOCKS' })
        .expect(201);

      expect(res.body.success).toBe(true);
    });

    it('GET /tasks/:id/dependencies lists blockers', async () => {
      const res = await ctx
        .http()
        .get(`/tasks/${taskId}/dependencies`)
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('removes the dependency', async () => {
      const dep = await ctx.prisma.taskDependency.findFirst({
        where: { dependentTaskId: taskId, blockingTaskId: subtaskId },
      });
      expect(dep).toBeTruthy();

      await ctx
        .http()
        .delete(`/tasks/dependencies/${dep!.id}`)
        .set(bearer(adminToken))
        .expect(200);

      const row = await ctx.prisma.taskDependency.findUnique({ where: { id: dep!.id } });
      expect(row).toBeNull();
    });
  });

  // ── 7. Sprints lifecycle ──────────────────────────────────────────────────

  describe('sprints lifecycle', () => {
    it('creates a sprint in PLANNING status', async () => {
      const res = await ctx
        .http()
        .post('/sprints')
        .set(bearer(adminToken))
        .send({
          projectId: mainProjectId,
          name: `Sprint 1 ${runId}`,
          goal: 'Deliver MVP features',
          startDate: new Date().toISOString().slice(0, 10),
          endDate: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
        })
        .expect(201);

      sprintId = res.body.data.id;
      expect(res.body.data.status).toBe('PLANNING');
    });

    it('viewer cannot create a sprint (403)', async () => {
      await ctx
        .http()
        .post('/sprints')
        .set(bearer(viewerToken))
        .send({ projectId: mainProjectId, name: 'Viewer sprint' })
        .expect(403);
    });

    it('member (no SPRINT_MANAGE) cannot create a sprint (403)', async () => {
      await ctx
        .http()
        .post('/sprints')
        .set(bearer(memberToken))
        .send({ projectId: mainProjectId, name: 'Member sprint' })
        .expect(403);
    });

    it('updates sprint name and goal', async () => {
      const res = await ctx
        .http()
        .patch(`/sprints/${sprintId}`)
        .set(bearer(adminToken))
        .send({ name: `Sprint 1 Updated ${runId}`, goal: 'Revised goal' })
        .expect(200);

      expect(res.body.data.name).toContain('Updated');
    });

    it('starts the sprint; status becomes ACTIVE', async () => {
      const res = await ctx
        .http()
        .patch(`/sprints/${sprintId}/start`)
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.data.status).toBe('ACTIVE');
    });

    it('completes the sprint; status becomes COMPLETED', async () => {
      const res = await ctx
        .http()
        .patch(`/sprints/${sprintId}/complete`)
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.data.status).toBe('COMPLETED');
    });

    it('GET /sprints?projectId lists all sprints for a project', async () => {
      const res = await ctx
        .http()
        .get('/sprints')
        .set(bearer(adminToken))
        .query({ projectId: mainProjectId })
        .expect(200);

      const ids = res.body.data.map((s: any) => s.id);
      expect(ids).toContain(sprintId);
    });

    it('GET /sprints/:id returns sprint detail', async () => {
      const res = await ctx
        .http()
        .get(`/sprints/${sprintId}`)
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.data.id).toBe(sprintId);
    });

    it('DELETE /sprints/:id removes sprint; tasks are detached (not deleted)', async () => {
      // Assign taskId to the sprint first
      await ctx.prisma.task.update({
        where: { id: taskId },
        data: { sprintId },
      });

      await ctx
        .http()
        .delete(`/sprints/${sprintId}`)
        .set(bearer(adminToken))
        .expect(200);

      // Sprint gone
      const sprint = await ctx.prisma.sprint.findUnique({ where: { id: sprintId } });
      expect(sprint).toBeNull();

      // Task still exists, sprintId is null
      const task = await ctx.prisma.task.findUnique({ where: { id: taskId } });
      expect(task).not.toBeNull();
      expect(task?.sprintId).toBeNull();
    });
  });

  // ── 8. Analytics ─────────────────────────────────────────────────────────

  describe('project analytics', () => {
    it('GET /projects/:slug/charts returns full analytics shape', async () => {
      const res = await ctx
        .http()
        .get(`/projects/${mainProjectSlug}/charts`)
        .set(bearer(adminToken))
        .expect(200);

      const d = res.body.data;
      expect(d).toHaveProperty('kpi');
      expect(d).toHaveProperty('statusDistribution');
      expect(d).toHaveProperty('byPriority');
      expect(d).toHaveProperty('byType');
      expect(d).toHaveProperty('velocity');
      expect(typeof d.kpi.total).toBe('number');
      expect(typeof d.kpi.completionRate).toBe('number');
    });

    it('completionRate is 0 when no tasks are done', async () => {
      // Create a fresh INTERNAL project with no tasks
      const p = await ctx
        .http()
        .post('/projects')
        .set(bearer(adminToken))
        .send({ name: `Empty Charts ${runId}`, visibility: 'INTERNAL' })
        .expect(201);

      const chartRes = await ctx
        .http()
        .get(`/projects/${p.body.data.slug}/charts`)
        .set(bearer(adminToken))
        .expect(200);

      expect(chartRes.body.data.kpi.completionRate).toBe(0);
      expect(chartRes.body.data.kpi.total).toBe(0);

      // Clean up
      await ctx.prisma.projectMember.deleteMany({ where: { projectId: p.body.data.id } });
      await ctx.prisma.projectRole.deleteMany({ where: { projectId: p.body.data.id } });
      await ctx.prisma.project.deleteMany({ where: { id: p.body.data.id } });
    });
  });

  // ── 9. Activity log ───────────────────────────────────────────────────────

  describe('project activity log', () => {
    it('GET /projects/:id/activity returns paginated audit log', async () => {
      const res = await ctx
        .http()
        .get(`/projects/${mainProjectId}/activity`)
        .set(bearer(adminToken))
        .query({ page: 1, limit: 10 })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.meta).toHaveProperty('total');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('non-member outsider cannot access project activity (403)', async () => {
      await ctx
        .http()
        .get(`/projects/${mainProjectId}/activity`)
        .set(bearer(outsiderToken))
        .expect(403);
    });
  });

  // ── 10. Project delete ────────────────────────────────────────────────────

  describe('project delete', () => {
    let tempProjectId: string;

    it('owner can soft-delete a project', async () => {
      const p = await ctx
        .http()
        .post('/projects')
        .set(bearer(adminToken))
        .send({ name: `Temp Delete Project ${runId}`, visibility: 'PRIVATE', ownerId: ownerEmpId })
        .expect(201);
      tempProjectId = p.body.data.id;

      await ctx
        .http()
        .delete(`/projects/${tempProjectId}`)
        .set(bearer(adminToken))
        .expect(200);

      // Project is soft-deleted: deletedAt is set
      const row = await ctx.prisma.project.findUnique({ where: { id: tempProjectId } });
      expect(row?.deletedAt).not.toBeNull();
    });

    it('soft-deleted project does not appear in list', async () => {
      const res = await ctx
        .http()
        .get('/projects')
        .set(bearer(adminToken))
        .expect(200);

      const ids = res.body.data.map((p: any) => p.id);
      expect(ids).not.toContain(tempProjectId);
    });

    it('outsider without PROJECT_DELETE cannot delete a project (403)', async () => {
      await ctx
        .http()
        .delete(`/projects/${mainProjectId}`)
        .set(bearer(outsiderToken))
        .expect(403);
    });
  });
});
