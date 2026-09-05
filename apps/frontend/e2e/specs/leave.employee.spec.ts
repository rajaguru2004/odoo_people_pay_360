import { expect, test } from '@playwright/test';

/**
 * Leave, from the inside: what this employee has left and what they have filed.
 *
 * `employee@peoplepay360.com` is EMP-0005, Fatma Al Rashdi, who the seed leaves
 * with a year of entitlement and one request of her own.
 *
 * The second half is the more important one. Self-service and the company list
 * are SEPARATE SCREENS rather than one screen with a filter, because the
 * company list answers by name and by reason across the whole workforce and the
 * server refuses it to this role — a filtered view would be a page that renders
 * empty for exactly the people it was built for. The rail hiding those entries
 * is a UI affordance and never the boundary, so what is asserted here is the
 * DENIAL: somebody following a bookmark has to land somewhere that says no.
 */
test.describe('My leave', () => {
  test('shows what is left, per entitlement', async ({ page }) => {
    await page.goto('/dashboard/my-leaves');

    await expect(page.getByRole('heading', { name: 'My leave' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What is left' })).toBeVisible();

    // One card per type the employee is actually entitled to. A gender-
    // restricted type is never allocated to somebody who could not take it, so
    // the cards are per-person and not a fixed set.
    await expect(page.getByText('Annual Leave').first()).toBeVisible();
    await expect(page.getByText('Sick Leave').first()).toBeVisible();
  });

  test('lists the requests this employee filed', async ({ page }) => {
    await page.goto('/dashboard/my-leaves');

    // The seeded request, matched on its reason: another spec decides it while
    // this one runs, so its STATUS is not a safe thing to assert on — that it
    // is on her own list is.
    await expect(page.getByText(/flights already booked/i)).toBeVisible();

    // No Employee column: every row on this screen is the reader.
    await expect(page.getByRole('columnheader', { name: 'Employee' })).toHaveCount(0);
  });

  test('filters that list by status', async ({ page }) => {
    await page.goto('/dashboard/my-leaves');

    await page.getByRole('button', { name: 'Rejected', exact: true }).click();

    // Nothing of hers was refused, and an empty list has to say so rather than
    // leave a blank card the reader reads as a broken page.
    await expect(
      page
        .getByText(/you have not filed any leave/i)
        .or(page.getByRole('columnheader', { name: 'Status' })),
    ).toBeVisible();
  });

  test('offers the self screens in the rail and none of the company ones', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('link', { name: 'My leave', exact: true })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Leave requests', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Leave balances', exact: true }),
    ).toHaveCount(0);
  });
});

test.describe('The company-wide leave screens refuse this role', () => {
  for (const [name, path] of [
    ['the module hub', '/dashboard/leave'],
    ['every request in the company', '/dashboard/leaves'],
    ['the approval queue', '/dashboard/leaves/pending'],
    ['the entitlement grid', '/dashboard/leaves/balances'],
    ['the leave type library', '/dashboard/leave/types'],
  ] as const) {
    test(`${name} lands on 403 rather than on a crashed page`, async ({ page }) => {
      await page.goto(path);

      await expect(page).toHaveURL(/\/403$/);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });
  }
});
