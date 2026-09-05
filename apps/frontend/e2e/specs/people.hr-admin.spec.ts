import { expect, test } from '@playwright/test';

/**
 * The People module. Loaded only by the `hr` and `admin` projects — an employee
 * has no VIEW_EMPLOYEES permission, so the rail does not even render the entry.
 */
test.describe('People hub', () => {
  test('is reachable from the sidebar and names itself', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'People', exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard\/people$/);
    await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
  });

  test('reports the active workforce as a real figure', async ({ page }) => {
    await page.goto('/dashboard/people');

    // Eighteen of the twenty seeded people are active; one is on leave and one
    // has been terminated.
    await expect(page.getByTestId('kpi-active')).toContainText('18');
  });

  test('offers a tile per child route', async ({ page }) => {
    await page.goto('/dashboard/people');
    await expect(page.getByTestId('module-tile')).toHaveCount(7);
  });
});

test.describe('Employee directory', () => {
  test('is reachable through the People group in the rail', async ({ page }) => {
    await page.goto('/dashboard');

    // Employees is a CHILD of People now, so the group has to be opened before
    // its links exist. A flat rail would have offered the link directly.
    await page.getByRole('button', { name: 'People' }).click();
    await page.getByRole('link', { name: 'Employee directory' }).click();

    await expect(page).toHaveURL(/\/dashboard\/employees$/);
    await expect(page.getByRole('heading', { name: 'Employees' })).toBeVisible();
  });

  test('lists employees and reports how many there are', async ({ page }) => {
    await page.goto('/dashboard/employees');

    await expect(page.getByRole('heading', { name: 'Employees' })).toBeVisible();
    await expect(page.getByText('Aisha Al Balushi')).toBeVisible();
  });

  test('the search box filters without a full page load', async ({ page }) => {
    await page.goto('/dashboard/employees');

    await page.getByLabel('Search employees').fill('Aisha');
    await expect(page.getByText('Aisha Al Balushi')).toBeVisible();
    await expect(page.getByText('Ahmed Al Farsi')).toBeHidden();
  });

  test('says so plainly when a search matches nothing', async ({ page }) => {
    await page.goto('/dashboard/employees');
    await page.getByLabel('Search employees').fill('zzz-no-such-employee');
    await expect(page.getByText(/nothing matches that search/i)).toBeVisible();
  });

  test('opens an employee record', async ({ page }) => {
    await page.goto('/dashboard/employees');
    await page.getByRole('link', { name: /aisha al balushi/i }).first().click();

    await expect(page).toHaveURL(/\/dashboard\/employees\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole('heading', { name: /aisha al balushi/i }),
    ).toBeVisible();
  });

  test('the new-employee form is reachable and labelled', async ({ page }) => {
    await page.goto('/dashboard/employees/new');

    await expect(page.getByLabel('Employee code')).toBeVisible();
    await expect(page.getByLabel('First name')).toBeVisible();
    await expect(page.getByLabel('Last name')).toBeVisible();
    await expect(page.getByRole('button', { name: /create employee/i })).toBeEnabled();
  });

  test('refuses to submit the new-employee form with the required fields empty', async ({ page }) => {
    await page.goto('/dashboard/employees/new');
    await page.getByRole('button', { name: /create employee/i }).click();

    // The form has to say what is wrong. Navigating away on an invalid submit
    // is how a half-filled record reaches the API.
    await expect(page.getByText(/required/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/employees\/new$/);
  });
});

test.describe('Teams', () => {
  test('lists the seeded teams with their department and lead', async ({ page }) => {
    await page.goto('/dashboard/teams');

    await expect(page.getByRole('heading', { name: 'Teams' })).toBeVisible();
    await expect(page.getByText('Payroll Operations')).toBeVisible();
    await expect(page.getByText('Shift A')).toBeVisible();
  });

  test('opens a team and lists who is on it', async ({ page }) => {
    await page.goto('/dashboard/teams');
    await page.getByRole('link', { name: /payroll operations/i }).first().click();

    await expect(page).toHaveURL(/\/dashboard\/teams\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Rahul Menon')).toBeVisible();
  });
});

test.describe('Contracts', () => {
  test('lists contracts against the people they belong to', async ({ page }) => {
    await page.goto('/dashboard/contracts');

    await expect(page.getByRole('heading', { name: 'Contracts' })).toBeVisible();
    await expect(page.getByText(/CTR-/).first()).toBeVisible();
  });

  test('the new-contract form is reachable and labelled', async ({ page }) => {
    await page.goto('/dashboard/contracts/new');

    await expect(page.getByLabel('Employee')).toBeVisible();
    await expect(page.getByLabel('Contract type')).toBeVisible();
    await expect(page.getByLabel('Start date')).toBeVisible();
  });

  test('shows the terminations queue', async ({ page }) => {
    await page.goto('/dashboard/contracts/terminations');
    await expect(page.getByRole('heading', { name: /terminations/i })).toBeVisible();
  });
});

test.describe('Visa reports', () => {
  test('lists work permits with how long each has left', async ({ page }) => {
    await page.goto('/dashboard/visa-reports');

    await expect(page.getByRole('heading', { name: /visa reports/i })).toBeVisible();
    // The seed issues a permit to every expatriate and none to a national.
    await expect(page.getByText(/VISA-OM-/).first()).toBeVisible();
  });

  test('names the alert window rather than leaving "expiring soon" undefined', async ({ page }) => {
    await page.goto('/dashboard/visa-reports');
    await expect(page.getByText(/30 days/i).first()).toBeVisible();
  });
});
