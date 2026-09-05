import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import {
  BranchesPage,
  BranchFormPage,
  BranchDetailPage,
  captureNativeDialogs,
  dismissNativeDialogs,
} from '../../pages';

/**
 * A branch, from the screens that create and retire one.
 *
 * A branch is not a lookup row: it carries the office hours, the weekly-off
 * calendar and the geofence that decide whether someone's check-in counts, and
 * it is the axis every other list is scoped by. So the failures worth catching
 * are not "the form did not submit" — they are a branch that exists with the
 * wrong configuration, or one that cannot be removed and gives no reason.
 *
 * These screens report every outcome through `window.alert`, including the
 * server's reason for refusing. Playwright dismisses dialogs by default, which
 * would both no-op the confirm-guarded delete and throw away the only evidence
 * on screen — hence `captureNativeDialogs` in almost every case here.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Unique per test run so a retry, or another project, cannot collide. */
const tag = () => `${test.info().project.name.toUpperCase()}${Date.now().toString(36).slice(-5)}`;

test.describe('branches, as an admin manages them', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'administrative screen');
  });

  let code = '';
  let branchId = '';

  test('the list agrees with the API about what exists', async ({ page, problems }) => {
    interface BranchRow {
      id: string;
      code: string;
      isActive?: boolean;
      geofencingEnabled?: boolean;
      _count?: { employees: number };
    }

    // The payload THIS page load received, not a second request of our own. The
    // four role projects share one database and run concurrently, so a branch
    // created by the HR project between two reads would make a correct screen
    // look wrong — which is a flaky test, not a finding.
    const list = new BranchesPage(page);
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'GET' && r.url().startsWith(`${API_URL}/branches`),
      ),
      list.open(),
    ]);
    const branches = ((await response.json())?.data ?? []) as BranchRow[];

    // The tiles are the first thing anyone reads on this screen, and they are
    // computed client-side from the same payload — a disagreement here means
    // the summary is lying about the estate.
    expect(await list.stat('total')).toBe(branches.length);
    expect(await list.stat('active')).toBe(branches.filter((b) => b.isActive !== false).length);
    expect(await list.stat('geofenced')).toBe(branches.filter((b) => b.geofencingEnabled).length);
    expect(await list.stat('employees')).toBe(
      branches.reduce((sum, b) => sum + (b._count?.employees ?? 0), 0),
    );

    expect(await list.has('HO')).toBe(true);
    settle(problems, 'the branch list');
  });

  test('search narrows the list and says so when nothing matches', async ({ page, problems }) => {
    const list = new BranchesPage(page);
    await list.open();

    await list.search('HO');
    await expect(list.card('HO')).toBeVisible();

    await list.search('no-such-branch-anywhere');
    await expect(page.getByTestId('branch-empty')).toBeVisible();

    await list.search('');
    await expect(list.card('HO')).toBeVisible();
    settle(problems, 'branch search');
  });

  test('the table view shows the same branches as the cards', async ({ page, problems }) => {
    const list = new BranchesPage(page);
    await list.open();
    await expect(list.card('HO')).toBeVisible();

    await list.showTable();
    await expect(list.row('HO')).toBeVisible();
    // The switch is a presentation choice, not a different query: a view that
    // quietly filters is how a branch goes missing without anyone noticing.
    await expect(list.row('E2E-BR2')).toBeVisible();

    await list.showCards();
    await expect(list.card('HO')).toBeVisible();
    settle(problems, 'the branch table view');
  });

  test('a new branch is created with the configuration it was given', async ({ page, problems }) => {
    code = `E2E-BR-${tag()}`;
    const dialogs = captureNativeDialogs(page);

    const form = new BranchFormPage(page);
    await form.openNew();
    await form.fill({
      code,
      name: `Journey Branch ${code}`,
      city: 'Muscat',
      country: 'OM',
      timezone: 'Asia/Muscat',
      officeStartTime: '08:00',
      officeEndTime: '16:30',
      weeklyOffDays: ['5', '6'],
    });
    await form.submit();

    await page.waitForURL('**/dashboard/branches', { timeout: 15_000 });
    expect(dialogs.join(' ')).not.toMatch(/fail|error/i);

    const list = new BranchesPage(page);
    await expect(list.card(code)).toBeVisible();
    // The hours pill distinguishes a branch that overrides the company default
    // from one that inherits it — the single visible signal of the setting that
    // decides who is late.
    expect(await list.hours(code)).toContain('08:00');
    settle(problems, 'the branch list after a create');
  });

  test('the detail screen reflects what was saved', async ({ page, problems, api }) => {
    test.skip(!code, 'nothing was created');

    const branches = await api.get<Array<{ id: string; code: string }>>('/branches');
    branchId = branches.find((b) => b.code === code)!.id;

    const detail = new BranchDetailPage(page);
    await detail.open(branchId);

    expect(await detail.name()).toContain(code);
    expect(await detail.staff()).toBe(0);
    expect(await detail.timezone()).toContain('Muscat');
    expect(await detail.hours()).toContain('08:00');
    settle(problems, 'the branch detail screen');
  });

  test('a duplicate code is refused with the server’s own words', async ({ page, problems }) => {
    test.skip(!code, 'nothing to duplicate');

    // The 409 is the point of this case, so the failure fixture must not treat
    // the console line it produces as evidence of a bug.
    crashesOnly(problems);
    const dialogs = captureNativeDialogs(page);
    const form = new BranchFormPage(page);
    await form.openNew();
    await form.fill({ code, name: 'Duplicate attempt' });
    await form.submit();

    // The reason has to reach the user. A generic "save failed" here would leave
    // them retyping the same code forever.
    await expect
      .poll(() => dialogs.join('\n'), { timeout: 15_000 })
      .toContain('Branch code already exists');

    // And the form must not have navigated away as if it had worked.
    expect(new URL(page.url()).pathname).toBe('/dashboard/branches/new');
    settle(problems, 'the branch form after a duplicate code');
  });

  test('the form refuses impossible values before the server sees them', async ({ page, problems }) => {
    const form = new BranchFormPage(page);
    await form.openNew();

    await form.submit();
    let errors = await form.fieldErrors();
    expect(errors.length).toBeGreaterThan(0);
    expect(new URL(page.url()).pathname).toBe('/dashboard/branches/new');

    await form.fill({
      code: `E2E-INVALID-${tag()}`,
      name: 'Invalid coordinates',
      geofencing: true,
      latitude: '91',
      longitude: '181',
      radius: '0',
    });
    await form.submit();

    errors = await form.fieldErrors();
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(new URL(page.url()).pathname).toBe('/dashboard/branches/new');
    settle(problems, 'the branch form with invalid input');
  });

  test('the geofence block round-trips through an edit', async ({ page, problems, api }) => {
    test.skip(!branchId, 'nothing to edit');

    const dialogs = captureNativeDialogs(page);
    const form = new BranchFormPage(page);
    await form.openEdit(branchId);

    await form.fill({
      geofencing: true,
      latitude: '23.588',
      longitude: '58.3829',
      radius: '250',
    });
    await form.submit();
    await page.waitForURL('**/dashboard/branches', { timeout: 15_000 });
    expect(dialogs.join(' ')).not.toMatch(/fail|error/i);

    const saved = await api.get<{ geofencingEnabled: boolean; geofenceRadiusM: number }>(
      `/branches/${branchId}`,
    );
    expect(saved.geofencingEnabled).toBe(true);
    expect(saved.geofenceRadiusM).toBe(250);

    // Reopening must show what was stored: a form that silently drops the
    // coordinates on the next edit is how a geofence gets switched off.
    await form.openEdit(branchId);
    expect(await form.value('latitude')).toBe('23.588');
    expect(await form.value('radius')).toBe('250');
    settle(problems, 'the branch edit form');
  });

  test('a delete is not carried out when the confirm is dismissed', async ({ page, problems }) => {
    test.skip(!code, 'nothing to delete');

    const asked = dismissNativeDialogs(page);
    const list = new BranchesPage(page);
    await list.open();
    await list.delete(code);

    await expect.poll(() => asked.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(list.card(code)).toBeVisible();
    settle(problems, 'the branch list after a dismissed delete');
  });

  test('an empty branch is removed, and one with staff is refused with a reason', async ({ page, problems }) => {
    test.skip(!code, 'nothing to delete');

    // The second half of this case is a deliberate 400.
    crashesOnly(problems);
    const dialogs = captureNativeDialogs(page);
    const list = new BranchesPage(page);
    await list.open();

    await list.delete(code);
    await expect(list.card(code)).toHaveCount(0, { timeout: 15_000 });

    // The head office holds every seeded employee, so removing it must fail —
    // and the refusal has to name the reason, or the branch simply appears not
    // to respond to the button.
    dialogs.length = 0;
    await list.delete('HO');
    await expect
      .poll(() => dialogs.join('\n'), { timeout: 15_000 })
      .toContain('Cannot delete branch with employees');
    await expect(list.card('HO')).toBeVisible();
    settle(problems, 'the branch list after deletes');
  });

  test('a retired branch can be found again and switched back on', async ({ page, problems }) => {
    test.skip(!code, 'nothing to reactivate');

    // The case above retired `code`. A retired branch is filtered out of this
    // list AND 404s on the detail route, so before the toggle below there was
    // no way back to one from anywhere in the UI — deactivating was a one-way
    // door, and the only repair was a hand-written UPDATE against the database.
    const dialogs = captureNativeDialogs(page);
    const list = new BranchesPage(page);
    await list.open();
    await expect(list.card(code)).toHaveCount(0, { timeout: 15_000 });

    await list.toggleInactive();
    await expect(list.card(code)).toBeVisible({ timeout: 15_000 });

    dialogs.length = 0;
    await list.reactivate(code);
    await expect
      .poll(() => dialogs.join('\n'), { timeout: 15_000 })
      .toContain('reactivated');

    // Back in the DEFAULT list is the assertion that matters: that list is what
    // every branch picker in the app reads.
    await list.toggleInactive();
    await expect(list.card(code)).toBeVisible({ timeout: 15_000 });
    settle(problems, 'the branch list after a reactivate');
  });
});

test.describe('branches, as HR', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'HR path');
  });

  test('HR can create and remove a branch too', async ({ page, problems }) => {
    const hrCode = `E2E-BR-${tag()}`;
    const dialogs = captureNativeDialogs(page);

    const form = new BranchFormPage(page);
    await form.openNew();
    await form.fill({ code: hrCode, name: `HR Branch ${hrCode}` });
    await form.submit();
    await page.waitForURL('**/dashboard/branches', { timeout: 15_000 });

    const list = new BranchesPage(page);
    await expect(list.card(hrCode)).toBeVisible();

    await list.delete(hrCode);
    await expect(list.card(hrCode)).toHaveCount(0, { timeout: 15_000 });
    expect(dialogs.join(' ')).not.toMatch(/fail/i);
    settle(problems, 'the branch list as HR');
  });
});

test.describe('branches, for the roles that may not manage them', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'manager path');
    });

    test('a manager is turned away from every branch screen', async ({ page, problems }) => {
      crashesOnly(problems);

      // Worth stating plainly: the API would let a MANAGER READ /branches, but the
      // client guard is ADMIN/HR only. The stricter side is the safe side, and
      // this records which side that is.
      for (const path of ['/dashboard/branches', '/dashboard/branches/new']) {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});
        expect(new URL(page.url()).pathname, `${path} let a manager through`).toBe('/403');
      }
      settle(problems, 'branch screens as a manager');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee path');
    });

    test('an employee is turned away from every branch screen', async ({ page, problems }) => {
      crashesOnly(problems);

      for (const path of ['/dashboard/branches', '/dashboard/branches/new']) {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});
        expect(new URL(page.url()).pathname, `${path} let an employee through`).toBe('/403');
      }
      settle(problems, 'branch screens as an employee');
    });

    test('an employee is refused by the API as well as the router', async () => {
      const api = await ApiClient.as('employee');
      await expect(api.get('/branches')).rejects.toThrow(/403/);
      await expect(
        api.post('/branches', { code: `E2E-NOPE-${tag()}`, name: 'nope' }),
      ).rejects.toThrow(/403/);
      await api.dispose();
    });
  });
});
