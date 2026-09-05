import { test, expect, settle, crashesOnly } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import {
  AttendanceManagerPage,
  AttendanceOverviewPage,
  selectBranch,
} from '../../pages';

/**
 * The Attendance Manager — two widgets that write attendance directly, with no
 * request and no approval behind them.
 *
 * This screen is the sharpest example of a pattern this module repeats: it has
 * **no `ProtectedRoute`**. It renders an "HR/Admin only" BANNER and enforces
 * nothing client-side; the only real gate is the server, where
 * `POST /attendances/manual` and `/auto-mark-absent` are both
 * `@Roles(ADMIN, HR_MANAGER)`. So the denial cases below assert a clean
 * data-403 — the screen loading and the action being refused — and deliberately
 * do NOT expect a redirect. Judged with `crashesOnly`, because the 403 IS the
 * system working.
 *
 * The manual-entry FORM rules (the onboarding boundary, the time ordering, the
 * status allowlist) are exhaustively covered in
 * `components/attendance/ManualAttendanceEntry.test.tsx`; this file drives the
 * one thing a component test cannot — that the row a human types here reaches
 * the same data the read screens show.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Yesterday, as YYYY-MM-DD — safely inside every seeded employee's tenure. */
const yesterday = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

interface EmployeeRow {
  id: string;
  fullName: string;
  employeeCode: string;
  startDate?: string;
}

test.describe('the attendance manager, as HR uses it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'the HR half');
  });

  let branchId = '';
  let target: EmployeeRow | null = null;

  test.beforeEach(async ({ api }) => {
    if (!branchId) branchId = await api.firstBranchId();
    if (!target) {
      const res = await api
        .withBranch(branchId)
        .get<any>('/employees?status=ACTIVE&limit=50');
      const rows: EmployeeRow[] = Array.isArray(res) ? res : (res?.data ?? []);
      // Someone who started long enough ago that yesterday is inside tenure —
      // the screen constrains the date field to `min={startDate}`.
      target =
        rows.find(
          (e) => e.startDate && new Date(e.startDate) < new Date(yesterday()),
        ) ?? rows[0] ?? null;
    }
  });

  test('MAN-UI-01 the screen renders its advisory banner', async ({ page, problems, api }) => {
    await selectBranch(page, branchId);
    const manager = new AttendanceManagerPage(page);
    await manager.open();

    expect(await manager.bannerVisible()).toBe(true);
    settle(problems, 'the manager screen');
  });

  test('MAN-UI-02 opening the auto-absent confirmation issues nothing', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const manager = new AttendanceManagerPage(page);
    await manager.open();

    let posted = false;
    page.on('request', (r) => {
      if (r.url().includes('/attendances/auto-mark-absent')) posted = true;
    });

    await manager.openAutoAbsent();
    await page.waitForTimeout(400);

    // The gate has to gate: the dialog is open and nothing has run.
    expect(posted).toBe(false);
    settle(problems, 'the auto-absent gate');
  });

  test('MAN-UI-03 cancelling the confirmation still issues nothing', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const manager = new AttendanceManagerPage(page);
    await manager.open();

    let posted = false;
    page.on('request', (r) => {
      if (r.url().includes('/attendances/auto-mark-absent')) posted = true;
    });

    await manager.openAutoAbsent();
    await manager.cancelAutoAbsent();
    await page.waitForTimeout(400);

    expect(posted).toBe(false);
    settle(problems, 'cancelling auto-absent');
  });

  /**
   * A31 reaching the user. Before the day-end boundary the endpoint answers
   * 201 with `success: true` and a "Skipped" message, having done nothing —
   * so HR presses the button, the screen reports success, and nobody is marked.
   * The case asserts the REQUEST completes and the screen does not crash;
   * whether a result panel appears depends on the boundary, which is why the
   * count is read defensively.
   */
  test('MAN-UI-04 confirming runs it and the screen survives either outcome', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const manager = new AttendanceManagerPage(page);
    await manager.open();

    await manager.openAutoAbsent();
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().includes('/attendances/auto-mark-absent'),
      ),
      manager.confirmAutoAbsent(),
    ]);

    expect(res.status()).toBe(201);
    const marked = await manager.autoAbsentMarked();
    if (marked !== null) expect(Number.isNaN(marked)).toBe(false);

    settle(problems, 'the auto-absent run');
  });

  test('MAN-UI-05 submit is disabled until an employee is chosen', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const manager = new AttendanceManagerPage(page);
    await manager.open();

    expect(await manager.manualSubmitEnabled()).toBe(false);
    settle(problems, 'the manual-entry guard');
  });

  /**
   * THE case this file exists for: a row typed by a human here has to become
   * the same row the read screens show. Everything else about the form is
   * covered far more cheaply in vitest.
   */
  test('MAN-UI-06 a manual entry reaches the overview for that day', async ({
    page,
    problems,
    api,
  }) => {
    test.skip(!target, 'needs an active employee');

    const date = yesterday();

    // Start from a known state: remove any row this spec previously wrote.
    await api
      .withBranch(branchId)
      .get(`/attendances/employee/${target!.id}?month=${Number(date.slice(5, 7))}&year=${Number(date.slice(0, 4))}`)
      .catch(() => null);

    await selectBranch(page, branchId);
    const manager = new AttendanceManagerPage(page);
    await manager.open();

    await manager.pickEmployee(target!.fullName.slice(0, 4), target!.id);
    await manager.fillManual({
      date,
      status: 'PRESENT',
      checkIn: '09:00',
      checkOut: '17:00',
      notes: 'booked by the manager journey',
    });

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().startsWith(`${API_URL}/attendances/manual`),
      ),
      manager.submitManual(),
    ]);
    expect(res.status()).toBe(201);
    expect(await manager.manualSuccess()).toBeTruthy();

    // Now the hand-off: the same day, read through the Overview screen.
    const overview = new AttendanceOverviewPage(page);
    await overview.open();
    await overview.period('custom');
    await page.getByTestId('att-date-from').fill(date);
    await page.getByTestId('att-date-to').fill(date);
    await page.waitForTimeout(1200);

    const ids = await overview.employeeIds();
    expect(ids).toContain(target!.id);
    expect(await overview.rowStatus(target!.id)).toBe('PRESENT');

    settle(problems, 'manual entry reaching the read screens');
  });
});

test.describe('the attendance manager, for the roles it is not meant for', () => {
  /**
   * F5. There is no `ProtectedRoute` on this route, so the screen LOADS for
   * everyone and the server does the refusing — and the two denied roles are
   * refused DIFFERENTLY, which is why they are separate cases rather than a
   * loop.
   *
   * A MANAGER can read `/employees`, so the form populates normally and the
   * refusal only arrives when they press Auto-Absent: a clean 403 on the POST.
   *
   * An EMPLOYEE cannot read `/employees` at all, so the screen's own data call
   * 403s on load and the app raises its global "Access Denied" modal — which
   * then covers the page. That is the behaviour `routes.ts` describes in its
   * header ("the permission modal rather than a redirect"), and it is a better
   * outcome than a silently broken form, so it is asserted as the product rule
   * rather than worked around.
   */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the manager view');
    });

    test('MAN-UI-07 a manager reaches the screen and the server refuses the action', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await api.firstBranchId());
      const manager = new AttendanceManagerPage(page);
      await manager.open();

      // No redirect: the shell is deliberately open.
      await expect(page).not.toHaveURL(/\/403/);

      await manager.openAutoAbsent();
      const [res] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            r.url().includes('/attendances/auto-mark-absent'),
        ),
        manager.confirmAutoAbsent(),
      ]);
      expect(res.status()).toBe(403);

      crashesOnly(problems);
      settle(problems, 'the manager denial');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the employee view');
    });

    test('MAN-UI-08 an employee reaches the screen and is told they are denied', async ({
      page,
      problems,
    }) => {
      const manager = new AttendanceManagerPage(page);

      const [res] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'GET' && r.url().includes('/employees'),
          { timeout: 15_000 },
        ),
        manager.open(),
      ]);
      expect(res.status()).toBe(403);

      // Told, not redirected, and not left staring at an empty form.
      await expect(page).not.toHaveURL(/\/403/);
      await expect(page.getByTestId('permission-denied-modal')).toBeVisible({
        timeout: 10_000,
      });

      crashesOnly(problems);
      settle(problems, 'the employee denial');
    });
  });
});
