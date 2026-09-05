import type { Page } from '@playwright/test';

/**
 * Deliberate full-page captures of the module hubs.
 *
 * `playwright.config.ts` sets `screenshot: 'only-on-failure'`, which is the
 * right default for a suite that asserts — but it means a PASSING run produces
 * no image, and the module hubs are the one place where "the assertions pass"
 * and "the page looks right" are genuinely different questions. A panel that is
 * half the height of its neighbours, a stacked bar whose bands do not fill it,
 * an axis that squashes every bar into the bottom fifth: none of that fails a
 * test, and all of it is the whole point of the design being finalized.
 *
 * So the hub specs capture on purpose, into `e2e/.screens/`, one image per
 * period tab, plus the Time & Attendance hub as the reference the other two are
 * read against.
 *
 * Kept out of `pages/` because these are not page objects — nothing here
 * drives the app, it only records what the app drew.
 */

/** Where the images land. Git-ignored alongside `.report` and `.logs`. */
export const SCREEN_DIR = 'e2e/.screens';

/**
 * Wait for the hub to be finished drawing, then capture it whole.
 *
 * `networkidle` alone is not enough: the KPI row animates in with a
 * per-card delay (`StatCard.tsx:138-142`, `0.05 + index * 0.05`), so a capture
 * taken the moment the request settles catches cards mid-fade and every image
 * looks like a rendering bug. The wait is for the last card's animation to have
 * finished, not for an arbitrary timeout.
 */
export async function captureHub(
  page: Page,
  name: string,
  opts: { settleMs?: number } = {},
): Promise<string> {
  await page.waitForLoadState('networkidle').catch(() => {});
  // Five cards × 50ms stagger + 300ms duration, rounded up, plus the charts'
  // own 500–600ms flex/stroke transitions.
  await page.waitForTimeout(opts.settleMs ?? 1200);

  // `fullPage` is not enough here. The dashboard shell scrolls an INNER
  // container, not the document, so the document's scroll height is one
  // viewport and a "full page" capture stops at the fold — which is exactly
  // where the three insight panels start. Growing the viewport is what
  // actually reveals the rest of the page.
  const original = page.viewportSize();
  await page.setViewportSize({ width: original?.width ?? 1280, height: 2600 });
  await page.waitForTimeout(400);

  const path = `${SCREEN_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });

  if (original) await page.setViewportSize(original);
  return path;
}

/**
 * Open a hub, switch to `tab`, and capture it.
 *
 * Waits for the period label to actually CHANGE rather than for the network to
 * go quiet — the network can settle before the click has been handled at all,
 * and the capture then records the previous window under the new tab's name.
 */
export async function captureTab(
  page: Page,
  tab: string,
  name: string,
): Promise<string> {
  const label = page.getByTestId('period-label');
  const before = await label.innerText().catch(() => '');
  await page.getByRole('button', { name: tab, exact: true }).click();
  if (before) {
    await page
      .waitForFunction(
        (prev) =>
          document.querySelector('[data-testid="period-label"]')?.textContent !== prev,
        before,
        { timeout: 10_000 },
      )
      .catch(() => {});
  }
  return captureHub(page, name);
}
