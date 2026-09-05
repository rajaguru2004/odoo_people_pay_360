import type { Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

/**
 * Full-page screenshots for the visual verification pass.
 *
 * There was no screenshot convention in this repo before Phase F —
 * `grep -rn "screenshot(" e2e` returned nothing, and the visual checks on
 * record in `docs/MODULE-LANDING-DASHBOARDS-TRACKER.md` were all taken by hand
 * against the dev stack. This is that convention.
 *
 * **Opt-in.** Nothing is captured unless `E2E_SCREENS` is set, so an ordinary
 * run neither slows down nor writes files. Output lands in `e2e/.results/`,
 * which `apps/frontend/.gitignore` already covers — no binaries reach the repo.
 *
 * Captured at two widths, because a dashboard that reads well at 1440 can put a
 * five-card KPI row into three columns of two-and-a-half at 1024, and a meter
 * label can wrap onto a line of its own only at the narrower one.
 */
const WIDTHS = [1440, 1024] as const;

/**
 * Tall enough that the whole hub is on screen at once.
 *
 * `fullPage: true` is useless here: `DashboardLayout` scrolls an inner `<main>`
 * rather than the document, so Playwright composites exactly one viewport and
 * the bottom half of the page — the three insight panels and the Go-to tiles —
 * never appeared in a single capture. Growing the viewport grows `h-screen`
 * with it, which puts everything in the frame.
 */
const HEIGHT = 2400;
// Deliberately NOT under `e2e/.results`: that is Playwright's `outputDir`, and
// Playwright empties it at the start of every run. `playwright_test.sh` invokes
// Playwright once per spec FILE, so the second file's run deleted the first
// file's screenshots — the Organization captures vanished before anyone could
// read them.
const OUT_DIR = resolve(__dirname, '.screens');

export const screensEnabled = Boolean(process.env.E2E_SCREENS);

/**
 * Capture `name` at both widths, restoring the viewport afterwards.
 *
 * A no-op unless `E2E_SCREENS` is set. The page is scrolled back to the top
 * first: `fullPage` composites from the current scroll position in some
 * engines, and a half-scrolled capture is indistinguishable from a broken
 * layout when you are reading a hundred of these.
 */
export async function captureScreens(page: Page, name: string): Promise<void> {
  if (!screensEnabled) return;

  mkdirSync(OUT_DIR, { recursive: true });
  const original = page.viewportSize();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHT });
    // Let the responsive grid settle and any entrance animation finish before
    // the shutter: framer-motion staggers the KPI cards by 50ms each, and a
    // capture mid-stagger shows half a row faded out.
    await page.waitForTimeout(600);
    // The inner container is what scrolls, so reset that one too.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('main')?.scrollTo(0, 0);
    });
    await page.screenshot({
      path: resolve(OUT_DIR, `${name}-${width}.png`),
      fullPage: true,
    });
  }

  if (original) await page.setViewportSize(original);
}

/**
 * Phone capture, for the ESS mobile pass.
 *
 * A SIBLING of `captureScreens` rather than a third entry in `WIDTHS`, and
 * deliberately: five hub specs call that function, none of them cares about a
 * phone, and adding a width would make every one of those runs 50% slower for a
 * picture nobody reads.
 *
 * Same gate (`E2E_SCREENS`), same output directory — which is outside
 * Playwright's `outputDir` on purpose, because Playwright empties that at the
 * start of every run and the phone suite runs one spec FILE at a time, so the
 * second file would delete the first file's evidence.
 *
 * Two shots when the content is taller than the frame, rather than a silent
 * truncation: a capture that quietly cuts a page in half is worse than none,
 * because it looks like a finished screen.
 */
const PHONE_WIDTH = 390;
const PHONE_HEIGHT = 2400;

export async function capturePhone(page: Page, name: string): Promise<string[]> {
  if (!screensEnabled) return [];

  mkdirSync(OUT_DIR, { recursive: true });
  const original = page.viewportSize();
  const written: string[] = [];

  await page.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector('main')?.scrollTo(0, 0);
  });

  const first = resolve(OUT_DIR, `${name}-390.png`);
  await page.screenshot({ path: first, fullPage: true });
  written.push(first);

  // How much did not fit. `main` is the scroll container in this shell, so its
  // own scrollHeight is the honest measure — not the document's.
  const overflowing = await page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.scrollHeight - main.clientHeight > 80 : false;
  });

  if (overflowing) {
    await page.evaluate(() => {
      const main = document.querySelector('main');
      if (main) main.scrollTop = main.scrollHeight;
    });
    await page.waitForTimeout(400);
    const second = resolve(OUT_DIR, `${name}-390-b.png`);
    await page.screenshot({ path: second, fullPage: true });
    written.push(second);
  }

  if (original) await page.setViewportSize(original);
  return written;
}
