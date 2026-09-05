import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { AttendanceCorrectionsPage, selectBranch } from '../../pages';

/**
 * Attendance regularisation — filing a correction and having it decided.
 *
 * The reason this belongs in a browser suite rather than an API one is the
 * conversion in the middle. The screen collects a date and two wall-clock times
 * in three separate inputs and assembles ISO instants from them; the backend
 * stores instants. Every timezone and DST bug in this feature lives in that
 * assembly step, and it exists only in the browser. An API test writes the
 * instants directly and can never see it.
 *
 * The second reason is that an approved correction rewrites an attendance row,
 * which is a payroll input. This is a money path with a mild-looking UI.
 *
 * Two roles, as with leave: the employee files, HR decides, the employee sees
 * the outcome. This file WRITES and runs serially.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const marker = `pw-corr-${Date.now().toString(36)}`;

/**
 * A past date — the form's `max` is today, and a correction is by definition
 * about a day that already happened. Nudged per run so repeated runs on one
 * database do not pile several requests onto the same day.
 */
function pastDate(offsetDays: number): string {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const RUN_NUDGE = Date.now() % 40;

interface Correction {
  id: string;
  status: string;
  reason?: string;
  requestedCheckIn?: string | null;
  requestedCheckOut?: string | null;
}

test.describe('an employee files a correction', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the employee files');
  });

  let api: ApiClient;
  let filedId: string | undefined;
  const date = pastDate(10 + RUN_NUDGE);

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    api = await ApiClient.as('employee');
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('the quota badge and the request button are both offered', async ({ page, problems }) => {
    const screen = new AttendanceCorrectionsPage(page);
    await screen.open();

    // `monthly_attendance_request_limit` is pinned in the baseline. If the
    // screen could not read it, the button is disabled and nobody can file
    // anything — a silent lockout, which is exactly the failure mode worth a test.
    expect(await screen.canRequest(), 'the employee was not offered the request button').toBe(true);

    settle(problems, 'the corrections screen for an employee');
  });

  test('the form refuses to submit without a reason', async ({ page, problems }) => {
    const screen = new AttendanceCorrectionsPage(page);
    await screen.open();
    await screen.openForm();

    // Date and times only. `reason` is `required` on the textarea, so the
    // browser should block the submit and the modal should still be open.
    await screen.fill({ date, checkIn: '09:15', checkOut: '18:05', reason: '' });
    await screen.submit();

    expect(await screen.formStillOpen(), 'a correction with no reason was accepted').toBe(true);

    settle(problems, 'the correction form with no reason');
  });

  test('a complete request is filed and appears as PENDING', async ({ page, problems }) => {
    const screen = new AttendanceCorrectionsPage(page);
    await screen.open();
    await screen.openForm();
    await screen.fill({
      date,
      checkIn: '09:15',
      checkOut: '18:05',
      reason: `Automated journey ${marker} — forgot to clock out`,
    });
    await screen.submit();

    /**
     * Matched on the run marker, NOT on "the first pending one". The same
     * employee account also files the approver half's requests over the API and
     * Playwright projects share this database, so "first pending" picked up
     * whichever record happened to exist first and the time assertions below
     * then checked the wrong one.
     *
     * Polled on the SERVER rather than on the row count, for the same reason:
     * this employee already has rows, so `rowCount() > 0` is true before the
     * submit has landed and proves nothing about the request just filed.
     */
    const mineFromThisRun = async () => {
      const all = await api.get<Correction[]>('/attendance-corrections/my-requests');
      return (Array.isArray(all) ? all : []).filter(
        (c) => c.status === 'PENDING' && c.reason?.includes(marker) && c.reason.includes('forgot to clock out'),
      );
    };
    await expect
      .poll(async () => (await mineFromThisRun()).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    filedId = (await mineFromThisRun())[0].id;

    await screen.expectRowStatus(filedId, 'PENDING');

    settle(problems, 'filing a correction');
  });

  test('the times the browser assembled are the times the server stored', async () => {
    test.skip(!filedId, 'the filing step did not produce an id');

    const record = await api.get<Correction>(`/attendance-corrections/${filedId}`);

    // The whole point of testing this in a browser. The form was given 09:15 and
    // 18:05 as wall-clock times on `date`; the stack runs TZ=UTC, so those are
    // the instants that must come back. A regression in the local-time-to-ISO
    // conversion moves these by the offset and nothing else notices.
    expect(record.requestedCheckIn, 'no check-in time was stored').toBeTruthy();
    expect(new Date(record.requestedCheckIn!).toISOString()).toBe(`${date}T09:15:00.000Z`);
    expect(new Date(record.requestedCheckOut!).toISOString()).toBe(`${date}T18:05:00.000Z`);
  });

  test('the employee is not offered the approval controls on their own request', async ({ page, problems }) => {
    test.skip(!filedId, 'the filing step did not produce an id');

    const screen = new AttendanceCorrectionsPage(page);
    await screen.open();

    expect(await screen.canReview(filedId!), 'an employee was offered approve/reject on their own request').toBe(false);

    settle(problems, 'an employee viewing their own pending correction');
  });
});

/**
 * The approver's half, with its own seeded request so it does not depend on the
 * employee project having run — Playwright projects share no state.
 */
test.describe('HR decides a correction', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'HR decides');
  });

  test.describe.configure({ mode: 'serial' });

  let employeeApi: ApiClient;
  let approveId: string;
  let rejectId: string;
  let branchId = '';

  test.beforeAll(async () => {
    if (!isProject('hr')) return;
    employeeApi = await ApiClient.as('employee');
    const adminApi = await ApiClient.as('admin');
    branchId = await adminApi.firstBranchId();
    await adminApi.dispose();

    const mk = async (offset: number, tag: string) => {
      const day = pastDate(offset + RUN_NUDGE);
      const created = await employeeApi.post<Correction>('/attendance-corrections', {
        // DATE-ONLY, deliberately. The DTO declares `@IsDateString()`, which
        // accepts a full ISO-8601 instant, but the service does
        // `dto.date.split('-')` and feeds the third part to `Number()` — with a
        // datetime that yields NaN, an Invalid Date, and an unhandled Prisma
        // 500 that leaks a query in its body. Recorded in docs/TESTING.md; this
        // spec sends what the UI sends rather than pinning the bug.
        date: day,
        requestedCheckIn: `${day}T09:00:00.000Z`,
        requestedCheckOut: `${day}T18:00:00.000Z`,
        reason: `Automated journey ${marker} — ${tag}`,
      });
      return created.id;
    };

    approveId = await mk(60, 'approval half');
    rejectId = await mk(70, 'rejection half');
  });

  test.afterAll(async () => {
    await employeeApi?.dispose();
  });

  test('HR sees the request and approves it with a note', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const screen = new AttendanceCorrectionsPage(page);
    await screen.open();

    expect(await screen.hasRow(approveId), 'HR could not see a pending correction').toBe(true);
    expect(await screen.canReview(approveId), 'HR was not offered the approval controls').toBe(true);

    await screen.review(approveId, 'approve', `Verified by the automated journey ${marker}`);
    await screen.expectRowStatus(approveId, 'APPROVED');

    // The screen agreeing with itself proves nothing; the record has to move.
    const record = await employeeApi.get<Correction>(`/attendance-corrections/${approveId}`);
    expect(record.status).toBe('APPROVED');

    settle(problems, 'approving a correction');
  });

  test('an approved request no longer offers a decision', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const screen = new AttendanceCorrectionsPage(page);
    await screen.open();

    expect(await screen.canReview(approveId), 'a settled correction still offered approval').toBe(false);

    settle(problems, 'a settled correction');
  });

  test('rejection carries its reason through to the record', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const screen = new AttendanceCorrectionsPage(page);
    await screen.open();

    await screen.review(rejectId, 'reject', `Rejected by the automated journey ${marker}`);
    await screen.expectRowStatus(rejectId, 'REJECTED');

    const record = await employeeApi.get<Correction & { rejectedReason?: string }>(
      `/attendance-corrections/${rejectId}`,
    );
    expect(record.status).toBe('REJECTED');
    expect(record.rejectedReason, 'the rejection reason was not stored').toContain(marker);

    settle(problems, 'rejecting a correction');
  });
});

test.describe('the corrections screen is scoped by role', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee view');
    });

    test('an employee sees only their own requests', async ({ page, problems }) => {
      const employeeApi = await ApiClient.as('employee');
      const adminApi = await ApiClient.as('admin');
      try {
        const mine = await employeeApi.get<Correction[]>('/attendance-corrections/my-requests');
        const all = await adminApi.get<Correction[]>('/attendance-corrections');

        const screen = new AttendanceCorrectionsPage(page);
        await screen.open();
        const shown = await screen.rowCount();

        // The leak this guards against: the screen calling the all-requests
        // endpoint for everyone and relying on the API to filter. It does not.
        expect(shown, 'an employee was shown more rows than they own').toBeLessThanOrEqual(
          Array.isArray(mine) ? mine.length : 0,
        );
        if (Array.isArray(all) && Array.isArray(mine) && all.length > mine.length) {
          expect(shown, 'an employee was shown every employee’s corrections').toBeLessThan(all.length);
        }
      } finally {
        await employeeApi.dispose();
        await adminApi.dispose();
      }

      settle(problems, 'the employee corrections list');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'manager view');
    });

    test('a manager is not handed the company-wide queue', async ({ page, problems }) => {
      // The list endpoint is ADMIN/HR_MANAGER only, so a manager's screen falls
      // back to their own requests and the API refuses the rest — a logged 403 is
      // the correct outcome here, not a fault.
      crashesOnly(problems);

      const screen = new AttendanceCorrectionsPage(page);
      await screen.open();
      expect(await screen.canReview('nonexistent')).toBe(false);

      settle(problems, 'the manager corrections list');
    });
  });
});
