import { test } from '@playwright/test';
import { assertAppMounted } from './capture';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

/**
 * Reconnaissance for the ADMINISTRATOR manual.
 *
 * The admin surface is roughly five times the employee's — ten menu groups and
 * some fifty-five screens — and a good part of it is behind feature flags that
 * ship OFF. So this pass answers two questions before a word is written: what
 * does each screen look like, and which of them exist in this deployment at all.
 *
 * It also dumps the anchors (test ids, buttons, headings, labels) for each
 * screen, because choosing what to ring cannot be done from the source and
 * guessing selectors produces a capture full of callouts that resolve to
 * nothing.
 *
 *   npx playwright test -c e2e/manual/manual.config.ts --project=admin admin-recon
 */

/**
 * The sweep lands beside the book it is for, not under `e2e/`.
 *
 * These are working pictures — the whole administrator surface, unannotated —
 * and they are looked at constantly while the chapters are being written:
 * "what does the encashment screen actually show", "is that queue empty".
 * Keeping them next to `content/` means the answer is one directory away from
 * the file asking the question. They are build output and are gitignored,
 * exactly like the page images the finished document is checked with.
 */
const OUT = resolve(
  __dirname, '..', '..', '..', '..',
  'docs', 'admin-user-manual', 'screens',
);

/** Every screen the admin sidebar offers, in the order it offers them. */
const SCREENS: Array<{ name: string; path: string; group: string }> = [
  { group: 'Home', name: '00-dashboard', path: '/dashboard' },
  { group: 'Home', name: '01-copilot', path: '/dashboard/copilot' },

  { group: 'Organization', name: '10-hub', path: '/dashboard/organization' },
  { group: 'Organization', name: '11-branches', path: '/dashboard/branches' },
  { group: 'Organization', name: '12-branch-new', path: '/dashboard/branches/new' },
  { group: 'Organization', name: '13-departments', path: '/dashboard/departments' },
  { group: 'Organization', name: '14-dept-tree', path: '/dashboard/departments/tree' },
  { group: 'Organization', name: '15-change-requests', path: '/dashboard/departments/change-requests' },

  { group: 'People', name: '20-hub', path: '/dashboard/people' },
  { group: 'People', name: '21-employees', path: '/dashboard/employees' },
  { group: 'People', name: '22-employee-new', path: '/dashboard/employees/new' },
  { group: 'People', name: '23-supervisor-teams', path: '/dashboard/supervisor-teams' },
  { group: 'People', name: '24-contracts', path: '/dashboard/contracts' },
  { group: 'People', name: '25-contract-new', path: '/dashboard/contracts/new' },
  { group: 'People', name: '26-terminations', path: '/dashboard/contracts/terminations' },
  { group: 'People', name: '27-visa-reports', path: '/dashboard/visa-reports' },

  { group: 'Time', name: '30-hub', path: '/dashboard/time' },
  { group: 'Time', name: '31-attendance', path: '/dashboard/attendance' },
  { group: 'Time', name: '32-corrections', path: '/dashboard/attendance/corrections' },
  { group: 'Time', name: '33-history', path: '/dashboard/attendance/history' },
  { group: 'Time', name: '34-reports', path: '/dashboard/attendance/reports' },
  { group: 'Time', name: '35-management', path: '/dashboard/attendance/management' },
  { group: 'Time', name: '36-face-management', path: '/dashboard/attendance/face-management' },

  { group: 'Schedules', name: '40-schedules', path: '/dashboard/schedules' },
  { group: 'Schedules', name: '41-overview', path: '/dashboard/schedules/overview' },
  { group: 'Schedules', name: '42-shifts', path: '/dashboard/schedules/shifts' },

  { group: 'Leave', name: '50-hub', path: '/dashboard/leave' },
  { group: 'Leave', name: '51-leaves', path: '/dashboard/leaves' },
  { group: 'Leave', name: '52-pending', path: '/dashboard/leaves/pending' },
  { group: 'Leave', name: '53-balances', path: '/dashboard/leaves/balances' },
  { group: 'Leave', name: '54-overtime', path: '/dashboard/overtime' },

  { group: 'Payroll', name: '60-overview', path: '/dashboard/payroll/overview' },
  { group: 'Payroll', name: '61-manage', path: '/dashboard/payroll/manage' },
  { group: 'Payroll', name: '62-validate', path: '/dashboard/payroll/validate' },
  { group: 'Payroll', name: '63-batches', path: '/dashboard/payroll/batches' },
  { group: 'Payroll', name: '64-approvals', path: '/dashboard/payroll/approvals' },
  { group: 'Payroll', name: '65-salary-structure', path: '/dashboard/payroll/salary-structure' },
  { group: 'Payroll', name: '66-grades', path: '/dashboard/payroll/grades' },
  { group: 'Payroll', name: '67-settlements', path: '/dashboard/payroll/settlements' },
  { group: 'Payroll', name: '68-gratuity-rules', path: '/dashboard/payroll/gratuity-rules' },
  { group: 'Payroll', name: '69-encashment', path: '/dashboard/payroll/encashment' },
  { group: 'Payroll', name: '70-recoveries', path: '/dashboard/payroll/recoveries' },
  { group: 'Payroll', name: '71-calendar', path: '/dashboard/payroll/calendar' },
  { group: 'Payroll', name: '72-transfers', path: '/dashboard/payroll/transfers' },
  { group: 'Payroll', name: '73-reports', path: '/dashboard/payroll/reports' },
  { group: 'Payroll', name: '74-banks', path: '/dashboard/banks' },
  { group: 'Payroll', name: '75-bank-config', path: '/dashboard/banks/config' },
  { group: 'Payroll', name: '76-bank-countries', path: '/dashboard/banks/branch-countries' },
  { group: 'Payroll', name: '77-bank-migrate', path: '/dashboard/banks/migrate' },

  { group: 'Finance', name: '80-hub', path: '/dashboard/finance' },
  { group: 'Finance', name: '81-reimbursements', path: '/dashboard/reimbursements' },
  { group: 'Finance', name: '82-travel', path: '/dashboard/travel' },
  { group: 'Finance', name: '83-loans', path: '/dashboard/advance-loans' },
  { group: 'Finance', name: '84-loan-reports', path: '/dashboard/advance-loans/reports' },
  { group: 'Finance', name: '85-budgets', path: '/dashboard/budgets' },

  { group: 'Talent', name: '90-hub', path: '/dashboard/talent' },
  { group: 'Talent', name: '91-appraisal', path: '/dashboard/appraisal' },
  { group: 'Talent', name: '92-training', path: '/dashboard/training' },
  { group: 'Talent', name: '93-rewards-disciplines', path: '/dashboard/rewards-disciplines' },
  { group: 'Talent', name: '94-grievances', path: '/dashboard/grievances' },

  { group: 'Workplace', name: 'A0-hub', path: '/dashboard/workplace' },
  { group: 'Workplace', name: 'A1-assets', path: '/dashboard/assets' },
  { group: 'Workplace', name: 'A2-letters', path: '/dashboard/letters' },
  { group: 'Workplace', name: 'A3-projects', path: '/dashboard/projects' },

  { group: 'System', name: 'B0-hub', path: '/dashboard/system' },
  { group: 'System', name: 'B1-settings', path: '/dashboard/settings' },
  { group: 'System', name: 'B2-audit-logs', path: '/dashboard/audit-logs' },
];

// Fail loudly rather than collect sixty-seven blank records.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await assertAppMounted(page);
  } finally {
    await page.close();
  }
});

test('admin recon: photograph and probe every administrator screen', async ({ page }) => {
  test.setTimeout(45 * 60_000);
  mkdirSync(OUT, { recursive: true });

  const unavailable: string[] = [];

  for (const screen of SCREENS) {
    try {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.goto(screen.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector('main', { state: 'attached', timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.querySelector('main')?.scrollTo(0, 0);
      });
      await page.waitForTimeout(250);
      await page.screenshot({ path: resolve(OUT, `${screen.name}.png`), timeout: 30_000 });

      const info = await page
        .evaluate(() => {
          const scope = document.querySelector('main') ?? document.body;
          const uniq = (a: string[]) => [...new Set(a)];
          const text = (scope.textContent ?? '').replace(/\s+/g, ' ').trim();
          return {
            text: text.slice(0, 160),
            ids: uniq(
              [...scope.querySelectorAll('[data-testid]')].map(
                (e) => e.getAttribute('data-testid') ?? '',
              ),
            ).filter(Boolean),
            btns: uniq(
              [...scope.querySelectorAll('button, a[href]')].map((e) =>
                (e.textContent ?? '').trim().replace(/\s+/g, ' '),
              ),
            ).filter((t) => t && t.length < 34),
            heads: uniq(
              [...scope.querySelectorAll('h1,h2,h3')].map((e) => (e.textContent ?? '').trim()),
            ).filter(Boolean),
            labels: uniq(
              [...scope.querySelectorAll('label')].map((e) =>
                (e.textContent ?? '').trim().replace(/\s+/g, ' '),
              ),
            ).filter((t) => t && t.length < 34),
          };
        })
        .catch(() => null);

      const landed = page.url().replace(/^https?:\/\/[^/]+/, '');
      // A screen whose feature is switched off says so rather than rendering.
      // Worth knowing BEFORE a chapter is written about it.
      const off = /not switched on|not enabled|is disabled|switched off/i.test(info?.text ?? '');
      if (off || landed.startsWith('/403')) unavailable.push(`${screen.name} (${landed})`);

      console.log(`\n### [${screen.group}] ${screen.name}  ${landed}${off ? '   ⛔ FEATURE OFF' : ''}`);
      if (info) {
        console.log(`  head: ${info.heads.slice(0, 5).join(' | ')}`);
        console.log(`  ids : ${info.ids.slice(0, 16).join(', ')}`);
        console.log(`  btn : ${info.btns.slice(0, 12).join(' | ')}`);
        if (info.labels.length) console.log(`  lbl : ${info.labels.slice(0, 12).join(' | ')}`);
      }
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      unavailable.push(`${screen.name}: ${why}`);
      console.warn(`\n### [${screen.group}] ${screen.name}  ⚠ ${why}`);
    }
  }

  if (unavailable.length) {
    console.log(`\n\n══ ${unavailable.length} screen(s) unavailable in this deployment ══`);
    for (const u of unavailable) console.log(`   • ${u}`);
  }
});
