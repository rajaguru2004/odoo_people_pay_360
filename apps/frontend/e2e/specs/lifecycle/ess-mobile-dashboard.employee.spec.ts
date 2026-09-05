import { test, expect, settle } from '../../fixtures';
import { PHONE, auditPhoneScreen } from '../../mobile-audit';

/**
 * The ESS home screen on a phone.
 *
 * The generic half of what this file used to assert — overflow, target sizes,
 * tab-bar clearance, the CSS split — now lives in `e2e/mobile-audit.ts` and is
 * shared by every ESS screen. What stays here is what is true of THIS screen
 * and no other: that the shift card is on it, and that the hero and its cards
 * survive the phone width.
 *
 * Shell behaviour (tab routing, `aria-current`) moved to
 * `ess-mobile-shell.employee.spec.ts` — it is identical on all forty screens,
 * so testing it once is right and testing it forty times is forty times the
 * cost for no extra information.
 */

test.use(PHONE);

const isEmployee = () => test.info().project.name === 'employee';

test.describe('the ESS dashboard on a phone', () => {
  test.beforeEach(() => {
    test.skip(!isEmployee(), 'the phone layout is the ESS portal');
  });

  test('ESS-MOB-01 shows the phone layout and hides the desktop one', async ({ page, problems }) => {
    await page.goto('/dashboard');

    await expect(page.getByTestId('ess-mobile-dashboard')).toBeVisible();
    await expect(page.getByTestId('ess-mobile-shift-card')).toBeVisible();
    await expect(page.getByTestId('ess-mobile-primary-action')).toBeVisible();
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();

    // The approved desktop layout is present but not painted — the split is
    // CSS, so a phone never renders the desktop grid even for a frame.
    await expect(page.locator('main .hidden.md\\:block').first()).toBeHidden();

    // Employees reach the drawer from the bar's More tab.
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();

    settle(problems, 'the phone dashboard');
  });

  test('ESS-MOB-02 fits the viewport, is thumb-sized, and clears the tab bar', async ({
    page,
    problems,
  }) => {
    const report = await auditPhoneScreen(page, '/dashboard', {
      problems,
      ready: 'ess-mobile-dashboard',
      label: 'the ESS dashboard',
      shot: 'ess-dashboard',
    });

    // Reported rather than merely passed: a gap that quietly shrinks from 16px
    // to 1px is a regression on its way to becoming an overlap.
    expect(report.tabBarGap, 'no tab bar was measured').not.toBeNull();
  });
});
