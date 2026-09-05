import { test, expect, settle, crashesOnly } from '../fixtures';

/**
 * Arabic, and right-to-left.
 *
 * The app ships two locales and every other spec pins `en`, deliberately: a
 * suite that selected on translated text would be testing the language rather
 * than the behaviour. That leaves `ar` completely unexercised, which is how a
 * missing message key or an RTL layout break reaches production unnoticed.
 *
 * This is a smoke test, not a second suite. It asserts the things that are
 * cheap and would be catastrophic: the direction actually flips, the screens
 * still render, and no key falls back to its raw name in front of a user.
 *
 * Deliberately NOT asserted: any particular translation. Wording is a content
 * decision and pinning it here would make every copy edit a test failure.
 */

const isProject = (name: string) => test.info().project.name === name;

/** Switches locale the way the language selector does, then loads the screen. */
async function openInArabic(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() =>
    window.localStorage.setItem('locale-storage', JSON.stringify({ state: { locale: 'ar' }, version: 0 })),
  );
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

test.describe('the Arabic locale', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'one locale smoke run is enough');
  });

  test('flips the document direction to RTL', async ({ page, problems }) => {
    await openInArabic(page, '/dashboard/my-leaves');

    // `LocaleProvider` writes lang/dir onto <html>. If this stops happening the
    // page renders Arabic text in a left-to-right layout, which is unreadable
    // rather than merely untidy.
    await expect.poll(() => page.locator('html').getAttribute('dir'), { timeout: 10_000 }).toBe('rtl');
    expect(await page.locator('html').getAttribute('lang')).toBe('ar');

    settle(problems, 'my-leaves in Arabic');
  });

  test('leaves the direction LTR in English', async ({ page, problems }) => {
    // The control: every other spec depends on this being the default.
    await page.goto('/dashboard/my-leaves', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    await expect.poll(() => page.locator('html').getAttribute('dir'), { timeout: 10_000 }).toBe('ltr');

    settle(problems, 'my-leaves in English');
  });

  const SCREENS = ['/dashboard', '/dashboard/my-leaves', '/dashboard/my-attendance', '/dashboard/profile'];

  for (const path of SCREENS) {
    test(`${path} still renders in Arabic`, async ({ page, problems }) => {
      await openInArabic(page, path);

      const body = await page.locator('body').innerText();
      expect(body.trim().length, `${path} rendered empty in Arabic`).toBeGreaterThan(0);
      expect(body, `${path} showed a Next error page in Arabic`).not.toContain(
        'Application error: a client-side exception',
      );

      // Data endpoints answer the same either way, so a console error here
      // would be about rendering rather than about the locale. Crashes still
      // count.
      crashesOnly(problems);
      settle(problems, `${path} in Arabic`);
    });
  }

  test('shows no raw message keys to the user', async ({ page, problems }) => {
    await openInArabic(page, '/dashboard/my-leaves');

    // next-intl falls back to the key itself when a translation is missing, so
    // an untranslated screen reads as `sidebar.myLeaves` rather than as words.
    // Catching that is the main reason this file exists.
    const body = await page.locator('body').innerText();
    const rawKeys = body.match(/\b[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]{3,}\b/g) ?? [];

    // Filenames and domains match the same shape, so only flag the namespaces
    // this app actually uses.
    const suspicious = rawKeys.filter((k) =>
      /^(sidebar|common|topHeader|dashboard|leaves|attendance|employees|payroll|overtime)\./.test(k),
    );

    expect(suspicious, 'untranslated message keys are visible in Arabic').toEqual([]);

    crashesOnly(problems);
    settle(problems, 'checking for raw keys');
  });
});
