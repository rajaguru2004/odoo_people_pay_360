import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { annotate, clearAnnotations, type Callout } from './annotate';

/**
 * The capture side of the manual pipeline.
 *
 * `shot()` takes one screen: navigate, let it settle, draw the callouts, save a
 * PNG, and append the legend to a manifest. The document builder then reads
 * that manifest instead of carrying its own copy of the legend, so the numbers
 * in the prose cannot drift from the numbers in the picture — the single
 * failure that makes an annotated manual worse than no manual at all.
 *
 * Everything lands in `e2e/.manual/`, which `apps/frontend/.gitignore` covers
 * alongside the other `.`-prefixed e2e output directories. (It did not until
 * this was written — the comment claiming it did was wrong, and ~40 MB of PNGs
 * were sitting untracked waiting to be committed by accident.)
 */

/**
 * Where this run's pictures and manifest land.
 *
 * Overridable because there is more than one book now. The employee manual and
 * the administrator manual are captured by different specs against different
 * sessions, and they must not share a `shots.json`: the manifest is rewritten
 * on every `shot()`, so a shared directory means whichever capture ran last
 * owns the file and the other book's build reports every figure missing.
 */
export const MANUAL_DIR = resolve(__dirname, '..', process.env.MANUAL_OUT_DIR ?? '.manual');
export const SHOTS_DIR = resolve(MANUAL_DIR, 'shots');
const MANIFEST = resolve(MANUAL_DIR, 'shots.json');

export interface ShotRecord {
  /** File stem, and the key the document builder looks the shot up by. */
  name: string;
  /** Path relative to MANUAL_DIR, for the builder. */
  file: string;
  /** The screen's own title, for the figure caption. */
  caption: string;
  /** Legend entries in badge order — index 0 is badge ①. */
  legend: string[];
  /** Callouts whose selector matched nothing. Non-empty means fix the spec. */
  missing: string[];
  /** Pixel size, so the builder can scale to the text column without guessing. */
  width: number;
  height: number;
}

const records: ShotRecord[] = [];

export interface ShotOptions {
  /**
   * Viewport for this screen. A manual wants a picture that looks like a real
   * browser, so the default is an ordinary laptop window; screens with a long
   * body get a taller one rather than a scrollbar and a cut-off card.
   *
   * `fullPage` is useless in this app — `DashboardLayout` scrolls an inner
   * `<main>` rather than the document, so Playwright composites exactly one
   * viewport either way. Growing the viewport grows `h-screen` with it, which
   * is what actually puts the whole screen in frame. Same finding as
   * `e2e/screens.ts`, arrived at the same way.
   */
  width?: number;
  height?: number;
  /** Extra settle time for charts and staggered card animations. */
  settleMs?: number;
  /**
   * Crop the viewport down to the height the content fills. On by default;
   * pass `false` for a screen whose empty space is the point — an empty-state
   * figure that is meant to show how much of the screen is bare.
   */
  fit?: boolean;
  /** Run before annotating — open a menu, expand a row, fill a field. */
  prepare?: (page: Page) => Promise<void>;
}

/**
 * Shrink the viewport to the height the screen actually fills.
 *
 * This is a legibility fix, not a tidiness one. A figure is scaled to the text
 * column — about 6.7 inches — so every pixel of empty page below the content is
 * a pixel stolen from the part the reader has to read. `My Payslips` laid out
 * in 900px and was photographed in 1400, so a third of the figure was blank and
 * the interface arrived on the page a third smaller than it needed to be.
 *
 * The tall viewport is still what gets us here: `DashboardLayout` scrolls an
 * inner `<main>` rather than the document, so the page must first be given room
 * to lay everything out before there is anything to measure.
 */
async function fitToContent(page: Page, width: number, max: number): Promise<void> {
  const needed = await page
    .evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return null;

      // The lowest edge of anything with a box inside `main`. Elements are
      // measured rather than `scrollHeight` because the layout's own padding
      // reports far more height than the content occupies.
      let bottom = main.getBoundingClientRect().top;
      main.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        // Skip the things that are pinned to the viewport rather than laid out
        // in it — the floating chat bubble sits at the bottom of the window and
        // would defeat the whole measurement.
        if (r.height === 0 || r.width === 0) return;
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') return;
        if (r.bottom > bottom) bottom = r.bottom;
      });
      return Math.ceil(bottom + 28);
    })
    .catch(() => null);

  if (!needed) return;
  const height = Math.max(560, Math.min(needed, max));
  await page.setViewportSize({ width, height });
  // Let the responsive grid settle into the new height before the shutter.
  await page.waitForTimeout(450);
}

/**
 * Refuse to run against an app that has not mounted.
 *
 * Call this from every spec's `beforeAll`. It exists because the failure it
 * catches is silent and expensive: when the running standalone server and
 * `.next/static` fall out of step, every chunk answers 500, the page renders
 * "Loading..." for ever, and a capture pass cheerfully saves sixty-seven white
 * screenshots and reports success. It has now happened twice — the second time
 * it cost a full anchor sweep whose output was sixty-seven empty records.
 *
 * A guard on ONE spec is not enough, which was the mistake the first time: the
 * annotated capture had it, the reconnaissance and anchor passes did not.
 */
export async function assertAppMounted(page: Page, baseURL = ''): Promise<void> {
  await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main', { state: 'attached', timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);

  const text = await page.locator('body').innerText().catch(() => '');
  if (text.replace(/\s+/g, ' ').trim().length < 200) {
    throw new Error(
      'The app served its shell but never rendered — every screenshot from this run would ' +
        'be a blank "Loading..." page.\n' +
        'The running frontend and its static chunks are almost certainly from different ' +
        'builds. Fix with:\n' +
        '    scripts/manual-stack.sh up\n' +
        `(saw ${text.length} characters of body text)`,
    );
  }
}

/** Wait for the app to stop moving, without depending on `networkidle`. */
async function settle(page: Page, ms: number): Promise<void> {
  // Several ESS screens poll, so `networkidle` never fires on them. Wait for
  // the app shell instead, then give the animations their stagger.
  await page
    .waitForSelector('main', { state: 'attached', timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(ms);
  // framer-motion staggers card entrances; a capture mid-stagger shows half a
  // row faded out. Scroll both the window and the inner scroller to the top so
  // repeated shots of one screen are framed identically.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector('main')?.scrollTo(0, 0);
  });
  await page.waitForTimeout(250);
}

/**
 * Capture one annotated screen.
 *
 * `url` may be a path (`/dashboard/my-leaves`) to navigate, or `null` to shoot
 * whatever is already on screen — which is how a modal, a filled form or a
 * second view of the same page gets its own figure.
 */
export async function shot(
  page: Page,
  opts: {
    name: string;
    caption: string;
    url?: string | null;
    callouts?: Callout[];
  } & ShotOptions,
): Promise<ShotRecord> {
  const width = opts.width ?? 1440;
  const height = opts.height ?? 900;

  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.setViewportSize({ width, height });

  if (opts.url) {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
  }
  await settle(page, opts.settleMs ?? 1200);

  if (opts.prepare) {
    await opts.prepare(page);
    await page.waitForTimeout(500);
  }

  // Measured AFTER `prepare`, because opening a modal or expanding a row is
  // exactly the thing that changes how tall the screen is.
  if (opts.fit !== false) await fitToContent(page, width, height);

  await clearAnnotations(page);
  const { drawn, missing } = opts.callouts?.length
    ? await annotate(page, opts.callouts)
    : { drawn: [], missing: [] };

  const file = `shots/${opts.name}.png`;
  await page.screenshot({ path: resolve(MANUAL_DIR, file) });
  await clearAnnotations(page);

  // The FITTED size, not the requested one: the builder scales each figure by
  // its own aspect ratio, and a manifest still claiming 1440x1400 for a shot
  // that came out 1440x900 would stretch it.
  const shotSize = page.viewportSize() ?? { width, height };

  const record: ShotRecord = {
    name: opts.name,
    file,
    caption: opts.caption,
    legend: drawn,
    missing,
    width: shotSize.width,
    height: shotSize.height,
  };
  records.push(record);
  writeFileSync(MANIFEST, JSON.stringify(records, null, 2));

  if (missing.length) {
    // Loud, but not fatal: a run that stops at the first stale selector gives
    // you one fix per run. Listing them all gives you the whole repair list.
    console.warn(`  ⚠ ${opts.name}: no match for ${missing.map((m) => `"${m}"`).join(', ')}`);
  }
  console.log(`  ✓ ${opts.name} (${drawn.length} callouts)`);

  return record;
}
