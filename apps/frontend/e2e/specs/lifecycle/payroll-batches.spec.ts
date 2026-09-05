import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { PayrollBatchesPage, selectBranch } from '../../pages';

/**
 * Payroll batches, through the screens.
 *
 * A batch is a named, per-branch group of employees, and it is the only way to
 * run payroll for a subset of a branch. It has **no lifecycle** — no PROCESSING
 * or COMPLETED state, no run endpoint of its own; "running a batch" is
 * `POST /payrolls { batchId }`, which the Run payroll button navigates to.
 *
 * Until Phase 4 this screen had no browser coverage and no `data-testid` at all,
 * and no `ProtectedRoute`: a manager or an employee saw the whole page, its
 * create button and its cards, and every request behind them 403'd.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const runId = `pwb${Date.now().toString(36)}`;
const BATCH = `Batch ${runId}`;
const RENAMED = `Batch ${runId} renamed`;

interface Employee {
  id: string;
  fullName: string;
}

async function employeesIn(api: ApiClient): Promise<Employee[]> {
  const res = await api
    .get<{ data?: Employee[] } | Employee[]>('/employees?limit=5')
    .catch(() => [] as Employee[]);
  return Array.isArray(res) ? res : (res?.data ?? []);
}

test.describe('payroll batches', () => {
  let api: ApiClient;
  let branchId = '';
  let employees: Employee[] = [];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    api = await ApiClient.as('admin');
    branchId = await api.firstBranchId();
    api.withBranch(branchId);
    employees = await employeesIn(api);
  });

  test.afterAll(async () => {
    // Named by runId, so this only ever removes what this file created.
    const batches = await api
      ?.get<{ data?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>>(
        '/payroll-batches',
      )
      .catch(() => null);
    const list = Array.isArray(batches) ? batches : (batches?.data ?? []);
    for (const b of list ?? []) {
      if (b.name.includes(runId)) await api.delete(`/payroll-batches/${b.id}`).catch(() => {});
    }
    await api?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the create path is an admin journey');
    });

    test('PB-UI-01: an admin creates a batch and it appears with its members', async ({
      page,
      problems,
    }) => {
      test.skip(employees.length < 2, 'needs at least two employees in the branch');

      await selectBranch(page, branchId);
      const batches = new PayrollBatchesPage(page);
      await batches.open();

      await batches.startCreate();
      await batches.fillName(BATCH);
      await batches.toggleEmployee(employees[0].id);
      await batches.toggleEmployee(employees[1].id);
      await batches.save();

      await expect.poll(() => batches.card(BATCH).count(), { timeout: 20_000 }).toBe(1);
      expect(await batches.memberCount(BATCH)).toBe(2);
      settle(problems, 'the batches screen');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('PB-UI-02: editing replaces the whole member set', async ({ page, problems }) => {
      test.skip(employees.length < 2, 'needs at least two employees');

      await selectBranch(page, branchId);
      const batches = new PayrollBatchesPage(page);
      await batches.open();

      await batches.edit(BATCH);
      await batches.fillName(RENAMED);
      // Deselect one; a PATCH carrying employeeIds replaces the set outright
      // rather than merging, which is the behaviour this asserts.
      await batches.toggleEmployee(employees[1].id);
      await batches.save();

      await expect.poll(() => batches.card(RENAMED).count(), { timeout: 20_000 }).toBe(1);
      expect(await batches.memberCount(RENAMED)).toBe(1);
      settle(problems, 'the batches screen after an edit');
    });

    test('PB-UI-03: the employee picker only offers this branch', async ({ page, problems }) => {
      await selectBranch(page, branchId);
      const batches = new PayrollBatchesPage(page);
      await batches.open();
      await batches.startCreate();

      const offered = await page.getByTestId('batch-employee-row').count();
      expect(offered).toBeGreaterThan(0);

      // Everyone offered belongs to the selected branch — the server refuses a
      // cross-branch member with a 400, so a picker that offered one would be
      // building a form that cannot be saved.
      const inBranch = await api.get<{ data?: Employee[] } | Employee[]>('/employees?limit=100');
      const allowed = new Set(
        (Array.isArray(inBranch) ? inBranch : (inBranch?.data ?? [])).map((e) => e.id),
      );
      const shown = await page.getByTestId('batch-employee-row').evaluateAll((rows) =>
        rows.map((r) => r.getAttribute('data-employee-id')),
      );
      for (const id of shown) expect(allowed.has(id ?? '')).toBe(true);

      settle(problems, 'the batch employee picker');
    });

    test('PB-UI-04: Run payroll carries the batch to the run screen', async ({ page, problems }) => {
      await selectBranch(page, branchId);
      const batches = new PayrollBatchesPage(page);
      await batches.open();
      await batches.runPayroll(RENAMED);

      await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/dashboard/payroll/manage');
      expect(page.url()).toContain('batchId=');
      crashesOnly(problems);
    });

    test('PB-UI-05: a batch can be deleted and the list shrinks', async ({ page, problems }) => {
      await selectBranch(page, branchId);
      const batches = new PayrollBatchesPage(page);
      await batches.open();
      const before = await batches.count();

      await batches.delete(RENAMED);
      await page.getByTestId('confirm-modal-confirm').click().catch(() => {});

      await expect.poll(() => batches.card(RENAMED).count(), { timeout: 20_000 }).toBe(0);
      expect(await batches.count()).toBe(before - 1);
      settle(problems, 'the batches screen after a delete');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager or employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager') && !isProject('employee'), 'denial projects only');
    });

    test('PB-UI-10: a manager and an employee are refused the screen', async ({ page }) => {
      await page.goto('/dashboard/payroll/batches', { waitUntil: 'domcontentloaded' });
      // MANAGE_PAYROLL is ADMIN + HR_MANAGER. Before Phase 4 this page had no
      // guard at all: the chrome rendered, the buttons rendered, and every request
      // behind them 403'd.
      await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/403');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'hr project only');
    });

    test('PB-UI-11: HR reaches the screen', async ({ page, problems }) => {
      await page.goto('/dashboard/payroll/batches', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.url(), { timeout: 20_000 }).not.toContain('/403');
      await expect(page.getByTestId('batch-create').or(page.getByTestId('batch-create-first'))).toBeVisible();
      crashesOnly(problems);
    });
  });
});
