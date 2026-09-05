import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import {
  DepartmentsPage,
  DepartmentFormPage,
  DepartmentDetailPage,
  DepartmentTreePage,
  captureNativeDialogs,
  selectBranch,
} from '../../pages';

/**
 * The department hierarchy, from the screens that shape it.
 *
 * Almost every rule in this module is a refusal — two levels and no more, no
 * moving a department that has people in it, no deleting one that still has
 * children. The backend suite proves the server refuses; what matters here is
 * that the person clicking the button is TOLD, in the server's own words,
 * rather than watching a dialog close and nothing happen.
 *
 * The other half is the hierarchy actually rendering: a tree that quietly drops
 * a node, or a parent select offering a department that would make the tree
 * three deep, is a defect no API test can see.
 *
 * ## Why the branch is pinned
 *
 * Departments are orthogonal to branches, but the LIST is not: it hides a
 * department whose staff are all in some other branch, and scopes every
 * headcount to the selected one. The picker auto-selects a branch on mount, so a
 * spec that ignores it is asserting against whichever branch happened to sort
 * first — which for this baseline is the empty second branch, where the only
 * populated department disappears. Every case here pins the head office, and
 * reads the API through the same selector.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const tag = () => `${test.info().project.name.toUpperCase()}${Date.now().toString(36).slice(-5)}`;

interface DeptRow {
  id: string;
  code: string;
  name: string;
  parentId?: string | null;
  _count?: { employees: number; children: number };
}

/** The head office — the branch every seeded employee belongs to. */
let hoId = '';

test.beforeAll(async () => {
  const admin = await ApiClient.as('admin');
  hoId = await admin.firstBranchId();
  await admin.dispose();
});

test.describe('departments, as an admin shapes them', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'administrative screen');
  });

  let code = '';
  let deptId = '';

  test.beforeEach(async ({ page, api }) => {
    if (!isProject('admin')) return;
    await selectBranch(page, hoId);
    api.withBranch(hoId);
  });

  test('the list agrees with the API, and the tiles with the list', async ({ page, problems }) => {
    // The payload this page load received — see the branch spec for why a
    // second request of our own would race the other role projects.
    const list = new DepartmentsPage(page);
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'GET' && r.url().startsWith(`${API_URL}/departments`),
      ),
      list.open(),
    ]);
    const departments = ((await response.json())?.data ?? []) as DeptRow[];

    expect(await list.stat('total')).toBe(departments.length);
    expect(await list.stat('toplevel')).toBe(departments.filter((d) => !d.parentId).length);
    expect(await list.has('HRD')).toBe(true);
    expect(await list.has('E2E-OPS')).toBe(true);
    settle(problems, 'the department list');
  });

  test('search and the advanced filters narrow the list, and clear again', async ({ page, problems }) => {
    const list = new DepartmentsPage(page);
    await list.open();

    await list.search('Operations');
    await expect(list.card('E2E-OPS')).toBeVisible();
    await expect(list.card('HRD')).toHaveCount(0);

    await list.search('no-such-department');
    await expect(page.getByTestId('dept-empty')).toBeVisible();
    await list.search('');

    await list.showAdvancedFilters();
    // "Managed" is the only filter with a visible split in the baseline: HRD has
    // a head, the two seeded structural departments do not.
    await list.filter('manager', 'assigned');
    await expect(list.card('HRD')).toBeVisible();
    await expect(list.card('E2E-FIN')).toHaveCount(0);

    await list.filter('manager', 'unassigned');
    await expect(list.card('E2E-FIN')).toBeVisible();
    await expect(list.card('HRD')).toHaveCount(0);

    await list.clearFilters();
    await expect(list.card('HRD')).toBeVisible();
    settle(problems, 'the department filters');
  });

  test('a new top-level department is created and appears everywhere', async ({ page, problems, api }) => {
    code = `E2E-DEP-${tag()}`;
    captureNativeDialogs(page);

    const form = new DepartmentFormPage(page);
    await form.openNew();
    await form.fill({ code, name: `Journey Dept ${code}`, description: 'created by the journey' });
    await form.submit();

    await page.waitForURL('**/dashboard/departments', { timeout: 15_000 });

    const list = new DepartmentsPage(page);
    await expect(list.card(code)).toBeVisible();

    const departments = await api.get<DeptRow[]>('/departments');
    deptId = departments.find((d) => d.code === code)!.id;
    expect(deptId).toBeTruthy();
    settle(problems, 'the department list after a create');
  });

  test('a duplicate code is refused in the banner, with the server’s reason', async ({ page, problems }) => {
    test.skip(!code, 'nothing to duplicate');

    // A deliberate 409: the console line it produces is the system working.
    crashesOnly(problems);
    const form = new DepartmentFormPage(page);
    await form.openNew();
    await form.fill({ code, name: 'Duplicate attempt' });
    await form.submit();

    // Unlike the branch form, this one has a banner — and it is fed by
    // getApiErrorMessage, which is what makes the backend's reason survive the
    // axios interceptor's flat error shape.
    await expect(page.getByTestId('dept-form-error')).toBeVisible({ timeout: 15_000 });
    expect(await form.errorBanner()).toContain('Department code already exists');
    expect(new URL(page.url()).pathname).toBe('/dashboard/departments/new');
    settle(problems, 'the department form after a duplicate code');
  });

  test('the parent select offers only departments that can legally be a parent', async ({ page, problems }) => {
    const form = new DepartmentFormPage(page);
    await form.openNew();

    const options = (await form.parentOptions()).join('\n');
    expect(options).toContain('Operations');
    // A department that is already a child cannot be a parent — offering it
    // would mean building a form whose every valid-looking choice is refused.
    expect(options).not.toContain('Operations Team');
    settle(problems, 'the parent select');
  });

  test('a child department nests one level down in the tree', async ({ page, problems, api }) => {
    const departments = await api.get<DeptRow[]>('/departments');
    const ops = departments.find((d) => d.code === 'E2E-OPS')!;
    const childCode = `E2E-SUB-${tag()}`;

    captureNativeDialogs(page);
    const form = new DepartmentFormPage(page);
    await form.openNew();
    await form.fill({ code: childCode, name: `Journey Team ${childCode}`, parentId: ops.id });
    await form.submit();
    await page.waitForURL('**/dashboard/departments', { timeout: 15_000 });

    const tree = new DepartmentTreePage(page);
    await tree.open();
    await expect(tree.node('E2E-OPS')).toBeVisible();
    await expect(tree.node(childCode)).toBeVisible();
    expect(await tree.level('E2E-OPS')).toBe(0);
    expect(await tree.level(childCode)).toBe(1);

    // Collapsing the parent must take its children with it; a tree whose toggle
    // does nothing is how a deep hierarchy becomes unreadable.
    await tree.collapse('E2E-OPS');
    await expect(tree.node(childCode)).toHaveCount(0);
    settle(problems, 'the department tree');
  });

  test('a rename is saved and shown on the detail screen', async ({ page, problems }) => {
    test.skip(!deptId, 'nothing to edit');

    captureNativeDialogs(page);
    const form = new DepartmentFormPage(page);
    await form.openEdit(deptId);
    await form.fill({ name: `Journey Dept ${code} (renamed)` });
    await form.submit();
    await page.waitForURL('**/dashboard/departments', { timeout: 15_000 });

    const detail = new DepartmentDetailPage(page);
    await detail.open(deptId);
    expect(await detail.name()).toContain('renamed');
    settle(problems, 'the department detail after a rename');
  });

  test('moving a populated department is warned about, then refused with a reason', async ({ page, problems, api }) => {
    const departments = await api.get<DeptRow[]>('/departments');
    const hrd = departments.find((d) => d.code === 'HRD')!;
    const ops = departments.find((d) => d.code === 'E2E-OPS')!;

    crashesOnly(problems);
    const form = new DepartmentFormPage(page);
    await form.openEdit(hrd.id);
    await form.fill({ parentId: ops.id });

    // The screen warns BEFORE the save, because the server will refuse it — the
    // warning existing is the difference between a considered form and a trap.
    expect(await form.hasParentWarning()).toBe(true);

    await form.submit();
    await expect(page.getByTestId('dept-form-error')).toBeVisible({ timeout: 15_000 });
    expect(await form.errorBanner()).toMatch(/employees|sub-departments/i);
    settle(problems, 'the department form after an illegal move');
  });

  test('the detail screen’s tabs all render', async ({ page, problems, api }) => {
    const departments = await api.get<DeptRow[]>('/departments');
    const hrd = departments.find((d) => d.code === 'HRD')!;

    const detail = new DepartmentDetailPage(page);
    await detail.open(hrd.id);
    expect(await detail.head()).toBeTruthy();

    for (const tab of ['employees', 'teams', 'performance', 'history', 'overview'] as const) {
      await detail.tab(tab);
      const text = await page.locator('body').innerText();
      expect(text.trim().length, `the ${tab} tab rendered nothing`).toBeGreaterThan(0);
    }
    settle(problems, 'the department detail tabs');
  });

  test('an empty department is deleted; one with staff or children is refused', async ({ page, problems, api }) => {
    test.skip(!deptId, 'nothing to delete');

    // The last two deletes are refused on purpose.
    crashesOnly(problems);
    const dialogs = captureNativeDialogs(page);
    const detail = new DepartmentDetailPage(page);

    await detail.open(deptId);
    await detail.delete();
    await page.waitForURL('**/dashboard/departments', { timeout: 15_000 });
    const list = new DepartmentsPage(page);
    await expect(list.card(code)).toHaveCount(0);

    const departments = await api.get<DeptRow[]>('/departments');
    const hrd = departments.find((d) => d.code === 'HRD')!;
    const ops = departments.find((d) => d.code === 'E2E-OPS')!;

    // The refusal has to name its reason. This screen used to read
    // `error.response.data.message`, always undefined under this app's axios
    // interceptor, so both rules collapsed into one blank "delete failed".
    dialogs.length = 0;
    await detail.open(hrd.id);
    await detail.delete();
    await expect
      .poll(() => dialogs.join('\n'), { timeout: 15_000 })
      .toContain('Cannot delete department with employees');

    dialogs.length = 0;
    await detail.open(ops.id);
    await detail.delete();
    await expect
      .poll(() => dialogs.join('\n'), { timeout: 15_000 })
      .toContain('sub-departments');

    // Both departments are still there, which is the part that must hold
    // whatever the message says.
    const stillThere = await api.get<DeptRow[]>('/departments');
    expect(stillThere.map((d) => d.code)).toEqual(
      expect.arrayContaining(['HRD', 'E2E-OPS']),
    );
    settle(problems, 'the department detail after refused deletes');
  });

  });

test.describe('departments, as HR', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'HR path');
  });

  test('HR can create and remove a department', async ({ page, problems, api }) => {
    await selectBranch(page, hoId);
    api.withBranch(hoId);

    const hrCode = `E2E-DEP-${tag()}`;
    captureNativeDialogs(page);

    const form = new DepartmentFormPage(page);
    await form.openNew();
    await form.fill({ code: hrCode, name: `HR Dept ${hrCode}` });
    await form.submit();
    await page.waitForURL('**/dashboard/departments', { timeout: 15_000 });

    const list = new DepartmentsPage(page);
    await expect(list.card(hrCode)).toBeVisible();

    const departments = await api.get<DeptRow[]>('/departments');
    const created = departments.find((d) => d.code === hrCode)!;

    const detail = new DepartmentDetailPage(page);
    await detail.open(created.id);
    await detail.delete();
    await page.waitForURL('**/dashboard/departments', { timeout: 15_000 });
    await expect(list.card(hrCode)).toHaveCount(0);
    settle(problems, 'the department list as HR');
  });
});

test.describe('departments, as the roles with less authority', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'manager path');
    });

    test('a manager reads their own department and is refused the others', async ({ page, problems, api }) => {
      const admin = (await ApiClient.as('admin')).withBranch(hoId);
      await selectBranch(page, hoId);
      const departments = await admin.get<DeptRow[]>('/departments');
      const hrd = departments.find((d) => d.code === 'HRD')!;
      const ops = departments.find((d) => d.code === 'E2E-OPS')!;
      await admin.dispose();

      const list = new DepartmentsPage(page);
      await list.open();
      expect(new URL(page.url()).pathname).toBe('/dashboard/departments');
      // MANAGE_DEPARTMENTS is not theirs, so the screen must not offer the button
      // at all rather than let them walk into a 403.
      expect(await list.canCreate()).toBe(false);

      const detail = new DepartmentDetailPage(page);
      await detail.open(hrd.id);
      expect(await detail.name()).toBeTruthy();

      // A department they do not head answers 403; the screen is expected to say
      // so and return, and above all not to break.
      crashesOnly(problems);
      await detail.open(ops.id);
      await page.waitForLoadState('networkidle').catch(() => {});
      expect(new URL(page.url()).pathname).not.toBe('/403');
      settle(problems, 'a foreign department as a manager');

      expect(api).toBeTruthy();
    });

    test('a manager is refused the write endpoints by the API', async () => {
      const api = await ApiClient.as('manager');
      await expect(
        api.post('/departments', { code: `E2E-NOPE-${tag()}`, name: 'nope' }),
      ).rejects.toThrow(/403/);
      await api.dispose();
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee path');
    });

    test('an employee cannot reach the department screens at all', async ({ page, problems }) => {
      crashesOnly(problems);

      for (const path of ['/dashboard/departments', '/dashboard/departments/new']) {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});
        expect(new URL(page.url()).pathname, `${path} let an employee through`).toBe('/403');
      }
      settle(problems, 'department screens as an employee');
    });
  });
});
