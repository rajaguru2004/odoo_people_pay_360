import { Page } from '@playwright/test';
import { test, expect, settle, crashesOnly, renderOnly, ApiClient, runId } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import {
  ProjectDetailPage,
  ProjectTasksViewPage,
  KanbanPage,
  TaskDetailPage,
  SprintsTab,
  WorkflowSettingsPage,
  captureNativeDialogs,
} from '../../pages';

/**
 * The task tracker, driven the way a team drives it: a card is created on a
 * form, dragged across a board, opened, edited, commented on, and put in a
 * sprint — and every one of those is re-read over the API afterwards, because a
 * board that only moved its own state is exactly the failure this file exists
 * to catch.
 *
 * The single most valuable case here is TSK-UI-02. `handleMove` in
 * `ProjectTasksView` updates the columns optimistically and, if the write
 * fails, calls `load()` and says nothing at all — so a board can show a card in
 * Done while the server still has it in To Do for as long as it takes someone to
 * reload. No API test can see that, and no assertion short of "drag it, then ask
 * the server" can either.
 *
 * ## dnd-kit and Playwright
 *
 * `KanbanPage.dragCardTo` exists because Playwright's `dragTo` synthesises an
 * HTML5 drag, and dnd-kit listens for pointer events — the synthetic drag never
 * reaches the library, the card never moves, and the case fails for a reason
 * that has nothing to do with the product. The page object drives press → a
 * first small move past the 8px activation constraint → a move over the target
 * dropzone → release, which is the sequence dnd-kit's own tests use.
 *
 * ## Subject
 *
 * A project of this file's own, created per role project and soft-deleted in
 * `afterAll`. The seeded `e2e-baseline-project` is never written to here: it is
 * the subject of the sibling specs, and a task or sprint left on it would move
 * their counts.
 *
 * ## The shared workflow
 *
 * Every project in the baseline hangs off the one `Default Workflow`, so
 * renaming a column in TSK-UI-12 changes every board in the database — that is
 * F10/R7, confirmed at the API. The case therefore renames to a run-unique
 * string and restores the original name before it ends.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const RUN = `${runId}${Math.random().toString(36).slice(2, 6)}`;

interface StatusRow {
  id: string;
  name: string;
  category: string;
  position: number;
}

interface TaskRow {
  id: string;
  taskCode: string;
  title: string;
  priority: string;
  statusId: string | null;
  parentTaskId?: string | null;
  sprintId?: string | null;
}

interface SprintRow {
  id: string;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
}

interface CommentRow {
  id: string;
  comment: string;
}

interface DependencyPayload {
  dependsOn: Array<{ id: string; blockingTask?: { id: string; taskCode: string } }>;
  blocks: Array<{ id: string; dependentTask?: { id: string; taskCode: string } }>;
}

/** Set up once per role project, in `beforeAll`. */
let projectId = '';
let projectSlug = '';
let statuses: StatusRow[] = [];
const createdProjects: string[] = [];

function statusByName(name: string): StatusRow {
  const found = statuses.find((s) => s.name === name);
  if (!found) throw new Error(`No workflow status named ${name} — statuses: ${statuses.map((s) => s.name).join(', ')}`);
  return found;
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
  // Only the admin project drives this file: every case here writes, and the
  // role projections belong to `workplace-project-rbac.spec.ts`.
  if (testInfo.project.name !== 'admin') return;
  const admin = await ApiClient.as('admin');
  const project = await createProject(admin, {
    name: `Journey Tasks ${RUN}`,
    visibility: 'INTERNAL',
    status: 'ACTIVE',
  });
  projectId = project.id;
  projectSlug = project.slug;
  createdProjects.push(project.id);
  statuses = (await admin.get<StatusRow[]>(`/project-statuses?projectId=${projectId}`)) as StatusRow[];
  await admin.dispose();
});

test.afterAll(async () => {
  if (!createdProjects.length) return;
  const admin = await ApiClient.as('admin');
  for (const id of createdProjects) await admin.delete(`/projects/${id}`).catch(() => {});
  await admin.dispose();
});

/** Opens the tasks tab in the board view and waits for the columns. */
async function openBoard(page: Page): Promise<KanbanPage> {
  const detail = new ProjectDetailPage(page, projectSlug);
  await detail.open();
  await detail.openTab('tasks');
  await new ProjectTasksViewPage(page).kanbanView.click();
  const board = new KanbanPage(page);
  await expect(board.board).toBeVisible();
  await expect(board.column(statusByName('To Do').id)).toBeVisible();
  return board;
}

// ── Creating work ────────────────────────────────────────────────────────────

test.describe('a task, from the form that files it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the tracker is driven from the admin project');
  });

  test('TSK-UI-01 a task created through the form lands on the board, and the API agrees', async ({
    page,
    problems,
    api,
  }) => {
    const title = `Journey Task ${RUN}`;
    const todo = statusByName('To Do');

    await page.goto(`/dashboard/projects/${projectSlug}/tasks/new`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForLoadState('networkidle').catch(() => {});

    await page.getByTestId('task-form-title').fill(title);
    await page.getByTestId('task-status-select').selectOption(todo.id);
    await page.getByTestId('task-priority-select').selectOption('HIGH');
    await page.getByTestId('task-form-submit').click();

    // The form returns to the project once the task is filed.
    await page.waitForURL(`**/dashboard/projects/${projectSlug}`, { timeout: 20_000 });

    // Re-read over the API before believing the screen.
    const tasks = (await api.get<TaskRow[]>(`/tasks?projectId=${projectId}&limit=200`)) as TaskRow[];
    const stored = tasks.find((t) => t.title === title);
    expect(stored, 'the task is readable over the API').toBeTruthy();
    expect(stored!.priority).toBe('HIGH');
    expect(stored!.statusId).toBe(todo.id);

    // ...and it is on the list the team looks at.
    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.openTab('tasks');
    const view = new ProjectTasksViewPage(page);
    await expect(view.taskRow(stored!.taskCode)).toBeVisible();

    settle(problems, 'the project board after a task create');
  });

  test('TSK-UI-02 a card dragged between columns moves on the SERVER, not just on the board', async ({
    page,
    problems,
    api,
  }) => {
    const todo = statusByName('To Do');
    const inProgress = statusByName('In Progress');
    const before = (await api.get<TaskRow[]>(`/tasks?projectId=${projectId}&limit=200`)) as TaskRow[];
    const subject = before.find((t) => t.statusId === todo.id);
    expect(subject, 'TSK-UI-01 left a card in To Do to drag').toBeTruthy();

    const board = await openBoard(page);
    await expect(board.card(subject!.taskCode)).toBeVisible();

    const [move] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().startsWith(`${API_URL}/tasks/`) &&
          r.url().endsWith('/move-status'),
        { timeout: 20_000 },
      ),
      board.dragCardTo(subject!.taskCode, inProgress.id),
    ]);
    expect(move.status(), 'the board actually asked the server to move it').toBeLessThan(400);

    // The board shows it in the new column...
    await expect(board.dropzone(inProgress.id).getByTestId(`task-card-${subject!.taskCode}`)).toBeVisible();

    // ...and so does the server, which is the half `handleMove`'s optimistic
    // update cannot be trusted for: on failure it reverts silently and tells
    // nobody, so "it looks moved" and "it moved" are genuinely different facts.
    const after = (await api.get<TaskRow>(`/tasks/${subject!.id}`)) as TaskRow;
    expect(after.statusId).toBe(inProgress.id);

    // And it survives a reload, which is what a colleague would see.
    await openBoard(page);
    await expect(board.dropzone(inProgress.id).getByTestId(`task-card-${subject!.taskCode}`)).toBeVisible();
    await expect(board.dropzone(todo.id).getByTestId(`task-card-${subject!.taskCode}`)).toHaveCount(0);

    settle(problems, 'a card dragged across the board');
  });

  test('TSK-UI-03 the detail drawer renames a task, and the rename persists', async ({
    page,
    problems,
    api,
  }) => {
    // The drawer used to log `MISSING_MESSAGE: taskDetailShared.statusLabel`
    // on every render (R77, now fixed and locked by TSK-UI-13). The relaxed
    // judgement stays because the drawer's own network noise — an optional
    // attachments read, a labels read on a project with none — is logged as a
    // console error by the browser and is not this case's subject.
    crashesOnly(problems);

    const tasks = (await api.get<TaskRow[]>(`/tasks?projectId=${projectId}&limit=200`)) as TaskRow[];
    const subject = tasks[0];
    expect(subject, 'there is a task to open').toBeTruthy();

    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('tasks');
    const view = new ProjectTasksViewPage(page);
    await view.taskRow(subject.taskCode).click();

    const drawer = new TaskDetailPage(page);
    await expect(drawer.drawer).toBeVisible();
    await expect(drawer.code).toContainText(subject.taskCode);

    const renamed = `${subject.title} (renamed ${RUN})`;
    await drawer.title.click();
    await drawer.titleInput.fill(renamed);
    await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && r.url() === `${API_URL}/tasks/${subject.id}`,
        { timeout: 15_000 },
      ),
      drawer.saveButton.click(),
    ]);
    await expect(drawer.title).toHaveText(renamed);

    // The record, not the drawer.
    const stored = (await api.get<TaskRow>(`/tasks/${subject.id}`)) as TaskRow;
    expect(stored.title).toBe(renamed);

    // And on the list after a full reload — `patch()` is optimistic and reverts
    // in silence if the write fails, so the reload is the honest check.
    await drawer.drawerClose.click();
    await detail.open();
    await detail.openTab('tasks');
    await expect(view.taskRow(subject.taskCode)).toContainText(renamed);

    settle(problems, 'a task renamed from the drawer');
  });

  test('TSK-UI-04 a subtask added in the drawer is stored under its parent', async ({
    page,
    problems,
    api,
  }) => {
    // The drawer used to log `MISSING_MESSAGE: taskDetailShared.statusLabel`
    // on every render (R77, now fixed and locked by TSK-UI-13). The relaxed
    // judgement stays because the drawer's own network noise — an optional
    // attachments read, a labels read on a project with none — is logged as a
    // console error by the browser and is not this case's subject.
    crashesOnly(problems);

    const tasks = (await api.get<TaskRow[]>(`/tasks?projectId=${projectId}&limit=200`)) as TaskRow[];
    const parent = tasks[0];

    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('tasks');
    await new ProjectTasksViewPage(page).taskRow(parent.taskCode).click();

    const drawer = new TaskDetailPage(page);
    await expect(drawer.drawer).toBeVisible();

    const childTitle = `Journey Subtask ${RUN}`;
    await page.getByTestId('subtask-add').click();
    await page.getByTestId('subtask-title').fill(childTitle);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url() === `${API_URL}/tasks/${parent.id}/subtasks`,
        { timeout: 15_000 },
      ),
      page.getByTestId('subtask-submit').click(),
    ]);

    const children = (await api.get<TaskRow[]>(`/tasks/${parent.id}/subtasks`)) as TaskRow[];
    const child = children.find((c) => c.title === childTitle);
    expect(child, 'the subtask is stored against the parent').toBeTruthy();
    expect(child!.parentTaskId).toBe(parent.id);

    await expect(drawer.subtask(child!.taskCode)).toBeVisible();

    settle(problems, 'a subtask added in the drawer');
  });

  test('TSK-UI-05 a dependency added in the drawer renders and is stored', async ({
    page,
    problems,
    api,
  }) => {
    // The drawer used to log `MISSING_MESSAGE: taskDetailShared.statusLabel`
    // on every render (R77, now fixed and locked by TSK-UI-13). The relaxed
    // judgement stays because the drawer's own network noise — an optional
    // attachments read, a labels read on a project with none — is logged as a
    // console error by the browser and is not this case's subject.
    crashesOnly(problems);

    // Two tasks of this case's own, created over the API — this case is about
    // the dependency panel, not about the create form a second time.
    const blocker = (await api.post<TaskRow>('/tasks', {
      projectId,
      title: `Journey Blocker ${RUN}`,
      type: 'TASK',
      statusId: statusByName('To Do').id,
    })) as TaskRow;
    const dependent = (await api.post<TaskRow>('/tasks', {
      projectId,
      title: `Journey Dependent ${RUN}`,
      type: 'TASK',
      statusId: statusByName('To Do').id,
    })) as TaskRow;

    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('tasks');
    await new ProjectTasksViewPage(page).taskRow(dependent.taskCode).click();

    const drawer = new TaskDetailPage(page);
    await expect(drawer.drawer).toBeVisible();
    await expect(drawer.dependencyEmpty).toBeVisible();

    await page.getByTestId('dependency-select').selectOption(blocker.id);
    await page.getByTestId('dependency-add').click();

    await expect(drawer.dependency(blocker.taskCode)).toBeVisible();
    await expect(drawer.dependencyEmpty).toHaveCount(0);

    const stored = (await api.get<DependencyPayload>(
      `/tasks/${dependent.id}/dependencies`,
    )) as DependencyPayload;
    expect(stored.dependsOn.map((d) => d.blockingTask?.id)).toContain(blocker.id);

    settle(problems, 'a dependency added in the drawer');
  });

  test('TSK-UI-06 a comment posted through the drawer reaches the thread', async ({
    page,
    problems,
    api,
  }) => {
    // The drawer used to log `MISSING_MESSAGE: taskDetailShared.statusLabel`
    // on every render (R77, now fixed and locked by TSK-UI-13). The relaxed
    // judgement stays because the drawer's own network noise — an optional
    // attachments read, a labels read on a project with none — is logged as a
    // console error by the browser and is not this case's subject.
    crashesOnly(problems);

    // Its own subject, so "the thread starts empty" is a fact rather than a
    // hope about which task the list happened to sort first.
    const subject = (await api.post<TaskRow>('/tasks', {
      projectId,
      title: `Journey Commented ${RUN}`,
      type: 'TASK',
      statusId: statusByName('To Do').id,
    })) as TaskRow;

    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('tasks');
    await new ProjectTasksViewPage(page).taskRow(subject.taskCode).click();

    const drawer = new TaskDetailPage(page);
    await expect(drawer.drawer).toBeVisible();
    await expect(drawer.commentEmpty).toBeVisible();

    const body = `Journey comment ${RUN}`;
    await drawer.commentInput.fill(body);
    await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url() === `${API_URL}/task-comments`,
        { timeout: 15_000 },
      ),
      drawer.commentSubmit.click(),
    ]);

    const thread = (await api.get<CommentRow[]>(`/task-comments/task/${subject.id}`)) as CommentRow[];
    const stored = thread.find((c) => c.comment === body);
    expect(stored, 'the comment is on the thread the API serves').toBeTruthy();

    await expect(drawer.comment(stored!.id)).toBeVisible();
    await expect(drawer.commentEmpty).toHaveCount(0);
    // The box is cleared, so a second click cannot post it twice.
    await expect(drawer.commentInput).toHaveValue('');

    settle(problems, 'a comment posted from the drawer');
  });
});

// ── The label that never arrived, and now has ────────────────────────────────

test.describe('the task drawer and its Status label', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the tracker is driven from the admin project');
  });

  test('TSK-UI-13 R77: the Status field carries a translated label, in both bundles', async ({
    page,
    problems,
    api,
  }) => {
    crashesOnly(problems);

    /**
     * R77 — FIXED. Found by this file, not predicted at planning time.
     *
     * `taskDetailShared.statusLabel` existed in neither `messages/en/projects.json`
     * nor `messages/ar/projects.json`, and two screens asked for it:
     * `TaskDetailDrawer.tsx:567` and
     * `app/dashboard/projects/[slug]/tasks/[taskId]/page.tsx:468`. next-intl
     * answers a missing key by logging `MISSING_MESSAGE` and rendering the key
     * PATH, so the Status property block was labelled
     * `taskDetailShared.statusLabel` — in both languages — on every task any
     * user opened. Its neighbours (`priorityLabel`, `sprintLabel`,
     * `assigneesLabel`, `reporterLabel`) were all present, so this was one
     * omission rather than a missing namespace.
     *
     * Both halves are locked: the console must be quiet about the key, and the
     * label must read as a word rather than as a path. Asserting only the
     * second would pass on a bundle that merely happened to contain the string.
     */
    const tasks = (await api.get<TaskRow[]>(`/tasks?projectId=${projectId}&limit=200`)) as TaskRow[];
    const subject = tasks.find((t) => !t.parentTaskId)!;

    const missing: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /MISSING_MESSAGE/.test(msg.text())) missing.push(msg.text());
    });

    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('tasks');
    await new ProjectTasksViewPage(page).taskRow(subject.taskCode).click();

    const drawer = new TaskDetailPage(page);
    await expect(drawer.drawer).toBeVisible();
    await expect(drawer.field('status')).toBeVisible();

    expect(missing.join('\n'), 'the drawer asked for a key that does not exist').not.toMatch(
      /MISSING_MESSAGE/,
    );
    await expect(drawer.field('status')).not.toContainText('taskDetailShared.statusLabel');
    await expect(drawer.field('status')).toContainText('Status');
  });
});

// ── R23: the refusal, now styled, translated and pointed at a field ──────────

test.describe('the task form and how it refuses', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the tracker is driven from the admin project');
  });

  test('TSK-UI-09 R23: an out-of-range story point is refused in the page, before any request', async ({
    page,
    problems,
    api,
  }) => {
    renderOnly(problems);

    /**
     * R23 — FIXED, both halves.
     *
     * `app/dashboard/projects/[slug]/tasks/new/page.tsx` used to report failure
     * through `alert()` twice — line 225 for a missing title, line 260 for
     * anything the server refused. Same class as `docs/TESTING.md` §Recorded
     * defects #4, the payroll `window.confirm`/`prompt`/`alert` group Phase 4
     * fixed for payroll and left everywhere else.
     *
     * The MISSING-TITLE half was unreachable: the submit button carries
     * `disabled={submitting || !title.trim()}` and is `type="button"` inside a
     * page with no `<form onSubmit>`, so neither a click nor Enter reached line
     * 225. `alert(t('errorTitleRequired'))` was dead code, and the only thing a
     * user with no title got was a greyed-out button that said nothing. That is
     * unchanged and still asserted below — the button IS the message for an
     * empty title, and the dead alert is gone.
     *
     * The REACHABLE half was Story Points: a plain `type="number"` with
     * `min={0}` and no upper bound over an int4 column, so any value past
     * 2^31−1 came back an unmapped 500 (F18/R61) and the user got a NATIVE
     * dialog reading only "Failed to create task." — no field marked, nothing
     * left on the screen, and the form still looking ready to submit.
     *
     * Now: the input carries an upper bound, the submit checks it, and the
     * refusal is an in-page element beside the form. `captureNativeDialogs` is
     * still installed, because "the form said nothing at all" and "the form
     * used a dialog" are different failures and this case has to tell them
     * apart.
     */
    const dialogs = captureNativeDialogs(page);

    await page.goto(`/dashboard/projects/${projectSlug}/tasks/new`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForLoadState('networkidle').catch(() => {});

    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url() === `${API_URL}/tasks`) posts.push(r.url());
    });

    // The title half: whitespace is not a title, and the button that cannot be
    // pressed is the whole message.
    await page.getByTestId('task-form-title').fill('   ');
    await expect(page.getByTestId('task-form-submit')).toBeDisabled();
    expect(dialogs.length, 'nothing was said about the missing title').toBe(0);

    // The story-points half.
    const before = (await api.get<TaskRow[]>(`/tasks?projectId=${projectId}&limit=200`)) as TaskRow[];
    await page.getByTestId('task-form-title').fill(`Journey Overflow ${RUN}`);

    // The input declares its own ceiling, so the browser's stepper and a
    // pasted value are bounded by the same number the submit checks.
    const max = await page.getByTestId('task-form-story-points').getAttribute('max');
    expect(Number(max), 'story points carry an upper bound').toBeGreaterThan(0);
    expect(Number(max)).toBeLessThan(2 ** 31 - 1);

    await page.getByTestId('task-form-story-points').fill('2147483648');
    await page.getByTestId('task-form-submit').click();

    // In the page, where the field is — not in a dialog that vanishes with the
    // reason.
    await expect(
      page.getByTestId('task-form-error'),
      'an in-page message, the way every other form in this app reports one',
    ).toBeVisible();
    await expect(page.getByTestId('task-form-error')).toContainText(String(max));
    expect(dialogs, 'the form used a native dialog').toHaveLength(0);

    // And it never reached the server, so the 500 the user used to provoke is
    // not provoked at all.
    expect(posts, 'an out-of-range estimate was posted anyway').toHaveLength(0);
    expect(new URL(page.url()).pathname).toBe(`/dashboard/projects/${projectSlug}/tasks/new`);

    const after = (await api.get<TaskRow[]>(`/tasks?projectId=${projectId}&limit=200`)) as TaskRow[];
    expect(after.length).toBe(before.length);

    // Corrected, the same form goes through — the bound is a bound, not a wall.
    await page.getByTestId('task-form-story-points').fill('5');
    await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url() === `${API_URL}/tasks`,
        { timeout: 15_000 },
      ),
      page.getByTestId('task-form-submit').click(),
    ]);
    await expect
      .poll(
        async () =>
          ((await api.get<TaskRow[]>(`/tasks?projectId=${projectId}&limit=200`)) as TaskRow[]).length,
        { timeout: 15_000 },
      )
      .toBe(before.length + 1);
    expect(dialogs, 'the successful path used a native dialog').toHaveLength(0);
  });
});

// ── Sprints ──────────────────────────────────────────────────────────────────

/**
 * The cancel controls, addressed by testid rather than through `SprintsTab`.
 *
 * `e2e/pages/index.ts` is shared by every project spec and is not this change's
 * to grow; these four belong on `SprintsTab` and should be lifted there the next
 * time that file is opened. The selectors are the convention either way —
 * `data-testid`, never the label, which exists in en and ar.
 */
const cancelButton = (page: Page, id: string) => page.getByTestId(`sprint-cancel-${id}`);
const cancelConfirm = (page: Page, id: string) => page.getByTestId(`sprint-cancel-confirm-${id}`);
const cancelYes = (page: Page, id: string) => page.getByTestId(`sprint-cancel-yes-${id}`);
/** What the close says it did to the backlog — R39/R37. One per tab, not per row. */
const closeNotice = (page: Page) => page.getByTestId('sprint-close-notice');

test.describe('a sprint, through the tab that runs it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the tracker is driven from the admin project');
  });

  let sprintId = '';

  test('TSK-UI-07 a sprint created in the tab appears, and the API agrees', async ({
    page,
    problems,
    api,
  }) => {
    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('sprints');

    const sprints = new SprintsTab(page);
    await expect(sprints.empty, 'a new project has no sprints').toBeVisible();

    const name = `Journey Sprint ${RUN}`;
    await sprints.createButton.click();
    await expect(sprints.form).toBeVisible();
    await sprints.formName.fill(name);
    await sprints.formGoal.fill('the goal, as typed by a person');
    await sprints.formStart.fill('2026-09-01');
    await sprints.formEnd.fill('2026-09-14');
    await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url() === `${API_URL}/sprints`,
        { timeout: 15_000 },
      ),
      sprints.formSubmit.click(),
    ]);

    const stored = (await api.get<SprintRow[]>(`/sprints?projectId=${projectId}`)) as SprintRow[];
    const created = stored.find((s) => s.name === name);
    expect(created, 'the sprint is readable over the API').toBeTruthy();
    expect(created!.status).toBe('PLANNING');
    sprintId = created!.id;

    await expect(sprints.row(sprintId)).toBeVisible();
    await expect(sprints.status(sprintId)).toBeVisible();
    await expect(sprints.empty).toHaveCount(0);

    // R37 — the verbs a PLANNING sprint offers. Cancel is one of them: the
    // decision was PLANNING *or* ACTIVE → CANCELLED, so a sprint can be
    // abandoned before it ever runs, which is the commoner of the two.
    await expect(cancelButton(page, sprintId), 'cancel is offered on PLANNING').toBeVisible();
    await expect(sprints.completeButton(sprintId)).toHaveCount(0);

    settle(problems, 'a sprint created from the tab');
  });

  test('TSK-UI-08 starting the sprint moves it to ACTIVE on both sides', async ({
    page,
    problems,
    api,
  }) => {
    expect(sprintId, 'TSK-UI-07 created a sprint').toBeTruthy();

    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('sprints');

    const sprints = new SprintsTab(page);
    await expect(sprints.startButton(sprintId)).toBeVisible();
    await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && r.url() === `${API_URL}/sprints/${sprintId}/start`,
        { timeout: 15_000 },
      ),
      sprints.startButton(sprintId).click(),
    ]);

    const stored = (await api.get<SprintRow[]>(`/sprints?projectId=${projectId}`)) as SprintRow[];
    expect(stored.find((s) => s.id === sprintId)!.status).toBe('ACTIVE');

    // The tab swaps Start for Complete, which is the only signal the screen gives.
    await expect(sprints.completeButton(sprintId)).toBeVisible();
    await expect(sprints.startButton(sprintId)).toHaveCount(0);
    // Cancel survives the transition — a sprint can be abandoned mid-flight, and
    // that is the case where the backlog sweep actually has work to move.
    await expect(cancelButton(page, sprintId), 'cancel is offered on ACTIVE').toBeVisible();

    settle(problems, 'a sprint started from the tab');
  });

  test('TSK-UI-10 completing the sprint closes it on both sides', async ({
    page,
    problems,
    api,
  }) => {
    expect(sprintId, 'TSK-UI-07 created a sprint').toBeTruthy();

    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('sprints');

    const sprints = new SprintsTab(page);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          r.url() === `${API_URL}/sprints/${sprintId}/complete`,
        { timeout: 15_000 },
      ),
      sprints.completeButton(sprintId).click(),
    ]);

    const stored = (await api.get<SprintRow[]>(`/sprints?projectId=${projectId}`)) as SprintRow[];
    const done = stored.find((s) => s.id === sprintId)!;
    expect(done.status).toBe('COMPLETED');

    /**
     * R39 — the close says what it moved.
     *
     * Completing now detaches the sprint's still-open tasks in the same
     * transaction and reports the count as `tasksReturnedToBacklog`. Rows the
     * click never named have changed, so the screen owes the user a sentence;
     * without one, unfinished work simply vanishes off the board. The NUMBER is
     * left to the component spec — how many of this file's tasks are in the
     * sprint depends on cases above — but the sentence being there at all is
     * this journey's business, and it is a sticky line rather than a toast
     * precisely so it is still readable after the list reloads.
     */
    await expect(closeNotice(page), 'the close reports the backlog sweep').toBeVisible();

    // No verb is offered on a completed sprint — which is the SCREEN enforcing
    // what the service used to leave open: F12/R30 records that `start()` and
    // `complete()` never read the current status, so a COMPLETED sprint could be
    // restarted over HTTP. `assertTransition` closes that server-side now, and
    // these hidden buttons are the client half.
    await expect(sprints.completeButton(sprintId)).toHaveCount(0);
    await expect(sprints.startButton(sprintId)).toHaveCount(0);
    // Cancel included: COMPLETED is terminal, so there is nothing left to abandon.
    await expect(cancelButton(page, sprintId)).toHaveCount(0);
    await expect(sprints.row(sprintId)).toBeVisible();

    settle(problems, 'a sprint completed from the tab');
  });

  test('TSK-UI-11 R37 cancelling is a confirmed verb of its own, and CANCELLED is terminal', async ({
    page,
    problems,
    api,
  }) => {
    /**
     * R37 — `SprintStatus.CANCELLED` was near-dead: unreachable through both
     * lifecycle verbs and settable only through the generic `PATCH /sprints/:id`,
     * where it had no message and no side effects. Cancelling was
     * indistinguishable from renaming, and a CANCELLED sprint restarted to
     * ACTIVE. `PATCH /sprints/:id/cancel` is the decision; this case is the
     * client half of it.
     *
     * Its own sprint, deliberately dateless: the range-overlap rule refuses two
     * sprints in one project that cover the same days, and this case is not
     * about that rule.
     */
    const detail = new ProjectDetailPage(page, projectSlug);
    await detail.open();
    await detail.openTab('sprints');

    const sprints = new SprintsTab(page);
    const name = `Abandoned Sprint ${RUN}`;
    await sprints.createButton.click();
    await expect(sprints.form).toBeVisible();
    await sprints.formName.fill(name);
    await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url() === `${API_URL}/sprints`,
        { timeout: 15_000 },
      ),
      sprints.formSubmit.click(),
    ]);

    const afterCreate = (await api.get<SprintRow[]>(`/sprints?projectId=${projectId}`)) as SprintRow[];
    const doomed = afterCreate.find((s) => s.name === name);
    expect(doomed, 'the sprint to cancel is readable over the API').toBeTruthy();
    const doomedId = doomed!.id;

    // A cancel is not undoable and it empties the sprint of its open work, so
    // the first click asks rather than acts. Nothing is sent until the second.
    await cancelButton(page, doomedId).click();
    await expect(cancelConfirm(page, doomedId)).toBeVisible();

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          r.url() === `${API_URL}/sprints/${doomedId}/cancel`,
        { timeout: 15_000 },
      ),
      cancelYes(page, doomedId).click(),
    ]);

    const stored = (await api.get<SprintRow[]>(`/sprints?projectId=${projectId}`)) as SprintRow[];
    expect(stored.find((s) => s.id === doomedId)!.status).toBe('CANCELLED');

    // Terminal, and visibly so. The row stays — a sprint that disappeared would
    // be the old "cancel is indistinguishable from nothing" defect in new
    // clothes — and it offers no way back to ACTIVE.
    await expect(sprints.row(doomedId)).toBeVisible();
    await expect(sprints.status(doomedId)).toBeVisible();
    await expect(sprints.startButton(doomedId)).toHaveCount(0);
    await expect(sprints.completeButton(doomedId)).toHaveCount(0);
    await expect(cancelButton(page, doomedId), 'CANCELLED cannot be re-cancelled').toHaveCount(0);

    // The same sentence the completion gets: this sprint had no tasks, so it
    // reports a plain close rather than a count, which is the point — the line
    // is not conditional on there being something to report.
    await expect(closeNotice(page)).toBeVisible();

    settle(problems, 'a sprint cancelled from the tab');
  });
});

// ── The board's own shape ────────────────────────────────────────────────────

test.describe('the workflow behind the board', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the tracker is driven from the admin project');
  });

  test('TSK-UI-12 renaming a column in the settings modal renames it on the board', async ({
    page,
    problems,
    api,
  }) => {
    const target = statusByName('In Review');
    const renamed = `In Review ${RUN}`;

    const board = await openBoard(page);
    const workflow = new WorkflowSettingsPage(page);
    await expect(workflow.openButton, 'STATUS_MANAGE is offered on the board').toBeVisible();
    await workflow.openButton.click();
    await expect(workflow.modal).toBeVisible();

    try {
      await workflow.editButton(target.id).click();
      await workflow.nameInput(target.id).fill(renamed);
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            r.url() === `${API_URL}/project-statuses/${target.id}`,
          { timeout: 15_000 },
        ),
        workflow.saveButton(target.id).click(),
      ]);
      await expect(workflow.name(target.id)).toHaveText(renamed);

      // The record.
      const stored = (await api.get<StatusRow[]>(
        `/project-statuses?projectId=${projectId}`,
      )) as StatusRow[];
      expect(stored.find((s) => s.id === target.id)!.name).toBe(renamed);

      // ...and the board behind the modal, which is the point: a column that
      // renames itself in a dialog and not on the board is a lie a user acts on.
      await workflow.done.click();
      await expect(workflow.modal).toHaveCount(0);
      await expect(board.column(target.id)).toContainText(renamed);
    } finally {
      // The workflow is SHARED by every project in this database (F10/R7), so
      // leaving this rename behind would rename a column on boards no case here
      // owns — including the seeded baseline project other specs assert on.
      const admin = await ApiClient.as('admin');
      await admin.patch(`/project-statuses/${target.id}`, { name: target.name }).catch(() => {});
      await admin.dispose();
    }

    settle(problems, 'a renamed workflow column');
  });
});
