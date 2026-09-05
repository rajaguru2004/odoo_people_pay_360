import { Page, expect } from '@playwright/test';
import { selectBranch } from './index';

/**
 * `/dashboard/advance-loans/reports` — the loan book, five ways.
 *
 * Five tabs over five differently-shaped endpoints, sharing one table. That
 * sharing is the risk the page object exists to make testable: the columns are
 * a per-tab definition and the rows are whatever the last request returned, so
 * a tab switch that renders the NEW columns against the OLD rows crashes on
 * `r.status.toLowerCase()` — which is exactly what this screen used to do. Any
 * assertion that switches tabs and then reads `columns()` is guarding that.
 *
 * Two more things the screen owes the reader, both asserted through here:
 *
 *   • Every figure counts LOCKED payroll only, so while a run is open the
 *     numbers will not match that run's payslips. `hasOpenPayrollBanner()` is
 *     how a spec proves the screen says so, and `openRunCount()` is how it
 *     proves the banner agrees with the server rather than merely existing.
 *   • The CSV is built from the same column definition the table renders, so
 *     the file and the view cannot drift. `exportCsv()` returns the bytes the
 *     browser was actually handed, which is the only way to check that claim.
 *
 * `selectBranch` is re-exported so a spec can take the branch helper and this
 * page object from one module — and it matters here: the report queries are
 * branch-scoped through hand-spliced SQL, so a browser pointed at the wrong
 * branch reads an empty book and every emptiness assertion passes for the wrong
 * reason.
 */
export { selectBranch };

export type LoanReportTab = 'outstanding' | 'emiDue' | 'overdue' | 'portfolio' | 'interest';

/** Every tab, in the order the screen offers them. */
export const LOAN_REPORT_TABS: LoanReportTab[] = [
  'outstanding',
  'emiDue',
  'overdue',
  'portfolio',
  'interest',
];

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

export class LoanReportsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/advance-loans/reports');
  }

  /**
   * Switches tab and waits for the table to settle.
   *
   * The wait is not decoration, and it deliberately does not stop at the first
   * paint that has something in it. Switching tab repaints this body three
   * times, not once:
   *
   *   1. the click commits the new tab with the OUTGOING tab's rows still
   *      mounted — and they are re-stamped with the NEW `data-tab` on the way
   *      through, so the attribute cannot tell them apart;
   *   2. the effect that follows drops them for the skeletons, which carry no
   *      testid at all, so the table reads as neither rows nor empty state;
   *   3. the answer lands and mounts a fresh set of `<tr>`s.
   *
   * A wait that returns at (1) hands the caller rows that are about to be torn
   * out from under it, which is how a click on a row that really was there ends
   * as "element was detached from the DOM". With two rows on screen that window
   * was too narrow to see; with a few hundred it is wide enough to lose a click
   * in. So the wait is for the body to stop CHANGING, not for it to be
   * non-empty.
   */
  async openTab(key: LoanReportTab): Promise<void> {
    await this.page.getByTestId(`loan-report-tab-${key}`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await expect.poll(() => this.activeTab(), { timeout: 20_000 }).toBe(key);
    await this.settleTable(key);
  }

  /** True while the skeleton rows are up — neither a row nor an empty state yet. */
  async isLoading(): Promise<boolean> {
    const rows = await this.page.getByTestId('loan-report-row').count();
    const empty = await this.page.getByTestId('loan-report-empty').count();
    return rows === 0 && empty === 0;
  }

  /**
   * The whole table body as one string, or `''` while it is mid-flight.
   *
   * Every terminal state the body can be in — rows, the per-tab empty state,
   * the load failure — carries `data-tab`, so anything still stamped with a
   * different tab, and the skeleton phase where none of the three is present,
   * both read as "not settled yet". The loan ids go into the string because a
   * bare count would call two different row sets of the same length identical.
   */
  private async bodyFingerprint(key: LoanReportTab | null): Promise<string> {
    const marks = await this.page
      .locator(
        '[data-testid="loan-report-row"],[data-testid="loan-report-empty"],[data-testid="loan-report-failed"]',
      )
      .evaluateAll((els) =>
        els.map((e) => `${e.getAttribute('data-tab') ?? ''}/${e.getAttribute('data-loan-id') ?? ''}`),
      );
    if (!marks.length) return '';
    if (key && marks.some((m) => !m.startsWith(`${key}/`))) return '';
    return marks.join('|');
  }

  /**
   * Polls until two consecutive reads of the body agree.
   *
   * Two samples rather than one because a single non-empty read cannot tell a
   * finished table from the outgoing tab's rows one frame before they are
   * dropped. The interval is longer than a frame on purpose: the stale render
   * is replaced by the effect that runs immediately after it paints, so it
   * cannot survive into a second sample.
   */
  private async settleTable(key: LoanReportTab | null): Promise<void> {
    let previous: string | null = null;
    let stable = 0;
    await expect
      .poll(
        async () => {
          const current = await this.bodyFingerprint(key);
          stable = current !== '' && current === previous ? stable + 1 : 0;
          previous = current;
          return stable;
        },
        { timeout: 30_000, intervals: [150] },
      )
      .toBeGreaterThanOrEqual(2);
  }

  async activeTab(): Promise<LoanReportTab | null> {
    const active = this.page.locator('[data-testid^="loan-report-tab-"][data-active="true"]');
    if (!(await active.count())) return null;
    const id = (await active.first().getAttribute('data-testid')) ?? '';
    return (id.replace('loan-report-tab-', '') as LoanReportTab) || null;
  }

  async tabCount(): Promise<number> {
    return this.page.locator('[data-testid^="loan-report-tab-"]').count();
  }

  /**
   * The column headings, read from `data-col` rather than from the cell text.
   *
   * These headings are the one string set on this screen that is NOT localised
   * — they are literals in the page's own COLUMNS table — but reading the
   * attribute keeps the assertion honest the day someone runs them through
   * next-intl, which is when a text-based assertion would start encoding the
   * language instead of the report.
   */
  async columns(): Promise<string[]> {
    return this.page
      .getByTestId('loan-report-col')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-col') ?? ''));
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('loan-report-row').count();
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('loan-report-empty').isVisible().catch(() => false);
  }

  /**
   * The empty state's two sentences, and which tab produced them.
   *
   * Per-tab wording is a deliberate product decision — an empty Overdue table
   * is good news and an empty Portfolio means there is no loan book at all — so
   * a spec asserts the two are DIFFERENT rather than asserting either literal.
   * Comparing texts is safe where selecting on them is not.
   */
  async emptyState(): Promise<{ tab: string; text: string } | null> {
    const el = this.page.getByTestId('loan-report-empty');
    if (!(await el.count())) return null;
    return {
      tab: (await el.getAttribute('data-tab')) ?? '',
      text: (await el.innerText()).trim(),
    };
  }

  /** The loan ids the current rows link to; `''` where a row opens nothing. */
  async rowLoanIds(): Promise<string[]> {
    return this.page
      .getByTestId('loan-report-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-loan-id') ?? ''));
  }

  /** Opens the loan a row names. Only rows carrying `data-loan-id` are clickable. */
  /**
   * Click a row through to its loan.
   *
   * Waits for the URL, not for the network. The row navigates with
   * `router.push`, which is client-side — `networkidle` can settle before the
   * route has changed, and the caller then reads the OLD pathname and reports
   * "the row did not open the loan it names" for a row that opened it a moment
   * later.
   *
   * The table is settled BEFORE the click, for the reason spelled out on
   * `openTab`: a row read out of a body that is still being replaced detaches
   * under the click, and Playwright's retry then races the same repaint until
   * it runs out of time. `.first()` is not laziness either — the instalment
   * tabs are per-schedule, so one loan three instalments behind is three rows,
   * all naming that loan and all opening the same page.
   */
  async openRow(loanId: string): Promise<void> {
    await this.settleTable(await this.activeTab());
    await this.page
      .locator(`[data-testid="loan-report-row"][data-loan-id="${loanId}"]`)
      .first()
      .click();
    await this.page.waitForURL(`**/dashboard/advance-loans/${loanId}`, {
      timeout: 20_000,
    });
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async hasOpenPayrollBanner(): Promise<boolean> {
    return this.page
      .getByTestId('loan-report-open-payroll-banner')
      .isVisible()
      .catch(() => false);
  }

  /** How many open runs the banner claims. 0 when the banner is absent. */
  async openRunCount(): Promise<number> {
    const el = this.page.getByTestId('loan-report-open-payroll-banner');
    if (!(await el.count())) return 0;
    return Number((await el.getAttribute('data-open-runs')) ?? '0');
  }

  async canExport(): Promise<boolean> {
    return this.page.getByTestId('loan-report-export').isEnabled().catch(() => false);
  }

  /**
   * Clicks Export and returns the file the browser was handed.
   *
   * The file never touches the network — it is a Blob built in the page and
   * handed over as an object URL, which the page then revokes on the next line.
   * Chromium starts the download synchronously on click, so the revoke is not a
   * race in practice; if this ever times out, that ordering is the first place
   * to look rather than the server.
   *
   * Returned as text plus the suggested name because both carry a claim: the
   * name encodes the tab and the report's `asOf`, and the text has to match the
   * table it was built from.
   */
  async exportCsv(): Promise<{ fileName: string; text: string }> {
    const waitForDownload = this.page.waitForEvent('download', { timeout: 30_000 });
    await this.page.getByTestId('loan-report-export').click();
    const download = await waitForDownload;
    const path = await download.path();
    if (!path) throw new Error('the browser produced no file for the CSV export');
    const { readFile } = await import('fs/promises');
    return {
      fileName: download.suggestedFilename(),
      text: await readFile(path, 'utf8'),
    };
  }

  /**
   * Leave the reports screen for the loan list.
   *
   * Waits for the URL, not for the network — the Back control navigates with
   * `router.push`, so `networkidle` can settle while the route has not changed
   * yet and the caller then reads the old pathname. Same trap as `openRow`.
   */
  async back(): Promise<void> {
    await this.page.getByTestId('loan-report-back').click();
    await this.page.waitForURL('**/dashboard/advance-loans', { timeout: 20_000 });
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

/**
 * Splits one CSV line into fields, honouring the doubled-quote escape the page
 * writes.
 *
 * Written out rather than pulled from a library because the claim under test is
 * that employee names carrying commas survive the round trip — and a parser
 * that merely splits on `,` would agree with a broken exporter.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}
