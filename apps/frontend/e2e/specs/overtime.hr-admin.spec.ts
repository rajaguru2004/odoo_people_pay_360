import { expect, test } from '@playwright/test';

/**
 * Overtime: the list, the tiers, and the breakdown that decides the money.
 *
 * A payroll officer and a department head reach these screens too — overtime
 * hours ARE a payroll fact, which is why payroll is admitted here and refused
 * the leave list. This file is `.hr-admin.` because those are the two projects
 * that exist and can also open every screen it touches.
 *
 * The breakdown on the detail page is the SERVER'S. It depends on the
 * employee's overtime policy and on the branch-aware day classification, and a
 * page that recomputed it from the global settings would print REGULAR where
 * the server said LATE — on the one screen that decides what is paid. So the
 * assertions look for the tier rows the server sent, with their hours and the
 * multiplier that prices them, rather than for a number this test could derive.
 */
test.describe('Overtime list', () => {
  test('lists the seeded requests with their payable hours', async ({ page }) => {
    await page.goto('/dashboard/overtime');

    await expect(page.getByRole('heading', { name: 'Overtime' })).toBeVisible();

    await expect(page.getByRole('link', { name: 'Ravi Kumar' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Deepak Rao' })).toBeVisible();

    // "Payable", not "worked": the attendance day boundary clamps a window
    // somebody forgot to close, and payroll reads the clamped figure.
    await expect(page.getByRole('columnheader', { name: 'Payable' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Worked' })).toBeVisible();
  });

  test('filters by tier', async ({ page }) => {
    await page.goto('/dashboard/overtime');

    // Ravi worked 17:30–23:00, so an hour of his window falls past the 22:00
    // threshold and the request is classified LATE. Hassan finished at 21:00
    // and is REGULAR, so he has to disappear.
    await page.getByLabel('Tier').selectOption('LATE');

    await expect(page.getByRole('link', { name: 'Ravi Kumar' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Hassan Al Hinai' })).toHaveCount(0);
  });

  test('filters by status', async ({ page }) => {
    await page.goto('/dashboard/overtime');

    await page.getByRole('button', { name: 'Rejected', exact: true }).click();

    await expect(page.getByRole('link', { name: 'Deepak Rao' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ravi Kumar' })).toHaveCount(0);
  });
});

test.describe('One overtime request', () => {
  test("shows the server's payable breakdown, tier by tier", async ({ page }) => {
    await page.goto('/dashboard/overtime');
    await page.getByRole('link', { name: 'Ravi Kumar' }).click();

    await expect(page).toHaveURL(/\/dashboard\/overtime\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'How it is paid' })).toBeVisible();

    const breakdown = page
      .getByRole('table')
      .filter({ has: page.getByRole('columnheader', { name: 'Rate' }) });

    for (const heading of ['Tier', 'Hours', 'Rate']) {
      await expect(breakdown.getByRole('columnheader', { name: heading })).toBeVisible();
    }

    // Ravi's window straddles the threshold, so it splits across two tiers —
    // which is the whole reason the page shows a table rather than one number.
    await expect(breakdown.getByRole('cell', { name: 'Regular', exact: true })).toBeVisible();
    await expect(breakdown.getByRole('cell', { name: 'Late', exact: true })).toBeVisible();

    // Hours as hours, and the rate as a multiplier — "1.25×" is how the line
    // reads on a payslip, so it is how it reads here.
    await expect(breakdown.getByRole('cell', { name: /^\d+(\.\d)?h$/ }).first()).toBeVisible();
    await expect(breakdown.getByRole('cell', { name: /×$/ }).first()).toBeVisible();

    // The tiers have to add up to something the reader can check against the
    // Payable figure above.
    await expect(breakdown.getByRole('cell', { name: 'Total', exact: true })).toBeVisible();
  });

  test('says which policy priced the hours, and what was allowed on top', async ({
    page,
  }) => {
    await page.goto('/dashboard/overtime');
    await page.getByRole('link', { name: 'Ravi Kumar' }).click();

    // A decided request carries the policy that classified it: editing a rate
    // later must not silently reprice what is already approved.
    await expect(page.getByText('Policy').first()).toBeVisible();
    await expect(page.getByText('Food allowance')).toBeVisible();
    await expect(page.getByText('Site allowance')).toBeVisible();
  });
});
