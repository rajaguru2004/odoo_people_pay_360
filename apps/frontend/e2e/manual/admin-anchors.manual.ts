import { test } from '@playwright/test';
import { assertAppMounted } from './capture';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Anchors only — no screenshots, short waits.
 *
 * The reconnaissance pass already photographed every administrator screen;
 * what it does not leave behind in a usable form is the list of things
 * a callout can be anchored TO. Re-running the whole sweep just to re-read the
 * test ids costs fifteen minutes for information that takes two to collect, so
 * this is the cheap half on its own.
 *
 * Writes a single text file, because the point is to read it once while writing
 * `admin.manual.ts` and then never again.
 *
 *   npx playwright test -c e2e/manual/manual.config.ts --project=admin admin-anchors
 */

// Beside the book, with the reconnaissance pictures — this file and those
// images are read together while a chapter is being written.
const OUT = resolve(
  __dirname, '..', '..', '..', '..',
  'docs', 'admin-user-manual', 'screens', 'anchors.txt',
);

const PATHS = [
  '/dashboard',
  '/dashboard/organization', '/dashboard/branches', '/dashboard/branches/new',
  '/dashboard/departments', '/dashboard/departments/tree', '/dashboard/departments/change-requests',
  '/dashboard/people', '/dashboard/employees', '/dashboard/employees/new',
  '/dashboard/supervisor-teams', '/dashboard/contracts', '/dashboard/contracts/new',
  '/dashboard/contracts/terminations', '/dashboard/visa-reports',
  '/dashboard/time', '/dashboard/attendance', '/dashboard/attendance/corrections',
  '/dashboard/attendance/history', '/dashboard/attendance/reports',
  '/dashboard/attendance/management', '/dashboard/attendance/face-management',
  '/dashboard/schedules/overview', '/dashboard/schedules/shifts',
  '/dashboard/leave', '/dashboard/leaves', '/dashboard/leaves/pending',
  '/dashboard/leaves/balances', '/dashboard/overtime',
  '/dashboard/payroll/manage', '/dashboard/payroll/batches',
  '/dashboard/payroll/approvals', '/dashboard/payroll/salary-structure',
  '/dashboard/talent', '/dashboard/appraisal', '/dashboard/training',
  '/dashboard/rewards-disciplines', '/dashboard/grievances',
  '/dashboard/workplace', '/dashboard/assets', '/dashboard/letters', '/dashboard/projects',
  '/dashboard/system', '/dashboard/settings', '/dashboard/audit-logs',
];

// Fail loudly rather than collect a file of blank records.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await assertAppMounted(page);
  } finally {
    await page.close();
  }
});

test('admin anchors', async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const lines: string[] = [];

  for (const path of PATHS) {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForSelector('main', { state: 'attached', timeout: 12_000 }).catch(() => undefined);
    await page.waitForTimeout(1100);

    const info = await page
      .evaluate(() => {
        const scope = document.querySelector('main') ?? document.body;
        const uniq = (a: string[]) => [...new Set(a)].filter(Boolean);
        return {
          text: (scope.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 130),
          ids: uniq(
            [...scope.querySelectorAll('[data-testid]')].map(
              (e) => e.getAttribute('data-testid') ?? '',
            ),
          ),
          btns: uniq(
            [...scope.querySelectorAll('button, a[href]')].map((e) =>
              (e.textContent ?? '').trim().replace(/\s+/g, ' '),
            ),
          ).filter((t) => t.length < 32),
          heads: uniq(
            [...scope.querySelectorAll('h1,h2,h3')].map((e) => (e.textContent ?? '').trim()),
          ),
          labels: uniq(
            [...scope.querySelectorAll('label')].map((e) =>
              (e.textContent ?? '').trim().replace(/\s+/g, ' '),
            ),
          ).filter((t) => t.length < 32),
        };
      })
      .catch(() => null);

    const landed = page.url().replace(/^https?:\/\/[^/]+/, '');
    const off = /not switched on|not enabled|is disabled|switched off/i.test(info?.text ?? '');

    lines.push(`\n### ${path}${landed !== path ? `  →  ${landed}` : ''}${off ? '   ⛔ OFF' : ''}`);
    if (info) {
      lines.push(`head: ${info.heads.slice(0, 6).join(' | ')}`);
      lines.push(`ids : ${info.ids.slice(0, 22).join(', ')}`);
      lines.push(`btn : ${info.btns.slice(0, 16).join(' | ')}`);
      if (info.labels.length) lines.push(`lbl : ${info.labels.slice(0, 14).join(' | ')}`);
      if (off) lines.push(`text: ${info.text}`);
    }
    console.log(`  ✓ ${path}${off ? '  ⛔ OFF' : ''}`);
  }

  writeFileSync(OUT, lines.join('\n'));
  console.log(`\n→ ${OUT}`);
});
