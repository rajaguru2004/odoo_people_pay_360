import { test, expect } from '@playwright/test';
import { shot } from './capture';

/**
 * The capture pass for the ADMINISTRATOR manual — every figure the book uses.
 *
 * Selectors come from `admin-anchors.manual.ts`, which harvests the test ids,
 * buttons and labels each screen actually carries. Guessing them produces a
 * capture full of callouts that resolve to nothing, and the manifest reports
 * every miss so a stale selector is a visible complaint rather than a legend
 * numbering a badge nobody drew.
 *
 * Split into one test per menu group rather than one long test, for the reason
 * the employee book learned the hard way (F6): a single shared timeout meant
 * one slow screen cost every screen after it its picture. Each group now has
 * its own budget and its own recorded failure.
 *
 *   scripts/admin-manual.sh up
 *   scripts/admin-manual.sh seed
 *   scripts/admin-manual.sh capture
 */

test.describe.configure({ mode: 'serial' });

/** Refuse to photograph an app that has not mounted. See `assertAppMounted`. */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main', { state: 'attached', timeout: 20_000 });
    const text = await page.locator('body').innerText();
    expect(
      text.length,
      'the app served a shell but never rendered — check that the frontend and its ' +
        'static chunks are from the SAME build (scripts/admin-manual.sh up)',
    ).toBeGreaterThan(200);
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Getting started
// ─────────────────────────────────────────────────────────────────────────────

test('getting started', async ({ browser, page }) => {
  test.setTimeout(300_000);

  // The sign-in screen needs a SIGNED-OUT browser, which the project's
  // storageState is the opposite of.
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonPage = await anon.newPage();
  await shot(anonPage, {
    name: 'login',
    caption: 'The sign-in screen',
    url: '/login',
    callouts: [
      { selector: 'input[type="email"], input[name="email"]', label: 'The work email address your account was created with' },
      { selector: 'input[type="password"]', label: 'Your password' },
      { selector: 'button[type="submit"]', label: 'Signs you in', badge: 'right' },
    ],
  });
  await anon.close();

  await shot(page, {
    name: 'console',
    caption: 'The administration console, as it opens',
    url: '/dashboard',
    height: 1400,
    callouts: [
      { selector: 'text=Total employees', label: 'Headcount in the selected branch', pad: 10, optional: true },
      { selector: 'text=Personnel overview', label: 'Joiners, leavers and the department split', pad: 10 },
      { selector: 'text=Operations & alerts', label: 'What needs attention today', pad: 10, optional: true },
      // Below the fold at this framing, and the figure is worth more framed
      // tight than stretched to reach one button: a shot scaled to the text
      // column loses width for every pixel of height it gains.
      { selector: 'text=Refresh', label: 'Re-reads every figure on the page', badge: 'left', optional: true },
    ],
  });

  // The chrome that is on every screen. Annotated once, referred to throughout.
  // The BRANCH SELECTOR is the callout that matters most in this book: almost
  // every list an administrator opens is filtered by it, and payroll refuses to
  // run at all until a specific branch is chosen.
  await shot(page, {
    name: 'shell',
    caption: 'The parts of the console that never change',
    url: '/dashboard',
    height: 900,
    callouts: [
      { selector: 'aside, nav', label: 'The sidebar — every screen your role can open', pad: 4 },
      { selector: 'input[placeholder*="Search" i]', label: 'Search staff, departments and records' },
      {
        selector: 'text=Muscat',
        label: 'The BRANCH SELECTOR — everything below it is scoped to this branch',
        badge: 'bottom',
        arrow: { from: 'bottom', text: 'Branch', distance: 130 },
      },
      { selector: 'text=AR', label: 'Switches the console to Arabic', badge: 'bottom' },
      { selector: 'button:has(svg.lucide-bell)', label: 'Notifications and approval alerts', badge: 'bottom' },
      { selector: 'text=System Admin', label: 'Your name, role and account menu', badge: 'bottom' },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Organisation
// ─────────────────────────────────────────────────────────────────────────────

test('organisation', async ({ page }) => {
  test.setTimeout(300_000);

  await shot(page, {
    name: 'org-hub',
    caption: 'Organization — the landing dashboard',
    url: '/dashboard/organization',
    height: 1400,
    callouts: [
      { selector: 'text=Department workforce', label: 'Headcount by department', pad: 10 },
      { selector: 'text=Branch workforce', label: 'Headcount by branch', pad: 10 },
      { selector: 'text=Change requests', label: 'Structure changes waiting for a decision', pad: 10 },
    ],
  });

  await shot(page, {
    name: 'branches',
    caption: 'Branches',
    url: '/dashboard/branches',
    height: 1200,
    callouts: [
      { selector: 'testid=branch-new', label: 'Opens the new-branch form' },
      { selector: 'testid=branch-stat-total', label: 'How many branches exist', pad: 8 },
      { selector: 'testid=branch-stat-employees', label: 'Staff across all branches', pad: 8 },
      { selector: 'testid=branch-search', label: 'Find a branch by name or code' },
      { selector: 'testid=branch-card-MCT', label: 'One branch — its code, hours and headcount', pad: 8 },
      { selector: 'testid=branch-view-table', label: 'Switch between cards and a table', badge: 'bottom' },
    ],
  });

  await shot(page, {
    name: 'branch-new',
    caption: 'Creating a branch',
    url: '/dashboard/branches/new',
    height: 1500,
    callouts: [
      { selector: 'testid=branch-code', label: 'Short unique code, e.g. MCT' },
      { selector: 'testid=branch-name', label: 'The name staff will see' },
      { selector: 'testid=branch-timezone', label: 'Drives every timestamp recorded at this branch' },
      { selector: 'testid=branch-start-time', label: 'Office start — lateness is measured against this' },
      { selector: 'testid=branch-end-time', label: 'Office end' },
      { selector: 'testid=branch-weekoff-5', label: 'Weekly off days — Friday and Saturday in Oman' },
      { selector: 'testid=branch-geofencing', label: 'Restrict check-in to a location', optional: true },
    ],
  });

  await shot(page, {
    name: 'departments',
    caption: 'Departments',
    url: '/dashboard/departments',
    height: 1300,
    callouts: [
      { selector: 'testid=dept-new', label: 'Add a department or a team' },
      // NOT "staff cannot be assigned to a team". That check was retired in
      // `employees.service.ts` — "a sub-department is a legitimate home for
      // staff" — and a legend asserting a rule the server no longer enforces
      // would be printed in a manual as though it were the law.
      { selector: 'testid=dept-stat-toplevel', label: 'Top-level departments', pad: 8 },
      // The badge lands on the *Total teams* COUNT tile, so the legend has to
      // describe the tile. It read 'Sub-departments — each with its own
      // manager and headcount', which describes the cards further down the
      // page — a legend that names something other than the thing it is
      // drawn on is the one error an annotated figure exists to prevent.
      { selector: 'testid=dept-stat-teams', label: 'How many of them are teams', pad: 8 },
      { selector: 'testid=dept-view-org-structure', label: 'Show the structure as a chart', badge: 'bottom' },
      { selector: 'testid=dept-card-HRD', label: 'One department, with its manager and headcount', pad: 8 },
    ],
  });

  await shot(page, {
    name: 'dept-tree',
    caption: 'The organisation chart',
    url: '/dashboard/departments/tree',
    height: 1100,
    callouts: [
      { selector: 'testid=tree-node-E2E-OPS', label: 'A main department', pad: 8 },
      { selector: 'testid=tree-node-E2E-OPS-TEAM', label: 'A sub-department, nested under its parent', pad: 8 },
      { selector: 'text=Grid view', label: 'Back to the card list', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'dept-change-requests',
    caption: 'Department change requests',
    url: '/dashboard/departments/change-requests',
    height: 1000,
    fit: false,
    callouts: [
      { selector: 'testid=cr-stat-pending', label: 'Requests waiting for a decision', pad: 8 },
      { selector: 'testid=cr-filter-PENDING', label: 'Filter the queue by outcome' },
      { selector: 'testid=cr-empty', label: 'The empty state — no requests have been raised', pad: 8, optional: true },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · People
// ─────────────────────────────────────────────────────────────────────────────

test('people', async ({ page }) => {
  test.setTimeout(360_000);

  await shot(page, {
    name: 'people-hub',
    caption: 'People — the landing dashboard',
    url: '/dashboard/people',
    height: 1400,
    callouts: [
      { selector: 'text=Workforce trend', label: 'Headcount over time', pad: 10 },
      { selector: 'text=Employee lifecycle', label: 'Joiners, movers and leavers', pad: 10 },
      { selector: 'text=Permit runway', label: 'Visas and permits approaching expiry', pad: 10 },
    ],
  });

  await shot(page, {
    name: 'employees',
    caption: 'The employee directory',
    url: '/dashboard/employees',
    height: 1500,
    callouts: [
      { selector: 'testid=emp-new', label: 'Start onboarding a new employee' },
      { selector: 'testid=employees-import-open', label: 'Add many people at once from a spreadsheet' },
      { selector: 'testid=emp-stat-total', label: 'Headcount in the selected branch', pad: 8 },
      { selector: 'testid=emp-search', label: 'Search by name, code, email or department' },
      { selector: 'testid=emp-filter-open', label: 'Filter by department, status or date', badge: 'left' },
      { selector: 'testid=emp-view-kanban', label: 'Table, cards or a board', badge: 'bottom' },
      { selector: 'testid=emp-export-open', label: 'Export the list', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'employee-new',
    caption: 'Onboarding — step 1, personal information',
    url: '/dashboard/employees/new',
    height: 1500,
    callouts: [
      { selector: 'text=Personal Info', label: 'The five steps of onboarding', pad: 8 },
      { selector: 'testid=field-fullName', label: 'Full name, as it should appear on payslips and letters' },
      { selector: 'testid=field-email', label: 'Work email — this becomes the employee’s login' },
      { selector: 'testid=field-idCard', label: 'ID card number, or let the system generate one' },
      { selector: 'testid=field-nationalityClass', label: 'National, GCC or expatriate — decides PASI liability' },
      // Sits at the foot of a form far taller than the frame. Optional for the
      // same reason as the dashboard's Refresh — the prose names it instead.
      { selector: 'text=Continue', label: 'Moves to the next step', badge: 'left', optional: true },
    ],
  });

  await shot(page, {
    name: 'supervisor-teams',
    caption: 'Teams',
    url: '/dashboard/supervisor-teams',
    height: 900,
    fit: false,
    callouts: [
      { selector: 'testid=steam-create', label: 'Create a team and name its supervisor' },
    ],
  });

  await shot(page, {
    name: 'contracts',
    caption: 'Contracts',
    url: '/dashboard/contracts',
    height: 1300,
    callouts: [
      { selector: 'testid=con-create', label: 'Draw up a new contract' },
      { selector: 'testid=con-terminations-link', label: 'The termination queue' },
      { selector: 'testid=con-search', label: 'Find a contract by employee or number' },
      { selector: 'testid=con-filter-open', label: 'Filter by type, status or expiry', badge: 'left' },
      { selector: 'testid=con-export', label: 'Export the list', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'contract-new',
    caption: 'Creating a contract',
    url: '/dashboard/contracts/new',
    height: 1400,
    callouts: [
      { selector: 'testid=con-form-employee-search', label: 'Who the contract is for' },
      { selector: 'testid=con-form-type', label: 'Indefinite, fixed-term or probation' },
      { selector: 'testid=con-form-start', label: 'When it takes effect' },
      { selector: 'testid=con-form-end', label: 'End date — required for a fixed term' },
      { selector: 'testid=con-form-salary', label: 'Basic salary in OMR' },
      { selector: 'testid=con-form-submit', label: 'Creates the contract', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'terminations',
    caption: 'Terminations waiting for approval',
    url: '/dashboard/contracts/terminations',
    height: 1200,
    callouts: [
      { selector: 'testid=term-stat-pending', label: 'How many are waiting', pad: 8 },
      { selector: 'testid=term-tab-pending', label: 'The queue, and the decided history beside it' },
      { selector: 'testid=clearance-banner', label: 'Clearance — outstanding loans and assets block a leaver', pad: 8, optional: true },
      { selector: 'text=Approve', label: 'Approves the termination', badge: 'left' },
      { selector: 'text=Reject', label: 'Sends it back', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'visa-reports',
    caption: 'Visa and permit expiry',
    url: '/dashboard/visa-reports',
    height: 1100,
    fit: false,
    callouts: [
      { selector: 'testid=visa-summary-expiring', label: 'Documents expiring soon', pad: 8 },
      { selector: 'testid=visa-summary-expired', label: 'Documents already expired', pad: 8 },
      { selector: 'testid=visa-filter-expiring', label: 'Narrow to a window — 30, 60 or 90 days' },
      { selector: 'testid=visa-export', label: 'Export for the PRO or government relations team', badge: 'left' },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Time & attendance
// ─────────────────────────────────────────────────────────────────────────────

test('time and attendance', async ({ page }) => {
  test.setTimeout(360_000);

  await shot(page, {
    name: 'time-hub',
    caption: 'Time & Attendance — the landing dashboard',
    url: '/dashboard/time',
    height: 1400,
    callouts: [
      { selector: 'text=Attendance overview', label: 'Attendance across the branch', pad: 10 },
      { selector: 'text=Turnout today', label: 'Who is in, late or absent right now', pad: 10 },
      { selector: 'text=Short-handed departments', label: 'Where cover is thin today', pad: 10 },
    ],
  });

  await shot(page, {
    name: 'attendance',
    caption: 'Today’s attendance register',
    url: '/dashboard/attendance',
    height: 1600,
    callouts: [
      { selector: 'testid=att-period-today', label: 'Today, this week, this month, or a range you choose' },
      { selector: 'testid=att-stat-present', label: 'Present, late and absent counts', pad: 8 },
      { selector: 'testid=att-chip-late', label: 'Filter the list to just the late arrivals' },
      { selector: 'testid=att-search', label: 'Find one person' },
      { selector: 'testid=att-dept', label: 'Narrow to one department' },
      { selector: 'testid=att-export', label: 'Export the register', badge: 'left' },
      { selector: 'testid=att-nav-reports', label: 'The monthly summary report', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'attendance-history',
    caption: 'The monthly attendance log',
    url: '/dashboard/attendance/history',
    height: 1300,
    callouts: [
      { selector: 'testid=attlog-month', label: 'The month being shown', pad: 8 },
      { selector: 'testid=attlog-prev-month', label: 'Step back a month' },
      { selector: 'testid=attlog-search', label: 'Find one employee’s row' },
      { selector: 'testid=attlog-export', label: 'Export the whole grid', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'attendance-reports',
    caption: 'The attendance summary report',
    url: '/dashboard/attendance/reports',
    height: 1400,
    callouts: [
      { selector: 'testid=attrep-kpi-checkins', label: 'Check-ins recorded in the month', pad: 8 },
      { selector: 'testid=attrep-kpi-lateRate', label: 'Late arrivals as a percentage', pad: 8 },
      { selector: 'testid=attrep-kpi-avgHours', label: 'Average hours worked per day', pad: 8 },
      { selector: 'testid=attrep-export', label: 'Export to Excel', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'attendance-management',
    caption: 'Logging attendance by hand',
    url: '/dashboard/attendance/management',
    height: 1300,
    callouts: [
      { selector: 'testid=attman-banner', label: 'This screen is limited to HR managers and administrators', pad: 8 },
      { selector: 'testid=absent-open', label: 'Mark a whole day’s absentees in one pass' },
      { selector: 'testid=manual-employee-search', label: 'Who the record is for' },
      { selector: 'testid=manual-date', label: 'Which day' },
      { selector: 'testid=manual-status', label: 'Present, absent, leave or holiday — nothing else' },
      { selector: 'testid=manual-in', label: 'Check-in time; lateness is derived from it' },
      { selector: 'testid=manual-submit', label: 'Writes the record', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'face-management',
    caption: 'Face registration',
    url: '/dashboard/attendance/face-management',
    height: 1200,
    callouts: [
      { selector: 'testid=bio-stat-registered', label: 'How many staff have enrolled a face', pad: 8 },
      { selector: 'testid=bio-stat-unregistered', label: 'How many have not', pad: 8 },
      { selector: 'testid=bio-search', label: 'Find an employee' },
      { selector: 'text=Register', label: 'Enrol this employee’s face', badge: 'left', optional: true },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · Schedules · 7 · Leave & overtime
// ─────────────────────────────────────────────────────────────────────────────

test('schedules, leave and overtime', async ({ page }) => {
  test.setTimeout(360_000);

  await shot(page, {
    name: 'schedules-hub',
    caption: 'Schedules — the landing dashboard',
    url: '/dashboard/schedules',
    height: 1400,
    callouts: [
      { selector: 'text=Schedule coverage', label: 'How much of the roster is filled', pad: 10 },
      { selector: 'text=Coverage gaps', label: 'Days with nobody rostered', pad: 10, optional: true },
      { selector: 'text=Shift distribution', label: 'How shifts are spread across staff', pad: 10 },
    ],
  });

  await shot(page, {
    name: 'schedules-overview',
    caption: 'The monthly schedule',
    url: '/dashboard/schedules/overview',
    height: 1400,
    callouts: [
      { selector: 'testid=schedule-stat-staff', label: 'Staff scheduled this month', pad: 8 },
      { selector: 'testid=schedule-stat-leaves', label: 'Days lost to approved leave', pad: 8 },
      { selector: 'testid=schedule-department-filter', label: 'Narrow to one department' },
      { selector: 'testid=schedule-next-month', label: 'Move between months' },
    ],
  });

  await shot(page, {
    name: 'shifts',
    caption: 'Shift planning',
    url: '/dashboard/schedules/shifts',
    height: 1400,
    callouts: [
      { selector: 'testid=shift-bulk-create', label: 'Roster many people at once' },
      { selector: 'testid=shift-create', label: 'Create a single shift calendar' },
      { selector: 'testid=shift-employee-search', label: 'Pick whose week you are looking at' },
      { selector: 'testid=shift-stat-hours', label: 'Hours rostered for the selected person', pad: 8 },
    ],
  });

  await shot(page, {
    name: 'leave-hub',
    caption: 'Leave & Overtime — the landing dashboard',
    url: '/dashboard/leave',
    height: 1400,
    callouts: [
      { selector: 'text=Pending approvals', label: 'Requests waiting on you', pad: 10 },
      { selector: 'text=Leave type', label: 'Which types are being taken', pad: 10 },
      { selector: 'text=Leave balance', label: 'Entitlement left across the branch', pad: 10 },
    ],
  });

  await shot(page, {
    name: 'leaves',
    caption: 'All leave requests',
    url: '/dashboard/leaves',
    height: 1500,
    callouts: [
      { selector: 'testid=lv-stat-pending', label: 'Waiting for a decision', pad: 8 },
      { selector: 'testid=lv-stat-approved', label: 'Approved', pad: 8 },
      { selector: 'testid=lv-stat-rejected', label: 'Rejected', pad: 8 },
      { selector: 'testid=lv-filter-status', label: 'Filter by outcome' },
      { selector: 'testid=lv-filter-type', label: 'Filter by leave type' },
      { selector: 'testid=lv-search', label: 'Find one employee’s requests' },
    ],
  });

  await shot(page, {
    name: 'leaves-pending',
    caption: 'The leave approval queue',
    url: '/dashboard/leaves/pending',
    height: 1200,
    callouts: [
      { selector: 'testid=lvp-count', label: 'How many are waiting', pad: 8 },
      { selector: 'testid=lvp-open', label: 'Open a request to approve or reject it', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'leave-balances',
    caption: 'Leave balances',
    url: '/dashboard/leaves/balances',
    height: 1300,
    callouts: [
      { selector: 'testid=lbl-year', label: 'The leave year being shown' },
      { selector: 'testid=lbl-run-accrual', label: 'Accrue this period’s entitlement for everybody' },
      { selector: 'testid=lbl-reset-defaults', label: 'Reset balances to the policy defaults', badge: 'left' },
      { selector: 'testid=lbl-edit', label: 'Adjust one person’s balance', badge: 'left', optional: true },
    ],
  });

  await shot(page, {
    name: 'overtime-admin',
    caption: 'Overtime claims',
    url: '/dashboard/overtime',
    height: 1300,
    callouts: [
      // `overtime/new` has no employee field: `overtimeService.create()` files
      // against the signed-in account, and the `createForEmployee` call that
      // would do otherwise is never reached from the UI. A legend saying "on
      // someone's behalf" would send an administrator to file overtime against
      // themselves.
      { selector: 'testid=ot-new', label: 'Opens the overtime claim form' },
      { selector: 'testid=ot-stat', label: 'Claims by status', pad: 8 },
      { selector: 'text=Pending', label: 'Filter to the claims still to decide' },
      { selector: 'testid=overtime-details', label: 'Open a claim to approve or reject it', badge: 'left', optional: true },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 · Payroll
// ─────────────────────────────────────────────────────────────────────────────

test('payroll', async ({ page }) => {
  test.setTimeout(480_000);

  await shot(page, {
    name: 'payroll-overview',
    caption: 'Payroll — the landing dashboard',
    url: '/dashboard/payroll/overview',
    height: 1600,
    callouts: [
      { selector: 'text=Run pipeline', label: 'Where each run has reached', pad: 10 },
      { selector: 'text=Payment readiness', label: 'What still blocks payment', pad: 10 },
      { selector: 'testid=oman-compliance', label: 'Oman compliance — WPS, PASI, overtime and end-of-service', pad: 8 },
      { selector: 'text=Manage runs', label: 'Go to the runs themselves', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'payroll-manage',
    caption: 'Payroll runs',
    url: '/dashboard/payroll/manage',
    height: 1300,
    callouts: [
      { selector: 'text=Create payroll', label: 'Generate a run for a month' },
      { selector: 'text=Draft', label: 'A run still being worked on', pad: 8 },
      { selector: 'text=Approved', label: 'A run that has been signed off', pad: 8 },
      { selector: 'testid=payroll-submit-approval', label: 'Send the draft for approval', badge: 'left' },
      { selector: 'testid=payroll-lock', label: 'Lock the run so it can no longer be changed', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'payroll-validate',
    caption: 'Pre-flight validation',
    url: '/dashboard/payroll/validate',
    height: 1100,
    fit: false,
    callouts: [
      { selector: 'testid=preflight-month', label: 'The period to check' },
      { selector: 'testid=preflight-run', label: 'Runs the checks without generating anything', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'payroll-approvals',
    caption: 'Payroll approvals',
    url: '/dashboard/payroll/approvals',
    height: 1100,
    fit: false,
    callouts: [
      { selector: 'text=Waiting for approval', label: 'Runs still to be decided' },
      { selector: 'text=Approved', label: 'Runs already signed off' },
      { selector: 'text=Rejected', label: 'Runs sent back' },
    ],
  });

  await shot(page, {
    name: 'payroll-batches',
    // 'Payroll batches' — what the screen, the sidebar and the empty state all
    // call it. A caption that renames the screen sends the reader looking for a
    // menu item that does not exist.
    caption: 'Payroll batches',
    url: '/dashboard/payroll/batches',
    height: 1000,
    fit: false,
    callouts: [
      { selector: 'testid=batch-create', label: 'Group approved payslips into a payment batch' },
    ],
  });

  await shot(page, {
    name: 'salary-structure',
    caption: 'Salary components',
    url: '/dashboard/payroll/salary-structure',
    height: 1300,
    callouts: [
      { selector: 'testid=sc-add', label: 'Add a component to an employee' },
      // `text=Allowances` matched the page SUBTITLE, not the chip — the
      // resolver takes the smallest element CONTAINING the needle, and an
      // exact match beats a containing one only among candidates that have it.
      // The badge was drawn on the subtitle while its legend described the
      // filters. Anchored on the chip's full label instead.
      { selector: 'text=Basic salary (0)', label: 'Filter by kind — basic, allowance or bonus' },
      { selector: 'testid=sc-edit', label: 'Change an amount or its effective date', badge: 'left', optional: true },
    ],
  });

  await shot(page, {
    name: 'grades',
    caption: 'Salary grades',
    url: '/dashboard/payroll/grades',
    height: 1200,
    callouts: [
      { selector: 'testid=grade-new', label: 'Create a band' },
      // NOT "the components every employee in the band receives". The template
      // is a suggestion an administrator applies by hand; payroll never reads
      // it. A legend promising otherwise would have the manual describe an
      // automation that does not exist.
      { selector: 'testid=grade-template', label: 'The component template suggested for this band', badge: 'left', optional: true },
      { selector: 'testid=grade-assign', label: 'Put an employee in this band', badge: 'left', optional: true },
    ],
  });

  await shot(page, {
    name: 'gratuity-rules',
    caption: 'End-of-service rules',
    url: '/dashboard/payroll/gratuity-rules',
    height: 1300,
    callouts: [
      { selector: 'testid=rule-country', label: 'Which country’s law the band belongs to' },
      { selector: 'testid=rule-class', label: 'Whom it applies to — national, GCC, expatriate or any' },
      { selector: 'testid=rule-days', label: 'Days of pay accrued per year of service' },
      { selector: 'testid=rule-create', label: 'Adds the band', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'encashment',
    caption: 'Leave encashment',
    url: '/dashboard/payroll/encashment',
    height: 1200,
    callouts: [
      { selector: 'testid=encash-tab-requests', label: 'Requests, policies and the year-end carry-forward' },
      { selector: 'testid=encash-employee', label: 'Whose leave is being encashed' },
      { selector: 'testid=encash-quote', label: 'Price it before committing', badge: 'left' },
      { selector: 'testid=encash-submit', label: 'Raises the request', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'recoveries',
    caption: 'Recoveries',
    url: '/dashboard/payroll/recoveries',
    height: 1100,
    fit: false,
    callouts: [
      { selector: 'testid=recovery-employee', label: 'Who owes it' },
      { selector: 'testid=recovery-kind', label: 'What kind of overpayment it is' },
      { selector: 'testid=recovery-total', label: 'The total to recover' },
      { selector: 'testid=recovery-create', label: 'Starts recovering it from payroll', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'payroll-calendar',
    caption: 'The payroll calendar',
    url: '/dashboard/payroll/calendar',
    height: 1100,
    fit: false,
    callouts: [
      { selector: 'testid=calendar-save', label: 'Saves the cut-off and pay days for the year', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'payroll-reports',
    caption: 'Payroll reports',
    url: '/dashboard/payroll/reports',
    height: 1200,
    callouts: [
      { selector: 'testid=report-tab-register', label: 'The full payroll register' },
      { selector: 'testid=report-tab-cost', label: 'Cost by department' },
      { selector: 'testid=report-tab-statutory', label: 'PASI and other statutory returns' },
      { selector: 'testid=report-tab-gratuity', label: 'End-of-service liability' },
      { selector: 'testid=report-tab-variance', label: 'What changed since last month' },
    ],
  });

  await shot(page, {
    name: 'banks',
    caption: 'Banks',
    url: '/dashboard/banks',
    height: 1200,
    callouts: [
      { selector: 'testid=bank-country-picker', label: 'Which country’s banks are listed' },
      { selector: 'testid=bank-name', label: 'Bank name' },
      { selector: 'testid=bank-swift', label: 'SWIFT / BIC — used by the WPS file' },
      { selector: 'testid=bank-add', label: 'Adds the bank', badge: 'left' },
      { selector: 'testid=bank-field-config', label: 'Which account fields staff must supply', badge: 'left' },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 · Finance
// ─────────────────────────────────────────────────────────────────────────────

test('finance', async ({ page }) => {
  test.setTimeout(360_000);

  await shot(page, {
    name: 'finance-hub',
    caption: 'Finance — the landing dashboard',
    url: '/dashboard/finance',
    height: 1400,
    callouts: [
      { selector: 'text=Employee expense', label: 'What staff have claimed', pad: 10 },
      { selector: 'text=Reimbursement health', label: 'How quickly claims are being settled', pad: 10 },
      { selector: 'text=Loans & advances', label: 'What is outstanding', pad: 10 },
      { selector: 'text=Budget health', label: 'Spend against budget', pad: 10 },
    ],
  });

  await shot(page, {
    name: 'reimbursements-admin',
    caption: 'Reimbursement claims',
    url: '/dashboard/reimbursements',
    height: 1200,
    callouts: [
      { selector: 'testid=reimb-tab-pending', label: 'Claims waiting for a decision' },
      { selector: 'testid=reimb-tab-all', label: 'Every claim, whatever its state' },
      { selector: 'testid=reimb-approve', label: 'Approves the claim for payment', badge: 'left', optional: true },
      { selector: 'testid=reimb-reject', label: 'Sends it back with a reason', badge: 'left', optional: true },
    ],
  });

  await shot(page, {
    name: 'travel-admin',
    caption: 'Travel requests',
    url: '/dashboard/travel',
    height: 1200,
    callouts: [
      // Same trap as `ot-new`: the New trip form has no employee picker and
      // posts against the signed-in account, so a legend promising on-behalf
      // filing would misdescribe the control it is drawn on.
      { selector: 'testid=travel-new', label: 'Opens the trip request form' },
      { selector: 'testid=travel-filter-status', label: 'Filter by state' },
      { selector: 'testid=travel-approve', label: 'Approves the trip', badge: 'left', optional: true },
    ],
  });

  await shot(page, {
    name: 'loans-admin',
    caption: 'Advances and loans',
    url: '/dashboard/advance-loans',
    height: 1300,
    callouts: [
      { selector: 'testid=loan-tab-pending', label: 'Requests waiting for a decision' },
      { selector: 'testid=loan-products', label: 'The loan types and their rules' },
      { selector: 'testid=loan-settlement', label: 'Settle a loan early' },
      { selector: 'testid=loan-reports', label: 'Outstanding, overdue and portfolio reports' },
      { selector: 'testid=loan-approve', label: 'Approves the request', badge: 'left', optional: true },
    ],
  });

  await shot(page, {
    name: 'loan-reports',
    caption: 'Loan reports',
    url: '/dashboard/advance-loans/reports',
    height: 1200,
    callouts: [
      { selector: 'testid=loan-report-tab-outstanding', label: 'What is still owed' },
      { selector: 'testid=loan-report-tab-emiDue', label: 'Instalments due this cycle' },
      { selector: 'testid=loan-report-tab-overdue', label: 'Instalments that were missed' },
      { selector: 'testid=loan-report-asof', label: 'The date the report is drawn to' },
      { selector: 'testid=loan-report-export', label: 'Export to CSV', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'budgets',
    caption: 'Budgets',
    url: '/dashboard/budgets',
    height: 1100,
    callouts: [
      { selector: 'testid=budget-new', label: 'Create a budget for a fiscal year' },
      { selector: 'testid=budget-variance-link', label: 'Spend against plan', badge: 'left', optional: true },
      { selector: 'testid=budget-close', label: 'Closes the budget to further commitments', badge: 'left', optional: true },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10 · Talent · 11 · Workplace
// ─────────────────────────────────────────────────────────────────────────────

test('talent and workplace', async ({ page }) => {
  test.setTimeout(420_000);

  await shot(page, {
    name: 'talent-hub',
    caption: 'Talent — the landing dashboard',
    url: '/dashboard/talent',
    height: 1400,
    callouts: [
      { selector: 'text=Performance health', label: 'How far appraisal has got', pad: 10 },
      { selector: 'text=Learning & development', label: 'Training booked and completed', pad: 10 },
      { selector: 'text=Grievance queue', label: 'Cases still open', pad: 10 },
    ],
  });

  await shot(page, {
    name: 'appraisal',
    caption: 'Appraisal',
    url: '/dashboard/appraisal',
    height: 1200,
    callouts: [
      { selector: 'text=Last Quarter', label: 'The period being appraised' },
      { selector: 'text=Generate Appraisal', label: 'Scores the selected group', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'training-admin',
    caption: 'Training',
    url: '/dashboard/training',
    height: 1300,
    callouts: [
      { selector: 'text=sessions', label: 'Sessions, nominations and the course catalogue' },
      { selector: 'text=Schedule session', label: 'Put a course in the diary' },
      { selector: 'text=Nominate', label: 'Put someone on a session', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'rewards-disciplines',
    caption: 'Rewards and discipline',
    url: '/dashboard/rewards-disciplines',
    height: 1200,
    callouts: [
      { selector: 'text=Add New', label: 'Record a commendation or a disciplinary case' },
      { selector: 'text=Commendation', label: 'The two registers, side by side' },
    ],
  });

  await shot(page, {
    name: 'grievances-admin',
    caption: 'Grievances',
    url: '/dashboard/grievances',
    height: 1200,
    callouts: [
      { selector: 'text=Grievance', label: 'The case list', pad: 10, optional: true },
    ],
  });

  await shot(page, {
    name: 'workplace-hub',
    caption: 'Workplace — the landing dashboard',
    url: '/dashboard/workplace',
    height: 1400,
    callouts: [
      { selector: 'text=Asset register', label: 'What the company owns and who holds it', pad: 10 },
      { selector: 'text=Letter requests', label: 'Letters waiting to be issued', pad: 10 },
      { selector: 'text=Project health', label: 'Projects running and overdue', pad: 10 },
    ],
  });

  await shot(page, {
    name: 'assets-admin',
    caption: 'The asset register',
    url: '/dashboard/assets',
    height: 1400,
    callouts: [
      { selector: 'testid=asset-new', label: 'Add an item to the register' },
      { selector: 'testid=asset-stat-held', label: 'Items currently issued to staff', pad: 8 },
      { selector: 'testid=asset-stat-unacknowledged', label: 'Issued but not yet acknowledged by the holder', pad: 8 },
      { selector: 'testid=asset-status-filter', label: 'Filter by state' },
      { selector: 'testid=asset-search', label: 'Find an item by tag or name' },
    ],
  });

  await shot(page, {
    name: 'letters-admin',
    caption: 'Letter requests',
    url: '/dashboard/letters',
    height: 1200,
    callouts: [
      { selector: 'testid=letter-status-filter', label: 'Filter by state' },
      { selector: 'text=Issue', label: 'Generates and issues the letter', badge: 'left' },
      { selector: 'text=Reject', label: 'Refuses it, with a reason', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'projects-admin',
    caption: 'Projects',
    url: '/dashboard/projects',
    height: 1300,
    callouts: [
      { selector: 'testid=project-new', label: 'Start a project' },
      { selector: 'testid=project-stat-active', label: 'Projects running now', pad: 8 },
      { selector: 'testid=project-status-filter', label: 'Filter by state' },
      { selector: 'testid=project-search', label: 'Find a project' },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12 · System administration
// ─────────────────────────────────────────────────────────────────────────────

test('system administration', async ({ page }) => {
  test.setTimeout(420_000);

  await shot(page, {
    name: 'system-hub',
    caption: 'System — the landing dashboard',
    url: '/dashboard/system',
    height: 1300,
    callouts: [
      { selector: 'text=Busiest accounts', label: 'Who is making the most changes', pad: 10 },
      { selector: 'text=Audit logs', label: 'The full record of who changed what', badge: 'left' },
    ],
  });

  await shot(page, {
    name: 'settings-general',
    caption: 'Settings — the tabs, and General',
    url: '/dashboard/settings',
    height: 1400,
    callouts: [
      { selector: 'testid=settings-tab-general', label: 'Language, time zone and date format' },
      { selector: 'testid=settings-tab-holidays', label: 'The public holiday calendar' },
      { selector: 'testid=settings-tab-approvals', label: 'Who approves what, and in what order' },
      { selector: 'testid=settings-tab-payroll', label: 'Payroll rules and the country preset' },
      { selector: 'testid=settings-tab-wps', label: 'Wage Protection System configuration' },
      { selector: 'testid=settings-save', label: 'Saves the tab you are on — and only that tab', badge: 'left' },
    ],
  });

  // Each tab is its own figure: the settings screen is sixteen screens wearing
  // one URL, and a chapter that pictures only the first of them is useless for
  // the fifteen an administrator actually spends their time in.
  //
  // The third column is the label for the TAB, and the fourth for the SAVE
  // button. Keeping them apart matters: the first draft passed the tab's
  // description as the save button's label, so badge ((2)) was drawn on
  // [[Save changes]] while the legend beside it read "The public holidays this
  // branch observes". A chapter citing that badge would have pointed the
  // reader at the wrong control — the one failure mode an annotated manual
  // exists to prevent.
  const TABS: Array<[string, string, string, string]> = [
    ['settings-holidays', 'settings-tab-holidays', 'Settings — Holidays',
      'The public holidays this branch observes'],
    ['settings-approvals', 'settings-tab-approvals', 'Settings — Approval hierarchy',
      'Who decides each kind of request, and in what order'],
    ['settings-payroll', 'settings-tab-payroll', 'Settings — Payroll',
      'Currency, overtime multipliers and statutory rules'],
    ['settings-wps', 'settings-tab-wps', 'Settings — Salary payment files',
      'The employer profile the wage file is built from'],
  ];

  for (const [name, tab, caption, what] of TABS) {
    const tabName = caption.split('— ')[1];
    await shot(page, {
      name,
      caption,
      url: '/dashboard/settings',
      height: 1400,
      prepare: async (p) => {
        await p.locator(`[data-testid="${tab}"]`).click({ timeout: 10_000 }).catch(() => undefined);
        await p.waitForTimeout(900);
      },
      callouts: [
        { selector: `testid=${tab}`, label: `The ${tabName} tab — ${what}` },
        { selector: 'testid=settings-save', label: 'Saves THIS tab, and only this tab', badge: 'left', optional: true },
      ],
    });
  }

  await shot(page, {
    name: 'audit-logs',
    caption: 'The audit log',
    url: '/dashboard/audit-logs',
    height: 1300,
    callouts: [
      { selector: 'text=Apply Filter', label: 'Narrow by user, resource, action or date', badge: 'left' },
      { selector: 'text=Export CSV', label: 'Export the filtered records', badge: 'left' },
      { selector: 'text=Refresh', label: 'Re-reads the log', badge: 'left' },
    ],
  });
});
