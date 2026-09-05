import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import {
  TeamsPage,
  TeamFormPage,
  TeamDetailPage,
  SupervisorTeamsPage,
  captureNativeDialogs,
  selectBranch,
} from '../../pages';

/**
 * Teams, from the screens — both features that share the name.
 *
 * `/dashboard/teams` drives the org `Team` model. `/dashboard/supervisor-teams`
 * drives the approval chain through `Team` rows of `type: 'SUPERVISION'`. They
 * are the same table and different products, the sidebar's "Teams" points at
 * the second, and the first is not in the sidebar at all — so the first case
 * here is simply "which one does the menu mean".
 *
 * Neither screen has a `ProtectedRoute`, so for the roles the server refuses
 * the assertion is that the shell renders and nothing throws — a screen that
 * 403s its data is a different failure from a screen that crashes.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
// Upper-cased on purpose: the create form upper-cases the code as the user
// types, so a mixed-case tag would be stored differently from what the spec
// then searches for.
const tag = () =>
  `${test.info().project.name.toUpperCase()}${Date.now()
    .toString(36)
    .slice(-5)
    .toUpperCase()}`;

let hoId = '';
let opsDeptId = '';

test.beforeAll(async () => {
  const api = await ApiClient.as('admin');
  const branches = await api.get<any>('/branches');
  const branchRows: any[] = Array.isArray(branches) ? branches : branches.data;
  hoId = branchRows.find((b: any) => b.code === 'HO')?.id ?? branchRows[0]?.id;

  const departments = await api.get<any>('/departments');
  const deptRows: any[] = Array.isArray(departments)
    ? departments
    : departments.data;
  opsDeptId = deptRows.find((d: any) => d.code === 'E2E-OPS')?.id;
  // Fail here rather than three screens later with "the row is not visible".
  if (!hoId) throw new Error('Baseline seed missing branch HO');
  if (!opsDeptId) throw new Error('Baseline seed missing department E2E-OPS');
});

test.beforeEach(async ({ page }) => {
  await selectBranch(page, hoId);
});

test.describe('Org teams', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('TEAM-UI-01: admin creates a team and finds it in the list', async ({
      page,
      problems,
    }) => {
      const code = `UI-${tag()}`;

      // This form reports failure through `alert()`. Without a handler installed
      // Playwright auto-dismisses it, so a refused save looks identical to a
      // successful one until the list assertion fails for no visible reason.
      const dialogs = captureNativeDialogs(page);

      const form = new TeamFormPage(page);
      await form.open();
      await form.fill({ name: `UI Team ${code}`, code, departmentId: opsDeptId });
      await form.submit();
      // A refused save alerts; a successful one navigates. Give the alert a
      // moment to arrive so this reports the reason rather than a missing row.
      await page.waitForTimeout(500);
      expect(dialogs, `the create was refused: ${dialogs.join(' | ')}`).toEqual([]);

      const list = new TeamsPage(page);
      await list.open();
      await list.search(code);
      await expect(list.row(code)).toBeVisible();

      settle(problems, 'The teams list');
    });

    test('TEAM-UI-03: a duplicate code is refused, and the user is told', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      const code = `UID-${tag()}`;
      await api.post('/teams', {
        name: `Existing ${code}`,
        code,
        departmentId: opsDeptId,
      });

      // The refusal arrives through `alert()`, not an inline banner, so the
      // message only exists inside the dialog.
      const dialogs = captureNativeDialogs(page);

      const form = new TeamFormPage(page);
      await form.open();
      await form.fill({ name: 'Duplicate attempt', code, departmentId: opsDeptId });
      await form.submit();

      // The alert is raised from the catch block AFTER the request settles, so
      // `networkidle` is not a signal that it has appeared yet — poll for it.
      await expect.poll(() => dialogs.length, { timeout: 10000 }).toBeGreaterThan(0);

      // The server's own words now reach the user. They did not before: the page
      // read `error.response?.data?.message`, a path this app's axios interceptor
      // never fills, so a duplicate code was indistinguishable from a network
      // outage (finding P33).
      expect(dialogs.join(' ')).toContain('Team code already exists');

      // The form is still open — the user has not lost their work.
      await expect(page).toHaveURL(/\/dashboard\/teams\/new/);

      crashesOnly(problems);
    });

    test('TEAM-UI-04: a member can be added and removed, with the count following', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      const code = `UIM-${tag()}`;
      const team = await api.post<any>('/teams', {
        name: `Member team ${code}`,
        code,
        departmentId: opsDeptId,
      });

      // Someone in the same department — the server refuses anyone else.
      // ACTIVE only: E2E-OPS deliberately holds a TERMINATED employee for the
      // hard-delete path, and the server refuses to put one in a team
      // ('Employee must be active').
      const staff = await api.get<any>(
        `/employees?departmentId=${opsDeptId}&status=ACTIVE&limit=5`,
      );
      const staffRows: any[] = Array.isArray(staff) ? staff : staff.data;
      const member = staffRows[0];
      test.skip(!member, 'no staff in E2E-OPS to add');

      await api.post(`/teams/${team.id}/members`, { employeeId: member.id });

      const dialogs = captureNativeDialogs(page);
      const detail = new TeamDetailPage(page);
      await detail.open(team.id);
      expect(await detail.name()).toContain('Member team');

      // Removal is confirmed through a native dialog, and the request only
      // leaves once the dialog is accepted — so the read-back has to wait for
      // the response, not for a load state.
      const [removal] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes(`/teams/${team.id}/members/`) &&
            r.request().method() === 'DELETE',
          { timeout: 20000 },
        ),
        detail.removeMember(member.employeeCode),
      ]);
      expect(removal.status()).toBe(200);
      await expect.poll(() => dialogs.length, { timeout: 10000 }).toBeGreaterThan(0);

      const after = await api.get<any>(`/teams/${team.id}`);
      const active = (after.members ?? []).filter((m: any) => m.isActive);
      expect(active).toHaveLength(0);

      crashesOnly(problems);
    });

    test('TEAM-UI-05: a team holding members cannot be deleted', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      const code = `UID2-${tag()}`;
      const team = await api.post<any>('/teams', {
        name: `Held team ${code}`,
        code,
        departmentId: opsDeptId,
      });
      // ACTIVE only: E2E-OPS deliberately holds a TERMINATED employee for the
      // hard-delete path, and the server refuses to put one in a team
      // ('Employee must be active').
      const staff = await api.get<any>(
        `/employees?departmentId=${opsDeptId}&status=ACTIVE&limit=5`,
      );
      const staffRows: any[] = Array.isArray(staff) ? staff : staff.data;
      test.skip(!staffRows[0], 'no staff in E2E-OPS to add');
      await api.post(`/teams/${team.id}/members`, {
        employeeId: staffRows[0].id,
      });

      // Driven over the API rather than through a screen: the list has no delete
      // control, so this is the rule the UI would hit if one were added.
      let refused = false;
      try {
        await api.delete(`/teams/${team.id}`);
      } catch (error) {
        refused = String(error).includes('Remove all members first');
      }
      expect(refused).toBe(true);

      const list = new TeamsPage(page);
      await list.open();
      await list.search(code);
      await expect(list.row(code)).toBeVisible();

      settle(problems, 'The teams list');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee journey');
    });

    test('TEAM-UI-07: an employee reaches the screen and its data 403s without crashing', async ({
      page,
      problems,
    }) => {
      // There is no ProtectedRoute here, so the client lets an employee in and
      // the server refuses the data. The rule is that this fails cleanly.
      const list = new TeamsPage(page);
      await list.open();
      await expect(page).toHaveURL(/\/dashboard\/teams/);

      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('TEAM-UI-08: the sidebar’s "Teams" means supervisor teams, not org teams', async ({
      page,
      problems,
    }) => {
      // Two unrelated features share the word. Asserted so the next person to
      // read the menu does not test the wrong one.
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      const link = page.locator('a[href="/dashboard/supervisor-teams"]').first();
      await expect(link).toHaveCount(1);
      await expect(
        page.locator('a[href="/dashboard/teams"]'),
      ).toHaveCount(0);

      settle(problems, 'The dashboard sidebar');
    });
  });
});

test.describe('Supervisor teams', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('STEAM-UI-01: admin creates a supervision team through the modal', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      // ACTIVE only: E2E-OPS deliberately holds a TERMINATED employee for the
      // hard-delete path, and the server refuses to put one in a team
      // ('Employee must be active').
      const staff = await api.get<any>(
        `/employees?departmentId=${opsDeptId}&status=ACTIVE&limit=5`,
      );
      const staffRows: any[] = Array.isArray(staff) ? staff : staff.data;
      test.skip(!staffRows[0], 'no staff in E2E-OPS to supervise');

      const screenName = `Sup ${tag()}`;
      const screen_ = new SupervisorTeamsPage(page);
      await screen_.open();
      await screen_.create();
      await screen_.fillName(screenName);
      // A supervisor is required — `save()` returns early with a toast without
      // one, which reads as "the button did nothing".
      await screen_.chooseSupervisor(staffRows[0].id);

      // Wait on the request so a refusal reports its own status rather than
      // surfacing three lines later as "the team is not in the list".
      const [created_] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes('/supervisors/teams') &&
            r.request().method() === 'POST',
          { timeout: 20000 },
        ),
        screen_.submit(),
      ]);
      expect(
        created_.status(),
        `create refused: ${await created_.text().catch(() => '')}`,
      ).toBeLessThan(300);

      const teams = await api.get<any>('/supervisors/teams');
      const rows: any[] = Array.isArray(teams) ? teams : teams.data;
      expect(rows.some((t: any) => t.name === screenName)).toBe(true);

      // Creating one is what assigns the approval chain — the half no screen
      // shows and the reason this feature is not just another team list.
      const created = rows.find((t: any) => t.name === screenName);
      expect(created.teamLeadId).toBe(staffRows[0].id);

      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'manager journey');
    });

    test('STEAM-UI-03: a manager reaches the screen and its data 403s — KNOWN GAP (P24)', async ({
      page,
      problems,
    }) => {
      // The screen has no ProtectedRoute and `/supervisors/teams` is ADMIN/HR,
      // so a manager lands on a page that can only fail. Pinned, not fixed: the
      // fix is a guard, and which guard is a product decision.
      const screen_ = new SupervisorTeamsPage(page);
      await screen_.open();
      await expect(page).toHaveURL(/\/dashboard\/supervisor-teams/);

      crashesOnly(problems);
    });
  });
});
