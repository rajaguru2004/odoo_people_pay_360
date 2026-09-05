import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { SalaryStructurePage, selectBranch } from '../../pages';

/**
 * Salary structures, through the screens.
 *
 * An employee's structure IS their set of active `SalaryComponent` rows — there
 * is no structure table and no assignment entity. Two rules make this screen
 * more than a CRUD form:
 *
 *  1. **Amending an amount is append-only.** The old row is retired and a new
 *     one takes its place, so the payslip already produced from the old figure
 *     still has a row that explains it.
 *  2. **Delete is ADMIN-only**, and refused outright once the employee has any
 *     LOCKED payroll. HR retires a component with Deactivate instead. The
 *     screen used to offer HR a delete button that answered 403.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const runId = `pws${Date.now().toString(36)}`;

interface Component {
  id: string;
  componentType: string;
  amount: number | string;
  employeeId: string;
}

test.describe('salary structure', () => {
  let api: ApiClient;
  let branchId = '';
  let employeeId = '';
  let created: Component | null = null;

  test.beforeAll(async () => {
    api = await ApiClient.as('admin');
    branchId = await api.firstBranchId();
    api.withBranch(branchId);

    const res = await api
      .get<{ data?: Array<{ id: string }> } | Array<{ id: string }>>('/employees?limit=1')
      .catch(() => [] as Array<{ id: string }>);
    const list = Array.isArray(res) ? res : (res?.data ?? []);
    employeeId = list[0]?.id ?? '';

    if (employeeId) {
      created = await api
        .post<Component>('/salary-components', {
          employeeId,
          componentType: 'TRANSPORT',
          amount: 1200,
          note: `seeded by ${runId}`,
        })
        .catch(() => null);
    }
  });

  test.afterAll(async () => {
    // Deactivate rather than delete: the employee may already have locked
    // payroll history, in which case the server refuses a delete — which is the
    // rule SC-UI-05 exists to prove.
    // ApiClient already unwraps the { success, data } envelope, so this is the
    // array itself — reading `.data` off it silently swept nothing.
    const all = await api
      ?.get<Component[]>(`/salary-components?employeeId=${employeeId}&limit=100`)
      .catch(() => [] as Component[]);
    for (const c of all ?? []) {
      if (c.componentType === 'TRANSPORT') {
        await api.post(`/salary-components/${c.id}/deactivate`, {}).catch(() => {});
      }
    }
    await api?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('SC-UI-01: the screen lists a component with its type and amount', async ({
      page,
      problems,
    }) => {
      test.skip(!created, 'the component could not be created');

      await selectBranch(page, branchId);
      const structure = new SalaryStructurePage(page);
      await structure.open();

      await expect.poll(() => structure.row(created!.id).count(), { timeout: 20_000 }).toBe(1);
      expect(await structure.amountOf(created!.id)).toBe(1200);
      settle(problems, 'the salary structure screen');
    });

    test('SC-UI-02: amending the amount retires the old row and shows the new one', async ({
      page,
      problems,
    }) => {
      test.skip(!created, 'the component could not be created');

      await selectBranch(page, branchId);
      const structure = new SalaryStructurePage(page);
      await structure.open();

      await structure.edit(created!.id);
      await structure.fill({ amount: 1800 });
      await structure.save();

      // The row on screen is a DIFFERENT row: the amend created one and
      // deactivated the other, so pay history stays explainable. Re-open rather
      // than polling the open page — what is asserted is that the amend PERSISTED
      // and the screen reflects it, not how quickly the list re-renders.
      await structure.open();
      await expect
        .poll(() => structure.row(created!.id).count(), { timeout: 20_000 })
        .toBe(0);
      await expect
        .poll(async () => (await structure.rowsOfType('TRANSPORT').count()) > 0, {
          timeout: 20_000,
        })
        .toBe(true);
      settle(problems, 'the salary structure screen after an amend');
    });

    test('SC-UI-03: a second BASIC is refused, and the reason reaches the user', async ({
      page,
      problems,
    }) => {
      test.skip(!employeeId, 'no employee available');

      // "One active BASIC per employee" is the rule under test, so the FIRST one has
      // to be guaranteed rather than assumed — a freshly cloned database does not
      // necessarily ship one, and without it this case silently tests a successful
      // create instead of a refusal.
      await api
        .post('/salary-components', { employeeId, componentType: 'BASIC', amount: 20000 })
        .catch(() => undefined);

      await selectBranch(page, branchId);
      const structure = new SalaryStructurePage(page);
      await structure.open();

      await structure.startAdd();
      await structure.fill({ employeeId, type: 'BASIC', amount: 1 });
      await structure.save();

      await expect(page.getByText(/basic salary/i).first()).toBeVisible({ timeout: 15_000 });
      crashesOnly(problems);
    });

    test('SC-UI-04: an admin is offered delete', async ({ page, problems }) => {
      await selectBranch(page, branchId);
      const structure = new SalaryStructurePage(page);
      await structure.open();

      const rows = structure.rowsOfType('TRANSPORT');
      test.skip((await rows.count()) === 0, 'nothing to act on');
      await expect(rows.first().getByTestId('sc-delete')).toBeVisible();
      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'hr project only');
    });

    test('SC-UI-05: HR reaches the screen and is offered no delete', async ({ page, problems }) => {
      await page.goto('/dashboard/payroll/salary-structure', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.url(), { timeout: 20_000 }).not.toContain('/403');

      // DELETE /salary-components/:id is ADMIN-only, and deleting a component
      // erases the row a produced payslip was calculated from. HR gets Deactivate.
      expect(await page.getByTestId('sc-delete').count()).toBe(0);
      await expect(page.getByTestId('sc-add')).toBeVisible();
      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager or employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager') && !isProject('employee'), 'denial projects only');
    });

    test('SC-UI-06: a manager and an employee are refused the screen', async ({ page }) => {
      await page.goto('/dashboard/payroll/salary-structure', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/403');
    });
  });
});
