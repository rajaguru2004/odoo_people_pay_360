import { test } from '@playwright/test';
import { assertAppMounted } from './capture';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Reconnaissance for the HR MANAGER manual.
 *
 * The HR book is largely the administrator book — the same company, the same
 * branch, the same screens — which is exactly why this pass exists rather than
 * an assumption. "Largely" is not a specification, and the two places it is
 * wrong are the two that matter: a chapter documenting a screen the reader is
 * bounced out of, and a chapter missing the one screen the reader has that the
 * administrator does not.
 *
 * `navConfig.ts` says HR_MANAGER is served the administrator menu with five
 * children withheld — gratuity rules, the payroll calendar, bank master, its
 * field config, and the audit log — and gains an Approvals inbox. It also drops
 * the Dashboard link. That is the CLIENT's view; what a route actually does
 * when it is opened is decided by `ProtectedRoute` and then by the server. So
 * this walks every path the administrator book covers, as her, and records
 * three outcomes per screen: rendered, redirected to `/403`, or a feature
 * switched off.
 *
 *   scripts/hr-manual.sh recon
 */

const OUT = resolve(
  __dirname, '..', '..', '..', '..',
  'docs', 'hr-user-manual', 'screens',
);

/** Every path the administrator book covers, plus the ones only HR gets. */
const SCREENS: Array<{ name: string; path: string; group: string }> = [
  { group: 'Home', name: '00-dashboard', path: '/dashboard' },
  { group: 'Home', name: '01-approvals', path: '/dashboard/approvals' },
  { group: 'Home', name: '02-copilot', path: '/dashboard/copilot' },

  { group: 'Organization', name: '10-hub', path: '/dashboard/organization' },
  { group: 'Organization', name: '11-branches', path: '/dashboard/branches' },
  { group: 'Organization', name: '12-departments', path: '/dashboard/departments' },
  { group: 'Organization', name: '13-dept-tree', path: '/dashboard/departments/tree' },
  { group: 'Organization', name: '14-change-requests', path: '/dashboard/departments/change-requests' },

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
  { group: 'Time', name: '32-history', path: '/dashboard/attendance/history' },
  { group: 'Time', name: '33-reports', path: '/dashboard/attendance/reports' },
  { group: 'Time', name: '34-management', path: '/dashboard/attendance/management' },
  { group: 'Time', name: '35-face-management', path: '/dashboard/attendance/face-management' },

  { group: 'Schedules', name: '40-hub', path: '/dashboard/schedules' },
  { group: 'Schedules', name: '41-overview', path: '/dashboard/schedules/overview' },
  { group: 'Schedules', name: '42-shifts', path: '/dashboard/schedules/shifts' },

  { group: 'Leave', name: '50-hub', path: '/dashboard/leave' },
  { group: 'Leave', name: '51-leaves', path: '/dashboard/leaves' },
  { group: 'Leave', name: '52-pending', path: '/dashboard/leaves/pending' },
  { group: 'Leave', name: '53-balances', path: '/dashboard/leaves/balances' },
  { group: 'Leave', name: '54-overtime', path: '/dashboard/overtime' },

  // The five withheld from HR by `navConfig` are still walked, because a menu
  // that hides a link is not the same as a route that refuses one — and the
  // manual has to say which of the two the reader is meeting.
  { group: 'Payroll', name: '60-overview', path: '/dashboard/payroll/overview' },
  { group: 'Payroll', name: '61-manage', path: '/dashboard/payroll/manage' },
  { group: 'Payroll', name: '62-validate', path: '/dashboard/payroll/validate' },
  { group: 'Payroll', name: '63-batches', path: '/dashboard/payroll/batches' },
  { group: 'Payroll', name: '64-approvals', path: '/dashboard/payroll/approvals' },
  { group: 'Payroll', name: '65-salary-structure', path: '/dashboard/payroll/salary-structure' },
  { group: 'Payroll', name: '66-grades', path: '/dashboard/payroll/grades' },
  { group: 'Payroll', name: '67-settlements', path: '/dashboard/payroll/settlements' },
  { group: 'Payroll', name: '68-gratuity-rules  [ADMIN-ONLY?]', path: '/dashboard/payroll/gratuity-rules' },
  { group: 'Payroll', name: '69-encashment', path: '/dashboard/payroll/encashment' },
  { group: 'Payroll', name: '70-recoveries', path: '/dashboard/payroll/recoveries' },
  { group: 'Payroll', name: '71-calendar  [ADMIN-ONLY?]', path: '/dashboard/payroll/calendar' },
  { group: 'Payroll', name: '72-transfers', path: '/dashboard/payroll/transfers' },
  { group: 'Payroll', name: '73-reports', path: '/dashboard/payroll/reports' },
  { group: 'Payroll', name: '74-banks  [ADMIN-ONLY?]', path: '/dashboard/banks' },
  { group: 'Payroll', name: '75-bank-config  [ADMIN-ONLY?]', path: '/dashboard/banks/config' },
  { group: 'Payroll', name: '76-bank-countries', path: '/dashboard/banks/branch-countries' },

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

  { group: 'System', name: 'B0-hub', path: '/dashboard/system' },
  { group: 'System', name: 'B1-settings', path: '/dashboard/settings' },
  { group: 'System', name: 'B2-audit-logs  [ADMIN-ONLY?]', path: '/dashboard/audit-logs' },
];

// Fail loudly rather than collect sixty blank records.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await assertAppMounted(page);
  } finally {
    await page.close();
  }
});

test('hr recon: what an HR manager can actually reach', async ({ page }) => {
  test.setTimeout(45 * 60_000);
  mkdirSync(OUT, { recursive: true });

  const refused: string[] = [];
  const off: string[] = [];
  const lines: string[] = [];

  /** The sidebar as HR sees it — captured once, it is the book's own chapter 2. */
  let sidebar: string[] = [];

  for (const screen of SCREENS) {
    try {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.goto(screen.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector('main', { state: 'attached', timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(1400);
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.querySelector('main')?.scrollTo(0, 0);
      });
      await page.waitForTimeout(250);
      await page.screenshot({ path: resolve(OUT, `${screen.name}.png`), timeout: 30_000 });

      const info = await page
        .evaluate(() => {
          const scope = document.querySelector('main') ?? document.body;
          const uniq = (a: string[]) => [...new Set(a)].filter(Boolean);
          return {
            text: (scope.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 150),
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
            // The menu this account is offered. Read from the nav, not from
            // `navConfig` — what the reader sees is what got rendered.
            nav: uniq(
              [...document.querySelectorAll('aside a[href], nav a[href]')].map((e) =>
                (e.textContent ?? '').trim().replace(/\s+/g, ' '),
              ),
            ).filter((t) => t && t.length < 40),
          };
        })
        .catch(() => null);

      if (info?.nav?.length && info.nav.length > sidebar.length) sidebar = info.nav;

      const landed = page.url().replace(/^https?:\/\/[^/]+/, '');
      const denied = landed.startsWith('/403') || /not authorised|not authorized|access denied/i.test(info?.text ?? '');
      const switchedOff = /not switched on|not enabled|is disabled|switched off/i.test(info?.text ?? '');

      if (denied) refused.push(`${screen.name} → ${landed}`);
      if (switchedOff) off.push(screen.name);

      const tag = denied ? '   ⛔ REFUSED' : switchedOff ? '   ⚙ FEATURE OFF' : '';
      lines.push(`\n### [${screen.group}] ${screen.name}  ${landed}${tag}`);
      if (info) {
        lines.push(`head: ${info.heads.slice(0, 5).join(' | ')}`);
        lines.push(`ids : ${info.ids.slice(0, 20).join(', ')}`);
        lines.push(`btn : ${info.btns.slice(0, 14).join(' | ')}`);
        if (denied || switchedOff) lines.push(`text: ${info.text}`);
      }
      console.log(`  ✓ ${screen.name}${tag}`);
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      lines.push(`\n### [${screen.group}] ${screen.name}  ⚠ ${why}`);
      console.warn(`  ⚠ ${screen.name} — ${why}`);
    }
  }

  lines.unshift(
    '# What an HR manager can reach',
    '',
    '## The sidebar, as rendered for HR_MANAGER',
    '',
    ...sidebar.map((s) => `- ${s}`),
    '',
    `## Refused (${refused.length})`,
    '',
    ...(refused.length ? refused.map((r) => `- ${r}`) : ['- none']),
    '',
    `## Feature switched off (${off.length})`,
    '',
    ...(off.length ? off.map((r) => `- ${r}`) : ['- none']),
    '',
  );

  writeFileSync(resolve(OUT, 'hr-access.md'), lines.join('\n'));

  console.log(`\n══ ${refused.length} screen(s) refused, ${off.length} switched off ══`);
  for (const r of refused) console.log(`   ⛔ ${r}`);
  console.log(`\n→ ${resolve(OUT, 'hr-access.md')}`);
});
