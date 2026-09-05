import { expect, test, type Page } from '@playwright/test';

/**
 * Deciding leave from the approval queue.
 *
 * This is the one leave spec that WRITES, which shapes two things about it.
 *
 * The projects act on DIFFERENT requests. `hr` and `admin` load this file and
 * run against one database at the same time, so both approving the same row
 * would leave whichever lost the race asserting against a request that is no
 * longer pending. The seed leaves exactly two, ordered by start date
 * descending, and each project takes one of them.
 *
 * The file is serial so the rejection walkthrough — which deliberately changes
 * nothing — runs against a request the approval test has not yet decided.
 *
 * The rejection half asserts the GUARD rather than the rejection: the person
 * who filed a request is owed a reason, and "Rejected" on its own is the start
 * of an argument rather than the end of one. So the confirm button stays
 * disabled until there is something to send back.
 */
test.describe.configure({ mode: 'serial' });

/** Seeded pending leave, split so the two projects never contend. */
const TARGET: Record<string, string> = {
  admin: 'Priya Nair',
  hr: 'Fatma Al Rashdi',
};

/**
 * The queue card for one person.
 *
 * The innermost block that holds both their name and the decision buttons —
 * the queue draws a card per request, and `Approve` on its own matches every
 * one of them.
 */
const cardFor = (page: Page, employee: string) =>
  page
    .locator('div')
    .filter({ has: page.getByRole('link', { name: employee }) })
    .filter({ has: page.getByRole('button', { name: 'Approve' }) })
    .last();

const targetFor = () => TARGET[test.info().project.name] ?? 'Fatma Al Rashdi';

test.describe('The approval queue', () => {
  test('will not send a rejection back without a reason', async ({ page }) => {
    const employee = targetFor();
    await page.goto('/dashboard/leaves/pending');

    await expect(page.getByRole('heading', { name: 'Pending leave' })).toBeVisible();

    await cardFor(page, employee).getByRole('button', { name: 'Reject' }).click();

    const confirm = page.getByRole('button', { name: 'Confirm rejection' });
    await expect(confirm).toBeDisabled();

    await page.getByLabel('Why it is being rejected').fill('Two people are already off that week');
    await expect(confirm).toBeEnabled();

    // Backed out on purpose: this test is about the guard, and the approval
    // test below needs the request still waiting.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
  });

  test('approves a request, and the row leaves the queue', async ({ page }) => {
    const employee = targetFor();
    await page.goto('/dashboard/leaves/pending');

    await expect(cardFor(page, employee)).toBeVisible();
    await cardFor(page, employee).getByRole('button', { name: 'Approve' }).click();

    // The SERVER'S sentence, not a generic one: it is the only thing that knows
    // how many of the approved days already carried an attendance record.
    await expect(page.getByText(/leave approved/i)).toBeVisible();

    // A decided request is not waiting on anybody, so it must leave the queue
    // rather than sit there inviting a second decision.
    await expect(page.getByRole('link', { name: employee })).toHaveCount(0);
  });

  test('and the decision shows on the company list', async ({ page }) => {
    const employee = targetFor();
    await page.goto('/dashboard/leaves');

    await page.getByRole('button', { name: 'Approved', exact: true }).click();
    await expect(page.getByRole('link', { name: employee })).toBeVisible();
  });
});
