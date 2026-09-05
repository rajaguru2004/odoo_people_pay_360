import {
  expect,
  request,
  test,
  type APIRequestContext,
} from '@playwright/test';
import { resolve } from 'path';
import { API_URL, STORAGE_DIR } from '../playwright.config';

/**
 * Who releases a payroll run, and who cannot.
 *
 * Loaded by the `admin` project only — approving, rejecting and marking paid
 * are ADMIN on the server too. The officer's half of the claim is asserted here
 * as well, through a second SESSION rather than a second project: the file
 * would not be loaded at all under a name the `payroll` project answers to, and
 * the two claims are one rule with two sides.
 *
 * ## Isolation
 *
 * A run is history nothing deletes, so this spec never touches the seeded runs
 * — approving one of those would move the hub's own figures under the hub spec.
 * It claims free months out of the sandbox window (2022-02 … 2024-12) instead,
 * from the far end of it so it cannot race `payroll.admin-payroll.spec.ts`.
 * Two months are consumed for good per pass; `npm run e2e:db reset` returns the
 * window.
 *
 * Serial, because the lifecycle IS the test: the run rejected in one step is
 * the run recalculated and approved in the next.
 */
test.describe.configure({ mode: 'serial' });

const ADMIN = { email: 'admin@peoplepay360.com', password: 'Admin@123' };

/** Claimed from the end of the window, away from the other writing spec. */
const YEARS = [2024, 2023, 2022];

interface Period {
  month: number;
  year: number;
  start: string;
}

const periodOf = (month: number, year: number): Period => ({
  month,
  year,
  start: `${year}-${String(month).padStart(2, '0')}-01`,
});

async function adminApi(): Promise<APIRequestContext> {
  const anonymous = await request.newContext({ baseURL: API_URL });
  const response = await anonymous.post('/auth/login', { data: ADMIN });
  if (!response.ok()) {
    throw new Error(
      `The seeded admin could not sign in against ${API_URL} (${response.status()}). Is the test API up?`,
    );
  }
  const body = await response.json();
  await anonymous.dispose();
  return request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.data.accessToken}` },
  });
}

/** Months in the sandbox window with no run against them. */
async function claimPeriods(api: APIRequestContext, count: number): Promise<Period[]> {
  const taken = new Set<string>();
  for (const year of YEARS) {
    const response = await api.get(`/payroll-runs?year=${year}&limit=200`);
    expect(response.ok()).toBeTruthy();
    for (const run of (await response.json()).data as Array<{ periodStart: string }>) {
      taken.add(String(run.periodStart).slice(0, 7));
    }
  }

  const free: Period[] = [];
  for (const year of YEARS) {
    for (let month = 12; month >= 2; month -= 1) {
      const period = periodOf(month, year);
      if (!taken.has(period.start.slice(0, 7))) free.push(period);
      if (free.length === count) return free;
    }
  }
  throw new Error(
    'The payroll sandbox window (2022-02 … 2024-12) is full. Run `npm run e2e:db reset`.',
  );
}

/**
 * A run in CALCULATED, built through the real endpoints.
 *
 * The pre-flight refuses a period nobody recorded attendance in, so one
 * ABSENT day is marked first — the same reason `payroll.admin-payroll.spec.ts`
 * marks one. Setting the run up is not what this file is testing; what happens
 * to it afterwards is.
 */
async function calculatedRun(api: APIRequestContext, period: Period): Promise<string> {
  const staff = await api.get('/employees?limit=1');
  const someone = (await staff.json()).data[0].id;
  await api.post('/attendances/bulk', {
    data: {
      date: `${period.start.slice(0, 8)}10`,
      entries: [{ employeeId: someone, status: 'ABSENT' }],
    },
  });

  const created = await api.post('/payroll-runs', {
    data: { month: period.month, year: period.year, notes: 'Opened by the approval e2e spec.' },
  });
  expect(created.status(), `a run for ${period.start} could not be opened`).toBe(201);
  const id: string = (await created.json()).data.id;

  const calculated = await api.post(`/payroll-runs/${id}/calculate`);
  expect(calculated.ok(), 'the run must reach CALCULATED before it can be decided').toBeTruthy();
  return id;
}

let api: APIRequestContext;
/** The run the admin decides on. */
let decisionRunId = '';
/** A second, untouched run — the officer's, so the two never move each other. */
let officerRunId = '';

test.beforeAll(async () => {
  api = await adminApi();
  const [decision, officer] = await claimPeriods(api, 2);
  decisionRunId = await calculatedRun(api, decision);
  officerRunId = await calculatedRun(api, officer);
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('An admin deciding a calculated run', () => {
  test('is offered both decisions', async ({ page }) => {
    await page.goto(`/dashboard/payroll/runs/${decisionRunId}`);

    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'CALCULATED');
    await expect(page.getByTestId('run-approve')).toBeVisible();
    await expect(page.getByTestId('run-reject')).toBeVisible();
  });

  test('cannot send a run back without saying why', async ({ page }) => {
    await page.goto(`/dashboard/payroll/runs/${decisionRunId}`);
    await page.getByTestId('run-reject').click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();

    // The reason is the point of the rejection: it survives the return to
    // DRAFT so whoever picks the run up reads what was wrong. The server 400s
    // without one, so the button refuses rather than sending a request that can
    // only fail.
    await expect(page.getByTestId('reject-confirm')).toBeDisabled();
    await page.getByTestId('reject-reason').fill('   ');
    await expect(page.getByTestId('reject-confirm')).toBeDisabled();

    await page.getByTestId('reject-reason').fill('The overtime hours for the plant are missing.');
    await expect(page.getByTestId('reject-confirm')).toBeEnabled();
  });

  test('sends it back to draft, carrying the reason', async ({ page }) => {
    await page.goto(`/dashboard/payroll/runs/${decisionRunId}`);
    await page.getByTestId('run-reject').click();
    await page
      .getByTestId('reject-reason')
      .fill('The overtime hours for the plant are missing.');
    await page.getByTestId('reject-confirm').click();

    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'DRAFT');
    await expect(page.getByTestId('run-rejection-reason')).toContainText(
      'The overtime hours for the plant are missing.',
    );
    // A draft is nobody's decision to take: the two decision buttons are gone
    // until it has been calculated again.
    await expect(page.getByTestId('run-approve')).toHaveCount(0);
    await expect(page.getByTestId('run-reject')).toHaveCount(0);
  });

  test('approves it once it has been calculated again', async ({ page }) => {
    await page.goto(`/dashboard/payroll/runs/${decisionRunId}`);

    await page.getByTestId('run-calculate').click();
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'CALCULATED', {
      timeout: 60_000,
    });

    await page.getByTestId('run-approve').click();
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'APPROVED');

    // Approved figures are a decision somebody signed, so they can no longer be
    // recalculated — and the next move is payment.
    await expect(page.getByTestId('run-calculate')).toHaveCount(0);
    await expect(page.getByTestId('run-approve')).toHaveCount(0);
    await expect(page.getByTestId('run-mark-paid')).toBeVisible();
  });
});

/**
 * The separation of duties, from the officer's side.
 *
 * A payroll officer holds MANAGE_PAYROLL and deliberately NOT APPROVE_PAYROLL:
 * the person who calculates a run must not be the person who releases it. The
 * session is swapped rather than the project, because a project whose role this
 * filename does not name would never load the file at all.
 */
test.describe('A payroll officer looking at the same kind of run', () => {
  test.use({ storageState: resolve(STORAGE_DIR, 'payroll.json') });

  test('is offered no decision, and can still do their own job', async ({ page }) => {
    await page.goto(`/dashboard/payroll/runs/${officerRunId}`);

    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'CALCULATED');

    // The claim this file exists for.
    await expect(page.getByTestId('run-approve')).toHaveCount(0);
    await expect(page.getByTestId('run-reject')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);

    // MANAGE_PAYROLL is not withdrawn by it: recalculating and cancelling are
    // still theirs.
    await expect(page.getByTestId('run-calculate')).toBeVisible();
    await expect(page.getByTestId('run-cancel')).toBeVisible();
  });

  test('cannot release the money on the run the admin approved', async ({ page }) => {
    // Left APPROVED by the test above, and still awaiting payment — which is
    // exactly the state the claim needs. "Mark paid" belongs to the same
    // permission as Approve, so the officer is offered neither.
    await page.goto(`/dashboard/payroll/runs/${decisionRunId}`);

    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'APPROVED');
    await expect(page.getByTestId('run-mark-paid')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mark paid' })).toHaveCount(0);
  });
});

/**
 * Declared last on purpose: the officer's assertions above need the run in
 * APPROVED, and this is the step that ends it. Serial mode runs the file in
 * declaration order, so "approved, then seen by the officer, then paid" is the
 * order it actually happens in.
 */
test.describe('Paying the approved run', () => {
  test('marks it paid, after which nothing can be undone', async ({ page }) => {
    await page.goto(`/dashboard/payroll/runs/${decisionRunId}`);

    await page.getByTestId('run-mark-paid').click();
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'PAID');

    // Money has moved. There is nothing left to cancel, and the figures are a
    // record rather than a working total.
    await expect(page.getByTestId('run-cancel')).toHaveCount(0);
    await expect(page.getByTestId('run-calculate')).toHaveCount(0);
    await expect(page.getByTestId('run-export')).toBeVisible();
  });
});
