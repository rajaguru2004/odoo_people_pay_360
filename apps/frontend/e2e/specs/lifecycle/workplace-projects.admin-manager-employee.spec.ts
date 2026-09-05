import { test, expect, settle, crashesOnly, ApiClient, runId } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import {
  ProjectsPage,
  ProjectFormPage,
  ProjectDetailPage,
  ProjectMembersTab,
  ProjectTasksViewPage,
  ProjectActivityLogPage,
  SprintsTab,
  captureNativeDialogs,
  dismissNativeDialogs,
} from '../../pages';

/**
 * The project register, from the screens that build it.
 *
 * The API half of this module is closed — 466 backend cases across nine suites,
 * every server rule asserted where it is enforced. What none of them can see is
 * what the person clicking the button is TOLD. So every business action here is
 * performed through a real form or dialog and then re-read over the API, which
 * is the only way to prove the screen did not simply update its own state and
 * call it done.
 *
 * ## What this file replaces
 *
 * `e2e/specs/lifecycle/projects.spec.ts` (16 cases, from `3c22f56`) set every
 * piece of state over the API and asserted `settle()` — "the page did not
 * crash". Three of its assertions were genuine and are carried across: the
 * `projectCode` shape (PRJ-UI-02), a PRIVATE project being absent from an
 * employee's list (PRJ-UI-13), and an employee refused `/dashboard/projects/new`
 * plus `POST /projects` (PRJ-UI-14). It also carried two `test.skip(true, ...)`
 * blocks and one silent pass — the member-role case returned early with
 * `settle()` instead of skipping, so it reported green having asserted nothing —
 * all of which plan §11 requires to be gone. It is deleted with this file.
 *
 * ## The seeded subjects
 *
 * `e2e-baseline-project` — INTERNAL, all four preset roles populated, three
 * members (employee1 as owner, manager on the `manager` preset, employee2 on
 * `member`). `e2e-baseline-private` — PRIVATE, owned by the manager. Neither is
 * mutated here; anything this file changes it creates for itself and soft-deletes
 * in `afterAll`.
 *
 * ## Concurrency note
 *
 * The four role projects share one database and can run at the same time. Every
 * list assertion here is therefore either a comparison against the exact payload
 * THIS page load received, or a statement about a named subject — never a count
 * another worker could move.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Unique per role project and per run, so two workers cannot collide on a name. */
const RUN = `${runId}${Math.random().toString(36).slice(2, 6)}`;
const tag = () => `${test.info().project.name}-${RUN}`;

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  projectCode: string;
  status: string;
  priority: string;
  visibility: string;
  isArchived: boolean;
  ownerId?: string | null;
  owner?: { id: string; fullName: string } | null;
}

interface Stats {
  total: number;
  active: number;
  completed: number;
  onHold: number;
}

interface EmployeeRow {
  id: string;
  email?: string | null;
  fullName?: string;
}

/** Every project this file created, torn down at the end of the run. */
const created: string[] = [];

/** `/employees` answers either a bare array or a paginated envelope. */
function asRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const data = (payload as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

/**
 * The create form navigates to the project it just made. `/dashboard/projects/new`
 * matches the same "one segment after /projects" shape, so a bare regex is
 * satisfied by the page the test is standing on and the slug reads as `new`.
 */
const onProjectDetail = (url: URL): boolean =>
  /^\/dashboard\/projects\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith('/new');

async function employeeByEmail(api: ApiClient, email: string): Promise<EmployeeRow> {
  const employees = asRows<EmployeeRow>(await api.get('/employees?limit=200'));
  const match = employees.find((e) => e.email === email);
  if (!match) throw new Error(`No employee seeded for ${email}`);
  return match;
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

test.afterAll(async () => {
  if (!created.length) return;
  const admin = await ApiClient.as('admin');
  for (const id of created) await admin.delete(`/projects/${id}`).catch(() => {});
  await admin.dispose();
});

// ── Admin: the register itself ───────────────────────────────────────────────

test.describe('the project register, as an admin builds it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'administrative screen');
  });

  test('PRJ-UI-01 the list agrees with the API, and the tiles with the list', async ({
    page,
    problems,
  }) => {
    // Both payloads THIS page load received. Fetching them again afterwards
    // would race a concurrent create in another role project and report a
    // one-off difference as a defect.
    const list = new ProjectsPage(page);
    const [listResponse, statsResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/projects?`) &&
          !r.url().includes('/stats'),
      ),
      page.waitForResponse(
        (r) => r.request().method() === 'GET' && r.url().startsWith(`${API_URL}/projects/stats`),
      ),
      list.open(),
    ]);
    const projects = ((await listResponse.json())?.data ?? []) as ProjectRow[];
    const stats = ((await statsResponse.json())?.data ?? {}) as Stats;

    // Every project the API returned has a card, and no card was invented.
    expect((await list.visibleSlugs()).sort()).toEqual(projects.map((p) => p.slug).sort());
    await expect(list.card('e2e-baseline-project')).toBeVisible();
    // An ADMIN is in GLOBAL_ADMIN_ROLES and bypasses visibility entirely, so
    // the PRIVATE project is on this list too.
    await expect(list.card('e2e-baseline-private')).toBeVisible();

    await expect(list.stat('total')).toContainText(String(stats.total));
    await expect(list.stat('active')).toContainText(String(stats.active));
    await expect(list.stat('on-hold')).toContainText(String(stats.onHold));
    await expect(list.stat('completed')).toContainText(String(stats.completed));

    settle(problems, 'the project list');
  });

  test('PRJ-UI-02 a project created through the form appears, and the API agrees', async ({
    page,
    problems,
    api,
  }) => {
    const name = `Journey Project ${tag()}`;
    const form = new ProjectFormPage(page);
    await form.open();
    await form.create({
      name,
      description: 'created through the real form',
      status: 'ACTIVE',
      priority: 'HIGH',
      visibility: 'INTERNAL',
    });

    // The form navigates to the project it just made — the first proof it landed.
    await page.waitForURL(onProjectDetail, { timeout: 20_000 });
    const slug = new URL(page.url()).pathname.split('/').pop()!;
    expect(slug).not.toBe('new');

    // Re-read over the API: the screen is not the record.
    const projects = asRows<ProjectRow>(await api.get('/projects?limit=200'));
    const stored = projects.find((p) => p.slug === slug);
    expect(stored, 'the created project is readable over the API').toBeTruthy();
    created.push(stored!.id);

    expect(stored!.name).toBe(name);
    expect(stored!.status).toBe('ACTIVE');
    expect(stored!.priority).toBe('HIGH');
    expect(stored!.visibility).toBe('INTERNAL');
    // Carried across from projects.spec.ts — the one genuine assertion it made
    // about the code. `generateProjectCode()` pads to four digits.
    expect(stored!.projectCode).toMatch(/^PROJ-\d{4}$/);

    // And the card exists, carrying the code the API reported.
    await new ProjectsPage(page).open();
    await expect(new ProjectsPage(page).card(slug)).toBeVisible();
    await expect(new ProjectsPage(page).card(slug)).toContainText(stored!.projectCode);

    settle(problems, 'the project list after a create');
  });

  test('PRJ-UI-03 the create form refuses to submit without a name', async ({ page, problems }) => {
    const form = new ProjectFormPage(page);
    await form.open();
    await expect(form.root).toBeVisible();

    // The whole guard is the submit button's own disabled state. There is no
    // error banner for a missing name, so a user who never fills it in is
    // simply stuck with a button that does nothing and says nothing.
    await expect(form.submit).toBeDisabled();
    await form.name.fill('   ');
    await expect(form.submit, 'whitespace is not a name').toBeDisabled();
    await form.name.fill('Named at last');
    await expect(form.submit).toBeEnabled();
    await expect(form.error, 'nothing was ever said out loud').toHaveCount(0);

    await form.cancel.click();
    await page.waitForURL('**/dashboard/projects', { timeout: 15_000 });
    settle(problems, 'the project create form');
  });

  test('PRJ-UI-04 search narrows the list, and a miss shows the empty state', async ({
    page,
    problems,
  }) => {
    const list = new ProjectsPage(page);
    await list.open();
    await expect(list.card('e2e-baseline-project')).toBeVisible();

    await list.search.fill('E2E Baseline Private');
    await expect(list.card('e2e-baseline-private')).toBeVisible();
    await expect(list.card('e2e-baseline-project')).toHaveCount(0);

    // The server searches name OR projectCode, so the code is a valid query too
    // — and the only one a user with a printed report in hand would think of.
    await list.search.fill('PROJ-9001');
    await expect(list.card('e2e-baseline-project')).toBeVisible();
    await expect(list.card('e2e-baseline-private')).toHaveCount(0);

    await list.search.fill(`no-such-project-${RUN}`);
    await expect(list.empty).toBeVisible();
    await expect(list.createFirst, 'an admin is offered the way out').toBeVisible();

    await list.search.fill('');
    await expect(list.card('e2e-baseline-project')).toBeVisible();
    settle(problems, 'the project search');
  });

  test('PRJ-UI-05 the status and priority filters narrow the list, and clear again', async ({
    page,
    problems,
    api,
  }) => {
    // Two subjects of this file's own with known, differing values, so the
    // assertions do not depend on what any other worker has created.
    const activeHigh = await createProject(api, {
      name: `Journey Filter High ${tag()}`,
      visibility: 'PRIVATE',
      status: 'ACTIVE',
      priority: 'HIGH',
    });
    const holdLow = await createProject(api, {
      name: `Journey Filter Low ${tag()}`,
      visibility: 'PRIVATE',
      status: 'ON_HOLD',
      priority: 'LOW',
    });
    created.push(activeHigh.id, holdLow.id);

    const list = new ProjectsPage(page);
    await list.open();

    await list.statusFilter.selectOption('ACTIVE');
    await expect(list.card(activeHigh.slug)).toBeVisible();
    await expect(list.card(holdLow.slug)).toHaveCount(0);

    await list.statusFilter.selectOption('ON_HOLD');
    await expect(list.card(holdLow.slug)).toBeVisible();
    await expect(list.card(activeHigh.slug)).toHaveCount(0);

    await list.statusFilter.selectOption('');
    await list.priorityFilter.selectOption('HIGH');
    await expect(list.card(activeHigh.slug)).toBeVisible();
    await expect(list.card(holdLow.slug)).toHaveCount(0);

    await list.priorityFilter.selectOption('LOW');
    await expect(list.card(holdLow.slug)).toBeVisible();
    await expect(list.card(activeHigh.slug)).toHaveCount(0);

    await list.priorityFilter.selectOption('');
    await expect(list.card(activeHigh.slug)).toBeVisible();
    await expect(list.card(holdLow.slug)).toBeVisible();
    settle(problems, 'the project filters');
  });

  test('PRJ-UI-06 all seven detail tabs load', async ({ page, problems, api }) => {
    const detail = new ProjectDetailPage(page, 'e2e-baseline-project');
    await detail.open();
    await expect(detail.tabs).toBeVisible();

    // overview — the stat trio and the side rail, checked against the record
    const stored = (await api.get<ProjectRow & { owner?: { fullName: string } }>(
      '/projects/by-slug/e2e-baseline-project',
    )) as ProjectRow & { owner?: { fullName: string } };
    await expect(detail.overviewStat('tasks')).toBeVisible();
    await expect(detail.overviewStat('members')).toBeVisible();
    await expect(detail.overviewStat('sprints')).toBeVisible();
    await expect(detail.detail('owner')).toContainText(stored.owner!.fullName);

    // tasks — the view switcher is this tab's own furniture
    await detail.openTab('tasks');
    const tasks = new ProjectTasksViewPage(page);
    await expect(tasks.listView).toBeVisible();
    await expect(tasks.kanbanView).toBeVisible();

    // calendar — deliberately has no testids (plan §12 keeps `ProjectCalendar`
    // route-matrix only), so its month grid is the structural handle.
    await detail.openTab('calendar');
    await expect(page.locator('.grid.grid-cols-7').first()).toBeVisible();

    await detail.openTab('sprints');
    const sprints = new SprintsTab(page);
    await expect(sprints.createButton.or(sprints.empty).first()).toBeVisible();

    // members — the baseline seeds exactly three, one per preset that has a holder
    await detail.openTab('members');
    await expect(new ProjectMembersTab(page).table).toBeVisible();
    expect(await page.locator('[data-testid^="member-row-"]').count()).toBe(3);

    await detail.openTab('activity');
    const activity = new ProjectActivityLogPage(page);
    await expect(activity.list.or(activity.empty).first()).toBeVisible();

    // settings — an admin bypasses every project permission, so all three
    // panels (edit, danger zone, roles matrix) are here
    await detail.openTab('settings');
    await expect(detail.settingsEdit).toBeVisible();
    await expect(detail.archiveButton).toBeVisible();
    await expect(page.getByTestId('role-matrix')).toBeVisible();

    settle(problems, 'the seven project tabs');
  });

  test('PRJ-UI-07 archiving is a disappearance, the archive filter finds it, and unarchiving brings it back', async ({
    page,
    problems,
    api,
  }) => {
    // Five full page loads plus two writes; on a loaded machine this one case
    // genuinely needs more than the 45s default.
    test.slow();

    // A subject of this file's own, so the shared baseline is never archived
    // out from under a spec running beside this one.
    const stored = await createProject(api, {
      name: `Journey Archive ${tag()}`,
      visibility: 'INTERNAL',
      status: 'ACTIVE',
    });
    created.push(stored.id);

    const detail = new ProjectDetailPage(page, stored.slug);
    await detail.open();
    await detail.openTab('settings');

    await expect(detail.archiveButton).toBeVisible();
    await detail.archiveButton.click();
    // The button's testid flips with `isArchived`, so that flip IS the reload.
    await expect(detail.unarchiveButton).toBeVisible();

    // The disappearance, asserted where a user would notice it.
    const list = new ProjectsPage(page);
    await list.open();
    await expect(list.card(stored.slug)).toHaveCount(0);

    /**
     * R78 — FIXED. `buildWhere()` sets `isArchived: false` unless the query
     * asks otherwise, and until now nothing in the UI could ask: the list
     * offered a status filter and a priority filter and no archived one, so an
     * archived project was reachable only by typing its slug into the address
     * bar. The API had always taken `?isArchived=true`.
     *
     * The filter is asserted through the SCREEN rather than by re-reading the
     * API, because "the row still exists" was never in doubt — "a user can get
     * back to it" was.
     */
    const archivedFilter = page.getByTestId('project-archived-filter');
    await expect(
      archivedFilter,
      'an archived filter beside the status and priority ones',
    ).toBeVisible();
    await archivedFilter.selectOption('true');
    await expect(list.card(stored.slug)).toBeVisible({ timeout: 15_000 });

    // …and it is a filter, not a widening: the live projects drop out of the
    // archived view, so the two lists cannot be confused for one another.
    const archivedSlugs = await list.visibleSlugs();
    expect(archivedSlugs).toContain(stored.slug);

    // Back to the live list, and it is gone again.
    await archivedFilter.selectOption('');
    await expect(list.card(stored.slug)).toHaveCount(0);

    // Back again for real, through the same screen.
    await detail.open();
    await detail.openTab('settings');
    await detail.unarchiveButton.click();
    await expect(detail.archiveButton).toBeVisible();

    await list.open();
    await expect(list.card(stored.slug)).toBeVisible();
    settle(problems, 'the archive round trip');
  });

  test('PRJ-UI-08 R22: a project is deleted from the Settings tab, behind a confirmation that names it', async ({
    page,
    problems,
    api,
  }) => {
    /**
     * R22, fixed. `PROJECT_DELETE` is one of the twelve catalogued project
     * permissions: granted, enforced by `ProjectPermissionGuard`, covered at
     * the API — and, until this pass, invokable by nobody. The danger zone on
     * the Settings tab stopped at archive, so an admin whose own
     * `my-permissions` returned `PROJECT_DELETE` had no way to exercise it, on
     * this tab or any of the other six.
     *
     * The control is gated on the project permission, not on a global role, and
     * guarded by the same native `confirm()` `ProjectRolesManager.removeRole`
     * uses two panels down.
     */
    const stored = await createProject(api, {
      name: `Journey Delete ${tag()}`,
      visibility: 'PRIVATE',
    });
    created.push(stored.id);

    // The permission this whole finding is about, asserted from the same door
    // the screen reads it through.
    const access = (await api.get<{ permissions: string[] }>(
      `/projects/${stored.id}/my-permissions`,
    )) as { permissions: string[] };
    expect(access.permissions).toContain('PROJECT_DELETE');

    const detail = new ProjectDetailPage(page, stored.slug);
    await detail.open();
    await detail.openTab('settings');

    // Archive is still there and still separate: they are different decisions
    // and the screen must not have swapped one for the other.
    await expect(detail.archiveButton).toBeVisible();
    const deleteButton = page.getByTestId('project-delete');
    await expect(deleteButton).toBeVisible();

    // ── The confirmation is dismissed: nothing happens ────────────────────
    const asked = dismissNativeDialogs(page);
    await deleteButton.click();
    await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(1);

    // It names the project, because "are you sure?" against the wrong project
    // is the mistake the prompt exists to catch — and it says what the server
    // actually does. `ProjectsService.remove` writes `deletedAt`, so calling it
    // permanent would be untrue and calling it reversible would be worse.
    expect(asked[0]).toContain(`Journey Delete ${tag()}`);
    expect(asked[0]).toMatch(/soft delete/i);

    // Dismissed means dismissed: still on the page, still in the API.
    await expect(deleteButton).toBeVisible();
    const survivor = await api.get<{ id: string }>(`/projects/${stored.id}`);
    expect(survivor.id).toBe(stored.id);

    settle(problems, 'the project delete confirmation');
  });

  test('PRJ-UI-08b R22: confirming the delete removes the project and returns to the list', async ({
    page,
    problems,
    api,
  }) => {
    const stored = await createProject(api, {
      name: `Journey Deleted ${tag()}`,
      visibility: 'PRIVATE',
    });
    created.push(stored.id);

    const list = new ProjectsPage(page);
    const detail = new ProjectDetailPage(page, stored.slug);
    await detail.open();
    await detail.openTab('settings');

    const asked = captureNativeDialogs(page);
    await page.getByTestId('project-delete').click();
    await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(1);

    // The screen goes back to the register — staying on the detail page of a
    // project that no longer exists is how a "not found" panel gets blamed on
    // the wrong thing.
    await page.waitForURL('**/dashboard/projects', { timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe('/dashboard/projects');
    // Wait for the register to have RENDERED before asserting an absence — a
    // count of zero on a list that has not loaded yet is not evidence of
    // anything.
    await expect(list.search).toBeVisible({ timeout: 15_000 });
    await list.search.fill(`Journey Deleted ${tag()}`);
    await expect(list.empty).toBeVisible({ timeout: 15_000 });
    await expect(list.card(stored.slug)).toHaveCount(0);

    // And the server agrees, which is the half a screen cannot fake: the soft
    // delete filters it out of every read.
    await expect(api.get(`/projects/${stored.id}`)).rejects.toThrow(/404/);

    settle(problems, 'deleting a project through the Settings tab');
  });

  test('PRJ-UI-09 F11/R6: consecutive creates keep incrementing the project code', async ({
    page,
    problems,
    api,
  }) => {
    /**
     * KNOWN GAP (F11 / R6) — read this before believing the assertions below.
     *
     * `generateProjectCode()` takes the LEXICAL maximum `project_code` and does
     * `parseInt(code.replace('PROJ-',''), 10) + 1`. Any code whose first
     * character sorts above `'P'` becomes that maximum, the parse yields NaN,
     * and the generator emits the literal string `PROJ-0NaN`. `project_code` is
     * `@unique`, so exactly one row can hold it: the first create returns 201
     * and every later create in that database answers a raw 500 until the row is
     * removed. Confirmed at the API by `PRJ-API-33/33a/33b/33c`.
     *
     * It is NOT reachable from a browser against `ess_baseline`. The only two
     * seeded codes are `PROJ-9001` and `PROJ-9002`, and `projectCode` is not a
     * field on `CreateProjectDto` — there is no write path through the API or
     * the UI that puts a non-`PROJ-<digits>` code in the table. The backend
     * fixtures reach it only because they seed `WP…` codes through Prisma
     * directly. So the second create does NOT 500 here, and asserting that it
     * does would be asserting a fiction.
     *
     * There is deliberately no `test.fail()` twin: a twin that cannot fail is a
     * silent pass, which is exactly what this phase is removing. What this case
     * is instead is the tripwire — it asserts the generator is in its working
     * state, and goes red the day anything seeds a code sorting above `'P'`,
     * which is the precise condition that breaks project creation for the whole
     * database.
     */
    const form = new ProjectFormPage(page);

    await form.open();
    await form.create({ name: `Journey Seq A ${tag()}`, visibility: 'PRIVATE' });
    await page.waitForURL(onProjectDetail, { timeout: 20_000 });
    const slugA = new URL(page.url()).pathname.split('/').pop()!;

    await form.open();
    await form.create({ name: `Journey Seq B ${tag()}`, visibility: 'PRIVATE' });
    await page.waitForURL(onProjectDetail, { timeout: 20_000 });
    const slugB = new URL(page.url()).pathname.split('/').pop()!;
    expect(slugB, 'the second create produced its own project').not.toBe(slugA);

    // No error banner was ever raised, on either create.
    await expect(form.error).toHaveCount(0);

    const projects = asRows<ProjectRow>(await api.get('/projects?limit=200'));
    const a = projects.find((p) => p.slug === slugA)!;
    const b = projects.find((p) => p.slug === slugB)!;
    created.push(a.id, b.id);

    expect(a.projectCode).toMatch(/^PROJ-\d{4}$/);
    expect(b.projectCode).toMatch(/^PROJ-\d{4}$/);
    expect(
      Number(b.projectCode.slice(5)) > Number(a.projectCode.slice(5)),
      'the second code is past the first — the parse-max generator is healthy',
    ).toBe(true);

    settle(problems, 'two consecutive project creates');
  });
});

// ── Employee: what visibility actually shows them ────────────────────────────

test.describe('the project register, as an employee meets it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), "the employee's own view");
  });

  test('PRJ-UI-12 R51: an INTERNAL project is listed, and it opens', async ({
    page,
    problems,
  }) => {
    // REGRESSION LOCK (R51/R51b, fixed). `buildWhere()` has always put every
    // INTERNAL project in everyone's list, while the by-slug read was guarded by
    // membership alone — so the card was offered and clicking it was a dead end.
    // What the user was left holding made it worse: a global "Access Denied"
    // modal from the axios interceptor, stacked over a panel saying the project
    // was not found. Two different wrong explanations for one situation, and
    // neither of them was "you are not a member".
    //
    // The read door now honours visibility — INTERNAL and PUBLIC are readable by
    // any authenticated user, which is what those visibilities mean — so the
    // list and the detail finally agree. PRJ-UI-13 holds the other side: PRIVATE
    // is still absent and still refused.
    const admin = await ApiClient.as('admin');
    const outsider = await createProject(admin, {
      name: `Journey Internal Outsider ${tag()}`,
      visibility: 'INTERNAL',
      status: 'ACTIVE',
    });
    created.push(outsider.id);
    await admin.dispose();

    const list = new ProjectsPage(page);
    await list.open();
    await expect(list.card(outsider.slug)).toBeVisible();

    const [read] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/projects/by-slug/${outsider.slug}`), {
        timeout: 15_000,
      }),
      list.card(outsider.slug).click(),
    ]);
    expect(read.status(), 'the server admits a non-member to an INTERNAL project').toBe(200);

    // The card led somewhere. No "not found" panel, no permission modal.
    const detail = new ProjectDetailPage(page);
    await expect(detail.tabs).toBeVisible();
    await expect(detail.notFound).toBeHidden();
    await expect(page.getByTestId('permission-denied-modal')).toBeHidden();

    // Read only: being able to OPEN it must not have handed them anything else.
    // The write half is asserted at the API by PRJ-API-16b.
    await expect(detail.editButton).toHaveCount(0);

    settle(problems, 'an INTERNAL project opened by a non-member');
  });

  test("PRJ-UI-13 a PRIVATE project is absent from the employee's list", async ({
    page,
    problems,
  }) => {
    // Carried across from projects.spec.ts, which asserted it over the API
    // only. The subject is seeded (`e2e-baseline-private`, owned by the
    // manager), so "absent" is about a row that provably exists rather than one
    // that might never have been created.
    const list = new ProjectsPage(page);
    await list.open();
    await expect(list.card('e2e-baseline-project'), 'INTERNAL, and they are the owner').toBeVisible();
    await expect(list.card('e2e-baseline-private')).toHaveCount(0);

    const empApi = await ApiClient.as('employee');
    const visible = asRows<ProjectRow>(await empApi.get('/projects?limit=200'));
    expect(visible.map((p) => p.slug)).not.toContain('e2e-baseline-private');
    await empApi.dispose();

    settle(problems, "a PRIVATE project and the employee's list");
  });

  test('PRJ-UI-14 the employee is refused the create screen, and the API behind it', async ({
    page,
    problems,
  }) => {
    crashesOnly(problems);

    // Client guard: `CREATE_PROJECT` is not in the EMPLOYEE permission set.
    await page.goto('/dashboard/projects/new', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(new URL(page.url()).pathname).toBe('/403');

    // The list drops the affordance too, rather than offering a button that 403s.
    const list = new ProjectsPage(page);
    await list.open();
    await expect(list.newButton).toHaveCount(0);
    await expect(list.card('e2e-baseline-project')).toBeVisible();

    // And the server says the same, so this is not client-only theatre.
    const empApi = await ApiClient.as('employee');
    await expect(
      empApi.post('/projects', { name: `Journey Refused ${tag()}`, visibility: 'PRIVATE' }),
    ).rejects.toThrow(/403/);
    await empApi.dispose();

    settle(problems, 'the create screen as an employee');
  });
});

// ── Manager: R16, the correction this phase made to the oracle ───────────────

test.describe('the project register, as a manager uses it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('manager'), 'the manager path');
  });

  test('PRJ-UI-15 R16: a manager reaches the create screen and creates a project', async ({
    page,
    problems,
  }) => {
    // `e2e/routes.ts` recorded `usableBy: ADMIN_HR` for this route until WP-0
    // corrected it — the oracle was wrong in the generous direction, telling the
    // suite to expect a denial, so nothing ever checked. `POST /projects`
    // carries `@Roles('ADMIN','HR_MANAGER','MANAGER')` and the client agrees.
    const list = new ProjectsPage(page);
    await list.open();
    await expect(list.newButton, 'the manager is offered the button').toBeVisible();

    const name = `Journey Manager Project ${tag()}`;
    const form = new ProjectFormPage(page);
    await form.open();
    expect(new URL(page.url()).pathname).toBe('/dashboard/projects/new');
    await expect(form.root).toBeVisible();

    await form.create({ name, visibility: 'PRIVATE', status: 'PLANNING' });
    await page.waitForURL(onProjectDetail, { timeout: 20_000 });
    const slug = new URL(page.url()).pathname.split('/').pop()!;

    const mgrApi = await ApiClient.as('manager');
    const projects = asRows<ProjectRow>(await mgrApi.get('/projects?limit=200'));
    const stored = projects.find((p) => p.slug === slug);
    expect(stored, 'the manager really created it').toBeTruthy();
    created.push(stored!.id);
    expect(stored!.name).toBe(name);

    // The creator becomes the owner, which is what makes the project usable to
    // them afterwards. A MANAGER who could create but not then edit would be a
    // worse hole than the one the stale oracle claimed.
    const managerEmployee = await employeeByEmail(mgrApi, 'manager@company.com');
    expect(stored!.ownerId ?? stored!.owner?.id).toBe(managerEmployee.id);

    const access = (await mgrApi.get<{ isOwner: boolean; permissions: string[] }>(
      `/projects/${stored!.id}/my-permissions`,
    )) as { isOwner: boolean; permissions: string[] };
    expect(access.isOwner).toBe(true);
    expect(access.permissions).toContain('PROJECT_EDIT');
    await mgrApi.dispose();

    // ...and the detail screen projects that: the edit control is offered.
    const detail = new ProjectDetailPage(page, slug);
    await detail.open();
    await expect(detail.editButton).toBeVisible();

    settle(problems, 'a project created by a manager');
  });
});
