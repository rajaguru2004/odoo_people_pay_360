import { expect, test } from '@playwright/test';

/**
 * The Organisation module.
 *
 * The `.hr-admin.` segment means only the `hr` and `admin` projects load this
 * file — the module is not in a payroll officer's or an employee's rail, so
 * scheduling it for them would open a browser only to assert a 403.
 */
test.describe('Organisation hub', () => {
  test('is reachable from the sidebar and names itself', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Organisation', exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard\/organization$/);
    await expect(page.getByRole('heading', { name: 'Organisation' })).toBeVisible();
  });

  test('reports headcount, branches and departments as real figures', async ({ page }) => {
    await page.goto('/dashboard/organization');

    // The seed puts twenty people across two branches and seven departments.
    // An em dash here means the aggregate failed and the page correctly refused
    // to invent a zero — which is right behaviour but a broken deployment.
    const branches = page.getByTestId('kpi-branches');
    await expect(branches).toBeVisible();
    await expect(branches).toContainText('2');

    const departments = page.getByTestId('kpi-departments');
    await expect(departments).toContainText('7');
  });

  test('surfaces the department that has nobody in charge of it', async ({ page }) => {
    await page.goto('/dashboard/organization');

    // Administration is deliberately headless in the seed. The whole purpose of
    // the attention strip is that this is visible without opening a report.
    await page.getByRole('button', { name: /needs attention/i }).click();
    await expect(page.getByText(/Administration/).first()).toBeVisible();
  });

  test('offers a tile per child route, and the tiles navigate', async ({ page }) => {
    await page.goto('/dashboard/organization');

    const tiles = page.getByTestId('module-tile');
    await expect(tiles).toHaveCount(4);

    await page.getByRole('link', { name: /branches/i }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/branches$/);
  });
});

test.describe('Branches', () => {
  test('lists the seeded branches with their occupancy', async ({ page }) => {
    await page.goto('/dashboard/branches');

    await expect(page.getByRole('heading', { name: 'Branches' })).toBeVisible();
    await expect(page.getByText('Head Office')).toBeVisible();
    await expect(page.getByText('Sohar Plant')).toBeVisible();
  });

  test('opens a branch and shows its working calendar', async ({ page }) => {
    await page.goto('/dashboard/branches');
    await page.getByRole('link', { name: /head office/i }).first().click();

    await expect(page).toHaveURL(/\/dashboard\/branches\/[0-9a-f-]{36}$/);
    // The office window is a wall clock, printed as one.
    await expect(page.getByText('08:00')).toBeVisible();
  });
});

test.describe('Departments', () => {
  test('lists departments with their head and headcount', async ({ page }) => {
    await page.goto('/dashboard/departments');

    await expect(page.getByRole('heading', { name: 'Departments' })).toBeVisible();
    await expect(page.getByText('Human Resources')).toBeVisible();
  });

  test('draws the hierarchy as a tree, not a flat list', async ({ page }) => {
    await page.goto('/dashboard/departments/tree');

    await expect(
      page.getByRole('heading', { name: /organisational chart/i }),
    ).toBeVisible();

    // Executive is the root and Maintenance sits two levels down under
    // Operations. A flat render would put every node at the same depth.
    const root = page.getByTestId('tree-node-EXEC');
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute('data-tree-level', '0');

    await expect(page.getByTestId('tree-node-OPS')).toHaveAttribute(
      'data-tree-level',
      '1',
    );
  });

  test('expands a node to reveal what sits under it', async ({ page }) => {
    await page.goto('/dashboard/departments/tree');

    const ops = page.getByTestId('tree-node-OPS');
    await expect(ops).toBeVisible();
    await expect(page.getByTestId('tree-node-MAINT')).toBeVisible();
  });
});

test.describe('Department change requests', () => {
  test('shows the queue with what each request would change', async ({ page }) => {
    await page.goto('/dashboard/departments/change-requests');

    await expect(
      page.getByRole('heading', { name: /change requests/i }),
    ).toBeVisible();

    // Filtered to Pending rather than counting the whole table. The seed
    // guarantees exactly these two — a head for Administration and a reparent
    // of Maintenance — whereas the total also carries whatever history the API
    // suite has left behind, and an assertion a sibling suite can move is an
    // assertion that fails for the wrong reason.
    await page.getByRole('button', { name: 'Pending', exact: true }).click();

    const rows = page.getByTestId('change-request-row');
    await expect(rows).toHaveCount(2);
    await expect(page.getByText('Administration')).toBeVisible();
  });

  test('opens a request and shows what approving it would touch', async ({ page }) => {
    await page.goto('/dashboard/departments/change-requests');
    await page.getByTestId('change-request-row').first().click();

    await expect(page).toHaveURL(
      /\/dashboard\/departments\/change-requests\/[0-9a-f-]{36}$/,
    );
    await expect(page.getByText(/affected employees/i)).toBeVisible();
  });
});
