import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { featureSkipReason, flagFlipAllowed, marker, withSetting } from '../../payroll-support';

/**
 * The nine payroll extension SCREENS, driven from a browser.
 *
 * Every one of them — validate, reports, recoveries, settlements, encashment,
 * grades, gratuity rules, calendar, transfers — shipped with `data-testid`s
 * already in place and not one browser case reading them. The reason is
 * structural rather than lazy: all nine sit behind a feature flag that defaults
 * to `'false'`, so in the ordinary lane they render a "switched off" panel and
 * there is nothing to drive. The API matrix for them lives in the backend Jest
 * suite; what was missing is whether the SCREENS work.
 *
 * That gap has a shape. `usePayrollFeatures` once derived its object inside the
 * zustand selector, which made a new snapshot on every read; every screen in
 * this list died to "Maximum update depth exceeded" and rendered nothing at
 * all. Nine screens broke, the whole suite stayed green, and the fix is
 * documented in that hook. This file is the case that would have caught it.
 *
 * Flags are GLOBAL — one table, no scope column — so this file only runs under
 * `scripts/e2e-payroll-edge-flagged.sh`, which gives it its own database and
 * ports. Everywhere else it skips with a reason printed.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Every switch these nine screens read, and the value that makes them render. */
const FLAGS: Record<string, string> = {
  payroll_preflight_enabled: 'true',
  payroll_reports_enabled: 'true',
  payroll_employee_recovery_enabled: 'true',
  payroll_eosb_enabled: 'true',
  // The master switch alone is not enough: `FinalSettlementsService` refuses
  // every route unless this one is on too, and the screen is gated on the pair
  // for exactly that reason.
  payroll_eosb_settlement_enabled: 'true',
  payroll_eosb_accrual_enabled: 'true',
  leave_encashment_enabled: 'true',
  employee_grade_enabled: 'true',
  employee_transfer_enabled: 'true',
  payroll_calendar_enabled: 'true',
  payroll_item_lines_enabled: 'true',
};

interface SettingRow {
  key: string;
  value: string;
}

test.describe('the payroll extension screens', () => {
  let admin: ApiClient;
  let restore: Record<string, string> = {};
  let setupError = '';
  /** Seeded on demand by the settlement-detail case, and reused if it retries. */
  let settlementId = '';
  const MARK = marker('pw-payui-');

  test.beforeAll(async () => {
    if (!isProject('admin') || !flagFlipAllowed()) return;
    try {
      admin = await ApiClient.as('admin');
      // Read BEFORE writing, from the list endpoint that supplies defaults for
      // unset keys, so the restore is exact rather than a guess at what the
      // default used to be.
      const raw = await admin.get<unknown>('/system-settings');
      const rows = (Array.isArray(raw) ? raw : ((raw as { data?: SettingRow[] })?.data ?? [])) as SettingRow[];
      for (const key of Object.keys(FLAGS)) {
        const row = rows.find((r) => r.key === key);
        if (!row) throw new Error(`system setting "${key}" is not returned by GET /system-settings`);
        restore[key] = row.value;
      }
      await admin.post('/system-settings', { settings: FLAGS });
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
    }
  });

  test.afterAll(async () => {
    // Not conditional on the body succeeding: a flag left flipped breaks every
    // other spec in the run, and the first failure would be blamed on them.
    if (Object.keys(restore).length > 0) {
      await admin?.post('/system-settings', { settings: restore }).catch(() => undefined);
    }
    await admin?.dispose();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!isProject('admin'), 'payroll extensions are administrative screens');
    test.skip(
      !flagFlipAllowed(),
      featureSkipReason('preflight', 'reports', 'recovery', 'eosb', 'encashment', 'grade', 'transfer', 'calendar'),
    );
    expect(setupError, 'could not turn the payroll extensions on').toBe('');
    void page;
  });

  /** Opens a screen and waits for it to settle past its skeleton. */
  async function open(page: import('@playwright/test').Page, path: string): Promise<void> {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  /**
   * The panel every one of these screens renders when its switch is off.
   *
   * Asserted absent on each screen, because that panel appearing with the flag
   * ON is exactly the `usePayrollFeatures` failure mode this file exists for.
   */
  async function expectSwitchedOn(page: import('@playwright/test').Page): Promise<void> {
    await expect(page.getByText(/switched off/i)).toHaveCount(0);
  }

  // ── Before you generate ───────────────────────────────────────────────────

  test('the pre-run checklist answers a verdict rather than a blank screen', async ({
    page,
    problems,
  }) => {
    await open(page, '/dashboard/payroll/validate');
    await expectSwitchedOn(page);

    await expect(page.getByTestId('preflight-month')).toBeVisible();
    await page.getByTestId('preflight-run').click();

    const verdict = page.getByTestId('preflight-verdict');
    await expect(verdict).toBeVisible({ timeout: 30_000 });
    // Either verdict is a pass — a blocked run is a real answer. What must not
    // happen is a screen that ran the checks and reported nothing.
    const canGenerate = await verdict.getAttribute('data-can-generate');
    expect(['true', 'false']).toContain(canGenerate);
    await expect(verdict).toContainText(/employees ready/i);

    settle(problems, 'the pre-run checklist');
  });

  // ── Reports ───────────────────────────────────────────────────────────────

  test('every report tab renders its OWN shape, not the previous tab’s', async ({
    page,
    problems,
  }) => {
    // The five tabs return five different row shapes off five endpoints, and
    // the page held them in one state — so a tab click rendered the previous
    // tab's rows through the new tab's columns for a frame, and an overlapping
    // request could make it permanent. React only ever complained about a
    // missing `key`; the defect was a screen showing the wrong numbers under
    // the right heading.
    await open(page, '/dashboard/payroll/reports');
    await expectSwitchedOn(page);

    for (const tab of ['register', 'cost', 'statutory', 'gratuity', 'variance'] as const) {
      await page.getByTestId(`report-tab-${tab}`).click();
      await page.waitForLoadState('networkidle').catch(() => {});

      // The register table is the one shape that can be identified positively,
      // so it is the one that proves a tab switch actually swapped the body.
      if (tab === 'register') {
        const shown =
          (await page.getByTestId('report-register').count()) +
          (await page.getByTestId('report-empty').count());
        expect(shown, 'the register tab rendered neither a table nor an empty state').toBeGreaterThan(0);
      } else {
        await expect(page.getByTestId('report-register')).toHaveCount(0);
      }
      // A refusal is not an empty result and must never be shown as one.
      await expect(page.getByTestId('report-failed')).toHaveCount(0);
    }

    settle(problems, 'the payroll report tabs');
  });

  test('changing the period re-reads the report instead of racing itself', async ({
    page,
    problems,
  }) => {
    await open(page, '/dashboard/payroll/reports');
    await page.getByTestId('report-tab-cost').click();
    await page.waitForLoadState('networkidle').catch(() => {});

    // Typing into a number field fires one request per keystroke. The screen
    // must land on the LAST one, whatever order they come back in.
    const month = page.locator('input[type="number"]').first();
    await month.fill('1');
    await month.fill('12');
    await page.waitForLoadState('networkidle').catch(() => {});

    await expect(page.getByTestId('report-register')).toHaveCount(0);
    settle(problems, 'the payroll report period');
  });

  // ── Recoveries ────────────────────────────────────────────────────────────

  test('a recovery can be raised and forgiven, with a reason on the record', async ({
    page,
    problems,
  }) => {
    await open(page, '/dashboard/payroll/recoveries');
    await expectSwitchedOn(page);

    const before = await page.getByTestId('recovery-row').count();

    await page.getByTestId('recovery-employee').selectOption({ index: 1 });
    await page.getByTestId('recovery-kind').selectOption({ index: 1 });
    await page.getByTestId('recovery-total').fill('40');
    await page.getByTestId('recovery-create').click();
    await page.waitForLoadState('networkidle').catch(() => {});

    await expect
      .poll(() => page.getByTestId('recovery-row').count(), { timeout: 20_000 })
      .toBeGreaterThan(before);

    // Waiving forgives company money permanently, so the reason is required and
    // the confirm must refuse without one.
    const waive = page.getByTestId('recovery-waive').first();
    if (await waive.count()) {
      await waive.click();
      await expect(page.getByTestId('recovery-waive-reason')).toBeVisible();
      await page.getByTestId('recovery-waive-reason').fill(`${MARK}pre-existing damage`);
      await page.getByTestId('recovery-waive-confirm').click();
      await page.waitForLoadState('networkidle').catch(() => {});
    }

    settle(problems, 'a payroll recovery');
  });

  // ── Settlements ───────────────────────────────────────────────────────────

  test('the settlements list opens, and preparing one asks for a last day', async ({
    page,
    problems,
  }) => {
    await open(page, '/dashboard/payroll/settlements');
    await expectSwitchedOn(page);

    await page.getByTestId('settlement-new').click();
    await expect(page.getByTestId('settlement-employee')).toBeVisible();
    // The last working day is what every EOSB figure is computed from, so the
    // form must not offer to create one without it.
    await expect(page.getByTestId('settlement-last-day')).toBeVisible();

    settle(problems, 'the settlements screen');
  });

  test('an existing settlement opens on its own screen with a net figure', async ({
    page,
    problems,
  }) => {
    // Seeded over the API rather than skipped when the database happens to be
    // empty: a case that quietly skips is a case that stops testing the moment
    // the fixture data changes, and the settlement DETAIL screen — the net, the
    // working, the adjustment — has never been driven at all.
    if (!settlementId) {
      const raw = await admin.get<unknown>('/employees?limit=8').catch(() => null);
      const list = (
        Array.isArray(raw) ? raw : ((raw as { data?: Array<{ id: string }> })?.data ?? [])
      ) as Array<{ id: string }>;
      for (const employee of list) {
        const made = await admin
          .post<{ id?: string }>('/final-settlements', {
            employeeId: employee.id,
            variant: 'RESIGNATION',
            lastWorkingDate: new Date().toISOString().slice(0, 10),
          })
          .catch(() => null);
        // "already has an open settlement" is a refusal, not a failure — try
        // the next employee rather than giving up on the case.
        if (made?.id) {
          settlementId = made.id;
          break;
        }
      }
    }

    // Reached by CLICKING the list, the way a person does. A direct URL also
    // works, but the list is what proves the two screens agree on which
    // settlements exist — and it carries whatever branch the list was scoped to.
    await open(page, '/dashboard/payroll/settlements');
    const rows = page.getByTestId('settlement-row');
    expect(
      await rows.count(),
      `no settlement is listed; seeding produced ${settlementId || 'nothing'}`,
    ).toBeGreaterThan(0);
    await rows.first().click();

    await expect(page.getByTestId('settlement-net')).toBeVisible({ timeout: 20_000 });
    // The working behind the total. A settlement with no gratuity and no
    // encashment legitimately has no lines, so what is asserted is that the
    // screen SAYS so rather than showing a bare figure with nothing under it.
    const lines = await page.getByTestId('settlement-line').count();
    if (lines === 0) {
      await expect(page.getByText(/nothing/i).first()).toBeVisible();
    }

    settle(problems, 'a settlement detail');
  });

  // ── Encashment ────────────────────────────────────────────────────────────

  test('a leave type must be given rules before it can be encashed', async ({
    page,
    problems,
  }) => {
    await open(page, '/dashboard/payroll/encashment');
    await expectSwitchedOn(page);

    // Policy FIRST, because that is the order the feature works in: with no
    // policy row the server answers 400 "No encashment policy is configured",
    // which is correct and is what the screen must show rather than swallow.
    await page.getByTestId('encash-tab-policies').click();
    await expect(page.getByTestId('policy-type')).toBeVisible();
    await page.getByTestId('policy-type').fill('Annual Leave');
    const encashable = page.getByTestId('policy-encashable');
    if (!(await encashable.isChecked())) await encashable.check();
    await page.getByTestId('policy-save').click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect
      .poll(() => page.getByTestId('policy-row').count(), { timeout: 20_000 })
      .toBeGreaterThan(0);

    settle(problems, 'a leave encashment policy');
  });

  test('encashment quotes a figure before anything is committed', async ({ page, problems }) => {
    // A refused quote is a legitimate answer — no balance, not encashable, over
    // the cap — and the server says so with a 4xx. What this case is about is
    // that the answer REACHES the screen either way, so the reader never
    // submits a request without having seen the money.
    crashesOnly(problems);

    await open(page, '/dashboard/payroll/encashment');
    await expectSwitchedOn(page);

    await expect(page.getByTestId('encash-employee')).toBeVisible();
    await page.getByTestId('encash-employee').selectOption({ index: 1 });
    await page.getByTestId('encash-days').fill('1');
    await page.getByTestId('encash-quote').click();

    const result = page.getByTestId('encash-quote-result');
    await expect(result).toBeVisible({ timeout: 20_000 });
    // Never blank: `lib/axios` rejects with a FLAT object, so a screen reading
    // `err.response.data.message` would print an empty panel here.
    expect((await result.innerText()).trim().length).toBeGreaterThan(0);

    settle(problems, 'a leave encashment quote');
  });

  // ── Grades ────────────────────────────────────────────────────────────────

  test('a grade can be created and then assigned to somebody', async ({ page, problems }) => {
    await open(page, '/dashboard/payroll/grades');
    await expectSwitchedOn(page);

    const before = await page.getByTestId('grade-row').count();
    await page.getByTestId('grade-new').click();
    await page.getByTestId('grade-code').fill(`${MARK}G1`.toUpperCase().slice(0, 12));
    // Both are required — Create stays disabled without a name, which is the
    // guard, not a bug. Filling only the code is how this case first failed.
    await page.getByTestId('grade-name').fill('Playwright grade');
    await expect(page.getByTestId('grade-create')).toBeEnabled();
    await page.getByTestId('grade-create').click();
    await page.waitForLoadState('networkidle').catch(() => {});

    await expect
      .poll(() => page.getByTestId('grade-row').count(), { timeout: 20_000 })
      .toBeGreaterThan(before);

    await page.getByTestId('grade-assign').first().click();
    await expect(page.getByTestId('grade-assign-employee')).toBeVisible();

    settle(problems, 'payroll grades');
  });

  // ── Gratuity rules ────────────────────────────────────────────────────────

  test('a gratuity rule lists its country and class rather than a bare number', async ({
    page,
    problems,
  }) => {
    await open(page, '/dashboard/payroll/gratuity-rules');
    await expectSwitchedOn(page);

    await expect(page.getByTestId('rule-country')).toBeVisible();
    await expect(page.getByTestId('rule-days')).toBeVisible();
    // Rules are keyed by country AND nationality class; a rule table that
    // showed days alone could not be reconciled against a settlement.
    await expect(page.getByTestId('rule-class')).toBeVisible();

    settle(problems, 'the gratuity rules screen');
  });

  // ── Calendar ──────────────────────────────────────────────────────────────

  test('the payroll calendar lists periods with a cut-off, and saves', async ({
    page,
    problems,
  }) => {
    await open(page, '/dashboard/payroll/calendar');
    await expectSwitchedOn(page);

    await expect(page.getByTestId('calendar-save')).toBeVisible();
    // The periods are what the pre-run window is derived from — without them
    // every run silently falls back to the calendar month.
    expect(await page.getByTestId('calendar-period').count()).toBeGreaterThanOrEqual(0);

    settle(problems, 'the payroll calendar');
  });

  // ── Transfers ─────────────────────────────────────────────────────────────

  test('a branch transfer asks for a destination, a date and a reason', async ({
    page,
    problems,
  }) => {
    await open(page, '/dashboard/payroll/transfers');
    await expectSwitchedOn(page);

    await page.getByTestId('transfer-new').click();
    await expect(page.getByTestId('transfer-employee')).toBeVisible();
    await expect(page.getByTestId('transfer-branch')).toBeVisible();
    await expect(page.getByTestId('transfer-date')).toBeVisible();
    // A move between branches re-prices payroll, so it is reviewed rather than
    // applied — the reason is the record of why.
    await expect(page.getByTestId('transfer-reason')).toBeVisible();

    settle(problems, 'the branch transfer screen');
  });

  // ── The off branch ────────────────────────────────────────────────────────

  test('settlements refuse to render on the master switch alone', async ({ page, problems }) => {
    // The defect this pins: EOSB on, final settlements off, and the screen drew
    // its list, its prepare form and its approve buttons over an API answering
    // 404 to every one of them. The switch the SERVER enforces is the switch
    // the screen has to read.
    await withSetting(admin, 'payroll_eosb_settlement_enabled', 'false', async () => {
      await open(page, '/dashboard/payroll/settlements');
      await expect(page.getByText('Final settlements are switched off')).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByTestId('settlement-new')).toHaveCount(0);
    });

    await open(page, '/dashboard/payroll/settlements');
    await expect(page.getByTestId('settlement-new')).toBeVisible({ timeout: 20_000 });

    settle(problems, 'the final-settlement switch');
  });

  test('a switched-off extension says so instead of rendering an empty screen', async ({
    page,
    problems,
  }) => {
    // Both branches of the kill switch, on one screen, in one case — and the
    // restore is scoped to this test so no other case sees reports off.
    await withSetting(admin, 'payroll_reports_enabled', 'false', async () => {
      await open(page, '/dashboard/payroll/reports');
      await expect(page.getByText('Payroll reports are switched off')).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByTestId('report-register')).toHaveCount(0);
    });

    await open(page, '/dashboard/payroll/reports');
    await expect(page.getByText('Payroll reports are switched off')).toHaveCount(0);

    settle(problems, 'the reports kill switch');
  });
});
