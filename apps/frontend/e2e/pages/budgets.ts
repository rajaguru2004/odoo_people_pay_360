import { Page, Locator, expect } from '@playwright/test';

/**
 * The HR budget screens: the list, and one budget's variance report.
 *
 * Same selector policy as `./index`. One rule is worth restating here because
 * this screen is nothing but numbers: every figure on it is rendered through
 * `toLocaleString` with a currency prefix, so a page object that read
 * `"OMR 1,250.00"` and parsed it would be asserting the formatter and the
 * runtime's locale data rather than the ledger. The pages publish the raw
 * numbers as `data-amount` / `data-planned` / `data-committed` beside the
 * formatted ones, and everything here reads those.
 */

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

/** `data-*` attributes are strings; this is the one place that admits it. */
function num(value: string | null): number {
  return value === null || value === '' ? 0 : Number(value);
}

export interface BudgetFormInput {
  name?: string;
  fiscalYear?: number;
  /** The branch id — the option's value, not its name. */
  branchId?: string;
  startDate?: string;
  endDate?: string;
}

export interface BudgetLineInput {
  /** A `BUDGET_CATEGORY` label; also the option's value. */
  category: string;
  /** Omit for the company-wide fallback line. */
  departmentId?: string;
  plannedAmount: number;
}

/** The four figures across the top of the variance report. */
export interface BudgetTotals {
  planned: number;
  committed: number;
  actual: number;
  remaining: number;
}

/**
 * `/dashboard/budgets` — the list.
 *
 * ADMIN and HR_MANAGER only, both in `ProtectedRoute` and in `@Roles` on all
 * seven routes behind it. The list is branch-scoped by the Prisma middleware
 * rather than by anything on this screen, which is why every spec here has to
 * say which branch it is looking from.
 */
export class BudgetsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/budgets');
  }

  row(budgetId: string): Locator {
    return this.page.locator(`[data-testid="budget-row"][data-budget-id="${budgetId}"]`);
  }

  async hasRow(budgetId: string): Promise<boolean> {
    return (await this.row(budgetId).count()) > 0;
  }

  /** `null` when the row is absent, so a caller can poll a list that is still loading. */
  async rowStatus(budgetId: string): Promise<string | null> {
    const row = this.row(budgetId);
    if ((await row.count()) === 0) return null;
    return row.getAttribute('data-status');
  }

  async expectRowStatus(budgetId: string, expected: string): Promise<void> {
    await expect.poll(() => this.rowStatus(budgetId), { timeout: 15_000 }).toBe(expected);
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('budget-row').count();
  }

  async ids(): Promise<string[]> {
    return this.page
      .getByTestId('budget-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-budget-id') ?? ''));
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('budget-empty').isVisible().catch(() => false);
  }

  // ── The create form ───────────────────────────────────────────────────────

  async openForm(): Promise<void> {
    await this.page.getByTestId('budget-new').click();
    await expect(this.page.getByTestId('budget-name')).toBeVisible();
  }

  async formIsOpen(): Promise<boolean> {
    return this.page.getByTestId('budget-submit').isVisible().catch(() => false);
  }

  /** The branches the picker offers, as ids. Empty option excluded. */
  async branchOptions(): Promise<string[]> {
    return this.page
      .getByTestId('budget-branch')
      .locator('option')
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLOptionElement).value).filter(Boolean),
      );
  }

  async fill(input: BudgetFormInput): Promise<void> {
    if (input.name !== undefined) {
      await this.page.getByTestId('budget-name').fill(input.name);
    }
    if (input.fiscalYear !== undefined) {
      await this.page.getByTestId('budget-year').fill(String(input.fiscalYear));
    }
    if (input.branchId !== undefined) {
      await this.page.getByTestId('budget-branch').selectOption(input.branchId);
    }
    if (input.startDate !== undefined) {
      await this.page.getByTestId('budget-start').fill(input.startDate);
    }
    if (input.endDate !== undefined) {
      await this.page.getByTestId('budget-end').fill(input.endDate);
    }
  }

  async submitOnly(): Promise<void> {
    await this.page.getByTestId('budget-submit').click();
  }

  async create(input: BudgetFormInput): Promise<void> {
    await this.openForm();
    await this.fill(input);
    await this.submitOnly();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Only a DRAFT is offered Activate; only an ACTIVE is offered Close. */
  async canActivate(budgetId: string): Promise<boolean> {
    return this.row(budgetId).getByTestId('budget-activate').isVisible().catch(() => false);
  }

  async canClose(budgetId: string): Promise<boolean> {
    return this.row(budgetId).getByTestId('budget-close').isVisible().catch(() => false);
  }

  async activate(budgetId: string): Promise<void> {
    await this.row(budgetId).getByTestId('budget-activate').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async close(budgetId: string): Promise<void> {
    await this.row(budgetId).getByTestId('budget-close').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** Follows the row's Variance link, so the navigation itself is exercised. */
  async openVariance(budgetId: string): Promise<void> {
    await this.row(budgetId).getByTestId('budget-variance-link').click();
    await this.page.waitForURL(`**/dashboard/budgets/${budgetId}`, { timeout: 20_000 });
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

/**
 * `/dashboard/budgets/[id]` — Planned vs Committed vs Actual vs Remaining.
 *
 * A dynamic route, so `e2e/routes.ts` cannot see it and nothing else in the
 * suite visits it. Two things it reports are computed rather than stored and
 * therefore only ever wrong at read time: `remaining`, which is
 * `planned − open commitments − actual`, and the unbudgeted list, which is real
 * spend that matched no line at all.
 */
export class BudgetVariancePage {
  constructor(private readonly page: Page) {}

  async open(budgetId: string): Promise<void> {
    await open(this.page, `/dashboard/budgets/${budgetId}`);
  }

  // ── Totals ────────────────────────────────────────────────────────────────

  private tile(key: keyof BudgetTotals): Locator {
    return this.page.getByTestId(`budget-total-${key}`);
  }

  async total(key: keyof BudgetTotals): Promise<number> {
    return num(await this.tile(key).getAttribute('data-amount'));
  }

  async totals(): Promise<BudgetTotals> {
    return {
      planned: await this.total('planned'),
      committed: await this.total('committed'),
      actual: await this.total('actual'),
      remaining: await this.total('remaining'),
    };
  }

  /** Polls one tile — the commitment lands through an approval on another screen. */
  async expectTotal(key: keyof BudgetTotals, expected: number): Promise<void> {
    await expect.poll(() => this.total(key), { timeout: 15_000 }).toBe(expected);
  }

  // ── Lines ─────────────────────────────────────────────────────────────────

  lineRow(lineId: string): Locator {
    return this.page.locator(`[data-testid="budget-line-row"][data-line-id="${lineId}"]`);
  }

  async hasLine(lineId: string): Promise<boolean> {
    return (await this.lineRow(lineId).count()) > 0;
  }

  async lineCount(): Promise<number> {
    return this.page.getByTestId('budget-line-row').count();
  }

  async lineIds(): Promise<string[]> {
    return this.page
      .getByTestId('budget-line-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-line-id') ?? ''));
  }

  async linePlanned(lineId: string): Promise<number> {
    return num(await this.lineRow(lineId).getAttribute('data-planned'));
  }

  /** What the line currently holds against approved-but-unpaid requests. */
  async lineCommitted(lineId: string): Promise<number> {
    return num(await this.lineRow(lineId).getAttribute('data-committed'));
  }

  async expectLineCommitted(lineId: string, expected: number): Promise<void> {
    await expect.poll(() => this.lineCommitted(lineId), { timeout: 15_000 }).toBe(expected);
  }

  /** The "no budget lines yet" row inside the table. */
  /**
   * Block until the report has actually rendered.
   *
   * The screen shows a "Loading…" card first, and every assertion below is
   * false while that is up — including `isVarianceEmpty()`, which would report
   * "not empty" for a report that simply had not arrived yet. That reads as a
   * product failure and is a race in the test.
   *
   * Loaded means one of two things is on screen: at least one line row, or the
   * empty panel. Waiting for either is what makes the two states
   * distinguishable rather than merely "not loading".
   */
  async waitForLoaded(): Promise<void> {
    await expect
      .poll(
        async () =>
          (await this.page.getByTestId('budget-line-row').count()) > 0 ||
          (await this.page.getByTestId('budget-variance-empty').count()) > 0,
        { timeout: 20_000 },
      )
      .toBe(true);
  }

  async isVarianceEmpty(): Promise<boolean> {
    await this.waitForLoaded();
    return this.page.getByTestId('budget-variance-empty').isVisible().catch(() => false);
  }

  // ── The line form ─────────────────────────────────────────────────────────

  async openLineForm(): Promise<void> {
    await this.page.getByTestId('budget-line-new').click();
    await expect(this.page.getByTestId('budget-line-category')).toBeVisible();
  }

  async lineFormIsOpen(): Promise<boolean> {
    return this.page.getByTestId('budget-line-save').isVisible().catch(() => false);
  }

  /** The categories the picker offers — from the `BUDGET_CATEGORY` library. */
  async categoryOptions(): Promise<string[]> {
    return this.page
      .getByTestId('budget-line-category')
      .locator('option')
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLOptionElement).value).filter(Boolean),
      );
  }

  /** Department ids the picker offers. The empty value is the company-wide fallback. */
  async departmentOptions(): Promise<string[]> {
    return this.page
      .getByTestId('budget-line-department')
      .locator('option')
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLOptionElement).value).filter(Boolean),
      );
  }

  /** See `TravelPage.masterHint` — the empty-category hint, found by its link. */
  masterHint(): Locator {
    return this.page.locator('a[href="/dashboard/settings?tab=libraries"]');
  }

  async fillLine(input: BudgetLineInput): Promise<void> {
    await this.page.getByTestId('budget-line-category').selectOption(input.category);
    // '' is the company-wide fallback option, which is what omitting a
    // department means — so this is set unconditionally rather than skipped.
    await this.page
      .getByTestId('budget-line-department')
      .selectOption(input.departmentId ?? '');
    await this.page.getByTestId('budget-line-amount').fill(String(input.plannedAmount));
  }

  async saveLine(): Promise<void> {
    await this.page.getByTestId('budget-line-save').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /**
   * Adds or updates a line through the form.
   *
   * The route behind it is an upsert on `(budget, category, department)`, so
   * running this twice with the same pair re-plans the line rather than
   * creating a second one.
   */
  async addLine(input: BudgetLineInput): Promise<void> {
    await this.openLineForm();
    await this.fillLine(input);
    await this.saveLine();
  }

  // ── Deletion ──────────────────────────────────────────────────────────────

  async openDeleteLine(lineId: string): Promise<void> {
    await this.lineRow(lineId).getByTestId('budget-line-delete').click();
    await expect(this.page.getByTestId('confirm-modal-confirm')).toBeVisible();
  }

  /**
   * Answers the dialog — and leaves it on screen.
   *
   * `useConfirm().handleConfirm` hands the caller a `closeModal()` to call when
   * the work is done, which this screen never does, so the panel stays up
   * showing "Processing…" over the reloaded table. Reads still work through it
   * (they are attribute reads, not clicks) but anything that clicks has to
   * follow a fresh `open()`.
   */
  async confirmDeleteLine(): Promise<void> {
    await this.page.getByTestId('confirm-modal-confirm').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** Whether the confirm dialog is still up — see `confirmDeleteLine`. */
  async confirmDialogIsOpen(): Promise<boolean> {
    return this.page.getByTestId('confirm-modal-confirm').isVisible().catch(() => false);
  }

  async deleteLine(lineId: string): Promise<void> {
    await this.openDeleteLine(lineId);
    await this.confirmDeleteLine();
  }

  // ── The over-run banner ───────────────────────────────────────────────────

  /**
   * Real spend that matched no budget line.
   *
   * Shown only when the server reports at least one such row — an over-run
   * rendered as an under-spend is the failure this banner exists to prevent.
   */
  async hasUnbudgetedBanner(): Promise<boolean> {
    return this.page.getByTestId('budget-unbudgeted').isVisible().catch(() => false);
  }

  /** The export control, present only once a report has loaded. */
  async canExport(): Promise<boolean> {
    return this.page.getByTestId('budget-export').isVisible().catch(() => false);
  }
}
