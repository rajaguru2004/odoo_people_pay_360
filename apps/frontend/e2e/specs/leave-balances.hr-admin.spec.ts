import { expect, test } from '@playwright/test';

/**
 * Entitlement: what the company owes, and what each employee has left.
 *
 * `.hr-admin.` — a payroll officer is not admitted, and an employee sees only
 * their own cards on /dashboard/my-leaves.
 *
 * The columns are the point of the screen. An allocation is held per TYPE
 * rather than as one "leave days" number, because annual and sick leave are
 * separate entitlements with separate rules; a grid with a single column is how
 * a company ends up unable to say how much sick leave it actually grants. So
 * the seeded types have to be COLUMNS here — and Unpaid Leave, the one type
 * that costs no entitlement, has to be absent from them.
 */
test.describe('Leave balances', () => {
  test('names itself and totals the year', async ({ page }) => {
    await page.goto('/dashboard/leaves/balances');

    await expect(page.getByRole('heading', { name: 'Leave balances' })).toBeVisible();

    for (const label of ['Active staff', 'Allocated', 'Taken', 'Still owed']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  test('breaks the company total down by leave type', async ({ page }) => {
    await page.goto('/dashboard/leaves/balances');

    await expect(page.getByRole('heading', { name: 'By leave type' })).toBeVisible();

    const byType = page.getByRole('table').first();
    await expect(byType.getByRole('cell', { name: 'Annual Leave' })).toBeVisible();
    await expect(byType.getByRole('cell', { name: 'Sick Leave' })).toBeVisible();

    // Carried-over days are a column of their own: an entitlement is not only
    // what was granted this year, and a "remaining" that ignored them would be
    // short for everybody who brought days in.
    for (const heading of ['Allocated', 'Carried over', 'Taken', 'Remaining', 'Used']) {
      await expect(byType.getByRole('columnheader', { name: heading })).toBeVisible();
    }
  });

  test('gives each entitlement its own column, and one row per employee', async ({
    page,
  }) => {
    await page.goto('/dashboard/leaves/balances');

    await expect(
      page.getByRole('columnheader', { name: 'Annual Leave' }),
    ).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Sick Leave' })).toBeVisible();

    // Unpaid Leave touches no balance — it is recorded and it still writes
    // ON_LEAVE attendance, it simply costs nothing — so it must not appear as a
    // column somebody could type an allocation into.
    await expect(
      page.getByRole('columnheader', { name: 'Unpaid Leave' }),
    ).toHaveCount(0);

    await expect(page.getByText('Fatma Al Rashdi')).toBeVisible();
  });

  test('searches the grid by name', async ({ page }) => {
    await page.goto('/dashboard/leaves/balances');

    await page.getByLabel('Search').fill('Fatma');
    await expect(page.getByText('Fatma Al Rashdi')).toBeVisible();
    await expect(page.getByText('Zainab Al Habsi')).toHaveCount(0);

    await page.getByLabel('Search').fill('zzz-no-such-person');
    await expect(page.getByText(/nobody matches/i)).toBeVisible();
  });
});
