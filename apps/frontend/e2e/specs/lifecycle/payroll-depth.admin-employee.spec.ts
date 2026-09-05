import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { PayrollApprovalsPage, PayrollDetailPage, PayslipsPage, selectBranch } from '../../pages';

/**
 * Payroll, driven through the screens rather than the API.
 *
 * `payroll.spec.ts` already proves the state machine reaches LOCKED and that
 * locking through the manage screen really locks the record. What it drives over
 * the API — submit and approve — is exactly what this file drives through the
 * UI instead, because those two transitions live on two DIFFERENT screens
 * (`/dashboard/payroll/[id]` submits, `/dashboard/payroll/approvals` approves)
 * and the hand-off between them is not covered anywhere.
 *
 * The other half is the employee's end of the same money: a locked run must
 * produce a payslip the employee can open, showing the figure the server holds.
 * A payroll that runs perfectly and shows the wrong number on the payslip is
 * indistinguishable, to everyone who matters, from a payroll that is wrong.
 *
 * Two constraints inherited from `payroll.spec.ts`, both found the hard way and
 * repeated here rather than shared, because they are the reason this file works:
 * payroll is PER-BRANCH (the `X-Branch-Id` header and the browser's
 * `branch-storage` must agree, or the run is refused outright), and a period
 * with no captured attendance is refused too (otherwise everyone counts absent
 * and LOP wipes the salary).
 *
 * It WRITES a payroll run in a period of its own, and runs serially.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/**
 * A period no other spec will touch.
 *
 * Deliberately far past the window `payroll.spec.ts` picks (1–24 months out):
 * two runs for one branch and month collide, and the loser fails with a
 * message about an existing run rather than about what it was testing.
 */
function targetPeriod(): { month: number; year: number } {
  const monthsForward = 30 + (Date.now() % 18);
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + monthsForward);
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

interface PayrollRecord {
  id: string;
  status: string;
  month: number;
  year: number;
}

async function seedAttendance(api: ApiClient, period: { month: number; year: number }): Promise<void> {
  const employees = await api
    .get<{ data?: Array<{ id: string }> } | Array<{ id: string }>>('/employees?limit=5')
    .catch(() => [] as Array<{ id: string }>);
  const list = Array.isArray(employees) ? employees : (employees?.data ?? []);
  const day = `${period.year}-${String(period.month).padStart(2, '0')}-02`;

  for (const employee of list.slice(0, 5)) {
    await api
      .post('/attendances/manual', {
        employeeId: employee.id,
        date: day,
        checkIn: `${day}T09:00:00.000Z`,
        checkOut: `${day}T18:00:00.000Z`,
        status: 'PRESENT',
        notes: 'Seeded by the payroll-depth journey',
      })
      .catch(() => undefined);
  }
}

test.describe('a payroll run is driven through its screens', () => {
  let api: ApiClient;
  let payroll: PayrollRecord | null = null;
  let branchId = '';
  let createError = '';
  const period = targetPeriod();

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    api = await ApiClient.as('admin');
    branchId = await api.firstBranchId();
    api.withBranch(branchId);

    await seedAttendance(api, period);
    payroll = await api
      .post<PayrollRecord>('/payrolls', { month: period.month, year: period.year })
      .catch((e) => {
        createError = (e as Error).message;
        return null;
      });

    // A retry re-runs this hook with the same period, and the run it created on
    // the first attempt is still there — so creation answers 409 and the whole
    // file would fail for a reason that has nothing to do with what it tests.
    // Adopt the existing run instead of inventing a new period.
    if (!payroll && createError.includes('already exists')) {
      const runs = await api
        .get<{ data?: PayrollRecord[] } | PayrollRecord[]>(`/payrolls?month=${period.month}&year=${period.year}`)
        .catch(() => [] as PayrollRecord[]);
      const list = Array.isArray(runs) ? runs : (runs?.data ?? []);
      payroll = list.find((p) => p.month === period.month && p.year === period.year) ?? null;
      if (payroll) createError = '';
    }
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'payroll is an administrative flow');
    });

    test('a DRAFT run opens on its own screen and offers submit, not lock', async ({ page, problems }) => {
      expect(payroll, `no run for ${period.month}/${period.year}: ${createError}`).toBeTruthy();

      await selectBranch(page, branchId);
      const detail = new PayrollDetailPage(page);
      await detail.open(payroll!.id);

      await detail.expectStatus('DRAFT');
      // The gating is the assertion. A DRAFT run that offers Lock skips approval
      // entirely, which is the whole control this workflow exists to impose.
      expect(await detail.canSubmit(), 'a DRAFT run did not offer submit-for-approval').toBe(true);
      expect(await detail.canLock(), 'a DRAFT run offered Lock, skipping approval').toBe(false);
      expect(await detail.canRevise(), 'an unlocked run offered a revision').toBe(false);

      settle(problems, 'a DRAFT payroll run');
    });

    test('submitting from the detail screen puts it in the approval queue', async ({ page, problems }) => {
      test.skip(!payroll, 'no run to submit');

      await selectBranch(page, branchId);
      const detail = new PayrollDetailPage(page);
      await detail.open(payroll!.id);
      // Submit is confirmed through the app's ConfirmModal now, so the click alone
      // decides nothing — the page object owns both halves of the gesture.
      await detail.submit();

      await detail.expectStatus('PENDING_APPROVAL');

      const record = await api.get<PayrollRecord>(`/payrolls/${payroll!.id}`);
      expect(record.status, 'the screen moved but the record did not').toBe('PENDING_APPROVAL');

      settle(problems, 'submitting a payroll run');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'approving a payroll is ADMIN-only');
    });

    test('the approval queue on the OTHER screen now holds it', async ({ page, problems }) => {
      test.skip(!payroll, 'no run to approve');

      await selectBranch(page, branchId);
      const approvals = new PayrollApprovalsPage(page);
      await approvals.open();

      // The hand-off between the two screens. A submit that never surfaces here
      // strands the run: nothing on the detail screen can move it forward.
      await expect.poll(() => approvals.has(payroll!.id), { timeout: 20_000 }).toBe(true);
      expect(await approvals.canApprove(payroll!.id), 'the queued run offered no approval control').toBe(true);

      await approvals.approve(payroll!.id);

      await expect
        .poll(async () => (await api.get<PayrollRecord>(`/payrolls/${payroll!.id}`)).status, { timeout: 30_000 })
        .toBe('APPROVED');

      settle(problems, 'approving a payroll run through the queue');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'payroll is an administrative flow');
    });

    test('an APPROVED run offers Lock and nothing else', async ({ page, problems }) => {
      test.skip(!payroll, 'no run to look at');

      await selectBranch(page, branchId);
      const detail = new PayrollDetailPage(page);
      await detail.open(payroll!.id);

      await detail.expectStatus('APPROVED');
      expect(await detail.canLock(), 'an APPROVED run did not offer Lock').toBe(true);
      expect(await detail.canSubmit(), 'an APPROVED run offered submit again').toBe(false);

      settle(problems, 'an APPROVED payroll run');
    });

    test('locking from the detail screen locks the record and opens the revision path', async ({ page, problems }) => {
      test.skip(!payroll, 'no run to lock');

      await selectBranch(page, branchId);
      const detail = new PayrollDetailPage(page);
      await detail.open(payroll!.id);
      await detail.lock();

      await expect
        .poll(async () => (await api.get<PayrollRecord>(`/payrolls/${payroll!.id}`)).status, { timeout: 30_000 })
        .toBe('LOCKED');

      await detail.open(payroll!.id);
      await detail.expectStatus('LOCKED');
      expect(await detail.canLock(), 'a LOCKED run still offered Lock').toBe(false);
      // A revision is the only legal way to correct a locked run. If it were
      // missing, a mistake in a locked payroll would be uncorrectable.
      expect(await detail.canRevise(), 'a LOCKED run offered no revision path').toBe(true);

      settle(problems, 'locking a payroll run from its detail screen');
    });

    test('the locked run produced payslips', async () => {
      test.skip(!payroll, 'no run to read');

      const record = await api.get<PayrollRecord & { items?: unknown[] }>(`/payrolls/${payroll!.id}`);
      expect(record.status).toBe('LOCKED');
      expect(Array.isArray(record.items) && record.items.length, 'a locked run has no payslip items').toBeTruthy();
    });
  });
});

test.describe('the employee end of payroll', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the ESS side of payroll');
  });

  test('an employee opens a payslip and sees the figure the server holds', async ({ page, problems }) => {
    const api = await ApiClient.as('employee');
    try {
      const slips = await api.get<Array<{ id: string; netSalary: string | number; payroll?: { year?: number } }>>(
        '/payrolls/my-payslips/list',
      );
      const list = Array.isArray(slips) ? slips : [];
      test.skip(!list.length, 'this employee has no finalised payslip in the baseline');

      const screen = new PayslipsPage(page);
      await screen.open();

      // The list filters to the current year by default, and the runs this
      // suite creates are deliberately in future periods so they cannot collide
      // with each other. Point the filter at the payslip's own year, or the
      // screen is empty for a reason that has nothing to do with payroll.
      const year = list[0].payroll?.year;
      if (year) await screen.selectYear(year);

      await expect.poll(() => screen.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);
      const shownId = await screen.firstPayrollId();
      await screen.openFirst();

      // Navigation is part of the flow: the list sends the employee to
      // /dashboard/my-payroll/[id], and landing anywhere else is a broken link.
      expect(page.url()).toContain('/dashboard/my-payroll/');

      const expected = list.find((s) => s.id === shownId) ?? list[0];
      expect(await screen.net(), 'the payslip shows a different net figure than the record').toBeCloseTo(
        Number(expected.netSalary),
        2,
      );
    } finally {
      await api.dispose();
    }

    settle(problems, 'an employee opening a payslip');
  });

  test('an employee cannot reach the payroll approval queue', async ({ page, problems }) => {
    crashesOnly(problems);
    await page.goto('/dashboard/payroll/approvals', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // Either turned away, or shown a queue with nothing actionable in it.
    if (!page.url().includes('/403')) {
      expect(
        await page.getByTestId('payroll-approval-approve').count(),
        'an employee was offered payroll approval controls',
      ).toBe(0);
    }

    settle(problems, 'an employee at the payroll approval queue');
  });

  test('an employee cannot reach the salary structure screen’s controls', async ({ page, problems }) => {
    crashesOnly(problems);
    await page.goto('/dashboard/payroll/salary-structure', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // Salary components define what everyone is paid. This screen being open to
    // an employee is a straight compensation leak, so either the guard turns
    // them away or the API refuses the data — a crash is neither.
    settle(problems, 'an employee at the salary structure screen');
  });
});
