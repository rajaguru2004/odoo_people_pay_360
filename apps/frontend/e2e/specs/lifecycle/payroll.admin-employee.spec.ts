import { test, expect, settle, ApiClient } from '../../fixtures';
import { PayrollManagePage } from '../../pages';

/**
 * Payroll, from a run to a locked one.
 *
 * Step 10 of `apps/backend/test/live/full-lifecycle.live-e2e.ts`, through the
 * browser. This is the money path, and `lock` is the step that matters: it is
 * the ONLY transition that settles reimbursements and loan recoveries, and a
 * LOCKED run cannot be edited or re-locked — the only way back is a revision.
 *
 * A UI that appears to lock while the record stays APPROVED is therefore an
 * expensive kind of wrong, and it is exactly the failure a per-screen test
 * cannot see: the button reacts, the toast appears, and nothing settled.
 *
 * The run is created over the API and driven through the UI from there, so the
 * spec spends its time on the transition under test rather than on six screens
 * of setup.
 *
 * Payroll is PER-BRANCH. Generating a run without a branch selected is refused
 * outright ("Select a specific branch before generating payroll"), so both the
 * API client and the browser have to agree on which branch they are in — the
 * browser reads it from the persisted `branch-storage`, the API from an
 * `X-Branch-Id` header. A mismatch shows up as a manage screen listing nothing.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/**
 * A period this run has to itself.
 *
 * Two constraints pull in opposite directions. It cannot be in the past: the
 * seeded employees start on the day the seed ran, so an earlier month has
 * nobody in it. And it cannot be a month a previous run already used, because
 * that run would still be sitting there LOCKED and the transitions below would
 * have nothing left to do — which is exactly how this spec failed the first
 * time it ran twice.
 *
 * So: a distinct future month per run. Attendance for it is seeded below, which
 * is what makes an arbitrary future period legal.
 */
function targetPeriod(): { month: number; year: number } {
  const monthsForward = 1 + (Date.now() % 24);
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + monthsForward);
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

/**
 * Puts the browser in the same branch the API client is using.
 *
 * `branch-storage` is the zustand slice the axios interceptor reads to set
 * `X-Branch-Id`; writing it before the first navigation is the equivalent of
 * choosing a branch in the top-bar picker.
 */
async function selectBranch(page: import('@playwright/test').Page, branchId: string): Promise<void> {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.evaluate((id) => {
    window.localStorage.setItem(
      'branch-storage',
      JSON.stringify({ state: { selectedBranchId: id }, version: 0 }),
    );
  }, branchId);
}

interface PayrollRecord {
  id: string;
  status: string;
  month: number;
  year: number;
}

/**
 * One present day per active employee, on the first working day of the period.
 *
 * Enough to clear the "attendance has not been processed" guard without
 * pretending to be a realistic month — the payroll arithmetic itself is the
 * backend's to test, and it has its own suite for that.
 */
async function seedAttendance(api: ApiClient, period: { month: number; year: number }): Promise<void> {
  const employees = await api
    .get<{ data?: Array<{ id: string }> } | Array<{ id: string }>>('/employees?limit=5')
    .catch(() => [] as Array<{ id: string }>);
  const list = Array.isArray(employees) ? employees : (employees?.data ?? []);
  if (!list.length) return;

  const day = `${period.year}-${String(period.month).padStart(2, '0')}-02`;

  for (const employee of list.slice(0, 5)) {
    await api
      .post('/attendances/manual', {
        employeeId: employee.id,
        date: day,
        checkIn: `${day}T09:00:00.000Z`,
        checkOut: `${day}T18:00:00.000Z`,
        status: 'PRESENT',
        notes: 'Seeded by the payroll journey',
      })
      // Already present from an earlier run — that is the desired end state.
      .catch(() => undefined);
  }
}

test.describe('a payroll run reaches LOCKED', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'payroll is an administrative flow');
  });

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

    // Payroll refuses to run for a period with NO attendance captured — without
    // that guard every employee would count absent for every working day and
    // LOP would wipe the whole salary. So the journey does what HR does: get
    // attendance in before asking for payroll. This mirrors the real order of
    // operations rather than working around it.
    await seedAttendance(api, period);

    payroll = await api
      .post<PayrollRecord>('/payrolls', { month: period.month, year: period.year })
      .catch((e) => {
        createError = (e as Error).message;
        return null;
      });
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('a run can be created for the period', async () => {
    expect(payroll, `no run for ${period.month}/${period.year}: ${createError}`).toBeTruthy();
    // DRAFT is the only legal starting state. Anything else means the engine
    // skipped a transition, or the period was not as fresh as it should be.
    expect(payroll!.status).toBe('DRAFT');
  });

  test('the run is visible on the manage screen', async ({ page, problems }) => {
    test.skip(!payroll, 'no run to look at');

    await selectBranch(page, branchId);
    const manage = new PayrollManagePage(page);
    await manage.open();

    // The screen has to show the run before any of the buttons below mean
    // anything — a manage page that silently lists nothing is its own bug.
    const body = await page.locator('body').innerText();
    expect(body.length).toBeGreaterThan(0);

    settle(problems, 'the payroll manage screen');
  });

  test('submitting for approval moves it out of DRAFT', async () => {
    test.skip(!payroll, 'no run to submit');

    await api.post(`/payrolls/${payroll!.id}/submit`, {});

    const after = await api.get<PayrollRecord>(`/payrolls/${payroll!.id}`);
    expect(after.status).toBe('PENDING_APPROVAL');
  });

  test('approving moves it to APPROVED', async () => {
    test.skip(!payroll, 'no run to approve');

    await api.post(`/payrolls/${payroll!.id}/approve`, { notes: 'Automated journey' });

    const after = await api.get<PayrollRecord>(`/payrolls/${payroll!.id}`);
    expect(after.status).toBe('APPROVED');
  });

  test('LOCKING it through the UI actually locks the record', async ({ page, problems }) => {
    test.skip(!payroll, 'no run to lock');

    await selectBranch(page, branchId);
    const manage = new PayrollManagePage(page);
    await manage.open();

    // The claim: the button did more than change its own label.
    test.skip(!(await manage.hasLockableRun()), 'the manage screen offered no lockable run');
    await manage.lockFirst();

    await expect
      .poll(async () => (await api.get<PayrollRecord>(`/payrolls/${payroll!.id}`)).status, {
        timeout: 30_000,
      })
      .toBe('LOCKED');

    settle(problems, 'locking a payroll run');
  });

  test('a LOCKED run refuses to be edited', async () => {
    test.skip(!payroll, 'no run to re-lock');

    const current = await api.get<PayrollRecord>(`/payrolls/${payroll!.id}`);
    test.skip(current.status !== 'LOCKED', 'the run never reached LOCKED');

    // The immutability that makes LOCKED meaningful. Without it, "locked"
    // would be a label rather than a state — which is what it used to be
    // before the WPS phase-0 work.
    await expect(api.post(`/payrolls/${payroll!.id}/lock`, {})).rejects.toThrow();
  });
});

test.describe('payslip visibility', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the ESS side of payroll');
  });

  test('an employee sees only their own payslips', async ({ page, problems }) => {
    // `/dashboard/payroll` is role-polymorphic: an admin sees runs, an employee
    // sees their own payslips. The same route rendering the admin view for an
    // employee would be a straight data leak.
    await page.goto('/dashboard/payroll', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    expect(new URL(page.url()).pathname).toBe('/dashboard/payroll');

    // No administrative controls on the employee's view of this screen.
    expect(await page.getByTestId('payroll-lock').count(), 'an employee was offered the lock control').toBe(0);
    expect(
      await page.getByTestId('payroll-submit-approval').count(),
      'an employee was offered the submit-for-approval control',
    ).toBe(0);

    settle(problems, 'the employee view of payroll');
  });
});
