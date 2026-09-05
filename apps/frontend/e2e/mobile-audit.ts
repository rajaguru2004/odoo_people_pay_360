import { expect, type Locator, type Page } from '@playwright/test';
import { settle, type PageProblems } from './fixtures';
import { capturePhone, screensEnabled } from './screens';
import { rebuildContactSheet, writeScreenRecord } from './screens-index';

/**
 * The phone audit, in one call.
 *
 * Forty screens each need the same five questions asked, and the first version
 * of that — `ess-mobile-dashboard.employee.spec.ts` — was 143 lines for one
 * screen. Forty copies of it is 5,700 lines in which every screen's exceptions
 * quietly drift apart. So the questions live here and a per-screen spec is
 * about fifteen lines.
 *
 * The other half of the job, and the half that actually decides what this
 * programme costs, is **diagnosis**. "`main` scrolls sideways by 24px" on a
 * 967-line page is a twenty-minute hunt; "`div.grid > div:nth-child(3) >
 * span.w-[380px]`, right edge 414 vs 390" is a thirty-second fix. Every
 * assertion here reports the offending node, not just the number.
 *
 * ## What is asked
 *
 * 1. No horizontal overflow — on `document.documentElement` **and** on `main`,
 *    which is the real scroll container in this shell (`DashboardLayout`).
 * 2. No interactive control under 44×44 CSS px.
 * 3. Every form control at a 16px font, or mobile Safari zooms the page on
 *    focus and strands the reader sideways inside a box that still measures
 *    clean.
 * 4. The fixed tab bar covers nothing — the lowest laid-out element in `main`
 *    ends above it once `main` is scrolled to the end.
 * 5. The split is CSS: a `hidden md:block` sibling exists and is not painted.
 *
 * Plus, always, the `problems` fixture in STRICT mode: an ESS screen the
 * employee owns has no excuse for a console error or a 403.
 */

/**
 * The context preset. `isMobile`, `hasTouch` and `deviceScaleFactor` are
 * CONTEXT options — `setViewportSize` cannot change them — so they have to come
 * from a file-level or describe-level `test.use`. Only the width is swept below.
 *
 * `deviceScaleFactor: 2` rather than a real iPhone's 3: layout assertions are
 * in CSS pixels either way, and at 3 a full-height evidence capture is a
 * 1170×7200 PNG nobody wants to open.
 */
export const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
} as const;

/**
 * 390 is the median handset and the width every layout assertion is written
 * for. 360 is the median ANDROID width, and those 30px are exactly the band
 * where a two-column grid with a fixed gap tips into overflow and a
 * `date · amount` row wraps. Behaviour is not re-tested there — only layout,
 * which is the only thing that changes with width.
 */
export const PHONE_WIDTHS = [390, 360] as const;

/** 320 is a survey, not a gate: `E2E_PHONE_320=1` adds it as soft assertions. */
const SURVEY_WIDTH = 320;
const surveyEnabled = Boolean(process.env.E2E_PHONE_320);

/** The tab bar is 3.5rem plus the home indicator; `.pb-mobile-tabbar` adds 1rem. */
const MIN_TABBAR_GAP = 8;

export interface AllowedSmallTarget {
  /** A CSS selector, matched against the offending node. */
  selector: string;
  /** Why this one is allowed. Goes into the tracker; there is no unexplained exception. */
  why: string;
}

export interface PhoneAuditOptions {
  problems: PageProblems;
  /** A testid, or a locator, that proves the screen actually rendered. */
  ready: string | Locator;
  /** Human label, used in failure messages. */
  label: string;
  widths?: readonly number[];
  minTarget?: number;
  allow?: AllowedSmallTarget[];
  /** Default true. A screen with no fixed bar (none today) can turn it off. */
  expectTabBar?: boolean;
  /** Default true. Asserts a `hidden md:block` sibling exists and is hidden. */
  expectDesktopSibling?: boolean;
  /** Capture stem. A no-op unless `E2E_SCREENS` is set. */
  shot?: string;
  /** Extra wait for staggered entrances and charts. */
  settleMs?: number;
  /**
   * Default TRUE — the audit is the last statement in the test body and settles
   * the page. Pass false only when the spec keeps going: settling early opens a
   * window in which in-flight requests are never judged.
   */
  settle?: boolean;
}

export interface OverflowReport {
  document: number;
  main: number;
  culprits: string[];
}

export interface PhoneAuditReport {
  label: string;
  overflow: Record<number, OverflowReport>;
  undersized: Array<{ label: string; selector: string; w: number; h: number }>;
  smallFonts: Array<{ selector: string; fontSize: string }>;
  tabBarGap: number | null;
  shots: string[];
}

/**
 * Overflow, with the node that caused it.
 *
 * The second pass skips `fixed` and `sticky` descendants: they are positioned
 * against the viewport rather than laid out in the flow, so a tab bar or a
 * sticky header is never the cause even when its box extends past the edge.
 */
export async function measureOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
      // Re-declared in each browser-side block: `page.evaluate` cannot
      // serialise a closure, and shipping `eval`/`new Function` into the page
      // under test is a worse trade than three copies of twelve lines.
      const nodePath = (node: Element): string => {
        const parts: string[] = [];
        let el: Element | null = node;
        while (el && el.nodeType === 1 && parts.length < 4) {
          let part = el.tagName.toLowerCase();
          const id = el.getAttribute('data-testid');
          if (id) {
            parts.unshift(`${part}[${id}]`);
            break;
          }
          const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
          if (cls) part += `.${cls}`;
          parts.unshift(part);
          el = el.parentElement;
        }
        return parts.join(' > ');
      };

      const main = document.querySelector('main');
      const doc = document.documentElement;

      const culprits: string[] = [];
      if (main) {
        const limit = main.clientWidth + 1;
        const mainLeft = main.getBoundingClientRect().left;
        for (const node of Array.from(main.querySelectorAll('*'))) {
          const style = getComputedStyle(node);
          if (style.position === 'fixed' || style.position === 'sticky') continue;
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = node.getBoundingClientRect();
          if (rect.width === 0) continue;
          const right = rect.right - mainLeft;
          if (right > limit) {
            culprits.push(`${nodePath(node)} — right edge ${Math.round(right)} vs ${Math.round(limit)}`);
          }
        }
      }

      /*
       * Fallback when the right-edge walk finds nothing.
       *
       * It happened on the overtime detail screen: `main` overflowed by 34px
       * and not one descendant's right edge was past the limit. Two things do
       * that — a child that is itself internally scrollable (its own
       * `scrollWidth` exceeds its box, so its RECT is innocent) and a node
       * pushed out by a negative margin on an ancestor. A diagnostic that goes
       * quiet on the case you cannot eyeball is worse than no diagnostic, so
       * report the widest boxes and any internally-scrolling node instead of
       * returning an empty list.
       */
      if (main && culprits.length === 0 && main.scrollWidth > main.clientWidth) {
        const wide: Array<{ path: string; w: number }> = [];
        for (const node of Array.from(main.querySelectorAll('*'))) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = node.getBoundingClientRect();
          if (rect.width > main.clientWidth) {
            wide.push({ path: `${nodePath(node)} — box ${Math.round(rect.width)}px`, w: rect.width });
          } else if (node.scrollWidth > node.clientWidth + 1) {
            wide.push({
              path: `${nodePath(node)} — scrolls internally, ${node.scrollWidth} vs ${node.clientWidth}`,
              w: node.scrollWidth,
            });
          }
        }
        wide.sort((a, b) => b.w - a.w);
        culprits.push(...wide.slice(0, 6).map((x) => x.path));
      }

      return {
        document: doc.scrollWidth - doc.clientWidth,
        main: main ? main.scrollWidth - main.clientWidth : 0,
        // The innermost offenders are the useful ones; a wide child makes every
        // ancestor look guilty.
        culprits: culprits.slice(-6),
      };
  });
}

export async function assertNoHorizontalOverflow(page: Page, label: string): Promise<OverflowReport> {
  const report = await measureOverflow(page);
  const detail = report.culprits.length ? `\n  ${report.culprits.join('\n  ')}` : '';

  expect(report.document, `${label}: the document scrolls sideways${detail}`).toBe(0);
  expect(report.main, `${label}: the page body scrolls sideways${detail}`).toBe(0);
  return report;
}

/**
 * Every rendered interactive node is at least `min` in both dimensions.
 *
 * A checkbox or radio is measured through its wrapping `<label>` when it has
 * one — a 16px box inside a 48px tappable row is correct, and failing it would
 * teach people to widen `allow` until it means nothing.
 */
export async function findUndersizedTargets(
  page: Page,
  scope: string,
  min: number,
): Promise<Array<{ label: string; selector: string; w: number; h: number }>> {
  return page.evaluate(
    ({ scope, min }) => {
      // Re-declared in each browser-side block: `page.evaluate` cannot
      // serialise a closure, and shipping `eval`/`new Function` into the page
      // under test is a worse trade than three copies of twelve lines.
      const nodePath = (node: Element): string => {
        const parts: string[] = [];
        let el: Element | null = node;
        while (el && el.nodeType === 1 && parts.length < 4) {
          let part = el.tagName.toLowerCase();
          const id = el.getAttribute('data-testid');
          if (id) {
            parts.unshift(`${part}[${id}]`);
            break;
          }
          const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
          if (cls) part += `.${cls}`;
          parts.unshift(part);
          el = el.parentElement;
        }
        return parts.join(' > ');
      };

      const SELECTOR = [
        'button',
        'a[href]',
        '[role="button"]',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        '[tabindex]:not([tabindex="-1"])',
      ]
        .map((s) => `${scope} ${s}`)
        .join(', ');

      const out: Array<{ label: string; selector: string; w: number; h: number }> = [];
      const seen = new Set<Element>();

      for (const node of Array.from(document.querySelectorAll(SELECTOR))) {
        if (node.closest('[data-audit-ignore]')) continue;

        let measured: Element = node;
        const type = node.getAttribute('type');
        if (type === 'checkbox' || type === 'radio') {
          measured = node.closest('label') ?? node;
        }
        if (seen.has(measured)) continue;
        seen.add(measured);

        const rect = measured.getBoundingClientRect();
        // Zero-sized nodes are the hidden desktop tree.
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width < min || rect.height < min) {
          out.push({
            label: ((measured as HTMLElement).innerText || measured.getAttribute('aria-label') || '?')
              .trim()
              .slice(0, 40),
            selector: nodePath(measured),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
        }
      }
      return out;
    },
    { scope, min },
  );
}

export async function assertTouchTargets(
  page: Page,
  label: string,
  { scope = 'main, nav', min = 44, allow = [] as AllowedSmallTarget[] } = {},
): Promise<PhoneAuditReport['undersized']> {
  const scopes = scope.split(',').map((s) => s.trim());
  const found = (await Promise.all(scopes.map((s) => findUndersizedTargets(page, s, min)))).flat();

  const allowed = new Set(allow.map((a) => a.selector));
  const offenders = found.filter((f) => ![...allowed].some((sel) => f.selector.includes(sel)));

  expect(
    offenders,
    `${label}: controls under ${min}×${min}\n  ${offenders
      .map((o) => `${o.selector} (${o.w}×${o.h}) "${o.label}"`)
      .join('\n  ')}`,
  ).toEqual([]);

  return found;
}

/**
 * Form controls render at 16px or larger.
 *
 * The one phone defect no screenshot and no overflow check can see: below 16px
 * mobile Safari zooms the whole page in when the field takes focus, and it does
 * not zoom back out on blur.
 */
export async function assertControlFontSize(page: Page, label: string): Promise<PhoneAuditReport['smallFonts']> {
  const small = await page.evaluate(() => {
      // Re-declared in each browser-side block: `page.evaluate` cannot
      // serialise a closure, and shipping `eval`/`new Function` into the page
      // under test is a worse trade than three copies of twelve lines.
      const nodePath = (node: Element): string => {
        const parts: string[] = [];
        let el: Element | null = node;
        while (el && el.nodeType === 1 && parts.length < 4) {
          let part = el.tagName.toLowerCase();
          const id = el.getAttribute('data-testid');
          if (id) {
            parts.unshift(`${part}[${id}]`);
            break;
          }
          const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
          if (cls) part += `.${cls}`;
          parts.unshift(part);
          el = el.parentElement;
        }
        return parts.join(' > ');
      };

      const out: Array<{ selector: string; fontSize: string }> = [];
      for (const node of Array.from(
        document.querySelectorAll('main input:not([type="hidden"]), main select, main textarea'),
      )) {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const size = parseFloat(getComputedStyle(node).fontSize);
        if (size < 16) out.push({ selector: nodePath(node), fontSize: `${size}px` });
      }
      return out;
  });

  expect(
    small,
    `${label}: form controls under 16px — iOS Safari will zoom the page on focus\n  ${small
      .map((s) => `${s.selector} (${s.fontSize})`)
      .join('\n  ')}`,
  ).toEqual([]);

  return small;
}

/**
 * The fixed tab bar covers nothing.
 *
 * Measured generically — the lowest laid-out (non-fixed, non-sticky) descendant
 * of `main` after scrolling `main` to its end — so it needs no per-screen
 * testid and works unchanged on all forty screens.
 */
export async function assertClearsTabBar(page: Page, label: string): Promise<number | null> {
  const bar = page.getByTestId('mobile-tab-bar');
  if ((await bar.count()) === 0) return null;

  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
  });
  await page.waitForTimeout(300);

  const contentBottom = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return 0;
    let lowest = 0;
    for (const node of Array.from(main.querySelectorAll('*'))) {
      const style = getComputedStyle(node);
      if (style.position === 'fixed' || style.position === 'sticky') continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = node.getBoundingClientRect();
      if (rect.height === 0) continue;
      lowest = Math.max(lowest, rect.bottom);
    }
    return lowest;
  });

  const barBox = await bar.boundingBox();
  if (!barBox) return null;
  const gap = Math.round(barBox.y - contentBottom);

  expect(
    gap,
    `${label}: content ends ${-gap}px INSIDE the tab bar — check that <main> carries pb-mobile-tabbar`,
  ).toBeGreaterThanOrEqual(MIN_TABBAR_GAP);

  return gap;
}

/** The shell a phone screen must be wearing. */
export async function assertPhoneShell(page: Page, { expectDesktopSibling = true } = {}): Promise<void> {
  await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
  // Employees reach the drawer from the bar's More tab; the hamburger is gone,
  // and the width it freed is what lets the header show its title in full.
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();

  if (expectDesktopSibling) {
    /*
     * The invariant is "a desktop-only subtree is never PAINTED on a phone",
     * not "every screen has one".
     *
     * The first version of this asserted a count of 1 and failed 35 of the 40
     * screens — wrongly. Two trees is the exception, not the rule: it is only
     * correct where the DOM genuinely differs (a `<table>` versus a card
     * list). A filter row, a stat strip or a form is ONE responsive tree by
     * design, and demanding a `hidden md:block` on those would push people to
     * duplicate markup to satisfy a test.
     */
    const desktop = page.locator('main .hidden.md\\:block');
    const count = await desktop.count();
    for (let i = 0; i < count; i++) {
      await expect(desktop.nth(i), 'a desktop-only subtree is painted at 390px').toBeHidden();
    }
  }
}

async function waitForReady(page: Page, ready: string | Locator, settleMs: number): Promise<void> {
  const locator = typeof ready === 'string' ? page.getByTestId(ready) : ready;
  await expect(locator).toBeVisible();
  // framer-motion staggers sections by up to 350ms; a capture or a measurement
  // taken mid-stagger sees half a page.
  await page.waitForTimeout(settleMs);
}

/**
 * Navigate to `path` and ask every phone question. The whole cycle, one call.
 */
export async function auditPhoneScreen(
  page: Page,
  path: string,
  options: PhoneAuditOptions,
): Promise<PhoneAuditReport> {
  const {
    problems,
    ready,
    label,
    widths = PHONE_WIDTHS,
    minTarget = 44,
    allow = [],
    expectTabBar = true,
    expectDesktopSibling = true,
    shot,
    settleMs = 700,
    settle: shouldSettle = true,
  } = options;

  const report: PhoneAuditReport = {
    label,
    overflow: {},
    undersized: [],
    smallFonts: [],
    tabBarGap: null,
    shots: [],
  };

  await page.goto(path);
  await waitForReady(page, ready, settleMs);

  if (expectTabBar) await assertPhoneShell(page, { expectDesktopSibling });

  // Layout is what changes with width; behaviour is not, so only the geometry
  // questions are swept.
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(250);
    report.overflow[width] = await assertNoHorizontalOverflow(page, `${label} @${width}`);
  }

  const surveyWidths = surveyEnabled ? [SURVEY_WIDTH] : [];
  for (const width of surveyWidths) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(250);
    const survey = await measureOverflow(page);
    report.overflow[width] = survey;
    // A survey, not a gate — 320px is under 1% of traffic and a wall of hard
    // failures there would be ignored rather than fixed.
    expect.soft(survey.main, `${label} @${width} (survey): ${survey.culprits.join(' · ')}`).toBe(0);
  }

  // Back to the width every size rule is written for.
  await page.setViewportSize({ width: PHONE_WIDTHS[0], height: 844 });
  await page.waitForTimeout(250);

  report.undersized = await assertTouchTargets(page, label, { min: minTarget, allow });
  report.smallFonts = await assertControlFontSize(page, label);
  if (expectTabBar) report.tabBarGap = await assertClearsTabBar(page, label);

  if (shot) {
    report.shots = await capturePhone(page, shot);
    recordForReview(shot, path, label, report, allow);
  }

  if (shouldSettle) settle(problems, label);
  return report;
}

/**
 * Drop a sidecar beside the capture and regenerate the contact sheet.
 *
 * Rebuilt from every sidecar on disk rather than accumulated in memory: the
 * phone suite runs one spec FILE at a time and a screen is often re-verified on
 * its own, so there is no moment at which one process holds all the results.
 */
function recordForReview(
  name: string,
  path: string,
  label: string,
  report: PhoneAuditReport,
  allow: AllowedSmallTarget[],
): void {
  if (!screensEnabled) return;
  const overflow: Record<number, number> = {};
  for (const [width, value] of Object.entries(report.overflow)) {
    overflow[Number(width)] = value.main;
  }
  writeScreenRecord({
    name,
    label,
    path,
    shots: report.shots,
    overflow,
    undersized: report.undersized.length,
    smallFonts: report.smallFonts.length,
    tabBarGap: report.tabBarGap,
    allow: allow.map(({ selector, why }) => ({ selector, why })),
  });
  rebuildContactSheet();
}

/**
 * The same questions, asked of an overlay.
 *
 * An overlay is portalled out of `main`, so the page-level checks do not see
 * it at all — which is how a 380px-wide dialog survived in a 390px viewport.
 */
export async function auditPhoneOverlay(
  page: Page,
  path: string,
  options: PhoneAuditOptions & {
    open: (page: Page) => Promise<void>;
    dialog?: string;
    close?: (page: Page) => Promise<void>;
  },
): Promise<PhoneAuditReport> {
  const {
    problems,
    ready,
    label,
    open,
    dialog = '[role="dialog"]',
    close,
    minTarget = 44,
    allow = [],
    shot,
    settleMs = 500,
    settle: shouldSettle = true,
  } = options;

  const report: PhoneAuditReport = {
    label,
    overflow: {},
    undersized: [],
    smallFonts: [],
    tabBarGap: null,
    shots: [],
  };

  await page.goto(path);
  await waitForReady(page, ready, settleMs);

  await open(page);
  const panel = page.locator(dialog).first();
  await expect(panel, `${label}: nothing opened`).toBeVisible();
  await page.waitForTimeout(settleMs);

  report.overflow[PHONE_WIDTHS[0]] = await assertNoHorizontalOverflow(page, label);

  // Scoped to the dialog: the page behind it is already covered by the screen's
  // own audit, and re-reporting it here would double every failure.
  const undersized = await findUndersizedTargets(page, dialog, minTarget);
  const allowed = new Set(allow.map((a) => a.selector));
  const offenders = undersized.filter((f) => ![...allowed].some((sel) => f.selector.includes(sel)));
  expect(
    offenders,
    `${label}: dialog controls under ${minTarget}×${minTarget}\n  ${offenders
      .map((o) => `${o.selector} (${o.w}×${o.h}) "${o.label}"`)
      .join('\n  ')}`,
  ).toEqual([]);
  report.undersized = undersized;

  report.smallFonts = await assertControlFontSize(page, label);

  // The panel scrolls internally rather than growing past the viewport — the
  // failure mode being that the submit button is off the bottom of the screen
  // with no way to reach it.
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  if (box && viewport) {
    expect(
      Math.round(box.height),
      `${label}: the sheet is taller than the screen — it must scroll inside itself`,
    ).toBeLessThanOrEqual(viewport.height);
  }

  if (shot) report.shots = await capturePhone(page, shot);
  if (close) await close(page);

  if (shouldSettle) settle(problems, label);
  return report;
}
