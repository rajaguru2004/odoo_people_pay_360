import { expect, test } from '@playwright/test';

/**
 * Every leave request in the company.
 *
 * `.hr-admin.` because the list answers BY NAME and by REASON — a medical
 * certificate sits behind half these rows — so the server refuses it to an
 * employee and to a payroll officer. An employee reads their own at
 * /dashboard/my-leaves instead, which `leave.employee.spec.ts` covers.
 *
 * The rows asserted on here are the DECIDED ones. The two pending requests are
 * what the approval spec acts on, and a list test that pinned their status
 * would be asserting on whichever spec happened to run first.
 */
test.describe('Leave requests', () => {
  test('lists the seeded requests', async ({ page }) => {
    await page.goto('/dashboard/leaves');

    await expect(page.getByRole('heading', { name: 'Leave requests' })).toBeVisible();

    // Zainab's annual leave spans today in the seed; Anil's was refused. Both
    // are decided, so no other spec can move them.
    await expect(page.getByRole('link', { name: 'Zainab Al Habsi' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Anil Verma' })).toBeVisible();
  });

  test('filters by status', async ({ page }) => {
    await page.goto('/dashboard/leaves');

    await page.getByRole('button', { name: 'Rejected', exact: true }).click();

    await expect(page.getByRole('link', { name: 'Anil Verma' })).toBeVisible();
    // Approved rows have to LEAVE, or the tab is decoration over an unfiltered
    // query — which is the failure a status filter is most likely to have.
    await expect(page.getByRole('link', { name: 'Zainab Al Habsi' })).toHaveCount(0);

    // Withdrawn, not "Cancelled": a request somebody took back is not a refused
    // one, and the queue must not read as a wall of rejections.
    await page.getByRole('button', { name: 'Withdrawn', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Noora Al Siyabi' })).toBeVisible();
  });

  test('narrows by leave type', async ({ page }) => {
    await page.goto('/dashboard/leaves');

    // The options are the library labels themselves, which is also what
    // `LeaveRequest.leaveType` stores — one string, not a key and a caption.
    await page.getByLabel('Leave type').selectOption('Sick Leave');

    await expect(page.getByRole('link', { name: 'Hassan Al Hinai' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Zainab Al Habsi' })).toHaveCount(0);
  });

  test('says so when a filter matches nothing', async ({ page }) => {
    await page.goto('/dashboard/leaves');

    await page.getByLabel('Search').fill('zzz-no-such-person');

    // An empty result is a sentence, not a blank card: the reader has to be
    // told the filters are the reason and how to widen them.
    await expect(
      page.getByText(/no leave requests match these filters/i),
    ).toBeVisible();
  });

  test('a row opens the request it stands for', async ({ page }) => {
    await page.goto('/dashboard/leaves');

    await page.getByRole('link', { name: 'Zainab Al Habsi' }).click();

    await expect(page).toHaveURL(/\/dashboard\/leaves\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole('heading', { name: /annual leave request/i }),
    ).toBeVisible();

    // The two dates the request is actually about, and the working-day count
    // the branch calendar produced from them.
    await expect(page.getByText('First day off')).toBeVisible();
    await expect(page.getByText('Last day off')).toBeVisible();
    await expect(page.getByText('Working days')).toBeVisible();
  });
});
