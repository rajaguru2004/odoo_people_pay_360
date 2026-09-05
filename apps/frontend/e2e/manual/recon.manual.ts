import { test } from '@playwright/test';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

/**
 * Reconnaissance: every ESS screen, unannotated, once.
 *
 * Written before the annotated pass on purpose. Callouts are anchored to real
 * elements, and choosing which elements are worth a number — and which screens
 * are empty enough to need seeding before they are worth picturing at all —
 * cannot be done from the source. This is the look-first step; `ess.manual.ts`
 * is the pass that produces the figures the document uses.
 *
 *   npx playwright test -c e2e/manual/manual.config.ts recon
 */

const OUT = resolve(__dirname, '..', '.manual', 'recon');

/** The employee's whole portal, in the order the sidebar presents it. */
const SCREENS: Array<{ name: string; path: string; height?: number }> = [
  { name: '01-dashboard', path: '/dashboard', height: 1400 },
  { name: '02-approvals', path: '/dashboard/approvals' },
  { name: '03-my-team', path: '/dashboard/my-team' },

  // My Time
  { name: '10-my-attendance', path: '/dashboard/my-attendance', height: 1500 },
  { name: '11-attendance-corrections', path: '/dashboard/attendance/corrections', height: 1300 },
  { name: '12-face-recognition', path: '/dashboard/face-recognition' },
  { name: '13-my-calendar', path: '/dashboard/my-calendar', height: 1300 },
  { name: '14-my-leaves', path: '/dashboard/my-leaves', height: 1300 },
  { name: '15-leave-new', path: '/dashboard/leaves/new', height: 1200 },
  { name: '16-my-overtime', path: '/dashboard/my-overtime', height: 1200 },
  { name: '17-overtime-new', path: '/dashboard/overtime/new', height: 1200 },

  // My Pay
  { name: '20-payroll', path: '/dashboard/payroll', height: 1300 },
  { name: '21-gratuity', path: '/dashboard/my-payroll/gratuity' },
  { name: '25-my-travel', path: '/dashboard/my-travel', height: 1200 },

  // My Records
  { name: '30-my-documents', path: '/dashboard/my-documents', height: 1200 },
  { name: '31-my-letters', path: '/dashboard/my-letters', height: 1200 },
  { name: '32-my-assets', path: '/dashboard/my-assets', height: 1200 },
  { name: '33-my-training', path: '/dashboard/my-training', height: 1200 },
  { name: '34-my-grievances', path: '/dashboard/my-grievances', height: 1200 },

  // Work
  { name: '41-my-timesheets', path: '/dashboard/my-timesheets', height: 1200 },
  { name: '42-timesheets-new', path: '/dashboard/timesheets/new', height: 1200 },

  // Account
  { name: '50-profile', path: '/dashboard/profile', height: 1500 },
  { name: '51-notifications', path: '/dashboard/notifications', height: 1200 },
  { name: '52-settings', path: '/dashboard/settings', height: 1400 },
];

test('recon: photograph every ESS screen', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  mkdirSync(OUT, { recursive: true });

  const failed: string[] = [];

  for (const screen of SCREENS) {
    // Each screen gets its own budget and its own failure. One slow screen —
    // `/dashboard/overtime/new` took three minutes and never settled — must not
    // cost the twelve after it their pictures, which is exactly what a single
    // shared test timeout does.
    const t0 = Date.now();
    let tNav = 0;
    try {
      await page.setViewportSize({ width: 1440, height: screen.height ?? 900 });
      await page.goto(screen.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      tNav = Date.now() - t0;
      await page
        .waitForSelector('main', { state: 'attached', timeout: 15_000 })
        .catch(() => undefined);
      await page.waitForTimeout(1600);
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.querySelector('main')?.scrollTo(0, 0);
      });
      await page.waitForTimeout(300);
      await page.screenshot({ path: resolve(OUT, `${screen.name}.png`), timeout: 30_000 });

      const landed = page.url().replace(/^https?:\/\/[^/]+/, '');
      // A bounce to /login means the session died mid-run — every screen after
      // this one would photograph the login form, so say so loudly.
      if (landed.startsWith('/login')) failed.push(`${screen.name} → redirected to /login`);
      // nav= time to first byte + DOM; total= the whole screen including the
      // fixed ~1.9s of deliberate settle. Anything where nav dominates is the
      // SERVER being slow, not the capture.
      console.log(
        `  ✓ ${screen.name.padEnd(26)} nav ${String(tNav).padStart(5)}ms  total ${String(
          Date.now() - t0,
        ).padStart(5)}ms  ${landed}`,
      );
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      failed.push(`${screen.name}: ${why}`);
      console.warn(`  ⚠ ${screen.name} — ${why}`);
    }
  }

  if (failed.length) {
    console.warn(`\n  ${failed.length} screen(s) did not photograph cleanly:`);
    for (const f of failed) console.warn(`   • ${f}`);
  }
});
