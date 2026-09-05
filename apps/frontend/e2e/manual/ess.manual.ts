import { test, expect } from '@playwright/test';
import { shot } from './capture';

/**
 * The capture pass: every figure the manual uses, annotated.
 *
 * Selectors are the ones the app actually carries — harvested from the running
 * screens rather than guessed — and a callout whose selector no longer resolves
 * is REPORTED in the manifest instead of silently vanishing, so a UI change
 * shows up as a build-time complaint rather than as a legend that numbers a
 * badge nobody drew.
 *
 * Run against the manual's own stack:
 *   scripts/manual-stack.sh up
 *   scripts/manual-stack.sh seed
 *   scripts/manual-stack.sh capture
 */

test.describe.configure({ mode: 'serial' });

/**
 * Refuse to photograph an app that has not mounted.
 *
 * This is the guard the first pass did not have. `waitForSelector('main')` was
 * wrapped in `.catch(() => undefined)`, so when every static chunk started
 * answering 500 the capture cheerfully saved twenty-nine white pages reading
 * "Loading..." and reported success. A screenshot tool that cannot tell a
 * working app from a broken one is worse than no screenshot tool.
 */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main', { state: 'attached', timeout: 20_000 });
    const text = await page.locator('body').innerText();
    expect(
      text.length,
      'the app served a shell but never rendered — check that the frontend and its ' +
        'static chunks are from the SAME build (scripts/manual-stack.sh up)',
    ).toBeGreaterThan(200);
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Getting started
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
      { selector: 'input[type="email"], input[name="email"]', label: 'Your work email address' },
      { selector: 'input[type="password"]', label: 'Your password' },
      { selector: 'button[type="submit"]', label: 'Signs you in', badge: 'right' },
    ],
  });
  await anon.close();

  await shot(page, {
    name: 'dashboard',
    caption: 'The dashboard — your portal home',
    url: '/dashboard',
    height: 1400,
    callouts: [
      { selector: 'text=Attendance today', label: 'Today’s clock-in card', pad: 10 },
      { selector: 'text=Check-in', label: 'Clocks you in for the day', badge: 'right' },
      { selector: 'text=Profile Completion', label: 'How complete your record is', pad: 10 },
      { selector: 'text=Recent leave requests', label: 'Your latest leave requests', pad: 10 },
      { selector: 'text=Recent overtime requests', label: 'Your latest overtime claims', pad: 10 },
      { selector: 'text=Quick access', label: 'Shortcuts to the screens used most', pad: 10 },
    ],
  });

  // The chrome that is on every screen. Annotated once, referred to throughout.
  await shot(page, {
    name: 'shell',
    caption: 'The parts of the screen that never change',
    url: '/dashboard',
    height: 900,
    callouts: [
      { selector: 'aside, nav', label: 'The sidebar — every screen you can open', pad: 4 },
      { selector: 'input[placeholder*="Search" i]', label: 'Search' },
      { selector: 'text=AR', label: 'Switch the portal to Arabic', badge: 'bottom' },
      { selector: 'header button:has(svg.lucide-bell), button:has(svg.lucide-bell)', label: 'Notifications', badge: 'bottom' },
      { selector: 'text=Employee', label: 'Your name, role and account menu', badge: 'bottom' },
    ],
  });

  await shot(page, {
    name: 'profile',
    caption: 'My Profile',
    url: '/dashboard/profile',
    height: 1500,
    callouts: [
      { selector: 'text=Profile Completion', label: 'What is still missing from your record', pad: 10 },
      { selector: 'text=Personal Information', label: 'Expand a section to view or edit it' },
      { selector: 'testid=pay-info-request-change', label: 'Ask HR to change your bank details' },
      { selector: 'text=Payment Information', label: 'Your bank details, changed by request' },
    ],
  });

  await shot(page, {
    name: 'settings',
    caption: 'Settings — language, time zone and password',
    url: '/dashboard/settings',
    height: 1200,
    callouts: [
      { selector: 'testid=settings-tab-general', label: 'Language, time zone and date format' },
      { selector: 'testid=settings-tab-notifications', label: 'Which emails and alerts you receive' },
      { selector: 'testid=settings-tab-security', label: 'Change your password' },
      { selector: 'testid=settings-save', label: 'Saves the tab you are on', badge: 'right' },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// My Time
// ─────────────────────────────────────────────────────────────────────────────

test('my time', async ({ page }) => {
  test.setTimeout(420_000);

  await shot(page, {
    name: 'my-attendance',
    caption: 'My Attendance, before you clock in',
    url: '/dashboard/my-attendance',
    height: 1500,
    callouts: [
      { selector: 'testid=attendance-check-in', label: 'Clocks you in', badge: 'right' },
      { selector: 'testid=attendance-check-out', label: 'Clocks you out at the end of the day', badge: 'right' },
      { selector: 'testid=attendance-hours', label: 'Hours counted so far today', pad: 8 },
      { selector: 'text=Attendance history this month', label: 'Every day you have worked this month', pad: 8 },
    ],
  });

  // What [[Check in]] ACTUALLY opens.
  //
  // The first version of this figure was captioned "once you have clocked in"
  // and annotated as though the attendance card had updated. It had not:
  // pressing [[Check in]] opens a camera panel and waits for a photograph, so
  // the picture showed the camera step under a caption promising the result of
  // it — a manual telling the reader they had finished when they had not.
  // Photographed and named for what it is instead.
  await shot(page, {
    name: 'attendance-camera',
    caption: 'The camera step that opens when you select Check in',
    url: '/dashboard/my-attendance',
    height: 1200,
    prepare: async (p) => {
      const button = p.getByTestId('attendance-check-in');
      if (await button.isEnabled().catch(() => false)) {
        await button.click().catch(() => undefined);
        // Chromium's fake device supplies a moving test pattern, so the panel
        // reaches its ready state rather than sitting on "no camera found".
        await p.waitForTimeout(3500);
      }
    },
    callouts: [
      { selector: 'video', label: 'The camera preview — centre your face here', pad: 8 },
      // By test id, not by label: the shutter reads "Check in", and so do the
      // panel's own heading and the button on the page behind it, so matching
      // on text picks one of three at random.
      { selector: 'testid=webcam-shutter', label: 'Takes the photograph and records your check-in', badge: 'right' },
    ],
  });

  await shot(page, {
    name: 'attendance-corrections',
    caption: 'Attendance Requests — asking for a day to be corrected',
    url: '/dashboard/attendance/corrections',
    height: 1200,
    callouts: [
      { selector: 'testid=correction-new', label: 'Raise a new correction request', badge: 'right' },
    ],
  });

  await shot(page, {
    name: 'correction-form',
    caption: 'The correction request form',
    url: '/dashboard/attendance/corrections',
    height: 1200,
    prepare: async (p) => {
      await p.getByTestId('correction-new').click().catch(() => undefined);
      await p.waitForTimeout(900);
    },
    callouts: [
      { selector: 'input[type="date"]', label: 'The day you want corrected' },
      { selector: 'textarea', label: 'Why the recorded time is wrong', pad: 8 },
    ],
  });

  await shot(page, {
    name: 'face-recognition',
    caption: 'Biometric Verification — registering your face',
    url: '/dashboard/face-recognition',
    height: 1200,
    callouts: [
      { selector: 'testid=facereg-panel', label: 'Whether your face is registered yet', pad: 8 },
      { selector: 'text=Start registration', label: 'Begins the three-photo registration' },
    ],
  });

  await shot(page, {
    name: 'my-calendar',
    caption: 'My Calendar — your working days, leave and holidays',
    url: '/dashboard/my-calendar',
    height: 1400,
    callouts: [
      { selector: 'testid=mycal-stat-workdays', label: 'Working days this month' },
      { selector: 'testid=mycal-stat-leaves', label: 'Days you are on leave' },
      { selector: 'testid=mycal-stat-overtime', label: 'Overtime hours' },
      { selector: 'testid=mycal-stat-holidays', label: 'Public holidays' },
      { selector: 'text=Month', label: 'Switch between month, week, day and list', badge: 'bottom' },
    ],
  });

  await shot(page, {
    name: 'my-leaves',
    caption: 'My Leaves — balances, requests and their status',
    url: '/dashboard/my-leaves',
    height: 1300,
    callouts: [
      { selector: 'testid=my-leave-balance-card', label: 'Days remaining, per leave type', pad: 8 },
      { selector: 'testid=my-leave-stat', label: 'How many requests you have, by outcome', pad: 8 },
      { selector: 'text=Create Request', label: 'Apply for leave', badge: 'right' },
      { selector: 'testid=my-leave-filter', label: 'Show only one status', pad: 6 },
      { selector: 'testid=my-leave-row', label: 'One request — dates, reason and status', pad: 6 },
      { selector: 'testid=my-leave-review', label: 'Open the full request' },
    ],
  });

  await shot(page, {
    name: 'leave-new',
    caption: 'Applying for leave',
    url: '/dashboard/leaves/new',
    height: 1200,
    callouts: [
      { selector: 'select', label: 'Which kind of leave you are taking' },
      { selector: 'input[type="date"]', label: 'First day away' },
      { selector: 'textarea', label: 'Why you are asking — your approver reads this', pad: 8 },
      { selector: 'text=Click to upload', label: 'Attach a medical note or ticket', pad: 8 },
      { selector: 'testid=leave-submit', label: 'Sends the request to your approver', badge: 'right' },
      { selector: 'text=Remaining Annual Leave', label: 'Your balance, while you fill the form in', pad: 8 },
    ],
  });

  await shot(page, {
    name: 'my-overtime',
    caption: 'My Overtime — claims and their status',
    url: '/dashboard/my-overtime',
    height: 1200,
    callouts: [
      { selector: 'testid=my-ot-new', label: 'Claim overtime you have worked', badge: 'right' },
      { selector: 'testid=my-ot-stat', label: 'Hours claimed, approved and pending', pad: 8 },
      { selector: 'testid=my-ot-filter', label: 'Show only one status', pad: 6 },
      { selector: 'testid=overtime-row', label: 'One claim — date, hours and status', pad: 6 },
      { selector: 'testid=my-ot-details', label: 'Open the full claim' },
    ],
  });

  await shot(page, {
    name: 'overtime-new',
    caption: 'Claiming overtime',
    url: '/dashboard/overtime/new',
    height: 1300,
    callouts: [
      { selector: 'testid=overtime-date', label: 'The day you worked the extra hours' },
      { selector: 'testid=overtime-start', label: 'When the overtime started' },
      { selector: 'testid=overtime-end', label: 'When it ended' },
      { selector: 'testid=ot-reason', label: 'Why the extra hours were needed', pad: 8 },
      { selector: 'testid=overtime-submit', label: 'Sends the claim for approval', badge: 'right' },
      { selector: 'text=Overtime salary', label: 'What the hours are worth at your rate', pad: 8 },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// My Pay
// ─────────────────────────────────────────────────────────────────────────────

test('my pay', async ({ page }) => {
  test.setTimeout(420_000);

  await shot(page, {
    name: 'payslips',
    caption: 'My Payslips',
    url: '/dashboard/payroll',
    height: 1400,
    callouts: [
      { selector: 'text=This month\'s salary', label: 'This month at a glance', pad: 10 },
      { selector: 'text=Total pay stubs', label: 'How many payslips you have', pad: 8 },
      { selector: 'testid=payslip-year', label: 'Filter by year' },
      { selector: 'testid=payslip-row', label: 'One month — basic, allowances, overtime, deductions and net', pad: 6 },
      { selector: 'testid=payslip-view', label: 'Open the payslip in full' },
      { selector: 'text=Payroll Information', label: 'How your pay is worked out', pad: 8 },
    ],
  });

  await shot(page, {
    name: 'payslip-detail',
    caption: 'A single payslip',
    url: '/dashboard/payroll',
    height: 1400,
    prepare: async (p) => {
      await p.getByTestId('payslip-view').first().click().catch(() => undefined);
      await p.waitForTimeout(1500);
    },
  });

  await shot(page, {
    name: 'my-travel',
    caption: 'My Travel — trip requests',
    url: '/dashboard/my-travel',
    height: 1200,
    callouts: [
      { selector: 'testid=mytravel-new', label: 'Request a trip', badge: 'right' },
      { selector: 'testid=mytravel-row', label: 'One trip — destination, dates and status', pad: 6 },
      { selector: 'testid=mytravel-cancel', label: 'Withdraw a trip that is still pending' },
    ],
  });

  // Flag-gated: pictured so the manual can explain the message rather than
  // leaving the reader wondering whether the screen is broken.
  await shot(page, {
    name: 'gratuity',
    caption: 'My Gratuity, when end-of-service benefits are switched off',
    url: '/dashboard/my-payroll/gratuity',
    height: 900,
    callouts: [
      { selector: 'text=End-of-service benefits are not switched on', label: 'What this message means', pad: 10 },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// My Records
// ─────────────────────────────────────────────────────────────────────────────

test('my records', async ({ page }) => {
  test.setTimeout(420_000);

  await shot(page, {
    name: 'my-documents',
    caption: 'My Documents',
    url: '/dashboard/my-documents',
    height: 1100,
    callouts: [
      { selector: 'testid=document-search', label: 'Search your documents' },
      { selector: 'testid=document-kind-filter', label: 'Show one kind only' },
    ],
  });

  await shot(page, {
    name: 'my-letters',
    caption: 'My Letters — salary certificates and other HR letters',
    url: '/dashboard/my-letters',
    height: 1100,
    callouts: [
      { selector: 'testid=letter-request-open', label: 'Ask HR for a letter', badge: 'right' },
      { selector: '[data-testid^="my-letter-row-"]', label: 'One request — what you asked for and when', pad: 6 },
      { selector: '[data-testid^="my-letter-status-"]', label: 'Where the request has got to' },
    ],
  });

  await shot(page, {
    name: 'my-assets',
    caption: 'My Assets — company property issued to you',
    url: '/dashboard/my-assets',
    height: 1100,
    callouts: [
      { selector: 'text=Currently held', label: 'What you are holding right now', pad: 8 },
      { selector: '[data-testid^="my-asset-row-"]', label: 'One item — what it is and when you got it', pad: 6 },
      { selector: '[data-testid^="asset-acknowledge-"]', label: 'Confirm you have received it', badge: 'right' },
    ],
  });

  await shot(page, {
    name: 'my-training',
    caption: 'My Training — courses you are booked on',
    url: '/dashboard/my-training',
    height: 1100,
    callouts: [{ selector: 'text=Upcoming', label: 'Sessions still to come', pad: 8 }],
  });

  await shot(page, {
    name: 'my-grievances',
    caption: 'My Grievances — raising a concern',
    url: '/dashboard/my-grievances',
    height: 1100,
    callouts: [
      { selector: 'text=Raise a grievance', label: 'Open a new case', badge: 'right' },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Work, team and alerts
// ─────────────────────────────────────────────────────────────────────────────

test('work, team and alerts', async ({ page }) => {
  test.setTimeout(420_000);

  await shot(page, {
    name: 'my-team',
    caption: 'My Team',
    url: '/dashboard/my-team',
    height: 1000,
  });

  await shot(page, {
    name: 'my-timesheets',
    caption: 'My Timesheets — hours you have booked',
    url: '/dashboard/my-timesheets',
    height: 1100,
    callouts: [
      { selector: 'text=daily', label: 'Group by day, week or month', badge: 'bottom' },
      { selector: 'text=Daily Breakdown', label: 'Hours booked, per day', pad: 8 },
    ],
  });

  await shot(page, {
    name: 'approvals',
    caption: 'Approvals — items waiting for your decision',
    url: '/dashboard/approvals',
    height: 1000,
    callouts: [
      { selector: 'testid=approval-tab-pending', label: 'Waiting for you' },
      { selector: 'testid=approval-tab-decided', label: 'Already decided by you' },
    ],
  });

  await shot(page, {
    name: 'notifications',
    caption: 'Notifications',
    url: '/dashboard/notifications',
    height: 1200,
    callouts: [
      { selector: 'text=Read them all', label: 'Mark everything as read' },
      { selector: 'text=Delete all', label: 'Clear the list' },
      { selector: 'text=Unread', label: 'Show only what you have not read', badge: 'bottom' },
    ],
  });
});
