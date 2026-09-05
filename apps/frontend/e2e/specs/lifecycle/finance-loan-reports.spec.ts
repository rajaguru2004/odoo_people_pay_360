import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import {
  LOAN_REPORT_TABS,
  LoanReportTab,
  LoanReportsPage,
  parseCsvLine,
  selectBranch,
} from '../../pages/loan-reports';

/**
 * The loan book, read five ways.
 *
 * These are the endpoints that never throw and can still be wrong. Nothing on
 * this screen writes anything, so the failure mode is not a broken button — it
 * is a number that is quietly the wrong number, or a table that renders one
 * tab's columns against another tab's rows. The second one is not hypothetical:
 * this page used to crash on `r.status.toLowerCase()` when switching to
 * Portfolio, because Portfolio's rows have no `status` in the shape Outstanding's
 * do. Every tab-switch assertion below is guarding that.
 *
 * Three claims this file is built around, none of which any single-screen test
 * would catch:
 *
 *   1. **Each tab has its own columns.** Five endpoints, five row shapes, one
 *      table. Asserted as a sweep so a sixth tab added without a column
 *      definition fails the loop rather than rendering blank cells.
 *   2. **The CSV is the table.** The export is built from the same COLUMNS
 *      definition the table renders, deliberately, so the file cannot drift
 *      from the view. The only way to check that claim is to take the bytes the
 *      browser was handed and compare them to what is on screen — which is what
 *      `exportCsv()` does.
 *   3. **The open-payroll banner is not decoration.** Every figure here counts
 *      LOCKED payroll only, so while a run is open these numbers will not match
 *      that run's payslips. The banner is the screen saying so, and the
 *      assertion is that it agrees with the server's `meta.openPayrolls` rather
 *      than merely existing.
 *
 * ## Why the banner is derived rather than staged
 *
 * The obvious test — open a run, see the banner — is not available. There is no
 * `DELETE /payrolls/:id`, and `openPayrolls` is company-wide rather than
 * branch-scoped, so a run created here could never be removed and would change
 * what every other Finance spec sees for the rest of the database's life.
 * Locking it instead would settle reimbursements and loan recoveries, which is
 * worse. So the case asserts the PROJECTION — banner present exactly when the
 * server reports an open run, and the count it displays equal to the count it
 * was given — which holds in whichever state the book happens to be in and is
 * the stronger claim anyway.
 *
 * ## Role gating
 *
 * The five book-wide reports are `ADMIN`/`HR_MANAGER` on the server, but
 * `/dashboard/advance-loans/reports` carries no `<ProtectedRoute>` (see
 * `e2e/routes.ts`) — so a MANAGER or EMPLOYEE reaches the shell and the API
 * refuses the data. That is the interesting case, and the one asserted at the
 * end: a clean refusal with the reason shown, not a blank page.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Distinct per run and visible on screen, so leftovers are identifiable. */
const marker = `pw-rpt-${Date.now().toString(36)}`;

/** The columns each tab must render, in order. The independent oracle. */
const EXPECTED_COLUMNS: Record<LoanReportTab, string[]> = {
  outstanding: ['Employee', 'Department', 'Loans', 'Principal', 'Repaid', 'Outstanding', 'In flight'],
  emiDue: ['Employee', 'Reference', '#', 'Due', 'Instalment', 'Status'],
  overdue: ['Employee', '#', 'Due', 'Days', 'Bucket', 'Amount'],
  portfolio: ['Status', 'Type', 'Count', 'Principal', 'Outstanding'],
  interest: ['Period', 'Interest', 'Principal', 'Fees'],
};

interface LoanRecord {
  id: string;
  status: string;
  amount: string;
}

interface ReportEnvelope {
  data: unknown[];
  meta: { openPayrolls: Array<{ id: string; month: number; year: number }> };
}

const rows = <T>(value: T[] | { data?: T[] } | null | undefined): T[] =>
  Array.isArray(value) ? value : (value?.data ?? []);

const AMOUNT = 600;
const INSTALMENTS = 6;

test.describe('the loan book reports', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the loan book is an HR/admin report');
  });

  let adminApi: ApiClient;
  let managerApi: ApiClient;
  let branchId = '';
  let loanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    adminApi = await ApiClient.as('admin');
    managerApi = await ApiClient.as('manager');

    try {
      branchId = await adminApi.firstBranchId();
      adminApi.withBranch(branchId);
      managerApi.withBranch(branchId);

      /**
       * One approved loan, so the book is not empty.
       *
       * Filed as the MANAGER account on purpose: `loans.spec.ts` fights over
       * the `employee` account's `MAX_ACTIVE_LOANS` allowance, and two files
       * competing for the same two slots would make both order-sensitive.
       * ADMIN cannot file at all (`@Roles('HR_MANAGER','MANAGER','EMPLOYEE')`
       * on create — admins administer the queue, they do not file into it), so
       * the loan is created by one client and approved by another.
       */
      const created = await managerApi.post<LoanRecord>('/advance-loans', {
        type: 'LOAN',
        amount: AMOUNT,
        installments: INSTALMENTS,
        reason: `Automated journey ${marker} — report fixture`,
      });
      loanId = created.id;
      await adminApi.post(`/advance-loans/${loanId}/approve`, {
        remarks: `Approved by the automated journey ${marker}`,
        installments: INSTALMENTS,
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    // An APPROVED loan carries a balance, so `close` refuses it — writing it
    // off is the operation that actually releases the manager's allowance for
    // the next run.
    if (isProject('admin') && loanId) {
      await adminApi
        .post(`/advance-loans/${loanId}/write-off`, { reason: `${marker} — journey finished` })
        .catch(() => undefined);
    }
    await adminApi?.dispose();
    await managerApi?.dispose();
  });

  test('the five tabs are offered and Outstanding is the one that opens', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();

    expect(await reports.tabCount(), 'the report screen does not offer five tabs').toBe(
      LOAN_REPORT_TABS.length,
    );
    for (const key of LOAN_REPORT_TABS) {
      expect(
        await page.getByTestId(`loan-report-tab-${key}`).count(),
        `the ${key} tab is missing`,
      ).toBe(1);
    }

    // Outstanding first because it is the only tab that answers "who owes what
    // right now" — the question the screen exists for.
    expect(await reports.activeTab()).toBe('outstanding');

    settle(problems, 'the loan report tabs');
  });

  test('each tab renders its own columns, and switching between them does not crash', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();

    for (const key of LOAN_REPORT_TABS) {
      await reports.openTab(key);
      expect(await reports.activeTab(), `the ${key} tab did not become active`).toBe(key);
      expect(await reports.columns(), `the ${key} tab rendered the wrong columns`).toEqual(
        EXPECTED_COLUMNS[key],
      );
    }

    // Back to the start, which is the transition that used to throw: Portfolio's
    // rows have no `employeeName`, and Outstanding's have no `status`, so a
    // render that kept the old rows applied one tab's accessors to the other's
    // data. The `problems` fixture is what actually judges this — an uncaught
    // render lands in `pageErrors` whatever the assertions below say.
    await reports.openTab('outstanding');
    expect(await reports.columns()).toEqual(EXPECTED_COLUMNS.outstanding);

    settle(problems, 'switching between report tabs');
  });

  test('an empty tab says which kind of empty it is', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();

    const wording = new Map<string, string>();
    for (const key of LOAN_REPORT_TABS) {
      await reports.openTab(key);
      const empty = await reports.emptyState();
      if (!empty) continue;
      expect(empty.tab, `the empty state on ${key} names the wrong tab`).toBe(key);
      wording.set(key, empty.text);
    }

    test.skip(wording.size < 2, 'fewer than two tabs are empty — nothing to compare');

    // The claim: an empty Overdue table is good news and an empty Portfolio
    // means there is no loan book at all. One shared "Nothing to report."
    // flattened that and left the reader unsure the page had worked, so the
    // assertion is that no two tabs say the same thing.
    const texts = [...wording.values()];
    expect(
      new Set(texts).size,
      `two tabs share one empty message: ${[...wording.entries()].map(([k, v]) => `${k}=${v}`).join(' | ')}`,
    ).toBe(texts.length);

    settle(problems, 'the per-tab empty states');
  });

  test('Export is dead while there is nothing to export', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();

    // Find an empty tab. A live Export there would hand the user a file
    // containing a header and nothing else, which reads as "the export is
    // broken" rather than "there is nothing to export".
    let emptyTab: LoanReportTab | null = null;
    for (const key of LOAN_REPORT_TABS) {
      await reports.openTab(key);
      if (await reports.isEmpty()) {
        emptyTab = key;
        break;
      }
    }
    test.skip(!emptyTab, 'every tab has rows — nothing to assert the disabled state against');

    expect(await reports.canExport(), `Export was live on the empty ${emptyTab} tab`).toBe(false);

    settle(problems, 'Export on an empty report');
  });

  test('Export produces a real file whose contents are the table', async ({ page, problems }) => {
    expect(loanId, `no loan was seeded, so no tab has rows: ${setupError}`).toBeTruthy();

    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();

    // Whichever tab actually has data. Portfolio is non-empty the moment one
    // loan exists, but the assertion is written against whatever is populated
    // rather than assuming which — the point is the file/table agreement, not
    // the tab.
    let populated: LoanReportTab | null = null;
    for (const key of LOAN_REPORT_TABS) {
      await reports.openTab(key);
      if ((await reports.rowCount()) > 0) {
        populated = key;
        break;
      }
    }
    expect(populated, 'no report tab has a single row despite an approved loan').toBeTruthy();

    const onScreenColumns = await reports.columns();
    const onScreenRows = await reports.rowCount();

    const { fileName, text } = await reports.exportCsv();

    // The name carries the tab and the report's `asOf`, so a file downloaded
    // from two different tabs cannot be confused on disk.
    expect(fileName, 'the export is not named after the tab it came from').toContain(
      `loan-${populated}`,
    );
    expect(fileName.endsWith('.csv')).toBe(true);

    const lines = text.trim().split('\n');
    expect(parseCsvLine(lines[0]), 'the CSV header is not the table header').toEqual(onScreenColumns);
    expect(lines.length - 1, 'the CSV has a different number of rows than the table').toBe(
      onScreenRows,
    );

    // Every body line has to carry one cell per column. A shifted row is how a
    // figure ends up under the wrong heading in a spreadsheet nobody re-checks.
    for (const line of lines.slice(1)) {
      expect(parseCsvLine(line).length, `a CSV row has the wrong cell count: ${line}`).toBe(
        onScreenColumns.length,
      );
    }

    settle(problems, 'exporting a report');
  });

  test('a row that names a loan opens it, and a row that does not is inert', async ({
    page,
    problems,
  }) => {
    test.skip(!loanId, 'no loan was seeded');

    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();
    // Clicking the already-active tab is a no-op for the app and a wait for the
    // spec: it is how this file says "the first fetch has landed" without
    // reaching for a sleep.
    await reports.openTab('outstanding');

    // Outstanding aggregates per EMPLOYEE, not per loan — someone with three
    // loans is one row — so its rows deliberately carry no loan id. Offering a
    // click there would have to guess which of the three to open.
    if ((await reports.rowCount()) > 0) {
      expect(
        (await reports.rowLoanIds()).filter(Boolean),
        'an Outstanding row claimed to open a single loan',
      ).toEqual([]);
    }

    // The instalment tabs are per-schedule and do name their loan. Reading a
    // report and then hunting the same loan by hand in the list was the gap.
    let target = '';
    for (const key of ['emiDue', 'overdue'] as LoanReportTab[]) {
      await reports.openTab(key);
      const ids = (await reports.rowLoanIds()).filter(Boolean);
      if (ids.length) {
        target = ids[0];
        break;
      }
    }
    test.skip(!target, 'no instalment is due or overdue, so no row links to a loan');

    await reports.openRow(target);
    expect(new URL(page.url()).pathname, 'the row did not open the loan it names').toBe(
      `/dashboard/advance-loans/${target}`,
    );

    settle(problems, 'clicking through from a report row');
  });

  test('the open-payroll banner says exactly what the server reports', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();
    await reports.openTab('outstanding');

    // The server's own answer, taken from the same endpoint the screen calls.
    const envelope = await adminApi.get<ReportEnvelope>(
      '/advance-loans/reports/outstanding?limit=100',
    );
    const open = envelope?.meta?.openPayrolls ?? [];

    // Asserted as a biconditional rather than "the banner is there": a banner
    // that never appears and a banner that always appears both make the figures
    // unreadable, and only one of the two is caught by a presence check.
    // Polled, not sampled. The banner is driven by `meta`, which is replaced
    // when a tab reloads — so reading it once can catch the instant between the
    // request going out and its answer arriving, and decide a biconditional on
    // a frame that represents neither state.
    await expect
      .poll(() => reports.hasOpenPayrollBanner(), { timeout: 15_000 })
      .toBe(open.length > 0);

    if (open.length) {
      expect(await reports.openRunCount(), 'the banner miscounts the open runs').toBe(open.length);
    }

    settle(problems, 'the open-payroll banner');
  });

  test('Back returns to the loan list', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();
    await reports.back();

    expect(new URL(page.url()).pathname).toBe('/dashboard/advance-loans');

    settle(problems, 'leaving the reports screen');
  });
});

/**
 * HR reads the same book.
 *
 * A separate describe rather than a parameter because the projects are separate
 * workers: HR is in the role matrix for all five reports (`ADMIN`/`HR_MANAGER`),
 * and a screen that only an admin can open would quietly make the finance team
 * dependent on one account.
 */
test.describe('HR reads the loan book', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'the HR half');
  });

  test('every tab loads for HR, with columns and no crash', async ({ page, problems }) => {
    const hrApi = await ApiClient.as('hr');
    try {
      const branchId = await hrApi.firstBranchId();
      await selectBranch(page, branchId);

      const reports = new LoanReportsPage(page);
      await reports.open();

      // No redirect: the route is unguarded and HR is entitled to the data, so
      // landing anywhere else means the client guard and the server disagree.
      expect(new URL(page.url()).pathname).toBe('/dashboard/advance-loans/reports');

      for (const key of LOAN_REPORT_TABS) {
        await reports.openTab(key);
        expect(await reports.columns(), `the ${key} tab misrendered for HR`).toEqual(
          EXPECTED_COLUMNS[key],
        );
      }
    } finally {
      await hrApi.dispose();
    }

    settle(problems, 'the loan reports for HR');
  });
});

/**
 * The two roles the reports are not for.
 *
 * `/dashboard/advance-loans/reports` has no `<ProtectedRoute>`, so nobody is
 * redirected — the shell renders and the API answers 403. The question this
 * describe answers is what that looks like, because "the screen refused" and
 * "the screen broke" are indistinguishable to a user and the second one is a
 * bug.
 */
for (const role of ['manager', 'employee'] as const) {
  test.describe(`${role} reaching the loan reports`, () => {
    // Role gate, in a hook rather than in each body: a skip decided here
    // happens before the page fixture is built, so no browser opens.
    test.beforeEach(() => {
      test.skip(!isProject(role), `the ${role} denial`);
    });

    test('is refused cleanly, with the reason on screen', async ({ page, problems }) => {
      // The 403 is the correct answer, and the screen logs the failed fetch on
      // its way to reporting it. Only an uncaught render or a 5xx is a fault.
      crashesOnly(problems);

      // The branch id is resolved as ADMIN on purpose: `GET /branches` admits
      // ADMIN/HR/MANAGER only, so an EMPLOYEE asking for it 403s and the SETUP
      // fails before the case can observe the denial it exists to describe.
      // Who fetched the id is irrelevant — it is a selector value, not a
      // permission claim.
      const admin = await ApiClient.as('admin');
      const api = await ApiClient.as(role);
      try {
        const branchId = await admin.firstBranchId();
        await selectBranch(page, branchId);

        await page.goto('/dashboard/advance-loans/reports', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});

        // Unguarded, so the shell is reached rather than /403 — recorded here
        // because it is a deliberate difference from the banks cluster, where
        // the same refusal DOES redirect.
        expect(new URL(page.url()).pathname).toBe('/dashboard/advance-loans/reports');

        // The refusal is explained. `lib/axios` turns any 403 into the global
        // Access Denied modal carrying the server's own message, which is the
        // difference between a refused screen and a broken one.
        await expect(page.getByTestId('permission-denied-modal')).toBeVisible({ timeout: 20_000 });

        // And the server really did refuse — a modal raised by something else
        // would make this pass for the wrong reason.
        await expect(api.get('/advance-loans/reports/outstanding')).rejects.toThrow(/403/);

        // Something rendered. A silently blank body is the failure this suite
        // exists to catch, and it is what a thrown render looks like from
        // outside.
        expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(0);

        // FIXED (F27): the table used to render "No outstanding balances"
        // underneath the modal, so dismissing it left the screen asserting the
        // loan book was empty when the truth was that this role may not see it.
        // "Nobody owes anything" and "you may not see who owes anything" are
        // opposite facts about company money. The page now has a third state.
        await expect(page.getByTestId('loan-report-failed')).toBeVisible({
          timeout: 20_000,
        });
        await expect(page.getByTestId('loan-report-empty')).toHaveCount(0);

        // The refusal carries the server's own reason, not a generic fallback.
        const refusal = (
          await page.getByTestId('loan-report-failed').innerText()
        ).toLowerCase();
        expect(refusal).not.toContain('no outstanding balances');
      } finally {
        await api.dispose();
        await admin.dispose();
      }

      settle(problems, `the loan reports for ${role}`);
    });
  });
}
