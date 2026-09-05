import { Page, expect } from '@playwright/test';
import { selectBranch } from './index';

/**
 * Page objects for the post-approval half of Advances & Loans.
 *
 * They live beside `pages/index.ts` rather than inside it because that file is
 * already 3,700 lines and this surface is large enough to be looked at on its
 * own: ten money operations, a two-phase importer and a server-backed toolbar.
 * The rules are the same ones stated at the top of `pages/index.ts` and are
 * repeated here only where this screen makes them sharper:
 *
 *   • `data-testid` first, never visible text — every label on these screens
 *     exists in English and in Arabic, so a text selector encodes the language
 *     rather than the intent.
 *   • Numbers are read from `data-*` attributes, not from rendered currency.
 *     `formatCurrency` inserts a locale-dependent separator and a symbol, so a
 *     test that parsed its output would be asserting `Intl`, not the app.
 *   • No business rules here. Which operations a status permits, and what the
 *     server says when it refuses, belong in the spec where a reader can see
 *     them.
 *
 * `selectBranch` is re-exported so a spec can take everything it needs from one
 * import; it is the same function, not a copy.
 */

export { selectBranch };

/** `data-*` attributes are strings; this is the one place that admits it. */
function num(value: string | null): number {
  return value === null || value === '' ? 0 : Number(value);
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * The ten post-approval operations, exactly as `LoanLifecycleActions` names
 * them. Kept as a literal union rather than imported from the component so the
 * suite compiles without pulling app code (and its `'use client'` directive)
 * into the Playwright process.
 */
export type LoanOp =
  | 'prepay'
  | 'skip'
  | 'hold'
  | 'resume'
  | 'convert'
  | 'waive'
  | 'foreclose'
  | 'close'
  | 'writeOff'
  | 'reinstate'
  // The three that had no screen until the gap-closure work: recording the
  // payout, repricing a live loan and replacing it with a larger one.
  | 'disburse'
  | 'rateChange'
  | 'topup';

/**
 * The same set as a value, for sweeping what a screen offers.
 *
 * `disburse`, `rateChange` and `topup` are deliberately NOT in it. This list is
 * used to assert what a role is offered on a LIVE loan, and those three are
 * offered in states the sweep does not visit — disburse only on an APPROVED
 * loan, the other two only on an interest-bearing one — so including them would
 * make every sweep expect buttons that are correctly absent.
 */
export const ALL_OPS: LoanOp[] = [
  'prepay',
  'skip',
  'hold',
  'resume',
  'convert',
  'waive',
  'foreclose',
  'close',
  'writeOff',
  'reinstate',
];

/**
 * Fields the operation dialog can show, keyed by the suffix of their test id.
 *
 * Not every operation shows every field — the dialog renders only what its own
 * operation needs, so passing a field the current operation does not have is a
 * spec bug and fails loudly rather than being silently dropped.
 */
export type LoanOpField =
  | 'amount'
  | 'reason'
  | 'installment-no'
  | 'installments'
  | 'until'
  | 'reference'
  | 'mode'
  | 'recalc'
  | 'waive'
  | 'waive-type'
  // Kebab-cased, like every other entry: the dialog builds its test ids as
  // `loan-op-${kebab(key)}`, so the camelCase field name is not the id.
  | 'disbursement-date'
  | 'disbursed-amount'
  | 'new-method'
  | 'new-rate';

export type LoanOpForm = Partial<Record<LoanOpField, string>>;

/** Which summary tile to read. The last two exist only before disbursement. */
export type LoanSummaryTile =
  | 'principal'
  | 'repaid'
  | 'outstanding'
  | 'payoff'
  | 'installments';

/**
 * One loan's detail route — the only screen from which the money operations can
 * be driven.
 *
 * It is a ROUTE, not a modal, which is why it can carry a schedule, a recovery
 * ledger and ten operations at once. That also puts it outside `e2e/routes.ts`
 * (a dynamic segment has no static path), so this class is the only coverage
 * the screen gets.
 */
export class LoanLifecyclePage {
  constructor(private readonly page: Page) {}

  async open(id: string): Promise<void> {
    await open(this.page, `/dashboard/advance-loans/${id}`);
  }

  /** The machine-readable status, never the translated badge label. */
  async status(): Promise<string | null> {
    const badge = this.page.getByTestId('loan-status');
    if (!(await badge.count())) return null;
    return badge.getAttribute('data-status');
  }

  /**
   * Polls rather than asserts once: every operation re-reads the loan after it
   * succeeds, so the badge is a render or two behind the click.
   */
  async expectStatus(expected: string): Promise<void> {
    await expect.poll(() => this.status(), { timeout: 20_000 }).toBe(expected);
  }

  /** The agreed repayment period, as the Terms block reports it. */
  async installments(): Promise<string> {
    return (await this.page.getByTestId('loan-installments-value').innerText()).trim();
  }

  /**
   * A money tile as a NUMBER.
   *
   * `null` when the tile is not on screen, which is an answer rather than a
   * fault: a request that never became debt shows two tiles (what was asked
   * for) instead of four, because "Outstanding 30,000" on a REJECTED request is
   * money the company is not owed.
   */
  async summary(tile: LoanSummaryTile): Promise<number | null> {
    const el = this.page.getByTestId(`loan-summary-${tile}`);
    if (!(await el.count())) return null;
    return num(await el.getAttribute('data-value'));
  }

  async hasRejectedBanner(): Promise<boolean> {
    return this.page.getByTestId('loan-detail-rejected-banner').isVisible().catch(() => false);
  }

  async hasHoldBanner(): Promise<boolean> {
    return this.page.getByTestId('loan-detail-hold-banner').isVisible().catch(() => false);
  }

  /** One row per live instalment. Superseded rows are never returned. */
  async scheduleRowCount(): Promise<number> {
    return this.page.getByTestId('loan-schedule-row').count();
  }

  /** The schedule status of one instalment, or null when the row is absent. */
  async scheduleRowStatus(installmentNo: number): Promise<string | null> {
    const row = this.page.locator(
      `[data-testid="loan-schedule-row"][data-installment-no="${installmentNo}"]`,
    );
    if (!(await row.count())) return null;
    return row.getAttribute('data-schedule-status');
  }

  async scheduleStatuses(): Promise<string[]> {
    return this.page
      .getByTestId('loan-schedule-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-schedule-status') ?? ''));
  }

  /**
   * Whether the screen is showing "there is no plan here".
   *
   * The wording lives inside `LoanScheduleTable`, so from this level the fact is
   * only observable as a marker on the section — present when the plan is empty,
   * absent when it is not.
   */
  async scheduleIsEmpty(): Promise<boolean> {
    return (await this.page.getByTestId('loan-schedule-empty').count()) > 0;
  }

  /** True when payroll has recovered nothing against this loan. */
  async ledgerIsEmpty(): Promise<boolean> {
    return this.page.getByTestId('loan-ledger-empty').isVisible().catch(() => false);
  }

  /**
   * Whether the "nothing ever reached payroll" wording is used rather than
   * "nothing recovered yet" — different facts, and the reason the two exist.
   */
  async ledgerNeverDisbursed(): Promise<boolean> {
    const el = this.page.getByTestId('loan-ledger-empty');
    if (!(await el.count())) return false;
    return (await el.getAttribute('data-never-disbursed')) === 'true';
  }

  /** 0 when the attachments section is not rendered at all. */
  async attachmentCount(): Promise<number> {
    const section = this.page.getByTestId('loan-attachments');
    if (!(await section.count())) return 0;
    return num(await section.getAttribute('data-count'));
  }

  // ── the operations panel ──────────────────────────────────────────────────

  /**
   * Whether this role is offered a given operation on this loan at all.
   *
   * The panel draws a button only when the STATUS permits the operation and the
   * caller has the capability — write-off is gated on
   * `advance_loan_writeoff_roles`, which is a database setting and not RBAC, so
   * an HR_MANAGER reaches the route and is still offered no button.
   */
  async offers(op: LoanOp): Promise<boolean> {
    return this.button(op).isVisible().catch(() => false);
  }

  /** Every operation currently on offer. */
  async operations(): Promise<LoanOp[]> {
    const offered: LoanOp[] = [];
    for (const op of ALL_OPS) {
      if (await this.offers(op)) offered.push(op);
    }
    return offered;
  }

  /**
   * The action BUTTON for an operation.
   *
   * Qualified by element rather than by test id alone: the foreclose dialog
   * carries a `waive`-keyed select, so `[data-testid="loan-op-waive"]` matches
   * two nodes whenever that dialog is open and an unqualified locator would
   * fail Playwright's strict mode on an assertion that has nothing to do with
   * it.
   */
  private button(op: LoanOp) {
    return this.page.locator(`button[data-testid="loan-op-${op}"]`);
  }

  /**
   * The explanation shown INSTEAD of an empty Actions box, and the status it was
   * written for. Null when operations are on offer.
   */
  async noActionsReason(): Promise<{ status: string; text: string } | null> {
    const el = this.page.getByTestId('loan-no-actions-reason');
    if (!(await el.count())) return null;
    return {
      status: (await el.getAttribute('data-status')) ?? '',
      text: (await el.innerText()).trim(),
    };
  }

  async openOp(op: LoanOp): Promise<void> {
    await this.button(op).click();
    await expect(this.page.getByTestId('loan-op-modal')).toBeVisible();
  }

  /** Which operation the open dialog belongs to, or null when none is open. */
  async openedOp(): Promise<string | null> {
    const modal = this.page.getByTestId('loan-op-modal');
    if (!(await modal.count())) return null;
    return modal.getAttribute('data-op');
  }

  /**
   * Fills the dialog. Selects and text inputs share one entry point because the
   * caller cares which VALUE a field carries, not which element renders it.
   *
   * Scoped to the dialog, not to the page: the foreclose form carries a
   * `waive`-keyed select while a `waive` action button is on the page behind it,
   * so an unscoped `loan-op-waive` matches two nodes and fails strict mode.
   */
  async fill(form: LoanOpForm): Promise<void> {
    const modal = this.page.getByTestId('loan-op-modal');
    for (const [field, value] of Object.entries(form)) {
      if (value === undefined) continue;
      const el = modal.getByTestId(`loan-op-${field}`);
      const tag = await el.evaluate((node) => node.tagName.toLowerCase());
      if (tag === 'select') await el.selectOption(value);
      else await el.fill(value);
    }
  }

  async confirm(): Promise<void> {
    await this.page.getByTestId('loan-op-confirm').click();
  }

  async cancelOp(): Promise<void> {
    await this.page.getByTestId('loan-op-cancel').click();
    await expect(this.page.getByTestId('loan-op-modal')).toBeHidden();
  }

  /**
   * Waits for the dialog to SETTLE, and reports which way it went.
   *
   * It has exactly two resting states, and both are deliberate: it CLOSES when
   * the operation went through, and it STAYS OPEN with the reason above the
   * fields when it was refused — by the client guards or by the server — so
   * that a user does not lose what they typed.
   *
   * Watching only for the close is what made a refusal cost the full 25s and
   * then report "the modal is still visible", which is the one fact the reader
   * already had. Watching for both means a refusal is reported the instant it
   * lands, in the words of whichever layer refused — and those words are what
   * tell a reader whether the loan was in the wrong state, whether a payroll run
   * has claimed it, or whether the operation is genuinely broken.
   *
   * Returns the refusal, or `null` when the operation succeeded.
   */
  private async settleOp(): Promise<string | null> {
    const modal = this.page.getByTestId('loan-op-modal');
    const banner = this.page.getByTestId('loan-op-error');

    await expect
      .poll(
        async () => {
          if (await banner.count()) return 'refused';
          return (await modal.count()) ? 'open' : 'closed';
        },
        {
          timeout: 25_000,
          message:
            'the operation dialog neither closed nor showed a reason — the request never came back',
        },
      )
      .not.toBe('open');

    if (!(await banner.count())) return null;
    return (await banner.innerText()).trim();
  }

  /**
   * Runs an operation that is expected to go through.
   *
   * A refusal fails the call immediately and QUOTES it, rather than timing out
   * on a hidden-ness that was never coming.
   */
  async run(op: LoanOp, form: LoanOpForm = {}): Promise<void> {
    await this.openOp(op);
    await this.fill(form);
    await this.confirm();

    const refusal = await this.settleOp();
    if (refusal !== null) {
      throw new Error(`the ${op} operation was refused: ${refusal}`);
    }
  }

  /**
   * Runs an operation that is EXPECTED to be refused, and returns the sentence
   * shown to the user.
   *
   * The whole point of the assertion this enables is in
   * `docs/LOAN-ADVANCES-TEST-CASES.md`: the backend explains every refusal
   * precisely, and a correct 404 once reached production as "The operation could
   * not be completed" because the axios interceptor rejects with a FLAT object
   * and `e.response.data.message` was always undefined. Returning the text is
   * what lets a spec assert the server's own words survived the trip.
   */
  async attempt(op: LoanOp, form: LoanOpForm = {}): Promise<string> {
    await this.openOp(op);
    await this.fill(form);
    await this.confirm();

    const refusal = await this.settleOp();
    if (refusal === null) {
      throw new Error(
        `the ${op} operation was expected to be refused, but it went through and closed its dialog`,
      );
    }

    // The designed behaviour, asserted here so that EVERY refusing case gets it
    // rather than only the ones that remembered: refused means the dialog stays
    // open, carrying the reason and what was typed into it.
    await expect(this.page.getByTestId('loan-op-modal')).toBeVisible();
    return refusal;
  }

  /** The refusal currently on screen, or null when the dialog is clean. */
  async error(): Promise<string | null> {
    const banner = this.page.getByTestId('loan-op-error');
    if (!(await banner.count())) return null;
    return (await banner.innerText()).trim();
  }

  async modalOpen(): Promise<boolean> {
    return this.page.getByTestId('loan-op-modal').isVisible().catch(() => false);
  }
}

/**
 * The search and filter bar above the request list.
 *
 * It is shown ONLY on the admin "All requests" tab, because that is the only tab
 * served by an endpoint that can answer a filter. The other two return a plain
 * array with no filter support, and a search box that silently searched one page
 * would be worse than none — so a spec that cannot find this toolbar is usually
 * on the wrong tab rather than looking at a broken screen.
 */
export class LoanToolbar {
  constructor(private readonly page: Page) {}

  async isVisible(): Promise<boolean> {
    return this.page.getByTestId('loan-search').isVisible().catch(() => false);
  }

  /**
   * Types into the search box and waits for the result to come back.
   *
   * The box is debounced at 350ms and holds its own text, committing to the
   * parent only once typing stops — so asserting immediately after `fill` reads
   * the PREVIOUS result set. The wait is on the count element's own reported
   * total settling, not on a sleep.
   */
  async search(term: string): Promise<void> {
    await this.page.getByTestId('loan-search').fill(term);
    await this.page.waitForTimeout(500);
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async searchValue(): Promise<string> {
    return this.page.getByTestId('loan-search').inputValue();
  }

  async filterType(value: '' | 'ADVANCE' | 'LOAN'): Promise<void> {
    await this.page.getByTestId('loan-filter-type').selectOption(value);
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async typeValue(): Promise<string> {
    return this.page.getByTestId('loan-filter-type').inputValue();
  }

  /**
   * Picks a status GROUP by its key, e.g. `live` for APPROVED/DISBURSED/ACTIVE.
   *
   * Groups rather than one chip per enum value: "Active" meaning four statuses
   * is the question people actually ask, and thirteen chips is a second copy of
   * the schema rather than a filter.
   */
  async filterStatus(key: string): Promise<void> {
    await this.page.getByTestId(`loan-filter-status-${key}`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** The keys the toolbar offers, in order — the contract with the server. */
  async statusKeys(): Promise<string[]> {
    return this.page
      .locator('[data-testid^="loan-filter-status-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-key') ?? ''));
  }

  /** The CSV a group sends as `status`, e.g. `PENDING,DRAFT`. */
  async statusValue(key: string): Promise<string | null> {
    return this.page.getByTestId(`loan-filter-status-${key}`).getAttribute('data-value');
  }

  async activeStatus(): Promise<string | null> {
    const active = this.page.locator('[data-testid^="loan-filter-status-"][data-active="true"]');
    if (!(await active.count())) return null;
    return active.first().getAttribute('data-key');
  }

  /**
   * What the bar says it found: rows on screen, and the server-side total behind
   * the filters. Read as numbers rather than out of the four-shaped sentence
   * beside them.
   */
  async count(): Promise<{ shown: number; total: number; loading: boolean }> {
    const el = this.page.getByTestId('loan-result-count');
    return {
      shown: num(await el.getAttribute('data-shown')),
      total: num(await el.getAttribute('data-total')),
      loading: (await el.getAttribute('data-loading')) === 'true',
    };
  }

  /** Polls, because the total lands with the response and not with the click. */
  async expectTotal(expected: number): Promise<void> {
    await expect.poll(async () => (await this.count()).total, { timeout: 20_000 }).toBe(expected);
  }

  /** The reset only exists while something is actually filtered. */
  async canClear(): Promise<boolean> {
    return this.page.getByTestId('loan-clear-filters').isVisible().catch(() => false);
  }

  /**
   * Presses the reset and waits for it to actually land in the box.
   *
   * The reset takes TWO renders, not one. The click commits the empty filters
   * into the PARENT, and only the effect that follows that commit pushes the
   * empty string back down into the search box's own local state — a passive
   * effect, so it runs after the paint, not during the click. Reading
   * `searchValue()` straight after the click therefore reads the term that is
   * on its way out and reports a reset button that "does not clear the search"
   * for a button that cleared it a frame later.
   *
   * `networkidle` is no protection either: the refetch has not been issued yet
   * at the instant the click returns, so an already-quiet page satisfies it
   * immediately. The wait has to be on the box itself.
   */
  async clear(): Promise<void> {
    await this.page.getByTestId('loan-clear-filters').click();
    await expect(this.page.getByTestId('loan-search')).toHaveValue('', { timeout: 20_000 });
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

/**
 * The loan importer — two phases on purpose.
 *
 * Preview parses, validates and persists NOTHING, so an operator can iterate on
 * a bad file without leaving half-imported loans behind; only the rows preview
 * called valid are sent to confirm. That split is the safety property, and it is
 * the one an "optimisation" into a single call would silently lose.
 */
export class LoanImportModalPage {
  constructor(private readonly page: Page) {}

  /** Opens from the list header. The button exists for ADMIN and HR only. */
  async open(): Promise<void> {
    await open(this.page, '/dashboard/advance-loans');
    await this.page.getByTestId('loan-import').click();
    await expect(this.page.getByTestId('loan-import-modal')).toBeVisible({ timeout: 20_000 });
  }

  /** `UPLOAD` → `PREVIEW` → `IMPORTING` → `RESULTS`. */
  async step(): Promise<string | null> {
    return this.page.getByTestId('loan-import-modal').getAttribute('data-step');
  }

  /**
   * Presses Download and returns the bytes the browser was handed.
   *
   * The click is the test: the workbook is fetched by an authenticated XHR and
   * handed over as an object URL, so a plain link would 401 and a spec that only
   * asserted the button exists would not notice.
   */
  async downloadTemplate(): Promise<Buffer> {
    const waitForDownload = this.page.waitForEvent('download', { timeout: 30_000 });
    await this.page.getByTestId('loan-import-template').click();
    const download = await waitForDownload;
    const path = await download.path();
    if (!path) throw new Error('the browser produced no file for the template download');
    const { readFile } = await import('fs/promises');
    return readFile(path);
  }

  /**
   * Feeds a workbook built in memory — no fixture file on disk to drift from the
   * column contract. Choosing the file IS the upload: the input's change handler
   * posts it straight to preview, so there is no second button to press.
   */
  async choose(file: { name: string; buffer: Buffer }): Promise<void> {
    await this.page.getByTestId('loan-import-file').setInputFiles({
      name: file.name,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: file.buffer,
    });
    await expect
      .poll(() => this.step(), { timeout: 30_000 })
      .toBe('PREVIEW');
  }

  async preview(): Promise<{ total: number; valid: number; invalid: number }> {
    const read = async (id: string) =>
      num(await this.page.getByTestId(id).getAttribute('data-count'));
    return {
      total: await read('loan-import-rows'),
      valid: await read('loan-import-valid'),
      invalid: await read('loan-import-invalid'),
    };
  }

  /** Disabled when preview found nothing worth importing. */
  async confirmEnabled(): Promise<boolean> {
    return this.page.getByTestId('loan-import-confirm').isEnabled().catch(() => false);
  }

  async confirm(): Promise<void> {
    await this.page.getByTestId('loan-import-confirm').click();
    await expect(this.page.getByTestId('loan-import-results')).toBeVisible({ timeout: 60_000 });
  }

  async results(): Promise<{ imported: number; failed: number }> {
    const el = this.page.getByTestId('loan-import-results');
    return {
      imported: num(await el.getAttribute('data-imported')),
      failed: num(await el.getAttribute('data-failed')),
    };
  }

  /** The same button is Cancel before the import and Done after it. */
  async close(): Promise<void> {
    await this.page.getByTestId('loan-import-cancel').click();
    await expect(this.page.getByTestId('loan-import-modal')).toBeHidden();
  }
}
