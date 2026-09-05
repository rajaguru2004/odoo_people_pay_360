import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { PayrollApprovalsPage, PayrollDetailPage, selectBranch } from '../../pages';

/**
 * The payroll approval queue, through the screens.
 *
 * Two rules the server holds and the UI used to contradict:
 *
 *  1. **Approve and reject are ADMIN-only.** `POST /payrolls/:id/approve` and
 *     `/reject` admit ADMIN alone. HR_MANAGER reaches the queue to watch it, and
 *     was being shown buttons that answered 403.
 *  2. **A rejection needs a reason.** It is written to `rejectionReason` and is
 *     the only explanation the person who has to redo the run ever sees. The
 *     screen used to collect it with `window.prompt`, which could not enforce a
 *     minimum, could not show a validation message, and — being a native dialog —
 *     was invisible to a browser test.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

interface PayrollRecord {
  id: string;
  status: string;
  month: number;
  year: number;
}

/** A period this file has to itself. */
function targetPeriod(): { month: number; year: number } {
  const monthsForward = 30 + (Date.now() % 12);
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + monthsForward);
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

async function seedAttendance(
  api: ApiClient,
  period: { month: number; year: number },
): Promise<void> {
  const res = await api
    .get<{ data?: Array<{ id: string }> } | Array<{ id: string }>>('/employees?limit=5')
    .catch(() => [] as Array<{ id: string }>);
  const list = Array.isArray(res) ? res : (res?.data ?? []);
  const day = `${period.year}-${String(period.month).padStart(2, '0')}-02`;
  for (const employee of list.slice(0, 5)) {
    await api
      .post('/attendances/manual', {
        employeeId: employee.id,
        date: day,
        checkIn: `${day}T09:00:00.000Z`,
        checkOut: `${day}T18:00:00.000Z`,
        status: 'PRESENT',
        notes: 'Seeded by the payroll approvals journey',
      })
      .catch(() => undefined);
  }
}

test.describe('the payroll approval queue', () => {
  let api: ApiClient;
  let branchId = '';
  let pending: PayrollRecord | null = null;
  const period = targetPeriod();

  test.beforeAll(async () => {
    api = await ApiClient.as('admin');
    branchId = await api.firstBranchId();
    api.withBranch(branchId);
    await seedAttendance(api, period);

    pending = await api
      .post<PayrollRecord>('/payrolls', { month: period.month, year: period.year })
      .catch(() => null);
    if (pending) {
      await api.post(`/payrolls/${pending.id}/submit`, {}).catch(() => undefined);
    }
  });

  test.afterAll(async () => {
    if (pending) await api?.delete(`/payrolls/${pending.id}`).catch(() => {});
    await api?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('PA-UI-01: a submitted run is waiting in the queue', async ({ page, problems }) => {
      test.skip(!pending, 'the run could not be created');

      await selectBranch(page, branchId);
      const approvals = new PayrollApprovalsPage(page);
      await approvals.open();

      await expect.poll(() => approvals.has(pending!.id), { timeout: 20_000 }).toBe(true);
      expect(await approvals.canApprove(pending!.id)).toBe(true);
      settle(problems, 'the approvals queue');
    });

    test('PA-UI-02: rejecting demands a reason before it will submit', async ({ page, problems }) => {
      test.skip(!pending, 'the run could not be created');

      await selectBranch(page, branchId);
      const approvals = new PayrollApprovalsPage(page);
      await approvals.open();

      await approvals.openReject(pending!.id);
      // Empty: the control refuses. This is the half `window.prompt` could not do.
      expect(await approvals.rejectBlocked()).toBe(true);

      await page.getByTestId('payroll-reject-reason').fill('the transport allowance is doubled');
      expect(await approvals.rejectBlocked()).toBe(false);
      await page.getByTestId('payroll-reject-cancel').click();
      crashesOnly(problems);
    });

    test('PA-UI-03: a rejection records the reason and moves the run', async ({ page, problems }) => {
      test.skip(!pending, 'the run could not be created');

      await selectBranch(page, branchId);
      const approvals = new PayrollApprovalsPage(page);
      await approvals.open();
      await approvals.reject(pending!.id, 'the transport allowance is doubled');

      await expect
        .poll(
          async () => (await api.get<PayrollRecord>(`/payrolls/${pending!.id}`)).status,
          { timeout: 20_000 },
        )
        .toBe('REJECTED');

      const record = await api.get<PayrollRecord & { rejectionReason?: string }>(
        `/payrolls/${pending!.id}`,
      );
      expect(record.rejectionReason).toContain('transport allowance');
      settle(problems, 'the approvals queue after a rejection');
    });

    test('PA-UI-04: a rejected run can be corrected and resubmitted', async ({ page, problems }) => {
      test.skip(!pending, 'the run could not be created');

      // Rejection exists to send work back. Before Phase 4 the server admitted a
      // submit only from DRAFT, so a rejected run was a dead end whose only escape
      // was deleting it and generating it again.
      await selectBranch(page, branchId);
      const detail = new PayrollDetailPage(page);
      await detail.open(pending!.id);
      await detail.expectStatus('REJECTED');
      expect(await detail.canSubmit()).toBe(true);

      await detail.submit();
      await detail.expectStatus('PENDING_APPROVAL');
      settle(problems, 'the run detail after a resubmit');
    });

    test('PA-UI-05: approving moves it out of the pending tab', async ({ page, problems }) => {
      test.skip(!pending, 'the run could not be created');

      await selectBranch(page, branchId);
      const approvals = new PayrollApprovalsPage(page);
      await approvals.open();
      await approvals.approve(pending!.id);

      await expect
        .poll(
          async () => (await api.get<PayrollRecord>(`/payrolls/${pending!.id}`)).status,
          { timeout: 20_000 },
        )
        .toBe('APPROVED');
      settle(problems, 'the approvals queue after an approval');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'hr project only');
    });

    test('PA-UI-11: HR sees the queue but is offered no decision', async ({ page, problems }) => {
      await page.goto('/dashboard/payroll/approvals', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.url(), { timeout: 20_000 }).not.toContain('/403');

      // The server admits ADMIN alone. Offering HR the buttons only produced a 403
      // they could do nothing about, so the controls are gone rather than dead.
      expect(await page.getByTestId('payroll-approval-approve').count()).toBe(0);
      expect(await page.getByTestId('payroll-approval-reject').count()).toBe(0);
      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager or employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager') && !isProject('employee'), 'denial projects only');
    });

    test('PA-UI-10: a manager and an employee are refused the screen', async ({ page }) => {
      await page.goto('/dashboard/payroll/approvals', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/403');
    });
  });
});
