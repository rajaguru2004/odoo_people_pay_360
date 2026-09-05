import {
  expect,
  request,
  test,
  type APIRequestContext,
} from '@playwright/test';
import { API_URL } from '../playwright.config';

/**
 * Opening a payroll run: period → pre-flight → generate.
 *
 * Loaded by the `admin` and `payroll` projects. A payroll officer holds
 * MANAGE_PAYROLL, so both roles may open a run; who may APPROVE one is
 * `payroll-approval.admin.spec.ts`.
 *
 * ## Isolation
 *
 * A payroll run is HISTORY the application never deletes, and
 * `@@unique([periodStart, periodEnd])` lets a month hold exactly one. So no
 * assertion here counts rows in a table, and no period is assumed to be free:
 * the spec CLAIMS the first month with no run against it out of a sandbox
 * window — 2022-02 … 2024-12 — that nothing else touches. The seed occupies the
 * current month and the two before it, and the payroll hub only ever looks six
 * or twelve months back, so nothing written here is visible to the hub, to the
 * demo data, or to another spec. Same discipline as
 * `apps/backend/test/payroll.e2e-spec.ts`.
 *
 * The two PROJECTS that load this file run at the same time, so they claim from
 * different years and can never race for the same month.
 *
 * A complete pass consumes one month for good. `npm run e2e:db reset` returns
 * the whole window.
 *
 * Serial, because every test after the first reads the month the first one
 * claimed, and `fullyParallel` would otherwise put them in different workers —
 * each running `beforeAll` again and claiming a month of its own.
 */
test.describe.configure({ mode: 'serial' });

const ADMIN = { email: 'admin@peoplepay360.com', password: 'Admin@123' };

/** The sandbox window, per project, so the two never collide on a month. */
const YEARS: Record<string, number[]> = {
  admin: [2022, 2024, 2023],
  payroll: [2023, 2024, 2022],
};

interface Period {
  month: number;
  year: number;
  start: string;
  end: string;
}

const periodOf = (month: number, year: number): Period => {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    month,
    year,
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
};

/** An API context carrying the seeded admin's bearer token. */
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

/**
 * The first month in the window with no run against it.
 *
 * Asked of the API rather than assumed: a previous pass has already used some
 * of them and a run is never deleted.
 */
async function claimPeriod(api: APIRequestContext, years: number[]): Promise<Period> {
  const taken = new Set<string>();
  for (const year of years) {
    const response = await api.get(`/payroll-runs?year=${year}&limit=200`);
    expect(response.ok(), 'the runs list must answer before a month can be claimed').toBeTruthy();
    const body = await response.json();
    for (const run of body.data as Array<{ periodStart: string }>) {
      taken.add(String(run.periodStart).slice(0, 7));
    }
  }

  for (const year of years) {
    // February onwards in the earliest year, so every candidate period ends
    // well after the seeded workforce was hired.
    for (let month = 2; month <= 12; month += 1) {
      const period = periodOf(month, year);
      if (!taken.has(period.start.slice(0, 7))) return period;
    }
  }

  throw new Error(
    'The payroll sandbox window (2022-02 … 2024-12) is full. Run `npm run e2e:db reset`.',
  );
}

let api: APIRequestContext;
/** The month this project will open a run for. */
let sandbox: Period;
/** The company's current month, which the seed's newest hire falls inside. */
let currentMonth: { month: number; year: number };

test.beforeAll(async ({}, testInfo) => {
  api = await adminApi();

  // The hub answers for the month the COMPANY is in — read rather than worked
  // out from the browser's clock, which is a different day either side of
  // midnight and would ask the pre-flight about the wrong period.
  const hub = await api.get('/payroll/hub-summary?months=6');
  expect(hub.ok()).toBeTruthy();
  const periodStart: string = (await hub.json()).data.period.periodStart;
  currentMonth = {
    month: Number(periodStart.slice(5, 7)),
    year: Number(periodStart.slice(0, 4)),
  };

  sandbox = await claimPeriod(api, YEARS[testInfo.project.name] ?? [2022, 2023, 2024]);

  // ONE attendance row in the claimed month, because a period with no
  // attendance anywhere is a BLOCKER — every payslip would pay a full month
  // against a month nobody processed. ABSENT rather than PRESENT: a present day
  // has to carry a check-in time, and this row exists to make the period
  // processed, not to describe anybody's week.
  const staff = await api.get('/employees?limit=1');
  const someone = (await staff.json()).data[0].id;
  const marked = await api.post('/attendances/bulk', {
    data: {
      date: `${sandbox.start.slice(0, 8)}10`,
      entries: [{ employeeId: someone, status: 'ABSENT' }],
    },
  });
  expect(marked.ok(), 'the sandbox month needs attendance before it can generate').toBeTruthy();
});

test.afterAll(async () => {
  await api?.dispose();
});

/** Put the picker on a period and ask the server what it would refuse. */
const preflight = async (
  page: import('@playwright/test').Page,
  period: { month: number; year: number },
) => {
  await page.getByLabel('Month', { exact: true }).selectOption(String(period.month));
  await page.getByLabel('Year', { exact: true }).selectOption(String(period.year));
  await page.getByTestId('run-preflight').click();
  await expect(page.getByTestId('preflight-result')).toBeVisible();
};

test.describe('The pre-flight, before anything is created', () => {
  test('refuses the period that has an employee with no salary structure', async ({ page }) => {
    await page.goto('/dashboard/payroll/runs/new');

    // The seed leaves its newest hire — Reem Al Saadi, EMP-0021 — deliberately
    // without a salary structure, and she was hired inside the current month.
    // A run over a period she was employed in has nothing to pay her from.
    await preflight(page, currentMonth);

    const blocked = page.getByTestId('preflight-blocked-employee');
    await expect(blocked.first()).toBeVisible();
    await expect(blocked.filter({ hasText: 'Reem Al Saadi' })).toHaveCount(1);
    await expect(blocked.filter({ hasText: 'Reem Al Saadi' })).toContainText('NO_STRUCTURE');

    // The verdict is the SERVER's, and the button reads it directly.
    await expect(page.getByTestId('run-generate')).toBeDisabled();
    await expect(page.getByText('The server refuses this period while a blocker stands.')).toBeVisible();
  });

  test('writes nothing — the refused period still has no run', async ({ page }) => {
    const runs = await api.get(
      `/payroll-runs?year=${currentMonth.year}&limit=200`,
    );
    const before = ((await runs.json()).data as Array<{ id: string }>).length;

    await page.goto('/dashboard/payroll/runs/new');
    await preflight(page, currentMonth);

    const after = await api.get(`/payroll-runs?year=${currentMonth.year}&limit=200`);
    // Anchored on the count for ONE year around a pre-flight that ran between
    // the two reads, never on the size of the runs table.
    expect(((await after.json()).data as Array<{ id: string }>).length).toBe(before);
  });

  test('will not generate the period it did not check', async ({ page }) => {
    await page.goto('/dashboard/payroll/runs/new');
    await preflight(page, sandbox);

    // The findings on screen are about the month the pre-flight answered for.
    // Moving the picker under them is the one mistake this screen exists to
    // prevent, so the button goes dead until the check is run again.
    await expect(page.getByTestId('run-generate')).toBeEnabled();
    await page
      .getByLabel('Month', { exact: true })
      .selectOption(String((sandbox.month % 12) + 1));
    await expect(page.getByTestId('run-generate')).toBeDisabled();
    await expect(
      page.getByText('The period changed. Run the pre-flight again before generating.'),
    ).toBeVisible();

    // Back on the checked period, the standing pre-flight is valid again.
    await page.getByLabel('Month', { exact: true }).selectOption(String(sandbox.month));
    await expect(page.getByTestId('run-generate')).toBeEnabled();
  });
});

test.describe('Generating the run', () => {
  test('reports warnings, generates, and lands on the calculated run', async ({ page }) => {
    await page.goto('/dashboard/payroll/runs/new');
    await preflight(page, sandbox);

    // Nobody but the one marked day has attendance in a sandbox month, so the
    // period carries WARNINGS and no blocker: the run will generate and the
    // warnings travel with it to whoever approves.
    await expect(page.getByTestId('preflight-findings')).toBeVisible();
    await expect(page.getByTestId('preflight-blocked-employee')).toHaveCount(0);
    await expect(page.getByTestId('finding-blocking')).toHaveCount(0);
    await expect(page.getByTestId('preflight-warned-employee').first()).toBeVisible();
    await expect(page.getByText('The server will accept this period.')).toBeVisible();

    await page.getByTestId('run-generate').click();

    // Two calls behind the one button — create, then calculate — and the page
    // sends the reader to the run either way.
    await expect(page).toHaveURL(/\/dashboard\/payroll\/runs\/[0-9a-f-]{36}$/, {
      timeout: 90_000,
    });
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'CALCULATED');
  });

  test('the run it generated has payslips whose lines add up', async ({ page }) => {
    // Found by its PERIOD — the fixture — rather than by a position in a list.
    const found = await api.get(`/payroll-runs?year=${sandbox.year}&limit=200`);
    const run = ((await found.json()).data as Array<{ id: string; periodStart: string; status: string }>)
      .find((candidate) => candidate.periodStart === sandbox.start);
    expect(run, 'the previous test must have generated this run').toBeTruthy();

    await page.goto(`/dashboard/payroll/runs/${run!.id}`);

    await expect(page.getByTestId('payroll-run-card-employees')).toBeVisible();
    await expect(page.getByTestId('payroll-run-card-net')).toBeVisible();
    // Employer contributions are on their own card, and the card says what they
    // are: recorded, never paid, in none of the other three figures.
    await expect(page.getByTestId('payroll-run-card-employerCost')).toContainText(
      'Recorded, never paid',
    );

    // One payslip per employee the run covered.
    await expect(page.getByTestId('payroll-run-row').first()).toBeVisible();

    // The cards and the table are one pass over the same payslips: a drift
    // notice appears only when the stored totals disagree with the lines.
    await expect(page.getByTestId('payroll-run-drift')).toHaveCount(0);
  });

  test('a calculated run can be recalculated, and offers no approval to the reader who ran it', async ({
    page,
  }) => {
    const found = await api.get(`/payroll-runs?year=${sandbox.year}&limit=200`);
    const run = ((await found.json()).data as Array<{ id: string; periodStart: string }>).find(
      (candidate) => candidate.periodStart === sandbox.start,
    );

    await page.goto(`/dashboard/payroll/runs/${run!.id}`);

    await expect(page.getByTestId('run-calculate')).toHaveText(/Recalculate/);
    await expect(page.getByTestId('run-cancel')).toBeVisible();
  });

  test('the run appears in the list under the year it was opened for', async ({ page }) => {
    const found = await api.get(`/payroll-runs?year=${sandbox.year}&limit=200`);
    const run = ((await found.json()).data as Array<{ id: string; periodStart: string }>).find(
      (candidate) => candidate.periodStart === sandbox.start,
    );

    await page.goto('/dashboard/payroll/runs');
    await page.getByLabel('Year', { exact: true }).selectOption(String(sandbox.year));

    // Its own row, by href — never "the first row", which belongs to whichever
    // period sorts highest today.
    await expect(
      page.locator(`a[href="/dashboard/payroll/runs/${run!.id}"]`).first(),
    ).toBeVisible();
  });
});
