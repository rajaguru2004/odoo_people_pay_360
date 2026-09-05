import { Browser, BrowserContext, Page } from '@playwright/test';
import {
  test,
  expect,
  settle,
  crashesOnly,
  ApiClient,
  runId,
  watchForProblems,
  assertNoCrashes,
} from '../../fixtures';
import { API_URL, FRONTEND_URL, STORAGE_DIR } from '../../playwright.config';
import {
  ProjectsPage,
  ProjectDetailPage,
  ProjectMembersTab,
  ProjectRolesManagerPage,
  ProjectTasksViewPage,
  KanbanPage,
  SprintsTab,
  WorkflowSettingsPage,
} from '../../pages';

/**
 * Project RBAC as a JOURNEY, which is the only thing that makes this file
 * different from the 466 backend cases already behind it.
 *
 * `workplace-project-rbac.e2e-spec.ts` asserts the full 12 × 5 grid live over
 * HTTP, one request per cell. Repeating that here would be repetition. What no
 * API case can reach is the loop a project lead actually closes: open the
 * matrix, tick ONE box, save — and then have the person that role belongs to
 * find they can now do the thing. PRJ-UI-21 does exactly that, with a second
 * browser session for the member, and PRJ-UI-22 takes it away again. Anything
 * less than "the member's screen changed" is a test of a checkbox, not of a
 * permission.
 *
 * ## The matrix is transposed
 *
 * Permissions are ROWS, roles are COLUMNS — `role-matrix-cell-<roleSlug>-<KEY>`.
 * Getting that backwards produces selectors that resolve to nothing and read as
 * "the matrix did not render".
 *
 * ## Why the personas are extra browser contexts
 *
 * Playwright's four role projects are separate processes with no shared state
 * and no ordering between them, so "admin grants it, employee uses it" cannot be
 * split across two of them. Every multi-persona case here therefore runs inside
 * the `admin` project and opens a second context from the storage state
 * `global-setup.ts` already minted for the other role. The seeded personas
 * (`employee1` owns the baseline project, `manager` is a manager-preset member
 * of it) are used where they fit; this file's own project supplies a viewer and
 * an outsider, which the baseline does not have.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const RUN = `${runId}${Math.random().toString(36).slice(2, 6)}`;

const ALL_PERMISSIONS = [
  'PROJECT_EDIT',
  'PROJECT_ARCHIVE',
  'PROJECT_DELETE',
  'MEMBER_MANAGE',
  'ROLE_MANAGE',
  'TASK_CREATE',
  'TASK_ASSIGN',
  'TASK_EDIT',
  'TASK_DELETE',
  'TASK_STATUS_UPDATE',
  'SPRINT_MANAGE',
  'STATUS_MANAGE',
] as const;

interface RoleRow {
  id: string;
  slug: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}

interface EmployeeRow {
  id: string;
  email?: string | null;
  fullName?: string;
}

interface TaskRow {
  id: string;
  taskCode: string;
  title: string;
  statusId: string | null;
}

interface StatusRow {
  id: string;
  name: string;
}

/** Set up once, in the admin project only. */
let projectId = '';
let projectSlug = '';
let roles: RoleRow[] = [];
const createdProjects: string[] = [];

function role(slug: string): RoleRow {
  const found = roles.find((r) => r.slug === slug);
  if (!found) throw new Error(`No ${slug} role on the fixture project`);
  return found;
}

function asRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const data = (payload as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

async function employeeByEmail(api: ApiClient, email: string): Promise<EmployeeRow> {
  const employees = asRows<EmployeeRow>(await api.get('/employees?limit=200'));
  const match = employees.find((e) => e.email === email);
  if (!match) throw new Error(`No employee seeded for ${email}`);
  return match;
}

/**
 * A second signed-in browser, for the persona whose capability is under test.
 *
 * `browser.newContext()` does NOT inherit the config's `use` block, so the
 * baseURL and the timezone are passed explicitly — without the first, every
 * relative `goto` in the persona's page silently fails.
 */
async function persona(
  browser: Browser,
  who: 'employee' | 'manager' | 'hr' | 'admin',
): Promise<{ context: BrowserContext; page: Page; done: () => Promise<void> }> {
  const context = await browser.newContext({
    baseURL: FRONTEND_URL,
    timezoneId: 'UTC',
    storageState: `${STORAGE_DIR}/${who}.json`,
  });
  const page = await context.newPage();
  // The persona's page gets the same crash net as the fixture page. Only the
  // fatal half is asserted: a persona is often looking at a screen it is not
  // meant to be able to use, where a logged 403 is the correct outcome.
  const problems = watchForProblems(page);
  return {
    context,
    page,
    done: async () => {
      assertNoCrashes(problems, `the ${who} persona's page`);
      await context.close();
    },
  };
}

/**
 * Creates a project over the API, retrying once on a 500.
 *
 * NOT defensive padding — a named workaround for R6/R45, which this suite trips
 * on itself. `generateProjectCode()` and `uniqueSlug()` are both read-then-write
 * with no P2002 handler, so two creates that overlap compute the same
 * `project_code`, and the loser comes back as a raw 500 rather than a 409. The
 * three project spec files run in parallel workers and each need a fixture
 * project, which is exactly the overlap. The defect is asserted where it is
 * enforced (`PRJ-API-33/33a`); repeating it in every fixture would only make
 * this suite report the same thing twenty times, flakily.
 */
async function createProject(
  api: ApiClient,
  body: Record<string, unknown>,
): Promise<{ id: string; slug: string }> {
  try {
    return (await api.post('/projects', body)) as { id: string; slug: string };
  } catch (err) {
    if (!/failed: 500/.test(String(err))) throw err;
    await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 600)));
    return (await api.post('/projects', body)) as { id: string; slug: string };
  }
}

test.beforeAll(async ({}, testInfo) => {
  if (testInfo.project.name !== 'admin') return;
  const admin = await ApiClient.as('admin');

  const emp2 = await employeeByEmail(admin, 'employee2@company.com');
  const emp1 = await employeeByEmail(admin, 'employee1@company.com');
  const mgr = await employeeByEmail(admin, 'manager@company.com');

  // PRIVATE, and owned by employee2 — so the admin's own bypass is the only
  // thing granting the admin anything here, and employee1/manager hold exactly
  // the project role they are given below and nothing else.
  const project = await createProject(admin, {
    name: `Journey RBAC ${RUN}`,
    visibility: 'PRIVATE',
    status: 'ACTIVE',
    ownerId: emp2.id,
  });
  projectId = project.id;
  projectSlug = project.slug;
  createdProjects.push(project.id);

  roles = (await admin.get<RoleRow[]>(`/projects/${projectId}/roles`)) as RoleRow[];
  await admin.post(`/projects/${projectId}/members`, {
    employeeIds: [emp1.id],
    roleId: role('viewer').id,
  });
  await admin.post(`/projects/${projectId}/members`, {
    employeeIds: [mgr.id],
    roleId: role('manager').id,
  });

  await admin.dispose();
});

test.afterAll(async () => {
  if (!createdProjects.length) return;
  const admin = await ApiClient.as('admin');
  // The fixture project carries its own copy of the preset roles, so dropping
  // it takes any half-finished toggle with it — nothing shared is left dirty.
  for (const id of createdProjects) await admin.delete(`/projects/${id}`).catch(() => {});
  await admin.dispose();
});

// ── The matrix itself ────────────────────────────────────────────────────────

test.describe('the permission matrix, as the project lead sees it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the matrix journeys run from the admin project');
  });

  test('PRJ-UI-20 the matrix is transposed, and the owner column cannot be touched', async ({
    page,
    problems,
  }) => {
    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('settings');

    const matrix = new ProjectRolesManagerPage(page);
    await expect(matrix.matrix).toBeVisible();

    // Columns are roles...
    for (const slug of ['owner', 'manager', 'member', 'viewer']) {
      await expect(matrix.roleHeader(slug), `a column for ${slug}`).toBeVisible();
    }
    // ...and rows are permissions, all twelve of them.
    for (const key of ALL_PERMISSIONS) {
      await expect(matrix.permissionRow(key), `a row for ${key}`).toBeVisible();
    }

    // The preset shape, read off the screen rather than off the constants file.
    await expect(matrix.matrixCell('manager', 'TASK_CREATE')).toBeChecked();
    await expect(matrix.matrixCell('manager', 'PROJECT_EDIT')).not.toBeChecked();
    await expect(matrix.matrixCell('member', 'TASK_STATUS_UPDATE')).toBeChecked();
    await expect(matrix.matrixCell('member', 'TASK_CREATE')).not.toBeChecked();
    await expect(matrix.matrixCell('viewer', 'TASK_STATUS_UPDATE')).not.toBeChecked();

    /**
     * KNOWN GAP context (R11 / F9). `ProjectRolesService.update()` silently
     * force-restores all twelve permissions when `slug === 'owner'`, answers
     * 200 `success: true` and echoes the full set back — a write the API says it
     * accepted and did not perform. That is confirmed at the API by
     * `PRJ-API-46a/46b`.
     *
     * It is NOT reachable from this screen, and these two assertions are why:
     * every owner cell renders `disabled` with a forced tick, and `dirtyRoleIds`
     * filters the owner role out before anything is sent. Two independent
     * client guards keyed on the same slug. The bug next door — `save()` not
     * comparing what it sent with what came back — IS reachable, and is
     * PRJ-UI-25 below.
     */
    for (const key of ALL_PERMISSIONS) {
      await expect(matrix.matrixCell('owner', key)).toBeChecked();
      await expect(matrix.matrixCell('owner', key)).toBeDisabled();
    }

    // Nothing dirty, so nothing to save.
    await expect(matrix.saveButton).toBeDisabled();
    await expect(matrix.dirtyCount).toHaveCount(0);
    await expect(matrix.error).toHaveCount(0);

    settle(problems, 'the project roles matrix');
  });

  test('PRJ-UI-21 granting TASK_CREATE in the matrix changes what the VIEWER can do', async ({
    page,
    problems,
    browser,
    api,
  }) => {
    const viewer = await persona(browser, 'employee');
    try {
      // ── Before ──────────────────────────────────────────────────────────
      // The viewer can read the project (they are a member) and is offered no
      // way to create work in it — on either the header or the list.
      const viewerDetail = new ProjectDetailPage(viewer.page, projectSlug);
      await viewerDetail.open();
      await expect(viewerDetail.tabs, 'a viewer can open the project').toBeVisible();
      await viewerDetail.openTab('tasks');
      const viewerTasks = new ProjectTasksViewPage(viewer.page);
      await expect(viewerTasks.list).toBeVisible();
      await expect(viewerTasks.newTask, 'no create button for a viewer').toHaveCount(0);
      await expect(viewer.page.getByTestId('task-list-add')).toHaveCount(0);

      // ...and the server agrees, so this is not client-only theatre.
      const viewerApi = await ApiClient.as('employee');
      await expect(
        viewerApi.post('/tasks', { projectId, title: `Refused ${RUN}`, type: 'TASK' }),
      ).rejects.toThrow(/403/);

      // ── The grant, through the real matrix ───────────────────────────────
      const detail = new ProjectDetailPage(page, projectSlug);
      await detail.open();
      await detail.openTab('settings');

      const matrix = new ProjectRolesManagerPage(page);
      await expect(matrix.matrix).toBeVisible();
      await expect(matrix.matrixCell('viewer', 'TASK_CREATE')).not.toBeChecked();

      await matrix.matrixCell('viewer', 'TASK_CREATE').click();
      await expect(matrix.dirtyCount, 'the screen says one role is unsaved').toBeVisible();
      await expect(matrix.saveButton).toBeEnabled();

      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            r.url() === `${API_URL}/projects/${projectId}/roles/${role('viewer').id}`,
          { timeout: 15_000 },
        ),
        matrix.saveButton.click(),
      ]);

      // The matrix reloads from the server after a save, so a tick that is still
      // here is a tick the server sent back.
      await expect(matrix.matrixCell('viewer', 'TASK_CREATE')).toBeChecked();
      await expect(matrix.dirtyCount).toHaveCount(0);
      await expect(matrix.error).toHaveCount(0);

      // And the record.
      const stored = (await api.get<RoleRow[]>(`/projects/${projectId}/roles`)) as RoleRow[];
      expect(stored.find((r) => r.slug === 'viewer')!.permissions).toContain('TASK_CREATE');

      // ── After: the member's own screen, which is the whole point ─────────
      await viewerDetail.open();
      await viewerDetail.openTab('tasks');
      await expect(viewerTasks.newTask, 'the viewer is now offered the control').toBeVisible();

      // ...and can actually use it. A button that appears but 403s would be a
      // worse outcome than no button at all.
      const title = `Viewer Task ${RUN}`;
      await viewer.page.getByTestId('task-list-add').click();
      await viewer.page.getByTestId('task-list-quick-add-title').fill(title);
      const [posted] = await Promise.all([
        viewer.page.waitForResponse(
          (r) => r.request().method() === 'POST' && r.url() === `${API_URL}/tasks`,
          { timeout: 15_000 },
        ),
        viewer.page.getByTestId('task-list-quick-add-submit').click(),
      ]);
      expect(posted.status(), 'the server honoured the grant too').toBeLessThan(400);

      const tasks = (await api.get<TaskRow[]>(`/tasks?projectId=${projectId}&limit=200`)) as TaskRow[];
      const filed = tasks.find((t) => t.title === title);
      expect(filed, 'the viewer really filed it').toBeTruthy();
      await expect(viewerTasks.taskRow(filed!.taskCode)).toBeVisible();

      await viewerApi.dispose();
    } finally {
      await viewer.done();
    }

    settle(problems, 'a permission granted through the matrix');
  });

  test('PRJ-UI-22 revoking it in the matrix takes the capability away again', async ({
    page,
    problems,
    browser,
    api,
  }) => {
    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('settings');

    const matrix = new ProjectRolesManagerPage(page);
    await expect(matrix.matrixCell('viewer', 'TASK_CREATE')).toBeChecked();

    await matrix.matrixCell('viewer', 'TASK_CREATE').click();
    await expect(matrix.dirtyCount).toBeVisible();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          r.url() === `${API_URL}/projects/${projectId}/roles/${role('viewer').id}`,
        { timeout: 15_000 },
      ),
      matrix.saveButton.click(),
    ]);
    await expect(matrix.matrixCell('viewer', 'TASK_CREATE')).not.toBeChecked();

    const stored = (await api.get<RoleRow[]>(`/projects/${projectId}/roles`)) as RoleRow[];
    expect(stored.find((r) => r.slug === 'viewer')!.permissions).toEqual([]);

    // The revoke reaches the viewer's screen, not just the matrix.
    const viewer = await persona(browser, 'employee');
    try {
      const viewerDetail = new ProjectDetailPage(viewer.page, projectSlug);
      await viewerDetail.open();
      await viewerDetail.openTab('tasks');
      await expect(new ProjectTasksViewPage(viewer.page).list).toBeVisible();
      await expect(new ProjectTasksViewPage(viewer.page).newTask).toHaveCount(0);
      await expect(viewer.page.getByTestId('task-list-add')).toHaveCount(0);

      const viewerApi = await ApiClient.as('employee');
      await expect(
        viewerApi.post('/tasks', { projectId, title: `Refused again ${RUN}`, type: 'TASK' }),
      ).rejects.toThrow(/403/);
      await viewerApi.dispose();
    } finally {
      await viewer.done();
    }

    settle(problems, 'a permission revoked through the matrix');
  });

  test('PRJ-UI-25 R67: a discarded write is reported, not mistaken for a save', async ({
    page,
    problems,
    api,
  }) => {
    /**
     * R67 — FIXED. `ProjectRolesManager.save()` used to await the PATCH, treat
     * any resolved promise as success, and then call `load()` — it never
     * compared what it SENT with what came back. So a server answering
     * `200 { success: true }` while changing nothing produced: the tick
     * silently falling back off, the dirty marker clearing (the screen's only
     * "saved" signal), and no error anywhere.
     *
     * The server behaviour that does this in production is R11 — the
     * owner-slug force-restore — and PRJ-UI-20 shows that two client guards
     * keep the owner column out of this code path entirely. There is no
     * editable role the live server discards a write for, so the ONLY way to
     * drive R67 in a real browser is to supply the success-shaped response the
     * client used to mishandle. That is what the route stub below does, and it
     * is stated rather than hidden: the stub replaces the SERVER, not the
     * client, and every assertion afterwards is about what this screen does
     * with an answer it will one day really get.
     *
     * `save()` now diffs the permission set it sent against the one returned
     * and says so when they disagree. The reverted tick STAYS reverted — it is
     * the truth of what the server holds — and the message is what stops that
     * revert reading as a save.
     */
    const memberRole = role('member');
    const before = (await api.get<RoleRow[]>(`/projects/${projectId}/roles`)) as RoleRow[];
    const unchanged = before.find((r) => r.id === memberRole.id)!;

    await page.route(`**/projects/${projectId}/roles/${memberRole.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, message: 'Role updated', data: unchanged }),
      });
    });

    try {
      const detail = new ProjectDetailPage(page, projectSlug);
      await detail.open();
      await detail.openTab('settings');

      const matrix = new ProjectRolesManagerPage(page);
      await expect(matrix.matrixCell('member', 'TASK_CREATE')).not.toBeChecked();

      await matrix.matrixCell('member', 'TASK_CREATE').click();
      await expect(matrix.dirtyCount).toBeVisible();
      await matrix.saveButton.click();

      // The user is told the permission they sent did not come back, and which
      // role it was.
      await expect(matrix.error).toBeVisible();
      await expect(matrix.error).toContainText('Member');
      // The box is still unticked, because that is what the server holds — the
      // screen is now honest about both facts at once rather than silent about
      // one of them.
      await expect(matrix.matrixCell('member', 'TASK_CREATE')).not.toBeChecked();

      // The write really was discarded.
      const after = (await api.get<RoleRow[]>(`/projects/${projectId}/roles`)) as RoleRow[];
      expect(after.find((r) => r.id === memberRole.id)!.permissions).toEqual(unchanged.permissions);
    } finally {
      await page.unroute(`**/projects/${projectId}/roles/${memberRole.id}`);
    }

    settle(problems, 'a discarded role write');
  });
});

// ── Role projection, per persona ─────────────────────────────────────────────

test.describe('what each role is offered on a project', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the persona journeys run from the admin project');
    });

    test('PRJ-UI-23 a VIEWER is offered no write control anywhere on the project', async ({
      problems,
      browser,
    }) => {
      crashesOnly(problems);

      const viewer = await persona(browser, 'employee');
      try {
        const detail = new ProjectDetailPage(viewer.page, projectSlug);
        await detail.open();
        await expect(detail.tabs).toBeVisible();

        // Header: no edit.
        await expect(detail.editButton).toHaveCount(0);

        // Tasks: no create, and the board offers no workflow settings.
        await detail.openTab('tasks');
        await expect(new ProjectTasksViewPage(viewer.page).newTask).toHaveCount(0);
        await new ProjectTasksViewPage(viewer.page).kanbanView.click();
        await expect(new KanbanPage(viewer.page).board).toBeVisible();
        await expect(new WorkflowSettingsPage(viewer.page).openButton).toHaveCount(0);

        // Sprints: no create.
        await detail.openTab('sprints');
        await expect(new SprintsTab(viewer.page).createButton).toHaveCount(0);

        // Members: readable, but no add, no role select, no remove.
        await detail.openTab('members');
        const members = new ProjectMembersTab(viewer.page);
        await expect(members.table).toBeVisible();
        await expect(members.addEmployee).toHaveCount(0);
        await expect(members.addButton).toHaveCount(0);
        expect(await viewer.page.locator('[data-testid^="member-role-select-"]').count()).toBe(0);
        expect(await viewer.page.locator('[data-testid^="member-remove-"]').count()).toBe(0);

        // Settings: the tab exists for everyone, and is empty of everything.
        await detail.openTab('settings');
        await expect(detail.settingsEdit).toHaveCount(0);
        await expect(detail.archiveButton).toHaveCount(0);
        await expect(detail.unarchiveButton).toHaveCount(0);
        await expect(viewer.page.getByTestId('role-matrix')).toHaveCount(0);
      } finally {
        await viewer.done();
      }
    });

    test('PRJ-UI-24 a MANAGER-preset member gets the task controls and none of the project ones', async ({
      problems,
      browser,
    }) => {
      crashesOnly(problems);

      const mgr = await persona(browser, 'manager');
      try {
        const detail = new ProjectDetailPage(mgr.page, projectSlug);
        await detail.open();
        await expect(detail.tabs).toBeVisible();

        // The preset is task ×5 + SPRINT_MANAGE + STATUS_MANAGE, and no more.
        await detail.openTab('tasks');
        await expect(new ProjectTasksViewPage(mgr.page).newTask, 'TASK_CREATE').toBeVisible();
        await new ProjectTasksViewPage(mgr.page).kanbanView.click();
        await expect(new KanbanPage(mgr.page).board).toBeVisible();
        await expect(
          new WorkflowSettingsPage(mgr.page).openButton,
          'STATUS_MANAGE',
        ).toBeVisible();

        await detail.openTab('sprints');
        await expect(new SprintsTab(mgr.page).createButton, 'SPRINT_MANAGE').toBeVisible();

        // ...and nothing that would let them reshape the project itself.
        await expect(detail.editButton, 'no PROJECT_EDIT').toHaveCount(0);
        await detail.openTab('members');
        await expect(new ProjectMembersTab(mgr.page).addButton, 'no MEMBER_MANAGE').toHaveCount(0);
        await detail.openTab('settings');
        await expect(detail.settingsEdit).toHaveCount(0);
        await expect(detail.archiveButton, 'no PROJECT_ARCHIVE').toHaveCount(0);
        await expect(mgr.page.getByTestId('role-matrix'), 'no ROLE_MANAGE').toHaveCount(0);
      } finally {
        await mgr.done();
      }
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'the HR half of GLOBAL_ADMIN_ROLES');
    });

    test('PRJ-UI-26 an HR_MANAGER who is a member of nothing gets every control', async ({
      page,
      problems,
    }) => {
      // `GLOBAL_ADMIN_ROLES = ['ADMIN','HR_MANAGER']` bypasses every project
      // permission. The HR half of that had never been exercised before this
      // phase, at either layer. The subject is the seeded PRIVATE project, whose
      // members are the manager alone.
      const hrApi = await ApiClient.as('hr');
      const priv = (await hrApi.get<{ id: string; slug: string }>(
        '/projects/by-slug/e2e-baseline-private',
      )) as { id: string; slug: string };
      const access = (await hrApi.get<{ isGlobalAdmin: boolean; permissions: string[] }>(
        `/projects/${priv.id}/my-permissions`,
      )) as { isGlobalAdmin: boolean; permissions: string[] };
      expect(access.isGlobalAdmin).toBe(true);
      expect(access.permissions.sort()).toEqual([...ALL_PERMISSIONS].sort());

      const members = (await hrApi.get<Array<{ employee?: { email?: string } }>>(
        `/projects/${priv.id}/members`,
      )) as Array<{ employee?: { email?: string } }>;
      expect(
        members.map((m) => m.employee?.email),
        'the bypass is not a membership',
      ).not.toContain('hr.manager@company.com');
      await hrApi.dispose();

      // A PRIVATE project they are not in, on their list...
      const list = new ProjectsPage(page);
      await list.open();
      await expect(list.card('e2e-baseline-private')).toBeVisible();

      // ...and every control on it.
      const detail = new ProjectDetailPage(page, 'e2e-baseline-private');
      await detail.open();
      await expect(detail.editButton).toBeVisible();
      await detail.openTab('members');
      await expect(new ProjectMembersTab(page).addButton).toBeVisible();
      await detail.openTab('settings');
      await expect(detail.settingsEdit).toBeVisible();
      await expect(detail.archiveButton).toBeVisible();
      await expect(page.getByTestId('role-matrix')).toBeVisible();

      settle(problems, 'a PRIVATE project seen by HR');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the manager path');
    });

    test('PRJ-UI-27 a manager-preset member of the seeded project gets tasks, not the project', async ({
      page,
      problems,
    }) => {
      // The same projection as PRJ-UI-24, but on the seeded baseline rather than
      // on a fixture this file built — so a change to `presetRolesCreateData()`
      // and a change to the seed are both caught.
      const detail = new ProjectDetailPage(page, 'e2e-baseline-project');
      await detail.open();
      await expect(detail.tabs).toBeVisible();
      await expect(detail.editButton, 'the manager preset has no PROJECT_EDIT').toHaveCount(0);

      await detail.openTab('tasks');
      await expect(new ProjectTasksViewPage(page).newTask, 'it does have TASK_CREATE').toBeVisible();

      await detail.openTab('settings');
      await expect(detail.archiveButton).toHaveCount(0);
      await expect(page.getByTestId('role-matrix')).toHaveCount(0);

      settle(problems, 'the seeded project as a manager-preset member');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the outsider is the employee here');
    });

    test('PRJ-UI-28 an OUTSIDER is refused a PRIVATE project even by direct URL', async ({
      page,
      problems,
    }) => {
      crashesOnly(problems);

      // employee1 is a member of the seeded INTERNAL project and of nothing else.
      // `e2e-baseline-private` is not on their list, and typing its slug does not
      // help: the by-slug read carries `@RequireProjectMembership`.
      const list = new ProjectsPage(page);
      await list.open();
      await expect(list.card('e2e-baseline-private')).toHaveCount(0);

      const detail = new ProjectDetailPage(page);
      const [refusal] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/projects/by-slug/e2e-baseline-private'), {
          timeout: 15_000,
        }),
        detail.open('e2e-baseline-private'),
      ]);
      expect(refusal.status()).toBe(403);
      await expect(detail.notFound).toBeVisible();
      await expect(detail.tabs).toHaveCount(0);

      settle(problems, 'a PRIVATE project reached by URL');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee1 owns the seeded project');
    });

    test('PRJ-UI-29 the project OWNER gets every control, whatever their global role', async ({
      page,
      problems,
    }) => {
      // The contrast that makes the model legible: the same EMPLOYEE who is
      // refused `e2e-baseline-private` outright holds all twelve permissions on
      // `e2e-baseline-project`, because `getAccess()` grants owner rights on
      // `ownerId` alone. Project authority is per project, not per global role.
      const empApi = await ApiClient.as('employee');
      const proj = (await empApi.get<{ id: string }>(
        '/projects/by-slug/e2e-baseline-project',
      )) as { id: string };
      const access = (await empApi.get<{ isOwner: boolean; permissions: string[] }>(
        `/projects/${proj.id}/my-permissions`,
      )) as { isOwner: boolean; permissions: string[] };
      expect(access.isOwner).toBe(true);
      expect(access.permissions.sort()).toEqual([...ALL_PERMISSIONS].sort());
      await empApi.dispose();

      const detail = new ProjectDetailPage(page, 'e2e-baseline-project');
      await detail.open();
      await expect(detail.editButton).toBeVisible();
      await detail.openTab('members');
      await expect(new ProjectMembersTab(page).addButton).toBeVisible();
      await detail.openTab('settings');
      await expect(detail.archiveButton).toBeVisible();
      await expect(page.getByTestId('role-matrix'), 'ROLE_MANAGE, as an EMPLOYEE').toBeVisible();

      // ...while `/dashboard/projects/new` stays shut, because CREATE_PROJECT is
      // a GLOBAL permission and owning one project grants nothing about making
      // another.
      const list = new ProjectsPage(page);
      await list.open();
      await expect(list.newButton).toHaveCount(0);

      settle(problems, 'the seeded project as its owner');
    });
  });
});
