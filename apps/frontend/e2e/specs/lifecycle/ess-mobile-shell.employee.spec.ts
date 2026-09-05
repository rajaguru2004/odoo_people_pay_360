import { test, expect, settle } from '../../fixtures';
import { PHONE } from '../../mobile-audit';

/**
 * The phone shell itself — the tab bar and the drawer behind its More tab.
 *
 * Separated from the dashboard spec because it is the same on every ESS screen:
 * asserting it once is a claim about the shell, asserting it forty times is the
 * same claim, forty times slower.
 *
 * **Every tab is clicked here, and that is the point.** The previous version
 * clicked Leave and More only, and the one tab it never pressed — Payslip —
 * pointed at `/dashboard/my-payroll`, a segment with no `page.tsx`. A quarter
 * of the ESS bottom bar answered 404 and no test noticed. See D-01 in
 * `docs/ESS-MOBILE-UI-TRACKER.md`.
 */

test.use(PHONE);

const isEmployee = () => test.info().project.name === 'employee';

/** Every destination the bar offers, and the screen it must actually reach. */
const TABS = [
  { testId: 'mobile-tab-navHome', path: '/dashboard' },
  { testId: 'mobile-tab-navAttendance', path: '/dashboard/my-attendance' },
  { testId: 'mobile-tab-navLeave', path: '/dashboard/my-leaves' },
  { testId: 'mobile-tab-navPayslip', path: '/dashboard/payroll' },
] as const;

test.describe('the ESS phone shell', () => {
  test.beforeEach(() => {
    test.skip(!isEmployee(), 'the tab bar is EMPLOYEE-only');
  });

  test('ESS-MOB-05 every tab reaches a real screen and marks itself current', async ({
    page,
    problems,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    await expect(page.getByTestId('mobile-tab-navHome')).toHaveAttribute('aria-current', 'page');

    for (const { testId, path } of TABS) {
      await page.getByTestId(testId).click();
      await page.waitForURL(`**${path}`);

      // A 404 in this app renders Next's own not-found page, which has no
      // <main> from the dashboard shell — so the tab bar itself is the proof
      // that the route resolved to a real ESS screen.
      await expect(page.getByTestId('mobile-tab-bar'), `${path} did not render the ESS shell`).toBeVisible();
      await expect(page.getByTestId(testId), `${path} did not light ${testId}`).toHaveAttribute(
        'aria-current',
        'page',
      );
    }

    settle(problems, 'the phone tab bar');
  });

  test('ESS-MOB-06 More opens the drawer without navigating', async ({ page, problems }) => {
    await page.goto('/dashboard/my-leaves');
    await page.getByTestId('mobile-tab-navMore').click();

    await expect(page.locator('aside').first()).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/dashboard/my-leaves');

    settle(problems, 'the More drawer');
  });

  test('ESS-MOB-07 the tab bar is EMPLOYEE-only and off at desktop width', async ({
    page,
    problems,
  }) => {
    // Two independent definitions of one seam: the CSS `md:hidden` on the bar,
    // and `useMediaQuery('(max-width: 767px)')` in `hooks/useMediaQuery.ts`,
    // which decides the sidebar's drawer behaviour. They agree today and
    // nothing tested that they keep agreeing.
    await page.goto('/dashboard');
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();

    await page.setViewportSize({ width: 767, height: 844 });
    await page.waitForTimeout(250);
    await expect(page.getByTestId('mobile-tab-bar'), 'still a phone at 767').toBeVisible();
    await expect(page.getByTestId('ess-mobile-dashboard')).toBeVisible();

    await page.setViewportSize({ width: 768, height: 900 });
    await page.waitForTimeout(250);
    await expect(page.getByTestId('mobile-tab-bar'), 'desktop at 768').toBeHidden();
    await expect(page.getByTestId('ess-mobile-dashboard'), 'phone tree at 768').toBeHidden();
    await expect(page.locator('main .hidden.md\\:block').first()).toBeVisible();

    settle(problems, 'the breakpoint seam');
  });
});
