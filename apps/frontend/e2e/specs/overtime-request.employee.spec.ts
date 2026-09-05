import { expect, test } from '@playwright/test';

/**
 * Logging overtime, as the person who worked it.
 *
 * The form computes the LENGTH of the window and nothing else, and this spec
 * asserts exactly that boundary. How the hours split across the payable tiers,
 * whether a food allowance applies and whether the day counts as a rest day all
 * depend on the employee's policy and on the branch calendar — neither of which
 * the browser has. A figure guessed here is a figure the approval then
 * contradicts, so the page must show the window and defer the rest.
 *
 * `employee@peoplepay360.com` is EMP-0005, who has no seeded overtime. That is
 * deliberate in the assertions below: her own list is allowed to be empty, and
 * an empty self-service list has to SAY it is empty rather than draw a blank
 * card the reader reads as a failure.
 */
test.describe('Logging overtime', () => {
  test('asks for the window worked, and nothing it cannot answer for', async ({
    page,
  }) => {
    await page.goto('/dashboard/overtime/new');

    await expect(page.getByRole('heading', { name: 'Log overtime' })).toBeVisible();
    await expect(page.getByLabel('Day worked')).toBeVisible();
    await expect(page.getByLabel('Started')).toBeVisible();
    await expect(page.getByLabel('Finished')).toBeVisible();

    // Recording hours for somebody else is an HR action — these become their
    // pay — so this role is never offered the picker.
    await expect(page.getByLabel('Employee')).toHaveCount(0);
  });

  test('recomputes the window as the times change', async ({ page }) => {
    await page.goto('/dashboard/overtime/new');

    // The defaults, 17:30 to 21:30.
    await expect(page.getByText('4h', { exact: true })).toBeVisible();

    await page.getByLabel('Started').fill('18:00');
    await expect(page.getByText('3.5h', { exact: true })).toBeVisible();

    await page.getByLabel('Finished').fill('22:30');
    await expect(page.getByText('4.5h', { exact: true })).toBeVisible();
  });

  test('reads a finish before the start as crossing midnight, not as an error', async ({
    page,
  }) => {
    await page.goto('/dashboard/overtime/new');

    await page.getByLabel('Started').fill('18:00');
    await page.getByLabel('Finished').fill('01:00');

    await expect(page.getByText('7h', { exact: true })).toBeVisible();
    // Exactly how the server reads it. The page says so, and says that the
    // payable share depends on when the attendance day closes.
    await expect(page.getByText(/crosses midnight/i)).toBeVisible();
  });

  test('never claims to know the payable total', async ({ page }) => {
    await page.goto('/dashboard/overtime/new');

    await expect(
      page.getByText(/the payable total can be lower than this/i),
    ).toBeVisible();
  });
});

test.describe('My overtime', () => {
  test('is the caller\'s own list, and says so when it is empty', async ({ page }) => {
    await page.goto('/dashboard/my-overtime');

    await expect(page.getByRole('heading', { name: 'My overtime' })).toBeVisible();

    // The totals on this page are computed from the page on screen, because
    // they ARE the page: an employee is not entitled to a company-wide figure.
    await expect(page.getByText('Approved hours')).toBeVisible();
    await expect(page.getByText('Awaiting a decision')).toBeVisible();

    // Rows if this account has logged any, the empty state if it has not.
    // Either is the screen working; a blank card would be neither.
    await expect(
      page
        .getByRole('columnheader', { name: 'Payable' })
        .or(page.getByText(/you have not logged any overtime/i)),
    ).toBeVisible();

    // No Employee column on a personal list: every row is the reader.
    await expect(page.getByRole('columnheader', { name: 'Employee' })).toHaveCount(0);
  });

  test('offers the form from the list', async ({ page }) => {
    await page.goto('/dashboard/my-overtime');

    await page.getByRole('link', { name: 'Log overtime' }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/overtime\/new$/);
  });
});
