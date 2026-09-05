import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * The ESS mobile standard, enforced against the source.
 *
 * A component test proves one screen; this proves every file that has been
 * converted, and fails the moment the thirty-seventh screen re-invents what the
 * third one fixed. It is the cheap half of the pass — it runs in the fast
 * `unit` project with no DOM, in milliseconds.
 *
 * ## Why there is a governed list rather than a blanket rule
 *
 * Pointed at all ~40 ESS screens today, every rule below is red, because those
 * screens have not been converted yet. A permanently-red test is ignored within
 * a week and then deleted. So `GOVERNED` starts as the files this pass owns and
 * **grows by one entry per delivered screen** — adding the path is part of the
 * screen's definition of done, exactly like adding its route to the phone
 * suite's table. Green means "everything converted so far still holds", which
 * is a claim worth making.
 *
 * See `docs/ESS-MOBILE-UI-TRACKER.md`.
 */

const FRONTEND = join(__dirname, '..', '..');

/**
 * Files held to the standard. Add a screen's page here when it is delivered.
 */
const GOVERNED = [
  // ── the kit ──
  'components/common/ConfirmModal.tsx',
  'components/common/EmptyState.tsx',
  'components/common/Field.tsx',
  'components/common/FilterBar.tsx',
  'components/common/Pagination.tsx',
  'components/common/SegmentedTabs.tsx',
  'components/common/Sheet.tsx',
  'components/common/Skeleton.tsx',
  'components/common/StatusBadge.tsx',
  'components/dashboard/EmployeeDashboardMobile.tsx',
  'components/dashboard/MobileTabBar.tsx',
  // ── delivered screens (Batches 1–7) ──
  'app/dashboard/my-leaves/page.tsx',
  'app/dashboard/my-overtime/page.tsx',
  'app/dashboard/my-documents/page.tsx',
  'app/dashboard/my-letters/page.tsx',
  'app/dashboard/my-assets/page.tsx',
  'app/dashboard/my-training/page.tsx',
  'app/dashboard/my-grievances/page.tsx',
  'app/dashboard/my-team/page.tsx',
  'app/dashboard/my-travel/page.tsx',
  'app/dashboard/my-payroll/gratuity/page.tsx',
  'app/dashboard/my-calendar/page.tsx',
];

/** Overlays are `Sheet`'s job; it is the only file allowed to declare one. */
const OVERLAY_OWNERS = ['components/common/Sheet.tsx'];

const read = (rel: string) => readFileSync(join(FRONTEND, rel), 'utf8');

/**
 * The file with its comments removed.
 *
 * Load-bearing: these components document the mistakes they exist to prevent,
 * and they do it by naming the offending class. Scanning the raw text makes
 * every one of those docblocks a violation of its own rule — which is both
 * wrong and the fastest way to teach the next author to stop explaining
 * themselves.
 */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.next')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(full) && !/\.test\.tsx$/.test(full)) out.push(full);
  }
  return out;
}

describe('the ESS mobile standard', () => {
  it('governs every file this pass has converted', () => {
    // A guard on the guard: a rename that leaves a stale path here would make
    // every rule below silently pass on a file that no longer exists.
    for (const rel of GOVERNED) {
      expect(() => read(rel), `${rel} is listed but missing`).not.toThrow();
    }
  });

  it.each(GOVERNED)('%s uses design tokens, not raw palette classes', (rel) => {
    // The portal writes its colours at runtime from a theme preset
    // (`theme/provider.tsx`), so `bg-white` or `text-slate-500` is not a
    // shortcut — it is a colour that ignores the customer's brand.
    const offenders = [
      ...code(rel).matchAll(
        /\b(?:bg|text|border|ring|from|to|via)-(slate|gray|zinc|neutral|stone|emerald|red|amber|blue|indigo|sky)-\d{2,3}\b/g,
      ),
    ].map((m) => m[0]);

    expect([...new Set(offenders)]).toEqual([]);
  });

  it.each(GOVERNED)('%s uses logical properties so RTL mirrors', (rel) => {
    // `left-3`/`pl-9`/`mr-2` pin a layout to one reading direction. The house
    // style is `start-*`/`ps-*`/`me-*`; `dir="rtl"` is a live toggle here.
    const offenders = [
      ...code(rel).matchAll(/(?<![\w:-])(?:-)?(?:left|right|pl|pr|ml|mr)-(?:\d+|\[)/g),
    ].map((m) => m[0]);

    expect([...new Set(offenders)]).toEqual([]);
  });

  it.each(GOVERNED)('%s gives form controls a 16px font', (rel) => {
    // Below 16px, mobile Safari zooms the page in on focus — and in this shell
    // `<main>` is the scroll container, so the zoom strands the reader sideways
    // inside a box whose scrollWidth still measures clean. Invisible to the
    // overflow assertion, invisible in a screenshot.
    const src = code(rel);
    const controls = [...src.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => m[0]);
    // `(?<![\w:-])` so a BREAKPOINT-PREFIXED size does not trip this: the
    // correct phone idiom is `text-base md:text-sm`, and flagging that would
    // teach people to drop the desktop size rather than add the mobile one.
    const tooSmall = controls.filter((tag) => /(?<![\w:-])text-(xs|sm)\b/.test(tag));

    expect(tooSmall).toEqual([]);
  });

  it('only Sheet opens a full-screen overlay', () => {
    // 46 hand-rolled `fixed inset-0` overlays is 46 dialogs with no focus trap,
    // no Escape, and no scroll lock. New ones go through Sheet.
    const offenders = GOVERNED.filter(
      (rel) => !OVERLAY_OWNERS.includes(rel) && /fixed inset-0/.test(code(rel)),
    );

    expect(offenders).toEqual([]);
  });

  it('no governed file branches its layout on useIsMobile()', () => {
    // The locked rule: the hook returns false on the first client render, so a
    // layout branch paints the desktop tree for a frame on every phone load.
    // Gating a FETCH on it is fine — that is an effect, after paint.
    const offenders = GOVERNED.filter((rel) => {
      const src = code(rel);
      if (!/useIsMobile/.test(src)) return false;
      // A layout branch reads as `isMobile ?` or `isMobile &&` inside JSX.
      return /\{\s*isMobile\s*[?&]/.test(src) || /=\{\s*isMobile\s*[?&]/.test(src);
    });

    expect(offenders).toEqual([]);
  });

  it('no file gives a table row and its mobile card the same test id', () => {
    // `DataCard`'s docblock warns about this and nothing enforced it:
    // Playwright's `.count()` includes hidden elements, so one shared id
    // silently doubles every count on a screen that renders both trees.
    const offenders: string[] = [];

    for (const file of walk(join(FRONTEND, 'app', 'dashboard'))) {
      const src = readFileSync(file, 'utf8');
      if (!/DataCard/.test(src)) continue;

      const ids = (re: RegExp) =>
        new Set([...src.matchAll(re)].map((m) => m[1]).filter(Boolean));

      // Ids on a <tr …> and ids passed as DataCard's `testId` prop.
      const rowIds = ids(/<tr\b[^>]*data-testid=["'{]+([\w-]+)/g);
      const cardIds = ids(/testId=["'{]+([\w-]+)/g);
      const shared = [...rowIds].filter((id) => cardIds.has(id));

      if (shared.length) offenders.push(`${file.slice(FRONTEND.length + 1)}: ${shared.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });
});
