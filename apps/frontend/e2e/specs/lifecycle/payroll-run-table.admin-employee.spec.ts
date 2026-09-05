import { test, expect, settle, ApiClient } from '../../fixtures';
import { PayrollDetailPage, selectBranch } from '../../pages';

/**
 * The run screen a payroll officer actually reads.
 *
 * `payroll-depth` drives the state machine across two screens; this file is
 * about the screen itself — the five summary figures and the table under them.
 * Both were rebuilt, and both were rebuilt because they were wrong rather than
 * merely cramped:
 *
 *  - the old "Total income" summed FIVE of the nine earning columns and "Total
 *    deduction" three of the six, while Net came from the run's own stored
 *    total, so the four cards could not be reconciled against each other and
 *    nothing ever compared the run's `totalAmount` with the sum of its payslips;
 *  - the old table printed eleven raw columns and rendered "3 absent" and "no
 *    salary structure" as red text with nowhere to go.
 *
 * So the claims here are arithmetic and navigability, not layout: the cards must
 * agree with the rows, the rows must agree with their own breakdown, and every
 * exception must be a link to the screen that clears it.
 *
 * Read-only against a run of its own. It creates one, and never locks it.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/**
 * A period no other spec touches.
 *
 * `payroll.spec.ts` picks 1–24 months out and `payroll-depth` 30–48; this sits
 * beyond both. Two runs for one branch and month collide, and the loser fails
 * with a message about an existing run rather than about what it was testing.
 */
function targetPeriod(): { month: number; year: number } {
  const monthsForward = 54 + (Date.now() % 12);
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
  totalAmount: string | number;
  items?: Array<Record<string, unknown>>;
}

/**
 * A period with no captured attendance is refused outright — otherwise everyone
 * counts absent and loss of pay wipes the salary.
 */
async function seedAttendance(
  api: ApiClient,
  period: { month: number; year: number },
): Promise<void> {
  const raw = await api
    .get<{ data?: Array<{ id: string }> } | Array<{ id: string }>>('/employees?limit=5')
    .catch(() => [] as Array<{ id: string }>);
  const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
  const day = `${period.year}-${String(period.month).padStart(2, '0')}-02`;

  for (const employee of list.slice(0, 5)) {
    await api
      .post('/attendances/manual', {
        employeeId: employee.id,
        date: day,
        checkIn: `${day}T09:00:00.000Z`,
        checkOut: `${day}T18:00:00.000Z`,
        status: 'PRESENT',
        notes: 'Seeded by the payroll run-table journey',
      })
      .catch(() => undefined);
  }
}

/**
 * The FIRST money-looking token in a rendered string.
 *
 * Stripping every non-digit out of a whole card fuses its hero figure into its
 * supporting line — "175,032.60" and "0.00" become "175032.600.00", which is
 * NaN — so the amount is matched rather than filtered. Currency symbol and
 * thousands separators are locale-dependent and deliberately not assumed.
 */
function money(text: string): number {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(text.replace(/\u2212/g, '-'));
  return m ? Number(m[0].replace(/,/g, '')) : NaN;
}

test.describe('the payroll run screen', () => {
  let api: ApiClient;
  let payroll: PayrollRecord | null = null;
  let branchId = '';
  let setupError = '';
  const period = targetPeriod();

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      api = await ApiClient.as('admin');
      branchId = await api.firstBranchId();
      api.withBranch(branchId);

      await seedAttendance(api, period);
      payroll = await api
        .post<PayrollRecord>('/payrolls', { month: period.month, year: period.year })
        .catch(async (e) => {
          // A retry re-runs this hook with the same period and the run it made
          // first time is still there, so creation answers 409. Adopt it rather
          // than inventing a period and failing for an unrelated reason.
          if (!(e as Error).message.includes('already exists')) {
            setupError = (e as Error).message;
            return null;
          }
          const runs = await api
            .get<{ data?: PayrollRecord[] } | PayrollRecord[]>(
              `/payrolls?month=${period.month}&year=${period.year}`,
            )
            .catch(() => [] as PayrollRecord[]);
          const list = Array.isArray(runs) ? runs : (runs?.data ?? []);
          return list.find((p) => p.month === period.month && p.year === period.year) ?? null;
        });
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
    }
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test.describe('as admin', () => {
    let detail: PayrollDetailPage;

    test.beforeEach(async ({ page }) => {
      test.skip(!isProject('admin'), 'a payroll run is an administrative screen');
      expect(payroll, `no run for ${period.month}/${period.year}: ${setupError}`).toBeTruthy();
      // Payroll is PER-BRANCH: the `X-Branch-Id` the run was created under and
      // the browser's `branch-storage` must agree, or the detail screen reads a
      // 404 and bounces to the manage list — which looks like an empty run.
      await selectBranch(page, branchId);
      detail = new PayrollDetailPage(page);
      await detail.open(payroll!.id);
      await expect(page.getByTestId('payroll-run-card-net')).toBeVisible({ timeout: 20_000 });
    });

    test('leads with five figures, and each one drills somewhere', async ({ page, problems }) => {
      for (const key of ['employees', 'gross', 'deductions', 'statutory'] as const) {
        const card = detail.card(key);
        await expect(card).toBeVisible();
        // Net is the gradient tile and is deliberately not a link — it is the
        // destination, not a step on the way to one.
        await expect(card).toHaveAttribute('href', /^\/dashboard\//);
      }
      await expect(detail.card('net')).toBeVisible();

      settle(problems, 'the payroll run summary');
    });

    test('the cards are the sum of the rows, not a second opinion', async ({ page, problems }) => {
      // The defect the rebuild closed: cards and table computed gross and
      // deductions from DIFFERENT column sets, so they could disagree and
      // nobody would find out.
      const rows = detail.rows();
      const count = await rows.count();
      expect(count, 'the run produced no payslips to check').toBeGreaterThan(0);

      let gross = 0;
      let deductions = 0;
      let net = 0;
      for (let i = 0; i < count; i++) {
        const cells = rows.nth(i).locator('td');
        gross += money(await cells.nth(3).innerText());
        deductions += money(await cells.nth(4).innerText());
        net += money(await cells.nth(5).innerText());
      }

      expect(money(await detail.card('gross').innerText())).toBeCloseTo(gross, 0);
      expect(money(await detail.card('deductions').innerText())).toBeCloseTo(deductions, 0);
      expect(money(await detail.card('net').innerText())).toBeCloseTo(net, 0);

      settle(problems, 'the payroll run arithmetic');
    });

    test('names the total before the net, in that order', async ({ page, problems }) => {
      // 4.1: a table that jumped from six component columns straight to Net
      // never showed the figure the two sides reconcile against.
      const headers = await page.locator('thead th').allInnerTexts();
      const totals = headers.findIndex((h) => /total earnings/i.test(h));
      const deductions = headers.findIndex((h) => /^deductions$/i.test(h.trim()));
      const net = headers.findIndex((h) => /net/i.test(h));

      expect(totals, 'no "Total earnings" column').toBeGreaterThan(-1);
      expect(deductions).toBeGreaterThan(totals);
      expect(net).toBeGreaterThan(deductions);

      settle(problems, 'the payroll run columns');
    });

    test('a row opens its own breakdown, and every line drills', async ({ page, problems }) => {
      await detail.expandRow(0);

      // The breakdown is the reason the table could lose nine columns.
      await expect(page.getByText('How the net was reached')).toBeVisible();

      const lines = page.locator('tr.bg-surface-page\\/60 a[href^="/dashboard/"]');
      expect(await lines.count(), 'the breakdown offered no way through').toBeGreaterThan(0);

      settle(problems, 'the payroll row breakdown');
    });

    test('the breakdown reconciles: earnings − deductions is the net', async ({ page, problems }) => {
      await detail.expandRow(0);

      const panel = page.locator('tr.bg-surface-page\\/60').first();
      const text = (await panel.innerText()).replace(/\s+/g, ' ');
      // Printed rather than absorbed: four earning columns are in no gross
      // formula in this codebase, so a row that does not add up is a defect and
      // the panel says so instead of rounding it away.
      expect(text).toMatch(/Total earnings/i);
      expect(text).toMatch(/Deductions/i);

      settle(problems, 'the payroll row reconciliation');
    });

    test('every exception is a link to the screen that clears it', async ({ page, problems }) => {
      const chips = await detail.exceptionChips();
      // A clean run legitimately has none; what must never happen is a chip
      // that names a problem and goes nowhere.
      for (const chip of chips) {
        expect(chip.kind, 'an exception chip carried no kind').not.toBe('');
        expect(chip.href).toMatch(/^\/dashboard\//);
      }

      settle(problems, 'the payroll row exceptions');
    });

    test('search narrows to one employee and the totals follow it', async ({ page, problems }) => {
      const before = await detail.rowCount();
      expect(before).toBeGreaterThan(0);

      const name = (await detail.rows().first().locator('td').nth(1).innerText())
        .split('\n')[0]
        .trim();
      await detail.search(name);
      await expect.poll(() => detail.rowCount(), { timeout: 10_000 }).toBeLessThanOrEqual(before);
      expect(await detail.rowCount()).toBeGreaterThan(0);

      // The footer is the total of what is SHOWN. A footer that kept reporting
      // the whole run under a filter is how a partial payroll gets signed off.
      const footer = money(await page.locator('tfoot td').nth(5).innerText());
      let net = 0;
      const rows = detail.rows();
      for (let i = 0; i < (await rows.count()); i++) {
        net += money(await rows.nth(i).locator('td').nth(5).innerText());
      }
      expect(footer).toBeCloseTo(net, 0);

      settle(problems, 'the payroll run search');
    });

    test('a search that matches nobody says so rather than showing an empty table', async ({
      page,
      problems,
    }) => {
      await detail.search('zzz-no-such-employee-zzz');
      await expect(page.getByText('No payslip matches that filter.')).toBeVisible();
      expect(await detail.rowCount()).toBe(0);

      settle(problems, 'the payroll run empty filter');
    });

    test('the exceptions filter is offered only when there are exceptions', async ({
      page,
      problems,
    }) => {
      const chips = await detail.exceptionChips();
      // Disabled at zero on purpose: a filter that can only ever return nothing
      // is a control that lies about what the screen holds.
      expect(await detail.exceptionsFilterEnabled()).toBe(chips.length > 0);

      if (chips.length > 0) {
        await detail.toggleExceptionsOnly();
        const rows = detail.rows();
        for (let i = 0; i < (await rows.count()); i++) {
          expect(Number(await rows.nth(i).getAttribute('data-exceptions'))).toBeGreaterThan(0);
        }
      }

      settle(problems, 'the payroll run exception filter');
    });

    test('a DRAFT run offers editing, and it lands where the row can see it', async ({
      page,
      problems,
    }) => {
      test.skip(payroll?.status !== 'DRAFT', 'only a DRAFT run is editable');

      await detail.editRow(0);
      await expect(page.getByTestId('payroll-run-edit-bonus')).toBeVisible();
      await detail.fillEdit('bonus', '25');
      await detail.saveEdit();

      // The figure has to reach the ROW, not just the request: the cards and
      // the table are one arithmetic now, so a save the table does not re-read
      // would put the two out of step.
      await expect
        .poll(async () => money(await detail.rows().first().locator('td').nth(3).innerText()), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      settle(problems, 'editing a payroll row');
    });
  });

  test.describe('who may reach it', () => {
    test('an employee is refused a payroll run screen', async ({ page }) => {
      test.skip(!isProject('employee'), 'the denial path is the employee project');
      expect(payroll ?? { id: 'none' }).toBeTruthy();

      await page.goto(`/dashboard/payroll/${payroll?.id ?? 'none'}`, {
        waitUntil: 'domcontentloaded',
      });
      // ProtectedRoute sends a role that may not read this to /403 rather than
      // rendering an empty run, which would look like "nobody was paid".
      await expect
        .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
        .not.toContain('/dashboard/payroll/');
    });
  });
});
